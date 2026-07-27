import type { StreamctlConfig } from "../config/types";
import type { Logger } from "../logger";
import type { JsoncEdit, JsonPath } from "./jsonc";
import { join } from "node:path";
import { coerce, compare, parse, validRange } from "semver";
import { RECONCILABLE_KEY_PATTERN } from "../config/types";
import { StreamctlError } from "../errors";
import { stderrLogger } from "../logger";
import { applyJsoncEdits, getAtPath, isPlainObject, strictParseJsonc } from "./jsonc";
import { createExistsProbe, createLatestProbe } from "./pm";
import { atomicWrite, readFileOrNull } from "./write";

export interface VersionChange {
  key: string;
  from: string;
  to: string;
}

export interface VersionSkew {
  key: string;
  actual: string;
  expected: string;
}

/**
 * A baseline key already satisfied or exceeded, left untouched by the floor
 * rule. `baseline` is the floor not written; `actual` is the repo's kept pin.
 */
export interface VersionSkippedAhead {
  key: string;
  actual: string;
  baseline: string;
}

export interface ReconcileResult {
  changes: VersionChange[];
  skippedAhead: VersionSkippedAhead[];
}

export interface ParsedPackageJson {
  raw: string;
  value: Record<string, unknown>;
}

export interface ReconcileVersionsOptions {
  cwd: string;
  config: StreamctlConfig;
  baseline: Record<string, string>;
  hasEslintConfig: boolean;
  /** `true`: write `package.json` (sync). `false`: report only (check / dry-run). */
  apply: boolean;
  /** Pre-parsed `package.json`, threaded in to skip a second parse when the sync plan pass already read it. Absent: reads it itself (the check/detectVersionSkew path). */
  pkg?: ParsedPackageJson;
  logger?: Logger;
}

/** Read + strict-parse `package.json` at `cwd`, or `null` when absent. Throws `CONFIG_INVALID` on malformed JSON or a non-object root. */
export async function readPackageJson(cwd: string): Promise<ParsedPackageJson | null> {
  const raw = await readFileOrNull(join(cwd, "package.json"));
  if (raw === null) {
    return null;
  }
  const parsed = strictParseJsonc(raw);
  if (!parsed.ok) {
    throw new StreamctlError("CONFIG_INVALID", `package.json is not valid JSON: ${parsed.reason}`, { path: "package.json" });
  }
  if (!isPlainObject(parsed.value)) {
    throw new StreamctlError("CONFIG_INVALID", "package.json must be a JSON object.", { path: "package.json" });
  }
  return { raw, value: parsed.value };
}

export type LatestVersionProbe = (cwd: string, packageName: string) => Promise<string | null>;

function isOptedOut(key: string, config: StreamctlConfig): boolean {
  return (config.versionSyncExclude ?? []).includes(key);
}

/** Sections a dependency may live in, in reconcile priority: `dependencies` > `devDependencies` > `optionalDependencies` > `peerDependencies`. */
const PACKAGE_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/** `catalog:`/`workspace:` specifiers resolve their version elsewhere, so the literal string is intentional: never skew, never rewrite. */
function isManagedExemptSpecifier(value: string): boolean {
  return value.startsWith("catalog:") || value.startsWith("workspace:");
}

/**
 * Resolve a baseline key's `actual` value and edit target, section-aware. A package key is matched by
 * bare name across all three sections, so a dep the baseline lists under `devDependencies.X` but the repo
 * keeps under `dependencies.X` is reconciled in place, never duplicated. Non-package keys (`engines.*`,
 * `packageManager`, `scripts.*`) keep the literal path. Multi-section declarations warn and reconcile the
 * highest-priority one (see {@link PACKAGE_SECTIONS}).
 */
