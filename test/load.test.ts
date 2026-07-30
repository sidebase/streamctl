import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "c12";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadStreamctlConfig } from "../src/config/load";
import { StreamctlError } from "../src/errors";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Can this platform/user create symlinks at all? Windows often can't. */
function symlinksSupported(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "streamctl-symprobe-"));
  try {
    writeFileSync(join(dir, "t"), "x");
    symlinkSync(join(dir, "t"), join(dir, "l"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const canSymlink = symlinksSupported();

const VALID_CONFIG = `export default {
  package: "@acme/payload",
  base: "nuxt-app",
  version: "1.2.3",
  profile: "nuxt-4",
};
`;

describe("loadStreamctlConfig", () => {
  it("loads and validates a valid config", async () => {
    const { config } = await loadStreamctlConfig(join(fixtures, "valid"));
    expect(config.base).toBe("nuxt-app");
    expect(config.version).toBe("1.2.3");
    expect(config.profile).toBe("nuxt-4");
    expect(config.versionSyncExclude).toEqual(["devDependencies.typescript"]);
  });

  it("NOT_INITIALIZED when the config is absent", async () => {
    const error = await loadStreamctlConfig(join(fixtures, "uninitialized")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("NOT_INITIALIZED");
    // Names the default location and the legacy one, since either is accepted.
    expect((error as StreamctlError).message).toContain("streamctl.config.ts");
    expect((error as StreamctlError).message).toContain(".streamctl/config.ts");
  });

  it("throws CONFIG_INVALID naming `version` on bad semver", async () => {
    const error = await loadStreamctlConfig(join(fixtures, "bad-semver")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).toContain("version");
  });

  it("lets an unknown top-level key through stage 1", async () => {
    // Unknown top-level keys are payload knobs. Loading has no merged chain to
    // check them against, so the strict pass lives in stage 2 (validateConfigKeys).
    const { config } = await loadStreamctlConfig(join(fixtures, "unknown-key"));
    expect(config.base).toBe("nuxt-app");
    expect((config as Record<string, unknown>).foo).toBe(true);
  });

  it("rejects a bad versionSyncExclude entry", async () => {
    const error = await loadStreamctlConfig(join(fixtures, "bad-exclude")).catch((e: unknown) => e);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).toContain("versionSyncExclude");
  });

  describe("location", () => {
    it("reports the legacy location for a legacy fixture", async () => {
      const cwd = join(fixtures, "valid");
      const { location } = await loadStreamctlConfig(cwd);

      expect(location.source).toBe("legacy");
      expect(location.rel).toBe(".streamctl/config.ts");
      expect(location.abs).toBe(join(cwd, ".streamctl", "config.ts"));
    });

    it("`location.abs` is the file c12 resolved", async () => {
      const cwd = join(fixtures, "valid");
      const { location } = await loadStreamctlConfig(cwd);

      const { _configFile } = await loadConfig({
        cwd,
        name: "streamctl",
        configFile: ".streamctl/config",
        rcFile: false,
        globalRc: false,
        packageJson: false,
        dotenv: false,
        envName: false,
      });

      // Compared as realpath'd forms, which is what the loader's own invariant means by
      // agreement: c12 emits pathe-normalized (forward-slashed) paths and may expand a
      // Windows 8.3 short name, so the raw strings can differ for the same file.
      expect(realpathSync(location.abs)).toBe(realpathSync(_configFile ?? ""));
    });
  });

  describe("root location", () => {
    let root: string;

    beforeEach(async () => {
      root = realpathSync(await mkdtemp(join(tmpdir(), "streamctl-load-")));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("loads a root config and reports it", async () => {
      await writeFile(join(root, "streamctl.config.ts"), VALID_CONFIG);

      const { config, location } = await loadStreamctlConfig(root);

      expect(config.base).toBe("nuxt-app");
      expect(location.source).toBe("root");
      expect(location.rel).toBe("streamctl.config.ts");
    });

    it("loads the root config and warns when both locations exist", async () => {
      const warnings: string[] = [];
      await writeFile(join(root, "streamctl.config.ts"), VALID_CONFIG);
      await mkdir(join(root, ".streamctl"), { recursive: true });
      await writeFile(join(root, ".streamctl", "config.ts"), VALID_CONFIG.replace("nuxt-app", "legacy-base"));

      const { config, location } = await loadStreamctlConfig(root, {
        logger: { warn: message => warnings.push(message) },
      });

      expect(location.source).toBe("root");
      // The root config's `base`, proving the legacy file was not the one loaded.
      expect(config.base).toBe("nuxt-app");
      // The ambiguity warning reaches the caller's logger through the loader.
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("streamctl.config.ts");
      expect(warnings[0]).toContain(".streamctl/config.ts");
    });

    it.skipIf(!canSymlink)("accepts a config that is a symlink", async () => {
      // `statSync` follows the link, so the probe reports the link path while c12 may
      // realpath to the target. The loader's invariant compares realpath'd forms, so
      // this layout keeps working — a string comparison would fail it as CONFIG_INVALID,
      // which would be a regression against today's behavior.
      const shared = join(root, "shared");
      await mkdir(shared, { recursive: true });
      await writeFile(join(shared, "streamctl.ts"), VALID_CONFIG);
      await symlink(join(shared, "streamctl.ts"), join(root, "streamctl.config.ts"));

      const { config, location } = await loadStreamctlConfig(root);

      expect(config.base).toBe("nuxt-app");
      expect(location.rel).toBe("streamctl.config.ts");
      expect(location.source).toBe("root");
    });

    it.skipIf(!canSymlink)("accepts a legacy config that is a symlink", async () => {
      const shared = join(root, "shared");
      await mkdir(join(root, ".streamctl"), { recursive: true });
      await mkdir(shared, { recursive: true });
      await writeFile(join(shared, "streamctl.ts"), VALID_CONFIG);
      await symlink(join(shared, "streamctl.ts"), join(root, ".streamctl", "config.ts"));

      const { config, location } = await loadStreamctlConfig(root);

      expect(config.base).toBe("nuxt-app");
      expect(location.rel).toBe(".streamctl/config.ts");
      expect(location.source).toBe("legacy");
    });
  });
});
