import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkCommand } from "../src/commands/check";
import { syncCommand } from "../src/commands/sync";

type SyncArgs = Parameters<NonNullable<typeof syncCommand.run>>[0];
type CheckArgs = Parameters<NonNullable<typeof checkCommand.run>>[0];

const VERSION = "9.9.9";

const TEMPLATES: Record<string, string> = {
  // Declares the `nuxt-4` that the config below pins and that `base/preset.json`'s
  // versionProfiles keys off. A payload using a profile must declare it.
  "manifest.json": JSON.stringify({ schemaVersion: 2, presets: ["base"], profiles: [{ name: "nuxt-4" }], defaultBase: "base" }),
  "base/preset.json": JSON.stringify({
    name: "base",
    files: [
      { path: ".editorconfig", strategy: "full", source: "base/editorconfig" },
      { path: ".npmrc", strategy: "block", source: "base/npmrc", blockMark: "registry" },
      { path: "eslint.config.ts", strategy: "scaffold", source: "base/eslint.config.ts", shadowedBy: ["eslint.config.mjs"] },
    ],
    // Baseline reconciles engines.node; inert unless a test repo carries a
    // (skewed) package.json.
    versionProfiles: { "nuxt-4": { "engines.node": ">=24.13.0" } },
  }),
  "base/editorconfig": "root = true\n",
  "base/npmrc": "registry=https://example\n",
  "base/eslint.config.ts": "export default 1\n",
};

let repo: string;
const previousExitCode = process.exitCode;

/** Build a temp consuming repo: installed config payload + a valid .streamctl/config.ts. */
async function makeRepo(): Promise<void> {
  // Keep the lockfile walk inside the fixture (see test/pm.test.ts); a stray
  // lockfile above the tmpdir would print a false stale-lockfile hint.
  await mkdir(join(repo, ".git"), { recursive: true });
  const pkg = join(repo, "node_modules", "@acme", "payload");
  await mkdir(join(pkg, "presets", "base"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@acme/payload", version: VERSION }));
  for (const [source, content] of Object.entries(TEMPLATES)) {
    await writeFile(join(pkg, "presets", source), content);
  }
  await mkdir(join(repo, ".streamctl"), { recursive: true });
  await writeFile(join(repo, ".streamctl", "config.ts"), `export default { package: "@acme/payload", base: "base", version: "${VERSION}", profile: "nuxt-4" };\n`);
}

/** The consumer's `.vscode/settings.json`: `editor` is a string, the payload declares an object. */
const MISMATCHED = `{ "editor": "custom" }`;

/**
 * Re-declare the payload preset with a single nested `merge` file and give the
 * consumer a scalar where the payload declares an object. Scoped to the tests
 * that need it so the shared fixture above stays untouched.
 */
async function withOwnedKeyTypeMismatch(): Promise<void> {
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
  await writeFile(join(repo, ".vscode", "settings.json"), MISMATCHED);
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "streamctl-cmd-"));
  await makeRepo();
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  await rm(repo, { recursive: true, force: true });
});

