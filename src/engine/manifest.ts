import type { ZodError } from "zod";
import type { ManagedFile as EngineManagedFile } from "../config/types";
import type { ConfigKeyType, ManagedFile as ManifestManagedFile, PayloadManifest, PresetManifest, RenderDef } from "../manifest/schema";
import type { PayloadHandle } from "../payload/resolve";
import { StreamctlError } from "../errors";
import { payloadManifestSchema, presetManifestSchema, SUPPORTED_SCHEMA_VERSION, zodToIssues } from "../manifest/schema";

const PAYLOAD_MANIFEST = "presets/manifest.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarize(error: ZodError): string {
  return zodToIssues(error).map(issue => `${issue.path}: ${issue.message}`).join("; ");
}

/**
 * A `schemaVersion` pre-check runs before the full zod parse; an integer other
 * than the supported one throws `SCHEMA_UNSUPPORTED`, so a v3 payload gets the
 * version message instead of a wall of zod issues.
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

  if (isRecord(parsed) && typeof parsed.schemaVersion === "number" && Number.isInteger(parsed.schemaVersion) && parsed.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new StreamctlError(
      "SCHEMA_UNSUPPORTED",
      `${PAYLOAD_MANIFEST} declares schemaVersion ${parsed.schemaVersion}, but this streamctl supports schemaVersion ${SUPPORTED_SCHEMA_VERSION}. Upgrade the CLI or the payload.`,
      { file: PAYLOAD_MANIFEST, found: parsed.schemaVersion, supported: SUPPORTED_SCHEMA_VERSION },
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
        { path: ref.path, declared: known },
      );
    }
  }

  return { files, baseline, configKeys };
}
