import type { ManagedFile, StreamctlConfig } from "../src/config/types";
import type { PayloadHandle } from "../src/payload/resolve";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/engine/check";
import { compose } from "../src/engine/compose";
import { validateStructured } from "../src/engine/structural";
import { runSync } from "../src/engine/sync";
import { StreamctlError } from "../src/errors";
import { isStructuredPath } from "../src/paths";

const config: StreamctlConfig = { package: "@acme/payload", base: "base", version: "1.0.0", profile: "nuxt-4" };

/** A `full` `.json` target whose payload template is deliberately not valid JSON. */
const BROKEN_JSON_FILE: ManagedFile = { path: "broken.json", strategy: "full", source: "base/broken.json" };

function stubPayload(files: Record<string, string>): PayloadHandle {
  return {
    version: "1.0.0",
    async read(source) {
      if (!(source in files)) {
        throw new Error(`missing fixture source: ${source}`);
      }
      return files[source] as string;
    },
    async list() {
      return Object.keys(files).sort();
    },
  };
}

const payload = stubPayload({
  "manifest.json": JSON.stringify({ schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" }),
  "base/preset.json": JSON.stringify({ name: "base", files: [BROKEN_JSON_FILE] }),
  "base/broken.json": "{ \"a\": 1, ", // truncated, so it will not parse
});

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "streamctl-structural-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("validateStructured", () => {
  it("recognizes structured extensions", () => {
    for (const path of ["a.json", "a.jsonc", "a.json5", "a.yaml", "a.yml"]) {
      expect(isStructuredPath(path)).toBe(true);
    }
    expect(isStructuredPath("a.ts")).toBe(false);
    expect(isStructuredPath(".editorconfig")).toBe(false);
  });

  it("passes valid JSON and YAML, rejects malformed", () => {
    expect(validateStructured("a.json", "{ \"a\": 1 }")).toEqual({ ok: true });
    expect(validateStructured("a.yaml", "a: 1\nb: 2\n")).toEqual({ ok: true });
    expect(validateStructured("a.txt", "{ not json")).toEqual({ ok: true });

    const badJson = validateStructured("a.json", "{ \"a\": 1, ");
    expect(badJson.ok).toBe(false);
    const badYaml = validateStructured("a.yaml", "a: [1, 2"); // unterminated flow collection
    expect(badYaml.ok).toBe(false);
  });

  it("keeps the .json/.jsonc duplicate-key guard", () => {
    // Duplicate keys are the guard drift detection actually leans on. Loosening the
    // json5 and multi-doc yaml handling below must leave this one alone.
    expect(validateStructured("a.json", "{ \"a\": 1, \"a\": 2 }").ok).toBe(false);
    expect(validateStructured("a.jsonc", "// c\n{ \"a\": 1, \"a\": 2 }").ok).toBe(false);
    expect(validateStructured("a.jsonc", "// c\n{ \"a\": 1, }").ok).toBe(true);
  });

  // `.json5` used to go through the JSONC parser, which rejects the very syntax json5
  // exists for (unquoted keys, single quotes). That was a permanent fault on valid
  // output, and `--force` could not bypass it. Pulling in a json5 dep is not worth it,
  // so json5 is text here, matching what `contentEquals` already does (it only
  // canonicalizes .json/.jsonc).
  it("does not structurally parse .json5", () => {
    expect(validateStructured("a.json5", "{ unquoted: 'single', trailing: 1, }")).toEqual({ ok: true });
    // Text means text: even junk is not this gate's business to reject.
    expect(validateStructured("a.json5", "{ not json at all")).toEqual({ ok: true });
  });

  it("still treats .json5 as structured for path classification", () => {
    // Load-bearing beyond this module: manifest/schema.ts bans `block` strategy on
    // structured paths via isStructuredPath. Dropping .json5 from the classifier to
    // skip parsing would silently legalize block-on-.json5. Skipping happens in the
    // format switch instead, so this stays true.
    expect(isStructuredPath("a.json5")).toBe(true);
  });

  // Single-doc `parseYaml` throws on `---`-separated input ("please use
  // parseAllDocuments"), which made valid k8s manifests fault permanently.
  it("accepts a valid multi-document yaml stream", () => {
    expect(validateStructured("a.yaml", "a: 1\n---\nb: 2\n")).toEqual({ ok: true });
    expect(validateStructured("a.yml", "---\na: 1\n---\nb: 2\n---\nc: 3\n")).toEqual({ ok: true });
  });

  it("faults when any one document in the stream is broken", () => {
    // First doc valid, second unterminated. parseAllDocuments does NOT throw here, it
    // reports per-doc `errors`, so an unchecked call would pass this silently.
    const result = validateStructured("a.yaml", "a: 1\n---\nb: [1, 2\n");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBeTruthy();
  });

  it("treats an empty yaml target as valid", () => {
    expect(validateStructured("a.yaml", "")).toEqual({ ok: true });
  });
});

