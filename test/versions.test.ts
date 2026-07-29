import type { StreamctlConfig } from "../src/config/types";
import type { PayloadHandle } from "../src/payload/resolve";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCheck } from "../src/engine/check";
import { checkUpdateAvailable, detectVersionSkew, reconcileVersions } from "../src/engine/versions";
import { StreamctlError } from "../src/errors";
import { exitCodeFor } from "../src/exit-codes";

const BASELINE: Record<string, string> = {
  "engines.node": ">=24.13.0",
  "engines.pnpm": ">=10.29.0",
  "packageManager": "pnpm@10.29.1",
  "devDependencies.typescript": "^6.0",
  "devDependencies.eslint": "^9.39",
  "devDependencies.vitest": "^3.2",
  "devDependencies.jiti": "^2.0",
  "scripts.postinstall": "nuxt prepare",
};

const config: StreamctlConfig = { package: "@acme/payload", base: "nuxt-app", version: "1.0.0", profile: "nuxt-4" };

const PKG = JSON.stringify(
  {
    name: "app",
    packageManager: "pnpm@10.20.0",
    engines: { node: ">=20.0.0", pnpm: ">=10.29.0" },
    scripts: { dev: "nuxt dev", postinstall: "echo old" },
    devDependencies: { typescript: "^5.0", vue: "^3.4", tailwindcss: "^3.0" },
  },
  null,
  2,
);

