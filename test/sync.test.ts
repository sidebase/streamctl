import type { ManagedFile, StreamctlConfig } from "../src/config/types";
import type { SyncBatchDecider, SyncChange, SyncDecider } from "../src/engine/sync";
import type { PayloadHandle } from "../src/payload/resolve";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSync } from "../src/engine/sync";
import { StreamctlError } from "../src/errors";

const config: StreamctlConfig = { package: "@acme/payload", base: "base", version: "1.0.0", profile: "n4" };

const payload: PayloadHandle = {
  version: "1.0.0",
  async read(source) {
    const files: Record<string, string> = {
      "base/editorconfig": "root = true\n",
      "base/npmrc": "registry=https://example\n",
      "base/eslint.config.ts": "export default createStreamctlEslint()\n",
    };
    const content = files[source];
    if (content === undefined) {
      throw new Error(`missing fixture source: ${source}`);
    }
    return content;
  },
  async list() {
    return [];
  },
};

const FILES: ManagedFile[] = [
  { path: ".editorconfig", strategy: "full", source: "base/editorconfig" },
  { path: ".npmrc", strategy: "block", source: "base/npmrc", blockMark: "registry" },
  { path: "eslint.config.ts", strategy: "scaffold", source: "base/eslint.config.ts" },
];

let cwd: string;

