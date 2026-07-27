import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run-cli";

describe("cli usage-error envelope", () => {
  const previousExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
  });

  it("unknown subcommand under --json", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await runCli(["chekc", "--json"]); // typo'd subcommand, so citty raises a usage CLIError

    const envelope = JSON.parse(out.join("")) as { ok: boolean; command: string; error: { code: string; message: string }; exitCode: number };
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe("chekc");
    expect(envelope.error.code).toBe("USAGE");
    expect(envelope.error.message).toBeTruthy();
    expect(envelope.exitCode).toBe(1);
    expect(process.exitCode).toBe(1);
    // The --json path sets process.exitCode; it never calls the internal process.exit.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("rejects an unknown --fail-on value and names the allowed ones", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // `outdate` used to coerce to `drift`, so CI passed while the user believed the
    // outdated gate was armed. The value is rejected before any config/payload work,
    // which is also what keeps this test hermetic: it never touches the tree.
    await runCli(["check", "--fail-on", "outdate", "--json"]);

    const envelope = JSON.parse(out.join("")) as { ok: boolean; command: string; error: { code: string; message: string }; exitCode: number };
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe("check");
    expect(envelope.error.code).toBe("CONFIG_INVALID");
    expect(envelope.error.message).toContain("outdate");
    expect(envelope.error.message).toContain("drift, outdated, any");
    expect(envelope.exitCode).toBe(1);
    expect(process.exitCode).toBe(1);
  });

  it.each([[[]], [["--fail-on", "drift"]], [["--fail-on", "outdated"]], [["--fail-on", "any"]]])(
    "accepts a valid --fail-on (%j)",
    async (flag: string[]) => {
      const out: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        out.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      await runCli(["check", ...flag, "--json"]);

      // With no flag we get citty's `drift` default, which must also survive the gate.
      // These stop at the uninitialized repo root (never reaching the registry probe),
      // so the assertion is only that the value itself was not the complaint.
      const envelope = JSON.parse(out.join("")) as { error: { message: string } };
      expect(envelope.error.message).not.toContain("--fail-on");
    },
  );

  it("without --json, usage errors still go through runMain", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await runCli(["chekc"]);

    // runMain calls process.exit(1); the --json path never does.
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(out.join("")).not.toContain("\"code\":\"USAGE\"");
  });
});
