import type { ManagedFile, StreamctlConfig } from "../src/config/types";
import type { PayloadHandle } from "../src/payload/resolve";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectDrift } from "../src/engine/drift";
import { composeMerge } from "../src/engine/merge";

const TEMPLATE = JSON.stringify(
  {
    "eslint.useFlatConfig": true,
    "editor.formatOnSave": true,
    "editor.fontSize": 14,
  },
  null,
  2,
);

function merge(current: string | null, projectFields: string[] = ["editor.fontSize"]) {
  return composeMerge({ path: ".vscode/settings.json", payloadTemplate: TEMPLATE, projectFields, currentContent: current });
}

describe("composeMerge", () => {
  it("updates owned keys to payload values", () => {
    const result = merge("{\n  \"eslint.useFlatConfig\": false\n}\n");
    if (!result.ok)
      throw new Error(result.reason);
    expect(JSON.parse(result.content)["eslint.useFlatConfig"]).toBe(true);
    expect(JSON.parse(result.content)["editor.formatOnSave"]).toBe(true);
  });

  it("never writes projectFields paths", () => {
    const result = merge("{\n  \"editor.fontSize\": 18\n}\n");
    if (!result.ok)
      throw new Error(result.reason);
    expect(JSON.parse(result.content)["editor.fontSize"]).toBe(18);
  });

  it("leaves comments and project-only keys alone", () => {
    const current = [
      "{",
      "  // project preference, must survive",
      "  \"workbench.colorTheme\": \"Solarized\",",
      "  \"eslint.useFlatConfig\": false",
      "}",
      "",
    ].join("\n");
    const result = merge(current);
    if (!result.ok)
      throw new Error(result.reason);
    expect(result.content).toContain("// project preference, must survive");
    expect(result.content).toContain("\"workbench.colorTheme\": \"Solarized\"");
    expect(result.content).toContain("\"eslint.useFlatConfig\": true");
  });

  it("tolerates a trailing comma, which is valid JSONC", () => {
    const result = merge("{\n  \"eslint.useFlatConfig\": true,\n}\n");
    expect(result.ok).toBe(true);
    if (!result.ok)
      throw new Error(result.reason);
    expect(result.content).toContain("\"eslint.useFlatConfig\": true");
  });

  // Last-wins parsing would let a duplicate hide drift in an owned key.
  it("rejects duplicate keys", () => {
    const result = merge("{\n  \"eslint.useFlatConfig\": true,\n  \"eslint.useFlatConfig\": false\n}\n");
    expect(result.ok).toBe(false);
    if (result.ok)
      throw new Error("expected failure");
    expect(result.reason).toContain("duplicate key");
  });

  it("rejects duplicate keys nested inside an owned object", () => {
    const result = merge(
      "{\n  \"editor.codeActionsOnSave\": {\n    \"source.fixAll\": true,\n    \"source.fixAll\": false\n  }\n}\n",
    );
    expect(result.ok).toBe(false);
    if (result.ok)
      throw new Error("expected failure");
    expect(result.reason).toContain("duplicate key");
  });

  // The payload declares an object at an owned path but the consumer holds a scalar,
  // array or null there. jsonc-parser cannot descend to the owned leaf and throws, and
  // that throw used to escape as a raw internal error (UNKNOWN, exit 1) rather than the
  // recoverable fault the caller is designed to handle.
  describe("owned-key type mismatch", () => {
    // Nested rather than the flat dotted keys above, because `editor` has to be a real
    // parent object for the mismatch to exist at all.
    const NESTED = JSON.stringify({ editor: { formatOnSave: true } }, null, 2);
    const mergeNested = (current: string): ReturnType<typeof composeMerge> =>
      composeMerge({ path: ".vscode/settings.json", payloadTemplate: NESTED, projectFields: [], currentContent: current });

    it.each([
      { shape: "scalar", current: `{ "editor": "custom" }`, parser: "type string" },
      { shape: "array", current: `{ "editor": [1, 2] }`, parser: "type array" },
      { shape: "null", current: `{ "editor": null }`, parser: "type null" },
      { shape: "number", current: `{ "editor": 5 }`, parser: "type number" },
    ])("faults, naming the path, when the consumer holds a $shape", ({ current, parser }) => {
      const result = mergeNested(current);
      expect(result.ok).toBe(false);
      if (result.ok)
        throw new Error("expected a merge fault, not composed content");
      expect(result.reason).toContain(`type mismatch at "editor.formatOnSave"`);
      expect(result.reason).toContain(parser); // parser's own message stays appended
    });

    it("composes normally when the types line up", () => {
      const result = mergeNested(`{ "editor": { "fontSize": 14 } }`);
      expect(result.ok).toBe(true);
      if (!result.ok)
        throw new Error(result.reason);
      // The owned leaf lands and the project's sibling leaf under the same key survives.
      expect(JSON.parse(result.content)).toEqual({ editor: { fontSize: 14, formatOnSave: true } });
    });
  });

  it("is idempotent", () => {
    const first = merge("{\n  \"workbench.colorTheme\": \"Solarized\"\n}\n");
    if (!first.ok)
      throw new Error(first.reason);
    const second = merge(first.content);
    if (!second.ok)
      throw new Error(second.reason);
    expect(second.content).toBe(first.content);
  });

  it("composes into a fresh file with all owned keys", () => {
    const result = merge(null);
    if (!result.ok)
      throw new Error(result.reason);
    const value = JSON.parse(result.content);
    expect(value["eslint.useFlatConfig"]).toBe(true);
    expect(value["editor.formatOnSave"]).toBe(true);
    // A projectField is never seeded from the template, not even into a brand-new file.
    expect("editor.fontSize" in value).toBe(false);
  });

  // defu reads a `null` in the primary object as unset and takes the project's value as
  // the default, so an owned key pinned to `null` used to compare against itself and
  // never produce an edit.
  describe("a null owned value", () => {
    const NULLABLE = JSON.stringify({ "editor.defaultFormatter": null, "editor.formatOnSave": true });
    const mergeNull = (current: string | null) =>
      composeMerge({ path: ".vscode/settings.json", payloadTemplate: NULLABLE, projectFields: [], currentContent: current });

    it("overwrites the project's value", () => {
      const result = mergeNull(`{\n  "editor.defaultFormatter": "esbenp.prettier-vscode"\n}\n`);
      if (!result.ok)
        throw new Error(result.reason);
      expect(JSON.parse(result.content)["editor.defaultFormatter"]).toBeNull();
    });

    it("is written into a fresh file", () => {
      const result = mergeNull(null);
      if (!result.ok)
        throw new Error(result.reason);
      const value = JSON.parse(result.content);
      expect("editor.defaultFormatter" in value).toBe(true);
      expect(value["editor.defaultFormatter"]).toBeNull();
    });

    it("stays idempotent", () => {
      const first = mergeNull(`{\n  "editor.defaultFormatter": "x"\n}\n`);
      if (!first.ok)
        throw new Error(first.reason);
      const second = mergeNull(first.content);
      if (!second.ok)
        throw new Error(second.reason);
      expect(second.content).toBe(first.content);
    });
  });

  // A BOM-prefixed target used to fail strict parse outright, so the file became a
  // permanent fault. The BOM has to survive the merge: dropping it rewrites the
  // consumer's file encoding behind their back.
  it("merges a BOM-prefixed target and keeps the BOM", () => {
    const result = merge(`\uFEFF{\n  "eslint.useFlatConfig": false\n}\n`);
    if (!result.ok)
      throw new Error(result.reason);
    expect(result.content.startsWith("\uFEFF")).toBe(true);
    expect(JSON.parse(result.content.slice(1))["eslint.useFlatConfig"]).toBe(true);
  });
});

