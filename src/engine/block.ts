import { commentSyntaxFor } from "../comment-syntax";

export type BlockResult
  = | { ok: true; content: string }
    | { ok: false; reason: string };

/**
 * Line-anchored on purpose: a `{mark}` that is a substring or prefix of another
 * (`core` vs `core2`) must never false-match, since substring matching would
 * silently corrupt the wrong block.
 */
function markerLineIndices(lines: string[], begin: string, end: string): { begins: number[]; ends: number[] } {
  const begins: number[] = [];
  const ends: number[] = [];
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === begin) {
      begins.push(i);
    } else if (trimmed === end) {
      ends.push(i);
    }
  }
  return { begins, ends };
}

function normalizeRegion(region: string, nl: string): string {
  const body = region.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return body.length === 0 ? "" : `${body}\n`.replace(/\n/g, nl);
}

/**
 * Compose the `block` strategy: maintain only the `{mark}` region and preserve
 * everything outside it byte-for-byte.
 *
 * Exactly one BEGIN plus END, in order, replaces the inner region. No markers at
 * all appends a fresh block in the file's newline style. Duplicated, unbalanced or
 * out-of-order markers are a recoverable fault reported as drift.
 *
 * Idempotent: re-composing with the same payload yields identical output.
 */
export function composeBlock(opts: {
  path: string;
  mark: string;
  payloadRegion: string;
  currentContent: string | null;
}): BlockResult {
  const { path, mark, payloadRegion, currentContent } = opts;
  const { prefix, suffix } = commentSyntaxFor(path);
  const nl = currentContent?.includes("\r\n") ? "\r\n" : "\n";

  const begin = `${prefix}BEGIN streamctl MANAGED BLOCK ${mark}${suffix}`;
  const end = `${prefix}END streamctl MANAGED BLOCK ${mark}${suffix}`;
  const region = normalizeRegion(payloadRegion, nl);
  const block = `${begin}${nl}${region}${end}${nl}`;

  if (currentContent === null || currentContent === "") {
    return { ok: true, content: block };
  }

  const lines = currentContent.split("\n");
  const { begins, ends } = markerLineIndices(lines, begin, end);

  if (begins.length === 0 && ends.length === 0) {
    // Single separating newline if the file lacks a trailing one.
    const sep = currentContent.endsWith("\n") ? "" : nl;
    return { ok: true, content: `${currentContent}${sep}${block}` };
  }

  if (begins.length !== 1 || ends.length !== 1) {
    return { ok: false, reason: `duplicated or unbalanced markers for "${mark}"` };
  }

  const beginLine = begins[0];
  const endLine = ends[0];
  if (beginLine === undefined || endLine === undefined) {
    return { ok: false, reason: `duplicated or unbalanced markers for "${mark}"` };
  }
  if (endLine < beginLine) {
    return { ok: false, reason: `END marker precedes BEGIN for "${mark}"` };
  }

  // `+1` accounts for the `\n` that split removed.
  const lineStart = (index: number): number =>
    lines.slice(0, index).reduce((offset, line) => offset + line.length + 1, 0);

  const innerStart = lineStart(beginLine + 1);
  const innerEnd = lineStart(endLine);

  return {
    ok: true,
    content: currentContent.slice(0, innerStart) + region + currentContent.slice(innerEnd),
  };
}
