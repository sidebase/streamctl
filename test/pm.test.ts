import type { PmName, PmRunner } from "../src/engine/pm";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExistsProbe, createInstaller, createLatestProbe, detectPm, findLockfile, installCommand, lockfileExists, viewArgv } from "../src/engine/pm";

let dir: string;

/** Write a repo whose PM is pinned via the `packageManager` field (nypm's first signal). */
async function repoWithPm(pm: PmName): Promise<void> {
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", packageManager: `${pm}@1.0.0` }));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "streamctl-pm-"));
  // Bound the lockfile walk inside the fixture. Without this it climbs past the
  // tmpdir and can find a stray lockfile above it (e.g. /tmp/pnpm-lock.yaml),
  // making results host-dependent. It is the walk's own stop condition, so the
  // fixtures exercise it rather than route around it.
  await mkdir(join(dir, ".git"), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("detectPm", () => {
  it("falls back to npm when no supported PM is detected", async () => {
    // nypm walks parent dirs, so a bare tmpdir probe can pick up stray PM signals.
    // Our own root pins an unsupported PM (deno), which maps to the npm default.
    const root = await mkdtemp(join(tmpdir(), "streamctl-pm-root-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "boundary", packageManager: "deno@2.0.0" }));
    const bare = join(root, "nested", "deep");
    await mkdir(bare, { recursive: true });
    try {
      const pm = await detectPm(bare);
      expect(pm.name).toBe("npm");
      expect(pm.lockfile).toBe("package-lock.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects npm from a package-lock.json with no packageManager field", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }));
    await writeFile(join(dir, "package-lock.json"), "{}");
    expect((await detectPm(dir)).name).toBe("npm");
  });

  it("detects each supported PM from its packageManager field", async () => {
    for (const name of ["npm", "pnpm", "yarn", "bun"] as const) {
      await repoWithPm(name);
      expect((await detectPm(dir)).name).toBe(name);
    }
  });

  // nypm lists bun's legacy binary lockfile first (`["bun.lockb", "bun.lock"]`). Taking
  // the head made the upgrade snapshot watch a path current bun never writes, so a
  // failed install was left un-rolled-back while the CLI reported a clean restore.
  it("picks the lockfile that exists over nypm's legacy-first array head", async () => {
    await repoWithPm("bun");
    await writeFile(join(dir, "bun.lock"), "{}\n");
    expect((await detectPm(dir)).lockfile).toBe("bun.lock");
  });

  it("falls back to the canonical lockfile name when none is on disk", async () => {
    await repoWithPm("bun");
    expect((await detectPm(dir)).lockfile).toBe("bun.lock");
  });

  it("still honours a legacy lockfile that is genuinely present", async () => {
    await repoWithPm("bun");
    await writeFile(join(dir, "bun.lockb"), "\0\0");
    expect((await detectPm(dir)).lockfile).toBe("bun.lockb");
  });
});

describe("installCommand", () => {
  it("builds the plain install command", () => {
    expect(installCommand("pnpm")).toBe("pnpm install");
    expect(installCommand("npm")).toBe("npm install");
    expect(installCommand("yarn")).toBe("yarn install");
    expect(installCommand("bun")).toBe("bun install");
  });
});

describe("lockfileExists", () => {
  it("is true when the detected PM's lockfile is present", async () => {
    await repoWithPm("pnpm");
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    expect(await lockfileExists(dir)).toBe(true);
  });

  it("is false when no lockfile is present", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }));
    expect(await lockfileExists(dir)).toBe(false);
  });

  it("falls back to npm for an unsupported PM (e.g. deno)", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", packageManager: "deno@2.0.0" }));
    expect((await detectPm(dir)).name).toBe("npm");
  });

  it("finds a lockfile in an ancestor monorepo root", async () => {
    // The workspace shape streamctl actually runs in: lockfile at the root, cwd in
    // packages/app.
    await repoWithPm("pnpm");
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const app = join(dir, "packages", "app");
    await mkdir(app, { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@acme/app" }));

    expect(await lockfileExists(app)).toBe(true);
  });

  it("stops walking up at the git root", async () => {
    await writeFile(join(dir, "npm-shrinkwrap.json"), "{}");
    // An `outer` lockfile ABOVE the inner repo's root must not count for it.
    await writeFile(join(dir, "package-lock.json"), "{}");
    const inner = join(dir, "inner");
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, "package.json"), JSON.stringify({ name: "inner" }));
    await mkdir(join(inner, ".git"), { recursive: true });

    expect(await lockfileExists(inner)).toBe(false);
  });
});

