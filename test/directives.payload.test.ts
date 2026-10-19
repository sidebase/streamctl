import type { ManagedFile, StreamctlConfig } from "../src/config/types";
import type { ComposeResult } from "../src/engine/compose";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { compose } from "../src/engine/compose";
import { resolvePresetChain } from "../src/engine/manifest";
import { resolvePayload } from "../src/payload/resolve";

// Schema-5 @acme/directives payload: if/else/end in a YAML workflow and its toggle
// fragment, a `#` block in a Containerfile and an HTML-comment block in Markdown.
const fixturesDir = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(fixturesDir, "fixtures/directives-payload");
const PKG = "@acme/directives";
const VERSION = "1.0.0";

const cfg = (ci: StreamctlConfig["ci"] = {}): StreamctlConfig => ({ package: PKG, base: "app", version: VERSION, profile: "std", ci });

let payloadPromise: ReturnType<typeof resolvePayload> | undefined;
function payload(): ReturnType<typeof resolvePayload> {
  payloadPromise ??= resolvePayload(pkgDir, PKG, VERSION, { resolvePackageDir: () => pkgDir });
  return payloadPromise;
}

async function fileByPath(path: string): Promise<ManagedFile> {
  const { files } = await resolvePresetChain(await payload(), "app", "std");
  const found = files.find(f => f.path === path);
  if (found === undefined) {
    throw new Error(`app did not resolve "${path}"`);
  }
  return found;
}

const workflowSchema = z.object({ jobs: z.record(z.string(), z.object({ steps: z.array(z.unknown()) })) });

function stepCounts(yaml: string): Record<string, number> {
  const { jobs } = workflowSchema.parse(parseYaml(yaml));
  return Object.fromEntries(Object.entries(jobs).map(([name, job]) => [name, job.steps.length]));
}

async function render(path: string, config: StreamctlConfig): Promise<string> {
  const result: ComposeResult = await compose(await fileByPath(path), await payload(), null, config);
  if (result.status !== "composed") {
    throw new Error(`expected composed, got ${result.status}`);
  }
  return result.targetContent;
}

describe("directives payload fixture", () => {
  it("resolves the chain", async () => {
    const { files } = await resolvePresetChain(await payload(), "app", "std");
    expect(files.map(f => f.path).sort()).toEqual([".github/workflows/pipeline.yml", "Containerfile", "NOTES.md"]);
  });

  it("renders the workflow with every condition on", async () => {
    const output = await render(".github/workflows/pipeline.yml", cfg({ cache: true, deploy: true, deployTarget: "prod", lint: true, strictLint: true }));
    expect(output).not.toContain("streamctl:");
    expect(output).toContain("actions/cache@v4");
    expect(output).not.toContain("cache disabled");
    expect(output).toContain("acme deploy --target prod");
    expect(output).toContain("acme lint --strict");
    expect(stepCounts(output)).toEqual({ build: 4, lint: 3 });
  });

  it("renders the workflow with every condition off", async () => {
    const output = await render(".github/workflows/pipeline.yml", cfg({ lint: true }));
    expect(output).not.toContain("streamctl:");
    expect(output).not.toContain("actions/cache@v4");
    expect(output).toContain("cache disabled");
    expect(output).not.toContain("acme deploy");
    expect(output).not.toContain("--strict");
    expect(stepCounts(output)).toEqual({ build: 3, lint: 2 });
  });

  it("applies # blocks in the Containerfile", async () => {
    expect(await render("Containerfile", cfg({ containerDebug: true }))).toContain("apt-get install");
    const off = await render("Containerfile", cfg());
    expect(off).not.toContain("apt-get");
    expect(off).not.toContain("streamctl:");
  });

  it("applies HTML-comment blocks in Markdown", async () => {
    expect(await render("NOTES.md", cfg({ extendedDocs: true }))).toContain("## Extended");
    expect(await render("NOTES.md", cfg())).toBe("# Notes\n\nManaged by streamctl.\n");
  });
});

describe("existing fixtures still resolve", () => {
  it("resolves synthetic-payload (schemaVersion 2)", async () => {
    const dir = resolve(fixturesDir, "fixtures/synthetic-payload");
    const synthetic = await resolvePayload(dir, "@acme/payload", "1.4.0", { resolvePackageDir: () => dir });
    const { files } = await resolvePresetChain(synthetic, "app", "std");
    expect(files.length).toBeGreaterThan(0);
  });
});
