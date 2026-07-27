import type { ManagedFile, StreamctlConfig } from "../config/types";
import type { PayloadHandle } from "../payload/resolve";
import { join } from "node:path";
import { compose } from "./compose";
import { contentEquals } from "./jsonc";
import { isFileEnabled } from "./render";
import { readFileOrNull } from "./write";

export type DriftKind = "content" | "missing" | "extra";

export interface DriftEntry {
  path: string;
  /** `content` (managed content differs), `missing` (file absent), `extra` (malformed/duplicated markers). */
  kind: DriftKind;
  /** Present for `extra` (marker faults): why the managed block could not be reconciled. */
  reason?: string;
}

export interface StructuralFault {
  path: string;
  reason: string;
}

export interface DriftReport {
  inSync: boolean;
  drift: DriftEntry[];
  /** Targets whose composed output does not parse; blocks the write, fails `check` (exit 3). */
  structuralFaults: StructuralFault[];
}

/**
 * Recompute expected streamctl-owned content from `(payload + config)` and diff
 * it against the working tree. No stored `state.json`, no writes.
 *
 * - `full`: whole-file compare.
 * - `block`: compares only the managed region; out-of-region edits are ignored,
 *   broken/duplicated markers surface as an `extra` conflict.
 * - `merge`: compares only the owned keys, project extras carried through unchanged.
 * - `scaffold`: excluded entirely (project-owned, not drift-checked).
 *
 * Pure: `check`/`sync` decide what to do with the result.
 */
export async function detectDrift(
  managedFiles: ManagedFile[],
  payload: PayloadHandle,
  config: StreamctlConfig,
  cwd: string,
): Promise<DriftReport> {
  const drift: DriftEntry[] = [];
  const structuralFaults: StructuralFault[] = [];

  for (const file of managedFiles) {
    // `files: off` opt-out, or a v2 `enabledBy` gate that is false, means not managed.
    if (config.files?.[file.path] === "off" || !isFileEnabled(file, config)) {
      continue;
    }

    const current = await readFileOrNull(join(cwd, file.path));
    const result = await compose(file, payload, current, config);

    if (result.status === "structural-error") {
      structuralFaults.push({ path: result.path, reason: result.reason });
      continue;
    }
    if (result.status === "marker-error" || result.status === "merge-error") {
      drift.push({ path: file.path, kind: "extra", reason: result.reason });
      continue;
    }
    if (!result.driftChecked) {
      continue;
    }
    if (current === null) {
      drift.push({ path: file.path, kind: "missing" });
      continue;
    }
    if (!contentEquals(file.path, current, result.targetContent)) {
      drift.push({ path: file.path, kind: "content" });
    }
  }

  return { inSync: drift.length === 0 && structuralFaults.length === 0, drift, structuralFaults };
}
