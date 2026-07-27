import type { Profile, StreamctlConfig } from "../config/types";
import type { Logger } from "../logger";
import type { PayloadHandle, ResolvePayloadOptions } from "../payload/resolve";
import type { JsoncEdit } from "./jsonc";
import type { SyncDecider, SyncPreview, SyncResult } from "./sync";
import type { LatestVersionProbe, VersionExistsProbe } from "./versions";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { validateStreamctlConfigWithKeys } from "../config/validate";
import { StreamctlError } from "../errors";
import { stderrLogger } from "../logger";
import { resolvePayload } from "../payload/resolve";
import { detectProfile, readProjectPackage } from "./detect";
import { applyJsoncEdits, getAtPath, isPlainObject, strictParseJsonc } from "./jsonc";
import { resolvePresetChain, tryLoadPayloadManifest } from "./manifest";
import { runSync } from "./sync";
import { atomicWrite, readFileOrNull } from "./write";

// The CLI knows its own package name for the scaffold devDep wiring. The payload
// package name always comes from the caller.
export const CLI_PKG = "@sidebase/streamctl";

/** `installed: false` when skipped via `--no-install` or the prompt was declined. */
export interface InstallOutcome {
  installed: boolean;
}

/** A `void` return counts as installed, for back-compat with simple test fakes. */
export type Installer = (cwd: string) => Promise<InstallOutcome | void>;

/** `false` raises `REGISTRY_AUTH_FAILED`. */
export type RegistryAuthCheck = (cwd: string, packageName: string) => Promise<boolean>;

/**
 * nypm's `installDependencies` throws plain Errors, so re-label them as coded
 * `INSTALL_FAILED` and the `--json` envelope carries something meaningful instead of
 * the generic `UNKNOWN`/`WRITE_FAILED` fallback. A `StreamctlError` passes through.
 * Shared by `init` and `upgrade` so the same failure reports the same code either way.
 */
export async function runInstaller(install: Installer, cwd: string): Promise<InstallOutcome | void> {
  try {
    return await install(cwd);
  } catch (error) {
    if (error instanceof StreamctlError) {
      throw error;
    }
    throw new StreamctlError("INSTALL_FAILED", error instanceof Error ? error.message : String(error));
  }
}

export interface RunInitOptions {
  cwd: string;
  /** The CLI ships no default. */
  package: string;
  /** Pins the `@sidebase/streamctl` devDep only. The payload versions independently. */
  cliVersion: string;
  /**
   * Omitted, it is resolved from the payload's override value or the registry,
   * never from {@link RunInitOptions.cliVersion}.
   */
  payloadVersion?: string;
  latestProbe: LatestVersionProbe;
  versionExists: VersionExistsProbe;
  /** Defaults to the v2 manifest's `defaultBase`. */
  base?: string;
  /** Auto-detected from the v2 manifest's `profiles[].detect` when omitted. */
  profile?: Profile;
  /** Accept detected defaults, run the first sync headlessly. */
  yes: boolean;
  install: Installer;
  checkRegistryAuth: RegistryAuthCheck;
  /** Also auto-skipped when an override resolves the payload. */
  skipRegistryCheck?: boolean;
  /** Scaffold and wire devDeps but skip install and the chained first sync. */
  noInstall?: boolean;
  /** Lets tests point at a fixture package. */
  resolvePackageDir?: ResolvePayloadOptions["resolvePackageDir"];
  decider?: SyncDecider;
  onPreview?: SyncPreview;
  logger?: Logger;
}

export interface InitResult {
  base: string;
  profile: Profile;
  /** The payload pin written to `.streamctl/config.ts`, never the CLI's own version. */
  version: string;
  cliVersion: string;
  /** `null` when `--no-install` skipped it. */
  sync: SyncResult | null;
}

/**
 * `pnpm.overrides` or a root `overrides`: the local-tarball adoption path, and the
 * same generic key set `init` already touches. Matches the bare name or a
 * `${name}@range` selector.
 */
async function findPayloadOverride(cwd: string, packageName: string): Promise<{ key: string; value: unknown } | null> {
  const raw = await readFileOrNull(join(cwd, "package.json"));
  if (raw === null) {
    return null;
  }
  const parsed = strictParseJsonc(raw);
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    return null;
  }
  const groups = [getAtPath(parsed.value, ["pnpm", "overrides"]), getAtPath(parsed.value, ["overrides"])];
  for (const group of groups) {
    if (!isPlainObject(group)) {
      continue;
    }
    const key = Object.keys(group).find(k => k === packageName || k.startsWith(`${packageName}@`));
    if (key !== undefined) {
      return { key, value: group[key] };
    }
  }
  return null;
}

/** When true the registry probe is meaningless and is auto-skipped. */
export async function hasPayloadOverride(cwd: string, packageName: string): Promise<boolean> {
  return (await findPayloadOverride(cwd, packageName)) !== null;
}