describe("findLockfile", () => {
  it("returns the absolute path of a lockfile at the workspace root", async () => {
    // `upgrade` snapshots this path and its rollback writes to it, so the absolute
    // location matters, not just whether some lockfile exists.
    const lock = join(dir, "pnpm-lock.yaml");
    await writeFile(lock, "lockfileVersion: 9\n");
    const app = join(dir, "packages", "app");
    await mkdir(app, { recursive: true });

    expect(findLockfile(app, "pnpm-lock.yaml")).toBe(lock);
  });

  it("prefers the nearest lockfile when one sits beside cwd", async () => {
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const app = join(dir, "packages", "app");
    await mkdir(app, { recursive: true });
    const nearest = join(app, "pnpm-lock.yaml");
    await writeFile(nearest, "lockfileVersion: 9\n");

    expect(findLockfile(app, "pnpm-lock.yaml")).toBe(nearest);
  });

  it("never returns a lockfile outside the repo", async () => {
    // The dangerous case: a stray lockfile above the repo root. Returning it would
    // let an upgrade rollback write to a file the repo does not own.
    await writeFile(join(dir, "package-lock.json"), "{}");
    const inner = join(dir, "inner");
    await mkdir(join(inner, ".git"), { recursive: true });

    expect(findLockfile(inner, "package-lock.json")).toBeNull();
  });

  it("searches only cwd when there is no git root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "streamctl-pm-nogit-"));
    try {
      await writeFile(join(outside, "package-lock.json"), "{}");
      const nested = join(outside, "nested");
      await mkdir(nested, { recursive: true });

      expect(findLockfile(nested, "package-lock.json")).toBeNull();
      expect(findLockfile(outside, "package-lock.json")).toBe(join(outside, "package-lock.json"));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("viewArgv", () => {
  it("maps every PM to its view-equivalent argv", () => {
    expect(viewArgv("npm", "@x/y")).toEqual({ command: "npm", args: ["view", "@x/y", "version"] });
    expect(viewArgv("pnpm", "@x/y")).toEqual({ command: "pnpm", args: ["view", "@x/y", "version"] });
    expect(viewArgv("yarn", "@x/y")).toEqual({ command: "yarn", args: ["npm", "info", "@x/y", "--fields", "version", "--json"] });
    expect(viewArgv("bun", "@x/y")).toEqual({ command: "bun", args: ["pm", "view", "@x/y", "version"] });
  });
});

describe("createLatestProbe / createExistsProbe (injected runner)", () => {
  it("spawns the detected PM's view and returns the bare version", async () => {
    await repoWithPm("pnpm");
    const calls: { command: string; args: string[] }[] = [];
    const run: PmRunner = async (command, args) => {
      calls.push({ command, args });
      return "1.2.3\n";
    };
    expect(await createLatestProbe(run)(dir, "@x/y")).toBe("1.2.3");
    expect(calls).toEqual([{ command: "pnpm", args: ["view", "@x/y", "version"] }]);
  });

  it("parses yarn's JSON view output", async () => {
    await repoWithPm("yarn");
    const run: PmRunner = async () => JSON.stringify({ version: "2.0.0" });
    expect(await createLatestProbe(run)(dir, "@x/y")).toBe("2.0.0");
  });

  it("falls back to `npm view` when the detected PM errors", async () => {
    await repoWithPm("bun");
    const calls: string[] = [];
    const run: PmRunner = async (command) => {
      calls.push(command);
      if (command === "bun") {
        throw new Error("bun binary missing");
      }
      return "3.0.0\n";
    };
    expect(await createLatestProbe(run)(dir, "pkg")).toBe("3.0.0");
    expect(calls).toEqual(["bun", "npm"]);
  });

  it("resolves null when the package is unpublished", async () => {
    await repoWithPm("npm");
    const run: PmRunner = async () => "\n";
    expect(await createLatestProbe(run)(dir, "pkg")).toBeNull();
  });

  it("existence probe queries `<pkg>@<version>`", async () => {
    await repoWithPm("npm");
    const seen: string[] = [];
    const run: PmRunner = async (_command, args) => {
      seen.push(args[1] ?? "");
      return args[1] === "pkg@1.0.0" ? "1.0.0\n" : "\n";
    };
    const exists = createExistsProbe(run);
    expect(await exists(dir, "pkg", "1.0.0")).toBe(true);
    expect(await exists(dir, "pkg", "9.9.9")).toBe(false);
    expect(seen).toEqual(["pkg@1.0.0", "pkg@9.9.9"]);
  });
});

describe("createInstaller (confirm / skip)", () => {
  it("is a no-op when skip is set", async () => {
    await repoWithPm("pnpm");
    const install = vi.fn(async () => {});
    expect(await createInstaller({ skip: true, install })(dir)).toEqual({ installed: false });
    expect(install).not.toHaveBeenCalled();
  });

  it("installs via the detected PM when no confirm is supplied", async () => {
    await repoWithPm("pnpm");
    const install = vi.fn(async () => {});
    expect(await createInstaller({ install })(dir)).toEqual({ installed: true });
    expect(install).toHaveBeenCalledWith(dir, "pnpm");
  });

  it("installs when the confirm resolves true", async () => {
    await repoWithPm("yarn");
    const install = vi.fn(async () => {});
    let asked = "";
    let defaultYes = false;
    const confirm = async (question: string, dy: boolean): Promise<boolean> => {
      asked = question;
      defaultYes = dy;
      return true;
    };
    await createInstaller({ confirm, install })(dir);
    expect(install).toHaveBeenCalledWith(dir, "yarn");
    expect(asked).toContain("Run yarn install now?");
    expect(defaultYes).toBe(true);
  });

  it("does not install when the confirm resolves false", async () => {
    await repoWithPm("pnpm");
    const install = vi.fn(async () => {});
    expect(await createInstaller({ confirm: async () => false, install })(dir)).toEqual({ installed: false });
    expect(install).not.toHaveBeenCalled();
  });
});