function resolveTarget(key: string, pkg: Record<string, unknown>, logger: Logger): { actual: string | undefined; path: JsonPath } {
  const segments = key.split(".");
  const [section, ...rest] = segments;
  if (section === undefined || !(PACKAGE_SECTIONS as readonly string[]).includes(section) || rest.length === 0) {
    const found = getAtPath(pkg, segments);
    // Same rule as the dependency branch below. Coercing to `undefined` instead read as
    // "absent", so `"engines": { "node": 22 }` reconciled with `from: ""` and `check
    // --json` told CI the repo's actual value was the empty string.
    if (found !== undefined && typeof found !== "string") {
      throw new StreamctlError(
        "CONFIG_INVALID",
        `package.json key "${key}" must be a string version, got ${typeof found}.`,
        { key },
      );
    }
    return { actual: found, path: segments };
  }

  const name = rest.join(".");
  const hits = PACKAGE_SECTIONS.filter(s => typeof getAtPath(pkg, [s, name]) === "string");
  if (hits.length > 1) {
    // don't fail the whole run over this; `hits` is already priority-ordered
    logger.warn(
      `package "${name}" is declared in multiple sections (${hits.join(", ")}); reconciling "${hits[0]}" and leaving the other(s) unchanged.`,
    );
  }
  const target = hits[0] ?? section;
  const raw = getAtPath(pkg, [target, name]);
  if (raw !== undefined && typeof raw !== "string") {
    throw new StreamctlError(
      "CONFIG_INVALID",
      `package.json key "${target}.${name}" must be a string version, got ${typeof raw}.`,
      { key: `${target}.${name}` },
    );
  }
  return { actual: raw, path: [target, name] };
}

function describeType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "array" : typeof value;
}

/**
 * Every container a planned edit descends through has to be an object.
 *
 * `getAtPath` returns `undefined` both for an absent key and for one under a non-object
 * container, so `"devDependencies": null` used to look like "the dep is simply absent":
 * the plan pass accepted it and only `applyReconcile` failed, with a raw jsonc-parser
 * error, *after* the managed files had been written. Checking here keeps the
 * plan-then-write contract — a bad `package.json` aborts before anything lands.
 */
function assertWritablePath(pkg: Record<string, unknown>, path: JsonPath): void {
  let current: unknown = pkg;
  for (const [index, segment] of path.slice(0, -1).entries()) {
    current = isPlainObject(current) ? current[segment] : undefined;
    if (current !== undefined && !isPlainObject(current)) {
      const at = path.slice(0, index + 1).join(".");
      throw new StreamctlError(
        "CONFIG_INVALID",
        `package.json key "${at}" must be an object to reconcile "${path.join(".")}", got ${describeType(current)}.`,
        { key: at },
      );
    }
  }
}

/** vitest is reconciled only if already present; jiti only when the preset uses `eslint.config.ts`. */
function isApplicable(key: string, actual: string | undefined, hasEslintConfig: boolean): boolean {
  if (key === "devDependencies.vitest") {
    return actual !== undefined;
  }
  if (key === "devDependencies.jiti") {
    return hasEslintConfig;
  }
  return true;
}

/** The compute output of {@link planReconcile}: the reported changes plus the concrete jsonc edits to apply. */
export interface ReconcilePlan {
  changes: VersionChange[];
  skippedAhead: VersionSkippedAhead[];
  edits: JsoncEdit[];
}

/**
 * Plan pass of the version reconcile: validate `versionSyncExclude`, then resolve and compare every
 * reconcilable baseline key against `package.json`. Pure and synchronous, so a bad pin (non-string value)
 * or an invalid exclude throws `CONFIG_INVALID` HERE — letting the caller fail before any write rather than
 * mid-reconcile after managed files are on disk. `null` when `versionSync` is disabled. Only keys matching
 * {@link RECONCILABLE_KEY_PATTERN} are touched; anything baseline-absent is left as the project has it.
 */
