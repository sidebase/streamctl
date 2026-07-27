import { runCommand, runMain } from "citty";
import { main } from "./main";

/** SGR escapes, stripped from citty's usage-error text. See {@link runCli}. */
// eslint-disable-next-line no-control-regex -- matching ANSI SGR by definition
const ANSI_SGR = /\u001B\[[0-9;]*m/g;

/**
 * CLI entrypoint. Usage errors have to honor the machine contract too.
 *
 * citty's `runMain` prints human usage and calls `process.exit(1)` internally on a
 * usage error, so an outer try/catch cannot intercept it. `runCommand` propagates
 * the usage `CLIError` instead. So under `--json` we go through `runCommand` and emit
 * a `USAGE` envelope matching the Reporter's shape; without `--json`, `runMain` stays
 * verbatim so human usage plus `--help`/`--version` are preserved.
 *
 * citty (0.2.2) still does not export `CLIError`, hence the match by name. It also
 * colors the offending name, which would otherwise put ANSI into the envelope and
 * break the Reporter's no-color-by-construction contract.
 */
export async function runCli(rawArgs: string[]): Promise<void> {
  if (!rawArgs.includes("--json")) {
    await runMain(main, { rawArgs });
    return;
  }

  try {
    await runCommand(main, { rawArgs });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "CLIError") {
      throw error;
    }
    // Best-effort label: first non-flag token, or the program name when the usage
    // error is at the top level.
    const command = rawArgs.find(arg => !arg.startsWith("-")) ?? "streamctl";
    const message = error.message.replace(ANSI_SGR, "");
    const envelope = { ok: false, command, error: { code: "USAGE", message }, exitCode: 1 };
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    process.exitCode = 1;
  }
}
