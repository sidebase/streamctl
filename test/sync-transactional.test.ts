import type { ManagedFile, StreamctlConfig } from "../src/config/types";
import type { PayloadHandle } from "../src/payload/resolve";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSync } from "../src/engine/sync";
import { StreamctlError } from "../src/errors";

const config: StreamctlConfig = { package: "@acme/payload", base: "base", version: "1.0.0", profile: "n4" };

function stubPayload(files: Record<string, string>): PayloadHandle {
  return {
    version: "1.0.0",
    async read(source) {
      if (!(source in files)) {
        throw new Error(`missing fixture source: ${source}`);
      }
      return files[source] as string;
    },
    async list() {
      return Object.keys(files).sort();
    },
  };
}

let cwd: string;
const exists = async (path: string): Promise<boolean> => readFile(join(cwd, path)).then(() => true).catch(() => false);

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "streamctl-tx-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("runSync transactional batch (validate-all-then-write)", () => {
  it("writes nothing when one file in the set composes to invalid output", async () => {
    const FILES: ManagedFile[] = [
      { path: "a.txt", strategy: "full", source: "a" },
      { path: "b.txt", strategy: "full", source: "b" },
      { path: "c.json", strategy: "full", source: "c" }, // composes to invalid JSON
      { path: "d.txt", strategy: "full", source: "d" },
      { path: "e.txt", strategy: "full", source: "e" },
    ];
    const payload = stubPayload({ a: "alpha\n", b: "bravo\n", c: "{ invalid json ", d: "delta\n", e: "echo\n" });

    const error = await runSync({ cwd, payload, config, managedFiles: FILES }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFLICTS_PENDING");

    const details = (error as StreamctlError).details as { written: string[]; conflicted: { path: string; kind: string }[] };
    expect(details.written).toEqual([]);
    expect(details.conflicted.map(c => c.path)).toContain("c.json");
    // A structural error composes to a `fault` conflict, which --force cannot fix.
    expect(details.conflicted.find(c => c.path === "c.json")?.kind).toBe("fault");

    // Not one of the five reached disk: the batch aborts before any write.
    for (const f of ["a.txt", "b.txt", "c.json", "d.txt", "e.txt"]) {
      expect(await exists(f)).toBe(false);
    }
  });

  it("a malformed package.json aborts in the plan pass, before any write", async () => {
    const FILES: ManagedFile[] = [
      { path: "a.txt", strategy: "full", source: "a" },
    ];
    const payload = stubPayload({ a: "alpha\n" });
    // The version reconcile strict-parses package.json and aborts up front.
    await writeFile(join(cwd, "package.json"), "{ not valid json ");

    const error = await runSync({ cwd, payload, config, managedFiles: FILES }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");

    expect(await exists("a.txt")).toBe(false);
  });
});

