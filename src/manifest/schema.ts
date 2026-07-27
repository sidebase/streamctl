import type { ZodError } from "zod";
import type { ConfigIssue } from "../config/validate";
import { z } from "zod";
import { RECONCILABLE_KEY_PATTERN } from "../config/types";
import { isStructuredPath } from "../paths";

/** A payload declaring any other `schemaVersion` maps to `SCHEMA_UNSUPPORTED`. Manifest and package versions are otherwise independent. */
export const SUPPORTED_SCHEMA_VERSION = 2;

/** The CLI checks shape only; semantics stay payload-owned. `"object"` is a presence + `typeof` check with no deep validation. */
export const CONFIG_KEY_TYPES = ["boolean", "string", "string[]", "object"] as const;
export type ConfigKeyType = (typeof CONFIG_KEY_TYPES)[number];

/**
 * A `string[]` value is deduped + sorted, then joined per `join` (`space` or
 * `lines`). Substitution is single-pass; any leftover `${…}` fails render.ts's
 * leftover-token check.
 */
export const placeholderSchema = z.strictObject({
  configPath: z.string().min(1),
  default: z.string(),
  pattern: z.string().min(1).optional(),
  join: z.enum(["space", "lines"]).optional(),
});

/**
 * A conditionally-appended template fragment, exactly one of:
 * - `{ toggle, source }`: appended when the boolean config path `toggle` is true.
 * - `{ forEach, source }`: repeated once per item of the `string[]` config value
 *   at `forEach`, the item exposed as `${ITEM}` (the per-environment deploy jobs).
 * A fragment carrying both keys, or neither, fails the union.
 */
export const fragmentSchema = z.union([
  z.strictObject({ toggle: z.string().min(1), source: z.string().min(1) }),
  z.strictObject({ forEach: z.string().min(1), source: z.string().min(1) }),
]);

/**
 * `passthrough` is the escape hatch for `${TOKEN}`s the template owns and the
 * renderer must leave verbatim (e.g. a Dockerfile build-`ARG` like
 * `${PRISMA_VERSION}`). Any other unresolved `${TOKEN}` after substitution is
 * still an error, so a forgotten placeholder fails loud.
 */
export const renderDefSchema = z.strictObject({
  placeholders: z.record(z.string().min(1), placeholderSchema).optional(),
  fragments: z.array(fragmentSchema).optional(),
  passthrough: z.array(z.string().min(1)).optional(),
});

/** Closed `strategy` enum kills the silent-skip class. `block` is forbidden on structured (`.json*`/`.ya?ml`) paths, since its append semantics corrupt a single-root document. */
export const managedFileSchema = z.strictObject({
  path: z.string().min(1),
  strategy: z.enum(["full", "block", "merge", "scaffold"]),
  source: z.string().min(1),
  blockMark: z.string().min(1).optional(),
  projectFields: z.array(z.string().min(1)).optional(),
  render: z.string().min(1).optional(),
  enabledBy: z.string().min(1).optional(),
  adoption: z.enum(["expected", "unexpected"]).optional(),
  shadowedBy: z.array(z.string().min(1)).optional(),
}).superRefine((file, ctx) => {
  // Shape checks, not a security boundary: the payload is trusted at the
  // npm-dependency level (no denylist).
  if (file.path.startsWith("/")) {
    ctx.addIssue({ code: "custom", path: ["path"], message: "must be repo-relative (no leading \"/\")" });
  }
  if (file.path.includes("\\")) {
    ctx.addIssue({ code: "custom", path: ["path"], message: "must use POSIX separators (no \"\\\")" });
  }
  if (file.path.split("/").includes("..")) {
    ctx.addIssue({ code: "custom", path: ["path"], message: "must not contain \"..\" segments" });
  }
  // `package.json` is owned by the version reconcile (writes it last from a pre-write
  // snapshot); managing it as a file too would let the reconcile silently clobber that write.
  if (file.path === "package.json") {
    ctx.addIssue({ code: "custom", path: ["path"], message: "package.json is reconciled via versionSync, not a managed file" });
  }
  if (file.strategy === "block" && file.blockMark === undefined) {
    ctx.addIssue({ code: "custom", path: ["blockMark"], message: "is required when strategy is \"block\"" });
  }
  if (file.strategy !== "block" && file.blockMark !== undefined) {
    ctx.addIssue({ code: "custom", path: ["blockMark"], message: "is only allowed when strategy is \"block\"" });
  }
  if (file.strategy !== "merge" && file.projectFields !== undefined) {
    ctx.addIssue({ code: "custom", path: ["projectFields"], message: "is only allowed when strategy is \"merge\"" });
  }
  if (file.strategy === "block" && isStructuredPath(file.path)) {
    ctx.addIssue({ code: "custom", path: ["path"], message: "block strategy is not allowed on a structured (.json*/.ya?ml) file" });
  }
});

