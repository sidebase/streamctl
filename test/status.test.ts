import type { ManagedFile, StreamctlConfig } from "../src/config/types";
import type { FileState } from "../src/engine/status";
import type { PayloadHandle } from "../src/payload/resolve";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectDrift } from "../src/engine/drift";
import { resolvePresetChain } from "../src/engine/manifest";
import { runStatus } from "../src/engine/status";
import { runSync } from "../src/engine/sync";
import { StreamctlError } from "../src/errors";

function BLOCK(registry: string): string {
  return `# BEGIN streamctl MANAGED BLOCK registry\nregistry=${registry}\n# END streamctl MANAGED BLOCK registry\n`;
}

/** One file per strategy plus a gated one, so a single preset can hit every state. */
const SOURCES: Record<string, string> = {
  "manifest.json": JSON.stringify({ schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" }),
  "base/preset.json": JSON.stringify({
    name: "base",
    files: [
      { path: ".editorconfig", strategy: "full", source: "base/editorconfig" },
      { path: ".npmrc", strategy: "block", source: "base/npmrc", blockMark: "registry" },
      { path: "Makefile", strategy: "full", source: "base/makefile" },
      { path: "LICENSE", strategy: "full", source: "base/license" },
      { path: "eslint.config.ts", strategy: "scaffold", source: "base/eslint" },
      { path: ".gitignore", strategy: "full", source: "base/gitignore", enabledBy: "ci.unitTests" },
      { path: "tsconfig.json", strategy: "full", source: "base/tsconfig" },
      { path: ".prettierrc", strategy: "full", source: "base/prettier" },
    ],
    versionProfiles: { "nuxt-4": { "engines.node": ">=24.13.0" } },
    configKeys: { "ci.unitTests": "boolean" },
  }),
  "base/editorconfig": "root = true\n",
  "base/npmrc": "registry=https://example\n",
  "base/makefile": "all:\n\techo hi\n",
  "base/license": "MIT\n",
  "base/eslint": "export default 1\n",
  "base/gitignore": "node_modules\n",
  "base/tsconfig": "{ not valid json", // composes to a structural fault
  "base/prettier": "{}\n",
};

const payload: PayloadHandle = {
  version: "1.0.0",
  async read(source) {
    const content = SOURCES[source];
    if (content === undefined) {
      throw new Error(`missing fixture source: ${source}`);
    }
    return content;
  },
  async list() {
    return Object.keys(SOURCES).sort();
  },
};

const config: StreamctlConfig = {
  package: "@acme/payload",
  base: "base",
  version: "1.0.0",
  profile: "nuxt-4",
  files: { ".prettierrc": "off" },
};

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "streamctl-status-"));
  // Bounds the lockfile walk inside the fixture (see test/pm.test.ts). Without it a
  // stray lockfile above the tmpdir leaks in and we report a false stale-lockfile.
  await mkdir(join(cwd, ".git"), { recursive: true });
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function stateOf(): Promise<Record<string, FileState>> {
  const result = await runStatus(cwd, payload, config, { cliVersion: "9.9.9" });
  return Object.fromEntries(result.files.map(f => [f.path, f.state]));
}

describe("runStatus state matrix", () => {
  it("classifies every state value from one fixture tree", async () => {
    await writeFile(join(cwd, ".editorconfig"), "root = true\n"); // matches, in-sync
    await writeFile(join(cwd, ".npmrc"), BLOCK("https://evil")); // owned region differs: drift
    await writeFile(join(cwd, "Makefile"), "all:\n\techo DIFFERENT\n"); // full differs: conflict
    // LICENSE absent, so missing
    await writeFile(join(cwd, "eslint.config.ts"), "export default localOverride()\n"); // scaffold present
    // .gitignore is gated by ci.unitTests, which is unset: disabled
    // tsconfig.json template is invalid JSON: fault
    // .prettierrc is turned off via files

    const states = await stateOf();
    expect(states).toEqual({
      ".editorconfig": "in-sync",
      ".npmrc": "drift",
      "Makefile": "conflict",
      "LICENSE": "missing",
      "eslint.config.ts": "scaffolded",
      ".gitignore": "disabled",
      "tsconfig.json": "fault",
      ".prettierrc": "off",
    });
  });

  it("reports a scaffold that was never written as `missing`", async () => {
    const states = await stateOf();
    expect(states["eslint.config.ts"]).toBe("missing");
  });

  it("carries the package summary", async () => {
    const result = await runStatus(cwd, payload, config, { cliVersion: "9.9.9" });
    expect(result.payload).toEqual({ package: "@acme/payload", pinned: "1.0.0", installed: "1.0.0" });
    expect(result.profile).toBe("nuxt-4");
    expect(result.cliVersion).toBe("9.9.9");
    expect(result.files.every(f => ["full", "block", "scaffold", "merge"].includes(f.strategy))).toBe(true);
  });

  it("flags lockfileStale when package.json would change and a lockfile is present", async () => {
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "app", engines: { node: ">=20.0.0" } }));
    await writeFile(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const result = await runStatus(cwd, payload, config, { cliVersion: "9.9.9" });
    expect(result.lockfileStale).toBe(true);
  });

  it("does not flag lockfileStale without a lockfile", async () => {
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "app", engines: { node: ">=20.0.0" } }));
    const result = await runStatus(cwd, payload, config, { cliVersion: "9.9.9" });
    expect(result.lockfileStale).toBe(false);
  });
});