let cwd: string;
const writePkg = (content: string): Promise<void> => writeFile(join(cwd, "package.json"), content);
const readPkg = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "streamctl-versions-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("reconcileVersions", () => {
  it("touches allow-list keys only", async () => {
    await writePkg(PKG);
    const { changes } = await reconcileVersions({ cwd, config, baseline: BASELINE, hasEslintConfig: true, apply: true });

    const keys = changes.map(c => c.key).sort();
    expect(keys).toEqual([
      "devDependencies.eslint",
      "devDependencies.jiti",
      "devDependencies.typescript",
      "engines.node",
      "packageManager",
      "scripts.postinstall",
    ]);
    // engines.pnpm already matched, so it is absent from the change list.
    expect(changes.find(c => c.key === "engines.node")).toEqual({ key: "engines.node", from: ">=20.0.0", to: ">=24.13.0" });

    const pkg = await readPkg();
    expect((pkg.devDependencies as Record<string, string>).vue).toBe("^3.4");
    expect((pkg.devDependencies as Record<string, string>).tailwindcss).toBe("^3.0");
    expect((pkg.scripts as Record<string, string>).dev).toBe("nuxt dev");
    expect((pkg.scripts as Record<string, string>).postinstall).toBe("nuxt prepare");
    expect((pkg.devDependencies as Record<string, string>).typescript).toBe("^6.0");
    expect((pkg.devDependencies as Record<string, string>).jiti).toBe("^2.0");
  });

  it("only reconciles vitest if the repo already has it", async () => {
    await writePkg(PKG);
    const { changes: absent } = await reconcileVersions({ cwd, config, baseline: BASELINE, hasEslintConfig: true, apply: false });
    expect(absent.some(c => c.key === "devDependencies.vitest")).toBe(false);

    await writePkg(JSON.stringify({ devDependencies: { vitest: "^3.0" } }, null, 2));
    const { changes: present } = await reconcileVersions({ cwd, config, baseline: BASELINE, hasEslintConfig: true, apply: false });
    expect(present.find(c => c.key === "devDependencies.vitest")).toEqual({ key: "devDependencies.vitest", from: "^3.0", to: "^3.2" });
  });

  it("jiti is only reconciled for presets shipping eslint.config.ts", async () => {
    await writePkg(PKG);
    const { changes: without } = await reconcileVersions({ cwd, config, baseline: BASELINE, hasEslintConfig: false, apply: false });
    expect(without.some(c => c.key === "devDependencies.jiti")).toBe(false);
  });

  it("syncs scripts.postinstall and leaves the rest of scripts alone", async () => {
    await writePkg(PKG);
    await reconcileVersions({ cwd, config, baseline: BASELINE, hasEslintConfig: true, apply: true });
    const pkg = await readPkg();
    expect((pkg.scripts as Record<string, string>)).toEqual({ dev: "nuxt dev", postinstall: "nuxt prepare" });
  });

  it("versionSync:false disables reconciliation entirely", async () => {
    await writePkg(PKG);
    const { changes } = await reconcileVersions({ cwd, config: { ...config, versionSync: false }, baseline: BASELINE, hasEslintConfig: true, apply: true });
    expect(changes).toEqual([]);
    expect((await readPkg()).packageManager).toBe("pnpm@10.20.0");
  });

  it("versionSyncExclude skips listed keys", async () => {
    await writePkg(PKG);
    const { changes } = await reconcileVersions({
      cwd,
      config: { ...config, versionSyncExclude: ["devDependencies.typescript", "packageManager"] },
      baseline: BASELINE,
      hasEslintConfig: true,
      apply: false,
    });
    const keys = changes.map(c => c.key);
    expect(keys).not.toContain("devDependencies.typescript");
    expect(keys).not.toContain("packageManager");
    expect(keys).toContain("engines.node");
  });

  it("rejects a versionSyncExclude key the reconciler could never touch", async () => {
    await writePkg(PKG);
    // `browserslist` has no reconcilable prefix (not engines.*/packageManager/*Dependencies.*/scripts.*).
    const error = await reconcileVersions({
      cwd,
      config: { ...config, versionSyncExclude: ["browserslist"] },
      baseline: BASELINE,
      hasEslintConfig: true,
      apply: false,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
  });

  it("reconciles any scripts.<name>, overwriting an existing script (no version floor)", async () => {
    // A script is not a semver, so the forward-aware floor cannot protect it: the
    // baseline value replaces whatever the repo has.
    await writePkg(JSON.stringify({ name: "app", scripts: { lint: "eslint ." } }, null, 2));
    const { changes } = await reconcileVersions({
      cwd,
      config,
      baseline: { "scripts.lint": "oxlint . && eslint ." },
      hasEslintConfig: false,
      apply: true,
    });
    expect(changes).toContainEqual({ key: "scripts.lint", from: "eslint .", to: "oxlint . && eslint ." });
    expect((await readPkg()).scripts).toEqual({ lint: "oxlint . && eslint ." });
  });

  it("rejects a non-string dep value with CONFIG_INVALID naming the key", async () => {
    // JSON-valid but semantically broken: the version is an object, not a string.
    await writePkg(JSON.stringify({ name: "app", devDependencies: { vue: {} } }, null, 2));
    const error = await reconcileVersions({
      cwd,
      config,
      baseline: { "devDependencies.vue": "^3.5" },
      hasEslintConfig: false,
      apply: false,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).toContain("devDependencies.vue");
  });

  it("bumps a `v`-prefixed pin below the baseline floor", async () => {
    // `v1.0.0` is a valid range, so it used to be mistaken for an un-orderable
    // multi-branch range and left untouched; it must reconcile forward.
    await writePkg(JSON.stringify({ name: "app", devDependencies: { vue: "v1.0.0" } }, null, 2));
    const { changes } = await reconcileVersions({
      cwd,
      config,
      baseline: { "devDependencies.vue": "^3.5" },
      hasEslintConfig: false,
      apply: false,
    });
    expect(changes).toContainEqual({ key: "devDependencies.vue", from: "v1.0.0", to: "^3.5" });
  });

  it("does not read a spurious version from a postinstall command's @-tail", async () => {
    // `tool@3.0.0` in a shell command must NOT be parsed as an orderable version;
    // a differing postinstall has to reconcile, not get mis-skipped as ahead.
    await writePkg(JSON.stringify({ name: "app", scripts: { postinstall: "pnpm dlx tool@3.0.0" } }, null, 2));
    const { changes, skippedAhead } = await reconcileVersions({
      cwd,
      config,
      baseline: { "scripts.postinstall": "pnpm dlx tool@2.0.0" },
      hasEslintConfig: false,
      apply: false,
    });
    expect(changes).toContainEqual({ key: "scripts.postinstall", from: "pnpm dlx tool@3.0.0", to: "pnpm dlx tool@2.0.0" });
    expect(skippedAhead).toEqual([]);
  });

  it("warns but accepts an exclude key the active baseline does not define", async () => {
    await writePkg(PKG);
    // The `base` preset and the `nuxt-3` profile ship an empty baseline, so a real
    // allow-list key has nothing to reconcile there. Excluding it has to stay a
    // no-op rather than a throw. It is still usually a typo, hence the warning.
    const warn = vi.fn();
    const { changes } = await reconcileVersions({
      cwd,
      config: { ...config, versionSyncExclude: ["devDependencies.typescript"] },
      baseline: {},
      hasEslintConfig: true,
      apply: false,
      logger: { warn },
    });
    expect(changes).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`"devDependencies.typescript" is not in the active baseline`));
  });

  it("stays quiet when the excluded key is in the baseline", async () => {
    await writePkg(PKG);
    const warn = vi.fn();
    await reconcileVersions({
      cwd,
      config: { ...config, versionSyncExclude: ["devDependencies.typescript"] },
      baseline: BASELINE,
      hasEslintConfig: true,
      apply: false,
      logger: { warn },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("preserves formatting and comments around the edited keys", async () => {
    const annotated = [
      "{",
      "  // project-owned comment",
      "  \"name\": \"app\",",
      "  \"packageManager\": \"pnpm@10.20.0\",",
      "  \"devDependencies\": { \"vue\": \"^3.4\" }",
      "}",
      "",
    ].join("\n");
    await writePkg(annotated);
    await reconcileVersions({ cwd, config, baseline: { packageManager: "pnpm@10.29.1" }, hasEslintConfig: true, apply: true });
    const raw = await readFile(join(cwd, "package.json"), "utf8");
    expect(raw).toContain("// project-owned comment");
    expect(raw).toContain("\"pnpm@10.29.1\"");
    expect(raw).toContain("\"name\": \"app\"");
    expect(raw).toContain("\"vue\": \"^3.4\"");
  });

  it("is a no-op when there is no package.json", async () => {
    const { changes } = await reconcileVersions({ cwd, config, baseline: BASELINE, hasEslintConfig: true, apply: true });
    expect(changes).toEqual([]);
  });

  it("updates a runtime dep in place instead of moving it to devDependencies", async () => {
    await writePkg(JSON.stringify({ dependencies: { nuxt: "^3.0" } }, null, 2));
    const { changes } = await reconcileVersions({
      cwd,
      config,
      baseline: { "devDependencies.nuxt": "^4.0" },
      hasEslintConfig: true,
      apply: true,
    });
    expect(changes).toEqual([{ key: "devDependencies.nuxt", from: "^3.0", to: "^4.0" }]);

    const pkg = await readPkg();
    expect((pkg.dependencies as Record<string, string>).nuxt).toBe("^4.0");
    expect(pkg.devDependencies).toBeUndefined();
  });

  it("parses scoped names when updating a runtime dep", async () => {
    await writePkg(JSON.stringify({ dependencies: { "@prisma/client": "^5.0" } }, null, 2));
    const { changes } = await reconcileVersions({
      cwd,
      config,
      baseline: { "devDependencies.@prisma/client": "^6.0" },
      hasEslintConfig: true,
      apply: true,
    });
    expect(changes).toEqual([{ key: "devDependencies.@prisma/client", from: "^5.0", to: "^6.0" }]);

    const pkg = await readPkg();
    expect((pkg.dependencies as Record<string, string>)["@prisma/client"]).toBe("^6.0");
    expect(pkg.devDependencies).toBeUndefined();
  });

  it("manages a package the CLI has never heard of", async () => {
    // Only the payload's versionProfiles declares this key. The walk iterates
    // declared keys plus the safety pattern, so managing a new package needs no
    // CLI release.
    await writePkg(JSON.stringify({ dependencies: { "some-new-pkg": "^1.0.0" } }, null, 2));
    const { changes } = await reconcileVersions({
      cwd,
      config,
      baseline: { "dependencies.some-new-pkg": "^2.0.0" },
      hasEslintConfig: true,
      apply: true,
    });
    expect(changes).toEqual([{ key: "dependencies.some-new-pkg", from: "^1.0.0", to: "^2.0.0" }]);
    expect((await readPkg()).dependencies).toEqual({ "some-new-pkg": "^2.0.0" });
  });

  it("handles peerDependencies too", async () => {
    await writePkg(JSON.stringify({ peerDependencies: { nuxt: "^3.0" } }, null, 2));
    const { changes } = await reconcileVersions({
      cwd,
      config,
      baseline: { "devDependencies.nuxt": "^4.0" },
      hasEslintConfig: true,
      apply: true,
    });
    expect(changes).toEqual([{ key: "devDependencies.nuxt", from: "^3.0", to: "^4.0" }]);

    const pkg = await readPkg();
    expect((pkg.peerDependencies as Record<string, string>).nuxt).toBe("^4.0");
    expect(pkg.devDependencies).toBeUndefined();
  });

  it("leaves catalog: and workspace: specifiers alone", async () => {
    await writePkg(JSON.stringify({
      devDependencies: { nuxt: "catalog:" },
      dependencies: { "@prisma/client": "workspace:*" },
    }, null, 2));
    const { changes } = await reconcileVersions({
      cwd,
      config,
      baseline: { "devDependencies.nuxt": "^4.0", "devDependencies.@prisma/client": "^6.0" },
      hasEslintConfig: true,
      apply: true,
    });
    expect(changes).toEqual([]);

    const pkg = await readPkg();
    expect((pkg.devDependencies as Record<string, string>).nuxt).toBe("catalog:");
    expect((pkg.dependencies as Record<string, string>)["@prisma/client"]).toBe("workspace:*");
  });

  it("warns rather than throws when a package sits in two sections", async () => {
    await writePkg(JSON.stringify({ dependencies: { nuxt: "^3.0" }, devDependencies: { nuxt: "^3.0" } }, null, 2));
    const warnings: string[] = [];
    const { changes } = await reconcileVersions({
      cwd,
      config,
      baseline: { "devDependencies.nuxt": "^4.0" },
      hasEslintConfig: true,
      apply: true,
      logger: { warn: m => warnings.push(m) },
    });

    // dependencies wins over devDependencies, so the edit lands there.
    expect(changes).toEqual([{ key: "devDependencies.nuxt", from: "^3.0", to: "^4.0" }]);
    const pkg = await readPkg();
    expect((pkg.dependencies as Record<string, string>).nuxt).toBe("^4.0");
    expect((pkg.devDependencies as Record<string, string>).nuxt).toBe("^3.0");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("dependencies");
    expect(warnings[0]).toContain("devDependencies");
  });

  it("adds a missing tooling dep to devDependencies", async () => {
    await writePkg(PKG);
    await reconcileVersions({ cwd, config, baseline: BASELINE, hasEslintConfig: true, apply: true });
    const pkg = await readPkg();
    expect((pkg.devDependencies as Record<string, string>).jiti).toBe("^2.0");
    expect(pkg.dependencies).toBeUndefined();
  });

  // The dependency branch already threw here; the non-dependency branch coerced to
  // `undefined`, which reads as "absent", so the key was rewritten and reported with
  // `from: ""` — telling CI the repo's actual value was the empty string.
  it("rejects a non-string value under a non-dependency key too", async () => {
    await writePkg(JSON.stringify({ name: "app", engines: { node: 22 } }, null, 2));
    const error = await reconcileVersions({
      cwd,
      config,
      baseline: { "engines.node": ">=24.13.0" },
      hasEslintConfig: false,
      apply: false,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).toContain("engines.node");
  });

  // `getAtPath` cannot tell "absent" from "under a non-object", so the plan pass used to
  // accept this and only jsonc-parser failed — inside applyReconcile, after the managed
  // files were already written.
  it("rejects a non-object container before planning an edit", async () => {
    await writePkg(JSON.stringify({ name: "app", devDependencies: null }, null, 2));
    const error = await reconcileVersions({
      cwd,
      config,
      baseline: { "devDependencies.vue": "^3.5" },
      hasEslintConfig: false,
      apply: false,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).toContain("devDependencies");
    expect((error as StreamctlError).message).toContain("null");
  });

  it("rejects a package.json with duplicate keys", async () => {
    await writePkg("{ \"packageManager\": \"pnpm@1\", \"packageManager\": \"pnpm@2\" }\n");
    const error = await reconcileVersions({ cwd, config, baseline: BASELINE, hasEslintConfig: true, apply: false }).catch((e: unknown) => e);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
  });

  describe("forward-aware floor: never downgrade a repo that is ahead", () => {
    it("skips and reports a key whose range-min exceeds the baseline", async () => {
      await writePkg(JSON.stringify({ devDependencies: { eslint: "^10.0.0" } }, null, 2));
      const { changes, skippedAhead } = await reconcileVersions({
        cwd,
        config,
        baseline: { "devDependencies.eslint": "^9.39.2" },
        hasEslintConfig: true,
        apply: true,
      });
      expect(changes).toEqual([]);
      expect(skippedAhead).toEqual([{ key: "devDependencies.eslint", actual: "^10.0.0", baseline: "^9.39.2" }]);
      expect((await readPkg()).devDependencies).toEqual({ eslint: "^10.0.0" });
    });

    it("respects the repo's operator style when the mins are equal (~9.39.2 vs ^9.39.2)", async () => {
      await writePkg(JSON.stringify({ devDependencies: { eslint: "~9.39.2" } }, null, 2));
      const { changes, skippedAhead } = await reconcileVersions({
        cwd,
        config,
        baseline: { "devDependencies.eslint": "^9.39.2" },
        hasEslintConfig: true,
        apply: true,
      });
      expect(changes).toEqual([]);
      expect(skippedAhead).toEqual([{ key: "devDependencies.eslint", actual: "~9.39.2", baseline: "^9.39.2" }]);
      expect((await readPkg()).devDependencies).toEqual({ eslint: "~9.39.2" });
    });

    it("a byte-identical key is in sync, not skipped-ahead", async () => {
      await writePkg(JSON.stringify({ devDependencies: { eslint: "^9.39.2" } }, null, 2));
      const { changes, skippedAhead } = await reconcileVersions({
        cwd,
        config,
        baseline: { "devDependencies.eslint": "^9.39.2" },
        hasEslintConfig: true,
        apply: false,
      });
      expect(changes).toEqual([]);
      expect(skippedAhead).toEqual([]);
    });

    it("still bumps a key that is behind", async () => {
      await writePkg(JSON.stringify({ devDependencies: { eslint: "^9.0.0" } }, null, 2));
      const { changes, skippedAhead } = await reconcileVersions({
        cwd,
        config,
        baseline: { "devDependencies.eslint": "^9.39.2" },
        hasEslintConfig: true,
        apply: true,
      });
      expect(changes).toEqual([{ key: "devDependencies.eslint", from: "^9.0.0", to: "^9.39.2" }]);
      expect(skippedAhead).toEqual([]);
      expect((await readPkg()).devDependencies).toEqual({ eslint: "^9.39.2" });
    });

    it("a pinned prerelease counts as behind its stable floor", async () => {
      await writePkg(JSON.stringify({ devDependencies: { nuxt: "^4.0.0-rc.1" } }, null, 2));
      const { changes, skippedAhead } = await reconcileVersions({
        cwd,
        config,
        baseline: { "devDependencies.nuxt": "^4.0.0" },
        hasEslintConfig: true,
        apply: false,
      });
      expect(changes).toEqual([{ key: "devDependencies.nuxt", from: "^4.0.0-rc.1", to: "^4.0.0" }]);
      expect(skippedAhead).toEqual([]);
    });

    it("a stable pin counts as ahead of a prerelease floor", async () => {
      await writePkg(JSON.stringify({ devDependencies: { nuxt: "^4.0.0" } }, null, 2));
      const { changes, skippedAhead } = await reconcileVersions({
        cwd,
        config,
        baseline: { "devDependencies.nuxt": "^4.0.0-rc.1" },
        hasEslintConfig: true,
        apply: false,
      });
      expect(changes).toEqual([]);
      expect(skippedAhead).toEqual([{ key: "devDependencies.nuxt", actual: "^4.0.0", baseline: "^4.0.0-rc.1" }]);
    });

    it("compares packageManager pins as versions", async () => {
      await writePkg(JSON.stringify({ packageManager: "pnpm@10.29.3" }, null, 2));
      const { changes, skippedAhead } = await reconcileVersions({
        cwd,
        config,
        baseline: { packageManager: "pnpm@10.28.1" },
        hasEslintConfig: true,
        apply: true,
      });
      expect(changes).toEqual([]);
      expect(skippedAhead).toEqual([{ key: "packageManager", actual: "pnpm@10.29.3", baseline: "pnpm@10.28.1" }]);
      expect((await readPkg()).packageManager).toBe("pnpm@10.29.3");
    });

    it("is floor-aware for an engines range", async () => {
      await writePkg(JSON.stringify({ engines: { pnpm: ">=10.29.3" } }, null, 2));
      const { changes, skippedAhead } = await reconcileVersions({
        cwd,
        config,
        baseline: { "engines.pnpm": ">=10.29.0" },
        hasEslintConfig: true,
        apply: true,
      });
      expect(changes).toEqual([]);
      expect(skippedAhead).toEqual([{ key: "engines.pnpm", actual: ">=10.29.3", baseline: ">=10.29.0" }]);
    });

    it("falls back to exact-string compare for an unparseable spec", async () => {
      await writePkg(JSON.stringify({ dependencies: { "some-pkg": "git+https://example.com/some-pkg.git" } }, null, 2));
      const { changes, skippedAhead } = await reconcileVersions({
        cwd,
        config,
        baseline: { "dependencies.some-pkg": "^1.0.0" },
        hasEslintConfig: true,
        apply: false,
      });
      // A git URL has no orderable floor, so it falls through to the string
      // compare and lands in `changes`, rather than being waved through as "ahead".
      expect(changes).toEqual([{ key: "dependencies.some-pkg", from: "git+https://example.com/some-pkg.git", to: "^1.0.0" }]);
      expect(skippedAhead).toEqual([]);
    });

    it("does not read an npm alias as a version pin", async () => {
      await writePkg(JSON.stringify({ dependencies: { "some-pkg": "npm:foo@1.2.3" } }, null, 2));
      const { changes, skippedAhead } = await reconcileVersions({
        cwd,
        config,
        baseline: { "dependencies.some-pkg": "^1.0.0" },
        hasEslintConfig: true,
        apply: false,
      });
      // The `@` here delimits the aliased package, not a version. Parsing it as
      // 1.2.3 would make the entry look ahead of the 1.0.0 floor and skip it.
      expect(skippedAhead).toEqual([]);
      expect(changes).toEqual([{ key: "dependencies.some-pkg", from: "npm:foo@1.2.3", to: "^1.0.0" }]);
    });

    it("leaves an OR-range like `^9 || ^10` intact", async () => {
      const pkg = JSON.stringify({ devDependencies: { eslint: "^9 || ^10" } }, null, 2);
      await writePkg(pkg);
      const { changes, skippedAhead } = await reconcileVersions({
        cwd,
        config,
        baseline: { "devDependencies.eslint": "^9.39.2" },
        hasEslintConfig: true,
        apply: true,
      });
      // There is no single orderable floor here. Collapsing to the baseline would
      // silently drop the `^10` branch, so the range is preserved as written.
      expect(changes).toEqual([]);
      expect(skippedAhead).toEqual([]);
      expect(await readFile(join(cwd, "package.json"), "utf8")).toBe(pkg);
    });

    it("same for a hyphen range", async () => {
      await writePkg(JSON.stringify({ devDependencies: { eslint: "9.0.0 - 10.0.0" } }, null, 2));
      const { changes, skippedAhead } = await reconcileVersions({
        cwd,
        config,
        baseline: { "devDependencies.eslint": "^9.39.2" },
        hasEslintConfig: true,
        apply: false,
      });
      expect(changes).toEqual([]);
      expect(skippedAhead).toEqual([]);
    });

    it("skips a version carrying `+build` metadata", async () => {
      await writePkg(JSON.stringify({ devDependencies: { eslint: "1.2.0+build" } }, null, 2));
      const { changes, skippedAhead } = await reconcileVersions({
        cwd,
        config,
        baseline: { "devDependencies.eslint": "^9.39.2" },
        hasEslintConfig: true,
        apply: false,
      });
      expect(changes).toEqual([]);
      expect(skippedAhead).toEqual([]);
    });

    it("still rewrites a git-URL and an npm-alias", async () => {
      await writePkg(JSON.stringify({ dependencies: { a: "git+https://example.com/a.git", b: "npm:foo@1.2.3" } }, null, 2));
      const { changes, skippedAhead } = await reconcileVersions({
        cwd,
        config,
        baseline: { "dependencies.a": "^1.0.0", "dependencies.b": "^1.0.0" },
        hasEslintConfig: true,
        apply: false,
      });
      expect(skippedAhead).toEqual([]);
      expect(changes).toEqual([
        { key: "dependencies.a", from: "git+https://example.com/a.git", to: "^1.0.0" },
        { key: "dependencies.b", from: "npm:foo@1.2.3", to: "^1.0.0" },
      ]);
    });

    it("an unparseable spec matching the baseline exactly is a no-op", async () => {
      await writePkg(JSON.stringify({ scripts: { postinstall: "nuxt prepare" } }, null, 2));
      const { changes, skippedAhead } = await reconcileVersions({
        cwd,
        config,
        baseline: { "scripts.postinstall": "nuxt prepare" },
        hasEslintConfig: true,
        apply: false,
      });
      expect(changes).toEqual([]);
      expect(skippedAhead).toEqual([]);
    });

    it("versionSyncExclude wins over the floor rule", async () => {
      await writePkg(JSON.stringify({ devDependencies: { eslint: "^10.0.0" } }, null, 2));
      const { changes, skippedAhead } = await reconcileVersions({
        cwd,
        config: { ...config, versionSyncExclude: ["devDependencies.eslint"] },
        baseline: { "devDependencies.eslint": "^9.39.2" },
        hasEslintConfig: true,
        apply: false,
      });
      expect(changes).toEqual([]);
      expect(skippedAhead).toEqual([]);
    });

    it("a repo ahead on every managed key needs no excludes", async () => {
      // A repo already ahead of the baseline on every managed key: every version
      // is newer, so reconciliation should touch nothing and need no excludes.
      const aheadEverywhere = JSON.stringify({
        name: "sample-app",
        packageManager: "pnpm@10.29.3",
        engines: { pnpm: ">=10.29.3" },
        devDependencies: { eslint: "^10.0.0", vitest: "^4.1.8", nuxt: "^4.3.1", oxlint: "^1.47.0" },
      }, null, 2);
      await writePkg(aheadEverywhere);
      const baseline: Record<string, string> = {
        "packageManager": "pnpm@10.28.1",
        "engines.pnpm": ">=10.29.0",
        "devDependencies.eslint": "^9.39.2",
        "devDependencies.vitest": "^3",
        "devDependencies.nuxt": "^4.3.0",
        "devDependencies.oxlint": "^1.43.0",
      };
      const { changes, skippedAhead } = await reconcileVersions({ cwd, config, baseline, hasEslintConfig: true, apply: true });

      expect(changes).toEqual([]);
      expect(skippedAhead.map(s => s.key).sort()).toEqual([
        "devDependencies.eslint",
        "devDependencies.nuxt",
        "devDependencies.oxlint",
        "devDependencies.vitest",
        "engines.pnpm",
        "packageManager",
      ]);
      expect(await readFile(join(cwd, "package.json"), "utf8")).toBe(aheadEverywhere);
    });
  });
});

describe("detectVersionSkew", () => {
  it("reshapes changes into {key, actual, expected}", async () => {
    await writePkg(PKG);
    const skew = await detectVersionSkew({ cwd, config, baseline: { packageManager: "pnpm@10.29.1" }, hasEslintConfig: true });
    expect(skew).toEqual([{ key: "packageManager", actual: "pnpm@10.20.0", expected: "pnpm@10.29.1" }]);
  });

  it("a repo ahead of the floor is not skewed", async () => {
    await writePkg(JSON.stringify({ engines: { pnpm: ">=10.29.3" } }, null, 2));
    const skew = await detectVersionSkew({ cwd, config, baseline: { "engines.pnpm": ">=10.29.0" }, hasEslintConfig: true });
    // Otherwise `check` goes red and prompts for a downgrade nobody wants.
    expect(skew).toEqual([]);
  });
});

describe("checkUpdateAvailable, with the registry probe injected", () => {
  it("reports a newer release", async () => {
    expect(await checkUpdateAvailable(cwd, "1.0.0", "@acme/payload", async () => "1.2.0")).toEqual({ current: "1.0.0", latest: "1.2.0" });
  });

  it("quiet when already on latest, or when the probe comes back empty", async () => {
    expect(await checkUpdateAvailable(cwd, "1.0.0", "@acme/payload", async () => "1.0.0")).toBeUndefined();
    expect(await checkUpdateAvailable(cwd, "1.0.0", "@acme/payload", async () => null)).toBeUndefined();
  });

  it("1.2.0 is an update for someone pinned to 1.2.0-rc.1", async () => {
    expect(await checkUpdateAvailable(cwd, "1.2.0-rc.1", "@acme/payload", async () => "1.2.0")).toEqual({ current: "1.2.0-rc.1", latest: "1.2.0" });
  });

  it("and not the other way round", async () => {
    expect(await checkUpdateAvailable(cwd, "1.2.0", "@acme/payload", async () => "1.2.0-rc.1")).toBeUndefined();
  });

  it("orders prerelease identifiers per semver precedence", async () => {
    // Last pair is the interesting one: numeric identifiers sort below
    // alphanumeric ones, so alpha.1 is behind beta.
    expect(await checkUpdateAvailable(cwd, "1.2.0-rc.1", "@acme/payload", async () => "1.2.0-rc.2")).toEqual({ current: "1.2.0-rc.1", latest: "1.2.0-rc.2" });
    expect(await checkUpdateAvailable(cwd, "1.2.0-rc.1", "@acme/payload", async () => "1.2.0-rc.1")).toBeUndefined();
    expect(await checkUpdateAvailable(cwd, "1.2.0-alpha.1", "@acme/payload", async () => "1.2.0-beta")).toEqual({ current: "1.2.0-alpha.1", latest: "1.2.0-beta" });
  });
});

describe("runCheck outdated gate", () => {
  const payload: PayloadHandle = {
    version: "1.0.0",
    async read(source) {
      const entries: Record<string, string> = {
        "manifest.json": JSON.stringify({ schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" }),
        "base/preset.json": JSON.stringify({
          name: "base",
          files: [{ path: ".editorconfig", strategy: "full", source: "base/editorconfig" }],
        }),
        "base/editorconfig": "root = true\n",
      };
      const content = entries[source];
      if (content === undefined)
        throw new Error(`missing fixture source: ${source}`);
      return content;
    },
    async list() {
      return ["manifest.json"];
    },
  };

  it("throws OUTDATED with exit 4 when failOn covers it", async () => {
    await writeFile(join(cwd, ".editorconfig"), "root = true\n");
    const error = await runCheck(cwd, payload, { package: "@acme/payload", base: "base", version: "1.0.0", profile: "nuxt-4" }, "outdated", {
      latestProbe: async () => "2.0.0",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("OUTDATED");
    expect(exitCodeFor((error as StreamctlError).code)).toBe(4);
    expect((error as StreamctlError).details).toMatchObject({ updateAvailable: { current: "1.0.0", latest: "2.0.0" } });
  });
});