describe("compose: structural-error", () => {
  it("downgrades a composed .json target with unparseable output", async () => {
    const result = await compose(BROKEN_JSON_FILE, payload, null, config);
    expect(result.status).toBe("structural-error");
    if (result.status !== "structural-error")
      throw new Error("expected structural-error");
    expect(result.path).toBe("broken.json");
    expect(result.reason).toBeTruthy();
  });

  it("composes json5-only syntax without faulting", async () => {
    const file: ManagedFile = { path: "a.json5", strategy: "full", source: "base/a.json5" };
    const json5 = "{ unquoted: 'single', trailing: 1, }\n";
    const result = await compose(file, stubPayload({ "base/a.json5": json5 }), null, config);
    expect(result.status).toBe("composed");
  });

  it("composes a multi-document yaml target", async () => {
    const file: ManagedFile = { path: "k8s.yaml", strategy: "full", source: "base/k8s.yaml" };
    const docs = "kind: Service\n---\nkind: Deployment\n";
    const result = await compose(file, stubPayload({ "base/k8s.yaml": docs }), null, config);
    expect(result.status).toBe("composed");
  });

  it("faults naming the file when a later yaml document is broken", async () => {
    const file: ManagedFile = { path: "k8s.yaml", strategy: "full", source: "base/k8s.yaml" };
    const docs = "kind: Service\n---\nkind: [Deployment\n";
    const result = await compose(file, stubPayload({ "base/k8s.yaml": docs }), null, config);
    expect(result.status).toBe("structural-error");
    if (result.status !== "structural-error")
      throw new Error("expected structural-error");
    expect(result.path).toBe("k8s.yaml");
    expect(result.reason).toContain("document 2");
  });
});

describe("check / sync: structural faults", () => {
  it("check reports the fault as DRIFT_DETECTED", async () => {
    const error = await runCheck(cwd, payload, config).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("DRIFT_DETECTED");
    const details = (error as StreamctlError).details as { inSync: boolean; structuralFaults: { path: string; reason: string }[] };
    expect(details.inSync).toBe(false);
    expect(details.structuralFaults).toHaveLength(1);
    expect(details.structuralFaults[0]?.path).toBe("broken.json");
  });

  it("sync writes nothing for a structural fault and raises CONFLICTS_PENDING", async () => {
    const error = await runSync({ cwd, payload, config, managedFiles: [BROKEN_JSON_FILE] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFLICTS_PENDING");
    const details = (error as StreamctlError).details as { written: string[]; conflicted: { path: string }[] };
    expect(details.written).toEqual([]);
    expect(details.conflicted.map(c => c.path)).toContain("broken.json");

    expect(await readdir(cwd)).not.toContain("broken.json");
  });

  it("does not flag a structurally valid composed target", async () => {
    const okPayload = stubPayload({
      "manifest.json": JSON.stringify({ schemaVersion: 2, presets: ["base"], profiles: [], defaultBase: "base" }),
      "base/preset.json": JSON.stringify({ name: "base", files: [{ path: "ok.json", strategy: "full", source: "base/ok.json" }] }),
      "base/ok.json": "{ \"a\": 1 }\n",
    });
    await writeFile(join(cwd, "ok.json"), "{ \"a\": 1 }\n");
    const result = await runCheck(cwd, okPayload, config);
    expect(result.structuralFaults).toEqual([]);
    expect(result.inSync).toBe(true);
  });
});
