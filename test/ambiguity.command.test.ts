import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { statusCommand } from "../src/commands/status";
import { captureStderr } from "./helpers/streams";

type StatusArgs = Parameters<NonNullable<typeof statusCommand.run>>[0];

/** The root config pins this; the legacy config pins something else on purpose. */
const VERSION = "9.9.9";
const LEGACY_VERSION = "1.1.1";

const TEMPLATES: Record<string, string> = {
  "manifest.json": JSON.stringify({ schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" }),
  "base/preset.json": JSON.stringify({
    name: "base",
    files: [{ path: ".editorconfig", strategy: "full", source: "base/editorconfig" }],
  }),
  "base/editorconfig": "root = true\n",
};

function config(version: string): string {
  return `export default { package: "@acme/payload", base: "base", version: "${version}", profile: "nuxt-4" };\n`;
}

let repo: string;
const previousExitCode = process.exitCode;
const stdout: string[] = [];

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "streamctl-ambiguity-"));
  const pkg = join(repo, "node_modules", "@acme", "payload");
  await mkdir(join(pkg, "presets", "base"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@acme/payload", version: VERSION }));
  for (const [source, content] of Object.entries(TEMPLATES)) {
    await writeFile(join(pkg, "presets", source), content);
  }
  await writeFile(join(repo, ".editorconfig"), "root = true\n");

  // Both locations, which is the case under test.
  await writeFile(join(repo, "streamctl.config.ts"), config(VERSION));
  await mkdir(join(repo, ".streamctl"), { recursive: true });
  await writeFile(join(repo, ".streamctl", "config.ts"), config(LEGACY_VERSION));

  stdout.length = 0;
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  await rm(repo, { recursive: true, force: true });
});

describe("both config locations present", () => {
  it("warns on stderr and keeps the --json envelope clean", async () => {
    const stderr = captureStderr();

    await statusCommand.run?.({ args: { json: true } } as unknown as StatusArgs);

    expect(process.exitCode).toBe(0);

    // stdout is the envelope and nothing else: it must still parse, and must not carry
    // the warning text.
    const envelope = JSON.parse(stdout.join("")) as { ok: boolean; data: { payload: { pinned: string } } };
    expect(envelope.ok).toBe(true);
    expect(stdout.join("")).not.toContain("streamctl:");

    // Exactly one warning, naming both paths. Substrings only — Q1's wording is open.
    //
    // This length assertion, not the stdout ones above, is what a `console.warn` in the
    // resolver would break: `console.warn` goes to stderr, so stdout stays clean either
    // way. And it only catches it because vitest intercepts `console`, bypassing the
    // `process.stderr.write` spy — in production `console.warn` does reach stderr. So
    // this is a harness artifact, not evidence that `console.*` in the resolver is
    // caught. The `Logger` seam is enforced by review, not by this test.
    const lines = stderr.join("").split("\n").filter(line => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("streamctl.config.ts");
    expect(lines[0]).toContain(".streamctl/config.ts");

    // The root config is the one that was read: it pins the installed version, while the
    // legacy file pins something else.
    expect(envelope.data.payload.pinned).toBe(VERSION);
  });

  it("warns once on a non-json run too", async () => {
    const stderr = captureStderr();

    await statusCommand.run?.({ args: {} } as unknown as StatusArgs);

    expect(process.exitCode).toBe(0);
    const lines = stderr.join("").split("\n").filter(line => line.length > 0);
    expect(lines).toHaveLength(1);
  });
});
