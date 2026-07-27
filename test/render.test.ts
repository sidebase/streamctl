import type { ManagedFile, StreamctlConfig } from "../src/config/types";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { compose } from "../src/engine/compose";
import { detectDrift } from "../src/engine/drift";
import { resolvePresetChain } from "../src/engine/manifest";
import { runSync } from "../src/engine/sync";
import { resolvePayload } from "../src/payload/resolve";

// Synthetic @acme/payload. Exercises the shipped v2 manifest and preset renders end
// to end through the generic renderer (not any hardcoded kind): a join-list
// placeholder plus declared passthrough (Containerfile), and fragment toggles plus a
// version-pin placeholder (pipeline.yml). Generic engine behavior only, no framework
// payload involved.
const configPkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/synthetic-payload");
const PKG = "@acme/payload";
const VERSION = "1.4.0";

const cfg = (over: Partial<StreamctlConfig> = {}): StreamctlConfig => ({ package: PKG, base: "app", version: VERSION, profile: "std", ...over });

let payloadPromise: ReturnType<typeof resolvePayload> | undefined;
function payload(): ReturnType<typeof resolvePayload> {
  payloadPromise ??= resolvePayload(configPkgDir, PKG, VERSION, { resolvePackageDir: () => configPkgDir });
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

/** Compose a resolved managed file (renderDef-driven) to its expected bytes. */
async function render(path: string, config: StreamctlConfig): Promise<string> {
  const result = await compose(await fileByPath(path), await payload(), null, config);
  if (result.status !== "composed") {
    throw new Error(`expected composed for ${path}, got "${result.status}"`);
  }
  return result.targetContent;
}

const CONTAINER_PATH = "Containerfile";
const PIPELINE_PATH = ".github/workflows/pipeline.yml";

describe("Containerfile apt render", () => {
  it("renders an empty arg for no packages", async () => {
    expect(await render(CONTAINER_PATH, cfg())).toContain("ARG APT_PACKAGES=\"\"");
  });

  it("renders a single package", async () => {
    expect(await render(CONTAINER_PATH, cfg({ aptPackages: ["libpq-dev"] }))).toContain("ARG APT_PACKAGES=\"libpq-dev\"");
  });

  it("dedupes and sorts many packages so the output is deterministic", async () => {
    const out = await render(CONTAINER_PATH, cfg({ aptPackages: ["zlib1g", "libpq-dev", "curl", "libpq-dev"] }));
    expect(out).toContain("ARG APT_PACKAGES=\"curl libpq-dev zlib1g\"");
  });

  it("leaves the declared ${BUILD_TOKEN} build-ARG verbatim", async () => {
    expect(await render(CONTAINER_PATH, cfg())).toContain("build token: ${BUILD_TOKEN}");
  });

  it("rejects apt names with shell-meta, quotes, or a leading dash", async () => {
    // apt-get would read the leading-dash cases (`-rf`, `--privileged`) as option
    // flags. The alnum-start anchor blocks them.
    for (const bad of ["curl; rm -rf /", "lib\"injected", "$(whoami)", "pkg`id`", "-rf", "--privileged"]) {
      const error = await render(CONTAINER_PATH, cfg({ aptPackages: [bad] })).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("CONFIG_INVALID");
    }
  });
});

describe("pipeline render toggles and version pins", () => {
  it("emits only the base build job by default", async () => {
    const out = await render(PIPELINE_PATH, cfg());
    expect(out).not.toContain("  lint:");
    expect(out).not.toContain("  smoke:");
  });

  it("includes the lint job when enabled", async () => {
    const out = await render(PIPELINE_PATH, cfg({ ci: { lint: true } }));
    expect(out).toContain("  lint:");
    expect(out).toContain("- run: acme lint");
  });

  it("includes the smoke job and its service when enabled", async () => {
    const out = await render(PIPELINE_PATH, cfg({ ci: { smoke: true } }));
    expect(out).toContain("  smoke:");
    expect(out).toContain("registry:");
    expect(out).toContain("- run: acme smoke");
  });

  it("emits enabled jobs in declaration order", async () => {
    const out = await render(PIPELINE_PATH, cfg({ ci: { smoke: true, lint: true } }));
    expect(out.indexOf("  lint:")).toBeLessThan(out.indexOf("  smoke:"));
  });

  it("pins node from the baseline default and parses as valid YAML", async () => {
    const out = await render(PIPELINE_PATH, cfg());
    const doc = parseYaml(out) as { env: Record<string, string>; jobs: Record<string, unknown> };
    expect(doc.env.NODE_VERSION).toBe("20.9.0");
    expect(Object.keys(doc.jobs)).toEqual(["build"]);
  });

  it("applies a per-repo ci.nodeVersion override", async () => {
    const out = await render(PIPELINE_PATH, cfg({ ci: { nodeVersion: "22.1.0" } }));
    const doc = parseYaml(out) as { env: Record<string, string> };
    expect(doc.env.NODE_VERSION).toBe("22.1.0");
  });

  it("appended optional jobs reference the env pin, never a hardcoded version", async () => {
    const out = await render(PIPELINE_PATH, cfg({ ci: { lint: true, smoke: true } }));
    const doc = parseYaml(out) as { jobs: Record<string, unknown> };
    expect(Object.keys(doc.jobs)).toEqual(expect.arrayContaining(["build", "lint", "smoke"]));
    expect(out).not.toContain("node-version: 20.9.0");
    expect(out).toContain("node-version: ${{ env.NODE_VERSION }}");
  });

  it("a version knob violating its pattern cannot inject YAML", async () => {
    const evil = "x\"\n  injected: pwned";
    const error = await render(PIPELINE_PATH, cfg({ ci: { nodeVersion: evil } })).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("CONFIG_INVALID");
  });
});

describe("render defaults track the std baseline", () => {
  // The render placeholder default MUST equal the version-profile baseline, so the
  // shipped pipeline runs on the same versions the reconciler enforces.
  const preset = JSON.parse(
    readFileSync(join(configPkgDir, "presets/app/preset.json"), "utf8"),
  ) as {
    renders: { pipeline: { placeholders: Record<string, { default: string }> } };
    versionProfiles: { std: Record<string, string> };
  };
  const std = preset.versionProfiles.std;
  const placeholders = preset.renders.pipeline.placeholders;

  it("the pipeline NODE_VERSION default equals the engines.node floor", () => {
    const floor = std["engines.node"]!.replace(/^\D*/, ""); // ">=20.9.0" becomes "20.9.0"
    expect(placeholders.NODE_VERSION!.default).toBe(floor);
  });
});

describe("config-applied compose: drift and idempotency", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "streamctl-render-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("config-applied content is not drift, but toggling a knob is", async () => {
    const files = [await fileByPath(CONTAINER_PATH), await fileByPath(PIPELINE_PATH)];
    const config = cfg({ aptPackages: ["libpq-dev"], ci: { smoke: true } });
    await runSync({ cwd, payload: await payload(), config, managedFiles: files });

    // The raw templates lack libpq-dev and the smoke job, but with the same config
    // applied the rendered expectation matches the working tree.
    expect(await detectDrift(files, await payload(), config, cwd)).toEqual({ inSync: true, drift: [], structuralFaults: [] });
    expect(await readFile(join(cwd, "Containerfile"), "utf8")).toContain("ARG APT_PACKAGES=\"libpq-dev\"");
    expect(await readFile(join(cwd, PIPELINE_PATH), "utf8")).toContain("  smoke:");

    // A different config (smoke off) makes the rendered expectation differ.
    const toggled = cfg({ aptPackages: ["libpq-dev"], ci: { smoke: false } });
    const report = await detectDrift(files, await payload(), toggled, cwd);
    expect(report.inSync).toBe(false);
    expect(report.drift.map(d => d.path)).toEqual([PIPELINE_PATH]);
  });

  it("re-syncing the same config writes nothing", async () => {
    const files = [await fileByPath(PIPELINE_PATH)];
    const config = cfg({ ci: { smoke: true } });
    await runSync({ cwd, payload: await payload(), config, managedFiles: files });

    // Same config, so the render matches what is on disk and nothing is written.
    const again = await runSync({ cwd, payload: await payload(), config, managedFiles: files });
    expect(again.written).toEqual([]);

    // A toggle re-renders a full-owned file, which is a conflict: streamctl can't tell
    // a config change from a manual edit, so it needs --force. Forcing it rewrites
    // cleanly, and the forced result is itself idempotent.
    const toggled = cfg({ ci: { smoke: false } });
    const forced = await runSync({ cwd, payload: await payload(), config: toggled, managedFiles: files, force: true });
    expect(forced.written).toEqual([PIPELINE_PATH]);
    expect(await readFile(join(cwd, PIPELINE_PATH), "utf8")).not.toContain("  smoke:");
    const settled = await runSync({ cwd, payload: await payload(), config: toggled, managedFiles: files });
    expect(settled.written).toEqual([]);
  });
});