describe("merge drift", () => {
  const config: StreamctlConfig = { package: "@acme/payload", base: "base", version: "1.0.0", profile: "n4" };
  const payload: PayloadHandle = {
    version: "1.0.0",
    async read() {
      return TEMPLATE;
    },
    async list() {
      return [];
    },
  };
  const file: ManagedFile = {
    path: ".vscode/settings.json",
    strategy: "merge",
    source: "base/vscode/settings.json",
    projectFields: ["editor.fontSize"],
  };

  let root: string;
  const write = async (path: string, content: string): Promise<void> => {
    const abs = join(root, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "streamctl-merge-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("drifts when an owned key differs", async () => {
    await write(".vscode/settings.json", "{ \"eslint.useFlatConfig\": false, \"editor.formatOnSave\": true }\n");
    const report = await detectDrift([file], payload, config, root);
    expect(report.inSync).toBe(false);
    expect(report.drift).toEqual([{ path: ".vscode/settings.json", kind: "content" }]);
  });

  it("ignores a projectField that differs", async () => {
    await write(".vscode/settings.json", "{ \"eslint.useFlatConfig\": true, \"editor.formatOnSave\": true, \"editor.fontSize\": 99 }\n");
    const report = await detectDrift([file], payload, config, root);
    expect(report).toEqual({ inSync: true, drift: [], structuralFaults: [] });
  });

  it("a duplicate-key file is a conflict, never in-sync", async () => {
    await write(".vscode/settings.json", "{ \"eslint.useFlatConfig\": true, \"eslint.useFlatConfig\": false }\n");
    const report = await detectDrift([file], payload, config, root);
    expect(report.inSync).toBe(false);
    expect(report.drift[0]).toMatchObject({ path: ".vscode/settings.json", kind: "extra" });
    expect(report.drift[0]?.reason).toContain("duplicate key");
  });
});