describe("runStatus --outdated probe", () => {
  it("includes `latest` when the probe reports a newer release", async () => {
    const result = await runStatus(cwd, payload, config, { cliVersion: "9.9.9", outdated: true, latestProbe: async () => "2.0.0" });
    expect(result.payload.latest).toBe("2.0.0");
  });

  it("swallows a throwing probe instead of rejecting; status stays usable offline", async () => {
    const result = await runStatus(cwd, payload, config, {
      cliVersion: "9.9.9",
      outdated: true,
      latestProbe: async () => {
        throw new Error("offline");
      },
    });
    expect(result.payload.latest).toBeUndefined();
  });

  it("does not probe at all without --outdated", async () => {
    let called = false;
    const result = await runStatus(cwd, payload, config, {
      cliVersion: "9.9.9",
      latestProbe: async () => {
        called = true;
        return "2.0.0";
      },
    });
    expect(called).toBe(false);
    expect(result.payload.latest).toBeUndefined();
  });

  it("throws CONFIG_INVALID rather than reporting a degraded status", async () => {
    const badConfig = { ...config, ci: { unitTests: "yes" } } as unknown as StreamctlConfig;
    const error = await runStatus(cwd, payload, badConfig, { cliVersion: "9.9.9" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
  });
});

// One consumer repo, three commands: the whole point of threading the dependency map
// through `compose` is that sync, check and status can never disagree about the bytes.
describe("dependency-derived render across sync, check and status", () => {
  const V3_SOURCES: Record<string, string> = {
    "manifest.json": JSON.stringify({ schemaVersion: 3, presets: ["base"], profiles: [], defaultBase: "base" }),
    "base/preset.json": JSON.stringify({
      name: "base",
      files: [{ path: "Dockerfile", strategy: "full", source: "base/Dockerfile", render: "dockerfile" }],
      renders: {
        dockerfile: { placeholders: { PRISMA: { configPath: "docker.prismaVersion", fromDependency: "prisma", default: "6.19.1" } } },
      },
      configKeys: { "docker.prismaVersion": "string" },
    }),
    "base/Dockerfile": "ARG PRISMA_VERSION=${PRISMA}\n",
  };

  const v3Payload: PayloadHandle = {
    version: "1.0.0",
    async read(source) {
      const content = V3_SOURCES[source];
      if (content === undefined) {
        throw new Error(`missing fixture source: ${source}`);
      }
      return content;
    },
    async list() {
      return Object.keys(V3_SOURCES).sort();
    },
  };

  const v3Config: StreamctlConfig = { package: "@acme/payload", base: "base", version: "1.0.0", profile: "nuxt-4" };

  async function pinPrisma(spec: string): Promise<void> {
    await writeFile(join(cwd, "package.json"), `${JSON.stringify({ name: "consumer", devDependencies: { prisma: spec } }, null, 2)}\n`);
  }

  async function managedFiles(): Promise<ManagedFile[]> {
    return (await resolvePresetChain(v3Payload, "base", "nuxt-4")).files;
  }

  it("all three commands see the same derived bytes", async () => {
    await pinPrisma("^6.19.3");
    const files = await managedFiles();

    const result = await runSync({ cwd, payload: v3Payload, config: v3Config, managedFiles: files });
    expect(result.written).toEqual(["Dockerfile"]);
    expect(await readFile(join(cwd, "Dockerfile"), "utf8")).toBe("ARG PRISMA_VERSION=6.19.3\n");
    expect(await detectDrift(files, v3Payload, v3Config, cwd)).toEqual({ inSync: true, drift: [], structuralFaults: [] });

    const status = await runStatus(cwd, v3Payload, v3Config, { cliVersion: "9.9.9" });
    expect(status.files).toEqual([{ path: "Dockerfile", strategy: "full", state: "in-sync" }]);
  });

  it("a pin bump drifts in check and status until sync re-renders", async () => {
    await pinPrisma("^6.19.3");
    const files = await managedFiles();
    await runSync({ cwd, payload: v3Payload, config: v3Config, managedFiles: files });

    await pinPrisma("^6.20.1");
    expect((await detectDrift(files, v3Payload, v3Config, cwd)).drift).toEqual([{ path: "Dockerfile", kind: "content" }]);
    const status = await runStatus(cwd, v3Payload, v3Config, { cliVersion: "9.9.9" });
    expect(status.files).toEqual([{ path: "Dockerfile", strategy: "full", state: "conflict" }]);

    await runSync({ cwd, payload: v3Payload, config: v3Config, managedFiles: files, force: true });
    expect(await readFile(join(cwd, "Dockerfile"), "utf8")).toBe("ARG PRISMA_VERSION=6.20.1\n");
    expect(await detectDrift(files, v3Payload, v3Config, cwd)).toEqual({ inSync: true, drift: [], structuralFaults: [] });
  });

  it("renders the default in a repo with no package.json at all", async () => {
    const files = await managedFiles();
    await runSync({ cwd, payload: v3Payload, config: v3Config, managedFiles: files });
    expect(await readFile(join(cwd, "Dockerfile"), "utf8")).toBe("ARG PRISMA_VERSION=6.19.1\n");
    const status = await runStatus(cwd, v3Payload, v3Config, { cliVersion: "9.9.9" });
    expect(status.files).toEqual([{ path: "Dockerfile", strategy: "full", state: "in-sync" }]);
  });
});
