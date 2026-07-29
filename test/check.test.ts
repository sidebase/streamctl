import type { StreamctlConfig } from "../src/config/types";
import type { PayloadHandle } from "../src/payload/resolve";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/engine/check";
import { StreamctlError } from "../src/errors";

const config: StreamctlConfig = { package: "@acme/payload", base: "base", version: "1.0.0", profile: "nuxt-4" };

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
    if (content === undefined) {
      throw new Error(`missing fixture source: ${source}`);
    }
    return content;
  },
  async list() {
    return ["manifest.json"];
  },
};

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "streamctl-check-"));
  // Bound the lockfile walk inside the fixture (see test/pm.test.ts). Without it a
  // stray lockfile above the tmpdir leaks in and flags a false stale-lockfile.
  await mkdir(join(cwd, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("runCheck", () => {
  it("reports in sync when the tree matches", async () => {
    await writeFile(join(cwd, ".editorconfig"), "root = true\n");
    const result = await runCheck(cwd, payload, config);
    expect(result).toEqual({ inSync: true, drift: [], structuralFaults: [], versionSkew: [] });
  });

  it("throws DRIFT_DETECTED with the check result attached", async () => {
    await writeFile(join(cwd, ".editorconfig"), "root = false\n");
    const error = await runCheck(cwd, payload, config).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("DRIFT_DETECTED");
    const details = (error as StreamctlError).details as { inSync: boolean; drift: { path: string; kind: string }[] };
    expect(details.inSync).toBe(false);
    expect(details.drift).toEqual([{ path: ".editorconfig", kind: "content" }]);
  });

  it("does not throw on drift when failOn is outdated only", async () => {
    await writeFile(join(cwd, ".editorconfig"), "root = false\n");
    const result = await runCheck(cwd, payload, config, "outdated", { latestProbe: async () => null });
    expect(result.inSync).toBe(false);
    expect(result.drift).toEqual([{ path: ".editorconfig", kind: "content" }]);
  });
});

/** A v2 payload (manifest.json present) whose `nuxt-3` profile detects `nuxt` major 3. */
const v2Payload: PayloadHandle = {
  version: "2.0.0",
  async read(source) {
    const entries: Record<string, string> = {
      "manifest.json": JSON.stringify({
        schemaVersion: 2,
        presets: ["base"],
        // Both declared: the soft detect-mismatch warning is about a profile the
        // payload DOES declare but detection disagrees with ("valid but probably
        // wrong"). An undeclared profile is the separate hard CONFIG_INVALID.
        profiles: [
          { name: "nuxt-3", detect: { dependency: "nuxt", majorIs: 3 } },
          { name: "nuxt-4", detect: { dependency: "nuxt", majorIs: 4 } },
        ],
        defaultBase: "base",
      }),
      "base/preset.json": JSON.stringify({
        name: "base",
        files: [{ path: ".editorconfig", strategy: "full", source: "base/editorconfig" }],
      }),
      "base/editorconfig": "root = true\n",
    };
    const content = entries[source];
    if (content === undefined) {
      throw new Error(`missing fixture source: ${source}`);
    }
    return content;
  },
  async list() {
    return ["manifest.json", "base/preset.json", "base/editorconfig"];
  },
};

/** A v2 payload declaring configKeys, for stage-2 config validation. */
const configKeysPayload: PayloadHandle = {
  version: "2.0.0",
  async read(source) {
    const entries: Record<string, string> = {
      "manifest.json": JSON.stringify({ schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" }),
      "base/preset.json": JSON.stringify({
        name: "base",
        files: [{ path: ".editorconfig", strategy: "full", source: "base/editorconfig" }],
        configKeys: { "ci.unitTests": "boolean" },
      }),
      "base/editorconfig": "root = true\n",
    };
    const content = entries[source];
    if (content === undefined) {
      throw new Error(`missing fixture source: ${source}`);
    }
    return content;
  },
  async list() {
    return ["manifest.json", "base/preset.json", "base/editorconfig"];
  },
};

describe("runCheck stage-2 config validation", () => {
  it("rejects a knob that violates its declared shape", async () => {
    await writeFile(join(cwd, ".editorconfig"), "root = true\n");
    const badConfig = { ...config, ci: { unitTests: "yes" } } as typeof config;

    const error = await runCheck(cwd, configKeysPayload, badConfig).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    const details = (error as StreamctlError).details as { issues: { path: string; message: string }[] };
    expect(details.issues).toEqual([{ path: "ci.unitTests", message: "expected boolean, got string" }]);
  });
});

describe("runCheck profile-mismatch warning", () => {
  it("warns when detection disagrees with config.profile, but stays in sync", async () => {
    await writeFile(join(cwd, ".editorconfig"), "root = true\n");
    // config pins nuxt-4 but the project depends on nuxt 3, so detection says nuxt-3.
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "app", devDependencies: { nuxt: "^3.0.0" } }));
    const warnings: string[] = [];

    const result = await runCheck(cwd, v2Payload, config, "drift", { logger: { warn: m => warnings.push(m) } });

    expect(result.inSync).toBe(true);
    expect(warnings.some(w => w.includes("does not match") && w.includes("nuxt-3"))).toBe(true);
  });

  it("stays silent when they agree", async () => {
    await writeFile(join(cwd, ".editorconfig"), "root = true\n");
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "app", devDependencies: { nuxt: "^3.0.0" } }));
    const warnings: string[] = [];

    await runCheck(cwd, v2Payload, { ...config, profile: "nuxt-3" }, "drift", { logger: { warn: m => warnings.push(m) } });

    expect(warnings).toEqual([]);
  });
});

/** A v2 payload whose `nuxt-4` baseline reconciles `engines.node` (drives version skew). */
const reconcilePayload: PayloadHandle = {
  version: "1.0.0",
  async read(source) {
    const entries: Record<string, string> = {
      "manifest.json": JSON.stringify({ schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" }),
      "base/preset.json": JSON.stringify({
        name: "base",
        files: [{ path: ".editorconfig", strategy: "full", source: "base/editorconfig" }],
        versionProfiles: { "nuxt-4": { "engines.node": ">=24.13.0" } },
      }),
      "base/editorconfig": "root = true\n",
    };
    const content = entries[source];
    if (content === undefined) {
      throw new Error(`missing fixture source: ${source}`);
    }
    return content;
  },
  async list() {
    return ["manifest.json", "base/preset.json", "base/editorconfig"];
  },
};

describe("runCheck lockfileStale flag", () => {
  const skewedPkg = JSON.stringify({ name: "app", engines: { node: ">=20.0.0" } });

  it("is true when reconcile drift exists and a lockfile is present", async () => {
    await writeFile(join(cwd, ".editorconfig"), "root = true\n"); // no file drift
    await writeFile(join(cwd, "package.json"), skewedPkg);
    await writeFile(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9\n");

    const error = await runCheck(cwd, reconcilePayload, config).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("DRIFT_DETECTED");
    const details = (error as StreamctlError).details as { versionSkew: unknown[]; lockfileStale?: boolean };
    expect(details.versionSkew.length).toBe(1);
    expect(details.lockfileStale).toBe(true);
  });

  it("does not flag reconcile drift when no lockfile exists", async () => {
    await writeFile(join(cwd, ".editorconfig"), "root = true\n");
    await writeFile(join(cwd, "package.json"), skewedPkg);

    const error = await runCheck(cwd, reconcilePayload, config).catch((e: unknown) => e);
    const details = (error as StreamctlError).details as { lockfileStale?: boolean };
    expect(details.lockfileStale).toBeFalsy();
  });
});
