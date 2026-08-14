import type { ManagedFile } from "../src/config/types";
import type { PayloadHandle } from "../src/payload/resolve";
import { describe, expect, it } from "vitest";
import { compose } from "../src/engine/compose";

function stubPayload(files: Record<string, string>): PayloadHandle {
  return {
    version: "1.0.0",
    async read(source) {
      if (!(source in files)) {
        throw new Error(`missing fixture source: ${source}`);
      }
      return files[source];
    },
    async list() {
      return Object.keys(files).sort();
    },
  };
}

const payload = stubPayload({
  "base/tsconfig.json": "{\n  \"extends\": \"streamctl\"\n}\n",
  "nuxt-app/eslint.config.ts": "export default createStreamctlEslint()\n",
});

describe("compose: full", () => {
  it("returns the payload verbatim, overwriting and drift-checked", async () => {
    const file: ManagedFile = { path: "tsconfig.json", strategy: "full", source: "base/tsconfig.json" };
    const result = await compose(file, payload);

    expect(result).toEqual({
      status: "composed",
      targetContent: "{\n  \"extends\": \"streamctl\"\n}\n",
      writeMode: "overwrite",
      driftChecked: true,
    });
  });
});

describe("compose: scaffold", () => {
  it("writes if-absent and opts out of drift checking", async () => {
    const file: ManagedFile = { path: "eslint.config.ts", strategy: "scaffold", source: "nuxt-app/eslint.config.ts" };
    const result = await compose(file, payload);

    expect(result).toEqual({
      status: "composed",
      targetContent: "export default createStreamctlEslint()\n",
      writeMode: "if-absent",
      driftChecked: false,
    });
  });
});

describe("compose: block", () => {
  const blockPayload = stubPayload({ "base/npmrc": "registry=https://example\n" });

  it("inserts a managed block into a marker-less file", async () => {
    const file: ManagedFile = { path: ".npmrc", strategy: "block", source: "base/npmrc", blockMark: "registry" };
    const result = await compose(file, blockPayload, "always-auth=true\n");
    expect(result).toMatchObject({ status: "composed", writeMode: "overwrite", driftChecked: true });
    if (result.status !== "composed")
      throw new Error("expected composed");
    expect(result.targetContent).toBe(
      "always-auth=true\n# BEGIN streamctl MANAGED BLOCK registry\nregistry=https://example\n# END streamctl MANAGED BLOCK registry\n",
    );
  });

  it("surfaces a marker-error for duplicated markers", async () => {
    const file: ManagedFile = { path: ".npmrc", strategy: "block", source: "base/npmrc", blockMark: "registry" };
    const dup = "# BEGIN streamctl MANAGED BLOCK registry\nx\n# END streamctl MANAGED BLOCK registry\n# BEGIN streamctl MANAGED BLOCK registry\ny\n# END streamctl MANAGED BLOCK registry\n";
    expect(await compose(file, blockPayload, dup)).toEqual({
      status: "marker-error",
      strategy: "block",
      mark: "registry",
      reason: "duplicated or unbalanced markers for \"registry\"",
    });
  });

  it("throws when blockMark is missing", async () => {
    const file: ManagedFile = { path: ".npmrc", strategy: "block", source: "base/npmrc" };
    await expect(compose(file, blockPayload, "")).rejects.toThrow(/requires a blockMark/);
  });
});

describe("compose: merge", () => {
  const mergePayload = stubPayload({ "base/vscode/settings.json": "{ \"eslint.useFlatConfig\": true }\n" });

  it("composes owned keys onto the current file", async () => {
    const file: ManagedFile = { path: ".vscode/settings.json", strategy: "merge", source: "base/vscode/settings.json", projectFields: ["editor.fontSize"] };
    const result = await compose(file, mergePayload, "{ \"editor.fontSize\": 18 }\n");
    expect(result).toMatchObject({ status: "composed", writeMode: "overwrite", driftChecked: true });
  });

  it("surfaces a merge-error for malformed JSONC", async () => {
    const file: ManagedFile = { path: ".vscode/settings.json", strategy: "merge", source: "base/vscode/settings.json" };
    // Genuinely malformed (missing value). Trailing commas are valid JSONC and tolerated.
    const result = await compose(file, mergePayload, "{ \"a\": }\n");
    expect(result.status).toBe("merge-error");
    if (result.status !== "merge-error")
      throw new Error("expected merge-error");
    expect(result.reason).toContain("invalid JSONC");
  });
});

describe("compose: dependency map", () => {
  const dockerPayload = stubPayload({ "base/Dockerfile": "ARG PRISMA_VERSION=${PRISMA}\n" });
  const dockerfile: ManagedFile = {
    path: "Dockerfile",
    strategy: "full",
    source: "base/Dockerfile",
    renderDef: { placeholders: { PRISMA: { configPath: "docker.prismaVersion", fromDependency: "prisma", default: "6.19.1" } } },
  };

  it("feeds the caller's map into placeholder resolution", async () => {
    const result = await compose(dockerfile, dockerPayload, null, undefined, { prisma: "^6.19.3" });
    expect(result).toMatchObject({ status: "composed", targetContent: "ARG PRISMA_VERSION=6.19.3\n" });
  });

  it("falls back to the placeholder default when the caller passes no map", async () => {
    const result = await compose(dockerfile, dockerPayload);
    expect(result).toMatchObject({ status: "composed", targetContent: "ARG PRISMA_VERSION=6.19.1\n" });
  });

  // `check` diffs its composed bytes against what `sync` wrote, so identical inputs must
  // produce identical output every time.
  it("composes byte-identically on repeat", async () => {
    const deps = { prisma: "^6.19.3" };
    const first = await compose(dockerfile, dockerPayload, null, undefined, deps);
    const second = await compose(dockerfile, dockerPayload, null, undefined, deps);
    expect(first).toEqual(second);
  });
});
