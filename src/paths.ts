import { basename, extname, isAbsolute, relative } from "node:path";

// Pure path classifier importing only `node:path`, so both `engine/*` and
// `manifest/*` can depend on it without cycles. The parse-time validator
// (`validateStructured`) lives in `engine/structural.ts`.

/**
 * `json5` is its own member rather than folded into `json`: the two are different
 * grammars (unquoted keys, single quotes) and no JSON5 parser ships with the CLI,
 * so `validateStructured` skips it. It stays a format rather than `null` so
 * `isStructuredPath` keeps reporting `.json5` as structured, which the manifest
 * schema relies on to ban the `block` strategy on structured targets.
 */
export type StructuralFormat = "json" | "json5" | "yaml";

const JSON_EXTENSIONS = new Set([".json", ".jsonc"]);
const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);

export function structuredFormat(path: string): StructuralFormat | null {
  const ext = extname(path).toLowerCase();
  if (JSON_EXTENSIONS.has(ext)) {
    return "json";
  }
  if (ext === ".json5") {
    return "json5";
  }
  if (YAML_EXTENSIONS.has(ext)) {
    return "yaml";
  }
  return null;
}

export function isStructuredPath(path: string): boolean {
  return structuredFormat(path) !== null;
}

/**
 * Repo-relative form of an absolute path, for error details that must never leak an
 * absolute FS path. Falls back to the basename when no relative form exists: across
 * Windows drive letters (`C:\…` vs `D:\…`) `relative` returns an absolute path, so
 * without the fallback the result would leak the root on that platform. A same-drive
 * `../…` result is kept since it leaks nothing.
 */
export function relativizeForDisplay(cwd: string, absPath: string): string {
  const rel = relative(cwd, absPath);
  return isAbsolute(rel) ? basename(absPath) : rel;
}
