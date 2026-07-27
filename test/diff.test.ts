import { describe, expect, it } from "vitest";
import { renderDiff } from "../src/engine/diff";

const ESC = "";

describe("renderDiff", () => {
  it("renders plain +/- markers with no ANSI by default", () => {
    const out = renderDiff("f.txt", "root = true\n", "root = false\n");
    expect(out).toContain("--- f.txt");
    expect(out).toContain("+++ f.txt");
    expect(out).toContain("-root = true");
    expect(out).toContain("+root = false");
    expect(out).not.toContain(ESC);
  });

  it("emits ANSI color only when explicitly enabled", () => {
    const out = renderDiff("f.txt", "a\n", "b\n", { color: true });
    expect(out).toContain(`${ESC}[31m`);
    expect(out).toContain(`${ESC}[32m`);
  });

  it("context lines get a leading space and stay uncolored", () => {
    const out = renderDiff("f.txt", "keep\nold\n", "keep\nnew\n", { color: true });
    expect(out).toContain(" keep");
    expect(out).not.toContain(`${ESC}[31m keep`);
  });
});
