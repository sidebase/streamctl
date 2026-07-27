import type { ParseError } from "jsonc-parser";
import { extname } from "node:path";
import { applyEdits, modify, parse, printParseErrorCode, visit } from "jsonc-parser";

export type JsonPath = (string | number)[];

export interface JsoncEdit {
  path: JsonPath;
  value: unknown;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isIndexable(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * First duplicate object key at any nesting level, or `null`.
 *
 * `jsonc-parser`'s `parse` is last-wins and silently accepts duplicates, which
 * masks drift: a repeated owned key whose later value differs reads as in-sync
 * while the active value is really the project's. `visit` tracks keys per object.
 */
function findDuplicateKey(text: string): string | null {
  const stack: Set<string>[] = [];
  let duplicate: string | null = null;
  visit(text, {
    onObjectBegin() {
      stack.push(new Set());
    },
    onObjectProperty(property) {
      const keys = stack.at(-1);
      if (!keys) {
        return;
      }
      if (keys.has(property)) {
        duplicate ??= property;
      } else {
        keys.add(property);
      }
    },
    onObjectEnd() {
      stack.pop();
    },
  });
  return duplicate;
}

/**
 * Rejects duplicate keys, tolerates trailing commas, comments and a leading BOM. All
 * are valid JSONC and common in real `.vscode/settings.json` / `tsconfig.json`;
 * rejecting trailing commas blocked adoption outright, and a BOM (VS Code's
 * `files.encoding: utf8bom`, Visual Studio, Notepad) turned a `merge` target into a
 * fault `--force` could not clear. The duplicate-key guard is the one that actually
 * protects drift detection.
 *
 * Only the parse skips the BOM. `applyJsoncEdits` handles BOM-prefixed text natively
 * and preserves it, so the consumer's encoding survives a merge untouched.
 */
export function strictParseJsonc(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const errors: ParseError[] = [];
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const value = parse(body, errors, { allowTrailingComma: true, disallowComments: false });
  const error = errors[0];
  if (error) {
    return { ok: false, reason: `${printParseErrorCode(error.error)} at offset ${error.offset}` };
  }
  const duplicate = findDuplicateKey(body);
  if (duplicate) {
    return { ok: false, reason: `duplicate key ${JSON.stringify(duplicate)}` };
  }
  return { ok: true, value };
}

/**
 * Folded so each edit recomputes offsets against the running text. This is the
 * robust form of end-to-start application: earlier offsets always stay valid, and
 * unlike a reverse-sorted batch, multiple insertions cannot corrupt separators.
 * Only the edited keys change; surrounding bytes and comments survive.
 */
export function applyJsoncEdits(text: string, edits: JsoncEdit[], eol: string): string {
  const formattingOptions = { tabSize: 2, insertSpaces: true, eol };
  let out = text;
  for (const edit of edits) {
    out = applyEdits(out, modify(out, edit.path, edit.value, { formattingOptions }));
  }
  return out;
}

export function getAtPath(root: unknown, path: JsonPath): unknown {
  let current = root;
  for (const segment of path) {
    if (!isIndexable(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/** Order-independent canonical form, so key order and formatting are not differences. */
export function canonical(value: unknown): string {
  if (value === undefined) {
    return " undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (!isPlainObject(value)) {
    return JSON.stringify(value) ?? "null"; // primitives incl. null
  }
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

function isJsonc(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === ".json" || ext === ".jsonc";
}

/** Trailing whitespace, trailing blank lines and CRLF are all cosmetic. */
function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/**
 * Compare on-disk vs expected content, ignoring cosmetic differences. JSONC goes
 * by strict-parsed canonical value, everything else by normalized text. A file
 * that fails strict parse (invalid JSONC, or a duplicate key — which last-wins
 * parsing would otherwise mask) can never equal a valid expected one, so it
 * registers as drift.
 */
export function contentEquals(path: string, actual: string, expected: string): boolean {
  if (isJsonc(path)) {
    const a = strictParseJsonc(actual);
    const b = strictParseJsonc(expected);
    return a.ok && b.ok && canonical(a.value) === canonical(b.value);
  }
  return normalizeText(actual) === normalizeText(expected);
}
