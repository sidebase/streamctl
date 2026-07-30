import type { SyncDecider } from "../src/engine/sync";
import type { RestoreStatus, RunUpgradeOptions } from "../src/engine/upgrade";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_FILE } from "../src/config/resolve";
import { extractEmbeddedVersion } from "../src/engine/init";
import { runUpgrade } from "../src/engine/upgrade";
import { StreamctlError } from "../src/errors";

const execFileAsync = promisify(execFile);

const FROM = "1.0.0";
const TO = "2.0.0";

const TEMPLATES: Record<string, string> = {
  "manifest.json": JSON.stringify({ schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" }),
  "base/preset.json": JSON.stringify({
    name: "base",
    files: [
      { path: ".editorconfig", strategy: "full", source: "base/editorconfig" },
      { path: "eslint.config.ts", strategy: "scaffold", source: "base/eslint.config.ts" },
    ],
    // Dotted keys make `ci` a namespace the validator recurses into, which is what
    // makes an undeclared `ci.*` knob catchable. A plain `ci: "object"` leaf would
    // be shape-only and let a typo through.
    // `ci.version` is the decoy the pin-selection tests below lean on; declaring it
    // keeps those configs valid under stage-2 instead of relying on validation
    // being skipped.
    configKeys: { "ci.unitTests": "boolean", "ci.version": "string" },
  }),
  "base/editorconfig": "root = true\n",
  "base/eslint.config.ts": "export default createStreamctlEslint()\n",
};

let repo: string;
let configPkg: string;

/** Writes a fake installed `@acme/payload` at the given version. */
async function makeConfigPackage(version: string): Promise<void> {
  await mkdir(join(configPkg, "presets", "base"), { recursive: true });
  await writeFile(join(configPkg, "package.json"), JSON.stringify({ name: "@acme/payload", version }));
  for (const [source, content] of Object.entries(TEMPLATES)) {
    await writeFile(join(configPkg, "presets", source), content);
  }
}

/**
 * The default fixture is at the ROOT, and that is load-bearing — do not relocate it.
 *
 * The `runUpgrade: legacy config location` block below cannot detect a `bumpConfigVersion`
 * hardcoded back to the legacy path: it passes 4/4 under a full revert, including the
 * byte-for-byte rollback case, because from inside a legacy repo the hash oracle cannot
 * tell "rollback restored it" from "nothing ever wrote it". Detection comes entirely from
 * the root-repo tests in this file. Move this to legacy and they stop being able to see
 * it, while everything here stays green.
 */
const writeConfig = (content: string): Promise<void> => writeFile(join(repo, `${CONFIG_FILE}.ts`), content);

/** A clean initialized repo pinned to FROM (config.ts + devDeps at FROM). */
async function makeRepo(): Promise<void> {
  // `packageManager` pins PM detection to npm. nypm walks parent dirs, so without
  // it a stray lockfile above the tmpdir (e.g. /tmp/pnpm-lock.yaml) decides the
  // repo's PM and the transactional snapshot then targets the wrong lockfile. A
  // `.git` marker does not bound nypm, only this field does. These tests already
  // assume npm (`hashSnapshot` defaults to package-lock.json), so pin it rather
  // than leave it up to the host.
  await writeFile(
    join(repo, "package.json"),
    `${JSON.stringify({ name: "app", packageManager: "npm@10.0.0", devDependencies: { "@acme/payload": FROM, "@sidebase/streamctl": FROM } }, null, 2)}\n`,
  );
  await writeConfig(`export default {\n  package: "@acme/payload",\n  base: "base",\n  version: "${FROM}",\n  profile: "nuxt-4",\n};\n`);
}

function baseOpts(overrides: Partial<RunUpgradeOptions> = {}): RunUpgradeOptions {
  return {
    cwd: repo,
    dryRun: false,
    install: async () => {},
    // No-op reinstall by default so rollback never shells out under test.
    reinstall: async () => {},
    latestProbe: async () => TO,
    versionExists: async (_cwd, _pkg, v) => v === TO,
    resolvePackageDir: () => configPkg,
    ...overrides,
  };
}

async function readPkg(): Promise<{ devDependencies: Record<string, string> }> {
  return JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
}
const readConfig = (): Promise<string> => readFile(join(repo, "streamctl.config.ts"), "utf8");

/** sha256 of a repo-relative file, `null` when absent. The byte-identity oracle for rollback tests. */
async function hashFile(rel: string): Promise<string | null> {
  const raw = await readFile(join(repo, rel)).catch(() => null);
  return raw === null ? null : createHash("sha256").update(raw).digest("hex");
}

/** Snapshot the three transactional files (config.ts, package.json, lockfile) as hashes. */
async function hashSnapshot(lockfile = "package-lock.json"): Promise<Record<string, string | null>> {
  return {
    config: await hashFile("streamctl.config.ts"),
    pkg: await hashFile("package.json"),
    lock: await hashFile(lockfile),
  };
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "streamctl-upgrade-repo-"));
  configPkg = await mkdtemp(join(tmpdir(), "streamctl-upgrade-pkg-"));
  await makeConfigPackage(TO);
  await makeRepo();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(repo, { recursive: true, force: true });
  await rm(configPkg, { recursive: true, force: true });
});