/** Read-only. The CLI never rewrites an override; that is PM-specific with no generic seam. */
export async function readPayloadOverride(cwd: string, packageName: string): Promise<string | null> {
  const found = await findPayloadOverride(cwd, packageName);
  return typeof found?.value === "string" ? found.value : null;
}

/**
 * Pull the last `x.y.z[-prerelease]` semver out of an override value, since a tarball
 * name ends with its version. `null` when the value carries none (bare dir path,
 * `link:`, `workspace:`). Only a heuristic; the authoritative gate stays
 * `resolvePayload`'s post-install check. The point is failing fast, before install.
 *
 * The archive extension is stripped first so the prerelease group does not swallow it.
 * "Last semver wins" can mis-extract a versioned parent directory
 * (`file:/opt/1.2.3/pkg.tgz`), which the post-install check still catches.
 *
 * Lives here beside the other override readers because `engine/upgrade.ts` already
 * imports from this module and the reverse import would be circular.
 */
export function extractEmbeddedVersion(value: string): string | null {
  const withoutArchiveExt = value.replace(/\.(?:tgz|tar\.gz|tar|tar\.bz2|zip)$/i, "");
  const matches = withoutArchiveExt.match(/\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?/gi);
  return matches ? (matches.at(-1) ?? null) : null;
}

/** Payload-root scaffold template. Convention, not declared in preset.json. */
const CONFIG_TEMPLATE_FILE = "config.template.ts";

/**
 * Used when the payload ships no `presets/config.template.ts`. Carries the same
 * tokens a payload template does, so both render through one path.
 */
const FALLBACK_CONFIG_TEMPLATE = `import { defineStreamctlConfig } from "${CLI_PKG}";

export default defineStreamctlConfig({
  package: "__PACKAGE__",
  base: "__BASE__",
  version: "__VERSION__",
  profile: "__PROFILE__",
});
`;

async function loadPayloadConfigTemplate(payload: PayloadHandle): Promise<string | null> {
  if (!(await payload.list()).includes(CONFIG_TEMPLATE_FILE)) {
    return null;
  }
  return payload.read(CONFIG_TEMPLATE_FILE);
}

/**
 * Callback form so the values land verbatim; a string replacement would honor
 * `$`-patterns in them. Base and profile are payload-declared strings, so this is
 * not hypothetical.
 */
function renderConfigTemplate(template: string, values: { package: string; base: string; version: string; profile: string }): string {
  return template
    .replaceAll("__PACKAGE__", () => values.package)
    .replaceAll("__BASE__", () => values.base)
    .replaceAll("__VERSION__", () => values.version)
    .replaceAll("__PROFILE__", () => values.profile);
}

async function scaffoldConfig(cwd: string, template: string, values: { package: string; base: string; version: string; profile: string }): Promise<void> {
  await atomicWrite(join(cwd, ".streamctl", "config.ts"), renderConfigTemplate(template, values));
}

/** `from === null` when the pin is newly added. */
export interface DependencyBump {
  name: string;
  from: string | null;
  to: string;
}

/**
 * A devDep pinned via a protocol (`file:` tarball, `link:`, `workspace:`, `catalog:`)
 * is a locally or centrally managed pin the version mover must not rewrite to a bare
 * range. A repo installing the payload from `file:…tgz` keeps its `file:` spec across
 * an `upgrade`.
 */
function isProtocolSpec(spec: string): boolean {
  // `git` covers the `git+ssh`/`git+https` transport variants too.
  return /^(?:file|link|workspace|catalog|portal|git(?:\+[a-z]+)?):/.test(spec);
}

/**
 * The shared pin mover behind `init` and `upgrade`. Targeted JSONC edits, so
 * formatting and comments survive. Unchanged pins are skipped, and a pin held via a
 * protocol spec ({@link isProtocolSpec}) is left alone.
 */
export async function bumpDevDeps(cwd: string, deps: Record<string, string>, apply = true): Promise<DependencyBump[]> {
  const pkgPath = join(cwd, "package.json");
  const raw = await readFileOrNull(pkgPath);
  if (raw === null) {
    throw new StreamctlError("CONFIG_INVALID", "package.json not found.", { path: "package.json" });
  }
  const parsed = strictParseJsonc(raw);
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    throw new StreamctlError(
      "CONFIG_INVALID",
      `package.json is not valid JSON${parsed.ok ? " (not an object)" : `: ${parsed.reason}`}.`,
      { path: "package.json" },
    );
  }

  const bumps: DependencyBump[] = [];
  const edits: JsoncEdit[] = [];
  for (const [name, to] of Object.entries(deps)) {
    const found = getAtPath(parsed.value, ["devDependencies", name]);
    const from = typeof found === "string" ? found : null;
    // Unchanged, or a managed protocol spec the mover must not clobber: the override
    // or catalog resolves the real version elsewhere.
    if (from === to || (from !== null && isProtocolSpec(from))) {
      continue;
    }
    bumps.push({ name, from, to });
    edits.push({ path: ["devDependencies", name], value: to });
  }

  if (apply && edits.length > 0) {
    const nl = raw.includes("\r\n") ? "\r\n" : "\n";
    const next = applyJsoncEdits(raw, edits, nl);
    await atomicWrite(pkgPath, next.endsWith(nl) ? next : `${next}${nl}`);
  }

  return bumps;
}

