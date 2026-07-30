import type { ZodError } from "zod";
import { describe, expect, it } from "vitest";
import {
  managedFileSchema,
  payloadManifestSchema,
  presetManifestSchema,
  renderDefSchema,
  SUPPORTED_SCHEMA_VERSION,
  zodToIssues,
} from "../src/manifest/schema";

function managedFile(): Record<string, unknown> {
  return { path: "config/x.ts", strategy: "full", source: "base/x" };
}

function preset(): Record<string, unknown> {
  return { name: "base", files: [{ path: ".editorconfig", strategy: "full", source: "base/editorconfig" }] };
}

function payload(): Record<string, unknown> {
  return { schemaVersion: 2, presets: ["base", "nuxt-app"], profiles: [{ name: "nuxt-4" }], defaultBase: "nuxt-app" };
}

/** Every issue `path` from a parse that is expected to fail. */
function issuePaths(input: unknown, schema: { safeParse: (v: unknown) => { success: boolean; error?: ZodError } }): string[] {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  return zodToIssues(result.error as ZodError).map(issue => issue.path);
}

describe("valid manifests parse", () => {
  it("accepts a preset that uses every optional section", () => {
    const rich = {
      name: "nuxt-app",
      extends: ["base"],
      files: [
        { path: ".editorconfig", strategy: "full", source: "base/editorconfig" },
        { path: ".npmrc", strategy: "block", source: "base/npmrc", blockMark: "registry" },
        { path: ".vscode/settings.json", strategy: "merge", source: "base/vscode/settings.json", projectFields: ["editor.fontSize"] },
        { path: "eslint.config.ts", strategy: "scaffold", source: "nuxt-app/eslint.config.ts" },
        { path: "Dockerfile", strategy: "full", source: "nuxt-app/Dockerfile", render: "dockerfile" },
        { path: ".github/workflows/deploy.yaml", strategy: "full", source: "nuxt-app/deploy.yaml", render: "deploy", enabledBy: "ci.deploy", adoption: "expected" },
      ],
      versionProfiles: { "nuxt-4": { "engines.node": ">=24.13.0", "packageManager": "pnpm@10.28.1", "devDependencies.nuxt": "^4.3.0", "scripts.postinstall": "nuxt prepare" } },
      renders: {
        dockerfile: { placeholders: { APT: { configPath: "aptPackages", default: "", pattern: "^[a-z0-9]+$", join: "space" } }, passthrough: ["PRISMA_VERSION"] },
        deploy: { placeholders: { NODE_VERSION: { configPath: "ci.nodeVersion", default: "24.13.0" } }, fragments: [{ forEach: "ci.deploy", source: "nuxt-app/deploy.job.yaml" }, { toggle: "ci.unitTests", source: "nuxt-app/x" }] },
      },
      configKeys: { eslint: "object", aptPackages: "string[]", verbose: "boolean", registry: "string" },
    };
    expect(presetManifestSchema.safeParse(rich).success).toBe(true);
  });

  it("accepts an empty files[] only when the preset extends a parent", () => {
    expect(presetManifestSchema.safeParse({ name: "leaf", extends: ["base"], files: [] }).success).toBe(true);
    expect(presetManifestSchema.safeParse({ name: "leaf", files: [] }).success).toBe(false);
  });

  it("profiles may carry a detection probe", () => {
    const withDetect = { ...payload(), profiles: [{ name: "nuxt-4", detect: { dependency: "nuxt", majorIs: 4 } }] };
    expect(payloadManifestSchema.safeParse(withDetect).success).toBe(true);
  });
});

