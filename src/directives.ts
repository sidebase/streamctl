import { commentSyntaxFor } from "./comment-syntax";
import { StreamctlError } from "./errors";
import { structuredFormat } from "./paths";

// Pure template-directive parser importing no engine code, so the public
// `manifest/*` subpath can re-export it.

export type DirectiveReason
  = | "unknown-directive"
    | "missing-condition"
    | "malformed-condition"
    | "unopened-end"
    | "unopened-else"
    | "duplicate-else"
    | "unclosed-if"
    | "end-mismatch"
    | "else-mismatch"
    | "nested-if"
    | "indent-mismatch"
    | "body-outdented"
    | "structured-json"
    | "merge-strategy"
    | "schema-version"
    | "undeclared-condition"
    | "object-condition"
    | "unevaluable-value";

export interface DirectiveErrorDetails {
  file: string;
  line: number;
  reason: DirectiveReason;
  directive?: string;
  condition?: string;
  expected?: string;
  openedAt?: number;
  found?: string;
}

export interface DirectiveBlock {
  /** Condition path without `!`. */
  condition: string;
  negated: boolean;
  /** 1-based. */
  ifLine: number;
  elseLine?: number;
  endLine: number;
}

type Verb = "if" | "else" | "end";

interface DirectiveLine {
  line: number;
  indent: string;
  verb: Verb;
  rawCondition: string;
}

interface OpenBlock {
  raw: string;
  line: number;
  indent: string;
  elseLine?: number;
}

const CONDITION_RE = /^!?[\w-]+(?:\.[\w-]+)*$/;
const RESERVED_VERBS = new Set(["each", "insert", "raw"]);

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(path: string, line: number, reason: DirectiveReason, message: string, extra: Partial<DirectiveErrorDetails> = {}): never {
  const details: DirectiveErrorDetails = { file: path, line, reason, ...extra };
  throw new StreamctlError("CONFIG_INVALID", `${path}:${line}: ${message}`, details);
}

/** Matches any line starting with the file's comment token followed by `streamctl:`. */
function buildCandidateMatcher(path: string): { candidate: RegExp; suffix: string } {
  const { prefix, suffix } = commentSyntaxFor(path);
  const token = escapeRegExp(prefix.trim());
  return { candidate: new RegExp(`^([ \\t]*)${token}[ \\t]*streamctl:(.*)$`), suffix: suffix.trim() };
}

function isVerb(value: string): value is Verb {
  return value === "if" || value === "else" || value === "end";
}

function parseDirective(path: string, lineNo: number, indent: string, rawRest: string, suffix: string): DirectiveLine {
  let rest = rawRest.trimEnd();
  const hasSuffix = suffix === "" || rest.endsWith(suffix);
  if (suffix !== "" && hasSuffix) {
    rest = rest.slice(0, -suffix.length).trimEnd();
  }
  const verbEnd = rest.search(/\s/);
  const verb = verbEnd === -1 ? rest : rest.slice(0, verbEnd);
  const words = (verbEnd === -1 ? "" : rest.slice(verbEnd)).split(/\s+/).filter(word => word !== "");

  if (!isVerb(verb)) {
    const hint = RESERVED_VERBS.has(verb)
      ? ` "streamctl:${verb}" is reserved for a future version.`
      : " Expected streamctl:if, streamctl:else or streamctl:end.";
    fail(path, lineNo, "unknown-directive", `unknown directive "streamctl:${verb}".${hint}`, { directive: verb });
  }
  if (!hasSuffix) {
    fail(path, lineNo, "malformed-condition", `"streamctl:${verb}" must be closed with "${suffix}" on the same line.`, { directive: verb });
  }
  const [rawCondition, ...extra] = words;
  if (rawCondition === undefined) {
    fail(path, lineNo, "missing-condition", `"streamctl:${verb}" requires a condition.`, { directive: verb });
  }
  if (extra.length > 0) {
    fail(path, lineNo, "malformed-condition", `"streamctl:${verb} ${rawCondition}" is followed by unexpected text "${extra.join(" ")}".`, { directive: verb, condition: rawCondition });
  }
  if (!CONDITION_RE.test(rawCondition)) {
    fail(path, lineNo, "malformed-condition", `"${rawCondition}" is not a valid condition; use a dotted config path such as "features.prisma", optionally prefixed with "!".`, { directive: verb, condition: rawCondition });
  }
  return { line: lineNo, indent, verb, rawCondition };
}