/**
 * The two pins are distinct values. The CLI and the payload release independently
 * (docs/release.md, "no lockstep and no shared version number"), so wiring both from
 * one version would pin the payload to whatever release the CLI happens to be on.
 */
async function wireDevDeps(cwd: string, packageName: string, cliVersion: string, payloadVersion: string): Promise<void> {
  await bumpDevDeps(cwd, { [CLI_PKG]: cliVersion, [packageName]: payloadVersion });
}

/**
 * Resolve the payload version to pin, never falling back to the CLI's own version.
 * Explicit `--payload-version` first (gated against the registry unless the registry
 * is off-limits), then the version embedded in a local override, then the latest
 * published release. Mirrors `upgrade`'s target resolution.
 *
 * `skipRegistryProbe` covers both `--skip-registry-check` and an overriding pin: both
 * promise no registry traffic, so neither probe may run. Without an override to read
 * a version from, an explicit `--payload-version` is then the only way to name the pin.
 *
 * Called before any write, so an unresolvable version leaves the repo untouched.
 */
async function resolvePayloadVersion(opts: RunInitOptions, overridden: boolean, skipRegistryProbe: boolean): Promise<string> {
  const { cwd } = opts;
  if (opts.payloadVersion !== undefined) {
    if (!skipRegistryProbe && !(await opts.versionExists(cwd, opts.package, opts.payloadVersion))) {
      throw new StreamctlError(
        "TARGET_NOT_FOUND",
        `${opts.package}@${opts.payloadVersion} is not published.`,
        { package: opts.package, payloadVersion: opts.payloadVersion },
      );
    }
    return opts.payloadVersion;
  }

  if (skipRegistryProbe && !overridden) {
    throw new StreamctlError(
      "CONFIG_INVALID",
      `The registry probe for ${opts.package} is disabled, so its latest release can't be resolved. Re-run with an explicit \`--payload-version <version>\`.`,
      { package: opts.package },
    );
  }

  if (overridden) {
    const overrideValue = await readPayloadOverride(cwd, opts.package);
    const embedded = overrideValue === null ? null : extractEmbeddedVersion(overrideValue);
    if (embedded !== null) {
      return embedded;
    }
    throw new StreamctlError(
      "CONFIG_INVALID",
      `${opts.package} is pinned via a local override${overrideValue === null ? "" : ` (${overrideValue})`} that carries no version, so the release to pin can't be resolved. Re-run with an explicit \`--payload-version <version>\`.`,
      { package: opts.package, overridden: true, overrideValue },
    );
  }

  const latest = await opts.latestProbe(cwd, opts.package);
  if (latest === null) {
    throw new StreamctlError(
      "CONFIG_INVALID",
      `Could not resolve the latest ${opts.package} release from the registry (offline, or the package is unpublished). Re-run with an explicit \`--payload-version <version>\`.`,
      { package: opts.package },
    );
  }
  return latest;
}

/**
 * Wire a repo to a preset for the first time. Detect the profile, probe registry
 * access unless skipped, scaffold `.streamctl/config.ts`, add the CLI and payload
 * devDeps, install so the payload is on disk, then run the first `sync`. The CLI
 * hardcodes no registry.
 *
 * `install`, `checkRegistryAuth` and the version probes are injected so this never
 * shells out under test.
 */
