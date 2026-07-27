import type { ManagedFile, StreamctlConfig, SyncStrategy } from "../config/types";
import type { Logger } from "../logger";
import type { PayloadHandle } from "../payload/resolve";
import type { VersionChange, VersionSkippedAhead } from "./versions";
import { join } from "node:path";
import { StreamctlError } from "../errors";
import { stderrLogger } from "../logger";
import { compose } from "./compose";
import { dirtyTrackedPaths } from "./git";
import { contentEquals } from "./jsonc";
import { lockfileExists } from "./pm";
import { isFileActive, isFileEnabled } from "./render";
import { applyReconcile, planReconcile, readPackageJson } from "./versions";
import { atomicWrite, readFileOrNull } from "./write";

/**
 * - `edit`: diverged from its target after being in-sync (the default).
 * - `adoption`: a pre-existing `full` file the payload newly manages.
 * - `fault`: the composed output does not parse — a payload/template bug.
 * - `malformed`: the file in the consumer's repo cannot be read — invalid JSONC or
 *   broken block markers. Split from `fault` because the two need opposite advice:
 *   one is fixed in the payload, the other in the repo running streamctl.
 * - `dirty`: uncommitted changes to an owned path.
 */
export type ConflictKind = "edit" | "adoption" | "fault" | "malformed" | "dirty";

export interface Conflict {
  path: string;
  reason: string;
  kind: ConflictKind;
}

export interface SyncResult {
  written: string[];
  skipped: string[];
  conflicted: Conflict[];
  /** Non-fatal advisories. Always present, `[]` when none, append-only. */
  warnings: string[];
  versionChanges: VersionChange[];
  /** Keys the repo already satisfies. The floor rule never downgrades an ahead repo. */
  versionsSkippedAhead: VersionSkippedAhead[];
  syncedVersion: string;
  /** Set when a CI `--frozen-lockfile` install would now fail. Never affects the exit code. */
  lockfileStale?: boolean;
}

/**
 * `create` is a clean add, `reconcile` a `block`/`merge` difference confined to the
 * owned region, `conflict` a `full`-file difference (consumer edited owned content).
 */
export interface SyncChange {
  path: string;
  strategy: SyncStrategy;
  kind: "create" | "reconcile" | "conflict";
  before: string | null;
  after: string;
}

/** Per-file accept/skip decision. Absent means headless policy. */
export type SyncDecider = (change: SyncChange) => Promise<"accept" | "skip">;
/** One prompt for all safe changes. Full-file conflicts are never batched. */
export type SyncBatchDecider = (changes: SyncChange[]) => Promise<"accept" | "skip">;
export type SyncPreview = (change: SyncChange) => void;

export interface RunSyncOptions {
  cwd: string;
  payload: PayloadHandle;
  config: StreamctlConfig;
  managedFiles: ManagedFile[];
  /** Empty disables version sync. */
  baseline?: Record<string, string>;
  dryRun?: boolean;
  force?: boolean;
  /**
   * Set by `init`, whose chained first sync legitimately runs over files `init`
   * itself just wrote, such as an appended `.npmrc` block.
   */
  allowDirty?: boolean;
  /**
   * Override for the reconcile "package.json had uncommitted changes" warning.
   * `upgrade` bumps `package.json` itself before this sync, so the live git query
   * would always read dirty; it passes the *pre-bump* state here so the warning
   * still reflects only the user's own pre-existing edits.
   */
  pkgDirtyBeforeReconcile?: boolean;
  only?: string;
  /**
   * `--yes`: auto-apply creates and `block`/`merge` reconciles. Full-file conflicts
   * still need the interactive decider or `--force`, which is a superset of this flag.
   */
  yes?: boolean;
  /**
   * When present, and not under `--dry-run`/`--force`, every changed file is offered
   * to it. With a {@link batchDecider} too, only conflicts reach this hook.
   */
  decider?: SyncDecider;
  /** Absent falls back to {@link decider}. */
  batchDecider?: SyncBatchDecider;
  onPreview?: SyncPreview;
  logger?: Logger;
}

