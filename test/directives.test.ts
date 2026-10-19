import type { DirectiveErrorDetails } from "../src/directives";
import { describe, expect, it } from "vitest";
import { scanDirectives } from "../src/directives";
import { StreamctlError } from "../src/errors";

function scanError(text: string, path = "ci.yaml"): { message: string; details: DirectiveErrorDetails } {
  try {
    scanDirectives(text, path);
  } catch (error) {
    if (!(error instanceof StreamctlError)) {
      throw error;
    }
    expect(error.code).toBe("CONFIG_INVALID");
    return { message: error.message, details: error.details as DirectiveErrorDetails };
  }
  throw new Error("expected scanDirectives to throw");
}

describe("scanDirectives: content", () => {
  it("returns [] for text without directives", () => {
    expect(scanDirectives("a: 1\nb: 2\n", "ci.yaml")).toEqual([]);
    expect(scanDirectives("", "ci.yaml")).toEqual([]);
  });

  it("treats a mid-line streamctl: as content", () => {
    expect(scanDirectives("run: echo \"# streamctl:if x\"\n", "ci.yaml")).toEqual([]);
  });

  it("ignores directives written with another file's comment token", () => {
    expect(scanDirectives("// streamctl:if x\n", "ci.yaml")).toEqual([]);
    expect(scanDirectives("# streamctl:if x\n", "app.ts")).toEqual([]);
    expect(scanDirectives("# streamctl:if x\n", "README.md")).toEqual([]);
  });

  it("leaves plain JSON templates untouched", () => {
    expect(scanDirectives("{\n  \"a\": \"# streamctl:if x\"\n}\n", "tsconfig.json")).toEqual([]);
  });
});

describe("scanDirectives: blocks", () => {
  it("parses an if/end block with # syntax", () => {
    expect(scanDirectives("a\n# streamctl:if features.prisma\nb\n# streamctl:end features.prisma\nc\n", "ci.yaml")).toEqual([
      { condition: "features.prisma", negated: false, ifLine: 2, endLine: 4 },
    ]);
  });

  it("parses // syntax", () => {
    expect(scanDirectives("// streamctl:if a\nx\n// streamctl:end a\n", "eslint.config.ts")).toEqual([
      { condition: "a", negated: false, ifLine: 1, endLine: 3 },
    ]);
  });

  it("parses <!-- --> syntax", () => {
    expect(scanDirectives("<!-- streamctl:if a -->\nx\n<!-- streamctl:end a-->\n", "README.md")).toEqual([
      { condition: "a", negated: false, ifLine: 1, endLine: 3 },
    ]);
  });

  it("derives negated and condition from a ! prefix", () => {
    expect(scanDirectives("# streamctl:if !a.b\n# streamctl:end !a.b\n", ".gitignore")).toEqual([
      { condition: "a.b", negated: true, ifLine: 1, endLine: 2 },
    ]);
  });

  it("records the else line", () => {
    expect(scanDirectives("# streamctl:if a\nx\n# streamctl:else a\ny\n# streamctl:end a\n", ".npmrc")).toEqual([
      { condition: "a", negated: false, ifLine: 1, elseLine: 3, endLine: 5 },
    ]);
  });

  it("allows empty bodies and empty else branches", () => {
    expect(scanDirectives("# streamctl:if a\n# streamctl:else a\n# streamctl:end a\n", ".npmrc")).toEqual([
      { condition: "a", negated: false, ifLine: 1, elseLine: 2, endLine: 3 },
    ]);
  });

  it("parses several sequential blocks", () => {
    const blocks = scanDirectives("# streamctl:if a\n# streamctl:end a\n# streamctl:if b\n# streamctl:end b\n", ".npmrc");
    expect(blocks.map(block => block.condition)).toEqual(["a", "b"]);
  });

  it("tolerates a trailing \\r", () => {
    expect(scanDirectives("# streamctl:if a\r\nx\r\n# streamctl:end a\r\n", "ci.yaml")).toEqual([
      { condition: "a", negated: false, ifLine: 1, endLine: 3 },
    ]);
  });

  it("accepts indented directives and tolerates spaces after the token", () => {
    expect(scanDirectives("  #streamctl:if a\n  x\n  #   streamctl:end a  \n", "ci.yaml")).toHaveLength(1);
  });
});