/** `detect` lets the CLI propose a profile / emit the soft mismatch warning without knowing any framework. */
export const profileDefSchema = z.strictObject({
  name: z.string().min(1),
  detect: z.strictObject({ dependency: z.string().min(1), majorIs: z.number().int() }).optional(),
});

/** `versionProfiles` inner keys are bounded by the reconcile safety pattern (aligned with `engine/versions.ts` PACKAGE_SECTIONS). */
export const presetManifestSchema = z.strictObject({
  name: z.string().min(1),
  extends: z.array(z.string().min(1)).optional(),
  files: z.array(managedFileSchema),
  // Checked in the superRefine below, not via a key-schema regex: zod's generic
  // "Invalid key in record" message would hide the actual pattern.
  versionProfiles: z.record(z.string().min(1), z.record(z.string().min(1), z.string())).optional(),
  renders: z.record(z.string().min(1), renderDefSchema).optional(),
  configKeys: z.record(z.string().min(1), z.enum(CONFIG_KEY_TYPES)).optional(),
}).superRefine((preset, ctx) => {
  if (preset.files.length === 0 && (preset.extends === undefined || preset.extends.length === 0)) {
    ctx.addIssue({ code: "custom", path: ["files"], message: "must be non-empty unless the preset extends a parent" });
  }
  for (const [profile, keys] of Object.entries(preset.versionProfiles ?? {})) {
    for (const key of Object.keys(keys)) {
      if (!RECONCILABLE_KEY_PATTERN.test(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["versionProfiles", profile, key],
          message: `"${key}" must be a reconcilable version key (engines.*, packageManager, dependencies.<name>, (dev|peer|optional)Dependencies.<name>, scripts.<name>)`,
        });
      }
    }
  }
});

/** The top-level payload index (`presets/manifest.json`, v2). */
export const payloadManifestSchema = z.strictObject({
  schemaVersion: z.literal(SUPPORTED_SCHEMA_VERSION),
  presets: z.array(z.string().min(1)),
  profiles: z.array(profileDefSchema),
  defaultBase: z.string().min(1),
});

export type Placeholder = z.infer<typeof placeholderSchema>;
export type Fragment = z.infer<typeof fragmentSchema>;
export type RenderDef = z.infer<typeof renderDefSchema>;
export type ManagedFile = z.infer<typeof managedFileSchema>;
export type ProfileDef = z.infer<typeof profileDefSchema>;
export type PresetManifest = z.infer<typeof presetManifestSchema>;
export type PayloadManifest = z.infer<typeof payloadManifestSchema>;

/** zod v4's `ZodError` does not extend `Error`, so callers must guard with `instanceof ZodError` before mapping. */
export function zodToIssues(error: ZodError): ConfigIssue[] {
  return error.issues.map(issue => ({
    path: issue.path.length > 0 ? issue.path.map(segment => String(segment)).join(".") : "(root)",
    message: issue.message,
  }));
}