/**
 * Deliberately a subset of real globbing: a doublestar maps to a plain `.*` with its
 * surrounding literals kept, so a leading globstar does not also match zero
 * directories. Enough for `--only`.
 */
function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char?.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** `expected` vs `unexpected` only tunes the reason text; both stay `adoption`. */
function classifyFullConflict(file: ManagedFile): Conflict {
  if (file.adoption === "expected") {
    return { path: file.path, reason: "pre-existing file streamctl now manages; adopting is expected", kind: "adoption" };
  }
  if (file.adoption === "unexpected") {
    return { path: file.path, reason: "pre-existing file differs unexpectedly; review before adopting", kind: "adoption" };
  }
  return { path: file.path, reason: "local edits to streamctl-owned content", kind: "edit" };
}

/**
 * A scaffolded file is inert when a manifest-declared `shadowedBy` sibling exists,
 * e.g. a scaffolded `eslint.config.ts` beside an `eslint.config.mjs`. Every sibling
 * filename comes from the payload manifest, which keeps the CLI framework-blind.
 */
async function collectShadowWarnings(cwd: string, file: ManagedFile, warnings: string[]): Promise<void> {
  for (const sibling of file.shadowedBy ?? []) {
    if ((await readFileOrNull(join(cwd, sibling))) !== null) {
      warnings.push(`${file.path} is shadowed by ${sibling}; the scaffolded config is inert until you port and delete ${sibling}.`);
    }
  }
}

interface PlannedWrite {
  abs: string;
  content: string;
  path: string;
}

interface PendingChange {
  change: SyncChange;
  abs: string;
  content: string;
  file: ManagedFile;
}

/**
 * Compose targets and reconcile the working tree. No state file: the payload is read
 * from `node_modules` on every run.
 *
 * Plan-then-write. Everything is composed and validated in a plan pass that writes
 * nothing, and the write pass runs only when the batch is clean, so any fault or
 * conflict leaves the tree untouched. Writes are per-file atomic but not
 * batch-atomic; there is no cross-file rollback on a mid-loop I/O error.
 *
 * Safe changes are written by default. A `full`-file difference or any
 * marker/merge/structural fault raises `CONFLICTS_PENDING` (exit 2) before anything
 * lands. `--force` accepts everything, dirty guard included.
 */
