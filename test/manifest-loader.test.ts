import type { PayloadHandle } from "../src/payload/resolve";
import { describe, expect, it } from "vitest";
import { loadPayloadManifest, resolvePresetChain } from "../src/engine/manifest";
import { StreamctlError } from "../src/errors";

/** Fake payload whose `presets/` tree is the given source-to-content map. Object values get JSON-encoded. */
function payloadOf(files: Record<string, unknown>): PayloadHandle {
  return {
    version: "2.0.0",
    async read(source) {
      if (!(source in files)) {
        throw new Error(`missing fixture source: ${source}`);
      }
      const value = files[source];
      return typeof value === "string" ? value : JSON.stringify(value);
    },
    async list() {
      return Object.keys(files).sort();
    },
  };
}

/** Valid two-preset v2 payload: nuxt-app extends base, both carry renders and configKeys. */
function validPayload(): PayloadHandle {
  return payloadOf({
    "manifest.json": { schemaVersion: 2, presets: ["base", "nuxt-app"], profiles: [{ name: "nuxt-4", detect: { dependency: "nuxt", majorIs: 4 } }], defaultBase: "nuxt-app" },
    "base/preset.json": {
      name: "base",
      files: [
        { path: ".editorconfig", strategy: "full", source: "base/editorconfig" },
        { path: "Dockerfile", strategy: "full", source: "base/Dockerfile", render: "dockerfile" },
      ],
      versionProfiles: { "nuxt-4": { "engines.node": ">=24.13.0" } },
      renders: { dockerfile: { placeholders: { APT: { configPath: "aptPackages", default: "" } } } },
      configKeys: { aptPackages: "string[]" },
    },
    "nuxt-app/preset.json": {
      name: "nuxt-app",
      extends: ["base"],
      files: [
        { path: "eslint.config.ts", strategy: "scaffold", source: "nuxt-app/eslint.config.ts" },
        { path: ".github/workflows/ci.yaml", strategy: "full", source: "nuxt-app/ci.yaml", render: "ci", enabledBy: "ci.unitTests" },
      ],
      versionProfiles: { "nuxt-4": { "devDependencies.nuxt": "^4.3.0" } },
      renders: { ci: { fragments: [{ toggle: "ci.unitTests", source: "nuxt-app/test.job" }] } },
      configKeys: { ci: "object" },
    },
  });
}

async function caught(promise: Promise<unknown>): Promise<StreamctlError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(StreamctlError);
  return error as StreamctlError;
}

describe("loadPayloadManifest", () => {
  it("returns the validated manifest", async () => {
    const manifest = await loadPayloadManifest(validPayload());
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.presets).toEqual(["base", "nuxt-app"]);
    expect(manifest.defaultBase).toBe("nuxt-app");
    expect(manifest.profiles[0]?.detect).toEqual({ dependency: "nuxt", majorIs: 4 });
  });

  it("tells the user what to look at when manifest.json is absent", async () => {
    const payload = payloadOf({ "base/preset.json": { name: "base", files: [] } });
    const error = await caught(loadPayloadManifest(payload));
    expect(error.code).toBe("PAYLOAD_INVALID");
    expect(error.message).toContain("presets/manifest.json");
    expect(error.message).toContain("is this a streamctl payload?");
  });

  it("rejects a manifest.json that isn't JSON", async () => {
    const payload = payloadOf({ "manifest.json": "{ not json" });
    const error = await caught(loadPayloadManifest(payload));
    expect(error.code).toBe("PAYLOAD_INVALID");
    expect(error.message).toContain("not valid JSON");
  });
});

describe("schemaVersion contract", () => {
  // v2 is still accepted: the CLI supports a set, not a single version.
  it("accepts a v3 payload", async () => {
    const payload = payloadOf({ "manifest.json": { schemaVersion: 3, presets: ["base"], profiles: [], defaultBase: "base" } });
    const manifest = await loadPayloadManifest(payload);
    expect(manifest.schemaVersion).toBe(3);
  });

  // Checked ahead of zod so the user sees both version numbers instead of a refinement issue.
  it("names the payload's version and ours when they disagree", async () => {
    const payload = payloadOf({ "manifest.json": { schemaVersion: 4, presets: ["base"], profiles: [], defaultBase: "base" } });
    const error = await caught(loadPayloadManifest(payload));
    expect(error.code).toBe("SCHEMA_UNSUPPORTED");
    expect(error.message).toContain("schemaVersion 4");
    expect(error.message).toContain("schemaVersion 2, 3");
    expect(error.message).toContain("Upgrade the CLI or the payload");
    expect(error.details).toMatchObject({ found: 4, supported: [2, 3] });
  });

  it("surfaces through resolvePresetChain too", async () => {
    const payload = payloadOf({ "manifest.json": { schemaVersion: 4, presets: ["base"], profiles: [], defaultBase: "base" } });
    const error = await caught(resolvePresetChain(payload, "base", "nuxt-4"));
    expect(error.code).toBe("SCHEMA_UNSUPPORTED");
  });
});

