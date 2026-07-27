import { parseAllDocuments } from "yaml";
import { structuredFormat } from "../paths";
import { strictParseJsonc } from "./jsonc";

export type StructuralResult = { ok: true } | { ok: false; reason: string };

/**
 * Never throws: a parse failure comes back as `{ ok: false, reason }` for the engine
 * to report (exit 3). Non-structured paths have nothing to validate, so callers can
 * invoke this unconditionally.
 *
 * `.json5` is deliberately not parsed. The JSONC parser rejects json5's defining
 * syntax (unquoted keys, single quotes), which made valid output a permanent fault
 * that `--force` could not bypass. Taking on a JSON5 dependency for a gate this
 * advisory was not worth it, so json5 is treated as text, matching `contentEquals`.
 */
export function validateStructured(path: string, content: string): StructuralResult {
  const format = structuredFormat(path);
  if (format === null || format === "json5") {
    return { ok: true };
  }
  if (format === "json") {
    const parsed = strictParseJsonc(content);
    return parsed.ok ? { ok: true } : { ok: false, reason: parsed.reason };
  }
  return validateYaml(content);
}

/**
 * `parseAllDocuments`, not `parse`: the single-doc parser throws on a
 * `---`-separated stream (k8s manifests), faulting valid output. It reports
 * doc-level problems as per-document `errors` rather than throwing, so those have
 * to be collected explicitly or broken yaml passes silently. The try/catch covers
 * input that fails before any document is produced.
 */
function validateYaml(content: string): StructuralResult {
  let documents;
  try {
    documents = parseAllDocuments(content);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  // Empty input yields zero documents and no errors. Valid, as with the old parser.
  const reasons = documents.flatMap((document, index) =>
    document.errors.map(error => (documents.length > 1 ? `document ${index + 1}: ${error.message}` : error.message)),
  );
  return reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join("; ") };
}
