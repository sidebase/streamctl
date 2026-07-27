import { describe, expect, it } from "vitest";
import { parsePorcelain, rebaseToPrefix } from "../src/engine/git";

// `-z` output is NUL-delimited (each entry ends with \0), status is `XY `, and
// paths come through raw: no surrounding quotes, no C-escaping.
describe("parsePorcelain (git status --porcelain -z)", () => {
  it("captures a tracked modified file", () => {
    expect([...parsePorcelain(" M src/a.ts\0")]).toEqual(["src/a.ts"]);
  });

  it("keeps a rename's new path and consumes the old one", () => {
    // Field order is reversed under -z: `R  <new>\0<old>\0`, working-tree path first.
    const set = parsePorcelain("R  new-name.ts\0old-name.ts\0");
    expect(set.has("new-name.ts")).toBe(true);
    expect(set.has("old-name.ts")).toBe(false);
    expect(set.size).toBe(1);
  });

  it("passes quotes, unicode and spaces through untouched", () => {
    const weird = "src/naïve dir/файл \"q\".ts";
    expect(parsePorcelain(` M ${weird}\0`).has(weird)).toBe(true);
  });

  it("skips untracked (??) and ignored (!!) entries", () => {
    expect([...parsePorcelain("?? untracked.ts\0!! ignored.ts\0 M kept.ts\0")]).toEqual(["kept.ts"]);
  });

  it("ignores short/garbage fields and the trailing empty field", () => {
    expect([...parsePorcelain(" M ok.ts\0x\0\0")]).toEqual(["ok.ts"]);
  });

  it("parses a mixed batch", () => {
    // modified, both-modified, a rename (new `d.ts`, old `c.ts`), an untracked.
    const set = parsePorcelain(" M a.ts\0MM b.ts\0R  d.ts\0c.ts\0?? e.ts\0");
    expect([...set].sort()).toEqual(["a.ts", "b.ts", "d.ts"]);
  });

  it("returns an empty set for empty output", () => {
    expect(parsePorcelain("").size).toBe(0);
  });
});

// Porcelain paths are repo-root-relative; managed paths are cwd-relative. In a
// workspace package the two only line up once the `--show-prefix` value is
// stripped back off.
describe("rebaseToPrefix", () => {
  it("strips the prefix from paths under the cwd subtree", () => {
    const set = rebaseToPrefix([".vscode/settings.json", "src/a.ts"].map(p => `packages/app/${p}`), "packages/app/");
    expect([...set].sort()).toEqual([".vscode/settings.json", "src/a.ts"]);
  });

  it("is the identity at the repo root, where the prefix is empty", () => {
    expect([...rebaseToPrefix([".editorconfig", "src/a.ts"], "")].sort()).toEqual([".editorconfig", "src/a.ts"]);
  });

  it("drops paths outside the cwd subtree", () => {
    const set = rebaseToPrefix(["packages/app/a.ts", "packages/other/b.ts", "root.ts"], "packages/app/");
    expect([...set]).toEqual(["a.ts"]);
  });

  it("does not swallow a sibling whose name merely starts with the prefix", () => {
    // `packages/app-other/...` starts with `packages/app` but not with `packages/app/`.
    // The trailing slash is what makes the containment check exact.
    expect(rebaseToPrefix(["packages/app-other/a.ts"], "packages/app/").size).toBe(0);
  });

  it("rebases a rename's new path", () => {
    const set = rebaseToPrefix(parsePorcelain("R  packages/app/new.ts\0packages/app/old.ts\0"), "packages/app/");
    expect([...set]).toEqual(["new.ts"]);
  });

  it("handles a whole porcelain batch end to end", () => {
    const stdout = " M packages/app/a.ts\0R  packages/app/d.ts\0packages/app/c.ts\0 M packages/other/x.ts\0?? packages/app/e.ts\0";
    expect([...rebaseToPrefix(parsePorcelain(stdout), "packages/app/")].sort()).toEqual(["a.ts", "d.ts"]);
  });

  it("returns an empty set for no paths", () => {
    expect(rebaseToPrefix([], "packages/app/").size).toBe(0);
  });
});
