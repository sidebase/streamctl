import type { ZodError } from "zod";
import type { ManagedFile as EngineManagedFile } from "../config/types";
import type { DirectiveBlock } from "../directives";
import type { ConfigKeyType, ManagedFile as ManifestManagedFile, PayloadManifest, PresetManifest, RenderDef } from "../manifest/schema";
import type { PayloadHandle } from "../payload/resolve";
import { scanDirectives } from "../directives";
import { StreamctlError } from "../errors";
import { COMMA_JOIN_MIN_SCHEMA_VERSION, DIRECTIVES_MIN_SCHEMA_VERSION, FROM_DEPENDENCY_MIN_SCHEMA_VERSION, OMIT_LINE_MIN_SCHEMA_VERSION, payloadManifestSchema, presetManifestSchema, SUPPORTED_SCHEMA_VERSION_LIST, SUPPORTED_SCHEMA_VERSIONS, zodToIssues } from "../manifest/schema";

const PAYLOAD_MANIFEST = "presets/manifest.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarize(error: ZodError): string {
  return zodToIssues(error).map(issue => `${issue.path}: ${issue.message}`).join("; ");
}

/**
 * A `schemaVersion` pre-check runs before the full zod parse; an integer outside
 * the supported set throws `SCHEMA_UNSUPPORTED`, so a payload from the future gets
 * the version message instead of a wall of zod issues.
 */
export async function loadPayloadManifest(payload: PayloadHandle): Promise<PayloadManifest> {
  if (!(await payload.list()).includes("manifest.json")) {
    throw new StreamctlError("PAYLOAD_INVALID", `payload has no ${PAYLOAD_MANIFEST}; is this a streamctl payload?`);
  }

  const raw = await payload.read("manifest.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StreamctlError(
      "PAYLOAD_INVALID",
      `${PAYLOAD_MANIFEST} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { file: PAYLOAD_MANIFEST },
    );
  }

  if (isRecord(parsed) && typeof parsed.schemaVersion === "number" && Number.isInteger(parsed.schemaVersion) && !SUPPORTED_SCHEMA_VERSIONS.has(parsed.schemaVersion)) {
    throw new StreamctlError(
      "SCHEMA_UNSUPPORTED",
      `${PAYLOAD_MANIFEST} declares schemaVersion ${parsed.schemaVersion}, but this streamctl supports schemaVersion ${SUPPORTED_SCHEMA_VERSION_LIST}. Upgrade the CLI or the payload.`,
      { file: PAYLOAD_MANIFEST, found: parsed.schemaVersion, supported: [...SUPPORTED_SCHEMA_VERSIONS] },
    );
  }

  const result = payloadManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new StreamctlError("CONFIG_INVALID", `Invalid ${PAYLOAD_MANIFEST}: ${summarize(result.error)}`, {
      file: PAYLOAD_MANIFEST,
      issues: zodToIssues(result.error),
    });
  }
  return result.data;
}

/** Soft loader for callers that only warn on a non-streamctl payload (e.g. the profile-mismatch check) instead of hard-failing. Still throws on a malformed manifest. */
export async function tryLoadPayloadManifest(payload: PayloadHandle): Promise<PayloadManifest | null> {
  if (!(await payload.list()).includes("manifest.json")) {
    return null;
  }
  return loadPayloadManifest(payload);
}

/** Render/configKeys cross-checks that need the merged chain run in {@link resolvePresetChain}, not here. */
export async function loadPresetManifest(payload: PayloadHandle, name: string, manifest: PayloadManifest): Promise<PresetManifest> {
  if (!manifest.presets.includes(name)) {
    throw new StreamctlError("CONFIG_INVALID", `preset "${name}" is not listed in ${PAYLOAD_MANIFEST} presets[].`, {
      file: PAYLOAD_MANIFEST,
      preset: name,
    });
  }

  const file = `presets/${name}/preset.json`;
  let raw: string;
  try {
    raw = await payload.read(`${name}/preset.json`);
  } catch {
    throw new StreamctlError("PAYLOAD_INVALID", `${file} is missing, but "${name}" is listed in ${PAYLOAD_MANIFEST} presets[].`, { file });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StreamctlError("CONFIG_INVALID", `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { file });
  }

  const result = presetManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new StreamctlError("CONFIG_INVALID", `Invalid ${file}: ${summarize(result.error)}`, { file, issues: zodToIssues(result.error) });
  }
  const preset = result.data;

  if (preset.name !== name) {
    throw new StreamctlError("CONFIG_INVALID", `${file} declares name "${preset.name}" but lives in directory "${name}".`, { file });
  }
  for (const parent of preset.extends ?? []) {
    if (!manifest.presets.includes(parent)) {
      throw new StreamctlError("CONFIG_INVALID", `${file} extends "${parent}", which is not listed in ${PAYLOAD_MANIFEST} presets[].`, { file, parent });
    }
  }

  // Feature gates. zod strictness only stops a new key on an OLD CLI; without this check a
  // payload author who forgets the schemaVersion bump ships a payload this CLI accepts and
  // every older one rejects with a raw zod wall.
  const gates = [
    { feature: "fromDependency", required: FROM_DEPENDENCY_MIN_SCHEMA_VERSION },
    { feature: "omitLineIfEmpty", required: OMIT_LINE_MIN_SCHEMA_VERSION },
  ] as const;
  for (const { feature, required } of gates) {
    if (manifest.schemaVersion >= required) {
      continue;
    }
    for (const [render, def] of Object.entries(preset.renders ?? {})) {
      for (const [key, placeholder] of Object.entries(def.placeholders ?? {})) {
        if (placeholder[feature] !== undefined) {
          throw new StreamctlError(
            "CONFIG_INVALID",
            `${file} renders.${render} placeholder "${key}" uses ${feature}, which requires schemaVersion ${required}, but ${PAYLOAD_MANIFEST} declares schemaVersion ${manifest.schemaVersion}.`,
            { file, preset: name, render, placeholder: key, found: manifest.schemaVersion, required },
          );
        }
      }
    }
  }
  if (manifest.schemaVersion < COMMA_JOIN_MIN_SCHEMA_VERSION) {
    for (const [render, def] of Object.entries(preset.renders ?? {})) {
      for (const [key, placeholder] of Object.entries(def.placeholders ?? {})) {
        if (placeholder.join === "comma") {
          throw new StreamctlError(
            "CONFIG_INVALID",
            `${file} renders.${render} placeholder "${key}" uses join: "comma", which requires schemaVersion ${COMMA_JOIN_MIN_SCHEMA_VERSION}, but ${PAYLOAD_MANIFEST} declares schemaVersion ${manifest.schemaVersion}.`,
            { file, preset: name, render, placeholder: key, found: manifest.schemaVersion, required: COMMA_JOIN_MIN_SCHEMA_VERSION },
          );
        }
      }
    }
  }
  return preset;
}

