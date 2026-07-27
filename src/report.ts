import type { CheckResult } from "./engine/check";
import type { InitResult } from "./engine/init";
import type { FileState, StatusResult } from "./engine/status";
import type { Conflict, ConflictKind, SyncResult } from "./engine/sync";
import type { UpgradeResult } from "./engine/upgrade";
import type { CommandName } from "./reporter";

/**
 * Human-readable command reports. Pure string building, no process/IO
 * access, so every formatter is unit-testable with an explicit {@link Style}.
 * Layout is a status table: icon, label, count, (truncated) detail per
 * outcome; `style.color` picks ANSI + Unicode glyphs vs plain ASCII tags so
 * piped/CI/`NO_COLOR` output stays greppable.
 */
export interface Style {
  color: boolean;
}

const ANSI = {
  reset: "[0m",
  bold: "[1m",
  dim: "[2m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
  blue: "[34m",
  cyan: "[36m",
} as const;

type StatusKind
  = | "written"
    | "reconciled"
    | "conflict"
    | "skipped"
    | "drift"
    | "fault"
    | "skew"
    | "warning"
    | "outdated"
    | "ok";

interface Descriptor {
  glyph: string;
  ascii: string;
  color: string;
}

const STATUS: Record<StatusKind, Descriptor> = {
  written: { glyph: "✓", ascii: "[+]", color: ANSI.green },
  reconciled: { glyph: "↻", ascii: "[~]", color: ANSI.cyan },
  conflict: { glyph: "⚠", ascii: "[!]", color: ANSI.yellow },
  skipped: { glyph: "·", ascii: "[=]", color: ANSI.dim },
  drift: { glyph: "✗", ascii: "[x]", color: ANSI.red },
  fault: { glyph: "✗", ascii: "[x]", color: ANSI.red },
  skew: { glyph: "⚠", ascii: "[!]", color: ANSI.yellow },
  warning: { glyph: "⚠", ascii: "[w]", color: ANSI.yellow },
  outdated: { glyph: "⬆", ascii: "[^]", color: ANSI.blue },
  ok: { glyph: "✓", ascii: "[+]", color: ANSI.green },
};

const MARK_WIDTH = 3;
const MAX_FILES = 6;

function paint(text: string, color: string, style: Style): string {
  return style.color ? `${color}${text}${ANSI.reset}` : text;
}

function dim(text: string, style: Style): string {
  return paint(text, ANSI.dim, style);
}

function bold(text: string, style: Style): string {
  return paint(text, ANSI.bold, style);
}

// ANSI codes are zero-width, so pad the plain token, not the colored string.
function markField(kind: StatusKind, style: Style): string {
  const descriptor = STATUS[kind];
  const token = style.color ? descriptor.glyph : descriptor.ascii;
  const rendered = style.color ? paint(descriptor.glyph, descriptor.color, style) : descriptor.ascii;
  return rendered + " ".repeat(Math.max(0, MARK_WIDTH - token.length));
}

function fileList(items: string[]): string {
  if (items.length <= MAX_FILES) {
    return items.join(", ");
  }
  return `${items.slice(0, MAX_FILES).join(", ")} … (+${items.length - MAX_FILES} more)`;
}

interface Row {
  kind: StatusKind;
  label: string;
  detail: string;
}

function statusRow(kind: StatusKind, label: string, items: string[], style: Style): Row {
  const count = bold(String(items.length), style);
  return { kind, label, detail: items.length > 0 ? `${count}   ${fileList(items)}` : count };
}

function renderRows(rows: Row[], style: Style): string[] {
  const labelWidth = Math.max(...rows.map(row => row.label.length));
  return rows.map((row) => {
    const detail = row.detail ? `  ${row.detail}` : "";
    return `  ${markField(row.kind, style)}  ${row.label.padEnd(labelWidth)}${detail}`;
  });
}

function kvLine(key: string, value: string, style: Style): string {
  return `  ${dim(key.padEnd(8), style)} ${value}`;
}

function assemble(title: string, body: string[], footerText: string, style: Style): string {
  const lines = [bold(title, style), "", ...body];
  if (footerText) {
    lines.push("", dim(footerText, style));
  }
  return lines.join("\n");
}

