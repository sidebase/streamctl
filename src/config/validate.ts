import type { ConfigKeyType } from "../manifest/schema";
import type { StreamctlConfig } from "./types";
import { z } from "zod";
import { StreamctlError } from "../errors";
import { RECONCILABLE_KEY_PATTERN } from "./types";

export interface ConfigIssue {
  path: string;
  message: string;
}

const SEMVER_RE
  = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-z-][\w-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][\w-]*))*))?(?:\+([\w-]+(?:\.[\w-]+)*))?$/i;

/** npm package name shape (optional scope). Mirrors the registry's validation. */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** The universal, CLI-owned config keys; everything else is a payload knob (stage 2). */
const UNIVERSAL_KEYS = ["package", "base", "version", "profile", "versionSync", "versionSyncExclude", "files"] as const;

/** Message is `"is required"` when the key is absent, `typeError` otherwise. */
function requiredError(typeError: string): { error: (issue: z.core.$ZodRawIssue) => string } {
  return { error: issue => (issue.input === undefined ? "is required" : typeError) };
}

/** Stage 1: the CLI-universal shape. `looseObject` passes every payload knob through untouched (validated by stage 2 against the payload's `configKeys`). */
const stage1Schema = z.looseObject({
  package: z.string(requiredError("must be a valid npm package name")).regex(PACKAGE_NAME_RE, "must be a valid npm package name"),
  base: z.string(requiredError("must be a non-empty string")).min(1, "must be a non-empty string"),
  version: z.string(requiredError("must be a valid semver string")).regex(SEMVER_RE, "must be a valid semver string"),
  profile: z.string(requiredError("must be a non-empty string")).min(1, "must be a non-empty string"),
  versionSync: z.boolean("must be a boolean").optional(),
  versionSyncExclude: z
    .array(z.string().regex(RECONCILABLE_KEY_PATTERN, "is not a reconcilable version key"), "must be an array of strings")
    .optional(),
  files: z.record(z.string(), z.enum(["managed", "off"], "must be \"managed\" or \"off\""), "must be an object").optional(),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.length > 0 ? path.map(segment => String(segment)).join(".") : "config";
}

/** No throw; returns issues plus the payload-knob `rest` (everything outside {@link UNIVERSAL_KEYS}). */
function collectStage1(input: unknown): { issues: ConfigIssue[]; rest: Record<string, unknown> } {
  if (!isPlainObject(input)) {
    return {
      issues: [{ path: "config", message: "must be an object" }],
      rest: {},
    };
  }

  const result = stage1Schema.safeParse(input);
  const issues: ConfigIssue[] = result.success
    ? []
    : result.error.issues.map(issue => ({ path: issuePath(issue.path), message: issue.message }));

  const universal = new Set<string>(UNIVERSAL_KEYS);
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!universal.has(key)) {
      rest[key] = value;
    }
  }

  return { issues, rest };
}

function assertNoIssues(issues: ConfigIssue[]): void {
  if (issues.length > 0) {
    const summary = issues.map(issue => `${issue.path}: ${issue.message}`).join("; ");
    throw new StreamctlError("CONFIG_INVALID", `Invalid .streamctl/config.ts: ${summary}`, { issues });
  }
}

/**
 * The single trust-boundary cast: once the stages prove the shape, the validated
 * object becomes the domain type. Payload fields (eslint/ci/…) stay opaque here.
 */
function asValidatedConfig(input: unknown): StreamctlConfig {
  return input as StreamctlConfig;
}

/** Stage 1 only, for callers with no merged preset chain (e.g. `config/load.ts`). */
export function validateStreamctlConfig(input: unknown): StreamctlConfig {
  const { issues } = collectStage1(input);
  assertNoIssues(issues);
  return asValidatedConfig(input);
}

function describeType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

/** True when `value` satisfies the declared {@link ConfigKeyType} (object = shape-only). */
function matchesType(value: unknown, type: ConfigKeyType): boolean {
  switch (type) {
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "string[]":
      return Array.isArray(value) && value.every(entry => typeof entry === "string");
    case "object":
      return isPlainObject(value);
  }
}

/** Levenshtein edit distance (iterative single-row; no dependency). */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr.push(Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = curr;
  }
  return prev[b.length] ?? 0;
}

function nearest(target: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const distance = editDistance(target, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/**
 * Stage 2: a declared leaf is shape-checked; a declared namespace is recursed
 * into with undeclared children flagged via nearest-match; a key in an entirely
 * undeclared namespace is rejected outright (the config file is payload-coupled
 * by design).
 */
export function validateConfigKeys(rest: Record<string, unknown>, configKeys: Record<string, ConfigKeyType>): ConfigIssue[] {
  const declared = Object.keys(configKeys);
  const namespaces = new Set(declared.map(key => key.split(".")[0]).filter((segment): segment is string => segment !== undefined));
  const issues: ConfigIssue[] = [];

  const isLeaf = (path: string): boolean => path in configKeys;
  const isNamespace = (path: string): boolean => declared.some(key => key.startsWith(`${path}.`));

  const visit = (obj: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;

      if (isLeaf(path)) {
        const type = configKeys[path];
        if (type !== undefined && !matchesType(value, type)) {
          issues.push({ path, message: `expected ${type}, got ${describeType(value)}` });
        }
        continue; // declared leaf, object included; never recurse (shape-only)
      }

      if (isNamespace(path)) {
        if (!isPlainObject(value)) {
          issues.push({ path, message: `expected object, got ${describeType(value)}` });
        } else {
          visit(value, path);
        }
        continue;
      }

      // Undeclared: suggest a near declared key sharing this namespace, else list
      // namespaces. Scope by the full namespace prefix, not just the first segment:
      // `split(".")[0]` never matches a dotted prefix, so nested namespaces got no
      // siblings at all.
      const scope = prefix === "" ? key : prefix;
      const siblings = declared.filter(candidate => candidate.startsWith(`${scope}.`));
      const suggestion = nearest(path, siblings.length > 0 ? siblings : declared);
      if (suggestion !== null) {
        issues.push({ path, message: `unknown config key ${path}; did you mean ${suggestion}?` });
      } else {
        issues.push({ path, message: `unknown config key ${path}: no preset declares it (declared: ${[...namespaces].sort().join(", ") || "none"})` });
      }
    }
  };

  visit(rest, "");
  return issues;
}

/**
 * The two-stage validator used where the merged preset chain is available
 * (sync / check / init). Stage 1 and stage 2 issues concatenate into one
 * `CONFIG_INVALID` so the user sees everything at once.
 */
export function validateStreamctlConfigWithKeys(input: unknown, configKeys: Record<string, ConfigKeyType>): StreamctlConfig {
  const { issues, rest } = collectStage1(input);
  const stage2 = validateConfigKeys(rest, configKeys);
  assertNoIssues([...issues, ...stage2]);
  return asValidatedConfig(input);
}