/** YAML lint: no non-blank body line may sit left of (or diverge from) the directive indent. */
function checkYamlBody(path: string, lines: string[], open: OpenBlock, endLine: number): void {
  for (let lineNo = open.line + 1; lineNo < endLine; lineNo++) {
    if (lineNo === open.elseLine) {
      continue;
    }
    const content = (lines[lineNo - 1] ?? "").replace(/\r$/, "");
    if (content.trim() !== "" && !content.startsWith(open.indent)) {
      fail(path, lineNo, "body-outdented", `line is indented less than its "streamctl:if ${open.raw}" directive (opened at line ${open.line}).`, { condition: open.raw, openedAt: open.line });
    }
  }
}

function closeBlock(open: OpenBlock, endLine: number): DirectiveBlock {
  const negated = open.raw.startsWith("!");
  const block: DirectiveBlock = {
    condition: negated ? open.raw.slice(1) : open.raw,
    negated,
    ifLine: open.line,
    endLine,
  };
  if (open.elseLine !== undefined) {
    block.elseLine = open.elseLine;
  }
  return block;
}

/** Parse and validate every directive in `text`; throws `CONFIG_INVALID` on the first error. */
export function scanDirectives(text: string, path: string): DirectiveBlock[] {
  const { candidate, suffix } = buildCandidateMatcher(path);
  const format = structuredFormat(path);
  const lines = text.split("\n");
  const blocks: DirectiveBlock[] = [];
  let open: OpenBlock | null = null;

  for (const [index, rawLine] of lines.entries()) {
    const lineNo = index + 1;
    const match = candidate.exec(rawLine.replace(/\r$/, ""));
    if (match === null) {
      continue;
    }
    if (format === "json" || format === "json5") {
      fail(path, lineNo, "structured-json", "template directives are not supported in JSON files.");
    }
    const directive = parseDirective(path, lineNo, match[1] ?? "", match[2] ?? "", suffix);
    const { verb, rawCondition, indent } = directive;
    const extra = { directive: verb, condition: rawCondition };

    if (verb === "if") {
      if (open !== null) {
        fail(path, lineNo, "nested-if", `"streamctl:if ${rawCondition}" cannot be nested inside the open block "${open.raw}" (opened at line ${open.line}).`, { ...extra, openedAt: open.line });
      }
      open = { raw: rawCondition, line: lineNo, indent };
      continue;
    }

    if (open === null) {
      fail(path, lineNo, verb === "end" ? "unopened-end" : "unopened-else", `"streamctl:${verb} ${rawCondition}" has no open "streamctl:if" block.`, extra);
    }
    if (verb === "else" && open.elseLine !== undefined) {
      fail(path, lineNo, "duplicate-else", `block "${open.raw}" already has an else branch at line ${open.elseLine} (opened at line ${open.line}).`, { ...extra, openedAt: open.line });
    }
    if (rawCondition !== open.raw) {
      fail(path, lineNo, verb === "end" ? "end-mismatch" : "else-mismatch", `"streamctl:${verb} ${rawCondition}" does not match the open block "${open.raw}" (opened at line ${open.line}).`, { ...extra, expected: open.raw, openedAt: open.line });
    }
    if (indent !== open.indent) {
      fail(path, lineNo, "indent-mismatch", `"streamctl:${verb} ${rawCondition}" must use the same indentation as its "streamctl:if" (opened at line ${open.line}).`, { ...extra, openedAt: open.line });
    }

    if (verb === "else") {
      open.elseLine = lineNo;
      continue;
    }
    if (format === "yaml") {
      checkYamlBody(path, lines, open, lineNo);
    }
    blocks.push(closeBlock(open, lineNo));
    open = null;
  }

  if (open !== null) {
    fail(path, open.line, "unclosed-if", `"streamctl:if ${open.raw}" is never closed with "streamctl:end ${open.raw}".`, { directive: "if", condition: open.raw, openedAt: open.line });
  }
  return blocks;
}