/** `renderDef` gets attached by {@link resolvePresetChain} after the chain merges, not here. */
function toEngineFile(file: ManifestManagedFile): EngineManagedFile {
  return {
    path: file.path,
    strategy: file.strategy,
    source: file.source,
    ...(file.blockMark !== undefined ? { blockMark: file.blockMark } : {}),
    ...(file.projectFields !== undefined ? { projectFields: file.projectFields } : {}),
    ...(file.enabledBy !== undefined ? { enabledBy: file.enabledBy } : {}),
    ...(file.adoption !== undefined ? { adoption: file.adoption } : {}),
    ...(file.shadowedBy !== undefined ? { shadowedBy: file.shadowedBy } : {}),
  };
}

interface ConfigPathRef {
  where: string;
  path: string;
  /** Extra error details, e.g. the directive location. */
  details?: Record<string, unknown>;
}

interface DirectiveScanTarget {
  source: string;
  /** Drives comment syntax, the YAML body rule and JSON rejection. */
  scanPath: string;
  kind: "template" | "fragment";
  strategy?: EngineManagedFile["strategy"];
}

/** Re-point a parser error from the scan path to the payload-relative source file. */
function relocateDirectiveError(error: unknown, scanPath: string, file: string): unknown {
  if (!(error instanceof StreamctlError) || !isRecord(error.details) || typeof error.details.line !== "number") {
    return error;
  }
  const prefix = `${scanPath}:${error.details.line}: `;
  const sentence = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
  return new StreamctlError(error.code, `${file}:${error.details.line}: ${sentence}`, { ...error.details, file });
}

