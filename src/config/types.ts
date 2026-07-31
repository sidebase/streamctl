import type { RenderDef } from "../manifest/schema";

/** Left open on purpose: the valid domain is owned by the resolved payload. */
export type Profile = string;

/**
 * - `full`: overwrite the whole file.
 * - `block`: maintain only the `BEGIN/END {mark}` region, preserve the rest.
 * - `merge`: structured JSONC deep-merge, streamctl owns listed keys.
 * - `scaffold`: write only if absent, never overwrite, not drift-checked.
 */
export type SyncStrategy = "full" | "block" | "merge" | "scaffold";

/**
 * Bounds the shape of a `package.json` key the version reconcile may touch. Not a
 * trust boundary: the payload is a trusted npm dependency, so there is no denylist.
 * Which keys actually get reconciled comes from the payload's `versionProfiles`
 * baseline. Dependency sections are anchored to exact npm field names so mis-cased
 * keys never match.
 */
export const RECONCILABLE_KEY_PATTERN
  = /^(?:engines\.[a-zA-Z]+|packageManager|(?:(?:dev|peer|optional)Dependencies|dependencies)\..+|scripts\..+)$/;

export interface ManagedFile {
  path: string;
  strategy: SyncStrategy;
  /** Template path within the package's bundled `presets/`. */
  source: string;
  /** Required when `strategy = "block"`. */
  blockMark?: string;
  /** Required when `strategy = "merge"`. Top-level keys the merge must not overwrite (e.g. VS Code's flat dotted `"editor.fontSize"`). */
  projectFields?: string[];
  /** When set, `renderFile` drives composition; otherwise the template passes through raw. */
  renderDef?: RenderDef;
  /** Config boolean dot-path. Absent or `false` excludes the file, same as `files: off`. */
  enabledBy?: string;
  /**
   * Marks a file the payload is newly taking over, so a pre-existing differing
   * `full` file is classified as an `adoption` conflict rather than an `edit`.
   * `"expected"` softens the resolution text, `"unexpected"` warns.
   */
  adoption?: "expected" | "unexpected";
  /**
   * Sibling paths whose presence makes this scaffold file inert, e.g. a scaffolded
   * `eslint.config.ts` shadowed by an existing `eslint.config.mjs`. The payload
   * declares them, which is what keeps the CLI framework-blind.
   */
  shadowedBy?: string[];
}

/** The per-repo manifest owned by a consuming repo (`streamctl.config.ts`). */
export interface StreamctlConfig {
  /** The CLI ships no default. */
  package: string;
  base: string;
  version: string;
  /** Any non-empty string; must name a profile the payload manifest declares in `profiles[]` (e.g. `"nuxt-4"`). */
  profile: Profile;
  /** Master opt-out for `package.json` version reconciliation. Default `true`. */
  versionSync?: boolean;
  /** e.g. `["devDependencies.typescript"]`. */
  versionSyncExclude?: string[];
  /** Opaque to the CLI, forwarded verbatim to the payload's typed wrapper. */
  eslint?: Record<string, unknown>;
  /** Injected into the Dockerfile `APT_PACKAGES` arg. */
  aptPackages?: string[];
  /**
   * Free-form by design. Shape is validated against the resolved payload's
   * `configKeys` rather than a built-in toggle set, which keeps the CLI out of
   * org-specific job naming.
   */
  ci?: Record<string, boolean | string | string[]>;
  /** e.g. `{ ".vscode/settings.json": "off" }`. */
  files?: Record<string, "managed" | "off">;
}
