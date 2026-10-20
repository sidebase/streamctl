import { basename, extname } from "node:path";

// Pure comment-syntax map importing only `node:path`, so both `engine/*` and the
// public `manifest/*` subpath (directive parser) can use it without engine imports.

/** Marker comment delimiters for a file format. Line comments leave `suffix` empty. */
export interface CommentSyntax {
  prefix: string;
  suffix: string;
}

const HASH: CommentSyntax = { prefix: "# ", suffix: "" };
const SLASH: CommentSyntax = { prefix: "// ", suffix: "" };
const HTML: CommentSyntax = { prefix: "<!-- ", suffix: " -->" };

export function commentSyntaxFor(path: string): CommentSyntax {
  const base = basename(path).toLowerCase();
  if (base === "dockerfile") {
    return HASH;
  }
  switch (extname(base)) {
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".ts":
    case ".mts":
    case ".cts":
    case ".json":
    case ".jsonc":
    case ".json5":
      // JSONC-tolerant config files (oxlintrc/tsconfig) use `//`, never `#`.
      return SLASH;
    case ".html":
    case ".htm":
    case ".md":
    case ".markdown":
    case ".vue":
      return HTML;
    // `#` covers npmrc, gitignore, editorconfig, yaml/yml, toml, ini, conf, sh.
    default:
      return HASH;
  }
}
