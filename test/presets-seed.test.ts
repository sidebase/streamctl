import type { StreamctlConfig } from "../src/config/types";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/engine/check";
import { resolvePresetChain } from "../src/engine/manifest";
import { isFileEnabled } from "../src/engine/render";
import { runSync } from "../src/engine/sync";
import { resolvePayload } from "../src/payload/resolve";

// Point the resolver at the synthetic @acme/payload fixture so the test exercises the
// actual seeded presets and v2 manifest (package.json version 1.4.0). The chain is
// deliberately generic (base + app) and covers full/block/merge/scaffold strategies.
const configPkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/synthetic-payload");
const config: StreamctlConfig = { package: "@acme/payload", base: "app", version: "1.4.0", profile: "std" };

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "streamctl-seed-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function payload() {
  return resolvePayload(cwd, "@acme/payload", "1.4.0", { resolvePackageDir: () => configPkgDir });
}

describe("seeded presets", () => {
  it("resolves app including base's files exactly once", async () => {
    const files = (await resolvePresetChain(await payload(), "app", "std")).files;
    const paths = files.map(f => f.path);

    expect(paths).toContain(".editorconfig");
    expect(paths).toContain(".acmerc");
    expect(paths).toContain(".vscode/settings.json");
    expect(paths).toContain("AGENTS.md");
    expect(paths).toContain("NOTES.md");
    // from the app preset itself
    expect(paths).toContain("acme.config.ts");
    expect(paths).toContain("Containerfile");
    expect(paths).toContain(".github/workflows/pipeline.yml");

    expect(new Set(paths).size).toBe(paths.length);
  });

  it("a seed sync writes every managed file and leaves check in-sync", async () => {
    const files = (await resolvePresetChain(await payload(), "app", "std")).files;
    const result = await runSync({ cwd, payload: await payload(), config, managedFiles: files });

    expect(result.conflicted).toEqual([]);
    // `enabledBy`-gated files (e.g. the opt-in acme-upgrade workflow) are excluded
    // from the plan under the default config, so a seed sync writes only the enabled set.
    expect(result.written.sort()).toEqual(files.filter(f => isFileEnabled(f, config)).map(f => f.path).sort());

    // full: verbatim payload
    expect(await readFile(join(cwd, ".editorconfig"), "utf8")).toContain("root = true");
    // block: markers present around the region
    expect(await readFile(join(cwd, ".acmerc"), "utf8")).toContain("# BEGIN streamctl MANAGED BLOCK core");
    // merge (structured): payload keys land, and no managed-block markers leak in
    const settings = await readFile(join(cwd, ".vscode/settings.json"), "utf8");
    expect(settings).toContain("\"editor.formatOnSave\"");
    expect(settings).not.toContain("MANAGED BLOCK");
    // scaffold: imports the payload factory from the subpath
    expect(await readFile(join(cwd, "acme.config.ts"), "utf8")).toContain("@acme/payload/config");
    expect(await readFile(join(cwd, "NOTES.md"), "utf8")).toContain("Scaffolded once by streamctl");

    const check = await runCheck(cwd, await payload(), config);
    expect(check).toEqual({ inSync: true, drift: [], structuralFaults: [], versionSkew: [] });
  });

  it("a second sync leaves an edited scaffold wrapper alone", async () => {
    const files = (await resolvePresetChain(await payload(), "app", "std")).files;
    await runSync({ cwd, payload: await payload(), config, managedFiles: files });

    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(cwd, "acme.config.ts"), "import x from 'local'\nexport default x\n");

    const second = await runSync({ cwd, payload: await payload(), config, managedFiles: files });
    expect(second.written).toEqual([]);
    expect(await readFile(join(cwd, "acme.config.ts"), "utf8")).toContain("local");
  });
});
