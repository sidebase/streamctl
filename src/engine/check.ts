import type { StreamctlConfig } from "../config/types";
import type { Logger } from "../logger";
import type { PayloadHandle } from "../payload/resolve";
import type { DriftKind } from "./drift";
import type { LatestVersionProbe } from "./versions";
import { validateStreamctlConfigWithKeys } from "../config/validate";
import { StreamctlError } from "../errors";
import { stderrLogger } from "../logger";
import { warnProfileMismatch } from "./detect";
import { detectDrift } from "./drift";
import { resolvePresetChain } from "./manifest";
import { lockfileExists } from "./pm";
import { isFileActive } from "./render";
import { checkUpdateAvailable, detectVersionSkew } from "./versions";

export interface CheckResult {
  inSync: boolean;
  /** `reason` present only for marker/merge faults (`kind: "extra"`). */
  drift: { path: string; kind: DriftKind; reason?: string }[];
  structuralFaults: { path: string; reason: string }[];
  versionSkew: { key: string; actual: string; expected: string }[];
  updateAvailable?: { current: string; latest: string };
  /** A reconcile would leave the lockfile stale. Informational only. */
  lockfileStale?: boolean;
}

export const FAIL_ON_VALUES = ["drift", "outdated", "any"] as const;

export type FailOn = typeof FAIL_ON_VALUES[number];

export function isFailOn(value: unknown): value is FailOn {
  // Widened so `includes` accepts an unvalidated value; narrowing is the point here.
  const allowed: readonly string[] = FAIL_ON_VALUES;
  return typeof value === "string" && allowed.includes(value);
}

export interface RunCheckOptions {
  /** Newer-release probe seam (defaults to the registry probe; tests inject a fake). */
  latestProbe?: LatestVersionProbe;
  logger?: Logger;
}

/**
 * Read-only report (the CI gate). No writes, no state file.
 *
 * Exit policy: `DRIFT_DETECTED` (exit 3) when file drift or version skew exists
 * and `failOn` includes `drift`; `OUTDATED` (exit 4) when a newer release exists
 * and `failOn` includes `outdated`. File drift takes precedence under `any`.
 *
 * The newer-release probe runs only when `failOn` includes `outdated`; the
 * default `drift` gate stays offline.
 */
export async function runCheck(
  cwd: string,
  payload: PayloadHandle,
  config: StreamctlConfig,
  failOn: FailOn = "drift",
  opts: RunCheckOptions = {},
): Promise<CheckResult> {
  await warnProfileMismatch(cwd, payload, config.profile, opts.logger ?? stderrLogger);

  const { files: managedFiles, baseline, configKeys } = await resolvePresetChain(payload, config.base, config.profile);
  validateStreamctlConfigWithKeys(config, configKeys);
  const report = await detectDrift(managedFiles, payload, config, cwd);

  const hasEslintConfig = managedFiles.some(file => file.path.endsWith("eslint.config.ts") && isFileActive(file, config));
  const versionSkew = await detectVersionSkew({ cwd, config, baseline, hasEslintConfig, logger: opts.logger });

  const updateAvailable = failOn === "outdated" || failOn === "any"
    ? await checkUpdateAvailable(cwd, config.version, config.package, opts.latestProbe)
    : undefined;

  // Reconcile drift plus an existing lockfile means a `sync` would leave it stale.
  const lockfileStale = versionSkew.length > 0 && await lockfileExists(cwd);

  const inSync = report.inSync && versionSkew.length === 0;
  const result: CheckResult = {
    inSync,
    // `reason` explains why an `extra` fault couldn't be reconciled.
    drift: report.drift.map(({ path, kind, reason }) => (reason === undefined ? { path, kind } : { path, kind, reason })),
    structuralFaults: report.structuralFaults,
    versionSkew,
    ...(updateAvailable ? { updateAvailable } : {}),
    ...(lockfileStale ? { lockfileStale: true } : {}),
  };

  if (!inSync && (failOn === "drift" || failOn === "any")) {
    throw new StreamctlError(
      "DRIFT_DETECTED",
      `${report.drift.length} managed file(s) drifted, ${report.structuralFaults.length} structurally invalid, and ${versionSkew.length} version(s) skewed from the pinned config.`,
      result,
    );
  }

  if (updateAvailable && (failOn === "outdated" || failOn === "any")) {
    throw new StreamctlError(
      "OUTDATED",
      `A newer ${config.package} (${updateAvailable.latest}) is published; pinned at ${updateAvailable.current}.`,
      result,
    );
  }

  return result;
}