describe("sync + check commands (exit codes)", () => {
  it("sync writes the managed files, then check reports in sync", async () => {
    await syncCommand.run?.({ args: {} } as unknown as SyncArgs);
    expect(process.exitCode).toBe(0);
    expect(await readFile(join(repo, ".editorconfig"), "utf8")).toBe("root = true\n");
    expect(await readFile(join(repo, "eslint.config.ts"), "utf8")).toBe("export default 1\n");

    process.exitCode = previousExitCode;
    await checkCommand.run?.({ args: { "fail-on": "drift" } } as unknown as CheckArgs);
    expect(process.exitCode).toBe(0);
  });

  // citty hands back `""` for `--only` with no value, and `runSync` reads a falsy filter
  // as "no filter" — so a run the user scoped to one file used to write every managed
  // file. `sync --only "$VAR"` with VAR unset is the realistic way to hit it.
  it("sync --only with no value fails instead of silently syncing everything", async () => {
    await syncCommand.run?.({ args: { only: "" } } as unknown as SyncArgs);

    expect(process.exitCode).toBe(1);
    // Nothing was written: the guard runs before any managed file lands.
    expect(await readFile(join(repo, ".editorconfig")).catch(() => null)).toBeNull();
    expect(await readFile(join(repo, "eslint.config.ts")).catch(() => null)).toBeNull();
  });

  it("sync --only with a real glob still scopes normally", async () => {
    await syncCommand.run?.({ args: { only: ".editorconfig" } } as unknown as SyncArgs);

    expect(process.exitCode).toBe(0);
    expect(await readFile(join(repo, ".editorconfig"), "utf8")).toBe("root = true\n");
    expect(await readFile(join(repo, "eslint.config.ts")).catch(() => null)).toBeNull();
  });

  // An owned-key type mismatch is consumer data, so it has to surface as the designed
  // recoverable fault. It used to escape as a raw internal error, which made `check`
  // exit 1 and broke the CI gate contract.
  it("sync exits 2 with the merge target untouched on an owned-key type mismatch", async () => {
    await withOwnedKeyTypeMismatch();

    await syncCommand.run?.({ args: {} } as unknown as SyncArgs);
    expect(process.exitCode).toBe(2);
    expect(await readFile(join(repo, ".vscode", "settings.json"), "utf8")).toBe(MISMATCHED);
  });

  it("sync --force does not bypass an owned-key type mismatch", async () => {
    await withOwnedKeyTypeMismatch();

    await syncCommand.run?.({ args: { force: true } } as unknown as SyncArgs);
    expect(process.exitCode).toBe(2);
    expect(await readFile(join(repo, ".vscode", "settings.json"), "utf8")).toBe(MISMATCHED);
  });

  it("check reports drift (3), not an internal error, on an owned-key type mismatch", async () => {
    await withOwnedKeyTypeMismatch();

    await checkCommand.run?.({ args: { "fail-on": "drift" } } as unknown as CheckArgs);
    expect(process.exitCode).toBe(3);
  });

  it("check --json carries the fault reason, not just the drifted path", async () => {
    await withOwnedKeyTypeMismatch();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });

    await checkCommand.run?.({ args: { "fail-on": "drift", "json": true } } as unknown as CheckArgs);

    const envelope = JSON.parse(out.join("")) as { error: { details: { drift: { path: string; kind: string; reason?: string }[] } } };
    expect(envelope.error.details.drift).toContainEqual(
      expect.objectContaining({ path: ".vscode/settings.json", kind: "extra", reason: expect.stringContaining("type mismatch") }),
    );
  });

  // Two broken-payload shapes: a source the payload does not ship, and no presets/
  // tree at all. Both are PAYLOAD_INVALID at exit 1; exit 4 belongs to OUTDATED.
  // The envelope must also stay free of the absolute node_modules path, which it
  // used to leak by embedding the raw fs message.
  /** Point the preset at a source the payload does not ship. */
  async function withMissingSource(): Promise<void> {
    await writeFile(
      join(repo, "node_modules", "@acme", "payload", "presets", "base", "preset.json"),
      JSON.stringify({ name: "base", files: [{ path: ".editorconfig", strategy: "full", source: "base/not-shipped" }] }),
    );
  }

  /** Strip the payload's presets/ tree entirely, keeping the package installed. */
  async function withoutPresetsDir(): Promise<void> {
    await rm(join(repo, "node_modules", "@acme", "payload", "presets"), { recursive: true, force: true });
  }

  it.each([
    { case: "a missing preset source", arrange: withMissingSource },
    { case: "a payload with no presets/ directory", arrange: withoutPresetsDir },
  ])("sync exits 1 on $case", async ({ arrange }) => {
    await arrange();

    await syncCommand.run?.({ args: {} } as unknown as SyncArgs);
    expect(process.exitCode).toBe(1);
  });

  it.each([
    { case: "a missing preset source", arrange: withMissingSource },
    { case: "a payload with no presets/ directory", arrange: withoutPresetsDir },
  ])("check exits 1 on $case", async ({ arrange }) => {
    await arrange();

    await checkCommand.run?.({ args: { "fail-on": "drift" } } as unknown as CheckArgs);
    expect(process.exitCode).toBe(1);
  });

  it.each([
    { case: "a missing preset source", arrange: withMissingSource, names: "base/not-shipped" },
    { case: "a payload with no presets/ directory", arrange: withoutPresetsDir, names: "presets" },
  ])("sync --json on $case: PAYLOAD_INVALID, exit 1, no absolute path", async ({ arrange, names }) => {
    await arrange();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });

    await syncCommand.run?.({ args: { json: true } } as unknown as SyncArgs);

    const envelope = JSON.parse(out.join("")) as { ok: boolean; error: { code: string; message: string }; exitCode: number };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("PAYLOAD_INVALID");
    expect(envelope.exitCode).toBe(1);
    expect(envelope.error.message).toContain(names);
    expect(out.join("")).not.toContain(repo);
    expect(out.join("")).not.toContain(tmpdir());
  });

  // A typo'd profile in .streamctl/config.ts used to resolve the version baseline to
  // `{}`, silently disabling reconcile forever behind a soft detect warning.
  it.each([
    { command: "sync", run: async () => syncCommand.run?.({ args: {} } as unknown as SyncArgs) },
    { command: "check", run: async () => checkCommand.run?.({ args: { "fail-on": "drift" } } as unknown as CheckArgs) },
  ])("$command exits 1 on a profile the payload does not declare", async ({ run }) => {
    await writeFile(
      join(repo, ".streamctl", "config.ts"),
      `export default { package: "@acme/payload", base: "base", version: "${VERSION}", profile: "n5" };\n`,
    );

    await run();
    expect(process.exitCode).toBe(1);
  });

  it("sync --json names the undeclared profile and the declared ones", async () => {
    await writeFile(
      join(repo, ".streamctl", "config.ts"),
      `export default { package: "@acme/payload", base: "base", version: "${VERSION}", profile: "n5" };\n`,
    );
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });

    await syncCommand.run?.({ args: { json: true } } as unknown as SyncArgs);

    const envelope = JSON.parse(out.join("")) as { ok: boolean; error: { code: string; message: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("CONFIG_INVALID");
    expect(envelope.error.message).toContain("n5");
    expect(envelope.error.message).toContain("nuxt-4");
  });

  it("check exits 3 after a managed-region edit", async () => {
    await syncCommand.run?.({ args: {} } as unknown as SyncArgs);
    await writeFile(join(repo, ".editorconfig"), "root = false\n");

    process.exitCode = previousExitCode;
    await checkCommand.run?.({ args: { "fail-on": "drift" } } as unknown as CheckArgs);
    expect(process.exitCode).toBe(3);
  });

  it("sync exits 2 on an owned-content edit without --force", async () => {
    await syncCommand.run?.({ args: {} } as unknown as SyncArgs);
    await writeFile(join(repo, ".editorconfig"), "root = false\n");

    process.exitCode = previousExitCode;
    await syncCommand.run?.({ args: {} } as unknown as SyncArgs);
    expect(process.exitCode).toBe(2);
  });

  it("sync --force overwrites an owned-content edit", async () => {
    await syncCommand.run?.({ args: {} } as unknown as SyncArgs);
    await writeFile(join(repo, ".editorconfig"), "root = false\n");

    process.exitCode = previousExitCode;
    await syncCommand.run?.({ args: { force: true } } as unknown as SyncArgs);
    expect(process.exitCode).toBe(0);
    expect(await readFile(join(repo, ".editorconfig"), "utf8")).toBe("root = true\n");
  });

  it("sync --yes does not accept a full-file conflict", async () => {
    await syncCommand.run?.({ args: {} } as unknown as SyncArgs);
    await writeFile(join(repo, ".editorconfig"), "root = false\n");

    process.exitCode = previousExitCode;
    await syncCommand.run?.({ args: { yes: true } } as unknown as SyncArgs);
    expect(process.exitCode).toBe(2);
    // --yes only accepts creates and safe reconciles, so the conflict is left alone.
    expect(await readFile(join(repo, ".editorconfig"), "utf8")).toBe("root = false\n");
  });

  it("sync --json carries warnings[] in the envelope data", async () => {
    await writeFile(join(repo, "eslint.config.mjs"), "export default []\n");
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });

    await syncCommand.run?.({ args: { json: true } } as unknown as SyncArgs);
    expect(process.exitCode).toBe(0);

    const envelope = JSON.parse(out.join("")) as { ok: boolean; data: { warnings: string[] } };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.warnings).toContainEqual(
      "eslint.config.ts is shadowed by eslint.config.mjs; the scaffolded config is inert until you port and delete eslint.config.mjs.",
    );
  });

  it("sync --json warnings[] is [] when no shadow sibling is present", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });

    await syncCommand.run?.({ args: { json: true } } as unknown as SyncArgs);
    const envelope = JSON.parse(out.join("")) as { data: { warnings: string[] } };
    expect(envelope.data.warnings).toEqual([]);
  });

  it("sync --dry-run reports but leaves the tree unchanged", async () => {
    await syncCommand.run?.({ args: { "dry-run": true } } as unknown as SyncArgs);
    expect(process.exitCode).toBe(0);
    expect(await readFile(join(repo, ".editorconfig")).catch(() => null)).toBeNull();
  });

  it("sync --interactive degrades to a plan on a non-TTY and still writes", async () => {
    // In the test runner stdin is not a TTY, so interactive must not prompt/hang.
    await syncCommand.run?.({ args: { interactive: true } } as unknown as SyncArgs);
    expect(process.exitCode).toBe(0);
    expect(await readFile(join(repo, ".editorconfig"), "utf8")).toBe("root = true\n");
  });
});

