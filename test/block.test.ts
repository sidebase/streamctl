import { describe, expect, it } from "vitest";
import { commentSyntaxFor, composeBlock } from "../src/engine/block";

describe("commentSyntaxFor", () => {
  it("uses # for npmrc, gitignore, yaml, editorconfig and dockerfiles", () => {
    for (const path of [".npmrc", ".gitignore", "ci.yaml", "deploy.yml", ".editorconfig", "Dockerfile"]) {
      expect(commentSyntaxFor(path)).toEqual({ prefix: "# ", suffix: "" });
    }
  });

  it("uses // for JS/TS and JSONC config files", () => {
    expect(commentSyntaxFor("eslint.config.ts")).toEqual({ prefix: "// ", suffix: "" });
    expect(commentSyntaxFor("a/b/foo.mjs")).toEqual({ prefix: "// ", suffix: "" });
    expect(commentSyntaxFor(".oxlintrc.json")).toEqual({ prefix: "// ", suffix: "" });
  });

  it("uses <!-- --> for HTML/markdown/vue", () => {
    expect(commentSyntaxFor("README.md")).toEqual({ prefix: "<!-- ", suffix: " -->" });
    expect(commentSyntaxFor("app.vue")).toEqual({ prefix: "<!-- ", suffix: " -->" });
  });
});

describe("composeBlock: insert when absent", () => {
  it("creates a block-only file when content is null", () => {
    const result = composeBlock({ path: ".npmrc", mark: "registry", payloadRegion: "a=1\n", currentContent: null });
    expect(result).toEqual({
      ok: true,
      content: "# BEGIN streamctl MANAGED BLOCK registry\na=1\n# END streamctl MANAGED BLOCK registry\n",
    });
  });

  it("appends after existing content, with a separating newline", () => {
    const result = composeBlock({ path: ".gitignore", mark: "core", payloadRegion: "node_modules\n", currentContent: "dist" });
    expect(result.ok).toBe(true);
    if (!result.ok)
      return;
    expect(result.content).toBe(
      "dist\n# BEGIN streamctl MANAGED BLOCK core\nnode_modules\n# END streamctl MANAGED BLOCK core\n",
    );
  });
});

describe("composeBlock: replace when present", () => {
  const current = "head line\n# BEGIN streamctl MANAGED BLOCK core\nOLD\n# END streamctl MANAGED BLOCK core\ntail line\n";

  it("replaces the inner region and leaves everything else byte for byte", () => {
    const result = composeBlock({ path: ".gitignore", mark: "core", payloadRegion: "NEW\n", currentContent: current });
    expect(result.ok).toBe(true);
    if (!result.ok)
      return;
    expect(result.content).toBe(
      "head line\n# BEGIN streamctl MANAGED BLOCK core\nNEW\n# END streamctl MANAGED BLOCK core\ntail line\n",
    );
  });

  it("is idempotent", () => {
    const first = composeBlock({ path: ".gitignore", mark: "core", payloadRegion: "NEW\n", currentContent: current });
    expect(first.ok).toBe(true);
    if (!first.ok)
      return;
    const second = composeBlock({ path: ".gitignore", mark: "core", payloadRegion: "NEW\n", currentContent: first.content });
    expect(second).toEqual(first);
  });
});

describe("composeBlock: mark disambiguation", () => {
  it("replaces only the matching mark's block", () => {
    const current = "# BEGIN streamctl MANAGED BLOCK a\nA\n# END streamctl MANAGED BLOCK a\n# BEGIN streamctl MANAGED BLOCK b\nB\n# END streamctl MANAGED BLOCK b\n";
    const result = composeBlock({ path: ".npmrc", mark: "b", payloadRegion: "B2\n", currentContent: current });
    expect(result.ok).toBe(true);
    if (!result.ok)
      return;
    expect(result.content).toBe(
      "# BEGIN streamctl MANAGED BLOCK a\nA\n# END streamctl MANAGED BLOCK a\n# BEGIN streamctl MANAGED BLOCK b\nB2\n# END streamctl MANAGED BLOCK b\n",
    );
  });
});