/**
 * Scan every template and fragment of the resolved chain, including files later
 * switched off, so a directive mistake fails every command up front. Pushes each
 * condition into `configPathRefs` for the shared declaration check.
 */
async function validateDirectives(
  payload: PayloadHandle,
  targets: DirectiveScanTarget[],
  schemaVersion: number,
  configKeys: Record<string, ConfigKeyType>,
  configPathRefs: ConfigPathRef[],
): Promise<void> {
  const reads = new Map<string, Promise<string>>();
  for (const target of targets) {
    const file = `presets/${target.source}`;
    let text = reads.get(target.source);
    if (text === undefined) {
      text = payload.read(target.source);
      reads.set(target.source, text);
    }
    let blocks: DirectiveBlock[];
    try {
      blocks = scanDirectives(await text, target.scanPath);
    } catch (error) {
      throw relocateDirectiveError(error, target.scanPath, file);
    }
    const first = blocks[0];
    if (first === undefined) {
      continue;
    }
    if (schemaVersion < DIRECTIVES_MIN_SCHEMA_VERSION) {
      throw new StreamctlError(
        "CONFIG_INVALID",
        `${file}:${first.ifLine}: uses template directives, which requires schemaVersion ${DIRECTIVES_MIN_SCHEMA_VERSION}, but ${PAYLOAD_MANIFEST} declares schemaVersion ${schemaVersion}.`,
        { file, line: first.ifLine, reason: "schema-version", found: schemaVersion, required: DIRECTIVES_MIN_SCHEMA_VERSION },
      );
    }
    if (target.strategy === "merge") {
      throw new StreamctlError(
        "CONFIG_INVALID",
        `${file}:${first.ifLine}: template directives are not supported in merge-strategy files.`,
        { file, line: first.ifLine, reason: "merge-strategy" },
      );
    }
    for (const block of blocks) {
      const details = { file, line: block.ifLine, condition: block.condition };
      if (configKeys[block.condition] === "object") {
        throw new StreamctlError(
          "CONFIG_INVALID",
          `${file}:${block.ifLine}: condition "${block.condition}" names an object config key; use one of its fields instead.`,
          { ...details, reason: "object-condition" },
        );
      }
      configPathRefs.push({
        where: `${target.kind} "${file}" line ${block.ifLine}`,
        path: block.condition,
        details: { ...details, reason: "undeclared-condition" },
      });
    }
  }
}

/**
 * Resolves a preset chain to its merged managed-file set and profile version
 * baseline, following `extends` parents-first with a `visited` cycle guard and
 * de-duping by target path (child overrides parent).
 */