export async function runInit(opts: RunInitOptions): Promise<InitResult> {
  const { cwd, cliVersion, yes, logger = stderrLogger } = opts;

  if (!existsSync(join(cwd, "package.json"))) {
    throw new StreamctlError("NOT_A_REPO", "No package.json found. Run `streamctl init` at a repository root.");
  }
  if (existsSync(join(cwd, ".streamctl", "config.ts"))) {
    throw new StreamctlError(
      "ALREADY_INITIALIZED",
      "`.streamctl/config.ts` already exists. Use `streamctl sync` or `streamctl upgrade`.",
    );
  }

  // Known-impossible upfront: `--no-install` never lands the payload, so base and
  // profile can never be auto-detected. Fail here, before wireDevDeps mutates
  // package.json. The installed-payload detection failures below stay resumable
  // since they fire after a successful install and a retry is idempotent.
  if (opts.noInstall === true && (opts.base === undefined || opts.profile === undefined)) {
    if (opts.base === undefined) {
      throw new StreamctlError(
        "CONFIG_INVALID",
        "No base preset specified; pass --base <name>.",
        { issues: [{ path: "base", message: "is required" }] },
      );
    }
    throw new StreamctlError(
      "PROFILE_DETECT_FAILED",
      "No version profile could be determined; pass --profile <name>.",
    );
  }

  // Verify the payload is installable before any files are written, so a failed probe
  // leaves the repo untouched and a retry is not blocked.
  const overridden = await hasPayloadOverride(cwd, opts.package);
  const skipProbe = opts.skipRegistryCheck === true || overridden;
  if (!skipProbe && !(await opts.checkRegistryAuth(cwd, opts.package))) {
    throw new StreamctlError(
      "REGISTRY_AUTH_FAILED",
      `Cannot read ${opts.package} from the registry; configure registry access for ${opts.package} first (see its README).`,
    );
  }

  // Also before any write. The payload's release line is independent of the CLI's, so
  // the pin has to be resolved rather than assumed, and an unresolvable one must
  // abort with package.json untouched.
  const version = await resolvePayloadVersion(opts, overridden, skipProbe);

  // devDeps and install first, so the payload and its manifest are on disk before we
  // finalize base/profile. Auto-detection reads the installed manifest.
  await wireDevDeps(cwd, opts.package, cliVersion, version);
  const outcome = await runInstaller(opts.install, cwd);
  const installed = !(opts.noInstall === true || outcome?.installed === false);

  // Resolve the payload at most once, and only when installed. Reused for detection
  // and the first sync.
  let payloadHandle: PayloadHandle | undefined;
  const getPayload = async (): Promise<PayloadHandle> =>
    (payloadHandle ??= await resolvePayload(cwd, opts.package, version, { resolvePackageDir: opts.resolvePackageDir }));

  // Explicit flags always win. Otherwise derive from the manifest: `defaultBase` for
  // the base, `profiles[].detect` for the profile.
  //
  // When install was declined at the prompt the payload never landed, so there is no
  // manifest to read and the explicit `--base`/`--profile` requirement still applies.
  // `--no-install` with a missing flag is already rejected upfront.
  let base = opts.base;
  let profile: string | undefined = opts.profile;
  if (base === undefined || profile === undefined) {
    const manifest = installed ? await tryLoadPayloadManifest(await getPayload()) : null;
    if (base === undefined) {
      if (manifest === null) {
        throw new StreamctlError(
          "CONFIG_INVALID",
          "No base preset specified; pass --base <name>.",
          { issues: [{ path: "base", message: "is required" }] },
        );
      }
      base = manifest.defaultBase;
    }
    if (profile === undefined) {
      if (manifest === null) {
        throw new StreamctlError(
          "PROFILE_DETECT_FAILED",
          "No version profile could be determined; pass --profile <name>.",
        );
      }
      const detected = detectProfile(manifest, await readProjectPackage(cwd));
      if (detected.profile === null) {
        throw new StreamctlError(
          "PROFILE_DETECT_FAILED",
          `No version profile could be detected; pass --profile <name> (available: ${manifest.profiles.map(p => p.name).join(", ")}).`,
        );
      }
      profile = detected.profile;
      logger.warn(`detected profile "${detected.profile}" (${detected.evidence}).`);
    }
  }

  // The payload's own template when it ships one, readable only once installed.
  const template = installed ? await loadPayloadConfigTemplate(await getPayload()) : null;
  await scaffoldConfig(cwd, template ?? FALLBACK_CONFIG_TEMPLATE, { package: opts.package, base, version, profile });

  // Install skipped or declined means the payload is not on disk. Return early rather
  // than crashing the first sync with CONFIG_PKG_MISSING; the command reports the
  // skip along with guidance.
  if (!installed) {
    return { base, profile, version, cliVersion, sync: null };
  }

  const config: StreamctlConfig = { package: opts.package, base, version, profile };
  const payload = await getPayload();
  const { files: managedFiles, baseline, configKeys } = await resolvePresetChain(payload, base, profile);
  // Stage 2. The freshly-scaffolded config carries no knobs, so this is a guard.
  validateStreamctlConfigWithKeys(config, configKeys);
  const sync = await runSync({
    cwd,
    payload,
    config,
    managedFiles,
    baseline,
    // init just wrote `.streamctl/config.ts` and bumped `package.json` devDeps, so the
    // dirty-tree guard must not refuse its own first sync.
    allowDirty: true,
    decider: yes ? undefined : opts.decider,
    onPreview: yes ? undefined : opts.onPreview,
    logger,
  });

  return { base, profile, version, cliVersion, sync };
}
