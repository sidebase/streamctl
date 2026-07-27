import type { Logger } from "../logger";
import type { PayloadManifest } from "../manifest/schema";
import type { PayloadHandle } from "../payload/resolve";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { strictParseJsonc } from "./jsonc";
import { tryLoadPayloadManifest } from "./manifest";

/** Only the two dependency records matter for profile detection (zod-lite, non-strict). */
const projectPackageSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

export type ProjectPackage = z.infer<typeof projectPackageSchema>;

/** Extract the pinned major version from a dependency range, or `null` when it doesn't pin one. Never throws. */
export function parseMajor(range: string): number | null {
  const trimmed = range.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // Comparators / unions / hyphen ranges never pin exactly one major.
  if (/[<>=|]/.test(trimmed) || trimmed.includes("||") || /\s-\s/.test(trimmed)) {
    return null;
  }
  const core = trimmed.replace(/^[~^]?v?/, "");
  const match = core.match(/^(\d+)(?:\.(?:\d+|[x*]))?(?:\.(?:\d+|[x*]))?(?:[-+][0-9a-z.-]+)?$/i);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

export interface DetectionResult {
  profile: string | null;
  evidence: string | null;
}

/** The section a dependency was found in; `devDependencies` wins over `dependencies`. */
function findDependency(pkg: ProjectPackage, name: string): { range: string; section: string } | null {
  const dev = pkg.devDependencies?.[name];
  if (dev !== undefined) {
    return { range: dev, section: "devDependencies" };
  }
  const prod = pkg.dependencies?.[name];
  if (prod !== undefined) {
    return { range: prod, section: "dependencies" };
  }
  return null;
}

/**
 * Detect the project's profile via the payload's `profiles[].detect` probes.
 * Exactly one match wins; zero or multiple return `null` so the caller falls
 * back to an explicit `--profile`.
 */
export function detectProfile(manifest: PayloadManifest, projectPkg: ProjectPackage): DetectionResult {
  const matches: DetectionResult[] = [];
  for (const profile of manifest.profiles) {
    if (!profile.detect) {
      continue;
    }
    const found = findDependency(projectPkg, profile.detect.dependency);
    if (found && parseMajor(found.range) === profile.detect.majorIs) {
      matches.push({ profile: profile.name, evidence: `${profile.detect.dependency} ${found.range} in ${found.section}` });
    }
  }
  const only = matches[0];
  return matches.length === 1 && only ? only : { profile: null, evidence: null };
}

/**
 * The soft profile-mismatch warning text, or `null` when detection finds nothing
 * or agrees with `configProfile`. Never an error: detection can be absent or
 * wrong, so a mismatch is just a note.
 */
export function profileMismatchWarning(manifest: PayloadManifest, projectPkg: ProjectPackage, configProfile: string): string | null {
  const { profile, evidence } = detectProfile(manifest, projectPkg);
  if (profile === null || profile === configProfile) {
    return null;
  }
  return `profile "${configProfile}" does not match the profile detected from package.json: "${profile}" (${evidence}).`;
}

// V2-only: a manifest-less payload has no `profiles[].detect`, so this is a no-op there.
export async function warnProfileMismatch(cwd: string, payload: PayloadHandle, configProfile: string, logger: Logger): Promise<void> {
  const manifest = await tryLoadPayloadManifest(payload);
  if (manifest === null) {
    return;
  }
  const warning = profileMismatchWarning(manifest, await readProjectPackage(cwd), configProfile);
  if (warning !== null) {
    logger.warn(warning);
  }
}

/** Read + shape-parse the project's `package.json` dependency records. Missing or malformed: empty (detection then finds nothing). */
export async function readProjectPackage(cwd: string): Promise<ProjectPackage> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, "package.json"), "utf8");
  } catch {
    return {};
  }
  // JSONC-tolerant, matching the reconcile path (`readPackageJson`): a trailing
  // comma must not blind detection while version-sync still reads the same file.
  const parsed = strictParseJsonc(raw);
  if (!parsed.ok) {
    return {};
  }
  const result = projectPackageSchema.safeParse(parsed.value);
  return result.success ? result.data : {};
}
