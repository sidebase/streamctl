import type { ManagedFile, StreamctlConfig } from "../src/config/types";
import type { PayloadHandle } from "../src/payload/resolve";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectDrift } from "../src/engine/drift";

const config: StreamctlConfig = { package: "@acme/payload", base: "nuxt-app", version: "1.0.0", profile: "nuxt-4" };

const payload: PayloadHandle = {
  version: "1.0.0",
  async read(source) {
    const files: Record<string, string> = {
      "base/editorconfig": "root = true\n",
      "base/npmrc": "registry=https://example\n",
      "base/settings.json": "{ \"a\": 1, \"b\": 2 }\n",
      "nuxt-app/eslint.config.ts": "export default createStreamctlEslint()\n",
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

const FULL: ManagedFile = { path: ".editorconfig", strategy: "full", source: "base/editorconfig" };
const BLOCK: ManagedFile = { path: ".npmrc", strategy: "block", source: "base/npmrc", blockMark: "registry" };
const JSON_FULL: ManagedFile = { path: "settings.json", strategy: "full", source: "base/settings.json" };
const SCAFFOLD: ManagedFile = { path: "eslint.config.ts", strategy: "scaffold", source: "nuxt-app/eslint.config.ts" };

const BLOCK_INSYNC = "always-auth=true\n# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://example\n# END streamctl MANAGED BLOCK registry\n";

let root: string;

async function write(path: string, content: string): Promise<void> {
  const abs = join(root, path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "streamctl-drift-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("detectDrift", () => {
  it("reports in-sync when full and block files match the payload", async () => {
    await write(".editorconfig", "root = true\n");
    await write(".npmrc", BLOCK_INSYNC);
    const report = await detectDrift([FULL, BLOCK], payload, config, root);
    expect(report).toEqual({ inSync: true, drift: [], structuralFaults: [] });
  });

  it("flags full content drift", async () => {
    await write(".editorconfig", "root = false\n");
    const report = await detectDrift([FULL], payload, config, root);
    expect(report.inSync).toBe(false);
    expect(report.drift).toEqual([{ path: ".editorconfig", kind: "content" }]);
  });

  it("flags a missing managed file", async () => {
    const report = await detectDrift([FULL], payload, config, root);
    expect(report.drift).toEqual([{ path: ".editorconfig", kind: "missing" }]);
  });

  it("flags drift inside a block region", async () => {
    await write(".npmrc", BLOCK_INSYNC.replace("https://example", "https://hacked"));
    const report = await detectDrift([BLOCK], payload, config, root);
    expect(report.drift).toEqual([{ path: ".npmrc", kind: "content" }]);
  });

  it("ignores edits outside the block region", async () => {
    await write(".npmrc", BLOCK_INSYNC.replace("always-auth=true", "always-auth=false\nextra=1"));
    const report = await detectDrift([BLOCK], payload, config, root);
    expect(report).toEqual({ inSync: true, drift: [], structuralFaults: [] });
  });

  it("classifies duplicated markers as an extra conflict", async () => {
    const dup = `${BLOCK_INSYNC}# BEGIN streamctl MANAGED BLOCK registry\nx\n# END streamctl MANAGED BLOCK registry\n`;
    await write(".npmrc", dup);
    const report = await detectDrift([BLOCK], payload, config, root);
    expect(report.drift).toHaveLength(1);
    expect(report.drift[0]).toMatchObject({ path: ".npmrc", kind: "extra" });
    expect(report.drift[0]?.reason).toContain("registry");
  });

  it("ignores cosmetic JSONC differences: key order, comments, whitespace", async () => {
    await write("settings.json", "{\n  \"b\": 2, /* note */\n  \"a\":    1\n}\n");
    const report = await detectDrift([JSON_FULL], payload, config, root);
    expect(report).toEqual({ inSync: true, drift: [], structuralFaults: [] });
  });

  it("a trailing comma is valid JSONC, not drift", async () => {
    await write("settings.json", "{ \"a\": 1, \"b\": 2, }\n");
    const report = await detectDrift([JSON_FULL], payload, config, root);
    expect(report).toEqual({ inSync: true, drift: [], structuralFaults: [] });
  });

  it("excludes scaffold files from the report even when they differ", async () => {
    await write("eslint.config.ts", "export default somethingLocal()\n");
    const report = await detectDrift([SCAFFOLD], payload, config, root);
    expect(report).toEqual({ inSync: true, drift: [], structuralFaults: [] });
  });

  it("skips files opted out with files: off", async () => {
    await write(".editorconfig", "root = false\n");
    const report = await detectDrift([FULL], payload, { ...config, files: { ".editorconfig": "off" } }, root);
    expect(report).toEqual({ inSync: true, drift: [], structuralFaults: [] });
  });
});
