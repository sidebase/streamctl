import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initCommand } from "../src/commands/init";

type InitArgs = Parameters<NonNullable<typeof initCommand.run>>[0];

let repo: string;
const previousExitCode = process.exitCode;

/** beforeEach swallows stdout; call this from a test that needs to read it back. */
function captureStdout(): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "streamctl-init-cmd-"));
  await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "app" }, null, 2)}\n`);
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  await rm(repo, { recursive: true, force: true });
});

describe("init --json envelope", () => {
  it("emits a success envelope", async () => {
    const out = captureStdout();

    // Every flag here exists to keep the run offline: --no-install, explicit
    // --base/--profile and --skip-registry-check scaffold without resolving or
    // installing the payload. --payload-version is passed for the same reason,
    // since resolving the pin would otherwise probe the registry.
    await initCommand.run?.({
      args: { "package": "@acme/payload", "payload-version": "1.4.0", "base": "base", "profile": "n4", "install": false, "skip-registry-check": true, "yes": true, "json": true },
    } as unknown as InitArgs);

    expect(process.exitCode).toBe(0);
    const envelope = JSON.parse(out.join("")) as { ok: boolean; command: string; exitCode: number; data: { base: string; profile: string; version: string; cliVersion: string; sync: unknown } };
    expect(envelope).toMatchObject({ ok: true, command: "init", exitCode: 0 });
    expect(envelope.data).toMatchObject({ base: "base", profile: "n4", version: "1.4.0", sync: null });
    // Regression: the pin used to fall back to the CLI's own release.
    expect(envelope.data.version).not.toBe(envelope.data.cliVersion);
  });

  it("a missing --package comes back as an error envelope, not a stack trace", async () => {
    const out = captureStdout();

    await initCommand.run?.({ args: { json: true } } as unknown as InitArgs);

    expect(process.exitCode).not.toBe(0);
    const envelope = JSON.parse(out.join("")) as { ok: boolean; command: string; error: { code: string; message: string }; exitCode: number };
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe("init");
    expect(envelope.error.code).toBe("CONFIG_INVALID");
    expect(envelope.error.message).toContain("--package");
  });
});
