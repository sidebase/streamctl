import type { ManagedFile, StreamctlConfig } from "../config/types";
import type { Placeholder, RenderDef } from "../manifest/schema";
import { StreamctlError } from "../errors";
import { isIndexable } from "./jsonc";
import { parseRangeMin } from "./versions";

// Generic renderer (v2): manifest-driven placeholders, fragments, enabledBy gates.
// Pure and deterministic, so output is byte-stable and a re-sync is idempotent.

export function readConfigPath(config: StreamctlConfig | undefined, path: string): unknown {
  let current: unknown = config;
  for (const segment of path.split(".")) {
    if (!isIndexable(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

export function isFileEnabled(file: ManagedFile, config?: StreamctlConfig): boolean {
  return file.enabledBy === undefined || readConfigPath(config, file.enabledBy) === true;
}

/** Active = not turned off via `files: { path: "off" }` and not gated out by an `enabledBy` toggle. */
export function isFileActive(file: ManagedFile, config?: StreamctlConfig): boolean {
  return config?.files?.[file.path] !== "off" && isFileEnabled(file, config);
}

function configStringList(config: StreamctlConfig | undefined, path: string): string[] {
  const raw = readConfigPath(config, path);
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

// Space-joined values land in a single unquoted shell interpolation (e.g.
// `apt-get install $APT_PACKAGES`), so any of these chars could inject commands.
// A floor, independent of the payload's optional `pattern`.
const SHELL_META_RE = /[\s;|&$`<>(){}\\'"*?[\]]/;

/** A full `x.y.z` triple with an optional prerelease tail. */
const FULL_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i;

/**
 * The consumer's pin for `name`, stripped to its range floor (`^6.19.3` → `6.19.3`), or
 * `null` when there is nothing reproducible to use. `parseRangeMin` also yields partial
 * cores (`^6` → `"6"`, `~1.2` → `"1.2"`), which would let the rendered version drift
 * between builds, so only full triples pass — everything else falls back to `default`.
 */
function dependencyFloor(deps: Record<string, string>, name: string): string | null {
  const spec = deps[name];
  if (spec === undefined) {
    return null;
  }
  const floor = parseRangeMin(spec);
  return floor !== null && FULL_VERSION_RE.test(floor) ? floor : null;
}

/**
 * Resolve a placeholder to its substitution string: config value, then the `fromDependency`
 * floor, falling back to `default`; `string[]` gets deduped, sorted, and joined.
 *
 * `deps` is the consumer's merged dependency map, passed in as data — this stays pure and
 * never touches the filesystem.
 */
function resolvePlaceholder(def: Placeholder, config: StreamctlConfig | undefined, key: string, filePath: string, deps: Record<string, string>): string {
  const raw = readConfigPath(config, def.configPath);
  if (Array.isArray(raw)) {
    const list = [...new Set(raw.filter((item): item is string => typeof item === "string"))].sort();
    if (def.join !== "lines") {
      // Reject metacharacters per item, before the join spaces get added.
      for (const item of list) {
        if (SHELL_META_RE.test(item)) {
          throw new StreamctlError(
            "CONFIG_INVALID",
            `render placeholder "${key}" for "${filePath}" has a space-joined value ${JSON.stringify(item)} containing a shell metacharacter (whitespace or one of ; | & $ \` < > ( ) { } \\ ' " * ? [ ]).`,
            { file: filePath, placeholder: key, value: item },
          );
        }
      }
      return list.join(" ");
    }
    return list.join("\n");
  }
  if (typeof raw === "string") {
    return raw;
  }
  if (typeof raw === "boolean" || typeof raw === "number") {
    return String(raw);
  }
  if (def.fromDependency !== undefined) {
    const floor = dependencyFloor(deps, def.fromDependency);
    if (floor !== null) {
      return floor;
    }
  }
  return def.default;
}

/** Extract the inner token name of every streamctl `${TOKEN}`; the `(?!\{)` guard excludes GitHub `${{ ... }}` expressions. */
const LEFTOVER_TOKEN_RE = /\$\{(?!\{)([^}]*)\}/g;

/**
 * Substitution repeats until the output stops changing, so a placeholder value that carries
 * another placeholder's token resolves whatever order the manifest declares them in. The cap
 * turns a cyclic manifest (A's value names B, B's names A) into a loud error instead of a
 * hang; ten levels of nesting is far past anything a payload legitimately needs.
 */
const MAX_SUBSTITUTION_PASSES = 10;

/**
 * Every `${TOKEN}` still in `text`, plus the tokens reachable through the values those name.
 * A cycle leaves only one of its members in the output at any given pass (the others were
 * just substituted), so following the values is what lets the error name the whole loop.
 */
function unresolvedTokens(text: string, values: ReadonlyMap<string, string>, passthrough: ReadonlySet<string>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const collect = (source: string): void => {
    for (const match of source.matchAll(LEFTOVER_TOKEN_RE)) {
      const name = match[1] ?? "";
      if (!passthrough.has(name) && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  };
  collect(text);
  for (let index = 0; index < names.length; index++) {
    const value = values.get(names[index] ?? "");
    if (value !== undefined) {
      collect(value);
    }
  }
  return names.sort().map(name => `\${${name}}`);
}

/**
 * Assemble fragments in declared order (`toggle` includes when true, `forEach`
 * repeats per `string[]` item as `${ITEM}`), then substitute `${KEY}` placeholders
 * over the assembled result. GitHub `${{ ... }}` expressions pass through untouched.
 *
 * A `${TOKEN}` left unresolved throws `CONFIG_INVALID`, unless declared in
 * `renderDef.passthrough` (e.g. a Dockerfile build `ARG`).
 *
 * `deps` feeds placeholder `fromDependency`; omitting it just means no placeholder resolves
 * that way.
 */
export function renderFile(
  sourceContent: string,
  renderDef: RenderDef,
  config: StreamctlConfig | undefined,
  fragmentSources: Record<string, string>,
  filePath = "(template)",
  deps: Record<string, string> = {},
): string {
  const parts = [sourceContent.replace(/\n+$/, "")];
  for (const fragment of renderDef.fragments ?? []) {
    const rawBody = fragmentSources[fragment.source];
    if (rawBody === undefined) {
      throw new StreamctlError(
        "CONFIG_INVALID",
        `render for "${filePath}" references fragment source "${fragment.source}", which was not provided.`,
        { file: filePath, source: fragment.source },
      );
    }
    // Strip trailing newlines so the `\n`-join produces exactly one separator.
    const body = rawBody.replace(/\n+$/, "");
    if ("toggle" in fragment) {
      if (readConfigPath(config, fragment.toggle) === true) {
        parts.push(body);
      }
    } else {
      for (const item of configStringList(config, fragment.forEach)) {
        // Callback form: a plain replacement string would honor $-patterns in the
        // value. Config values are data and must land verbatim (same below).
        // eslint-disable-next-line no-template-curly-in-string -- literal ${ITEM} placeholder token, not a template expression
        parts.push(body.replaceAll("${ITEM}", () => item));
      }
    }
  }

  let output = `${parts.join("\n")}\n`;

  // Values are resolved (and pattern-checked) once, ahead of substitution: they come from
  // the config and the dependency map, never from the output being assembled.
  const values = new Map<string, string>();
  for (const [key, def] of Object.entries(renderDef.placeholders ?? {})) {
    const value = resolvePlaceholder(def, config, key, filePath, deps);
    if (def.pattern !== undefined && !new RegExp(def.pattern).test(value)) {
      throw new StreamctlError(
        "CONFIG_INVALID",
        `render placeholder "${key}" for "${filePath}" has value ${JSON.stringify(value)}, which violates its pattern /${def.pattern}/.`,
        { file: filePath, placeholder: key, value },
      );
    }
    values.set(key, value);
  }

  const passthrough = new Set(renderDef.passthrough ?? []);

  // Callback form: a plain replacement string would honor `$&`/`$1` patterns in the value.
  // Config values are data and must land verbatim.
  const substitutePass = (text: string): string => {
    let next = text;
    for (const [key, value] of values) {
      next = next.replaceAll(`\${${key}}`, () => value);
    }
    return next;
  };

  for (let pass = 1; ; pass++) {
    const next = substitutePass(output);
    if (next === output) {
      break; // fixpoint
    }
    output = next;
    if (pass >= MAX_SUBSTITUTION_PASSES) {
      const tokens = unresolvedTokens(output, values, passthrough);
      throw new StreamctlError(
        "CONFIG_INVALID",
        `render for "${filePath}" did not stabilize after ${MAX_SUBSTITUTION_PASSES} substitution passes; still unresolved: ${tokens.join(", ")}. A placeholder value references itself, directly or through another placeholder.`,
        { file: filePath, tokens, passes: MAX_SUBSTITUTION_PASSES },
      );
    }
  }

  for (const match of output.matchAll(LEFTOVER_TOKEN_RE)) {
    const token = match[0];
    const name = match[1] ?? "";
    if (passthrough.has(name)) {
      continue; // template-owned literal, declared verbatim in the manifest
    }
    throw new StreamctlError(
      "CONFIG_INVALID",
      `unresolved render token ${token} remains in "${filePath}" after rendering; unknown placeholder or template/manifest drift.`,
      { file: filePath, token },
    );
  }

  return output;
}
