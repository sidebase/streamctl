import { describe, expect, it } from "vitest";
import { applyJsoncEdits, canonical, contentEquals, getAtPath, isPlainObject, strictParseJsonc } from "../src/engine/jsonc";

describe("strictParseJsonc", () => {
  it("accepts comments and trailing commas", () => {
    const result = strictParseJsonc(`{
  // line comment
  "a": 1, /* block comment */
  "b": [1, 2,],
}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ a: 1, b: [1, 2] });
    }
  });

  it("reports the byte offset when the document is malformed", () => {
    const result = strictParseJsonc(`{ "a": }`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/at offset \d+/);
    }
  });

  // A duplicate key would silently mask owned-key drift, so it has to be an error.
  it("rejects duplicate keys", () => {
    const result = strictParseJsonc(`{ "a": 1, "a": 2 }`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("duplicate key");
      expect(result.reason).toContain("\"a\"");
    }
  });

  it("looks for duplicates in nested objects too", () => {
    const result = strictParseJsonc(`{ "outer": { "x": 1, "x": 2 } }`);
    expect(result.ok).toBe(false);
  });

  // VS Code's `files.encoding: utf8bom`, Visual Studio and Notepad all write one. It
  // used to fail as `InvalidSymbol at offset 0`, turning a merge target into a fault
  // that --force could not clear.
  it("accepts a leading UTF-8 BOM", () => {
    const result = strictParseJsonc(`\uFEFF{\n  "a": 1\n}\n`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ a: 1 });
    }
  });

  it("still finds duplicate keys behind a BOM", () => {
    expect(strictParseJsonc(`\uFEFF{ "a": 1, "a": 2 }`).ok).toBe(false);
  });
});

describe("applyJsoncEdits (the merge/reconcile edit path)", () => {
  it("edits the target key and leaves comments and surrounding bytes alone", () => {
    const src = `{
  // keep this comment
  "a": 1,
  "b": 2
}`;
    const out = applyJsoncEdits(src, [{ path: ["a"], value: 99 }], "\n");
    expect(out).toContain("// keep this comment");
    expect(out).toContain("\"b\": 2");
    const parsed = strictParseJsonc(out);
    expect(parsed.ok && parsed.value).toEqual({ a: 99, b: 2 });
  });

  it("adds a new nested key without touching siblings", () => {
    const out = applyJsoncEdits(`{ "x": { "y": 1 } }`, [{ path: ["x", "z"], value: 2 }], "\n");
    const parsed = strictParseJsonc(out);
    expect(parsed.ok && parsed.value).toEqual({ x: { y: 1, z: 2 } });
  });

  // Each insert shifts the offsets of the ones after it; folding has to account for that.
  it("folds multiple edits", () => {
    const out = applyJsoncEdits(`{ "a": 1, "b": 2 }`, [
      { path: ["a"], value: 10 },
      { path: ["c"], value: 3 },
    ], "\n");
    const parsed = strictParseJsonc(out);
    expect(parsed.ok && parsed.value).toEqual({ a: 10, b: 2, c: 3 });
  });
});

describe("getAtPath", () => {
  it("walks nested objects and array indices", () => {
    expect(getAtPath({ a: { b: [10, 20] } }, ["a", "b", 1])).toBe(20);
  });

  it("undefined for a missing segment, or a root that is not an object", () => {
    expect(getAtPath({ a: 1 }, ["a", "b"])).toBeUndefined();
    expect(getAtPath(null, ["a"])).toBeUndefined();
    expect(getAtPath("string", ["a"])).toBeUndefined();
  });
});

describe("isPlainObject", () => {
  it("is true only for non-array, non-null objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("string")).toBe(false);
    expect(isPlainObject(42)).toBe(false);
  });
});

describe("canonical", () => {
  it("ignores object key order but respects array order", () => {
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });

  it("encodes primitives and undefined distinctly", () => {
    expect(canonical(undefined)).toBe(" undefined");
    expect(canonical(null)).toBe("null");
    expect(canonical("x")).toBe("\"x\"");
    expect(canonical(3)).toBe("3");
  });
});

describe("contentEquals", () => {
  it("ignores cosmetic differences for valid JSON", () => {
    expect(contentEquals("x.json", `{ "a": 1 }\n`, `{"a":1}`)).toBe(true);
  });

  it("treats a duplicate-key JSON as drift, not in-sync", () => {
    // `actual` last-wins-parses equal to `expected`, but the duplicate `a` key
    // must fail strict parse and register as drift rather than mask it.
    expect(contentEquals("x.json", `{ "a": 9, "b": 2, "a": 1 }`, `{ "a": 1, "b": 2 }`)).toBe(false);
  });
});
