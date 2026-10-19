import type { ManagedFile, StreamctlConfig } from "../src/config/types";
import type { ComposeResult } from "../src/engine/compose";
import type { PayloadHandle } from "../src/payload/resolve";
import { describe, expect, it } from "vitest";
import { compose } from "../src/engine/compose";
import { evaluateCondition } from "../src/engine/conditions";
import { StreamctlError } from "../src/errors";

function payloadOf(files: Record<string, string>): PayloadHandle {
  return {
    version: "1.0.0",
    async read(source) {
      const value = files[source];
      if (value === undefined) {
        throw new Error(`missing fixture source: ${source}`);
      }
      return value;
    },
    async list() {
      return Object.keys(files).sort();
    },
  };
}

function cfg(extra: Partial<StreamctlConfig> = {}): StreamctlConfig {
  return { package: "@acme/config", base: "base", version: "1.0.0", profile: "nuxt-4", ...extra };
}

function content(result: ComposeResult): string {
  if (result.status !== "composed") {
    throw new Error(`expected composed, got ${result.status}`);
  }
  return result.targetContent;
}

const block = "a\n# streamctl:if ci.prisma\nprisma\n# streamctl:else ci.prisma\nno-prisma\n# streamctl:end ci.prisma\nz\n";

describe("evaluateCondition", () => {
  it.each([
    [true, true],
    [false, false],
    [undefined, false],
    ["x", true],
    ["", false],
    [["a"], true],
    [[], false],
  ])("treats %j as %s", (value, expected) => {
    const config = value === undefined ? cfg() : cfg({ ci: { flag: value } });
    expect(evaluateCondition(config, "ci.flag", "ci.yaml")).toBe(expected);
  });

  it("is false without a config", () => {
    expect(evaluateCondition(undefined, "ci.flag", "ci.yaml")).toBe(false);
  });

  it.each([
    [1, "number"],
    [null, "null"],
    [{ a: 1 }, "object"],
  ])("rejects %j as unevaluable", (value, found) => {
    const config: unknown = { ...cfg(), ci: { flag: value } };
    let caught: unknown;
    try {
      evaluateCondition(config as StreamctlConfig, "ci.flag", "ci.yaml");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StreamctlError);
    expect(caught).toMatchObject({
      code: "CONFIG_INVALID",
      details: { file: "ci.yaml", condition: "ci.flag", reason: "unevaluable-value", found },
    });
  });
});

describe("compose: directive pass", () => {
  const payload = payloadOf({
    "base/npmrc": block,
    "base/ci.yaml": "jobs:\n  # streamctl:if ci.deploy\n  deploy: ${DEPLOY}\n  # streamctl:end ci.deploy\n  lint: true\n",
    "base/ci-main.yaml": "jobs:\n",
    "base/toggle.job": "  # streamctl:if ci.prisma\n  prisma: true\n  # streamctl:end ci.prisma\n  test: true\n",
    "base/env.job": "  deploy-${ITEM}:\n    # streamctl:if !ci.prisma\n    plain: true\n    # streamctl:end !ci.prisma\n",
  });

  it("applies directives to a full file without render", async () => {
    const file: ManagedFile = { path: ".npmrc", strategy: "full", source: "base/npmrc" };
    expect(content(await compose(file, payload, null, cfg({ ci: { prisma: true } })))).toBe("a\nprisma\nz\n");
    expect(content(await compose(file, payload, null, cfg()))).toBe("a\nno-prisma\nz\n");
  });

  it("applies directives to the payload region of a block file", async () => {
    const file: ManagedFile = { path: ".npmrc", strategy: "block", source: "base/npmrc", blockMark: "core" };
    const current = "local=1\n# BEGIN streamctl MANAGED BLOCK core\nold\n# END streamctl MANAGED BLOCK core\ntail\n";
    expect(content(await compose(file, payload, current, cfg({ ci: { prisma: true } })))).toBe(
      "local=1\n# BEGIN streamctl MANAGED BLOCK core\na\nprisma\nz\n# END streamctl MANAGED BLOCK core\ntail\n",
    );
  });

  it("applies directives to a scaffold file", async () => {
    const file: ManagedFile = { path: ".npmrc", strategy: "scaffold", source: "base/npmrc" };
    const result = await compose(file, payload, null, cfg());
    expect(result).toMatchObject({ status: "composed", writeMode: "if-absent", driftChecked: false });
    expect(content(result)).toBe("a\nno-prisma\nz\n");
  });

  it("needs no placeholder value for a token inside a dropped block", async () => {
    const file: ManagedFile = { path: ".github/workflows/ci.yaml", strategy: "full", source: "base/ci.yaml", renderDef: {} };
    expect(content(await compose(file, payload, null, cfg()))).toBe("jobs:\n  lint: true\n");
  });

  it("still fails on a token inside a kept block without a placeholder", async () => {
    const file: ManagedFile = { path: ".github/workflows/ci.yaml", strategy: "full", source: "base/ci.yaml", renderDef: {} };
    await expect(compose(file, payload, null, cfg({ ci: { deploy: true } }))).rejects.toThrow(/unresolved render token/);
  });

  it("applies directives inside toggle and forEach fragments", async () => {
    const file: ManagedFile = {
      path: ".github/workflows/ci.yaml",
      strategy: "full",
      source: "base/ci-main.yaml",
      renderDef: { fragments: [{ toggle: "ci.test", source: "base/toggle.job" }, { forEach: "ci.envs", source: "base/env.job" }] },
    };
    const output = content(await compose(file, payload, null, cfg({ ci: { test: true, envs: ["dev", "prod"] } })));
    expect(output).not.toContain("streamctl:");
    expect(output).not.toContain("prisma");
    expect(output).toContain("  test: true\n");
    expect(output).toContain("  deploy-dev:\n    plain: true\n");
    expect(output).toContain("  deploy-prod:\n    plain: true\n");
  });

  it("reports unevaluable values against the target path", async () => {
    const file: ManagedFile = { path: ".npmrc", strategy: "full", source: "base/npmrc" };
    const config: unknown = { ...cfg(), ci: { prisma: 3 } };
    await expect(compose(file, payload, null, config as StreamctlConfig)).rejects.toMatchObject({
      details: { file: ".npmrc", reason: "unevaluable-value", found: "number" },
    });
  });
});
