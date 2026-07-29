import type { ConfigKeyType } from "../src/manifest/schema";
import { describe, expect, it } from "vitest";
import { validateConfigKeys, validateStreamctlConfig, validateStreamctlConfigWithKeys } from "../src/config/validate";
import { StreamctlError } from "../src/errors";

const base = { package: "@acme/payload", base: "nuxt-app", version: "1.0.0", profile: "nuxt-4" } as const;

describe("validateStreamctlConfig", () => {
  it("requires `package`", () => {
    const { package: _omit, ...withoutPackage } = base;
    const error = (() => {
      try {
        validateStreamctlConfig(withoutPackage);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).toContain("package: is required");
  });

  it("rejects a malformed `package` name", () => {
    const error = (() => {
      try {
        validateStreamctlConfig({ ...base, package: "Not A Valid Name" });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).toContain("package");
  });

  it("accepts the full set of documented ci toggles", () => {
    const config = validateStreamctlConfig({
      ...base,
      ci: { unitTests: true, e2e: true, migrationLint: true, deploy: ["staging"], nodeVersion: "24.13.0", pnpmVersion: "10.28.1" },
    });
    expect(config.ci?.nodeVersion).toBe("24.13.0");
    expect(config.ci?.pnpmVersion).toBe("10.28.1");
  });

  it("accepts arbitrary eslint knobs as an opaque object", () => {
    const eslint = {
      autoImportPaths: ["utils/"],
      ignoresTypeAware: ["eslint.config.ts"],
      // A key the CLI has never heard of is passed through untouched.
      somePayloadSpecificKnob: { nested: true },
    };
    const config = validateStreamctlConfig({ ...base, eslint });
    expect(config.eslint).toEqual(eslint);
  });

  it("stage 1 passes payload knobs through untouched, they are stage 2's problem", () => {
    const config = validateStreamctlConfig({ ...base, eslint: "full", ci: { notARealToggle: true } });
    expect((config as Record<string, unknown>).eslint).toBe("full");
  });

  it("accepts an unknown eslint option", () => {
    const config = validateStreamctlConfig({ ...base, eslint: { notARealOption: true } });
    expect(config.eslint).toEqual({ notARealOption: true });
  });

  it("accepts any non-empty string profile", () => {
    expect(validateStreamctlConfig({ ...base, profile: "nuxt-3" }).profile).toBe("nuxt-3");
    expect(validateStreamctlConfig({ ...base, profile: "custom" }).profile).toBe("custom");
  });

  it("rejects an empty-string profile", () => {
    const error = (() => {
      try {
        validateStreamctlConfig({ ...base, profile: "" });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).message).toContain("profile: must be a non-empty string");
  });
});

const CONFIG_KEYS = {
  "ci.unitTests": "boolean",
  "ci.e2e": "boolean",
  "ci.nodeVersion": "string",
  "aptPackages": "string[]",
  "eslint": "object",
} satisfies Record<string, ConfigKeyType>;

describe("validateConfigKeys (stage 2)", () => {
  it("accepts config knobs matching their declared shapes", () => {
    const issues = validateConfigKeys(
      { ci: { unitTests: true, e2e: false, nodeVersion: "24.13.0" }, aptPackages: ["curl"], eslint: { anything: { deep: 1 } } },
      CONFIG_KEYS,
    );
    expect(issues).toEqual([]);
  });

  it("flags a shape mismatch with expected/got and the dotted path", () => {
    const issues = validateConfigKeys({ ci: { unitTests: "yes" } }, CONFIG_KEYS);
    expect(issues).toEqual([{ path: "ci.unitTests", message: "expected boolean, got string" }]);
  });

  it("suggests the nearest declared key on a typo", () => {
    const issues = validateConfigKeys({ ci: { unitTest: true } }, CONFIG_KEYS);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("ci.unitTest");
    expect(issues[0]?.message).toContain("did you mean ci.unitTests");
  });

  it("scopes the suggestion to a NESTED namespace, not just its first segment", () => {
    // Depth 3: the sibling filter must key on the full `ci.jobs` prefix. Keying on
    // the first segment alone never matches a dotted prefix, so the suggestion fell
    // back to every declared key and could name one from an unrelated namespace.
    const keys: Record<string, ConfigKeyType> = {
      "ci.jobs.build": "boolean",
      "ci.jobs.buildCache": "boolean",
      "release.buildX": "boolean",
    };
    const issues = validateConfigKeys({ ci: { jobs: { buildd: true } } }, keys);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("ci.jobs.buildd");
    expect(issues[0]?.message).toContain("did you mean ci.jobs.build");
  });

  it("rejects a key in an undeclared namespace and lists the declared ones", () => {
    const issues = validateConfigKeys({ foo: { bar: 1 } }, CONFIG_KEYS);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("foo");
    expect(issues[0]?.message).toContain("unknown config key foo");
    expect(issues[0]?.message).toContain("aptPackages");
    expect(issues[0]?.message).toContain("ci");
    expect(issues[0]?.message).toContain("eslint");
  });

  it("treats a declared \"object\" key as shape-only, however weird the value", () => {
    const issues = validateConfigKeys({ eslint: { a: [1, 2, { nested: null }], b: () => 0 } as Record<string, unknown> }, CONFIG_KEYS);
    expect(issues).toEqual([]);
  });

  it("rejects an \"object\" key that is not an object", () => {
    const issues = validateConfigKeys({ eslint: "full" }, CONFIG_KEYS);
    expect(issues).toEqual([{ path: "eslint", message: "expected object, got string" }]);
  });

  it("validates string[] element types", () => {
    const issues = validateConfigKeys({ aptPackages: ["curl", 42] }, CONFIG_KEYS);
    expect(issues).toEqual([{ path: "aptPackages", message: "expected string[], got array" }]);
  });
});

describe("validateStreamctlConfigWithKeys (combined stages)", () => {
  it("concatenates stage-1 and stage-2 issues into ONE CONFIG_INVALID", () => {
    const error = (() => {
      try {
        // profile empty fails stage 1, ci.unitTests wrong type fails stage 2.
        validateStreamctlConfigWithKeys({ ...base, profile: "", ci: { unitTests: "yes" } }, CONFIG_KEYS);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(StreamctlError);
    const issues = (error as StreamctlError).details as { issues: { path: string }[] };
    const paths = issues.issues.map(i => i.path);
    expect(paths).toContain("profile");
    expect(paths).toContain("ci.unitTests");
  });

  it("an empty configKeys map rejects every payload knob", () => {
    const error = (() => {
      try {
        validateStreamctlConfigWithKeys({ ...base, madeUp: true }, {});
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(StreamctlError);
    const issues = (error as StreamctlError).details as { issues: { path: string }[] };
    expect(issues.issues.map(i => i.path)).toContain("madeUp");
  });

  it("returns the validated config when everything matches", () => {
    const config = validateStreamctlConfigWithKeys({ ...base, ci: { unitTests: true }, aptPackages: ["curl"] }, CONFIG_KEYS);
    expect(config.profile).toBe("nuxt-4");
  });
});
