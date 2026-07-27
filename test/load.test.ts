import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStreamctlConfig } from "../src/config/load";
import { StreamctlError } from "../src/errors";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("loadStreamctlConfig", () => {
  it("loads and validates a valid config", async () => {
    const config = await loadStreamctlConfig(join(fixtures, "valid"));
    expect(config.base).toBe("nuxt-app");
    expect(config.version).toBe("1.2.3");
    expect(config.profile).toBe("n4");
    expect(config.versionSyncExclude).toEqual(["devDependencies.typescript"]);
  });

  it("NOT_INITIALIZED when the config is absent", async () => {
    const error = await loadStreamctlConfig(join(fixtures, "uninitialized")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("NOT_INITIALIZED");
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
    const config = await loadStreamctlConfig(join(fixtures, "unknown-key"));
    expect(config.base).toBe("nuxt-app");
    expect((config as Record<string, unknown>).foo).toBe(true);
  });

  it("rejects a bad versionSyncExclude entry", async () => {
    const error = await loadStreamctlConfig(join(fixtures, "bad-exclude")).catch((e: unknown) => e);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).toContain("versionSyncExclude");
  });
});
