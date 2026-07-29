import type { ManagedFile, StreamctlConfig } from "../src/config/types";
import type { SyncResult } from "../src/engine/sync";
import type { PayloadHandle } from "../src/payload/resolve";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dirtyTrackedPaths } from "../src/engine/git";
import { runSync } from "../src/engine/sync";
import { StreamctlError } from "../src/errors";
import { exitCodeFor } from "../src/exit-codes";

const execFileAsync = promisify(execFile);

const config: StreamctlConfig = { package: "@acme/payload", base: "base", version: "1.0.0", profile: "nuxt-4" };

const payload: PayloadHandle = {
  version: "1.0.0",
  async read() {
    return "registry=https://example\n";
  },
  async list() {
    return [];
  },
};

// `block` on purpose. A diverging `full` file is already classified as an edit
// conflict and refused, but block and merge divergences count as "safe" reconciles
// and get written headlessly. For those the dirty-tree guard is the only thing
// standing between an uncommitted in-block edit and an overwrite.
const FILES: ManagedFile[] = [{ path: ".npmrc", strategy: "block", source: "base/npmrc", blockMark: "registry" }];

/** Repo root, i.e. the workspace root. The consumer lives in `packages/app` below it. */
let root: string;
/** The consumer package dir: the cwd streamctl runs from, a subdir of the git root. */
let app: string;

async function git(...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: root });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "streamctl-subdir-"));
  app = join(root, "packages", "app");
  await mkdir(app, { recursive: true });
  await git("init", "-q", ".");
  // Identity must be repo-local: a bare tmpdir has no committer otherwise.
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "test");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("dirty-tree guard from a repo subdirectory (monorepo workspace)", () => {
  it("refuses to clobber an uncommitted edit inside an owned block", async () => {
    // Sync once so the owned file exists, then commit it. The guard only protects
    // tracked files, and this is what an already-onboarded workspace looks like.
    await runSync({ cwd: app, payload, config, managedFiles: FILES });
    await git("add", "-A");
    await git("commit", "-qm", "adopt streamctl");

    // User hand-edits inside the managed block and does not commit. Sync would
    // recompose the block from the payload and overwrite this line.
    const owned = join(app, ".npmrc");
    const userEdit = "# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://internal.corp\n# END streamctl MANAGED BLOCK registry\n";
    await writeFile(owned, userEdit);

    const error = await runSync({ cwd: app, payload, config, managedFiles: FILES }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(StreamctlError);
    const failure = error as StreamctlError;
    expect(failure.code).toBe("CONFLICTS_PENDING");
    expect(exitCodeFor(failure.code)).toBe(2);
    expect((failure.details as SyncResult).conflicted).toEqual([
      { path: ".npmrc", reason: "uncommitted changes (dirty working tree)", kind: "dirty" },
    ]);
    // The whole point: the uncommitted work survives.
    expect(await readFile(owned, "utf8")).toBe(userEdit);
  });

  it("reports dirty paths cwd-relative, ignoring same-named files elsewhere", async () => {
    await writeFile(join(app, ".editorconfig"), "root = true\n");
    // A same-named file at the repo root and in a sibling package: neither is under
    // the consumer's cwd, so neither may leak into its dirty set.
    await writeFile(join(root, ".editorconfig"), "root = true\n");
    const sibling = join(root, "packages", "app-other");
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, ".editorconfig"), "root = true\n");
    await git("add", "-A");
    await git("commit", "-qm", "init");

    await writeFile(join(app, ".editorconfig"), "edited\n");
    await writeFile(join(root, ".editorconfig"), "edited\n");
    await writeFile(join(sibling, ".editorconfig"), "edited\n");

    expect([...(await dirtyTrackedPaths(app, [".editorconfig"]))]).toEqual([".editorconfig"]);
    // From the root the same call sees only the root's own file, not the packages'.
    expect([...(await dirtyTrackedPaths(root, [".editorconfig"]))]).toEqual([".editorconfig"]);
  });

  it("rebases a rename's new path and drops the old one", async () => {
    await writeFile(join(app, "old-name.ts"), "export const a = 1;\n");
    await git("add", "-A");
    await git("commit", "-qm", "init");
    await execFileAsync("git", ["mv", "old-name.ts", "new-name.ts"], { cwd: app });

    const dirty = await dirtyTrackedPaths(app, ["old-name.ts", "new-name.ts"]);
    expect(dirty.has("new-name.ts")).toBe(true);
    expect(dirty.has("packages/app/new-name.ts")).toBe(false);
    expect(dirty.has("old-name.ts")).toBe(false);
  });

  it("disengages quietly outside a git repo", async () => {
    const loose = await mkdtemp(join(tmpdir(), "streamctl-nogit-"));
    try {
      await writeFile(join(loose, ".editorconfig"), "root = true\n");
      expect((await dirtyTrackedPaths(loose, [".editorconfig"])).size).toBe(0);
    } finally {
      await rm(loose, { recursive: true, force: true });
    }
  });
});