function syncRows(data: SyncResult, style: Style, includeConflicts = true): Row[] {
  const rows: Row[] = [];
  if (data.written.length > 0) {
    rows.push(statusRow("written", "written", data.written, style));
  }
  if (data.versionChanges.length > 0) {
    rows.push(statusRow("reconciled", "reconciled", data.versionChanges.map(c => `${c.key} ${c.from} → ${c.to}`), style));
  }
  if (data.versionsSkippedAhead.length > 0) {
    // left as-is: min already meets or exceeds the floor (covers an ahead pin
    // and an equal-min/different-range spec like `~9.39.2` vs `^9.39.2`)
    rows.push(statusRow("skipped", "≥ floor", data.versionsSkippedAhead.map(s => `${s.key} ${s.actual} ≥ ${s.baseline}`), style));
  }
  if (includeConflicts && data.conflicted.length > 0) {
    rows.push(statusRow("conflict", "conflict", data.conflicted.map(c => c.path), style));
  }
  if (data.skipped.length > 0) {
    rows.push(statusRow("skipped", "skipped", data.skipped, style));
  }
  return rows;
}

/**
 * Per-`kind` conflict presentation: status glyph, group label, one-line "what
 * happened", and a "what to do" that names actual flags (`sync --interactive`,
 * `sync --force`, `--only <glob>`). There is no `--accept`/`--theirs`.
 */
const CONFLICT_GROUPS: { kind: ConflictKind; status: StatusKind; label: string; happened: string; todo: string }[] = [
  { kind: "edit", status: "conflict", label: "edit", happened: "managed file(s) edited locally; streamctl-owned content diverged", todo: "review, then `sync --interactive` (accept/skip per file) or `sync --force` to overwrite" },
  { kind: "adoption", status: "conflict", label: "adoption", happened: "pre-existing file(s) streamctl now manages", todo: "`sync --interactive` to adopt per file, `sync --force` to take ownership, or `--only <glob>` to scope" },
  { kind: "fault", status: "fault", label: "fault", happened: "structurally invalid composed output (a payload/template bug)", todo: "not fixable with --force: fix the payload, `--only <glob>` can skip it meanwhile" },
  { kind: "malformed", status: "fault", label: "malformed", happened: "file(s) in this repo could not be parsed (invalid JSONC or broken markers)", todo: "not fixable with --force: repair the file here, `--only <glob>` can skip it meanwhile" },
  { kind: "dirty", status: "skew", label: "dirty", happened: "streamctl-owned path(s) have uncommitted changes", todo: "commit or stash them, or re-run with `sync --force`" },
];

function conflictGroupLines(conflicted: Conflict[], style: Style): string[] {
  const lines: string[] = [];
  for (const group of CONFLICT_GROUPS) {
    const items = conflicted.filter(c => c.kind === group.kind);
    if (items.length === 0) {
      continue;
    }
    lines.push(`  ${markField(group.status, style)}  ${bold(`${group.label} (${items.length})`, style)}  ${dim(group.happened, style)}`);
    for (const item of items) {
      lines.push(`      ${item.path}${dim(` - ${item.reason}`, style)}`);
    }
    lines.push(`      ${dim(`→ ${group.todo}`, style)}`);
  }
  return lines;
}

function warningLines(warnings: string[] | undefined, style: Style): string[] {
  return (warnings ?? []).map(w => `  ${markField("warning", style)}  ${paint(w, ANSI.yellow, style)}`);
}

export function formatSync(data: SyncResult, style: Style, lockfileInstall?: string): string {
  // conflicts render as their own kind-grouped blocks below, not a status row
  const rows = syncRows(data, style, false);
  if (rows.length === 0 && data.conflicted.length === 0) {
    rows.push({ kind: "ok", label: "in sync", detail: dim("no changes", style) });
  }

  let footerText: string;
  if (data.conflicted.length > 0) {
    footerText = `${data.conflicted.length} conflict(s) pending; see the per-kind guidance above.`;
  } else if (data.written.length === 0 && data.versionChanges.length === 0) {
    footerText = "up to date, nothing to write.";
  } else {
    footerText = "sync complete.";
  }

  const body = [...renderRows(rows, style), ...conflictGroupLines(data.conflicted, style), ...warningLines(data.warnings, style)];
  const report = assemble(`streamctl sync · v${data.syncedVersion}`, body, footerText, style);
  // name the PM's install command so the user beats CI's --frozen-lockfile
  if (data.lockfileStale && lockfileInstall) {
    const hint = `package.json changed, so the lockfile is stale. Run \`${lockfileInstall}\` to update it.`;
    return `${report}\n${paint(hint, ANSI.yellow, style)}`;
  }
  return report;
}

