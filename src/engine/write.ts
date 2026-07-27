import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { errnoCode, isErrnoException, StreamctlError } from "../errors";
import { relativizeForDisplay } from "../paths";

/**
 * Read a UTF-8 file, or `null` when it does not exist (ENOENT). Any other fs error
 * (EACCES, EISDIR, ELOOP) becomes a `READ_FAILED` carrying only the relativized path
 * and errno code — never the raw fs message, which embeds the absolute path.
 */
export async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    const relPath = relativizeForDisplay(process.cwd(), path);
    throw new StreamctlError(
      "READ_FAILED",
      `Failed to read ${relPath} (${errnoCode(error)}).`,
      { path: relPath, code: errnoCode(error) },
    );
  }
}

/**
 * Atomically write a file: `write-file-atomic` writes a temp file, fsyncs, and
 * renames over the target, so an interrupted write never leaves a half-written
 * config and the original is untouched on failure.
 */
export async function atomicWrite(absPath: string, content: string): Promise<void> {
  try {
    await mkdir(dirname(absPath), { recursive: true });
    await writeFileAtomic(absPath, content);
  } catch (error) {
    // Repo-relative path for the error: the absolute FS path would leak into
    // `--json` output. The write itself still uses `absPath`.
    const relPath = relativizeForDisplay(process.cwd(), absPath);
    throw new StreamctlError(
      "WRITE_FAILED",
      `Failed to write ${relPath} (${errnoCode(error)}).`,
      { path: relPath, code: errnoCode(error) },
    );
  }
}
