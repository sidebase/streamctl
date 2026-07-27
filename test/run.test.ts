import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeCommand } from "../src/commands/run";
import { StreamctlError } from "../src/errors";

/**
 * A throwing command body must set `process.exitCode` from the code-to-exit map
 * and never rethrow past `executeCommand`. The write streams are stubbed so the
 * emitted envelope does not pollute the test output.
 */
describe("executeCommand error boundary", () => {
  const previousExitCode = process.exitCode;

  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = previousExitCode;
  });

  it("DRIFT_DETECTED exits 3", async () => {
    await expect(
      executeCommand("check", true, () => {
        throw new StreamctlError("DRIFT_DETECTED", "drift");
      }),
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBe(3);
  });

  it("CONFLICTS_PENDING exits 2, so the mapping is real and not a hardcoded value", async () => {
    await expect(
      executeCommand("sync", true, () => {
        throw new StreamctlError("CONFLICTS_PENDING", "conflicts");
      }),
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBe(2);
  });

  it("a plain Error is caught too and treated as UNKNOWN", async () => {
    await expect(
      executeCommand("status", true, () => {
        throw new Error("boom");
      }),
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
  });

  it("swallows a rejected async body as well", async () => {
    await expect(
      executeCommand("upgrade", true, async () => {
        await Promise.resolve();
        throw new StreamctlError("OUTDATED", "outdated");
      }),
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBe(4);
  });

  it("a clean run exits 0", async () => {
    await expect(executeCommand("status", true, () => ({ ok: true }))).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);
  });
});
