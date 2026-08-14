import type { ManagedFile, StreamctlConfig, SyncStrategy } from "../config/types";
import type { Logger } from "../logger";
import type { PayloadHandle } from "../payload/resolve";
import type { LatestVersionProbe } from "./versions";
import { join } from "node:path";
import { validateStreamctlConfigWithKeys } from "../config/validate";
import { stderrLogger } from "../logger";
import { compose } from "./compose";
import { contentEquals } from "./jsonc";
import { resolvePresetChain } from "./manifest";
import { lockfileExists } from "./pm";
import { isFileActive, isFileEnabled } from "./render";
import { checkUpdateAvailable, dependencyMap, detectVersionSkew, readPackageJson } from "./versions";
import { readFileOrNull } from "./write";

/**
 * Per-managed-file state:
 * - `in-sync`: on disk and matches the composed target.
 * - `drift`: a `block`/`merge` file whose owned region differs (sync would reconcile it).
 * - `conflict`: a `full` file that differs (sync refuses without --force/--interactive).
 * - `missing`: the managed file is absent.
 * - `off`: opted out via `config.files[path] = "off"`.
 * - `disabled`: gated off by a false `enabledBy` toggle.
 * - `scaffolded`: a `scaffold` file present (its project-owned steady state).
 * - `fault`: a structural impossibility (broken markers, unparseable compose/merge).
 */
export type FileState = "in-sync" | "drift" | "conflict" | "missing" | "off" | "scaffolded" | "fault" | "disabled";

export interface StatusEntry {
  path: string;
  strategy: SyncStrategy;
  state: FileState;
}

export interface StatusResult {
  files: StatusEntry[];
  payload: {
    package: string;
    pinned: string;
    /** Equals `pinned` on a healthy repo. */
    installed: string;
    /** Only set when `--outdated` probed and found one. */
    latest?: string;
  };
  profile: string;
  cliVersion: string;
  lockfileStale: boolean;
}

export interface RunStatusOptions {
  cliVersion: string;
  /** Silently skipped on any probe failure, so `status` stays offline-safe. */
  outdated?: boolean;
  latestProbe?: LatestVersionProbe;
  logger?: Logger;
}

/** Classify one managed file's state from a read-only compose (mirrors the sync plan-pass, but writes nothing). */
async function fileState(file: ManagedFile, payload: PayloadHandle, config: StreamctlConfig, cwd: string, deps: Record<string, string>): Promise<FileState> {
  if (config.files?.[file.path] === "off") {
    return "off";
  }
  if (!isFileEnabled(file, config)) {
    return "disabled";
  }

  const current = await readFileOrNull(join(cwd, file.path));
  const result = await compose(file, payload, current, config, deps);

  if (result.status === "structural-error" || result.status === "marker-error" || result.status === "merge-error") {
    return "fault";
  }

  // scaffold (write-once): present means its project-owned steady state, absent means not yet written.
  if (result.writeMode === "if-absent") {
    return current === null ? "missing" : "scaffolded";
  }

  if (current === null) {
    return "missing";
  }
  if (contentEquals(file.path, current, result.targetContent)) {
    return "in-sync";
  }
  // A `full` divergence is a conflict; a `block`/`merge` region diff is a safe reconcile (drift).
  return file.strategy === "full" ? "conflict" : "drift";
}

/**
 * Read-only per-file overview for the `status` command. Reuses the compose
 * plan-pass from `check`/`sync`: no writes, no prompts, no network unless
 * `--outdated` opts into the newer-release probe. Never gates; `check` is the
 * exit-coded CI gate.
 */
export async function runStatus(
  cwd: string,
  payload: PayloadHandle,
  config: StreamctlConfig,
  opts: RunStatusOptions,
): Promise<StatusResult> {
  const logger = opts.logger ?? stderrLogger;
  const { files: managedFiles, baseline, configKeys } = await resolvePresetChain(payload, config.base, config.profile);
  // Stage 2: a malformed config here is a hard exit-1.
  validateStreamctlConfigWithKeys(config, configKeys);

  // Read once per run, so `status` composes the same bytes `sync`/`check` do.
  const deps = dependencyMap(await readPackageJson(cwd));

  const files: StatusEntry[] = [];
  for (const file of managedFiles) {
    files.push({ path: file.path, strategy: file.strategy, state: await fileState(file, payload, config, cwd, deps) });
  }

  const hasEslintConfig = managedFiles.some(file => file.path.endsWith("eslint.config.ts") && isFileActive(file, config));
  const versionSkew = await detectVersionSkew({ cwd, config, baseline, hasEslintConfig, logger });
  const lockfileStale = versionSkew.length > 0 && await lockfileExists(cwd);

  const payloadSummary: StatusResult["payload"] = { package: config.package, pinned: config.version, installed: payload.version };
  if (opts.outdated) {
    try {
      const update = await checkUpdateAvailable(cwd, config.version, config.package, opts.latestProbe);
      if (update) {
        payloadSummary.latest = update.latest;
      }
    } catch {
      // Offline or probe failure: status stays usable, latest is silently omitted.
    }
  }

  return {
    files,
    payload: payloadSummary,
    profile: config.profile,
    cliVersion: opts.cliVersion,
    lockfileStale,
  };
}
