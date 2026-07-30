import type { Logger } from "../logger";
import { statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { SUPPORTED_EXTENSIONS } from "c12";

/** The resolved answer to "where does this repo's config live". */
export interface ConfigFileLocation {
  abs: string;
  /** `cwd`-relative, POSIX-separated on every platform. Doubles as a git pathspec. */
  rel: string;
  /** Which of the two supported locations matched. */
  source: "root" | "legacy";
}

/** Default location: `streamctl.config.<ext>` at the invocation directory. */
export const CONFIG_FILE = "streamctl.config";

/** Legacy location, read indefinitely: `.streamctl/config.<ext>`. */
export const LEGACY_CONFIG_FILE = ".streamctl/config";

/**
 * c12's own extension list, in its own precedence order (note `.js` precedes `.ts`).
 * Imported rather than restated so the two can never drift apart.
 */
const EXTENSIONS: readonly string[] = SUPPORTED_EXTENSIONS;

/**
 * A spelling crossed with every supported extension, in c12's order. Exported only so
 * a test can pin the candidate list to c12's export.
 *
 * @internal
 */
export function configCandidates(spelling: string): string[] {
  return EXTENSIONS.map(ext => `${spelling}${ext}`);
}

/**
 * `isFile`, not `existsSync`: a *directory* named `streamctl.config.ts` would pass an
 * existence check and be returned as a root hit, shadowing a real legacy config and
 * handing `load.ts` an `abs` that c12 will not corroborate.
 *
 * `throwIfNoEntry` suppresses ENOENT only, so EACCES on an unreadable parent still
 * throws; the catch is what keeps `resolveConfigFile` total.
 */
function isFile(abs: string): boolean {
  try {
    return statSync(abs, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

function probe(cwd: string, spelling: string): string | null {
  for (const candidate of configCandidates(spelling)) {
    const abs = resolve(cwd, candidate);
    if (isFile(abs)) {
      return abs;
    }
  }
  return null;
}

/**
 * Locate the repo's config, root location first. Returns `null` when neither location
 * holds one; never throws.
 *
 * The probe runs *before* anything is loaded, and that ordering is what keeps c12's
 * `.config/` fallbacks out: `tryResolve` exhausts every extension on the primary path
 * before trying `.config/` (`c12/dist/index.mjs:334-343`), so handing the loader a
 * spelling whose file is known to exist makes those branches unreachable. Probing
 * after a load, or loading speculatively, silently re-admits `.config/` paths.
 *
 * `logger` is optional with no `stderrLogger` fallback — a deliberate deviation from
 * the house `opts.logger ?? stderrLogger` default, because `init` calls this without a
 * logger precisely to stay quiet ahead of its `ALREADY_INITIALIZED` failure.
 *
 * `async` with nothing awaited is deliberate — the signature stays `Promise`-returning
 * so `init`'s guard and `load.ts` keep `await`ing it, and a move to `fs.promises` is
 * not a breaking change (`50_api.md`).
 */
export async function resolveConfigFile(cwd: string, logger?: Logger): Promise<ConfigFileLocation | null> {
  const rootAbs = probe(cwd, CONFIG_FILE);
  // Probed even on a root hit: it is the only signal for the both-present warning.
  const legacyAbs = probe(cwd, LEGACY_CONFIG_FILE);
  const abs = rootAbs ?? legacyAbs;
  if (abs === null) {
    return null;
  }

  const toRel = (path: string): string => relative(cwd, path).split(sep).join("/");

  if (rootAbs !== null && legacyAbs !== null) {
    logger?.warn(
      `streamctl: both ${toRel(rootAbs)} and ${toRel(legacyAbs)} exist; using ${toRel(rootAbs)} and ignoring ${toRel(legacyAbs)}.`,
    );
  }

  return { abs, rel: toRel(abs), source: rootAbs !== null ? "root" : "legacy" };
}
