import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamctlError } from "../src/errors";
import { resolvePayload } from "../src/payload/resolve";

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

let root: string;

/**
 * No absolute path may reach the user, neither in the message nor in the `details`
 * that become the `--json` envelope. Asserted against the serialized form, since
 * that is what actually ships.
 */
function expectNoAbsolutePath(error: StreamctlError): void {
  const serialized = `${error.message} ${JSON.stringify(error.details ?? {})}`;
  expect(serialized).not.toContain(root);
  expect(serialized).not.toContain(tmpdir());
  expect(serialized).not.toMatch(/(^|[\s"'(])\/[\w.-]+\//);
}

/** Install a fixture `@acme/payload` under `root/node_modules` and return its directory. */
async function installFixtureConfig(version: string): Promise<string> {
  const dir = join(root, "node_modules", "@acme", "payload");
  await mkdir(join(dir, "presets", "base"), { recursive: true });
  await mkdir(join(dir, "presets", "nuxt-app"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@acme/payload", version }));
  await writeFile(join(dir, "presets", "base", "npmrc"), "registry-line\n");
  await writeFile(join(dir, "presets", "base", "preset.json"), "{}\n");
  await writeFile(join(dir, "presets", "nuxt-app", "preset.json"), "{}\n");
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "streamctl-payload-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolvePayload", () => {
  it("exposes the installed package's presets/ tree", async () => {
    await installFixtureConfig("1.2.3");
    const payload = await resolvePayload(root, "@acme/payload", "1.2.3");

    expect(payload.version).toBe("1.2.3");
    expect(await payload.list()).toEqual([
      "base/npmrc",
      "base/preset.json",
      "nuxt-app/preset.json",
    ]);
    expect(await payload.read("base/npmrc")).toBe("registry-line\n");
  });

  it("resolves from a parent directory's node_modules", async () => {
    await installFixtureConfig("1.2.3");
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    const payload = await resolvePayload(nested, "@acme/payload", "1.2.3");
    expect(payload.version).toBe("1.2.3");
  });

  it("errors when the package is not installed at all", async () => {
    const error = await resolvePayload(root, "@acme/payload", "1.2.3").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_PKG_MISSING");
  });

  it("reports both versions when the install does not match the pin", async () => {
    await installFixtureConfig("1.0.0");
    const error = await resolvePayload(root, "@acme/payload", "2.0.0").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_VERSION_MISMATCH");
    expect((error as StreamctlError).details).toEqual({ installed: "1.0.0", pinned: "2.0.0" });
  });

  // A preset listing a source the payload does not ship (or a payload with no presets/
  // tree at all) used to reject with a raw Node ENOENT: code UNKNOWN, exit 1, and the
  // absolute node_modules path leaked into both the message and the --json envelope.
  describe("missing payload files", () => {
    it("names the missing source and stays relative", async () => {
      await installFixtureConfig("1.2.3");
      const payload = await resolvePayload(root, "@acme/payload", "1.2.3");

      const error = await payload.read("base/does-not-exist").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StreamctlError);
      const failure = error as StreamctlError;
      expect(failure.code).toBe("PAYLOAD_INVALID");
      expect(failure.message).toContain("base/does-not-exist");
      expectNoAbsolutePath(failure);
    });

    it("reports a payload with no presets/ directory", async () => {
      const dir = join(root, "node_modules", "@acme", "payload");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@acme/payload", version: "1.2.3" }));
      const payload = await resolvePayload(root, "@acme/payload", "1.2.3");

      const error = await payload.list().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StreamctlError);
      const failure = error as StreamctlError;
      expect(failure.code).toBe("PAYLOAD_INVALID");
      expect(failure.message).toContain("presets");
      expectNoAbsolutePath(failure);
    });

    it.skipIf(!canRevokeRead)("an unreadable source is not a raw fs error", async () => {
      const dir = await installFixtureConfig("1.2.3");
      // 0o000 gives EACCES on read, and Node's own fs message would embed the absolute path.
      await chmod(join(dir, "presets", "base", "npmrc"), 0o000);
      const payload = await resolvePayload(root, "@acme/payload", "1.2.3");

      const error = await payload.read("base/npmrc").catch((e: unknown) => e);
      await chmod(join(dir, "presets", "base", "npmrc"), 0o644); // restore so cleanup works
      expect(error).toBeInstanceOf(StreamctlError);
      const failure = error as StreamctlError;
      expect(failure.code).toBe("PAYLOAD_INVALID");
      expect(failure.message).toContain("base/npmrc");
      expectNoAbsolutePath(failure);
    });
  });

  it("uses the injected resolver and does no lookup of its own", async () => {
    const packageDir = await installFixtureConfig("3.1.4");
    const resolvePackageDir = vi.fn(() => packageDir);
    const payload = await resolvePayload("/nonexistent", "@acme/payload", "3.1.4", { resolvePackageDir });

    expect(resolvePackageDir).toHaveBeenCalledTimes(1);
    expect(resolvePackageDir).toHaveBeenCalledWith("/nonexistent");
    expect(payload.version).toBe("3.1.4");
  });

  it("rejects a source that escapes presets/", async () => {
    await installFixtureConfig("1.2.3");
    const payload = await resolvePayload(root, "@acme/payload", "1.2.3");
    await expect(payload.read("../package.json")).rejects.toThrow(/escapes/);
  });

  it("works when presets/ has files directly at its root", async () => {
    const dir = join(root, "node_modules", "@acme", "payload");
    await mkdir(join(dir, "presets"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@acme/payload", version: "1.2.3" }));
    await writeFile(join(dir, "presets", "marker"), "hi\n");

    const payload = await resolvePayload(root, "@acme/payload", "1.2.3");
    expect(payload.version).toBe("1.2.3");
    expect(await payload.read("marker")).toBe("hi\n");
  });
});