describe("ManagedFile", () => {
  // The strategy enum is closed on purpose: an unknown strategy used to be silently skipped.
  it("rejects an unknown strategy", () => {
    expect(managedFileSchema.safeParse({ ...managedFile(), strategy: "copy" }).success).toBe(false);
  });

  it("rejects an unknown key", () => {
    expect(managedFileSchema.safeParse({ ...managedFile(), bogus: 1 }).success).toBe(false);
  });

  it("requires blockMark when strategy is block", () => {
    expect(issuePaths({ path: ".npmrc", strategy: "block", source: "base/npmrc" }, managedFileSchema)).toContain("blockMark");
  });

  it("rejects blockMark on a non-block strategy", () => {
    expect(issuePaths({ ...managedFile(), blockMark: "x" }, managedFileSchema)).toContain("blockMark");
  });

  it("won't let the block strategy near a .json or .yaml path", () => {
    expect(managedFileSchema.safeParse({ path: ".oxlintrc.json", strategy: "block", blockMark: "x", source: "s" }).success).toBe(false);
    expect(managedFileSchema.safeParse({ path: "a.yaml", strategy: "block", blockMark: "x", source: "s" }).success).toBe(false);
  });

  it("rejects a `..` path", () => {
    expect(issuePaths({ ...managedFile(), path: "../escape" }, managedFileSchema)).toContain("path");
  });

  it("rejects an absolute path", () => {
    expect(issuePaths({ ...managedFile(), path: "/etc/passwd" }, managedFileSchema)).toContain("path");
  });

  it("rejects a backslash path", () => {
    expect(issuePaths({ ...managedFile(), path: "a\\b" }, managedFileSchema)).toContain("path");
  });

  it("rejects package.json (owned by the version reconcile)", () => {
    expect(issuePaths({ ...managedFile(), path: "package.json" }, managedFileSchema)).toContain("path");
  });

  describe("reserved config paths", () => {
    const reject = (path: string): string[] => issuePaths({ ...managedFile(), path }, managedFileSchema);
    const accepts = (path: string): boolean => managedFileSchema.safeParse({ ...managedFile(), path }).success;

    it("rejects the root config on any extension", () => {
      for (const path of ["streamctl.config.ts", "streamctl.config.mjs", "streamctl.config.js", "streamctl.config.mts"]) {
        expect(reject(path), path).toContain("path");
      }
    });

    it("rejects anything under the legacy directory", () => {
      expect(reject(".streamctl/config.ts")).toContain("path");
      expect(reject(".streamctl/notes.md")).toContain("path");
    });

    // `./x`, `.//x` and `././x` all reach disk as the same file a bare `x` names, so a
    // guard that only tests the raw string is bypassed by typing a prefix.
    it("rejects `./`-prefixed spellings of every reservation", () => {
      for (const path of [
        "./streamctl.config.ts",
        ".//streamctl.config.ts",
        "././streamctl.config.ts",
        "./.streamctl/config.ts",
        ".//.streamctl/config.ts",
        "./package.json",
        ".//package.json",
      ]) {
        expect(reject(path), path).toContain("path");
      }
    });

    // The failure mode of this guard is over-breadth, not absence: a payload's own
    // wrapper files live in the same root namespace, and `acme.config.ts` is managed by
    // the synthetic payload much of the suite depends on.
    it("still accepts other root-level wrapper configs", () => {
      for (const path of ["eslint.config.ts", "prisma.config.ts", "acme.config.ts"]) {
        expect(accepts(path), path).toBe(true);
      }
    });

    it("accepts the reserved names outside the invocation directory", () => {
      expect(accepts("nested/streamctl.config.ts")).toBe(true);
      // Same stem, different file: only `streamctl.config.<ext>` is reserved.
      expect(accepts("streamctl.config-guide.md")).toBe(true);
      expect(accepts("docs/streamctl.config-guide.md")).toBe(true);
    });
  });

  it("rejects projectFields on a non-merge strategy", () => {
    expect(issuePaths({ ...managedFile(), projectFields: ["x"] }, managedFileSchema)).toContain("projectFields");
  });

  // shadowedBy was added without bumping schemaVersion, so it has to stay optional.
  it("accepts shadowedBy as a string[]", () => {
    expect(managedFileSchema.safeParse({ path: "eslint.config.ts", strategy: "scaffold", source: "s", shadowedBy: ["eslint.config.mjs", "eslint.config.js"] }).success).toBe(true);
    expect(managedFileSchema.safeParse({ path: "eslint.config.ts", strategy: "scaffold", source: "s" }).success).toBe(true);
  });

  it("rejects a bare string or an empty entry in shadowedBy", () => {
    expect(managedFileSchema.safeParse({ ...managedFile(), shadowedBy: "eslint.config.mjs" }).success).toBe(false);
    expect(issuePaths({ ...managedFile(), shadowedBy: [""] }, managedFileSchema)).toContain("shadowedBy.0");
  });
});