// Marker matching is line-anchored, so `core` must not latch onto `core2`.
describe("composeBlock: prefix-mark disambiguation", () => {
  it("`core` inserts a new block and leaves `core2` alone", () => {
    const current = "# BEGIN streamctl MANAGED BLOCK core2\nX\n# END streamctl MANAGED BLOCK core2\n";
    const result = composeBlock({ path: ".npmrc", mark: "core", payloadRegion: "NEW\n", currentContent: current });
    expect(result.ok).toBe(true);
    if (!result.ok)
      return;
    expect(result.content).toBe(
      "# BEGIN streamctl MANAGED BLOCK core2\nX\n# END streamctl MANAGED BLOCK core2\n# BEGIN streamctl MANAGED BLOCK core\nNEW\n# END streamctl MANAGED BLOCK core\n",
    );
  });

  it("each of two overlapping marks replaces only its own region", () => {
    const current = "# BEGIN streamctl MANAGED BLOCK core\nA\n# END streamctl MANAGED BLOCK core\n# BEGIN streamctl MANAGED BLOCK core2\nB\n# END streamctl MANAGED BLOCK core2\n";

    const core = composeBlock({ path: ".npmrc", mark: "core", payloadRegion: "A2\n", currentContent: current });
    expect(core.ok).toBe(true);
    if (!core.ok)
      return;
    expect(core.content).toBe(
      "# BEGIN streamctl MANAGED BLOCK core\nA2\n# END streamctl MANAGED BLOCK core\n# BEGIN streamctl MANAGED BLOCK core2\nB\n# END streamctl MANAGED BLOCK core2\n",
    );

    const core2 = composeBlock({ path: ".npmrc", mark: "core2", payloadRegion: "B2\n", currentContent: current });
    expect(core2.ok).toBe(true);
    if (!core2.ok)
      return;
    expect(core2.content).toBe(
      "# BEGIN streamctl MANAGED BLOCK core\nA\n# END streamctl MANAGED BLOCK core\n# BEGIN streamctl MANAGED BLOCK core2\nB2\n# END streamctl MANAGED BLOCK core2\n",
    );
  });
});

describe("composeBlock: broken markers", () => {
  it("flags a duplicated block", () => {
    const current = "# BEGIN streamctl MANAGED BLOCK m\nx\n# END streamctl MANAGED BLOCK m\n# BEGIN streamctl MANAGED BLOCK m\ny\n# END streamctl MANAGED BLOCK m\n";
    expect(composeBlock({ path: ".npmrc", mark: "m", payloadRegion: "z\n", currentContent: current }))
      .toEqual({ ok: false, reason: "duplicated or unbalanced markers for \"m\"" });
  });

  it("flags a block with no END marker", () => {
    const current = "# BEGIN streamctl MANAGED BLOCK m\nx\n";
    expect(composeBlock({ path: ".npmrc", mark: "m", payloadRegion: "z\n", currentContent: current }))
      .toEqual({ ok: false, reason: "duplicated or unbalanced markers for \"m\"" });
  });

  it("flags END before BEGIN", () => {
    const current = "# END streamctl MANAGED BLOCK m\nx\n# BEGIN streamctl MANAGED BLOCK m\n";
    expect(composeBlock({ path: ".npmrc", mark: "m", payloadRegion: "z\n", currentContent: current }))
      .toEqual({ ok: false, reason: "END marker precedes BEGIN for \"m\"" });
  });
});

describe("composeBlock: comment syntaxes", () => {
  it("// for TS", () => {
    const result = composeBlock({ path: "eslint.config.ts", mark: "core", payloadRegion: "x\n", currentContent: null });
    expect(result).toEqual({
      ok: true,
      content: "// BEGIN streamctl MANAGED BLOCK core\nx\n// END streamctl MANAGED BLOCK core\n",
    });
  });

  it("<!-- --> for markdown", () => {
    const result = composeBlock({ path: "README.md", mark: "core", payloadRegion: "x\n", currentContent: null });
    expect(result).toEqual({
      ok: true,
      content: "<!-- BEGIN streamctl MANAGED BLOCK core -->\nx\n<!-- END streamctl MANAGED BLOCK core -->\n",
    });
  });
});

describe("composeBlock: newline preservation", () => {
  it("keeps a CRLF file on CRLF and converts the payload region to match", () => {
    const current = "head\r\n# BEGIN streamctl MANAGED BLOCK core\r\nOLD\r\n# END streamctl MANAGED BLOCK core\r\ntail\r\n";
    const result = composeBlock({ path: ".gitignore", mark: "core", payloadRegion: "L1\nL2\n", currentContent: current });
    expect(result.ok).toBe(true);
    if (!result.ok)
      return;
    expect(result.content).toBe(
      "head\r\n# BEGIN streamctl MANAGED BLOCK core\r\nL1\r\nL2\r\n# END streamctl MANAGED BLOCK core\r\ntail\r\n",
    );
  });
});