describe("runSync conflict classification (kind)", () => {
  async function conflictOf(managedFiles: ManagedFile[], payload: PayloadHandle): Promise<{ path: string; reason: string; kind: string }> {
    const error = await runSync({ cwd, payload, config, managedFiles }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFLICTS_PENDING");
    const details = (error as StreamctlError).details as { conflicted: { path: string; reason: string; kind: string }[] };
    return details.conflicted[0]!;
  }

  it("classifies a post-sync hand-edit of a full file as `edit`", async () => {
    const FULL: ManagedFile = { path: "x.txt", strategy: "full", source: "x" };
    const payload = stubPayload({ x: "target\n" });
    await runSync({ cwd, payload, config, managedFiles: [FULL] });
    await writeFile(join(cwd, "x.txt"), "hand edit\n");

    const c = await conflictOf([FULL], payload);
    expect(c.kind).toBe("edit");
    expect(c.reason).toBe("local edits to streamctl-owned content");
  });

  it("adoption: expected classifies as `adoption` with softened wording", async () => {
    const ADOPT: ManagedFile = { path: "y.txt", strategy: "full", source: "y", adoption: "expected" };
    const payload = stubPayload({ y: "managed\n" });
    await writeFile(join(cwd, "y.txt"), "pre-existing\n");

    const c = await conflictOf([ADOPT], payload);
    expect(c.kind).toBe("adoption");
    expect(c.reason).toContain("adopting is expected");
  });

  it("adoption: unexpected is still `adoption`, only the reason text differs", async () => {
    const ADOPT: ManagedFile = { path: "z.txt", strategy: "full", source: "z", adoption: "unexpected" };
    const payload = stubPayload({ z: "managed\n" });
    await writeFile(join(cwd, "z.txt"), "pre-existing\n");

    const c = await conflictOf([ADOPT], payload);
    expect(c.kind).toBe("adoption");
    expect(c.reason).toContain("differs unexpectedly");
  });

  it("prefers `edit` when there is no adoption hint", async () => {
    const FULL: ManagedFile = { path: "w.txt", strategy: "full", source: "w" };
    const payload = stubPayload({ w: "managed\n" });
    await writeFile(join(cwd, "w.txt"), "pre-existing\n");

    const c = await conflictOf([FULL], payload);
    expect(c.kind).toBe("edit");
  });

  // `malformed`, not `fault`: the broken file is in this repo, so the remediation is
  // "repair it here", the opposite of `fault`'s "fix the payload".
  it("classifies broken block markers as `malformed`", async () => {
    const BLOCK: ManagedFile = { path: ".npmrc", strategy: "block", source: "npmrc", blockMark: "registry" };
    const payload = stubPayload({ npmrc: "registry=https://example\n" });
    // Duplicated BEGIN markers: an unrecoverable marker fault that --force can't repair.
    await writeFile(join(cwd, ".npmrc"), "# BEGIN streamctl MANAGED BLOCK registry\n# BEGIN streamctl MANAGED BLOCK registry\n# END streamctl MANAGED BLOCK registry\n");

    const c = await conflictOf([BLOCK], payload);
    expect(c.kind).toBe("malformed");
  });

  it("classifies a malformed merge target as `malformed`, keeping `fault` for payload bugs", async () => {
    const MERGE: ManagedFile = { path: ".vscode/settings.json", strategy: "merge", source: "settings" };
    const payload = stubPayload({ settings: `{ "editor.tabSize": 2 }` });
    await mkdir(join(cwd, ".vscode"), { recursive: true });
    // Duplicate key: strict JSONC rejects it, and it is the consumer's own file.
    await writeFile(join(cwd, ".vscode/settings.json"), `{ "a": 1, "a": 2 }\n`);

    const c = await conflictOf([MERGE], payload);
    expect(c.kind).toBe("malformed");
  });
});

let hasGit = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  hasGit = false;
}

// On CI, assert git is actually there so the skipIf(!hasGit) suite below can't
// vanish silently. Locally (no `CI`) this is a no-op.
describe.skipIf(!process.env.CI)("dirty-tree guard git sentinel (CI only)", () => {
  it("has git available so the dirty-tree guard suite is not silently skipped", () => {
    expect(hasGit).toBe(true);
  });
});

