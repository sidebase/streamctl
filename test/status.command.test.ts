import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { statusCommand } from "../src/commands/status";

type StatusArgs = Parameters<NonNullable<typeof statusCommand.run>>[0];

const VERSION = "9.9.9";

const TEMPLATES: Record<string, string> = {
  "manifest.json": JSON.stringify({ schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" }),
  "base/preset.json": JSON.stringify({
    name: "base",
    files: [
      { path: ".editorconfig", strategy: "full", source: "base/editorconfig" },
      { path: ".npmrc", strategy: "block", source: "base/npmrc", blockMark: "registry" },
    ],
  }),
  "base/editorconfig": "root = true\n",
  "base/npmrc": "registry=https://example\n",
};

let repo: string;
const previousExitCode = process.exitCode;
const stdout: string[] = [];

async function makeRepo(): Promise<void> {
  const pkg = join(repo, "node_modules", "@acme", "payload");
  await mkdir(join(pkg, "presets", "base"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@acme/payload", version: VERSION }));
  for (const [source, content] of Object.entries(TEMPLATES)) {
    await writeFile(join(pkg, "presets", source), content);
  }
  await mkdir(join(repo, ".streamctl"), { recursive: true });
  await writeFile(join(repo, ".streamctl", "config.ts"), `export default { package: "@acme/payload", base: "base", version: "${VERSION}", profile: "nuxt-4" };\n`);
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "streamctl-status-cmd-"));
  await makeRepo();
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

describe("status command", () => {
  // Regression: an owned-key type mismatch used to blow up the read-only status
  // command with a raw internal error. It has to read as the `fault` state instead.
  it("reports an owned-key type mismatch as a fault", async () => {
    const pkg = join(repo, "node_modules", "@acme", "payload");
    await writeFile(
      join(pkg, "presets", "base", "preset.json"),
      JSON.stringify({
        name: "base",
        files: [{ path: ".vscode/settings.json", strategy: "merge", source: "base/vscode-settings.json", projectFields: [] }],
      }),
    );
    await writeFile(join(pkg, "presets", "base", "vscode-settings.json"), JSON.stringify({ editor: { formatOnSave: true } }));
    await mkdir(join(repo, ".vscode"), { recursive: true });
    await writeFile(join(repo, ".vscode", "settings.json"), `{ "editor": "custom" }`);

    await statusCommand.run?.({ args: { json: true } } as unknown as StatusArgs);
    expect(process.exitCode).toBe(0);

    const envelope = JSON.parse(stdout.join("")) as { ok: boolean; data: { files: { path: string; state: string }[] } };
    expect(envelope.data.files).toContainEqual(expect.objectContaining({ path: ".vscode/settings.json", state: "fault" }));
  });

  it("still exits 0 with both drift and conflicts present", async () => {
    await writeFile(join(repo, ".editorconfig"), "root = false\n"); // full differs: conflict
    await writeFile(join(repo, ".npmrc"), "# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://evil\n# END streamctl MANAGED BLOCK registry\n"); // block differs: drift

    await statusCommand.run?.({ args: {} } as unknown as StatusArgs);
    expect(process.exitCode).toBe(0);

    const out = stdout.join("");
    expect(out).toContain("streamctl status");
    expect(out).toContain("conflict");
    expect(out).toContain("drift");
  });

  it("emits a JSON envelope whose files agree with the table", async () => {
    await writeFile(join(repo, ".editorconfig"), "root = true\n");

    await statusCommand.run?.({ args: { json: true } } as unknown as StatusArgs);
    expect(process.exitCode).toBe(0);

    const envelope = JSON.parse(stdout.join("")) as { ok: boolean; command: string; data: { files: { path: string; state: string; strategy: string }[]; payload: { package: string; pinned: string }; lockfileStale: boolean }; exitCode: number };
    expect(envelope).toMatchObject({ ok: true, command: "status", exitCode: 0 });
    expect(envelope.data.payload).toMatchObject({ package: "@acme/payload", pinned: VERSION });
    expect(envelope.data.files.find(f => f.path === ".editorconfig")).toEqual({ path: ".editorconfig", state: "in-sync", strategy: "full" });
    expect(typeof envelope.data.lockfileStale).toBe("boolean");
  });

  it("exits 1 when the repo has no config", async () => {
    await rm(join(repo, ".streamctl"), { recursive: true, force: true });

    await statusCommand.run?.({ args: {} } as unknown as StatusArgs);
    expect(process.exitCode).toBe(1);
  });
});
