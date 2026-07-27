import type { ManagedFile, StreamctlConfig } from "../config/types";
import type { PayloadHandle } from "../payload/resolve";
import { StreamctlError } from "../errors";
import { composeBlock } from "./block";
import { composeMerge } from "./merge";
import { renderFile } from "./render";
import { validateStructured } from "./structural";

/**
 * Outcome of composing a single {@link ManagedFile} against the payload.
 *
 * - `composed`: expected target content, consumed by the drift detector and
 *   the atomic writer.
 * - `marker-error`: a `block` file has duplicated/unbalanced/out-of-order
 *   markers. Recoverable, surfaced by the drift layer.
 * - `merge-error`: a `merge` target is malformed JSONC. Recoverable, surfaced
 *   as a conflict rather than crashing the run.
 * - `structural-error`: composed `.json*`/`.ya?ml` output that doesn't parse.
 *   Reported (exit 3) and blocks the write.
 */
export type ComposeResult
  = | {
    status: "composed";
    targetContent: string;
    /** `overwrite` (streamctl owns the file) or `if-absent` (write once, then project-owned). */
    writeMode: "overwrite" | "if-absent";
    /** Whether this file participates in drift detection (`scaffold` does not). */
    driftChecked: boolean;
  }
  | { status: "marker-error"; strategy: "block"; mark: string; reason: string }
  | { status: "merge-error"; strategy: "merge"; reason: string }
  | { status: "structural-error"; path: string; reason: string };

/** Downgrade a `composed` result to `structural-error` if a `.json*`/`.ya?ml` target's output doesn't parse. Non-structured targets pass through. */
function finalizeComposed(
  path: string,
  composed: Extract<ComposeResult, { status: "composed" }>,
): ComposeResult {
  const validation = validateStructured(path, composed.targetContent);
  return validation.ok ? composed : { status: "structural-error", path, reason: validation.reason };
}

// Fragment sources are read from the payload here so `renderFile` itself stays pure.
async function renderManagedTemplate(file: ManagedFile, payload: PayloadHandle, config?: StreamctlConfig): Promise<string> {
  const raw = await payload.read(file.source);
  if (file.renderDef === undefined) {
    return raw;
  }
  const fragmentSources: Record<string, string> = {};
  for (const fragment of file.renderDef.fragments ?? []) {
    if (!(fragment.source in fragmentSources)) {
      fragmentSources[fragment.source] = await payload.read(fragment.source);
    }
  }
  return renderFile(raw, file.renderDef, config, fragmentSources, file.path);
}

export async function compose(
  file: ManagedFile,
  payload: PayloadHandle,
  currentContent: string | null = null,
  config?: StreamctlConfig,
): Promise<ComposeResult> {
  const template = await renderManagedTemplate(file, payload, config);

  switch (file.strategy) {
    case "full":
      return finalizeComposed(file.path, {
        status: "composed",
        targetContent: template,
        writeMode: "overwrite",
        driftChecked: true,
      });

    // Wrapper files (eslint.config.ts / prisma.config.ts): write once, then
    // project-owned; local `.append()`/options survive npm bumps.
    case "scaffold":
      return finalizeComposed(file.path, {
        status: "composed",
        targetContent: template,
        writeMode: "if-absent",
        driftChecked: false,
      });

    // streamctl owns only the `{mark}` region; markers absent means append.
    case "block": {
      if (!file.blockMark) {
        throw new StreamctlError(
          "CONFIG_INVALID",
          `block strategy for "${file.path}" requires a blockMark`,
          { path: file.path },
        );
      }
      const result = composeBlock({
        path: file.path,
        mark: file.blockMark,
        payloadRegion: template,
        currentContent,
      });
      if (!result.ok) {
        return { status: "marker-error", strategy: "block", mark: file.blockMark, reason: result.reason };
      }
      return finalizeComposed(file.path, { status: "composed", targetContent: result.content, writeMode: "overwrite", driftChecked: true });
    }

    // Non-destructive: owns the payload's keys minus `projectFields`, project keeps the rest.
    case "merge": {
      const result = composeMerge({
        path: file.path,
        payloadTemplate: template,
        projectFields: file.projectFields ?? [],
        currentContent,
      });
      if (!result.ok) {
        return { status: "merge-error", strategy: "merge", reason: result.reason };
      }
      return finalizeComposed(file.path, { status: "composed", targetContent: result.content, writeMode: "overwrite", driftChecked: true });
    }
  }

  // Unreachable: `never` here makes exhaustiveness a compile-time guarantee.
  const unhandled: never = file.strategy;
  throw new StreamctlError("CONFIG_INVALID", `unhandled sync strategy "${String(unhandled)}" for "${file.path}".`, { path: file.path });
}
