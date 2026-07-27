import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderUsage } from "citty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCommand } from "../src/commands/check";
import { syncCommand } from "../src/commands/sync";
import { exitCodeFor } from "../src/exit-codes";
import { runCli } from "../src/run-cli";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const stripAnsi = (value: string) => value.replace(/\u001B\[\d+m/g, "");

type CheckRunCtx = Parameters<NonNullable<typeof checkCommand.run>>[0];

describe("exitCodeFor", () => {
  it("maps codes to the documented exit codes", () => {
    expect(exitCodeFor("CONFLICTS_PENDING")).toBe(2);
    expect(exitCodeFor("DRIFT_DETECTED")).toBe(3);
    expect(exitCodeFor("OUTDATED")).toBe(4);
    expect(exitCodeFor("CONFIG_INVALID")).toBe(1);
    expect(exitCodeFor("NOT_INITIALIZED")).toBe(1);
  });
});

describe("sync --help", () => {
  it("lists every documented flag", async () => {
    const usage = stripAnsi(await renderUsage(syncCommand));
    for (const flag of ["--interactive", "--dry-run", "--only", "--no-version-sync", "--yes", "--force", "--json"]) {
      expect(usage).toContain(flag);
    }
    expect(usage).toMatchSnapshot();
  });
});

// citty's usage error must surface through the machine contract rather than its own
// human output. The companion no-ANSI assertion lives in scripts/e2e-dry-run.mjs:
// citty fixes color support at import time, so only a subprocess can force color on
// and prove the strip works. Here it would pass vacuously.
describe("an unknown command under --json", () => {
  const previousExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
  });

  it("reports USAGE and exits non-zero", async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    });

    await runCli(["bogus-command", "--json"]);

    const envelope = JSON.parse(chunks.join("")) as {
      ok: boolean;
      command: string;
      error: { code: string; message: string };
      exitCode: number;
    };

    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe("bogus-command");
    expect(envelope.error.code).toBe("USAGE");
    expect(envelope.error.message).toContain("bogus-command");
    expect(envelope.exitCode).toBe(1);
    expect(process.exitCode).toBe(1);
  });
});

describe("check --json on an uninitialized repo", () => {
  const previousExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
  });

  it("emits a well-formed JSON error envelope and a non-zero exit", async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    });
    vi.spyOn(process, "cwd").mockReturnValue(join(fixtures, "uninitialized"));

    await checkCommand.run?.({ args: { "json": true, "fail-on": "drift" } } as unknown as CheckRunCtx);

    const envelope = JSON.parse(chunks.join("")) as {
      ok: boolean;
      command: string;
      error: { code: string; message: string };
      exitCode: number;
    };

    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe("check");
    expect(envelope.error.code).toBe("NOT_INITIALIZED");
    expect(envelope.exitCode).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(envelope).toMatchSnapshot();
  });
});
