import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamctlError } from "../src/errors";
import { Reporter } from "../src/reporter";

/** Capture stdout writes for one Reporter call. */
function captureStdout(): string[] {
  const out: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  return out;
}

/** Capture stderr writes for one Reporter call. */
function captureStderr(): string[] {
  const out: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  return out;
}

describe("Reporter --json envelope hardening", () => {
  const previousDebug = process.env.STREAMCTL_DEBUG;

  afterEach(() => {
    if (previousDebug === undefined) {
      delete process.env.STREAMCTL_DEBUG;
    } else {
      process.env.STREAMCTL_DEBUG = previousDebug;
    }
    vi.restoreAllMocks();
  });

  it("circular failure details fall back to SERIALIZATION_FAILED", () => {
    const out = captureStdout();
    const circular: Record<string, unknown> = {};
    circular.self = circular; // JSON.stringify would throw on this.
    const reporter = new Reporter(true);

    expect(() => reporter.failure("check", new StreamctlError("CONFIG_INVALID", "boom", circular))).not.toThrow();

    const envelope = JSON.parse(out.join("")) as { ok: boolean; command: string; error: { code: string; message: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe("check");
    expect(envelope.error.code).toBe("SERIALIZATION_FAILED");
    expect(envelope.error.message).toContain("could not be serialized");
  });

  it("guards the success path too: BigInt data falls back instead of throwing", () => {
    const out = captureStdout();
    const reporter = new Reporter(true);

    expect(() => reporter.success("status", { n: 1n })).not.toThrow();

    const envelope = JSON.parse(out.join("")) as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("SERIALIZATION_FAILED");
  });

  it("attaches a stack under details when STREAMCTL_DEBUG is set", () => {
    process.env.STREAMCTL_DEBUG = "1";
    const out = captureStdout();

    new Reporter(true).failure("sync", new Error("kaboom"));

    const envelope = JSON.parse(out.join("")) as { error: { code: string; details?: { stack?: string; cause?: unknown } } };
    expect(envelope.error.code).toBe("UNKNOWN");
    expect(typeof envelope.error.details?.stack).toBe("string");
    expect(envelope.error.details?.stack).toContain("kaboom");
  });

  it("omits it when STREAMCTL_DEBUG is unset", () => {
    delete process.env.STREAMCTL_DEBUG;
    const out = captureStdout();

    new Reporter(true).failure("sync", new Error("kaboom"));

    const envelope = JSON.parse(out.join("")) as { error: { code: string; details?: unknown } };
    expect(envelope.error.code).toBe("UNKNOWN");
    expect(envelope.error.details).toBeUndefined();
  });
});

describe("Reporter human output markers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warn prefixes [WARN] and writes to stderr", () => {
    const err = captureStderr();
    new Reporter(false).warn("heads up");
    expect(err.join("")).toBe("[WARN] heads up\n");
  });

  it("warn omits the prefix in --json mode, stderr stays a plain line", () => {
    const err = captureStderr();
    new Reporter(true).warn("heads up");
    expect(err.join("")).toBe("heads up\n");
  });

  it("an unrenderable success result falls back to the [OK] marker", () => {
    const out = captureStdout();
    // `null` matches no result shape, so renderReport returns null and we get a marker.
    new Reporter(false).success("sync", null);
    expect(out.join("")).toBe("[OK] sync\n");
  });

  it("CONFLICTS_PENDING maps to [CONFLICT]", () => {
    const err = captureStderr();
    // No renderable details, so this is the marker line rather than a report.
    new Reporter(false).failure("sync", new StreamctlError("CONFLICTS_PENDING", "conflicts remain"));
    expect(err.join("")).toBe("[CONFLICT] conflicts remain\n");
  });

  it("DRIFT_DETECTED maps to [DRIFT]", () => {
    const err = captureStderr();
    new Reporter(false).failure("check", new StreamctlError("DRIFT_DETECTED", "drift found"));
    expect(err.join("")).toBe("[DRIFT] drift found\n");
  });

  it("any other code maps to [ERROR]", () => {
    const err = captureStderr();
    new Reporter(false).failure("status", new StreamctlError("CONFIG_INVALID", "bad config"));
    expect(err.join("")).toBe("[ERROR] bad config\n");
  });

  it("a plain Error also comes out under [ERROR]", () => {
    const err = captureStderr();
    new Reporter(false).failure("status", new Error("boom"));
    expect(err.join("")).toBe("[ERROR] boom\n");
  });

  it("threads the lockfileHint into a rendered sync report", () => {
    const out = captureStdout();
    const reporter = new Reporter(false, false); // color off, so the output is greppable
    reporter.lockfileHint = "pnpm install";
    reporter.success("sync", {
      syncedVersion: "1.2.3",
      written: ["a.txt"],
      conflicted: [],
      skipped: [],
      versionChanges: [],
      versionsSkippedAhead: [],
      warnings: [],
      lockfileStale: true,
    });
    const text = out.join("");
    expect(text).toContain("lockfile is stale");
    expect(text).toContain("`pnpm install`");
  });
});