describe("scanDirectives: errors", () => {
  it("rejects an unknown verb", () => {
    const { details, message } = scanError("# streamctl: the CLI\n");
    expect(details).toMatchObject({ file: "ci.yaml", line: 1, reason: "unknown-directive" });
    expect(message).toMatch(/^ci\.yaml:1: /);
    expect(message).not.toContain("reserved");
  });

  it("hints at reserved verbs", () => {
    for (const verb of ["each", "insert", "raw"]) {
      const { details, message } = scanError(`# streamctl:${verb} a\n`);
      expect(details).toMatchObject({ reason: "unknown-directive", directive: verb });
      expect(message).toContain("reserved for a future version");
    }
  });

  it("rejects a missing condition", () => {
    expect(scanError("# streamctl:if\n").details).toMatchObject({ line: 1, reason: "missing-condition" });
    expect(scanError("# streamctl:if a\n# streamctl:end\n").details).toMatchObject({ line: 2, reason: "missing-condition" });
  });

  it("rejects a malformed condition", () => {
    expect(scanError("# streamctl:if a..b\n").details).toMatchObject({ reason: "malformed-condition", condition: "a..b" });
    expect(scanError("# streamctl:if a=b\n").details).toMatchObject({ reason: "malformed-condition" });
  });

  it("rejects extra tokens", () => {
    expect(scanError("# streamctl:if a b\n").details).toMatchObject({ reason: "malformed-condition", condition: "a" });
  });

  it("rejects a missing --> in HTML-comment files", () => {
    expect(scanError("<!-- streamctl:if a\n", "README.md").details).toMatchObject({ line: 1, reason: "malformed-condition" });
  });

  it("rejects end with no open block", () => {
    expect(scanError("x\n# streamctl:end a\n").details).toMatchObject({ line: 2, reason: "unopened-end" });
  });

  it("rejects else with no open block", () => {
    expect(scanError("# streamctl:else a\n").details).toMatchObject({ line: 1, reason: "unopened-else" });
  });

  it("rejects a second else", () => {
    const { details } = scanError("# streamctl:if a\n# streamctl:else a\n# streamctl:else a\n# streamctl:end a\n");
    expect(details).toMatchObject({ line: 3, reason: "duplicate-else", openedAt: 1 });
  });

  it("rejects a nested if", () => {
    const { details } = scanError("# streamctl:if a\n# streamctl:if b\n# streamctl:end b\n# streamctl:end a\n");
    expect(details).toMatchObject({ line: 2, reason: "nested-if", openedAt: 1 });
  });

  it("rejects an if without end, reporting the if line", () => {
    expect(scanError("x\n# streamctl:if a\ny\n").details).toMatchObject({ line: 2, reason: "unclosed-if", openedAt: 2 });
  });

  it("rejects an end naming a different condition", () => {
    const { details, message } = scanError("# streamctl:if features.prisma\n# streamctl:end features.prism\n");
    expect(details).toEqual({
      file: "ci.yaml",
      line: 2,
      reason: "end-mismatch",
      directive: "end",
      condition: "features.prism",
      expected: "features.prisma",
      openedAt: 1,
    });
    expect(message).toBe("ci.yaml:2: \"streamctl:end features.prism\" does not match the open block \"features.prisma\" (opened at line 1).");
  });

  it("compares names byte-exact including !", () => {
    expect(scanError("# streamctl:if !a\n# streamctl:end a\n").details).toMatchObject({ reason: "end-mismatch", expected: "!a" });
  });

  it("rejects an else naming a different condition", () => {
    const { details } = scanError("# streamctl:if a\n# streamctl:else b\n# streamctl:end a\n");
    expect(details).toMatchObject({ line: 2, reason: "else-mismatch", expected: "a", openedAt: 1 });
  });

  it("rejects end indent differing from if indent", () => {
    expect(scanError("  # streamctl:if a\n# streamctl:end a\n", ".npmrc").details).toMatchObject({ line: 2, reason: "indent-mismatch" });
  });

  it("rejects else indent differing from if indent", () => {
    expect(scanError("# streamctl:if a\n  # streamctl:else a\n# streamctl:end a\n", ".npmrc").details).toMatchObject({ line: 2, reason: "indent-mismatch" });
  });

  it("rejects directives in JSON targets", () => {
    for (const path of ["tsconfig.json", ".oxlintrc.jsonc", "a.json5"]) {
      expect(scanError("// streamctl:if a\n// streamctl:end a\n", path).details).toMatchObject({ file: path, line: 1, reason: "structured-json" });
    }
  });

  it("rejects outdented YAML body lines in either branch", () => {
    expect(scanError("  # streamctl:if a\n  x: 1\ny: 2\n  # streamctl:end a\n").details).toMatchObject({ line: 3, reason: "body-outdented" });
    expect(scanError("  # streamctl:if a\n  # streamctl:else a\ny: 2\n  # streamctl:end a\n", "ci.yml").details).toMatchObject({ line: 3, reason: "body-outdented" });
  });

  it("allows blank and deeper-indented YAML body lines", () => {
    expect(scanDirectives("  # streamctl:if a\n\n    x: 1\n  y: 2\n  # streamctl:end a\n", "ci.yaml")).toHaveLength(1);
  });

  it("does not apply the YAML body rule to other files", () => {
    expect(scanDirectives("  # streamctl:if a\nx\n  # streamctl:end a\n", ".npmrc")).toHaveLength(1);
  });
});
