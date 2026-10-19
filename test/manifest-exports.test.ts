import { describe, expect, it } from "vitest";
import { StreamctlError } from "../src/errors";
import { commentSyntaxFor, DIRECTIVES_MIN_SCHEMA_VERSION, scanDirectives, SUPPORTED_SCHEMA_VERSION } from "../src/manifest";

describe("@sidebase/streamctl/manifest exports", () => {
  it("exposes the directive scanner and comment syntax", () => {
    expect(scanDirectives("# streamctl:if ci.lint\n# streamctl:end ci.lint\n", "ci.yaml")).toEqual([
      { condition: "ci.lint", negated: false, ifLine: 1, endLine: 2 },
    ]);
    expect(commentSyntaxFor("README.md")).toEqual({ prefix: "<!-- ", suffix: " -->" });
  });

  it("throws StreamctlError with a reason for directive mistakes", () => {
    let caught: unknown;
    try {
      scanDirectives("# streamctl:if ci.lint\n", "ci.yaml");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StreamctlError);
    expect(caught).toMatchObject({ code: "CONFIG_INVALID", details: { file: "ci.yaml", line: 1, reason: "unclosed-if" } });
  });

  it("exposes the schema constants", () => {
    expect(SUPPORTED_SCHEMA_VERSION).toBe(5);
    expect(DIRECTIVES_MIN_SCHEMA_VERSION).toBe(5);
  });
});
