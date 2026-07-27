import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StreamctlError } from "../src/errors";
import { resolvePayload } from "../src/payload/resolve";

/** Can this platform/user create symlinks at all? Windows often can't. */
function symlinksSupported(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "streamctl-symprobe-"));
  try {
    writeFileSync(join(dir, "t"), "x");
    symlinkSync(join(dir, "t"), join(dir, "l"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const canSymlink = symlinksSupported();

describe.skipIf(!canSymlink)("payload read symlink-escape guard", () => {
  let pkgDir: string;

  beforeEach(async () => {
    pkgDir = await mkdtemp(join(tmpdir(), "streamctl-sym-payload-"));
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@acme/payload", version: "1.0.0" }));
    const presets = join(pkgDir, "presets");
    await mkdir(join(presets, "nested"), { recursive: true });
    await writeFile(join(presets, "ok.txt"), "hello\n");
    // The bait: a file outside presets/ that both symlinks below try to reach.
    await writeFile(join(pkgDir, "secret.txt"), "SECRET\n");
    await symlink(join(pkgDir, "secret.txt"), join(presets, "escape.txt"));
    // Symlinked directory in the middle of the path. An lstat on the final component
    // alone would walk straight past this one, which is why we realpath instead.
    await symlink(pkgDir, join(presets, "nested", "up"));
  });

  afterEach(async () => {
    await rm(pkgDir, { recursive: true, force: true });
  });

  async function read(source: string): Promise<string> {
    const payload = await resolvePayload(pkgDir, "@acme/payload", "1.0.0", { resolvePackageDir: () => pkgDir });
    return payload.read(source);
  }

  it("reads an ordinary preset file", async () => {
    expect(await read("ok.txt")).toBe("hello\n");
  });

  it("rejects a symlink in the final component that points out of presets/", async () => {
    const error = await read("escape.txt").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).toContain("symlink escape");
  });

  it("rejects a path routed through a symlinked directory", async () => {
    const error = await read("nested/up/secret.txt").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).toContain("symlink escape");
  });
});
