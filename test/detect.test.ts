import type { PayloadManifest } from "../src/manifest/schema";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectProfile, parseMajor, profileMismatchWarning, readProjectPackage } from "../src/engine/detect";

/** Two profiles keyed off the same dependency, differing only in the nuxt major. */
function nuxtManifest(): PayloadManifest {
  return {
    schemaVersion: 2,
    presets: ["nuxt-app"],
    defaultBase: "nuxt-app",
    profiles: [
      { name: "nuxt-3", detect: { dependency: "nuxt", majorIs: 3 } },
      { name: "nuxt-4", detect: { dependency: "nuxt", majorIs: 4 } },
    ],
  };
}

describe("parseMajor", () => {
  it("pins a single major from caret, tilde, exact and .x forms", () => {
    expect(parseMajor("^4.0.0")).toBe(4);
    expect(parseMajor("~4.1.0")).toBe(4);
    expect(parseMajor("4.2.0")).toBe(4);
    expect(parseMajor("4.x")).toBe(4);
    expect(parseMajor("4.2.x")).toBe(4);
    expect(parseMajor("4")).toBe(4);
    expect(parseMajor("^4")).toBe(4);
    expect(parseMajor("v4.0.0")).toBe(4);
    expect(parseMajor("4.0.0-beta.1")).toBe(4);
    expect(parseMajor(" 18.3.1 ")).toBe(18);
  });

  it("gives up on comparator, union and hyphen ranges", () => {
    expect(parseMajor(">=4.0.0")).toBeNull();
    expect(parseMajor(">4")).toBeNull();
    expect(parseMajor("<5")).toBeNull();
    expect(parseMajor("<=4.2.0")).toBeNull();
    expect(parseMajor("4 - 5")).toBeNull();
    expect(parseMajor("^3 || ^4")).toBeNull();
  });

  it("returns null instead of throwing on wildcards, aliases and outright garbage", () => {
    expect(parseMajor("*")).toBeNull();
    expect(parseMajor("x")).toBeNull();
    expect(parseMajor("")).toBeNull();
    expect(parseMajor("latest")).toBeNull();
    expect(parseMajor("workspace:*")).toBeNull();
    expect(parseMajor("npm:nuxt@4")).toBeNull();
    expect(parseMajor("4abc")).toBeNull();
  });
});

describe("detectProfile", () => {
  it("detects nuxt-4 from nuxt ^4.2.0 in devDependencies, and says where it looked", () => {
    const result = detectProfile(nuxtManifest(), { devDependencies: { nuxt: "^4.2.0" } });
    expect(result).toEqual({ profile: "nuxt-4", evidence: "nuxt ^4.2.0 in devDependencies" });
  });

  it("detects nuxt-3 from a plain dependency", () => {
    const result = detectProfile(nuxtManifest(), { dependencies: { nuxt: "^3.8.0" } });
    expect(result).toEqual({ profile: "nuxt-3", evidence: "nuxt ^3.8.0 in dependencies" });
  });

  it("prefers devDependencies when both declare the dependency", () => {
    const result = detectProfile(nuxtManifest(), { dependencies: { nuxt: "^3.0.0" }, devDependencies: { nuxt: "^4.0.0" } });
    expect(result).toEqual({ profile: "nuxt-4", evidence: "nuxt ^4.0.0 in devDependencies" });
  });

  it("returns null when the dependency is absent", () => {
    expect(detectProfile(nuxtManifest(), { devDependencies: { vue: "^3.0.0" } })).toEqual({ profile: null, evidence: null });
  });

  it("returns null when the range pins no single major", () => {
    expect(detectProfile(nuxtManifest(), { devDependencies: { nuxt: ">=4.0.0" } })).toEqual({ profile: null, evidence: null });
  });

  it("refuses to guess when two profiles both match", () => {
    const manifest: PayloadManifest = {
      schemaVersion: 2,
      presets: ["app"],
      defaultBase: "app",
      profiles: [
        { name: "nuxt4", detect: { dependency: "nuxt", majorIs: 4 } },
        { name: "vue3", detect: { dependency: "vue", majorIs: 3 } },
      ],
    };
    const result = detectProfile(manifest, { devDependencies: { nuxt: "^4.0.0", vue: "^3.0.0" } });
    expect(result).toEqual({ profile: null, evidence: null });
  });

  it("ignores profiles without a detect probe", () => {
    const manifest: PayloadManifest = {
      schemaVersion: 2,
      presets: ["app"],
      defaultBase: "app",
      profiles: [{ name: "manual" }, { name: "nuxt-4", detect: { dependency: "nuxt", majorIs: 4 } }],
    };
    expect(detectProfile(manifest, { devDependencies: { nuxt: "^4.0.0" } }).profile).toBe("nuxt-4");
  });
});

describe("profileMismatchWarning", () => {
  it("warns when the detected profile disagrees with the configured one", () => {
    const warning = profileMismatchWarning(nuxtManifest(), { devDependencies: { nuxt: "^3.0.0" } }, "nuxt-4");
    expect(warning).toContain("\"nuxt-4\"");
    expect(warning).toContain("\"nuxt-3\"");
    expect(warning).toContain("nuxt ^3.0.0");
  });

  it("stays quiet when detection agrees with the config", () => {
    expect(profileMismatchWarning(nuxtManifest(), { devDependencies: { nuxt: "^4.0.0" } }, "nuxt-4")).toBeNull();
  });

  it("is silent when detection finds nothing", () => {
    expect(profileMismatchWarning(nuxtManifest(), {}, "nuxt-4")).toBeNull();
  });
});

describe("readProjectPackage", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "streamctl-detect-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("tolerates a trailing comma (JSONC), so a hand-edited package.json is not misread as empty", async () => {
    await writeFile(join(dir, "package.json"), `{\n  "devDependencies": {\n    "nuxt": "^4.0.0",\n  },\n}\n`);
    const pkg = await readProjectPackage(dir);
    expect(pkg.devDependencies?.nuxt).toBe("^4.0.0");
  });

  it("returns empty on a missing package.json", async () => {
    expect(await readProjectPackage(dir)).toEqual({});
  });
});