export async function runSync(opts: RunSyncOptions): Promise<SyncResult> {
  const { cwd, payload, config, dryRun = false, force = false, yes = false, allowDirty = false, pkgDirtyBeforeReconcile: pkgDirtyOverride, only, decider, batchDecider, onPreview } = opts;
  const filter = only ? globToRegExp(only) : null;
  const interactive = Boolean(decider) && !dryRun && !force;
  const logger = opts.logger ?? stderrLogger;

  const written: string[] = [];
  const skipped: string[] = [];
  const conflicted: Conflict[] = [];
  const warnings: string[] = [];
  const plannedWrites: PlannedWrite[] = [];
  const pending: PendingChange[] = [];

  // Files in scope this run, after `--only` and per-file `off`. Drives both the plan
  // pass and the dirty-tree guard's owned/scaffold partition.
  const activeFiles: ManagedFile[] = [];
  for (const file of opts.managedFiles) {
    if (filter && !filter.test(file.path)) {
      continue;
    }
    if (config.files?.[file.path] === "off" || !isFileEnabled(file, config)) {
      skipped.push(file.path);
      continue;
    }
    activeFiles.push(file);
  }

  // Plan pass: compose and validate everything, write nothing.
  for (const file of activeFiles) {
    const abs = join(cwd, file.path);
    const current = await readFileOrNull(abs);
    const result = await compose(file, payload, current, config);

    // Never write output that does not parse. `--force` cannot fix corrupt output.
    if (result.status === "structural-error") {
      conflicted.push({ path: result.path, reason: `composed output is not valid: ${result.reason}`, kind: "fault" });
      continue;
    }
    if (result.status === "marker-error" || result.status === "merge-error") {
      conflicted.push({ path: file.path, reason: result.reason, kind: "malformed" });
      continue;
    }

    // scaffold: write once if absent, project-owned afterwards, never prompted.
    if (result.writeMode === "if-absent") {
      if (current === null) {
        plannedWrites.push({ abs, content: result.targetContent, path: file.path });
      } else {
        skipped.push(file.path);
      }
      // Warn whether written fresh or skipped: a live `shadowedBy` sibling makes the
      // scaffolded config inert until it is ported and removed.
      await collectShadowWarnings(cwd, file, warnings);
      continue;
    }

    if (current !== null && contentEquals(file.path, current, result.targetContent)) {
      skipped.push(file.path);
      continue;
    }

    // A `full`-file difference is a consumer edit to owned content. A `block`/`merge`
    // difference touches only the owned region or keys, which is also what lets a
    // config-knob toggle land on a plain `sync`.
    const kind: SyncChange["kind"] = current === null
      ? "create"
      : file.strategy === "full" ? "conflict" : "reconcile";
    const change: SyncChange = { path: file.path, strategy: file.strategy, kind, before: current, after: result.targetContent };

    onPreview?.(change);
    pending.push({ change, abs, content: result.targetContent, file });
  }

  // Still the plan pass. A malformed package.json throws CONFIG_INVALID here, before
  // any managed write, rather than inside the post-write reconcile, which would leave
  // managed files already on disk. Threaded into `planReconcile` so the file is
  // read once per run.
  const parsedPkg = config.versionSync === false ? null : await readPackageJson(cwd);

  // jiti is reconciled only for an ACTIVE eslint.config.ts: a file turned off or gated
  // out by `enabledBy` is not managed here, so its version key must not move either.
  const hasEslintConfig = opts.managedFiles.some(file => file.path.endsWith("eslint.config.ts") && isFileActive(file, config));

  // Compute the reconcile in the plan pass too, so a bad pin (e.g. a non-string
  // version value) throws CONFIG_INVALID before any managed write. The edits are
  // applied after the write loop below.
  const reconcilePlan = parsedPkg
    ? planReconcile({ config, baseline: opts.baseline ?? {}, hasEslintConfig, pkg: parsedPkg, logger })
    : null;

  // Resolve the safe set's fate first, so the batch prompt precedes any per-file
  // conflict prompt.
  const accept = (p: PendingChange): void => {
    plannedWrites.push({ abs: p.abs, content: p.content, path: p.change.path });
  };
  const skip = (p: PendingChange): void => {
    skipped.push(p.change.path);
  };
  const safe = pending.filter(p => p.change.kind !== "conflict");

  // `null` means decide each safe change per-file via `decider`.
  let safeBatch: "accept" | "skip" | null = null;
  if (force || yes || !interactive) {
    safeBatch = "accept"; // force/--yes accept safe outright; headless writes them too.
  } else if (batchDecider && safe.length > 0) {
    safeBatch = await batchDecider(safe.map(p => p.change));
  }

  for (const p of pending) {
    if (p.change.kind !== "conflict") {
      if (safeBatch !== null) {
        (safeBatch === "accept" ? accept : skip)(p);
      } else if (decider) {
        // `safeBatch === null` implies interactive, so `decider` is present. Narrowed
        // rather than asserted.
        ((await decider(p.change)) === "accept" ? accept : skip)(p);
      } else {
        // Defensively unreachable. Accept rather than silently drop the change.
        accept(p);
      }
    } else if (force) {
      accept(p);
    } else if (interactive && decider) {
      ((await decider(p.change)) === "accept" ? accept : skip)(p);
    } else {
      // A `full` file carries no marker, so "adopted-then-drifted" and
      // "never-managed" are indistinguishable from content alone. The manifest
      // adoption hint is the only signal; absent, assume the safer `edit` wording.
      conflicted.push(classifyFullConflict(p.file));
    }
  }

  // Transactional: any fault or conflict means write nothing.
  if (conflicted.length > 0) {
    throw new StreamctlError(
      "CONFLICTS_PENDING",
      `${conflicted.length} file(s) have unresolved conflicts. Re-run with --force or --interactive.`,
      { written: [], skipped, conflicted, warnings, versionChanges: [], versionsSkippedAhead: [], syncedVersion: config.version } satisfies SyncResult,
    );
  }

  // Runs under `--dry-run` too, warning instead of writing, so the plan reflects that
  // a real sync would be refused.
  if (!allowDirty) {
    const owned = activeFiles.filter(f => f.strategy !== "scaffold").map(f => f.path);
    const scaffold = activeFiles.filter(f => f.strategy === "scaffold").map(f => f.path);
    const dirty = await dirtyTrackedPaths(cwd, [...owned, ...scaffold]);

    // Block only on owned paths this run will actually write. A dirty owned file that
    // is content-equal was skipped earlier and is absent from `plannedWrites`, so it
    // is left untouched anyway; refusing the whole run over it just pushed people to
    // `--force`.
    const plannedPaths = new Set(plannedWrites.map(p => p.path));
    const dirtyOwned = owned.filter(p => dirty.has(p) && plannedPaths.has(p));
    if (dirtyOwned.length > 0 && !force) {
      if (dryRun) {
        logger.warn(
          `streamctl: a real sync would be refused; streamctl-owned path(s) have uncommitted changes: ${dirtyOwned.join(", ")}.`,
        );
      } else {
        throw new StreamctlError(
          "CONFLICTS_PENDING",
          `Refusing to sync; streamctl-owned path(s) have uncommitted changes: ${dirtyOwned.join(", ")}. Commit or stash them, or re-run with --force.`,
          { written: [], skipped, conflicted: dirtyOwned.map(p => ({ path: p, reason: "uncommitted changes (dirty working tree)", kind: "dirty" as const })), warnings, versionChanges: [], versionsSkippedAhead: [], syncedVersion: config.version } satisfies SyncResult,
        );
      }
    }

    const dirtyScaffold = scaffold.filter(p => dirty.has(p));
    if (dirtyScaffold.length > 0) {
      logger.warn(
        `streamctl: uncommitted changes in project-owned file(s) left untouched: ${dirtyScaffold.join(", ")}.`,
      );
    }
  }

  // Not batch-atomic: a mid-loop OS write failure leaves the files written so far
  // committed.
  for (const planned of plannedWrites) {
    if (!dryRun) {
      await atomicWrite(planned.abs, planned.content);
    }
    written.push(planned.path);
  }

  // package.json is not an `activeFiles` entry, so the guard above never covers it,
  // yet the reconcile below edits it in place. Snapshot whether it is already dirty
  // here, before reconcile writes, or its own edit would always read back as dirty and
  // mask the user's pre-existing changes. Warn only: a reconcile runs on every sync,
  // so refusing would block a sync over any unrelated package.json edit.
  const pkgDirtyBeforeReconcile = !force && !dryRun && !allowDirty
    ? (pkgDirtyOverride ?? (await dirtyTrackedPaths(cwd, ["package.json"])).has("package.json"))
    : false;

  // Apply the plan computed above (edits already validated pre-write).
  if (reconcilePlan && parsedPkg && !dryRun) {
    await applyReconcile(cwd, parsedPkg.raw, reconcilePlan.edits);
  }
  const versionChanges = reconcilePlan?.changes ?? [];
  const versionsSkippedAhead = reconcilePlan?.skippedAhead ?? [];

  if (pkgDirtyBeforeReconcile && versionChanges.length > 0) {
    logger.warn(
      "streamctl: reconciled version keys in package.json, which had uncommitted changes. The reconcile edits are now mixed with your local changes. Review before committing.",
    );
  }

  // Surface a stale lockfile so `--frozen-lockfile` CI installs do not fail.
  const lockfileStale = !dryRun && versionChanges.length > 0 && await lockfileExists(cwd);

  return {
    written,
    skipped,
    conflicted,
    warnings,
    versionChanges,
    versionsSkippedAhead,
    syncedVersion: config.version,
    ...(lockfileStale ? { lockfileStale: true } : {}),
  };
}