export async function resolvePresetChain(
  payload: PayloadHandle,
  base: string,
  profile: string,
): Promise<{ files: EngineManagedFile[]; baseline: Record<string, string>; configKeys: Record<string, ConfigKeyType> }> {
  const manifest = await loadPayloadManifest(payload);

  if (!manifest.presets.includes(base)) {
    throw new StreamctlError("CONFIG_INVALID", `base preset "${base}" is not listed in ${PAYLOAD_MANIFEST} presets[].`, {
      file: PAYLOAD_MANIFEST,
      preset: base,
    });
  }

  // Undeclared profile is a hard error (unlike declared-but-wrong, which only
  // warns in engine/detect.ts). Without this, a typo or an explicit `--profile`
  // silently resolved the baseline to `{}` and disabled version reconcile for
  // good. `profiles: []` opts out entirely and stays permissive; the check
  // targets declared names, not baseline content.
  const declared = manifest.profiles.map(p => p.name);
  if (declared.length > 0 && !declared.includes(profile)) {
    throw new StreamctlError("CONFIG_INVALID", `profile "${profile}" is not declared in ${PAYLOAD_MANIFEST} profiles[]; declared: ${declared.join(", ")}.`, {
      file: PAYLOAD_MANIFEST,
      profile,
      declared,
    });
  }

  const visited = new Set<string>();
  const byPath = new Map<string, EngineManagedFile>();
  const renders = new Map<string, RenderDef>();
  const renderKeyByPath = new Map<string, string>();
  const configKeys: Record<string, ConfigKeyType> = {};
  const baseline: Record<string, string> = {};
  const renderRefs: { file: string; render: string }[] = [];
  const configPathRefs: ConfigPathRef[] = [];

  const visit = async (name: string): Promise<void> => {
    if (visited.has(name)) {
      return;
    }
    visited.add(name);

    const preset = await loadPresetManifest(payload, name, manifest);
    for (const parent of preset.extends ?? []) {
      await visit(parent);
    }

    for (const [key, def] of Object.entries(preset.renders ?? {})) {
      renders.set(key, def); // child overrides parent (parents visited first)
      for (const placeholder of Object.values(def.placeholders ?? {})) {
        configPathRefs.push({ where: `renders.${key} placeholder`, path: placeholder.configPath });
      }
      for (const fragment of def.fragments ?? []) {
        configPathRefs.push({ where: `renders.${key} fragment`, path: "toggle" in fragment ? fragment.toggle : fragment.forEach });
      }
    }
    Object.assign(configKeys, preset.configKeys ?? {}); // child overrides parent (parents visited first)
    for (const file of preset.files) {
      byPath.set(file.path, toEngineFile(file));
      // Track the render key per path so a child override that drops render clears
      // the parent's key, else the merged file would inherit a stale renderDef.
      if (file.render !== undefined) {
        renderRefs.push({ file: file.path, render: file.render });
        renderKeyByPath.set(file.path, file.render);
      } else {
        renderKeyByPath.delete(file.path);
      }
      if (file.enabledBy !== undefined) {
        configPathRefs.push({ where: `file "${file.path}" enabledBy`, path: file.enabledBy });
      }
    }
    Object.assign(baseline, preset.versionProfiles?.[profile] ?? {});
  };

  await visit(base);

  const files = [...byPath.values()];
  if (files.length === 0) {
    throw new StreamctlError("CONFIG_INVALID", `preset "${base}" resolves to no managed files.`, { preset: base });
  }

  for (const ref of renderRefs) {
    if (!renders.has(ref.render)) {
      throw new StreamctlError(
        "CONFIG_INVALID",
        `file "${ref.file}" uses render "${ref.render}", which no preset in the chain declares in renders.`,
        { file: ref.file, render: ref.render },
      );
    }
  }

  // renderRefs above guarantees every key resolves.
  for (const [path, key] of renderKeyByPath) {
    const def = renders.get(key);
    const file = byPath.get(path);
    if (file !== undefined && def !== undefined) {
      file.renderDef = def;
    }
  }

  const scanTargets: DirectiveScanTarget[] = files.map(file => ({ source: file.source, scanPath: file.path, kind: "template", strategy: file.strategy }));
  const fragmentSources = new Set<string>();
  for (const key of new Set(renderKeyByPath.values())) {
    for (const fragment of renders.get(key)?.fragments ?? []) {
      if (!fragmentSources.has(fragment.source)) {
        fragmentSources.add(fragment.source);
        scanTargets.push({ source: fragment.source, scanPath: fragment.source, kind: "fragment" });
      }
    }
  }
  await validateDirectives(payload, scanTargets, manifest.schemaVersion, configKeys, configPathRefs);

  // A referenced config path is satisfied when it names a declared configKey exactly,
  // or descends into one declared `object` (the only declared type with addressable
  // children). Matching the root namespace alone was too loose: `ci.upgradePr` against a
  // declared `ci.upgradePR` passed, then `isFileEnabled` read an undefined path and the
  // file stayed off with no way to turn it on.
  for (const ref of configPathRefs) {
    const satisfied = Object.entries(configKeys).some(([key, type]) =>
      ref.path === key || (type === "object" && ref.path.startsWith(`${key}.`)));
    if (!satisfied) {
      const known = Object.keys(configKeys).sort();
      const hint = known.length > 0 ? ` Declared keys: ${known.join(", ")}.` : "";
      throw new StreamctlError(
        "CONFIG_INVALID",
        `${ref.where} references config path "${ref.path}", which no preset declares in configKeys.${hint}`,
        { path: ref.path, declared: known, ...ref.details },
      );
    }
  }

  return { files, baseline, configKeys };
}