describe("RenderDef", () => {
  it("rejects an unknown key", () => {
    expect(renderDefSchema.safeParse({ placeholders: {}, bogus: 1 }).success).toBe(false);
  });

  it("a fragment must not carry both toggle and forEach", () => {
    expect(renderDefSchema.safeParse({ fragments: [{ toggle: "a", forEach: "b", source: "s" }] }).success).toBe(false);
  });

  it("a fragment with neither is rejected too", () => {
    expect(renderDefSchema.safeParse({ fragments: [{ source: "s" }] }).success).toBe(false);
  });

  it("accepts one of each", () => {
    expect(renderDefSchema.safeParse({ fragments: [{ toggle: "ci.e2e", source: "a" }, { forEach: "ci.deploy", source: "b" }] }).success).toBe(true);
  });

  it("rejects an invalid placeholder join", () => {
    expect(renderDefSchema.safeParse({ placeholders: { X: { configPath: "a", default: "", join: "csv" } } }).success).toBe(false);
  });

  it("accepts a passthrough token list", () => {
    expect(renderDefSchema.safeParse({ passthrough: ["PRISMA_VERSION", "OTHER"] }).success).toBe(true);
  });

  it("rejects a non-string or empty passthrough entry", () => {
    expect(renderDefSchema.safeParse({ passthrough: [1] }).success).toBe(false);
    expect(renderDefSchema.safeParse({ passthrough: [""] }).success).toBe(false);
  });
});

describe("PresetManifest", () => {
  it("rejects a versionProfiles key outside the reconcile safety pattern", () => {
    const paths = issuePaths({ ...preset(), versionProfiles: { "nuxt-4": { browserslist: "> 1%" } } }, presetManifestSchema);
    expect(paths.some(p => p.startsWith("versionProfiles"))).toBe(true);
  });

  it("accepts reconcilable versionProfiles keys", () => {
    expect(presetManifestSchema.safeParse({ ...preset(), versionProfiles: { "nuxt-4": { "devDependencies.typescript": "^6.0.0" } } }).success).toBe(true);
  });

  it("accepts any scripts.<name>, not just scripts.postinstall", () => {
    expect(presetManifestSchema.safeParse({ ...preset(), versionProfiles: { "nuxt-4": { "scripts.lint": "oxlint . && eslint ." } } }).success).toBe(true);
  });

  it("covers all four dependency sections", () => {
    const keys = { "dependencies.a": "^1", "devDependencies.b": "^1", "peerDependencies.c": "^1", "optionalDependencies.d": "^1" };
    expect(presetManifestSchema.safeParse({ ...preset(), versionProfiles: { "nuxt-4": keys } }).success).toBe(true);
  });

  // The pattern is anchored to the exact npm field names, casing included.
  it("rejects a mis-cased dependency section", () => {
    expect(presetManifestSchema.safeParse({ ...preset(), versionProfiles: { "nuxt-4": { "Dependencies.x": "^1" } } }).success).toBe(false);
    expect(presetManifestSchema.safeParse({ ...preset(), versionProfiles: { "nuxt-4": { "devdependencies.x": "^1" } } }).success).toBe(false);
  });

  it("rejects a bad configKeys value", () => {
    expect(presetManifestSchema.safeParse({ ...preset(), configKeys: { eslint: "number" } }).success).toBe(false);
  });

  it("rejects the old v1 shape with its packages/description keys", () => {
    expect(presetManifestSchema.safeParse({ ...preset(), packages: ["@x/y"], description: "d" }).success).toBe(false);
  });
});

describe("PayloadManifest schemaVersion contract", () => {
  it(`accepts exactly schemaVersion ${SUPPORTED_SCHEMA_VERSION}`, () => {
    expect(payloadManifestSchema.safeParse(payload()).success).toBe(true);
  });

  // Plain literal failure here; the loader is what turns it into SCHEMA_UNSUPPORTED.
  it("rejects anything older or newer", () => {
    expect(payloadManifestSchema.safeParse({ ...payload(), schemaVersion: 1 }).success).toBe(false);
    expect(payloadManifestSchema.safeParse({ ...payload(), schemaVersion: 3 }).success).toBe(false);
  });

  it("rejects an unknown top-level key", () => {
    expect(payloadManifestSchema.safeParse({ ...payload(), extra: true }).success).toBe(false);
  });
});

describe("zodToIssues", () => {
  it("maps a ZodError onto ConfigIssue", () => {
    const result = managedFileSchema.safeParse({ ...managedFile(), path: "../x" });
    expect(result.success).toBe(false);
    const issues = zodToIssues((result as { error: ZodError }).error);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(typeof issue.path).toBe("string");
      expect(typeof issue.message).toBe("string");
    }
    expect(issues.some(i => i.path === "path" && i.message.includes(".."))).toBe(true);
  });

  it("labels a root-level issue \"(root)\" instead of an empty string", () => {
    const result = managedFileSchema.safeParse("not-an-object");
    const issues = zodToIssues((result as { error: ZodError }).error);
    expect(issues[0]?.path).toBe("(root)");
  });
});