describe("sync stale-lockfile hint", () => {
  const skewedPkg = JSON.stringify({ name: "app", engines: { node: ">=20.0.0" } });

  /** Capture stdout writes for this test (beforeEach swallows them). */
  function captureStdout(): string[] {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    return writes;
  }

  it("names the detected pnpm install command after a reconcile write", async () => {
    await writeFile(join(repo, "package.json"), skewedPkg);
    await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const out = captureStdout();

    await syncCommand.run?.({ args: {} } as unknown as SyncArgs);
    expect(process.exitCode).toBe(0);

    const report = out.join("");
    expect(report).toContain("lockfile is stale");
    expect(report).toContain("Run `pnpm install`");
  });

  it("names npm install when the repo carries a package-lock.json", async () => {
    await writeFile(join(repo, "package.json"), skewedPkg);
    await writeFile(join(repo, "package-lock.json"), "{}\n");
    const out = captureStdout();

    await syncCommand.run?.({ args: {} } as unknown as SyncArgs);

    // Unambiguous: `pnpm install` also contains "npm install".
    expect(out.join("")).toContain("Run `npm install`");
  });

  it("prints no hint when there is no lockfile to stale", async () => {
    await writeFile(join(repo, "package.json"), skewedPkg);
    const out = captureStdout();

    await syncCommand.run?.({ args: {} } as unknown as SyncArgs);

    expect(out.join("")).not.toContain("lockfile is stale");
  });
});