export function formatCheck(data: CheckResult, style: Style): string {
  const rows: Row[] = [];
  if (data.drift.length > 0) {
    rows.push(statusRow("drift", "drift", data.drift.map(d => `${d.path} (${d.kind})`), style));
  }
  if (data.structuralFaults.length > 0) {
    rows.push(statusRow("fault", "fault", data.structuralFaults.map(f => f.path), style));
  }
  if (data.versionSkew.length > 0) {
    rows.push(statusRow("skew", "skew", data.versionSkew.map(s => `${s.key} ${s.actual} → ${s.expected}`), style));
  }
  if (data.updateAvailable) {
    rows.push({ kind: "outdated", label: "outdated", detail: `${data.updateAvailable.current} → ${data.updateAvailable.latest} available` });
  }

  let footerText: string;
  if (rows.length === 0) {
    rows.push({ kind: "ok", label: "in sync", detail: "all managed files match" });
    footerText = "all clean.";
  } else if (!data.inSync) {
    footerText = "DRIFT_DETECTED. Run `streamctl sync` to reconcile.";
  } else if (data.updateAvailable) {
    footerText = `update available; run \`streamctl upgrade\` to move to ${data.updateAvailable.latest}.`;
  } else {
    footerText = "check complete.";
  }

  return assemble("streamctl check", renderRows(rows, style), footerText, style);
}

export function formatInit(data: InitResult, style: Style): string {
  // `version` is the payload pin (from `.streamctl/config.ts`); the CLI's own
  // release gets its own line so the two never read as one number.
  const head = [
    kvLine("base", data.base, style),
    kvLine("profile", data.profile, style),
    kvLine("payload", data.version, style),
    "",
  ];
  if (data.sync === null) {
    return assemble(
      `streamctl init · v${data.cliVersion}`,
      head,
      "install skipped. Install dependencies, then run `streamctl sync`.",
      style,
    );
  }
  return assemble(
    `streamctl init · v${data.cliVersion}`,
    [...head, ...renderRows(syncRows(data.sync, style), style), ...warningLines(data.sync.warnings, style)],
    "initialized. Review changes and commit.",
    style,
  );
}

export function formatUpgrade(data: UpgradeResult, style: Style, lockfileInstall?: string): string {
  const rows: Row[] = [];
  if (data.dependencyBumps.length > 0) {
    rows.push(statusRow("outdated", "deps", data.dependencyBumps.map(b => b.name), style));
  }
  if (data.sync) {
    rows.push(...syncRows(data.sync, style));
  }

  // keyed on `dryRun`, not `sync === null` (also null for `--no-install`) -
  // that used to report a dry run for a write that had already happened
  const footerText = data.dryRun
    ? `dry run: would upgrade to v${data.toVersion}.`
    : data.sync
      ? `upgraded to v${data.toVersion}.`
      // pin + devDep are written here, only the install was skipped (mirrors formatInit)
      : `upgraded to v${data.toVersion}; ${lockfileInstall === undefined ? "install dependencies" : `run \`${lockfileInstall}\``}, then run \`streamctl sync\`.`;
  const body = [...renderRows(rows, style), ...warningLines(data.sync?.warnings, style)];
  const report = assemble(`streamctl upgrade · ${data.fromVersion} → ${data.toVersion}`, body, footerText, style);
  if (data.sync?.lockfileStale && lockfileInstall) {
    const hint = `package.json changed, so the lockfile is stale. Run \`${lockfileInstall}\` to update it.`;
    return `${report}\n${paint(hint, ANSI.yellow, style)}`;
  }
  return report;
}