export function planReconcile(opts: {
  config: StreamctlConfig;
  baseline: Record<string, string>;
  hasEslintConfig: boolean;
  pkg: ParsedPackageJson;
  logger?: Logger;
}): ReconcilePlan | null {
  const { config, baseline, hasEslintConfig, logger = stderrLogger } = opts;

  if (config.versionSync === false) {
    return null;
  }

  for (const excluded of config.versionSyncExclude ?? []) {
    // reject only keys whose shape the reconciler could never touch; a
    // shape-valid key the baseline just doesn't define is a harmless no-op,
    // but it's usually a typo of a real key, so this warns instead of failing
    if (!RECONCILABLE_KEY_PATTERN.test(excluded)) {
      throw new StreamctlError(
        "CONFIG_INVALID",
        `versionSyncExclude entry "${excluded}" is not a reconcilable version key.`,
        { key: excluded },
      );
    }
    if (!(excluded in baseline)) {
      logger.warn(`versionSyncExclude entry "${excluded}" is not in the active baseline, so nothing to exclude (typo?).`);
    }
  }

  const pkg = opts.pkg.value;
  const changes: VersionChange[] = [];
  const skippedAhead: VersionSkippedAhead[] = [];
  const edits: JsoncEdit[] = [];

  for (const [key, expected] of Object.entries(baseline)) {
    if (!RECONCILABLE_KEY_PATTERN.test(key) || isOptedOut(key, config)) {
      continue;
    }
    const { actual, path } = resolveTarget(key, pkg, logger);

    // catalog:/workspace: specifiers are managed elsewhere; exempt them from
    // both skew reporting and rewriting
    if (actual !== undefined && isManagedExemptSpecifier(actual)) {
      continue;
    }

    if (!isApplicable(key, actual, hasEslintConfig)) {
      continue;
    }

    // Forward-aware floor: skip a key whose repo pin already meets or exceeds the baseline (an ahead repo
    // must never be dragged backwards). Equal minimums are skipped too - `versionSyncExclude` is for
    // opting out of that style churn. Unparseable specs fall back to exact-string equality, never guessing
    // a direction; `actual` undefined (add-when-absent) is unparseable too, so it still gets added below.
    if (actual !== undefined) {
      const actualMin = parseRangeMin(actual);
      const expectedMin = parseRangeMin(expected);
      const bothParsed = actualMin !== null && expectedMin !== null;

      // `actual` has no orderable floor (`parseRangeMin` null) but is a valid semver range: `^9 || ^10`,
      // a hyphen range, or a `+build` version. Collapsing it to the baseline floor would silently drop a
      // branch, so it's skipped untouched. A git URL/npm alias/tag is also null here but not a valid
      // range, so it still falls through to the rewrite below.
      if (actualMin === null && validRange(actual) !== null) {
        continue;
      }

      const skip = bothParsed ? compareSemver(actualMin, expectedMin) >= 0 : actual === expected;
      if (skip) {
        // Report only genuine ahead/at-floor keys (parsed & not byte-identical);
        // a byte-exact match is plain in-sync, not a skip worth surfacing.
        if (bothParsed && actual !== expected) {
          skippedAhead.push({ key, actual, baseline: expected });
        }
        continue;
      }
    }

    assertWritablePath(pkg, path);
    changes.push({ key, from: actual ?? "", to: expected });
    edits.push({ path, value: expected });
  }

  return { changes, skippedAhead, edits };
}

/** Apply pass: write the planned edits back to `package.json`, preserving formatting/comments. No-op on an empty edit set. */
export async function applyReconcile(cwd: string, raw: string, edits: JsoncEdit[]): Promise<void> {
  if (edits.length === 0) {
    return;
  }
  const nl = raw.includes("\r\n") ? "\r\n" : "\n";
  const next = applyJsoncEdits(raw, edits, nl);
  await atomicWrite(join(cwd, "package.json"), next.endsWith(nl) ? next : `${next}${nl}`);
}

/**
 * Compute (and optionally apply) the reconciliation of `package.json`'s version allow-list +
 * `scripts.postinstall` to the active profile baseline. Thin wrapper over {@link planReconcile} +
 * {@link applyReconcile}; `runSync` calls those two directly so the compute (which can throw) runs in
 * its plan pass, before any managed write.
 */
export async function reconcileVersions(opts: ReconcileVersionsOptions): Promise<ReconcileResult> {
  const { cwd, apply } = opts;

  if (opts.config.versionSync === false) {
    return { changes: [], skippedAhead: [] };
  }

  const parsedPkg = opts.pkg ?? await readPackageJson(cwd);
  if (parsedPkg === null) {
    return { changes: [], skippedAhead: [] };
  }

  const plan = planReconcile({
    config: opts.config,
    baseline: opts.baseline,
    hasEslintConfig: opts.hasEslintConfig,
    pkg: parsedPkg,
    logger: opts.logger,
  });
  if (plan === null) {
    return { changes: [], skippedAhead: [] };
  }

  if (apply) {
    await applyReconcile(cwd, parsedPkg.raw, plan.edits);
  }
  return { changes: plan.changes, skippedAhead: plan.skippedAhead };
}