describe("runUpgrade", () => {
  it("bumps the pin and the payload devDep, installs, then re-syncs", async () => {
    const install = vi.fn(async () => {});
    const result = await runUpgrade(baseOpts({ install }));

    expect(result.fromVersion).toBe(FROM);
    expect(result.toVersion).toBe(TO);
    expect(install).toHaveBeenCalledTimes(1);

    // Only the payload package moves; the CLI's own devDep stays put.
    expect(result.dependencyBumps).toEqual([{ name: "@acme/payload", from: FROM, to: TO }]);

    expect(await readConfig()).toContain(`version: "${TO}"`);
    const pkg = await readPkg();
    expect(pkg.devDependencies["@acme/payload"]).toBe(TO);
    expect(pkg.devDependencies["@sidebase/streamctl"]).toBe(FROM);

    expect(result.sync?.written).toContain(".editorconfig");
    expect(await readFile(join(repo, ".editorconfig"), "utf8")).toBe("root = true\n");
  });

  it("NO_NEWER_VERSION when already on the latest release", async () => {
    const error = await runUpgrade(baseOpts({ latestProbe: async () => FROM })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("NO_NEWER_VERSION");
  });

  it("fails with TARGET_NOT_FOUND when --to is unpublished", async () => {
    const error = await runUpgrade(baseOpts({ to: "9.9.9" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("TARGET_NOT_FOUND");
  });

  it("--dry-run reports the target and the bumps but writes nothing", async () => {
    const install = vi.fn(async () => {});
    const result = await runUpgrade(baseOpts({ dryRun: true, install }));

    expect(result.toVersion).toBe(TO);
    expect(result.dependencyBumps).toEqual(
      expect.arrayContaining([{ name: "@acme/payload", from: FROM, to: TO }]),
    );
    expect(result.sync?.written).toContain(".editorconfig");

    expect(install).not.toHaveBeenCalled();
    expect(await readConfig()).toContain(`version: "${FROM}"`);
    expect((await readPkg()).devDependencies["@acme/payload"]).toBe(FROM);
    expect(await readFile(join(repo, ".editorconfig")).catch(() => null)).toBeNull();
  });

  it("rolls back to the exact pre-upgrade tree on a non-interactive conflict", async () => {
    await writeFile(join(repo, ".editorconfig"), "root = false\n");
    const before = await hashSnapshot();

    const error = await runUpgrade(baseOpts()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFLICTS_PENDING");

    const details = (error as StreamctlError).details as { rolledBack?: boolean; plan?: unknown[] };
    expect(details.rolledBack).toBe(true);
    expect(Array.isArray(details.plan)).toBe(true);
    expect(await hashSnapshot()).toEqual(before);
    expect(await readConfig()).toContain(`version: "${FROM}"`);
    expect((await readPkg()).devDependencies["@acme/payload"]).toBe(FROM);
  });

  it("--force overwrites an owned-content conflict instead of rolling back", async () => {
    // Same setup as the rollback case above; --force has to reach the chained
    // runSync for the conflict to be accepted.
    await writeFile(join(repo, ".editorconfig"), "root = false\n");

    const result = await runUpgrade(baseOpts({ force: true }));
    expect(result.rolledBack).toBe(false);
    expect(result.toVersion).toBe(TO);
    expect(result.sync?.written).toContain(".editorconfig");
    expect(await readFile(join(repo, ".editorconfig"), "utf8")).toBe("root = true\n");
    expect(await readConfig()).toContain(`version: "${TO}"`);
  });

  it("--yes auto-applies safe reconciles but still routes conflicts to the decider", async () => {
    // The payload gets a block-managed .npmrc so the chained sync has both a safe
    // reconcile and a full-file conflict to partition.
    await writeFile(
      join(configPkg, "presets", "base", "preset.json"),
      JSON.stringify({
        name: "base",
        files: [
          { path: ".editorconfig", strategy: "full", source: "base/editorconfig" },
          { path: ".npmrc", strategy: "block", source: "base/npmrc", blockMark: "registry" },
          { path: "eslint.config.ts", strategy: "scaffold", source: "base/eslint.config.ts" },
        ],
      }),
    );
    await writeFile(join(configPkg, "presets", "base", "npmrc"), "registry=https://example\n");

    await writeFile(join(repo, ".editorconfig"), "root = false\n"); // full-file conflict
    // Synced-then-edited managed block, so a safe reconcile rather than a create.
    await writeFile(join(repo, ".npmrc"), "# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://evil\n# END streamctl MANAGED BLOCK registry\n");

    const calls: string[] = [];
    const decider: SyncDecider = async (change) => {
      calls.push(change.path);
      return "accept";
    };
    const result = await runUpgrade(baseOpts({ yes: true, decider }));

    expect(calls).toEqual([".editorconfig"]);
    expect(result.rolledBack).toBe(false);
    expect(result.sync?.written).toContain(".npmrc");
    expect(await readFile(join(repo, ".npmrc"), "utf8")).toBe("# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://example\n# END streamctl MANAGED BLOCK registry\n");
  });

  it("NOT_INITIALIZED on a config-less repo", async () => {
    await rm(join(repo, "streamctl.config.ts"), { force: true });
    const error = await runUpgrade(baseOpts()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("NOT_INITIALIZED");
  });

  it("the result shape is stable and JSON-serializable", async () => {
    const result = await runUpgrade(baseOpts());
    expect(Object.keys(result).sort()).toEqual(["dependencyBumps", "dryRun", "fromVersion", "plan", "rolledBack", "sync", "toVersion"]);
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({ fromVersion: FROM, toVersion: TO, rolledBack: false, dryRun: false });
  });

  // `sync` cannot discriminate in either direction. It is null for a dry run with
  // the target absent AND for --no-install (which does write the pin and devDep);
  // it is non-null for a real upgrade AND for a dry run whose target happens to be
  // installed. Only `dryRun` says whether anything was written.
  it("dryRun, not sync, is what tells a preview apart from a real write", async () => {
    // Target IS installed in this fixture, so the dry run produces a real preview.
    const dry = await runUpgrade(baseOpts({ dryRun: true }));
    expect(dry.dryRun).toBe(true);
    expect(dry.sync).not.toBeNull(); // non-null, yet nothing was written
    expect(await readConfig()).toContain(`version: "${FROM}"`); // pin untouched

    const noInstall = await runUpgrade(baseOpts({ noInstall: true }));
    expect(noInstall).toMatchObject({ dryRun: false, sync: null }); // null, yet it DID write
    expect(await readConfig()).toContain(`version: "${TO}"`); // pin moved

    await makeRepo(); // reset the pin for the full path
    const full = await runUpgrade(baseOpts());
    expect(full.dryRun).toBe(false);
    expect(full.sync).not.toBeNull();
  });

  it("populates the preflight plan on success", async () => {
    const result = await runUpgrade(baseOpts());
    expect(result.rolledBack).toBe(false);
    expect(result.plan).toContainEqual({ path: ".editorconfig", kind: "create" });
  });

  it("rolls back byte-for-byte when the install fails", async () => {
    const before = await hashSnapshot();
    const install = vi.fn(async () => {
      throw new Error("install boom");
    });

    const error = await runUpgrade(baseOpts({ install })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    // A raw installer failure is labeled INSTALL_FAILED, not the generic WRITE_FAILED.
    expect((error as StreamctlError).code).toBe("INSTALL_FAILED");
    expect((error as StreamctlError).details).toMatchObject({ rolledBack: true });

    expect(await hashSnapshot()).toEqual(before);
    expect(await readConfig()).toContain(`version: "${FROM}"`);
    expect((await readPkg()).devDependencies["@acme/payload"]).toBe(FROM);
  });

  it("restores the workspace-root lockfile when run from a sub-package", async () => {
    // A monorepo: the lockfile lives at the workspace root, but streamctl runs from
    // the package dir. Snapshotting `join(cwd, lockfile)` would record a path that
    // never existed, so the failed install's damage to the REAL lockfile would
    // survive a rollback that reported success.
    const pkgDir = join(repo, "packages", "app");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(repo, ".git"), "gitdir: ../elsewhere\n");
    const rootLock = join(repo, "pnpm-lock.yaml");
    await writeFile(rootLock, "lockfileVersion: 9\n# pinned to 1.0.0\n");
    await writeFile(
      join(pkgDir, "package.json"),
      `${JSON.stringify({ name: "app", packageManager: "pnpm@10.28.1", devDependencies: { "@acme/payload": FROM, "@sidebase/streamctl": FROM } }, null, 2)}\n`,
    );
    await writeFile(join(pkgDir, "streamctl.config.ts"), `export default {\n  package: "@acme/payload",\n  base: "base",\n  version: "${FROM}",\n  profile: "nuxt-4",\n};\n`);

    const before = await readFile(rootLock, "utf8");
    const install = vi.fn(async () => {
      // What a real install does: rewrite the ROOT lockfile, then fail.
      await writeFile(rootLock, "lockfileVersion: 9\n# pinned to 2.0.0\n");
      throw new Error("install boom");
    });

    const error = await runUpgrade(baseOpts({ cwd: pkgDir, install })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).details).toMatchObject({ rolledBack: true });
    expect(await readFile(rootLock, "utf8")).toBe(before);
  });

  it("names an out-of-cwd lockfile by its path relative to cwd, so the recovery command works", async () => {
    // `FileSnapshot.path` doubles as the ROLLBACK_FAILED label AND feeds its
    // `git checkout HEAD -- <path>` command. Git pathspecs resolve against cwd, so
    // a `../`-style label stays copy-pasteable from the package dir.
    const pkgDir = join(repo, "packages", "app");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(repo, ".git"), "gitdir: ../elsewhere\n");
    await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    await writeFile(
      join(pkgDir, "package.json"),
      `${JSON.stringify({ name: "app", packageManager: "pnpm@10.28.1", devDependencies: { "@acme/payload": FROM, "@sidebase/streamctl": FROM } }, null, 2)}\n`,
    );
    await writeFile(join(pkgDir, "streamctl.config.ts"), `export default {\n  package: "@acme/payload",\n  base: "base",\n  version: "${FROM}",\n  profile: "nuxt-4",\n};\n`);

    const install = vi.fn(async () => {
      // Dirty the lockfile, or the restore is a no-op and never reports a failure.
      await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n# rewritten\n");
      throw new Error("install boom");
    });
    // Every restore that is attempted fails, so the error carries their labels.
    const restoreWrite = async (): Promise<void> => {
      throw new Error("disk full");
    };

    const error = await runUpgrade(baseOpts({ cwd: pkgDir, install, restoreWrite })).catch((e: unknown) => e);

    expect((error as StreamctlError).code).toBe("ROLLBACK_FAILED");
    const details = (error as StreamctlError).details as { failed: string[]; recover: string };
    expect(details.failed).toContain("../../pnpm-lock.yaml");
    expect(details.recover).toContain("../../pnpm-lock.yaml");
  });

  it("deletes a root lockfile the failed install created in a never-installed workspace", async () => {
    // No lockfile anywhere, so there is nothing to resolve and the snapshot falls back
    // to cwd. The install then writes the ROOT lockfile, which the snapshot could not
    // have predicted, so it has to be swept rather than restored.
    const pkgDir = join(repo, "packages", "app");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(repo, ".git"), "gitdir: ../elsewhere\n");
    await writeFile(
      join(pkgDir, "package.json"),
      `${JSON.stringify({ name: "app", packageManager: "pnpm@10.28.1", devDependencies: { "@acme/payload": FROM, "@sidebase/streamctl": FROM } }, null, 2)}\n`,
    );
    await writeFile(join(pkgDir, "streamctl.config.ts"), `export default {\n  package: "@acme/payload",\n  base: "base",\n  version: "${FROM}",\n  profile: "nuxt-4",\n};\n`);
    const rootLock = join(repo, "pnpm-lock.yaml");

    const install = vi.fn(async () => {
      await writeFile(rootLock, "lockfileVersion: 9\n");
      throw new Error("install boom");
    });

    const error = await runUpgrade(baseOpts({ cwd: pkgDir, install })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StreamctlError);
    expect(existsSync(rootLock)).toBe(false);
    expect(existsSync(join(pkgDir, "pnpm-lock.yaml"))).toBe(false);
  });

  it("deletes a lockfile the failed install created", async () => {
    // Pin the PM so the snapshot targets the same lockfile the fake install writes.
    await writeFile(
      join(repo, "package.json"),
      `${JSON.stringify({ name: "app", packageManager: "pnpm@10.28.1", devDependencies: { "@acme/payload": FROM, "@sidebase/streamctl": FROM } }, null, 2)}\n`,
    );
    expect(existsSync(join(repo, "pnpm-lock.yaml"))).toBe(false);

    const install = vi.fn(async () => {
      await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
      throw new Error("install failed after writing the lockfile");
    });

    const error = await runUpgrade(baseOpts({ install })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);

    // Absent before, created by the failed install, so rollback deletes it.
    expect(existsSync(join(repo, "pnpm-lock.yaml"))).toBe(false);
    expect(await readConfig()).toContain(`version: "${FROM}"`);
  });

  // A file the failed install *created* is not in HEAD, so `git checkout HEAD -- <it>`
  // would just report a pathspec error. Deleting it is what actually restores the
  // pre-upgrade state.
  it("tells the user to delete, not git-checkout, a lockfile the install created", async () => {
    await writeFile(
      join(repo, "package.json"),
      `${JSON.stringify({ name: "app", packageManager: "pnpm@10.28.1", devDependencies: { "@acme/payload": FROM, "@sidebase/streamctl": FROM } }, null, 2)}\n`,
    );
    const install = vi.fn(async () => {
      await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
      throw new Error("install boom");
    });
    // The sweep of the created lockfile fails (read-only mount, EPERM on Windows, ...).
    const restoreRemove = vi.fn(async () => {
      throw new Error("EPERM");
    });

    const error = await runUpgrade(baseOpts({ install, restoreRemove })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("ROLLBACK_FAILED");

    const details = (error as StreamctlError).details as { failed: string[]; recover: string };
    expect(details.failed).toEqual(["pnpm-lock.yaml"]);
    expect(details.recover).toBe("rm -f pnpm-lock.yaml");
    expect(details.recover).not.toContain("git checkout");
  });

  it("rolls back when the newly-installed payload turns out to be invalid", async () => {
    const before = await hashSnapshot();
    // Post-bump, the target payload advertises an unknown manifest schema.
    await writeFile(
      join(configPkg, "presets", "manifest.json"),
      JSON.stringify({ schemaVersion: 99, presets: ["base"], profiles: [], defaultBase: "base" }),
    );

    const error = await runUpgrade(baseOpts()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("SCHEMA_UNSUPPORTED");
    expect((error as StreamctlError).details).toMatchObject({ rolledBack: true });
    expect(await hashSnapshot()).toEqual(before);
  });

  it("--no-install keeps the bump and reports sync: null", async () => {
    const install = vi.fn(async () => ({ installed: false }));
    const result = await runUpgrade(baseOpts({ noInstall: true, install }));

    expect(result.sync).toBeNull();
    expect(result.rolledBack).toBe(false);
    expect(result.plan).toEqual([]);
    expect(await readConfig()).toContain(`version: "${TO}"`);
    expect((await readPkg()).devDependencies["@acme/payload"]).toBe(TO);
    // No preflight sync, so no managed file is written.
    expect(existsSync(join(repo, ".editorconfig"))).toBe(false);
  });

  it("ROLLBACK_FAILED carries per-file status and a recovery command", async () => {
    const install = vi.fn(async () => {
      throw new Error("install boom");
    });
    const restoreWrite = vi.fn(async () => {
      throw new Error("disk full");
    });

    const error = await runUpgrade(baseOpts({ install, restoreWrite })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("ROLLBACK_FAILED");

    const details = (error as StreamctlError).details as { failed: string[]; recover: string; perFile: string[] };
    expect(details.failed).toEqual(expect.arrayContaining(["streamctl.config.ts", "package.json"]));
    expect(details.recover).toContain("git checkout HEAD --");
    expect(details.perFile.some(line => line.includes("FAILED"))).toBe(true);
  });

  it("ignores a commented-out pin and a prefix-key decoy", async () => {
    await writeConfig(
      `// version: "0.0.0" (commented decoy, must not be bumped)\nexport default {\n  package: "@acme/payload",\n  base: "base",\n  versionSync: true,\n  version: "${FROM}",\n  profile: "nuxt-4",\n};\n`,
    );
    await runUpgrade(baseOpts());

    const config = await readConfig();
    expect(config).toContain(`version: "${TO}"`);
    expect(config).toContain(`// version: "0.0.0"`);
    expect(config).toContain("versionSync: true");
  });

  // A `/* */` block is not line-anchored away the way `//` is: a `version:` at column 0
  // inside one beat the real (indented) pin on depth, was a lone match at that depth so
  // no ambiguity error fired, and got bumped while the real pin went stale.
  it("ignores a pin inside a block comment, even at column 0", async () => {
    await writeConfig(
      `/*\nExample:\nversion: "0.0.0"\n*/\nexport default {\n  package: "@acme/payload",\n  base: "base",\n  version: "${FROM}",\n  profile: "nuxt-4",\n};\n`,
    );
    await runUpgrade(baseOpts());

    const config = await readConfig();
    expect(config).toContain(`  version: "${TO}"`);
    expect(config).toContain(`version: "0.0.0"`); // the commented decoy is untouched
  });

  // The `/*` here opens inside a string literal, so it must not start a comment and
  // swallow the pin that follows.
  it("does not treat a `/*` inside a string literal as a comment", async () => {
    await writeConfig(
      `export default {\n  package: "@acme/payload",\n  base: "base",\n  ignore: "src/**/*.ts",\n  version: "${FROM}",\n  profile: "nuxt-4",\n};\n`,
    );
    await runUpgrade(baseOpts());
    expect(await readConfig()).toContain(`version: "${TO}"`);
  });

  it("upgrades over a payload override with --to, skipping the registry probe", async () => {
    // The payload is pinned through pnpm.overrides to a file: tarball, so a registry
    // probe would resolve false. We skip it and trust --to; resolvePayload still gates.
    await writeFile(
      join(repo, "package.json"),
      `${JSON.stringify({
        name: "app",
        devDependencies: { "@acme/payload": FROM, "@sidebase/streamctl": FROM },
        pnpm: { overrides: { "@acme/payload": "file:/tmp/streamctl-tgz/config.tgz" } },
      }, null, 2)}\n`,
    );
    const versionExists = vi.fn(async () => {
      throw new Error("registry probe must not run over an override");
    });
    const result = await runUpgrade(baseOpts({ to: TO, versionExists }));

    expect(versionExists).not.toHaveBeenCalled();
    expect(result.toVersion).toBe(TO);
    expect(await readConfig()).toContain(`version: "${TO}"`);
    // A bare-version payload devDep is still bumped; only protocol specs are exempt.
    expect((await readPkg()).devDependencies["@acme/payload"]).toBe(TO);
  });

  it("refuses a bare upgrade over an override, since --to is the only signal", async () => {
    await writeFile(
      join(repo, "package.json"),
      `${JSON.stringify({
        name: "app",
        devDependencies: { "@acme/payload": FROM, "@sidebase/streamctl": FROM },
        pnpm: { overrides: { "@acme/payload": "file:/tmp/streamctl-tgz/config.tgz" } },
      }, null, 2)}\n`,
    );
    const latestProbe = vi.fn(async () => TO);
    const error = await runUpgrade(baseOpts({ latestProbe })).catch((e: unknown) => e);

    expect(latestProbe).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).toContain("--to");
    // Nothing bumped: the pin stays at FROM.
    expect(await readConfig()).toContain(`version: "${FROM}"`);
  });

  it("leaves a file: payload devDep untouched across an upgrade", async () => {
    // The override carries no embedded semver, so the preflight only notes it and
    // proceeds. What matters here is that the file: devDep string survives verbatim.
    await writeFile(
      join(repo, "package.json"),
      `${JSON.stringify({
        name: "app",
        devDependencies: {
          "@acme/payload": "file:/tmp/streamctl-tgz/acme-payload-1.0.0.tgz",
          "@sidebase/streamctl": FROM,
        },
        pnpm: { overrides: { "@acme/payload": "file:/tmp/streamctl-tgz/config.tgz" } },
      }, null, 2)}\n`,
    );
    const result = await runUpgrade(baseOpts({ to: TO }));

    // The pin still advances, but the file: devDep is not rewritten to a bare range
    // (the override resolves the real version), so it is not reported as a bump.
    expect(await readConfig()).toContain(`version: "${TO}"`);
    expect((await readPkg()).devDependencies["@acme/payload"]).toBe("file:/tmp/streamctl-tgz/acme-payload-1.0.0.tgz");
    expect(result.dependencyBumps.some(b => b.name === "@acme/payload")).toBe(false);
  });

  it("CONFIG_INVALID when no version pin sits on its own line", async () => {
    await writeConfig(`export default { package: "@acme/payload", base: "base", version: "${FROM}", profile: "nuxt-4" };\n`);
    const install = vi.fn(async () => {});
    const error = await runUpgrade(baseOpts({ install })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");

    // The config pin is bumped before package.json, so a missing pin has to abort
    // before the devDeps advance. Otherwise package.json and config.ts skew.
    const pkg = await readPkg();
    expect(pkg.devDependencies["@acme/payload"]).toBe(FROM);
    expect(pkg.devDependencies["@sidebase/streamctl"]).toBe(FROM);
    expect(install).not.toHaveBeenCalled();
  });

  // upgrade used to be the only command skipping stage-2 (payload-declared knob)
  // validation, so a typo that `sync` rejects outright was silently ignored here,
  // and the pin, devDeps and install all went ahead first.
  describe("stage-2 config validation", () => {
    const withKnob = (knob: string): string =>
      `export default {\n  package: "@acme/payload",\n  base: "base",\n  version: "${FROM}",\n  profile: "nuxt-4",\n  ci: { ${knob} },\n};\n`;

    // The shared harness pre-installs the target version to fake the post-install
    // state. Pre-write validation reads the payload actually on disk before the
    // upgrade, so these fixtures model the real thing: installed == pinned (FROM),
    // with the install seam moving it to TO.
    beforeEach(async () => {
      await writeFile(join(configPkg, "package.json"), JSON.stringify({ name: "@acme/payload", version: FROM }));
    });
    const installMovesPayloadToTarget = async (): Promise<void> => {
      await writeFile(join(configPkg, "package.json"), JSON.stringify({ name: "@acme/payload", version: TO }));
    };

    it.each([
      { case: "an undeclared knob", knob: `typoToggle: true`, path: "ci.typoToggle" },
      { case: "a knob of the wrong type", knob: `unitTests: "yes"`, path: "ci.unitTests" },
    ])("aborts with CONFIG_INVALID before any write on $case", async ({ knob, path }) => {
      await writeConfig(withKnob(knob));
      const before = await hashSnapshot();
      const install = vi.fn(async () => {});

      const error = await runUpgrade(baseOpts({ install })).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(StreamctlError);
      expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
      const details = (error as StreamctlError).details as { issues: { path: string; message: string }[] };
      expect(details.issues.map(i => i.path)).toContain(path);

      expect(await hashSnapshot()).toEqual(before);
      expect(await readConfig()).toContain(`version: "${FROM}"`);
      expect((await readPkg()).devDependencies["@acme/payload"]).toBe(FROM);
      expect(install).not.toHaveBeenCalled();
    });

    it("reports the same issue sync would, for the same config and payload", async () => {
      // Parity is the whole point: both funnel through the one validator, so the
      // reported issue must be identical rather than merely similar.
      await writeConfig(withKnob(`unitTests: "yes"`));
      const error = await runUpgrade(baseOpts()).catch((e: unknown) => e);
      const details = (error as StreamctlError).details as { issues: { path: string; message: string }[] };
      expect(details.issues).toEqual([{ path: "ci.unitTests", message: "expected boolean, got string" }]);
    });

    it("a valid declared knob upgrades normally", async () => {
      await writeConfig(withKnob(`unitTests: true`));
      const result = await runUpgrade(baseOpts({ install: installMovesPayloadToTarget }));
      expect(result.toVersion).toBe(TO);
      expect(await readConfig()).toContain(`version: "${TO}"`);
    });

    it("does not fail when the current payload is not installed", async () => {
      // A pin ahead of node_modules is exactly what CONFIG_VERSION_MISMATCH tells
      // users to run `upgrade` for, so the gate must not turn it into a hard error.
      await writeConfig(withKnob(`unitTests: true`));
      await writeFile(join(configPkg, "package.json"), JSON.stringify({ name: "@acme/payload", version: "0.0.1" }));

      const result = await runUpgrade(baseOpts({ install: installMovesPayloadToTarget }));
      expect(result.toVersion).toBe(TO);
    });
  });

  it("bumps the top-level pin, not a nested payload knob declared before it", async () => {
    // `ci.version` is a payload knob that happens to sit above the pin. Document
    // order used to decide, so the knob got rewritten with the streamctl version
    // and the real pin stayed stale.
    await writeConfig(
      `export default {\n  package: "@acme/payload",\n  base: "base",\n  ci: {\n    version: "22",\n  },\n  version: "${FROM}",\n  profile: "nuxt-4",\n};\n`,
    );
    await runUpgrade(baseOpts());

    const config = await readConfig();
    expect(config).toContain(`version: "22"`); // the knob is untouched
    expect(config).toContain(`  version: "${TO}"`); // the pin advanced
    expect(config).not.toContain(FROM);
  });

  it("same when the pin is declared before the nested knob", async () => {
    await writeConfig(
      `export default {\n  package: "@acme/payload",\n  base: "base",\n  version: "${FROM}",\n  ci: {\n    version: "22",\n  },\n  profile: "nuxt-4",\n};\n`,
    );
    await runUpgrade(baseOpts());

    const config = await readConfig();
    expect(config).toContain(`version: "22"`);
    expect(config).toContain(`  version: "${TO}"`);
    expect(config).not.toContain(FROM);
  });

  it("a tab-indented config still bumps the right pin", async () => {
    // Depth, not document order, is the selector, and depth is only meaningful
    // relative to the other `version:` lines in the file.
    await writeConfig(
      `export default {\n\tpackage: "@acme/payload",\n\tbase: "base",\n\tversion: "${FROM}",\n\tprofile: "nuxt-4",\n};\n`,
    );
    await runUpgrade(baseOpts());
    expect(await readConfig()).toContain(`\tversion: "${TO}"`);
  });

  // Blank lines before the pin must not count toward its indentation depth. They
  // used to: `^` also asserts at a blank line under /m, so a newline-spanning
  // indent capture swallowed the blank lines plus the real indent.
  it.each([
    { blanks: 2, why: "used to report a spurious ambiguity" },
    { blanks: 3, why: "used to overwrite the nested knob" },
  ])("$blanks blank lines before the pin ($why)", async ({ blanks }) => {
    await writeConfig(
      `export default {\n  package: "@acme/payload",\n  base: "base",\n  ci: {\n    version: "22",\n  },${"\n".repeat(blanks + 1)}  version: "${FROM}",\n  profile: "nuxt-4",\n};\n`,
    );
    await runUpgrade(baseOpts());

    const config = await readConfig();
    expect(config).toContain(`version: "22"`); // the nested knob is untouched
    expect(config).toContain(`  version: "${TO}"`); // the real pin advanced
    expect(config).not.toContain(FROM);
    // The blank lines survive verbatim: the bump is a value rewrite, not a reflow.
    expect(config).toContain(`},${"\n".repeat(blanks + 1)}  version: "${TO}"`);
  });

  it("two pins at the same depth are ambiguous, so nothing is written", async () => {
    const ambiguous = `const shared = {\n  version: "22",\n};\n\nexport default {\n  package: "@acme/payload",\n  base: "base",\n  version: "${FROM}",\n  profile: "nuxt-4",\n  ci: shared,\n};\n`;
    await writeConfig(ambiguous);
    const before = await hashSnapshot();
    const install = vi.fn(async () => {});

    const error = await runUpgrade(baseOpts({ install })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).toMatch(/ambiguous version pin/i);
    // This repo uses the root config, so it catches a hardcoded *legacy* literal in the
    // ambiguous branch — the mirror of the legacy-repo test on the no-pin branch, which
    // catches a hardcoded root one. Between them both branches and both directions are
    // covered; the unreadable-file branch is deliberately left unpinned, since only a
    // TOCTOU delete between the resolver's probe and the read can reach it.
    expect(((error as StreamctlError).details as { path: string }).path).toBe("streamctl.config.ts");

    // Guessing between the two would corrupt one of them, so we write nothing.
    expect(await readConfig()).toBe(ambiguous);
    expect(await hashSnapshot()).toEqual(before);
    expect(install).not.toHaveBeenCalled();
  });
});

describe("runUpgrade: version-reconcile dirty warning", () => {
  const git = (...args: string[]): Promise<unknown> => execFileAsync("git", args, { cwd: repo });

  // A preset whose nuxt-4 profile reconciles `engines.node`, so the chained sync
  // produces a real version change and the warning is reachable.
  async function withBaseline(): Promise<void> {
    await writeFile(
      join(configPkg, "presets", "base", "preset.json"),
      JSON.stringify({
        name: "base",
        files: [
          { path: ".editorconfig", strategy: "full", source: "base/editorconfig" },
          { path: "eslint.config.ts", strategy: "scaffold", source: "base/eslint.config.ts" },
        ],
        configKeys: { "ci.unitTests": "boolean", "ci.version": "string" },
        versionProfiles: { "nuxt-4": { "engines.node": ">=24.13.0" } },
      }),
    );
  }

  function capture(): { warnings: string[]; logger: { warn: (m: string) => void } } {
    const warnings: string[] = [];
    return { warnings, logger: { warn: (m: string) => void warnings.push(m) } };
  }

  beforeEach(async () => {
    await withBaseline();
    await git("init", "-q", ".");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "test");
    await git("add", "-A");
    await git("commit", "-q", "-m", "init");
  });

  it("does not warn about uncommitted changes when the pre-upgrade tree is clean", async () => {
    const { warnings, logger } = capture();
    const result = await runUpgrade(baseOpts({ logger }));

    // The reconcile genuinely fired, so the warning path was reachable...
    expect(result.sync?.versionChanges.length).toBeGreaterThan(0);
    // ...but package.json was dirtied only by upgrade's own devDep bump, so the
    // "you had uncommitted changes" warning must NOT fire on a clean tree.
    expect(warnings.some(w => w.includes("uncommitted changes"))).toBe(false);
  });

  it("still warns when the user had genuine uncommitted package.json changes", async () => {
    // A real pre-existing edit the reconcile will now be mixed with.
    const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8")) as Record<string, unknown>;
    pkg.description = "local edit";
    await writeFile(join(repo, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

    const { warnings, logger } = capture();
    const result = await runUpgrade(baseOpts({ logger }));

    expect(result.sync?.versionChanges.length).toBeGreaterThan(0);
    expect(warnings.some(w => w.includes("uncommitted changes"))).toBe(true);
  });
});

describe("extractEmbeddedVersion", () => {
  it("strips a trailing archive extension so a prerelease isn't swallowed", () => {
    expect(extractEmbeddedVersion("file:/tmp/streamctl-tgz/config-2.0.0-beta.1.tgz")).toBe("2.0.0-beta.1");
    expect(extractEmbeddedVersion("file:/tmp/config-1.2.3.tgz")).toBe("1.2.3");
    expect(extractEmbeddedVersion("file:/tmp/config-1.2.3.tar.gz")).toBe("1.2.3");
  });

  it("returns null for a version-less value", () => {
    expect(extractEmbeddedVersion("file:/tmp/streamctl-tgz/config.tgz")).toBeNull();
    expect(extractEmbeddedVersion("link:../config")).toBeNull();
  });

  it("takes the last semver, so a tarball tail beats a versioned directory", () => {
    expect(extractEmbeddedVersion("file:/opt/1.2.3/config-2.0.0.tgz")).toBe("2.0.0");
  });
});

describe("runUpgrade: stale-override preflight", () => {
  const overridePkg = (overrideValue: string): string => `${JSON.stringify({
    name: "app",
    devDependencies: { "@acme/payload": FROM, "@sidebase/streamctl": FROM },
    pnpm: { overrides: { "@acme/payload": overrideValue } },
  }, null, 2)}\n`;

  it("fails before any bump when the override version isn't the --to target", async () => {
    await writeFile(join(repo, "package.json"), overridePkg("file:/tmp/streamctl-tgz/acme-payload-1.0.0.tgz"));
    const install = vi.fn(async () => {});

    const error = await runUpgrade(baseOpts({ to: TO, install })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).toContain("1.0.0 ≠ the target 2.0.0");
    expect((error as StreamctlError).message).toContain("Update pnpm.overrides");
    expect((error as StreamctlError).details).toMatchObject({ overrideVersion: "1.0.0", to: TO });
    // The preflight fires before snapshot, bump and install, so nothing is touched.
    expect(install).not.toHaveBeenCalled();
    expect(await readConfig()).toContain(`version: "${FROM}"`);
    expect((await readPkg()).devDependencies["@acme/payload"]).toBe(FROM);
  });

  it("proceeds when the override version equals the --to target", async () => {
    await writeFile(join(repo, "package.json"), overridePkg("file:/tmp/streamctl-tgz/acme-payload-2.0.0.tgz"));
    const result = await runUpgrade(baseOpts({ to: TO }));
    expect(result.toVersion).toBe(TO);
    expect(await readConfig()).toContain(`version: "${TO}"`);
  });

  it("warns but proceeds on a version-less override", async () => {
    await writeFile(join(repo, "package.json"), overridePkg("file:/tmp/streamctl-tgz/config.tgz"));
    const warnings: string[] = [];
    const logger = {
      warn: (m: string) => {
        warnings.push(m);
      },
    };

    const result = await runUpgrade(baseOpts({ to: TO, logger }));
    expect(result.toVersion).toBe(TO);
    expect(warnings.some(w => w.includes("no embedded version"))).toBe(true);
  });

  it("skips the preflight when the payload is not overridden", async () => {
    // No pnpm.overrides, so the preflight is inert and a normal registry --to runs.
    const result = await runUpgrade(baseOpts({ to: TO }));
    expect(result.toVersion).toBe(TO);
  });
});

describe("runUpgrade: rollback reinstall", () => {
  it("reinstalls after a post-install rollback so node_modules matches package.json", async () => {
    await writeFile(join(repo, ".editorconfig"), "root = false\n"); // preflight conflict, then rollback
    const reinstall = vi.fn(async () => {});

    const error = await runUpgrade(baseOpts({ reinstall })).catch((e: unknown) => e);
    expect((error as StreamctlError).code).toBe("CONFLICTS_PENDING");
    expect(reinstall).toHaveBeenCalledTimes(1);
    expect(reinstall).toHaveBeenCalledWith(repo);
  });

  it("no reinstall when the install step itself failed", async () => {
    const install = vi.fn(async () => {
      throw new Error("install boom");
    });
    const reinstall = vi.fn(async () => {});

    const error = await runUpgrade(baseOpts({ install, reinstall })).catch((e: unknown) => e);
    expect((error as StreamctlError).code).toBe("INSTALL_FAILED");
    expect(reinstall).not.toHaveBeenCalled();
  });

  it("no reinstall on --no-install", async () => {
    const reinstall = vi.fn(async () => {});
    const result = await runUpgrade(baseOpts({ noInstall: true, install: async () => ({ installed: false }), reinstall }));
    expect(result.sync).toBeNull();
    expect(reinstall).not.toHaveBeenCalled();
  });

  it("a failed reinstall hints at stale node_modules without masking the original error", async () => {
    await writeFile(
      join(repo, "package.json"),
      `${JSON.stringify({ name: "app", packageManager: "pnpm@10.28.1", devDependencies: { "@acme/payload": FROM, "@sidebase/streamctl": FROM } }, null, 2)}\n`,
    );
    await writeFile(join(repo, ".editorconfig"), "root = false\n"); // conflict, then rollback
    const reinstall = vi.fn(async () => {
      throw new Error("reinstall boom");
    });
    const warnings: string[] = [];
    const logger = {
      warn: (m: string) => {
        warnings.push(m);
      },
    };

    const error = await runUpgrade(baseOpts({ reinstall, logger })).catch((e: unknown) => e);
    // The reinstall failure must not mask the error that caused the rollback.
    expect((error as StreamctlError).code).toBe("CONFLICTS_PENDING");
    expect((error as StreamctlError).details).toMatchObject({ rolledBack: true });
    expect(warnings.some(w => w.includes("node_modules is stale") && w.includes("pnpm install"))).toBe(true);
  });
});

describe("runUpgrade: interrupt signal handling", () => {
  it("restores the snapshot when a signal lands inside the transactional window", async () => {
    const before = await hashSnapshot(); // config + package.json at FROM; lock absent

    let capturedSignal: NodeJS.Signals | undefined;
    let capturedStatuses: RestoreStatus[] | undefined;
    let abortCount = 0;
    let resolveAbort: () => void;
    const aborted = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const onSignalAbort = (signal: NodeJS.Signals, statuses: RestoreStatus[]): void => {
      abortCount += 1;
      capturedSignal = signal;
      capturedStatuses = statuses;
      resolveAbort();
    };

    // Snapshot the SIGINT listeners present before this run so `install` can find
    // and call exactly the handler runUpgrade registers. Invoking our own handler
    // directly, rather than via `process.emit`, keeps the test runner's signal
    // handlers out of it. By the time install runs the pin and package.json are
    // already bumped to TO, so the handler has to restore them.
    const preexisting = new Set(process.listeners("SIGINT"));
    const install = vi.fn((): Promise<void> => {
      const ours = process.listeners("SIGINT").filter(l => !preexisting.has(l));
      for (const l of ours) {
        l("SIGINT");
      }
      // A second signal must be ignored; restoring twice is not idempotent.
      for (const l of ours) {
        l("SIGINT");
      }
      // In reality the process dies here; hang so the main flow never proceeds.
      return new Promise<void>(() => {});
    });

    // Fire-and-forget: install never resolves, so runUpgrade stays pending. The
    // signal handler, not the return value, is what this asserts on.
    void runUpgrade(baseOpts({ install, onSignalAbort })).catch(() => {});
    await aborted;

    expect(capturedSignal).toBe("SIGINT");
    expect(abortCount).toBe(1); // second signal ignored
    expect(capturedStatuses?.map(s => s.path).sort()).toEqual(["package-lock.json", "package.json", "streamctl.config.ts"]);
    expect(capturedStatuses?.every(s => s.ok)).toBe(true);
    expect(await hashSnapshot()).toEqual(before);
    expect(await readConfig()).toContain(`version: "${FROM}"`);
    expect((await readPkg()).devDependencies["@acme/payload"]).toBe(FROM);
  });

  it("deregisters its signal handlers after a clean run", async () => {
    const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
    await runUpgrade(baseOpts());
    expect(process.listenerCount("SIGINT")).toBe(before.int);
    expect(process.listenerCount("SIGTERM")).toBe(before.term);
  });
});

/**
 * A legacy repo keeps its config at `.streamctl/config.ts`, and `upgrade` must act on
 * that file rather than on the root path it would write today. Every assertion here is
 * on file **content or hash**, never on reported restore status: `restoreFile` returns
 * `{ action: "unchanged", ok: true }` for a path that never existed, so a status-based
 * assertion passes in exactly the broken case these tests exist to catch.
 */
describe("runUpgrade: legacy config location", () => {
  const legacyRel = ".streamctl/config.ts";
  const legacyConfig = `export default {\n  package: "@acme/payload",\n  base: "base",\n  version: "${FROM}",\n  profile: "nuxt-4",\n};\n`;

  /** Move this repo's config from the root to the legacy location. */
  async function useLegacyConfig(): Promise<void> {
    // Tripwire, not coverage — it can only fail from a deliberate edit, and it proves
    // nothing about the product. Its job is to turn a silent loss into a loud one.
    //
    // These four tests cannot detect a `bumpConfigVersion` hardcoded to the legacy path
    // (see the comment on `writeConfig`); the root-repo tests above are what can, and
    // only while the default fixture stays at the root.
    //
    // Moving it is defended in depth, and this assertion is only the first layer.
    // Measured against a *faithful* relocation — this helper, `readConfig`,
    // `hashSnapshot` and every path-detail expectation, all handled properly:
    //
    //   relocation, assertion present            -> 4 red (this block)
    //   assertion deleted                        -> still 4 red
    //   assertion deleted + `force` on the `rm`  -> still 3 red
    //
    // So the `rm` below is a second, independent guard: with the default moved, it
    // raises ENOENT on its own, with no assertion involved. That is why it has no
    // `force` — adding one is the obvious way to "fix" the resulting failure, and it
    // is the step this comment exists to argue against.
    //
    // An earlier version of this comment claimed the relocation goes 57/57 green the
    // moment this assertion is removed. That does not reproduce; it understates the
    // protection rather than overstating it. Corrected rather than deleted, because a
    // comment asserting a measurement nobody can repeat is worse than no comment.
    expect(existsSync(join(repo, `${CONFIG_FILE}.ts`)), "the default fixture must stay at the root").toBe(true);
    await rm(join(repo, `${CONFIG_FILE}.ts`));
    await mkdir(join(repo, ".streamctl"), { recursive: true });
    await writeFile(join(repo, legacyRel), legacyConfig);
  }

  const readLegacyConfig = (): Promise<string> => readFile(join(repo, legacyRel), "utf8");

  it("moves the pin inside the legacy file", async () => {
    await useLegacyConfig();

    const result = await runUpgrade(baseOpts());

    expect(result.toVersion).toBe(TO);
    expect(await readLegacyConfig()).toContain(`version: "${TO}"`);
    // The root path must not be created as a side effect of the bump.
    expect(existsSync(join(repo, "streamctl.config.ts"))).toBe(false);
  });

  it("restores the legacy file byte-for-byte after a failed install", async () => {
    await useLegacyConfig();
    const before = await hashFile(legacyRel);
    const install = vi.fn(async () => {
      throw new Error("install boom");
    });

    const error = await runUpgrade(baseOpts({ install })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StreamctlError);
    // The hash is the oracle: the bump advanced the pin to TO, so an unrestored file
    // hashes differently. A rollback that "succeeded" without writing fails here.
    expect(await hashFile(legacyRel)).toBe(before);
    expect(await readLegacyConfig()).toContain(`version: "${FROM}"`);
    expect(await readLegacyConfig()).not.toContain(`version: "${TO}"`);
  });

  it("CONFIG_INVALID details name the legacy path when no pin is bumpable", async () => {
    await useLegacyConfig();
    // Single-line object: the pin regex is line-anchored, so `version:` mid-line is not
    // a bumpable pin. The error then has to name the file the user actually has.
    await writeFile(join(repo, legacyRel), `export default { package: "@acme/payload", base: "base", version: "${FROM}", profile: "nuxt-4" };\n`);

    const error = await runUpgrade(baseOpts({ install: vi.fn(async () => {}) })).catch((e: unknown) => e);

    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    const details = (error as StreamctlError).details as { path: string };
    expect(details.path).toBe(legacyRel);
    // The negative is the point: a regression to the literal would send a legacy-repo
    // user to a root file that does not exist.
    expect(details.path).not.toBe("streamctl.config.ts");
    expect((error as StreamctlError).message).toContain(legacyRel);
  });

  it("ROLLBACK_FAILED names the legacy path, not the root one", async () => {
    await useLegacyConfig();
    const install = vi.fn(async () => {
      throw new Error("install boom");
    });
    const restoreWrite = vi.fn(async () => {
      throw new Error("disk full");
    });

    const error = await runUpgrade(baseOpts({ install, restoreWrite })).catch((e: unknown) => e);

    expect((error as StreamctlError).code).toBe("ROLLBACK_FAILED");
    const details = (error as StreamctlError).details as { failed: string[]; recover: string };
    expect(details.failed).toContain(legacyRel);
    expect(details.failed).not.toContain("streamctl.config.ts");
    // The label doubles as the git pathspec in the recovery command.
    expect(details.recover).toContain(legacyRel);
  });
});
