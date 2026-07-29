import type { StreamctlConfig } from "../src/config/types";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPayloadManifest } from "../src/engine/manifest";
import { reconcileVersions } from "../src/engine/versions";
import { StreamctlError } from "../src/errors";
import { resolvePayload } from "../src/payload/resolve";

const asError = (e: unknown): StreamctlError => e as StreamctlError;

/**
 * Does `chmod 0o000` actually revoke read on this machine? Windows can't revoke
 * read that way and root ignores the bit outright. Without this probe, both
 * environments read the file happily and the EACCES expectations fail.
 */
function chmodCanRevokeRead(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "streamctl-chmodprobe-"));
  try {
    const file = join(dir, "probe");
    writeFileSync(file, "x");
    chmodSync(file, 0o000);
    readFileSync(file, "utf8");
    return false; // still readable at 0o000, so: Windows ACLs, or running as root
  } catch {
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const canRevokeRead = chmodCanRevokeRead();

// A payload with no presets/ tree used to reach loadPayloadManifest as a raw readdir
// ENOENT: code UNKNOWN, exit 1, absolute path in the message. It is converted at the
// payload boundary now, so the loader only ever sees the documented coded error.
describe("payload without a presets/ directory", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "streamctl-nopresets-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reaches loadPayloadManifest as a coded error, not a raw ENOENT", async () => {
    const dir = join(root, "node_modules", "@acme", "payload");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@acme/payload", version: "1.0.0" }));
    const payload = await resolvePayload(root, "@acme/payload", "1.0.0");

    const error = await loadPayloadManifest(payload).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect(asError(error).code).toBe("PAYLOAD_INVALID");
    expect(asError(error).message).toContain("presets");
    expect(`${asError(error).message} ${JSON.stringify(asError(error).details ?? {})}`).not.toContain(root);
  });
});

// Reading the installed payload's package.json to check its version.
describe("malformed installed package.json", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "streamctl-manifest-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("wraps the JSON.parse failure with the manifest path", async () => {
    const dir = join(root, "node_modules", "@acme", "payload");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), "{ not valid json");

    const error = await resolvePayload(root, "@acme/payload", "1.0.0").catch(asError);
    expect(error).toBeInstanceOf(StreamctlError);
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("package.json is not valid JSON");
    // details carry a repo-relative path, never the absolute node_modules one.
    expect(error.details).toEqual({ path: join("node_modules", "@acme", "payload", "package.json") });
  });

  it("wraps an unreadable manifest as CONFIG_INVALID rather than UNKNOWN", async () => {
    const dir = join(root, "node_modules", "@acme", "payload");
    // A directory where package.json should be, so readFile throws EISDIR. Unlike a
    // chmod-based unreadable file, this fails regardless of the runner's uid.
    await mkdir(join(dir, "package.json"), { recursive: true });

    const error = await resolvePayload(root, "@acme/payload", "1.0.0").catch(asError);
    expect(error).toBeInstanceOf(StreamctlError);
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("Failed to read");
    expect(error.details).toEqual({ path: join("node_modules", "@acme", "payload", "package.json"), code: "EISDIR" });
  });

  it.skipIf(!canRevokeRead)("keeps the absolute path out of an EACCES failure", async () => {
    // The EISDIR case above cannot catch this. Node's EISDIR message carries no path,
    // whereas EACCES and ENOENT embed the absolute one ("EACCES: ... open '/abs/path'").
    // Splicing that raw message into the error text is what leaked it.
    const dir = join(root, "node_modules", "@acme", "payload");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@acme/payload", version: "1.0.0" }));
    await chmod(join(dir, "package.json"), 0o000);

    const error = await resolvePayload(root, "@acme/payload", "1.0.0").catch(asError);
    await chmod(join(dir, "package.json"), 0o644); // restore so cleanup works

    expect(error).toBeInstanceOf(StreamctlError);
    expect(error.code).toBe("CONFIG_INVALID");
    const serialized = `${error.message} ${JSON.stringify(error.details ?? {})}`;
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(tmpdir());
    expect(error.details).toEqual({ path: join("node_modules", "@acme", "payload", "package.json"), code: "EACCES" });
  });
});

// Same class of failure, but on the consumer's own package.json during reconcile.
describe("malformed package.json in reconcileVersions", () => {
  const config: StreamctlConfig = { package: "@acme/payload", base: "base", version: "1.0.0", profile: "nuxt-4" };
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "streamctl-versions-err-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("reports the relative path on a syntax error", async () => {
    await writeFile(join(cwd, "package.json"), "{ \"a\": }");
    const error = await reconcileVersions({ cwd, config, baseline: {}, hasEslintConfig: true, apply: false }).catch(asError);
    expect(error).toBeInstanceOf(StreamctlError);
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("package.json is not valid JSON");
    expect(error.details).toEqual({ path: "package.json" });
  });

  it("rejects a top-level array", async () => {
    await writeFile(join(cwd, "package.json"), "[1, 2, 3]");
    const error = await reconcileVersions({ cwd, config, baseline: {}, hasEslintConfig: true, apply: false }).catch(asError);
    expect(error).toBeInstanceOf(StreamctlError);
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("must be a JSON object");
    expect(error.details).toEqual({ path: "package.json" });
  });
});
