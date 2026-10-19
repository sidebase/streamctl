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
  /** Offending value: a type name (`unevaluable-value`) or the declared `schemaVersion` (`schema-version`). */
  found?: string | number;
  /** Minimum `schemaVersion` (`schema-version`). */
  required?: number;
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

type DetailExtras = Omit<Partial<DirectiveErrorDetails>, "file" | "line" | "reason">;

function fail(path: string, line: number, reason: DirectiveReason, message: string, extra: DetailExtras = {}): never {
  const details: DirectiveErrorDetails = { ...extra, file: path, line, reason };
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

interface DirectiveParseError {
  reason: DirectiveReason;
  message: string;
  extra: DetailExtras;
}

function parseDirective(lineNo: number, indent: string, rawRest: string, suffix: string): DirectiveLine | DirectiveParseError {
  let rest = rawRest.trimEnd();
  const hasSuffix = suffix === "" || rest.endsWith(suffix);
  if (suffix !== "" && hasSuffix) {
    rest = rest.slice(0, -suffix.length).trimEnd();
  }
  const verbEnd = rest.search(/\s/);
  const verb = verbEnd === -1 ? rest : rest.slice(0, verbEnd);
  const words = (verbEnd === -1 ? "" : rest.slice(verbEnd)).split(/\s+/).filter(word => word !== "");

  if (!isVerb(verb)) {
    let hint = " Expected streamctl:if, streamctl:else or streamctl:end.";
    if (RESERVED_VERBS.has(verb)) {
      hint = ` "streamctl:${verb}" is reserved for a future version.`;
    } else if (verb === "" && words[0] !== undefined && isVerb(words[0])) {
      hint = ` No space is allowed after "streamctl:"; write "streamctl:${words[0]}".`;
    }
    return { reason: "unknown-directive", message: `unknown directive "streamctl:${verb}".${hint}`, extra: { directive: verb } };
  }
  if (!hasSuffix) {
    return { reason: "malformed-condition", message: `"streamctl:${verb}" must be closed with "${suffix}" on the same line.`, extra: { directive: verb } };
  }
  const [rawCondition, ...extra] = words;
  if (rawCondition === undefined) {
    return { reason: "missing-condition", message: `"streamctl:${verb}" requires a condition.`, extra: { directive: verb } };
  }
  if (extra.length > 0) {
    return { reason: "malformed-condition", message: `"streamctl:${verb} ${rawCondition}" is followed by unexpected text "${extra.join(" ")}".`, extra: { directive: verb, condition: rawCondition } };
  }
  if (!CONDITION_RE.test(rawCondition)) {
    return { reason: "malformed-condition", message: `"${rawCondition}" is not a valid condition; use a dotted config path such as "features.prisma", optionally prefixed with "!".`, extra: { directive: verb, condition: rawCondition } };
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

/**
 * Line (1-based) of the first well-formed `if`/`else`/`end` directive, ignoring block
 * structure; any other `streamctl:` comment counts as content. Payloads below
 * schemaVersion 5 use this, so prose comments keep rendering verbatim while a real
 * directive still trips the schemaVersion gate.
 */
export function findDirectiveLine(text: string, path: string): number | undefined {
  const { candidate, suffix } = buildCandidateMatcher(path);
  for (const [index, rawLine] of text.split("\n").entries()) {
    const match = candidate.exec(rawLine.replace(/\r$/, ""));
    if (match !== null && !("reason" in parseDirective(index + 1, match[1] ?? "", match[2] ?? "", suffix))) {
      return index + 1;
    }
  }
  return undefined;
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
    const directive = parseDirective(lineNo, match[1] ?? "", match[2] ?? "", suffix);
    if ("reason" in directive) {
      fail(path, lineNo, directive.reason, directive.message, directive.extra);
    }
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

/**
 * Drop every directive line, the `if` branch of false blocks and the `else` branch
 * of true blocks. Always rescans; other lines are kept byte for byte.
 */
export function applyDirectives(text: string, path: string, evaluate: (conditionPath: string) => boolean): string {
  const blocks = scanDirectives(text, path);
  if (blocks.length === 0) {
    return text;
  }
  // 0-based indices; block line numbers are 1-based.
  const drop = new Set<number>();
  for (const block of blocks) {
    const kept = evaluate(block.condition) !== block.negated;
    const branchEnd = block.elseLine ?? block.endLine;
    const [from, to] = kept ? [branchEnd, block.endLine] : [block.ifLine, branchEnd];
    drop.add(block.ifLine - 1);
    drop.add(block.endLine - 1);
    if (block.elseLine !== undefined) {
      drop.add(block.elseLine - 1);
    }
    for (let lineNo = from + 1; lineNo < to; lineNo++) {
      drop.add(lineNo - 1);
    }
  }
  return text.split("\n").filter((_, index) => !drop.has(index)).join("\n");
}
