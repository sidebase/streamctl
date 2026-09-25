import type { ConfigFileLocation } from "../config/resolve";
import type { StreamctlConfig } from "../config/types";
import type { Logger } from "../logger";
import type { ConfigKeyType } from "../manifest/schema";
import type { ResolvePayloadOptions } from "../payload/resolve";
import type { DependencyBump, Installer } from "./init";
import type { SyncBatchDecider, SyncChange, SyncDecider, SyncPreview, SyncResult } from "./sync";
import type { LatestVersionProbe, VersionExistsProbe } from "./versions";
import { rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { loadStreamctlConfig } from "../config/load";
import { validateStreamctlConfigWithKeys } from "../config/validate";
import { StreamctlError } from "../errors";
import { resolvePayload } from "../payload/resolve";
import { dirtyTrackedPaths } from "./git";
import { bumpDevDeps, extractEmbeddedVersion, hasPayloadOverride, readPayloadOverride, runInstaller } from "./init";
import { resolvePresetChain } from "./manifest";
import { detectPm, findLockfile, installCommand, reinstallDependencies } from "./pm";
import { runSync } from "./sync";
import { checkUpdateAvailable } from "./versions";
import { atomicWrite, readFileOrNull } from "./write";

/** Defaults to {@link atomicWrite}; injected so tests can force `ROLLBACK_FAILED`. */
export type RestoreWriter = (abs: string, content: string) => Promise<void>;
/** Defaults to `fs.rm` force. Deletes a lockfile the failed install created. */
export type RestoreRemover = (abs: string) => Promise<void>;

export interface RunUpgradeOptions {
  cwd: string;
  /** Omitted resolves the latest published release. */
  to?: string;
  dryRun: boolean;
  install: Installer;
  /** Bump the pin and devDep but skip install, preflight, and rollback. */
  noInstall?: boolean;
  latestProbe: LatestVersionProbe;
  versionExists: VersionExistsProbe;
  /** Lets tests point at a fixture package. */
  resolvePackageDir?: ResolvePayloadOptions["resolvePackageDir"];
  decider?: SyncDecider;
  batchDecider?: SyncBatchDecider;
  yes?: boolean;
  force?: boolean;
  onPreview?: SyncPreview;
  restoreWrite?: RestoreWriter;
  restoreRemove?: RestoreRemover;
  /**
   * Once a SIGINT/SIGTERM has restored the snapshot the process is aborted non-zero.
   * The default re-raises the signal so the exit code reflects the interrupt.
   * Injected so a test can assert the restore ran without killing the runner.
   */
  onSignalAbort?: (signal: NodeJS.Signals, statuses: RestoreStatus[]) => void;
  /**
   * Re-run the PM install without prompting. Used after the chained sync reconciled
   * `package.json`, so the lockfile matches it, and after a post-install failure
   * restores the snapshot, so `node_modules` matches the rolled-back `package.json`.
   */
  reinstall?: (cwd: string) => Promise<void>;
  logger?: Logger;
}

/**
 * Planned writes only, hence the three-value `kind` subset. Files the plan pass
 * rejected outright (adoption, fault, dirty) never reach a preview and live in the
 * sync result's `conflicted[]` instead, so a consumer wanting the whole picture
 * reads both.
 */
export interface UpgradePlanEntry {
  path: string;
  kind: SyncChange["kind"];
}

export interface UpgradeResult {
  fromVersion: string;
  toVersion: string;
  dependencyBumps: DependencyBump[];
  /** `null` on `--dry-run` (target not installed) or `--no-install`. */
  sync: SyncResult | null;
  /** `sync === null` cannot tell a dry run from `--no-install`, which does write. */
  dryRun: boolean;
  rolledBack: boolean;
  plan: UpgradePlanEntry[];
}

/** Per-file restore outcome, surfaced in a `ROLLBACK_FAILED` error's `details`. */
export interface RestoreStatus {
  path: string;
  action: "restored" | "removed" | "unchanged";
  ok: boolean;
  error?: string;
}

interface FileSnapshot {
  path: string;
  abs: string;
  existed: boolean;
  content: string;
}

/**
 * Move the resolved config's `version` pin in place, at whichever location the run
 * loaded it from. Line-anchored so a suffix key (`myversion:`), a `versionSync:`
 * sibling, or a commented-out pin cannot be mistaken for the real one.
 *
 * The pin is chosen by indentation, not document order: the streamctl pin is
 * top-level and therefore the shallowest `version:` line, while a payload knob like
 * `ci: { version: "22" }` sits deeper. Taking the first match used to rewrite such a
 * knob whenever it was declared above the pin, corrupting the knob and leaving the
 * real pin stale. Two candidates at the same depth is an error, since guessing
 * corrupts one of them.
 *
 * Matched rather than parsed; the config is TS and full TS parsing is out of scope.
 */
async function bumpConfigVersion(location: ConfigFileLocation, toVersion: string): Promise<void> {
  const raw = await readFileOrNull(location.abs);
  if (raw === null) {
    throw new StreamctlError("CONFIG_INVALID", `\`${location.rel}\` not found.`, { path: location.rel });
  }
  // Horizontal whitespace only in the indent capture. `\s*` would span newlines:
  // under `/m` the `^` also asserts at a blank line, and a greedy `\s*` then eats the
  // blank lines plus the real indent, inflating the depth of any `version:` line
  // preceded by blank lines. With enough of them a nested knob out-ranks the
  // top-level pin, resurrecting the corruption this selection exists to prevent.
  const pin = /^([^\S\r\n]*)version\s*:\s*["'][^"']*["']/gm;
  // Matched against comment-masked text so a commented-out pin cannot win, but every
  // slice below indexes `raw`: the mask preserves offsets exactly.
  const matches = [...maskComments(raw).matchAll(pin)];
  if (matches.length === 0) {
    throw new StreamctlError(
      "CONFIG_INVALID",
      `Could not find a \`version: "…"\` pin on its own line in ${location.rel} to bump.`,
      { path: location.rel },
    );
  }

  // The capture always participates, so an absent group means no indent, depth 0.
  const depthOf = (match: RegExpExecArray): number => match[1]?.length ?? 0;
  const target = matches.reduce((best, match) => (depthOf(match) < depthOf(best) ? match : best));
  const outermost = matches.filter(match => depthOf(match) === depthOf(target));
  if (outermost.length > 1) {
    throw new StreamctlError(
      "CONFIG_INVALID",
      `Ambiguous version pin in ${location.rel}: ${outermost.length} \`version:\` keys share the outermost indentation, so the streamctl pin cannot be identified. Leave exactly one \`version:\` at the top level of the exported config.`,
      { path: location.rel },
    );
  }

  // Bounded to the matched text so it cannot wander to another pin the way the old
  // file-wide replace did. The callback form keeps `$`-patterns in `toVersion` literal.
  const matched = raw.slice(target.index, target.index + target[0].length);
  const bumped = matched.replace(/(["'])[^"']*(["'])$/, (_match: string, open: string, close: string) => `${open}${toVersion}${close}`);
  await atomicWrite(location.abs, raw.slice(0, target.index) + bumped + raw.slice(target.index + target[0].length));
}

/**
 * String literals and comments, in that order so a `/*` inside a string is consumed as
 * part of the string and never opens a comment.
 */
const LITERALS_AND_COMMENTS = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/**
 * Blank out comment bodies, preserving every offset and newline so the result stays
 * line-aligned with the original and match indices remain valid against it.
 *
 * The pin regex is line-anchored, which already rules out a `// version: "…"` line
 * comment, but not a `version: "…"` line at column 0 inside a block comment. That
 * outranks the real (indented) pin on depth and is a lone match at its depth, so it
 * used to be bumped silently while the true pin went stale.
 */
function maskComments(text: string): string {
  return text.replace(LITERALS_AND_COMMENTS, token => (token.startsWith("/") ? token.replace(/[^\n]/g, " ") : token));
}

/** Snapshot an absolute path under an explicit label (see {@link FileSnapshot.path}). */
async function snapshotAbs(abs: string, label: string): Promise<FileSnapshot> {
  const raw = await readFileOrNull(abs);
  return { path: label, abs, existed: raw !== null, content: raw ?? "" };
}

/** Snapshot a path relative to `cwd`, which doubles as its label. */
async function snapshotFile(cwd: string, rel: string): Promise<FileSnapshot> {
  return snapshotAbs(join(cwd, rel), rel);
}

async function restoreFile(snap: FileSnapshot, write: RestoreWriter, remove: RestoreRemover): Promise<RestoreStatus> {
  try {
    if (snap.existed) {
      const current = await readFileOrNull(snap.abs);
      if (current === snap.content) {
        return { path: snap.path, action: "unchanged", ok: true };
      }
      await write(snap.abs, snap.content);
      return { path: snap.path, action: "restored", ok: true };
    }
    if ((await readFileOrNull(snap.abs)) === null) {
      return { path: snap.path, action: "unchanged", ok: true };
    }
    await remove(snap.abs);
    return { path: snap.path, action: "removed", ok: true };
  } catch (error) {
    return {
      path: snap.path,
      action: snap.existed ? "restored" : "removed",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Delete a lockfile the failed install created somewhere the snapshot could not have
 * predicted. With no lockfile anywhere in the repo there is nothing to resolve, so the
 * snapshot falls back to `cwd` — but an install run from a workspace package writes the
 * lockfile at the repo root instead, which `restoreFile` would then never touch.
 *
 * Guarded by `existed === false`: that means the repo had NO lockfile when the upgrade
 * started, so whatever is there now is the failed install's and removing it restores the
 * pre-upgrade state. When the snapshot did record a file, `restoreFile` already owns it.
 * `null` when there is nothing to sweep.
 */
async function removeStrayLockfile(
  cwd: string,
  lockfileName: string,
  snap: FileSnapshot,
  remove: RestoreRemover,
): Promise<RestoreStatus | null> {
  if (snap.existed) {
    return null;
  }
  const stray = findLockfile(cwd, lockfileName);
  if (stray === null || stray === snap.abs) {
    return null; // nothing appeared, or restoreFile already removed the predicted path
  }
  const path = relative(cwd, stray).split(sep).join("/");
  try {
    await remove(stray);
    return { path, action: "removed", ok: true };
  } catch (error) {
    return { path, action: "removed", ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The repo needs manual recovery, so name the exact files and command.
 *
 * Split by what the failed restore was trying to do: an `action: "removed"` entry is a
 * file the failed install *created* (a lockfile the repo did not have before), so it is
 * not in HEAD and `git checkout` would report a pathspec error. Those need deleting.
 */
function rollbackFailedError(statuses: RestoreStatus[]): StreamctlError {
  const failures = statuses.filter(s => !s.ok);
  const failed = failures.map(s => s.path);
  const created = failures.filter(s => s.action === "removed").map(s => s.path);
  const tracked = failures.filter(s => s.action !== "removed").map(s => s.path);
  const recover = [
    tracked.length > 0 ? `git checkout HEAD -- ${tracked.join(" ")}` : null,
    created.length > 0 ? `rm -f ${created.join(" ")}` : null,
  ].filter(part => part !== null).join(" && ");
  const perFile = statuses.map(s => `${s.path}: ${s.ok ? s.action : `FAILED (${s.error ?? "unknown"})`}`);
  const message
    = `Upgrade rollback failed. ${failed.length} file(s) could not be restored: ${failed.join(", ")}. `
      + `Restore them manually: ${recover}`;
  return new StreamctlError("ROLLBACK_FAILED", message, { restore: statuses, failed, recover, perFile });
}

/** Tag a rolled-back failure with `rolledBack: true` and the preflight `plan`. */
function rolledBackError(error: unknown, plan: UpgradePlanEntry[]): StreamctlError {
  if (error instanceof StreamctlError) {
    const base = isRecord(error.details) ? error.details : {};
    return new StreamctlError(error.code, `${error.message} (pre-upgrade state restored)`, { ...base, rolledBack: true, plan });
  }
  // A genuine non-install write fault with no code; install failures are already
  // re-labeled INSTALL_FAILED upstream. Wrap it so `--json` carries `rolledBack`.
  const message = error instanceof Error ? error.message : String(error);
  return new StreamctlError("WRITE_FAILED", `${message} (pre-upgrade state restored)`, { rolledBack: true, plan });
}

/**
 * Stage-2 knob validation, at parity with sync/check/status/init. Validated against
 * the currently installed payload, the chain on disk before the upgrade writes.
 *
 * An unresolvable payload is tolerated: a pin ahead of node_modules is exactly what
 * `upgrade` recovers from, so there is simply nothing to validate the knobs against.
 */
async function validateConfigKnobs(opts: RunUpgradeOptions, config: StreamctlConfig): Promise<void> {
  let configKeys: Record<string, ConfigKeyType>;
  try {
    const payload = await resolvePayload(opts.cwd, config.package, config.version, { resolvePackageDir: opts.resolvePackageDir });
    ({ configKeys } = await resolvePresetChain(payload, config.base, config.profile));
  } catch (error) {
    if (error instanceof StreamctlError && (error.code === "CONFIG_VERSION_MISMATCH" || error.code === "CONFIG_PKG_MISSING")) {
      return;
    }
    throw error;
  }
  validateStreamctlConfigWithKeys(config, configKeys);
}

/** Would-be sync changes for `--dry-run` when the target payload is installed. */
async function previewSync(opts: RunUpgradeOptions, config: StreamctlConfig, onPreview: SyncPreview): Promise<SyncResult | null> {
  try {
    const payload = await resolvePayload(opts.cwd, config.package, config.version, { resolvePackageDir: opts.resolvePackageDir });
    const { files: managedFiles, baseline } = await resolvePresetChain(payload, config.base, config.profile);
    return await runSync({ cwd: opts.cwd, payload, config, managedFiles, baseline, dryRun: true, onPreview, logger: opts.logger });
  } catch (error) {
    if (error instanceof StreamctlError && (error.code === "CONFIG_VERSION_MISMATCH" || error.code === "CONFIG_PKG_MISSING")) {
      return null;
    }
    throw error;
  }
}

/**
 * The only command that moves the pinned version forward, and it does so
 * transactionally: either it fully applies or it restores the exact pre-upgrade tree.
 *
 * Three files are snapshotted, since a failed run could leave them inconsistent: the
 * resolved config (root or legacy), `package.json`, and the detected PM's lockfile.
 * The pin is validated and written before install so a failed install rolls back
 * cleanly, and `runSync` writes nothing until its batch is clean, which doubles as the
 * preflight.
 *
 * Any failure after the snapshot restores it byte-exactly and re-throws the original
 * error tagged `rolledBack: true`; only `node_modules` reflects the aborted install.
 * A restore that itself fails raises `ROLLBACK_FAILED` with per-file status and a
 * recovery command. A one-shot `SIGINT`/`SIGTERM` handler covers the same window.
 */
export async function runUpgrade(opts: RunUpgradeOptions): Promise<UpgradeResult> {
  const { cwd, dryRun } = opts;

  // `location` feeds both config touch points below — the rollback snapshot and the pin
  // bump — so the run can only ever write the file it read.
  const { config, location } = await loadStreamctlConfig(cwd, { logger: opts.logger });
  const fromVersion = config.version;

  // A payload pinned via a local override (a package-manager `overrides` entry
  // pointing at a `file:` tarball or similar) resolves its real version outside the
  // registry, so the `versionExists`/`latest` probes are meaningless and would
  // spuriously fail. Skip them, which makes `latest` unknowable and an explicit
  // `--to` mandatory. The real gate stays `resolvePayload`'s post-install version
  // check below: the installed payload must equal the new pin. Reuses `init`'s
  // detection and keeps PM/registry specifics out of the CLI.
  const overridden = await hasPayloadOverride(cwd, config.package);

  let toVersion: string;
  if (opts.to !== undefined) {
    if (!overridden && !(await opts.versionExists(cwd, config.package, opts.to))) {
      throw new StreamctlError("TARGET_NOT_FOUND", `${config.package}@${opts.to} is not published.`, { to: opts.to });
    }
    toVersion = opts.to;
  } else if (overridden) {
    throw new StreamctlError(
      "CONFIG_INVALID",
      `${config.package} is pinned via a local override, so its latest release can't be resolved from the registry. Re-run with an explicit \`--to <version>\`. (See docs/reference.md "Upgrading over a payload override".)`,
      { package: config.package, overridden: true },
    );
  } else {
    const update = await checkUpdateAvailable(cwd, fromVersion, config.package, opts.latestProbe);
    if (!update) {
      throw new StreamctlError(
        "NO_NEWER_VERSION",
        `Already on the latest ${config.package} release (${fromVersion}).`,
        { current: fromVersion },
      );
    }
    toVersion = update.latest;
  }

  // Stale-override preflight, before any snapshot, bump or install. An override
  // value embedding a semver other than the target would install the wrong payload
  // and end in install, version mismatch, rollback. Fail fast with a fix hint
  // instead. We never rewrite the override itself: that is PM-specific and there is
  // no generic seam. Only meaningful with an explicit `--to`, since the no-`--to`
  // override case threw above.
  if (overridden && opts.to !== undefined) {
    const overrideValue = await readPayloadOverride(cwd, config.package);
    const embedded = overrideValue === null ? null : extractEmbeddedVersion(overrideValue);
    if (embedded !== null && embedded !== toVersion) {
      throw new StreamctlError(
        "CONFIG_INVALID",
        `${config.package} is pinned via a local override (${overrideValue}) whose version ${embedded} ≠ the target ${toVersion}. Update pnpm.overrides / overrides for ${config.package} to the ${toVersion} artifact, then re-run \`streamctl upgrade --to ${toVersion}\`.`,
        { package: config.package, overridden: true, overrideValue, overrideVersion: embedded, to: toVersion },
      );
    }
    if (overrideValue !== null && embedded === null) {
      opts.logger?.warn(
        `${config.package} is pinned via a local override (${overrideValue}) with no embedded version, so assuming it resolves the ${toVersion} artifact; the post-install check still gates a mismatch.`,
      );
    }
  }

  // Stage 2, ahead of the snapshot and every write below, so a typo'd knob aborts
  // with nothing to roll back. After the version preflights so their errors keep
  // precedence, and before the `--dry-run` return so a dry run reports the same
  // failure a real one would.
  await validateConfigKnobs(opts, config);

  const newConfig: StreamctlConfig = { ...config, version: toVersion };

  // Collect every previewed change into the `plan`, then forward it to the caller's
  // preview hook unchanged.
  const planChanges: SyncChange[] = [];
  const collectPreview: SyncPreview = (change) => {
    planChanges.push(change);
    opts.onPreview?.(change);
  };
  const toPlan = (): UpgradePlanEntry[] => planChanges.map(c => ({ path: c.path, kind: c.kind }));

  if (dryRun) {
    const dependencyBumps = await bumpDevDeps(cwd, { [newConfig.package]: toVersion }, false);
    const sync = await previewSync(opts, newConfig, collectPreview);
    return { fromVersion, toVersion, dependencyBumps, sync, dryRun: true, rolledBack: false, plan: toPlan() };
  }

  const restoreWrite = opts.restoreWrite ?? atomicWrite;
  const restoreRemove = opts.restoreRemove ?? (async (abs: string): Promise<void> => {
    await rm(abs, { force: true });
  });

  const pm = await detectPm(cwd);
  // `pm.lockfile` is a bare filename, and in a workspace the lockfile sits at the
  // repo root rather than next to `cwd` — resolve where it actually is, or the
  // rollback would "restore" a path that never existed and silently leave the real
  // lockfile on the aborted version. No lockfile anywhere means the install is about
  // to create one at `cwd`, which the rollback then removes.
  const lockfileAbs = findLockfile(cwd, pm.lockfile) ?? join(cwd, pm.lockfile);
  const snapshots = await Promise.all([
    // Both halves come from the resolver, so the snapshot is bound to the file that was
    // actually loaded rather than to a path re-derived from `cwd`. `location.rel` is
    // already POSIX-normalized at the source, which it must be: it doubles as the
    // user-facing label in the ROLLBACK_FAILED report and as the git pathspec there.
    snapshotAbs(location.abs, location.rel),
    snapshotFile(cwd, "package.json"),
    // Labeled relative to `cwd` (so `../pnpm-lock.yaml` above a package dir): the
    // label is also the pathspec in the report's `git checkout HEAD -- …` command,
    // and git resolves those against cwd.
    snapshotAbs(lockfileAbs, relative(cwd, lockfileAbs).split(sep).join("/")),
  ]);
  const lockSnapshot = snapshots[2] as FileSnapshot;

  /**
   * Restore every snapshot, then sweep a lockfile the failed install created at a
   * path we could not have predicted. Shared by the catch and the signal handler so
   * an interrupt and a failure roll back identically.
   */
  const rollback = async (): Promise<RestoreStatus[]> => {
    const statuses = await Promise.all(snapshots.map(s => restoreFile(s, restoreWrite, restoreRemove)));
    const stray = await removeStrayLockfile(cwd, pm.lockfile, lockSnapshot, restoreRemove);
    return stray === null ? statuses : [...statuses, stray];
  };

  // A SIGINT or SIGTERM between the first write below and the catch would kill the
  // process before the rollback runs, leaving the pin advanced but the payload
  // uninstalled. On signal, restore the snapshot down the same path the catch uses,
  // then abort non-zero. Self-deregisters on the first signal, so a second signal
  // cannot double-restore and no listener leaks despite the re-raise; the `finally`
  // removes it on the clean and non-signal paths.
  const abortSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  const onSignalAbort = opts.onSignalAbort ?? ((signal: NodeJS.Signals): void => {
    // Snapshot restored; re-raise so the exit code reflects the interrupt (128+n).
    process.kill(process.pid, signal);
  });
  let signalHandled = false;
  const removeSignalHandlers = (): void => {
    for (const signal of abortSignals) {
      process.removeListener(signal, onSignal);
    }
  };
  function onSignal(signal: NodeJS.Signals): void {
    if (signalHandled) {
      return; // idempotent: a second signal must not double-restore.
    }
    signalHandled = true;
    removeSignalHandlers();
    void (async () => {
      opts.logger?.warn(`Interrupted (${signal}). Restoring the pre-upgrade state before exiting.`);
      onSignalAbort(signal, await rollback());
    })();
  }
  for (const signal of abortSignals) {
    process.on(signal, onSignal);
  }

  // Whether `install` completed, i.e. node_modules moved to the target. Gates the
  // rollback reinstall. Stays false if install threw or was skipped.
  let installed = false;

  // Capture before our own bumps dirty `package.json`, so the reconcile warning in
  // `runSync` reflects only the user's pre-existing edits, not this upgrade's write.
  const pkgDirtyBefore = (await dirtyTrackedPaths(cwd, ["package.json"])).has("package.json");

  try {
    // Config pin first (throws CONFIG_INVALID if no bumpable pin exists), before
    // `package.json` is touched.
    await bumpConfigVersion(location, toVersion);
    const dependencyBumps = await bumpDevDeps(cwd, { [newConfig.package]: toVersion }, true);
    const outcome = await runInstaller(opts.install, cwd);

    // `--no-install` or declined: the new payload is not on disk, so no preflight is
    // possible. The bump is kept and this path is exempt from rollback.
    if (opts.noInstall === true || outcome?.installed === false) {
      return { fromVersion, toVersion, dependencyBumps, sync: null, dryRun: false, rolledBack: false, plan: [] };
    }
    installed = true;

    const payload = await resolvePayload(cwd, newConfig.package, toVersion, { resolvePackageDir: opts.resolvePackageDir });
    const { files: managedFiles, baseline } = await resolvePresetChain(payload, newConfig.base, newConfig.profile);
    const sync = await runSync({
      cwd,
      payload,
      config: newConfig,
      managedFiles,
      baseline,
      yes: opts.yes,
      force: opts.force,
      decider: opts.decider,
      batchDecider: opts.batchDecider,
      onPreview: collectPreview,
      logger: opts.logger,
      pkgDirtyBeforeReconcile: pkgDirtyBefore,
    });

    // The sync reconciled `package.json` after the install above, so the lockfile no
    // longer matches it. Install again; the user already agreed to the first one.
    if (sync.lockfileStale) {
      await runInstaller(async (dir) => {
        await (opts.reinstall ?? reinstallDependencies)(dir);
      }, cwd);
      const { lockfileStale: _stale, ...fresh } = sync;
      return { fromVersion, toVersion, dependencyBumps, sync: fresh, dryRun: false, rolledBack: false, plan: toPlan() };
    }

    return { fromVersion, toVersion, dependencyBumps, sync, dryRun: false, rolledBack: false, plan: toPlan() };
  } catch (error) {
    const statuses = await rollback();
    if (statuses.some(s => !s.ok)) {
      throw rollbackFailedError(statuses);
    }

    // The three files are restored, but a completed install already moved
    // `node_modules` to the target. Reinstall to reconcile it with the rolled-back
    // `package.json`. Best-effort: a reinstall failure only adds a pm-aware
    // stale-node_modules hint and never masks the original error.
    if (installed) {
      const reinstall = opts.reinstall ?? reinstallDependencies;
      try {
        await reinstall(cwd);
      } catch {
        opts.logger?.warn(
          `node_modules is stale (still on ${toVersion}). Run \`${installCommand(pm.name)}\` to reconcile it with the restored package.json.`,
        );
      }
    }

    throw rolledBackError(error, toPlan());
  } finally {
    // Drop the window's handler so it never leaks into another command. The signal
    // path already self-deregistered.
    removeSignalHandlers();
  }
}
