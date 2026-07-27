import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWrite } from "../src/engine/write";
import { StreamctlError } from "../src/errors";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "streamctl-write-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("atomicWrite", () => {
  it("creates parent directories and writes the file", async () => {
    const target = join(root, "nested/dir/file.txt");
    await atomicWrite(target, "hello\n");
    expect(await readFile(target, "utf8")).toBe("hello\n");
  });

  it("throws WRITE_FAILED and leaves no partial state behind", async () => {
    // A directory sits on the target path, so the rename cannot land a file.
    const target = join(root, "blocked");
    await mkdir(target);

    const error = await atomicWrite(target, "data").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("WRITE_FAILED");
    // Surfaced paths are relative to cwd so error output doesn't leak the tmpdir.
    const details = (error as StreamctlError).details as { path: string };
    expect(isAbsolute(details.path)).toBe(false);

    expect((await stat(target)).isDirectory()).toBe(true);
  });

  it("overwrites an existing file in place", async () => {
    const target = join(root, "keep.txt");
    await writeFile(target, "original\n");
    await atomicWrite(target, "updated\n");
    expect(await readFile(target, "utf8")).toBe("updated\n");
  });
});
