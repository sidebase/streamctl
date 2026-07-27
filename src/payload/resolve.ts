import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { detectPm } from "../engine/pm";
import { errnoCode, isErrnoException, StreamctlError } from "../errors";
import { relativizeForDisplay } from "../paths";

/** The transport is an interface so tests/fixtures can inject their own preset source (see {@link resolvePayload}). */
export interface PayloadHandle {
  readonly version: string;
  /** Read a template by its `ManagedFile.source` path (relative to `presets/`). */
  read: (source: string) => Promise<string>;
  /** Enumerate every template path under `presets/` (posix-style, sorted). */
  list: () => Promise<string[]>;
}

export interface ResolvePayloadOptions {
  /** Defaults to a `node_modules` walk; the injection seam lets tests point at a fixture package without a real install. */
  resolvePackageDir?: (cwd: string) => string | null;
}

/** Walk up from `cwd` looking for an installed `packageName` under `node_modules`. */
function findInstalledConfigDir(cwd: string, packageName: string): string | null {
  const segments = packageName.split("/");
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, "node_modules", ...segments);
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * The raw error message is deliberately dropped: Node embeds the absolute path
 * in it (`ENOENT: … open '/abs/path'`), which is the leak this exists to prevent.
 */
function payloadFileError(cwd: string, abs: string, describe: (rel: string, missing: boolean) => string, error: unknown): StreamctlError {
  const rel = relativizeForDisplay(cwd, abs);
  const missing = isErrnoException(error) && error.code === "ENOENT";
  return new StreamctlError("PAYLOAD_INVALID", describe(rel, missing), { path: rel, code: errnoCode(error) });
}

function createHandle(cwd: string, packageDir: string, version: string): PayloadHandle {
  const presetsDir = join(packageDir, "presets");
  const readSource = async (source: string, abs: string): Promise<string> => {
    try {
      return await readFile(abs, "utf8");
    } catch (error) {
      throw payloadFileError(cwd, abs, (rel, missing) => missing
        ? `Payload does not ship the template for source "${source}" (expected at ${rel}).`
        : `Payload template for source "${source}" could not be read (${rel}).`, error);
    }
  };
  return {
    version,
    async read(source) {
      const full = resolve(presetsDir, source);
      const rel = relative(presetsDir, full);
      // Lexical fast-fail: blocks "../" in the source string.
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new StreamctlError(
          "CONFIG_INVALID",
          `Payload source "${source}" escapes the presets/ directory.`,
          { source },
        );
      }

      // `readFile` follows symlinks, so a symlink packed in presets/ could read
      // outside the payload. Realpath both the target and the presets/ root, then
      // re-check containment; a bare lstat on the last component would miss an
      // intermediate symlink. A non-existent file's realpath throws ENOENT: let
      // the normal missing-file read surface it, not a symlink-escape error.
      let realFull: string;
      let realPresets: string;
      try {
        realFull = await realpath(full);
        realPresets = await realpath(presetsDir);
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          return readSource(source, full);
        }
        throw payloadFileError(cwd, full, rel => `Payload template for source "${source}" could not be read (${rel}).`, error);
      }
      const realRel = relative(realPresets, realFull);
      if (realRel.startsWith("..") || isAbsolute(realRel)) {
        throw new StreamctlError(
          "CONFIG_INVALID",
          `Payload source "${source}" resolves outside the presets/ directory (symlink escape).`,
          { source },
        );
      }
      return readSource(source, realFull);
    },
    async list() {
      let entries: Dirent[];
      try {
        entries = await readdir(presetsDir, { recursive: true, withFileTypes: true });
      } catch (error) {
        throw payloadFileError(cwd, presetsDir, (rel, missing) => missing
          ? `Payload has no presets/ directory (expected at ${rel}); is this a streamctl payload?`
          : `Payload presets/ directory could not be read (${rel}).`, error);
      }
      return entries
        .filter(entry => entry.isFile())
        .map(entry => relative(presetsDir, join(entry.parentPath, entry.name)).split(sep).join("/"))
        .sort();
    },
  };
}

/**
 * The install *is* the payload delivery, so this reads straight from
 * `node_modules` (no tag fetch, no extraction, no cache, no network).
 */
export async function resolvePayload(
  cwd: string,
  packageName: string,
  pinnedVersion: string,
  opts: ResolvePayloadOptions = {},
): Promise<PayloadHandle> {
  const packageDir = (opts.resolvePackageDir ?? (dir => findInstalledConfigDir(dir, packageName)))(cwd);
  if (!packageDir) {
    const pm = await detectPm(cwd);
    throw new StreamctlError(
      "CONFIG_PKG_MISSING",
      `${packageName} is not installed. Run \`${pm.name} install\`.`,
    );
  }

  const manifestPath = join(packageDir, "package.json");
  // Repo-relative: the absolute node_modules path would leak in `--json` details.
  const relManifest = relativizeForDisplay(cwd, manifestPath);

  // An EACCES/EISDIR here would otherwise surface as an uncoded UNKNOWN. The
  // message is dropped since Node embeds the absolute path in it, which would
  // defeat the relativized path above.
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(manifestPath, "utf8");
  } catch (error) {
    throw new StreamctlError(
      "CONFIG_INVALID",
      `Failed to read ${relManifest} (${errnoCode(error)}).`,
      { path: relManifest, code: errnoCode(error) },
    );
  }

  let manifest: { version?: string };
  try {
    manifest = JSON.parse(manifestRaw) as { version?: string };
  } catch (error) {
    throw new StreamctlError(
      "CONFIG_INVALID",
      `package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { path: relManifest },
    );
  }
  const version = manifest.version;
  if (version !== pinnedVersion) {
    const pm = await detectPm(cwd);
    throw new StreamctlError(
      "CONFIG_VERSION_MISMATCH",
      `${packageName} is installed at ${version ?? "an unknown version"} but the pinned version is ${pinnedVersion}. Run \`streamctl upgrade\` or \`${pm.name} install\`.`,
      { installed: version, pinned: pinnedVersion },
    );
  }

  return createHandle(cwd, packageDir, version);
}
