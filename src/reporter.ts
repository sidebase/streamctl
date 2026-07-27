import type { Logger } from "./logger";
import type { Style } from "./report";
import { colorEnabled } from "./engine/prompt";
import { StreamctlError } from "./errors";
import { exitCodeFor } from "./exit-codes";
import { renderReport } from "./report";

export type CommandName = "init" | "sync" | "check" | "status" | "upgrade";

export interface CommandEnvelope<T = unknown> {
  ok: boolean;
  command: CommandName;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  exitCode: number;
}

function markerForError(code: string): string {
  switch (code) {
    case "CONFLICTS_PENDING":
      return "[CONFLICT]";
    case "DRIFT_DETECTED":
      return "[DRIFT]";
    default:
      return "[ERROR]";
  }
}

// keep a fallback message from itself bloating the envelope
function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// stack + cause for an unexpected (non-StreamctlError) failure, only when
// STREAMCTL_DEBUG is set; never leak stacks by default
function debugDetails(error: unknown): unknown {
  if (!process.env.STREAMCTL_DEBUG) {
    return undefined;
  }
  if (error instanceof Error) {
    return { stack: error.stack, cause: error.cause };
  }
  return { value: String(error) };
}

/**
 * Renders command results as the `--json` envelope (stdout) or a
 * human-readable report, and doubles as the {@link Logger} so diagnostics
 * always go to stderr, keeping `--json` stdout clean.
 */
export class Reporter implements Logger {
  readonly json: boolean;
  private readonly style: Style;
  /** Set by `sync` after a reconcile write. */
  lockfileHint?: string;

  constructor(json: boolean, color: boolean = colorEnabled()) {
    this.json = json;
    this.style = { color };
  }

  warn(message: string): void {
    process.stderr.write(`${this.json ? "" : "[WARN] "}${message}\n`);
  }

  success<T>(command: CommandName, data: T): number {
    if (this.json) {
      this.emitJson(command, { ok: true, command, data, exitCode: 0 }, 0);
    } else {
      const report = renderReport(command, data, this.style, this.lockfileHint);
      process.stdout.write(`${report ?? `[OK] ${command}`}\n`);
    }
    return 0;
  }

  failure(command: CommandName, error: unknown): number {
    const isStreamctl = error instanceof StreamctlError;
    const code = isStreamctl ? error.code : "UNKNOWN";
    const message = error instanceof Error ? error.message : String(error);
    const details = isStreamctl ? error.details : debugDetails(error);
    const exitCode = exitCodeFor(code);

    if (this.json) {
      const envelope: CommandEnvelope = {
        ok: false,
        command,
        error: details === undefined ? { code, message } : { code, message, details },
        exitCode,
      };
      this.emitJson(command, envelope, exitCode);
    } else {
      // check/sync failures carry the full result as `details`, so the report's
      // own footer states the verdict; everything else falls back to a marker line
      const report = renderReport(command, isStreamctl ? error.details : undefined, this.style, this.lockfileHint);
      process.stderr.write(report ? `${report}\n` : `${markerForError(code)} ${message}\n`);
    }
    return exitCode;
  }

  private emitJson(command: CommandName, envelope: CommandEnvelope, exitCode: number): void {
    let serialized: string;
    try {
      serialized = JSON.stringify(envelope);
    } catch (error) {
      // a BigInt or circular value in data/details would otherwise throw past
      // run.ts's never-throw boundary
      const reason = error instanceof Error ? error.message : String(error);
      const fallback: CommandEnvelope = {
        ok: false,
        command,
        error: { code: "SERIALIZATION_FAILED", message: `Response envelope could not be serialized: ${truncate(reason)}` },
        exitCode,
      };
      serialized = JSON.stringify(fallback);
    }
    process.stdout.write(`${serialized}\n`);
  }
}