const STATE_KIND: Record<FileState, StatusKind> = {
  "in-sync": "ok",
  "scaffolded": "written",
  "drift": "drift",
  "conflict": "conflict",
  "fault": "fault",
  "missing": "skew",
  "off": "skipped",
  "disabled": "skipped",
};

export function formatStatus(data: StatusResult, style: Style): string {
  const head = [
    kvLine("package", data.payload.package, style),
    kvLine("pinned", data.payload.pinned, style),
    kvLine("installed", data.payload.installed, style),
    ...(data.payload.latest ? [kvLine("latest", `${data.payload.latest} available`, style)] : []),
    kvLine("profile", data.profile, style),
    kvLine("cli", data.cliVersion, style),
    kvLine("lockfile", data.lockfileStale ? "stale, run your package manager's install" : "ok", style),
    "",
  ];

  const rows: Row[] = data.files.map(file => ({
    kind: STATE_KIND[file.state],
    label: file.state,
    detail: `${dim(file.strategy, style)}  ${file.path}`,
  }));
  const body = rows.length > 0 ? renderRows(rows, style) : [`  ${dim("no managed files", style)}`];

  // never a verdict: status just points at the tools, `check` is the gate
  const actionable = data.files.some(file => file.state === "drift" || file.state === "conflict" || file.state === "missing" || file.state === "fault");
  const footerText = actionable
    ? "run `streamctl sync` to reconcile. `streamctl check` is the CI gate (exit codes)."
    : "all managed files in sync.";

  return assemble("streamctl status", [...head, ...body], footerText, style);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isSyncResult(value: unknown): value is SyncResult {
  return isObject(value)
    && Array.isArray(value.written)
    && Array.isArray(value.conflicted)
    && Array.isArray(value.skipped)
    // formatSync reads these unguarded; a malformed `details` payload should
    // fall back to the marker line, not throw
    && Array.isArray(value.versionChanges)
    && Array.isArray(value.versionsSkippedAhead)
    && Array.isArray(value.warnings)
    && typeof value.syncedVersion === "string";
}

export function isCheckResult(value: unknown): value is CheckResult {
  return isObject(value)
    && typeof value.inSync === "boolean"
    && Array.isArray(value.drift)
    && Array.isArray(value.structuralFaults)
    && Array.isArray(value.versionSkew);
}

function isInitResult(value: unknown): value is InitResult {
  return isObject(value)
    && typeof value.version === "string"
    && typeof value.cliVersion === "string"
    && (value.sync === null || isSyncResult(value.sync));
}

function isUpgradeResult(value: unknown): value is UpgradeResult {
  return isObject(value)
    && typeof value.fromVersion === "string"
    && typeof value.toVersion === "string"
    && typeof value.dryRun === "boolean"
    && Array.isArray(value.dependencyBumps)
    && (value.sync === null || isSyncResult(value.sync));
}

function isStatusResult(value: unknown): value is StatusResult {
  return isObject(value)
    && Array.isArray(value.files)
    && value.files.every(file => isObject(file) && typeof file.state === "string" && typeof file.strategy === "string" && typeof file.path === "string")
    && isObject(value.payload)
    && typeof value.cliVersion === "string"
    && typeof value.profile === "string";
}

/**
 * Renders the report for a command from its result `data`, or `null` when
 * `data` doesn't match the command's result shape (callers fall back to a
 * marker line). Used on both the success and failure paths: a thrown
 * {@link import("./errors").StreamctlError} carries its result as `details`.
 */
export function renderReport(command: CommandName, data: unknown, style: Style, lockfileInstall?: string): string | null {
  switch (command) {
    case "sync":
      return isSyncResult(data) ? formatSync(data, style, lockfileInstall) : null;
    case "check":
      return isCheckResult(data) ? formatCheck(data, style) : null;
    case "init":
      return isInitResult(data) ? formatInit(data, style) : null;
    case "status":
      return isStatusResult(data) ? formatStatus(data, style) : null;
    case "upgrade":
      return isUpgradeResult(data) ? formatUpgrade(data, style, lockfileInstall) : null;
    default:
      return null;
  }
}