describe.skipIf(!hasGit)("runSync dirty-tree guard", () => {
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=test", ...args], { cwd, stdio: "ignore" });
  };

  it("refuses to overwrite a tracked, uncommitted owned file, and --force overrides", async () => {
    const NPMRC: ManagedFile = { path: ".npmrc", strategy: "block", source: "npmrc", blockMark: "registry" };
    const payload = stubPayload({ npmrc: "registry=https://example\n" });

    // Sync writes the managed block, then commit it so the tree is clean + tracked.
    await runSync({ cwd, payload, config, managedFiles: [NPMRC] });
    git("init");
    git("add", "-A");
    git("commit", "-m", "init");

    // Dirty the owned file in-region so this is a genuine planned rewrite, not a no-op.
    await writeFile(
      join(cwd, ".npmrc"),
      "# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://evil\n# END streamctl MANAGED BLOCK registry\n",
    );

    const error = await runSync({ cwd, payload, config, managedFiles: [NPMRC] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFLICTS_PENDING");
    expect((error as StreamctlError).message).toContain(".npmrc");
    // The dirty-tree guard classifies the entry as `dirty`.
    const details = (error as StreamctlError).details as { conflicted: { path: string; kind: string }[] };
    expect(details.conflicted).toEqual([{ path: ".npmrc", reason: expect.any(String), kind: "dirty" }]);
    // Refused: the dirty file is untouched.
    expect(await readFile(join(cwd, ".npmrc"), "utf8")).toContain("evil");

    // --force bypasses the dirty-tree refusal and rewrites the owned region.
    const result = await runSync({ cwd, payload, config, managedFiles: [NPMRC], force: true });
    expect(result.written).toEqual([".npmrc"]);
    expect(await readFile(join(cwd, ".npmrc"), "utf8")).toContain("registry=https://example");
  });

  it("--dry-run warns about a dirty owned path instead of throwing", async () => {
    const NPMRC: ManagedFile = { path: ".npmrc", strategy: "block", source: "npmrc", blockMark: "registry" };
    const payload = stubPayload({ npmrc: "registry=https://example\n" });

    await runSync({ cwd, payload, config, managedFiles: [NPMRC] });
    git("init");
    git("add", "-A");
    git("commit", "-m", "init");
    await writeFile(
      join(cwd, ".npmrc"),
      "# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://evil\n# END streamctl MANAGED BLOCK registry\n",
    );

    const warnings: string[] = [];
    // A dirty tree must not throw here; the warning is how the plan reflects the real refusal.
    await runSync({ cwd, payload, config, managedFiles: [NPMRC], dryRun: true, logger: { warn: m => warnings.push(m) } });
    expect(warnings.some(w => w.includes(".npmrc"))).toBe(true);
    expect(await readFile(join(cwd, ".npmrc"), "utf8")).toContain("evil");
  });

  it("allowDirty skips the guard so init's own first sync is never refused", async () => {
    const NPMRC: ManagedFile = { path: ".npmrc", strategy: "block", source: "npmrc", blockMark: "registry" };
    const payload = stubPayload({ npmrc: "registry=https://example\n" });

    await runSync({ cwd, payload, config, managedFiles: [NPMRC] });
    git("init");
    git("add", "-A");
    git("commit", "-m", "init");
    await writeFile(
      join(cwd, ".npmrc"),
      "# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://evil\n# END streamctl MANAGED BLOCK registry\n",
    );

    // Without allowDirty this would throw CONFLICTS_PENDING; with it the rewrite proceeds.
    const result = await runSync({ cwd, payload, config, managedFiles: [NPMRC], allowDirty: true });
    expect(result.written).toEqual([".npmrc"]);
    expect(await readFile(join(cwd, ".npmrc"), "utf8")).toContain("registry=https://example");
  });

  it("a dirty project-owned scaffold only warns", async () => {
    const SCAFFOLD: ManagedFile = { path: "eslint.config.ts", strategy: "scaffold", source: "eslint" };
    const payload = stubPayload({ eslint: "export default 1\n" });

    await runSync({ cwd, payload, config, managedFiles: [SCAFFOLD] });
    git("init");
    git("add", "-A");
    git("commit", "-m", "init");
    await writeFile(join(cwd, "eslint.config.ts"), "export default localEdit()\n");

    const warnings: string[] = [];
    const result = await runSync({ cwd, payload, config, managedFiles: [SCAFFOLD], logger: { warn: m => warnings.push(m) } });
    expect(result.written).toEqual([]); // scaffold already present, so it is skipped
    expect(warnings.some(w => w.includes("eslint.config.ts"))).toBe(true);
    expect(await readFile(join(cwd, "eslint.config.ts"), "utf8")).toContain("localEdit");
  });

  it("does not block an unrelated planned write when a dirty owned file is content-equal", async () => {
    const X: ManagedFile = { path: "x.txt", strategy: "full", source: "x" };
    const Y: ManagedFile = { path: "y.txt", strategy: "full", source: "y" };
    const payload = stubPayload({ x: "xcontent\n", y: "ycontent\n" });

    // Sync + commit X so it is tracked and in-sync.
    await runSync({ cwd, payload, config, managedFiles: [X] });
    git("init");
    git("add", "-A");
    git("commit", "-m", "init");

    // Dirty X cosmetically: trailing blank lines are content-equal, so X is skipped,
    // but git still sees an uncommitted change.
    await writeFile(join(cwd, "x.txt"), "xcontent\n\n\n");

    // Y is absent, so it is a clean planned create. The run must proceed and write it.
    const result = await runSync({ cwd, payload, config, managedFiles: [X, Y] });
    expect(result.written).toEqual(["y.txt"]);
    expect(result.skipped).toContain("x.txt");
    // X keeps its cosmetic dirt exactly as the user left it.
    expect(await readFile(join(cwd, "x.txt"), "utf8")).toBe("xcontent\n\n\n");
  });

  it("still blocks when the dirty owned file is itself a planned write", async () => {
    const NPMRC: ManagedFile = { path: ".npmrc", strategy: "block", source: "npmrc", blockMark: "registry" };
    const payload = stubPayload({ npmrc: "registry=https://example\n" });

    await runSync({ cwd, payload, config, managedFiles: [NPMRC] });
    git("init");
    git("add", "-A");
    git("commit", "-m", "init");

    // Dirty the owned region so the composed target genuinely differs, making this a
    // planned write. The dirty set and the planned writes overlap, so the guard refuses.
    await writeFile(
      join(cwd, ".npmrc"),
      "# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://evil\n# END streamctl MANAGED BLOCK registry\n",
    );

    const error = await runSync({ cwd, payload, config, managedFiles: [NPMRC] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFLICTS_PENDING");
    const details = (error as StreamctlError).details as { conflicted: { path: string; kind: string }[] };
    expect(details.conflicted).toEqual([{ path: ".npmrc", reason: expect.any(String), kind: "dirty" }]);
    // Refused: the dirty file is untouched.
    expect(await readFile(join(cwd, ".npmrc"), "utf8")).toContain("evil");
  });

  // package.json is not an owned managed file, so the guard never covers it, yet the
  // version reconcile still edits it. Policy: warn when it was already dirty, never
  // refuse. The baseline below reconciles `engines.node`.
  const s4Baseline = { "engines.node": ">=24.13.0" };
  const skewedPkg = `${JSON.stringify({ name: "app", engines: { node: ">=20.0.0" } }, null, 2)}\n`;

  it("warns when a reconcile edits an already-dirty package.json, but still applies the edit", async () => {
    await writeFile(join(cwd, "package.json"), skewedPkg);
    git("init");
    git("add", "-A");
    git("commit", "-m", "init");

    // Dirty package.json with an unrelated tracked edit; engines stays skewed so
    // the reconcile still bumps it.
    await writeFile(join(cwd, "package.json"), `${JSON.stringify({ name: "app-renamed", engines: { node: ">=20.0.0" } }, null, 2)}\n`);

    const warnings: string[] = [];
    const result = await runSync({ cwd, payload: stubPayload({}), config, managedFiles: [], baseline: s4Baseline, logger: { warn: m => warnings.push(m) } });

    // Not refused: the reconcile applied and only warned.
    expect(result.versionChanges.map(c => c.key)).toEqual(["engines.node"]);
    expect(await readFile(join(cwd, "package.json"), "utf8")).toContain(">=24.13.0");
    expect(warnings.some(w => w.includes("package.json") && w.includes("uncommitted"))).toBe(true);
  });

  it("does not warn when the reconciled package.json was clean", async () => {
    await writeFile(join(cwd, "package.json"), skewedPkg);
    git("init");
    git("add", "-A");
    git("commit", "-m", "init"); // committed, so package.json is clean before the reconcile

    const warnings: string[] = [];
    const result = await runSync({ cwd, payload: stubPayload({}), config, managedFiles: [], baseline: s4Baseline, logger: { warn: m => warnings.push(m) } });

    // The reconcile still edits package.json, but it was clean beforehand, so no warning.
    expect(result.versionChanges.map(c => c.key)).toEqual(["engines.node"]);
    expect(warnings.some(w => w.includes("package.json") && w.includes("uncommitted"))).toBe(false);
  });
});