async function exists(path: string): Promise<boolean> {
  return readFile(join(cwd, path)).then(() => true).catch(() => false);
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "streamctl-sync-"));
  // Keep the lockfile walk inside the fixture (see test/pm.test.ts); otherwise a
  // stray lockfile above the tmpdir leaks in and flags a false stale-lockfile.
  // The dir is not a real repo, so git still reports "not a git repository" and
  // the dirty-tree guard stays disengaged here.
  await mkdir(join(cwd, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("runSync", () => {
  it("writes full, block, and scaffold files on a clean repo", async () => {
    const result = await runSync({ cwd, payload, config, managedFiles: FILES });

    expect(result.written.sort()).toEqual([".editorconfig", ".npmrc", "eslint.config.ts"]);
    expect(result.conflicted).toEqual([]);
    expect(result.syncedVersion).toBe("1.0.0");

    expect(await readFile(join(cwd, ".editorconfig"), "utf8")).toBe("root = true\n");
    expect(await readFile(join(cwd, ".npmrc"), "utf8")).toBe(
      "# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://example\n# END streamctl MANAGED BLOCK registry\n",
    );
    expect(await readFile(join(cwd, "eslint.config.ts"), "utf8")).toBe("export default createStreamctlEslint()\n");
  });

  it("second sync writes nothing", async () => {
    await runSync({ cwd, payload, config, managedFiles: FILES });
    const second = await runSync({ cwd, payload, config, managedFiles: FILES });
    expect(second.written).toEqual([]);
    expect(second.skipped.sort()).toEqual([".editorconfig", ".npmrc", "eslint.config.ts"]);
  });

  it("--dry-run reports would-be writes but touches nothing", async () => {
    const result = await runSync({ cwd, payload, config, managedFiles: FILES, dryRun: true });
    expect(result.written.sort()).toEqual([".editorconfig", ".npmrc", "eslint.config.ts"]);
    expect(await exists(".editorconfig")).toBe(false);
    expect(await exists(".npmrc")).toBe(false);
    expect(await exists("eslint.config.ts")).toBe(false);
  });

  it("does not overwrite an existing scaffold file", async () => {
    await writeFile(join(cwd, "eslint.config.ts"), "export default localOverride()\n");
    const result = await runSync({ cwd, payload, config, managedFiles: FILES });
    expect(result.skipped).toContain("eslint.config.ts");
    expect(await readFile(join(cwd, "eslint.config.ts"), "utf8")).toBe("export default localOverride()\n");
  });

  it("raises CONFLICTS_PENDING when owned content was edited", async () => {
    await runSync({ cwd, payload, config, managedFiles: FILES });
    await writeFile(join(cwd, ".editorconfig"), "root = false\n");

    const error = await runSync({ cwd, payload, config, managedFiles: FILES }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFLICTS_PENDING");
    const details = (error as StreamctlError).details as { conflicted: { path: string }[] };
    expect(details.conflicted.map(c => c.path)).toEqual([".editorconfig"]);
    expect(await readFile(join(cwd, ".editorconfig"), "utf8")).toBe("root = false\n");
  });

  it("--force overwrites the conflicting file", async () => {
    await runSync({ cwd, payload, config, managedFiles: FILES });
    await writeFile(join(cwd, ".editorconfig"), "root = false\n");

    const result = await runSync({ cwd, payload, config, managedFiles: FILES, force: true });
    expect(result.conflicted).toEqual([]);
    expect(result.written).toContain(".editorconfig");
    expect(await readFile(join(cwd, ".editorconfig"), "utf8")).toBe("root = true\n");
  });

  it("treats a markerless block file as a clean insert, not a conflict", async () => {
    await writeFile(join(cwd, ".npmrc"), "always-auth=true\n");
    const result = await runSync({ cwd, payload, config, managedFiles: [FILES[1] as ManagedFile] });
    expect(result.conflicted).toEqual([]);
    expect(result.written).toEqual([".npmrc"]);
    expect(await readFile(join(cwd, ".npmrc"), "utf8")).toBe(
      "always-auth=true\n# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://example\n# END streamctl MANAGED BLOCK registry\n",
    );
  });

  it("honors --only", async () => {
    const result = await runSync({ cwd, payload, config, managedFiles: FILES, only: "*.editorconfig" });
    expect(result.written).toEqual([".editorconfig"]);
    expect(await exists(".npmrc")).toBe(false);
  });
});

describe("runSync --only glob translation", () => {
  // Generic payload: `read` returns a constant for any source. Everything uses the
  // `full` strategy under `--dry-run`, so we assert the planned (would-write) set
  // without touching disk or needing nested target directories to exist.
  const globPayload: PayloadHandle = {
    version: "1.0.0",
    read: async () => "content\n",
    list: async () => [],
  };

  function filesFor(paths: string[]): ManagedFile[] {
    return paths.map(path => ({ path, strategy: "full", source: path }));
  }

  async function plannedWith(only: string, paths: string[]): Promise<string[]> {
    const result = await runSync({ cwd, payload: globPayload, config, managedFiles: filesFor(paths), only, dryRun: true });
    return result.written.sort();
  }

  it("`**/x` matches nested tails but not a root-level `x`", async () => {
    // `**` becomes `.*` and the literal `/x` stays, so the pattern needs a slash before `x`.
    expect(await plannedWith("**/x", ["x", "a/x", "deep/dir/x"])).toEqual(["a/x", "deep/dir/x"]);
  });

  it("`a?c` matches exactly one non-slash char", async () => {
    expect(await plannedWith("a?c", ["abc", "axc", "a/c"])).toEqual(["abc", "axc"]);
  });

  it("regex-special chars in the glob are matched literally", async () => {
    // `.` and `+` are escaped, so only the exact string matches, not `axbyc`.
    expect(await plannedWith("a.b+c", ["a.b+c", "axbyc", "aXbYc"])).toEqual(["a.b+c"]);
  });
});

describe("runSync write policy (pinned)", () => {
  const NPMRC = FILES[1] as ManagedFile;
  const EDITORCONFIG = FILES[0] as ManagedFile;
  const SYNCED_NPMRC = "# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://example\n# END streamctl MANAGED BLOCK registry\n";

  it("an in-region block edit is a safe write, not a conflict", async () => {
    await runSync({ cwd, payload, config, managedFiles: [NPMRC] });
    await writeFile(join(cwd, ".npmrc"), "# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://evil\n# END streamctl MANAGED BLOCK registry\n");

    const result = await runSync({ cwd, payload, config, managedFiles: [NPMRC] });
    expect(result.conflicted).toEqual([]);
    expect(result.written).toEqual([".npmrc"]);
    expect(await readFile(join(cwd, ".npmrc"), "utf8")).toBe(SYNCED_NPMRC);
  });

  it("a full-file edit conflicts and the file is left alone", async () => {
    await runSync({ cwd, payload, config, managedFiles: [EDITORCONFIG] });
    await writeFile(join(cwd, ".editorconfig"), "root = false\n");

    const error = await runSync({ cwd, payload, config, managedFiles: [EDITORCONFIG] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFLICTS_PENDING");
    expect(await readFile(join(cwd, ".editorconfig"), "utf8")).toBe("root = false\n");
  });
});

describe("runSync lockfileStale flag", () => {
  // A baseline that reconciles `engines.node`; the fixture package.json is skewed
  // so a real sync writes package.json (making any lockfile stale).
  const baseline = { "engines.node": ">=24.13.0" };
  const skewedPkg = `${JSON.stringify({ name: "app", engines: { node: ">=20.0.0" } }, null, 2)}\n`;

  it("flags true when a reconcile wrote package.json and a pnpm lockfile exists", async () => {
    await writeFile(join(cwd, "package.json"), skewedPkg);
    await writeFile(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9\n");

    const result = await runSync({ cwd, payload, config, managedFiles: [], baseline });
    expect(result.versionChanges.map(c => c.key)).toEqual(["engines.node"]);
    expect(result.lockfileStale).toBe(true);
  });

  it("flags true with an npm lockfile too", async () => {
    await writeFile(join(cwd, "package.json"), skewedPkg);
    await writeFile(join(cwd, "package-lock.json"), "{}\n");

    const result = await runSync({ cwd, payload, config, managedFiles: [], baseline });
    expect(result.lockfileStale).toBe(true);
  });

  it("does not flag when package.json already matches the baseline", async () => {
    await writeFile(join(cwd, "package.json"), `${JSON.stringify({ name: "app", engines: { node: ">=24.13.0" } }, null, 2)}\n`);
    await writeFile(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9\n");

    const result = await runSync({ cwd, payload, config, managedFiles: [], baseline });
    expect(result.versionChanges).toEqual([]);
    expect(result.lockfileStale).toBeFalsy();
  });

  it("does not flag a reconcile write when no lockfile exists", async () => {
    await writeFile(join(cwd, "package.json"), skewedPkg);

    const result = await runSync({ cwd, payload, config, managedFiles: [], baseline });
    expect(result.versionChanges.map(c => c.key)).toEqual(["engines.node"]);
    expect(result.lockfileStale).toBeFalsy();
  });

  it("reports skipped-ahead keys instead of downgrading them", async () => {
    // Repo is ahead of the baseline floor: nothing gets written, but it is still reported.
    await writeFile(join(cwd, "package.json"), `${JSON.stringify({ name: "app", engines: { node: ">=26.0.0" } }, null, 2)}\n`);
    await writeFile(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9\n");

    const result = await runSync({ cwd, payload, config, managedFiles: [], baseline });
    expect(result.versionChanges).toEqual([]);
    expect(result.versionsSkippedAhead).toEqual([{ key: "engines.node", actual: ">=26.0.0", baseline: ">=24.13.0" }]);
    expect(result.lockfileStale).toBeFalsy();
  });

  it("does not flag on --dry-run", async () => {
    await writeFile(join(cwd, "package.json"), skewedPkg);
    await writeFile(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9\n");

    const result = await runSync({ cwd, payload, config, managedFiles: [], baseline, dryRun: true });
    expect(result.lockfileStale).toBeFalsy();
  });
});

describe("runSync version reconcile", () => {
  const editorconfig: ManagedFile = { path: ".editorconfig", strategy: "full", source: "base/editorconfig" };
  const eslintFile: ManagedFile = { path: "eslint.config.ts", strategy: "scaffold", source: "base/eslint.config.ts" };

  it("throws CONFIG_INVALID in the plan pass and writes no managed file on a non-string pin", async () => {
    // A JSON-valid but broken pin (object, not a string version). The reconcile is
    // now planned in the plan pass, so it must fail BEFORE the managed create lands.
    await writeFile(join(cwd, "package.json"), `${JSON.stringify({ name: "app", devDependencies: { vue: {} } }, null, 2)}\n`);

    const error = await runSync({ cwd, payload, config, managedFiles: [editorconfig], baseline: { "devDependencies.vue": "^3.5" } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    // Transactional: the managed create must not have been written.
    expect(await exists(".editorconfig")).toBe(false);
  });

  // Same contract, different hole: a non-object *container* left `actual` undefined, so
  // the plan pass saw "dep absent", planned an add, and only jsonc-parser failed —
  // inside applyReconcile, which runs after the managed writes.
  it("throws in the plan pass and writes nothing when a dependency section is not an object", async () => {
    await writeFile(join(cwd, "package.json"), `${JSON.stringify({ name: "app", devDependencies: null }, null, 2)}\n`);

    const error = await runSync({ cwd, payload, config, managedFiles: [editorconfig], baseline: { "devDependencies.vue": "^3.5" } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect(await exists(".editorconfig")).toBe(false);
  });

  it("reconciles jiti when eslint.config.ts is active", async () => {
    await writeFile(join(cwd, "package.json"), `${JSON.stringify({ name: "app" }, null, 2)}\n`);
    const result = await runSync({ cwd, payload, config, managedFiles: [eslintFile], baseline: { "devDependencies.jiti": "^2.0" } });
    expect(result.versionChanges.map(c => c.key)).toContain("devDependencies.jiti");
  });

  it("does not reconcile jiti when eslint.config.ts is turned off", async () => {
    await writeFile(join(cwd, "package.json"), `${JSON.stringify({ name: "app" }, null, 2)}\n`);
    const result = await runSync({
      cwd,
      payload,
      config: { ...config, files: { "eslint.config.ts": "off" } },
      managedFiles: [eslintFile],
      baseline: { "devDependencies.jiti": "^2.0" },
    });
    expect(result.versionChanges.map(c => c.key)).not.toContain("devDependencies.jiti");
  });
});

describe("runSync --interactive", () => {
  const record = (answer: "accept" | "skip", calls: string[]): SyncDecider => async (change) => {
    calls.push(change.path);
    return answer;
  };

  it("writes an accepted conflict and never lands it in conflicted[]", async () => {
    await runSync({ cwd, payload, config, managedFiles: FILES });
    await writeFile(join(cwd, ".editorconfig"), "root = false\n");

    const calls: string[] = [];
    const result = await runSync({ cwd, payload, config, managedFiles: FILES, decider: record("accept", calls) });
    expect(calls).toEqual([".editorconfig"]);
    expect(result.written).toContain(".editorconfig");
    expect(result.conflicted).toEqual([]);
    expect(await readFile(join(cwd, ".editorconfig"), "utf8")).toBe("root = true\n");
  });

  it("leaves a skipped file unchanged and records it in skipped[]", async () => {
    await runSync({ cwd, payload, config, managedFiles: FILES });
    await writeFile(join(cwd, ".editorconfig"), "root = false\n");

    const calls: string[] = [];
    const result = await runSync({ cwd, payload, config, managedFiles: FILES, decider: record("skip", calls) });
    expect(result.skipped).toContain(".editorconfig");
    expect(result.written).not.toContain(".editorconfig");
    expect(result.conflicted).toEqual([]);
    expect(await readFile(join(cwd, ".editorconfig"), "utf8")).toBe("root = false\n");
  });

  it("never prompts for scaffold wrappers", async () => {
    const calls: string[] = [];
    await runSync({ cwd, payload, config, managedFiles: FILES, decider: record("accept", calls) });
    expect(calls.sort()).toEqual([".editorconfig", ".npmrc"]);
    expect(calls).not.toContain("eslint.config.ts");
    expect(await readFile(join(cwd, "eslint.config.ts"), "utf8")).toBe("export default createStreamctlEslint()\n");
  });

  it("--force accepts all without invoking the decider", async () => {
    await runSync({ cwd, payload, config, managedFiles: FILES });
    await writeFile(join(cwd, ".editorconfig"), "root = false\n");

    const calls: string[] = [];
    const result = await runSync({ cwd, payload, config, managedFiles: FILES, force: true, decider: record("skip", calls) });
    expect(calls).toEqual([]);
    expect(result.written).toContain(".editorconfig");
    expect(await readFile(join(cwd, ".editorconfig"), "utf8")).toBe("root = true\n");
  });

  it("--dry-run prompts nothing and writes nothing", async () => {
    const calls: string[] = [];
    const result = await runSync({ cwd, payload, config, managedFiles: FILES, dryRun: true, decider: record("accept", calls) });
    expect(calls).toEqual([]);
    expect(result.written.sort()).toEqual([".editorconfig", ".npmrc", "eslint.config.ts"]);
    expect(await exists(".editorconfig")).toBe(false);
  });
});

describe("runSync warnings (shadowedBy)", () => {
  const ESLINT: ManagedFile = { path: "eslint.config.ts", strategy: "scaffold", source: "base/eslint.config.ts", shadowedBy: ["eslint.config.mjs", "eslint.config.js"] };
  const EXPECTED = "eslint.config.ts is shadowed by eslint.config.mjs; the scaffolded config is inert until you port and delete eslint.config.mjs.";

  it("warns when a scaffold is written fresh next to a live shadow sibling", async () => {
    await writeFile(join(cwd, "eslint.config.mjs"), "export default []\n");
    const result = await runSync({ cwd, payload, config, managedFiles: [ESLINT] });
    expect(result.written).toContain("eslint.config.ts");
    expect(result.warnings).toEqual([EXPECTED]);
  });

  it("warns when the scaffold already exists and a shadow sibling is present", async () => {
    await writeFile(join(cwd, "eslint.config.ts"), "export default localOverride()\n");
    await writeFile(join(cwd, "eslint.config.mjs"), "export default []\n");
    const result = await runSync({ cwd, payload, config, managedFiles: [ESLINT] });
    expect(result.skipped).toContain("eslint.config.ts");
    expect(result.warnings).toEqual([EXPECTED]);
  });

  it("no warning without a shadow sibling", async () => {
    const result = await runSync({ cwd, payload, config, managedFiles: [ESLINT] });
    expect(result.written).toContain("eslint.config.ts");
    expect(result.warnings).toEqual([]);
  });

  it("warnings is always present, even with no shadowedBy declaration", async () => {
    const result = await runSync({ cwd, payload, config, managedFiles: FILES });
    expect(result.warnings).toEqual([]);
  });
});

describe("runSync --yes (non-interactive safe accept)", () => {
  const record = (answer: "accept" | "skip", calls: string[]): SyncDecider => async (change) => {
    calls.push(change.path);
    return answer;
  };

  it("auto-accepts creates + safe reconciles without consulting the decider", async () => {
    // Fresh repo, so every managed file is a create; the skip decider must be bypassed.
    const calls: string[] = [];
    const result = await runSync({ cwd, payload, config, managedFiles: FILES, yes: true, decider: record("skip", calls) });
    expect(calls).toEqual([]);
    expect(result.written.sort()).toEqual([".editorconfig", ".npmrc", "eslint.config.ts"]);
    expect(await readFile(join(cwd, ".editorconfig"), "utf8")).toBe("root = true\n");
  });

  it("still blocks a full-file conflict when no decider is supplied", async () => {
    await runSync({ cwd, payload, config, managedFiles: FILES });
    await writeFile(join(cwd, ".editorconfig"), "root = false\n");

    const error = await runSync({ cwd, payload, config, managedFiles: FILES, yes: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFLICTS_PENDING");
    // The transactional abort happens before any write, so the file survives intact.
    expect(await readFile(join(cwd, ".editorconfig"), "utf8")).toBe("root = false\n");
  });

  it("--force is a superset of --yes: conflicts included", async () => {
    await runSync({ cwd, payload, config, managedFiles: FILES });
    await writeFile(join(cwd, ".npmrc"), "# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://evil\n# END streamctl MANAGED BLOCK registry\n");
    await writeFile(join(cwd, ".editorconfig"), "root = false\n");

    const calls: string[] = [];
    const result = await runSync({ cwd, payload, config, managedFiles: FILES, force: true, yes: false, decider: record("skip", calls) });
    expect(calls).toEqual([]);
    expect(result.written.sort()).toEqual([".editorconfig", ".npmrc"]);
    expect(await readFile(join(cwd, ".editorconfig"), "utf8")).toBe("root = true\n");
  });

  it("auto-applies a safe reconcile, but a conflict still prompts", async () => {
    await runSync({ cwd, payload, config, managedFiles: FILES });
    // .npmrc gets an in-region edit (safe reconcile), .editorconfig a full-file edit (conflict).
    await writeFile(join(cwd, ".npmrc"), "# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://evil\n# END streamctl MANAGED BLOCK registry\n");
    await writeFile(join(cwd, ".editorconfig"), "root = false\n");

    const calls: string[] = [];
    const result = await runSync({ cwd, payload, config, managedFiles: FILES, yes: true, decider: record("skip", calls) });
    // The decider is consulted only for the conflict, never the safe reconcile.
    expect(calls).toEqual([".editorconfig"]);
    expect(result.written).toContain(".npmrc");
    expect(result.written).not.toContain(".editorconfig");
    expect(result.skipped).toContain(".editorconfig");
    expect(result.conflicted).toEqual([]);
    expect(await readFile(join(cwd, ".editorconfig"), "utf8")).toBe("root = false\n");
  });
});

describe("runSync batch decider", () => {
  const recordDecider = (answer: "accept" | "skip", calls: string[]): SyncDecider => async (change) => {
    calls.push(change.path);
    return answer;
  };
  const recordBatch = (answer: "accept" | "skip", batches: string[][]): SyncBatchDecider => async (changes) => {
    batches.push(changes.map((c: SyncChange) => c.path));
    return answer;
  };

  it("decides all safe changes with a single batch call and writes them on accept", async () => {
    await runSync({ cwd, payload, config, managedFiles: FILES });
    await writeFile(join(cwd, ".npmrc"), "# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://evil\n# END streamctl MANAGED BLOCK registry\n");

    const perFile: string[] = [];
    const batches: string[][] = [];
    const result = await runSync({
      cwd,
      payload,
      config,
      managedFiles: FILES,
      decider: recordDecider("skip", perFile),
      batchDecider: recordBatch("accept", batches),
    });
    expect(batches).toEqual([[".npmrc"]]);
    expect(perFile).toEqual([]); // no conflict, so the per-file decider is never called
    expect(result.written).toContain(".npmrc");
    expect(await readFile(join(cwd, ".npmrc"), "utf8")).toBe("# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://example\n# END streamctl MANAGED BLOCK registry\n");
  });

  it("declining the batch skips the whole safe set", async () => {
    await runSync({ cwd, payload, config, managedFiles: FILES });
    const edited = "# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://evil\n# END streamctl MANAGED BLOCK registry\n";
    await writeFile(join(cwd, ".npmrc"), edited);

    const batches: string[][] = [];
    const result = await runSync({
      cwd,
      payload,
      config,
      managedFiles: FILES,
      decider: recordDecider("accept", []),
      batchDecider: recordBatch("skip", batches),
    });
    expect(batches).toEqual([[".npmrc"]]);
    expect(result.skipped).toContain(".npmrc");
    expect(result.written).not.toContain(".npmrc");
    expect(await readFile(join(cwd, ".npmrc"), "utf8")).toBe(edited);
  });

  it("batches the safe reconcile but routes a full-file conflict to the per-file decider", async () => {
    await runSync({ cwd, payload, config, managedFiles: FILES });
    await writeFile(join(cwd, ".npmrc"), "# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://evil\n# END streamctl MANAGED BLOCK registry\n");
    await writeFile(join(cwd, ".editorconfig"), "root = false\n");

    const perFile: string[] = [];
    const batches: string[][] = [];
    const result = await runSync({
      cwd,
      payload,
      config,
      managedFiles: FILES,
      decider: recordDecider("accept", perFile),
      batchDecider: recordBatch("accept", batches),
    });
    expect(batches).toEqual([[".npmrc"]]);
    expect(perFile).toEqual([".editorconfig"]);
    expect(result.written.sort()).toEqual([".editorconfig", ".npmrc"]);
  });
});