export async function detectVersionSkew(opts: Omit<ReconcileVersionsOptions, "apply">): Promise<VersionSkew[]> {
  const { changes } = await reconcileVersions({ ...opts, apply: false });
  return changes.map(({ key, from, to }) => ({ key, actual: from, expected: to }));
}

/**
 * Default newer-release probe: latest published `packageName` via the detected PM's `view` (npm fallback),
 * not a git tag. Resolves `null` on any failure so `check` degrades quietly. Single source of truth for
 * the outdated probe; `upgrade` reuses it. PM specifics live in `engine/pm.ts`.
 */
export const probeLatestVersion: LatestVersionProbe = createLatestProbe();

export type VersionExistsProbe = (cwd: string, packageName: string, version: string) => Promise<boolean>;

/**
 * Default `--to` existence check via the PM's `view <pkg>@<version>` (npm fallback); resolves `false` on
 * any failure. Shares its transport with {@link probeLatestVersion}; `upgrade` uses it for `TARGET_NOT_FOUND`.
 */
export const probeVersionExists: VersionExistsProbe = createExistsProbe();

/**
 * Orders two versions via the `semver` reference impl (positive when `a` is newer), honoring prerelease
 * precedence. `parse` keeps a full version as-is (so `1.2.0-rc.1` orders below `1.2.0`); a bare core from
 * {@link parseRangeMin} gets `coerce`d to `x.y.z` first, since `semver.compare` needs a full triple.
 */
function compareSemver(a: string, b: string): number {
  const va = parse(a) ?? coerce(a);
  const vb = parse(b) ?? coerce(b);
  if (!va || !vb) {
    return 0;
  }
  return compare(va, vb);
}

/** A bare semver core: 1-3 numeric segments with an optional prerelease tail (`10.29.3`, `9.39`, `4.0.0-rc.1`). */
function isSemverCore(value: string): boolean {
  return /^\d+(?:\.\d+){0,2}(?:-[0-9a-z.-]+)?$/i.test(value);
}

/**
 * Extracts the comparable minimum of a version specifier: strips a leading range operator or a
 * `packageManager` pin's `<tool>@` prefix, returning the bare semver core. `null` when unparseable
 * (git/URL/tag/alias), so callers fall back to exact-string comparison rather than guess a direction.
 */
function parseRangeMin(spec: string): string | null {
  // a protocol/alias spec (file:, link:, npm:foo@1.2.3, git:...) has no
  // orderable min - its `@` is an alias delimiter, not a version pin
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec.trim())) {
    return null;
  }
  // Strip a leading range operator, then a leading `v` (only before a digit, so a tag
  // like `vue` is untouched). `detect.ts:parseMajor` strips `v` too; stay consistent.
  const stripped = spec.replace(/^\s*(?:>=|<=|[><=^~])\s*/, "").replace(/^\s*v(?=\d)/i, "").trim();
  if (isSemverCore(stripped)) {
    return stripped;
  }
  // `<tool>@<version>` pin (e.g. packageManager `pnpm@10.29.1`). Require no whitespace
  // before the `@`, or a shell command like `pnpm dlx tool@3.0.0` (a valid postinstall
  // value) would yield a spurious orderable version and get mis-skipped.
  const at = spec.lastIndexOf("@");
  if (at > 0 && !/\s/.test(spec.slice(0, at))) {
    const core = spec.slice(at + 1).trim().replace(/^v(?=\d)/i, "");
    if (isSemverCore(core)) {
      return core;
    }
  }
  return null;
}

export async function checkUpdateAvailable(
  cwd: string,
  current: string,
  packageName: string,
  probe: LatestVersionProbe = probeLatestVersion,
): Promise<{ current: string; latest: string } | undefined> {
  const latest = await probe(cwd, packageName);
  if (latest && compareSemver(latest, current) > 0) {
    return { current, latest };
  }
  return undefined;
}