describe("fromDependency feature gate", () => {
  /** Single-preset payload whose dockerfile render derives a placeholder from the prisma pin. */
  function withFromDependency(schemaVersion: number): PayloadHandle {
    return payloadOf({
      "manifest.json": { schemaVersion, presets: ["base"], profiles: [], defaultBase: "base" },
      "base/preset.json": {
        name: "base",
        files: [{ path: "Dockerfile", strategy: "full", source: "Dockerfile", render: "dockerfile" }],
        renders: {
          dockerfile: {
            placeholders: {
              PRISMA_VERSION_DEFAULT: { configPath: "docker.prismaVersion", fromDependency: "prisma", default: "6.19.1" },
            },
          },
        },
        configKeys: { "docker.prismaVersion": "string" },
      },
    });
  }

  it("lets a v3 payload declare it", async () => {
    const { files } = await resolvePresetChain(withFromDependency(3), "base", "nuxt-4");
    expect(files.find(f => f.path === "Dockerfile")?.renderDef?.placeholders?.PRISMA_VERSION_DEFAULT?.fromDependency).toBe("prisma");
  });

  // zod strictness only protects an OLD CLI; this CLI must refuse the key itself, or a
  // forgotten schemaVersion bump ships a payload that breaks every 0.2.x repo.
  it("refuses it under a v2 payload, naming the placeholder and the version it needs", async () => {
    const error = await caught(resolvePresetChain(withFromDependency(2), "base", "nuxt-4"));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("PRISMA_VERSION_DEFAULT");
    expect(error.message).toContain("fromDependency");
    expect(error.message).toContain("requires schemaVersion 3");
    expect(error.details).toMatchObject({ file: "presets/base/preset.json", render: "dockerfile", placeholder: "PRISMA_VERSION_DEFAULT" });
  });

  it("leaves a v2 payload without the key alone", async () => {
    const manifest = await loadPayloadManifest(validPayload());
    expect(manifest.schemaVersion).toBe(2);
    const { files } = await resolvePresetChain(validPayload(), "nuxt-app", "nuxt-4");
    expect(files.length).toBeGreaterThan(0);
  });
});

