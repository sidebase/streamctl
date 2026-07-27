import type { CommandName } from "../reporter";
import { StreamctlError } from "../errors";
import { Reporter } from "../reporter";

/**
 * Reject any flag passed without a value.
 *
 * citty yields `""` for `--only` at the end of the line, and for the very common
 * `--only "$VAR"` with `VAR` unset. `typeof x === "string"` keeps that `""`, and every
 * string flag here means something specific when absent — `--only` absent is "no
 * filter", `--to` absent is "the latest release" — so silently reading `""` as absent
 * runs something the user did not ask for. The `--only` case is the sharp one: a run
 * asked to touch one file writes every managed file instead.
 *
 * Call this first inside the {@link executeCommand} body so the failure lands in the
 * `--json` envelope like any other error.
 */
export function rejectEmptyFlags(args: Record<string, unknown>): void {
  const empty = Object.entries(args)
    .filter(([name, value]) => value === "" && !name.startsWith("_"))
    .map(([name]) => name);
  if (empty.length === 0) {
    return;
  }
  const flags = empty.map(name => `\`--${name}\``).join(", ");
  throw new StreamctlError(
    "CONFIG_INVALID",
    `${flags} ${empty.length === 1 ? "was" : "were"} passed without a value.`,
    { flags: empty },
  );
}

/**
 * Runs a command body with uniform error handling: renders the success/error
 * envelope via the {@link Reporter} and sets `process.exitCode` from the
 * centralized error-code-to-exit-code map. Command bodies never throw past this boundary.
 */
export async function executeCommand<T>(
  command: CommandName,
  json: boolean,
  body: (reporter: Reporter) => Promise<T> | T,
): Promise<void> {
  const reporter = new Reporter(json);
  try {
    const data = await body(reporter);
    process.exitCode = reporter.success(command, data);
  } catch (error) {
    process.exitCode = reporter.failure(command, error);
  }
}
