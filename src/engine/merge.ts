import type { JsoncEdit, JsonPath } from "./jsonc";
import { createDefu } from "defu";
import { StreamctlError } from "../errors";
import { applyJsoncEdits, canonical, getAtPath, isPlainObject, strictParseJsonc } from "./jsonc";

export type MergeResult
  = | { ok: true; content: string }
    | { ok: false; reason: string };

/**
 * defu variant that overrides arrays instead of concatenating them. streamctl owns
 * the arrays it declares (`recommendations` and friends) wholesale. Objects still
 * deep-merge, so a project's extra leaves under an owned key survive.
 */
const mergeOwned = createDefu((obj, key, value) => {
  if (Array.isArray(value)) {
    Reflect.set(obj, key, value);
    return true;
  }
  return false;
});

interface Leaf {
  path: JsonPath;
  value: unknown;
}

function omitKeys(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const drop = new Set(keys);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!drop.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

function collectLeaves(value: unknown, prefix: JsonPath): Leaf[] {
  if (!isPlainObject(value)) {
    return [{ path: prefix, value }];
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return [{ path: prefix, value }];
  }
  return entries.flatMap(([key, child]) => collectLeaves(child, [...prefix, key]));
}

/**
 * Compose the `merge` strategy, a structured JSONC deep-merge for `.vscode/*`.
 *
 * streamctl owns every key the payload declares except those listed in
 * `projectFields`; all other on-disk keys and comments are preserved. Only changed
 * leaves are edited, so unrelated bytes survive and a second compose is
 * byte-identical. Malformed JSONC (trailing comma, duplicate key) is a recoverable
 * fault.
 */
export function composeMerge(opts: {
  path: string;
  payloadTemplate: string;
  projectFields: string[];
  currentContent: string | null;
}): MergeResult {
  const { path, payloadTemplate, projectFields, currentContent } = opts;

  const payloadParse = strictParseJsonc(payloadTemplate);
  if (!payloadParse.ok || !isPlainObject(payloadParse.value)) {
    throw new StreamctlError("CONFIG_INVALID", `merge template "${path}" must be a valid JSON object.`, { path });
  }

  const nl = currentContent?.includes("\r\n") ? "\r\n" : "\n";
  const hasCurrent = currentContent !== null && currentContent.trim() !== "";

  let currentValue: Record<string, unknown> = {};
  if (hasCurrent) {
    const parsed = strictParseJsonc(currentContent as string);
    if (!parsed.ok) {
      return { ok: false, reason: `invalid JSONC in "${path}": ${parsed.reason}` };
    }
    if (!isPlainObject(parsed.value)) {
      return { ok: false, reason: `"${path}" must be a JSON object` };
    }
    currentValue = parsed.value;
  }

  const ownedTree = omitKeys(payloadParse.value, projectFields);
  const desired = mergeOwned(ownedTree, currentValue);

  const edits: JsoncEdit[] = [];
  for (const leaf of collectLeaves(ownedTree, [])) {
    // defu treats a `null` in the primary object as unset and takes the default, i.e.
    // the project's own value — so a payload pinning a key to `null` (a deliberate
    // "clear this setting", valid in `.vscode/settings.json`) compared the project's
    // value against itself and never emitted an edit. `desired` is only load-bearing
    // for empty-object leaves, where the project's extra keys must survive.
    const want = leaf.value === null ? null : getAtPath(desired, leaf.path);
    if (canonical(getAtPath(currentValue, leaf.path)) !== canonical(want)) {
      edits.push({ path: leaf.path, value: want });
    }
  }

  // One edit at a time, which is identical to folding them (what `applyJsoncEdits`
  // does internally) but lets a throw be attributed to the exact edit that caused it.
  let text = hasCurrent ? (currentContent as string) : `{}${nl}`;
  for (const edit of edits) {
    try {
      text = applyJsoncEdits(text, [edit], nl);
    } catch (cause) {
      // The consumer holds a scalar/array/null where the payload declares an object,
      // so jsonc-parser cannot descend to the owned leaf and throws. That is consumer
      // data, not a bug, so report it as the same recoverable fault as a malformed
      // target instead of letting a raw internal error escape.
      const detail = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, reason: `type mismatch at "${edit.path.join(".")}": ${detail}` };
    }
  }
  return { ok: true, content: text.endsWith(nl) ? text : `${text}${nl}` };
}