describe("resolvePresetChain (v2 payload)", () => {
  it("walks the extends chain parents-first and merges the baseline", async () => {
    const { files, baseline } = await resolvePresetChain(validPayload(), "nuxt-app", "nuxt-4");
    expect(files.map(f => f.path)).toEqual([".editorconfig", "Dockerfile", "eslint.config.ts", ".github/workflows/ci.yaml"]);
    // Each render key must resolve to the merged RenderDef, not the bare key.
    expect(files.find(f => f.path === "Dockerfile")?.renderDef).toEqual({ placeholders: { APT: { configPath: "aptPackages", default: "" } } });
    expect(files.find(f => f.path === ".github/workflows/ci.yaml")?.renderDef).toEqual({ fragments: [{ toggle: "ci.unitTests", source: "nuxt-app/test.job" }] });
    expect(baseline).toEqual({ "engines.node": ">=24.13.0", "devDependencies.nuxt": "^4.3.0" });
  });

  it("resolves a preset with no parents", async () => {
    const { files } = await resolvePresetChain(validPayload(), "base", "nuxt-4");
    expect(files.map(f => f.path)).toEqual([".editorconfig", "Dockerfile"]);
  });

  it("threads `adoption` through to the engine's managed file", async () => {
    const payload = payloadOf({
      "manifest.json": { schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" },
      "base/preset.json": { name: "base", files: [{ path: "tsconfig.json", strategy: "full", source: "tsconfig", adoption: "expected" }] },
    });
    const { files } = await resolvePresetChain(payload, "base", "nuxt-4");
    expect(files.find(f => f.path === "tsconfig.json")?.adoption).toBe("expected");
  });

  it("threads `shadowedBy` through as well", async () => {
    const payload = payloadOf({
      "manifest.json": { schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" },
      "base/preset.json": { name: "base", files: [{ path: "eslint.config.ts", strategy: "scaffold", source: "eslint", shadowedBy: ["eslint.config.mjs", "eslint.config.js"] }] },
    });
    const { files } = await resolvePresetChain(payload, "base", "nuxt-4");
    expect(files.find(f => f.path === "eslint.config.ts")?.shadowedBy).toEqual(["eslint.config.mjs", "eslint.config.js"]);
  });

  it("merges configKeys across the chain, child wins", async () => {
    const { configKeys } = await resolvePresetChain(validPayload(), "nuxt-app", "nuxt-4");
    expect(configKeys).toEqual({ aptPackages: "string[]", ci: "object" });
  });

  it("returns {} when nothing in the chain declares configKeys", async () => {
    const payload = payloadOf({
      "manifest.json": { schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" },
      "base/preset.json": { name: "base", files: [{ path: ".x", strategy: "full", source: "x" }] },
    });
    const { configKeys } = await resolvePresetChain(payload, "base", "nuxt-4");
    expect(configKeys).toEqual({});
  });

  it("a dot-path configKey satisfies the render-ref cross-check", async () => {
    // Declaring `ci.unitTests` also declares the `ci` namespace, so the fragment toggle resolves.
    const payload = payloadOf({
      "manifest.json": { schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" },
      "base/preset.json": {
        name: "base",
        files: [{ path: ".github/workflows/ci.yaml", strategy: "full", source: "ci.yaml", render: "ci", enabledBy: "ci.unitTests" }],
        renders: { ci: { fragments: [{ toggle: "ci.unitTests", source: "test.job" }] } },
        configKeys: { "ci.unitTests": "boolean" },
      },
    });
    const { configKeys } = await resolvePresetChain(payload, "base", "nuxt-4");
    expect(configKeys).toEqual({ "ci.unitTests": "boolean" });
  });

  // Matching only the root namespace let a typo in the leaf through. The file then
  // evaluated an undeclared config path, stayed disabled, and no config could enable it.
  it("rejects an enabledBy that only matches the declared namespace, not the key", async () => {
    const payload = payloadOf({
      "manifest.json": { schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" },
      "base/preset.json": {
        name: "base",
        files: [{ path: ".github/workflows/upgrade.yaml", strategy: "full", source: "upgrade.yaml", enabledBy: "ci.upgradePr" }],
        configKeys: { "ci.upgradePR": "boolean" },
      },
    });
    const error = await caught(resolvePresetChain(payload, "base", "nuxt-4"));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("ci.upgradePr");
    expect(error.message).toContain("ci.upgradePR"); // names what IS declared
  });

  // `object` is the one declared type with addressable children, so descending into it
  // has to keep working.
  it("allows a path that descends into an `object` configKey", async () => {
    const payload = payloadOf({
      "manifest.json": { schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" },
      "base/preset.json": {
        name: "base",
        files: [{ path: ".github/workflows/ci.yaml", strategy: "full", source: "ci.yaml", enabledBy: "ci.unitTests" }],
        configKeys: { ci: "object" },
      },
    });
    const { files } = await resolvePresetChain(payload, "base", "nuxt-4");
    expect(files.map(f => f.path)).toContain(".github/workflows/ci.yaml");
  });

  it("rejects a render placeholder configPath that no preset declares", async () => {
    const payload = payloadOf({
      "manifest.json": { schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" },
      "base/preset.json": {
        name: "base",
        files: [{ path: "Dockerfile", strategy: "full", source: "Dockerfile", render: "dockerfile" }],
        renders: { dockerfile: { placeholders: { APT: { configPath: "aptPackage", default: "" } } } },
        configKeys: { aptPackages: "string[]" },
      },
    });
    const error = await caught(resolvePresetChain(payload, "base", "nuxt-4"));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("aptPackage");
  });
});

describe("v2 load-time failures", () => {
  it("a typo'd field points at both the file and the field path", async () => {
    const payload = payloadOf({
      "manifest.json": { schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" },
      "base/preset.json": { name: "base", files: [{ path: ".x", stratgy: "full", source: "x" }] },
    });
    const error = await caught(resolvePresetChain(payload, "base", "nuxt-4"));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("presets/base/preset.json");
    expect(error.message).toContain("files.0");
    expect((error.details as { file?: string }).file).toBe("presets/base/preset.json");
  });

  it("rejects a base preset that presets[] never lists", async () => {
    const payload = payloadOf({
      "manifest.json": { schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" },
      "base/preset.json": { name: "base", files: [{ path: ".x", strategy: "full", source: "x" }] },
    });
    const error = await caught(resolvePresetChain(payload, "nuxt-app", "nuxt-4"));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("\"nuxt-app\" is not listed");
  });

  // An undeclared profile used to resolve the version baseline to `{}`, silently
  // disabling version reconcile forever. Profile names are now validated like `base` is.
  it("an undeclared profile errors and lists the names that do exist", async () => {
    const error = await caught(resolvePresetChain(validPayload(), "base", "n5"));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("\"n5\"");
    expect(error.message).toContain("nuxt-4"); // lists what IS declared
    expect(error.details).toMatchObject({ file: "presets/manifest.json", profile: "n5" });
  });

  it("a declared profile with an empty baseline is fine", async () => {
    // `min` is declared but no preset contributes a versionProfiles entry for it.
    // We validate profile names, not baseline content, so this just reconciles nothing.
    const payload = payloadOf({
      "manifest.json": { schemaVersion: 2, presets: ["base"], profiles: [{ name: "std" }, { name: "min" }], defaultBase: "base" },
      "base/preset.json": { name: "base", files: [{ path: ".x", strategy: "full", source: "x" }], versionProfiles: { std: { "engines.node": ">=24.13.0" } } },
    });
    const { baseline } = await resolvePresetChain(payload, "base", "min");
    expect(baseline).toEqual({});
  });

  it("a payload declaring no profiles at all stays permissive", async () => {
    // `profiles: []` is schema-valid and means the payload opts out of profiles
    // entirely, so any profile name resolves to an empty baseline rather than erroring.
    const payload = payloadOf({
      "manifest.json": { schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" },
      "base/preset.json": { name: "base", files: [{ path: ".x", strategy: "full", source: "x" }] },
    });
    const { baseline } = await resolvePresetChain(payload, "base", "anything");
    expect(baseline).toEqual({});
  });

  it("listed preset with no preset.json on disk", async () => {
    const payload = payloadOf({
      "manifest.json": { schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" },
    });
    const error = await caught(resolvePresetChain(payload, "base", "nuxt-4"));
    expect(error.code).toBe("PAYLOAD_INVALID");
    expect(error.message).toContain("presets/base/preset.json is missing");
  });

  it("extends a preset nobody declared", async () => {
    const payload = payloadOf({
      "manifest.json": { schemaVersion: 2, presets: ["child"], profiles: [], defaultBase: "child" },
      "child/preset.json": { name: "child", extends: ["ghost"], files: [{ path: ".x", strategy: "full", source: "x" }] },
    });
    const error = await caught(resolvePresetChain(payload, "child", "nuxt-4"));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("extends \"ghost\"");
  });

  it("preset `name` disagrees with its directory", async () => {
    const payload = payloadOf({
      "manifest.json": { schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" },
      "base/preset.json": { name: "wrong", files: [{ path: ".x", strategy: "full", source: "x" }] },
    });
    const error = await caught(resolvePresetChain(payload, "base", "nuxt-4"));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("declares name \"wrong\"");
  });

  it("a file references a render key no preset in the chain declares", async () => {
    const payload = payloadOf({
      "manifest.json": { schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" },
      "base/preset.json": { name: "base", files: [{ path: "Dockerfile", strategy: "full", source: "x", render: "dockerfile" }] },
    });
    const error = await caught(resolvePresetChain(payload, "base", "nuxt-4"));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("render \"dockerfile\"");
    expect(error.message).toContain("no preset in the chain declares");
  });

  it("browserslist is not a reconcilable version key", async () => {
    const payload = payloadOf({
      "manifest.json": { schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" },
      "base/preset.json": {
        name: "base",
        files: [{ path: ".x", strategy: "full", source: "x" }],
        versionProfiles: { "nuxt-4": { browserslist: "> 1%" } },
      },
    });
    const error = await caught(resolvePresetChain(payload, "base", "nuxt-4"));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("reconcilable version key");
    expect(error.message).toContain("versionProfiles");
  });

  it("enabledBy pointing at an undeclared config path", async () => {
    const payload = payloadOf({
      "manifest.json": { schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" },
      "base/preset.json": { name: "base", files: [{ path: ".x", strategy: "full", source: "x", enabledBy: "ci.upgradePr" }] },
    });
    const error = await caught(resolvePresetChain(payload, "base", "nuxt-4"));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("ci.upgradePr");
    expect(error.message).toContain("configKeys");
  });
});

// There is no manifest-less v1 fallback any more; a payload without a manifest is just invalid.
describe("manifest is required", () => {
  it("refuses to guess the layout of a manifest-less payload", async () => {
    const payload = payloadOf({
      "base/preset.json": {
        name: "base",
        files: [{ path: ".editorconfig", strategy: "full", source: "base/editorconfig" }],
        versionProfiles: { "nuxt-4": { "engines.node": ">=24.13.0" } },
      },
    });
    const error = await caught(resolvePresetChain(payload, "base", "nuxt-4"));
    expect(error.code).toBe("PAYLOAD_INVALID");
    expect(error.message).toContain("has no presets/manifest.json");
  });
});
