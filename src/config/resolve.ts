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

/**
 * Every existing file for a spelling, in c12's precedence order — the first entry is
 * the one c12 will load.
 *
 * Walks the whole list rather than short-circuiting, which is what makes the shadow
 * warning possible: stopping at the first hit cannot see that a second exists. The cost
 * is fixed at 24 stats per run (12 extensions × 2 locations) instead of as few as 2,
 * all against paths the OS has cached, and it is noise beside jiti compiling a TS
 * config.
 */
function probeAll(cwd: string, spelling: string): string[] {
  const matches: string[] = [];
  for (const candidate of configCandidates(spelling)) {
    const abs = resolve(cwd, candidate);
    if (isFile(abs)) {
      matches.push(abs);
    }
  }
  return matches;
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
  const rootMatches = probeAll(cwd, CONFIG_FILE);
  // Probed even on a root hit: it is the only signal for the both-present warning.
  const legacyMatches = probeAll(cwd, LEGACY_CONFIG_FILE);

  // The winning location, entire. Only this one can shadow: the other is ignored
  // wholesale, so reporting a collision inside it would be noise about files that make
  // no difference either way.
  const [rootAbs] = rootMatches;
  const [legacyAbs] = legacyMatches;
  const [abs, ...shadowed] = rootAbs === undefined ? legacyMatches : rootMatches;
  if (abs === undefined) {
    return null;
  }

  const toRel = (path: string): string => relative(cwd, path).split(sep).join("/");

  // Shadow first, then cross-location: a shadow is known as soon as one location has
  // been probed, while the cross warning needs both. Pinned by test so the order stays
  // predictable in CI logs rather than following whatever the code happens to do.
  //
  // `abs` cannot appear in `shadowed`, so there is no "skip the resolved file" check
  // here: it could never fire, and a guard that cannot fire reads as protection that is
  // not there.
  //
  // Two separate properties hold this up, and they cover different hazards.
  //
  // 1. **Positional selection** removes *self*-comparison. `abs` is `matches[0]` and
  //    `shadowed` is everything after it, so the winner is excluded by where it sits in
  //    the list, whatever it points at. This is stronger than candidate distinctness,
  //    which is a claim about strings while the hazard is about files. Keep selecting by
  //    position: switching to identity- or set-based selection (dedupe by realpath, a
  //    `Set`, `filter(m => m !== abs)`) breaks this while looking like it preserves the
  //    invariant, because the distinctness test would still pass.
  //
  // 2. **Descriptive wording** is what makes *alias*-comparison harmless — and position
  //    does not help there. `statSync` follows symlinks, so a `streamctl.config.js`
  //    symlinked to `streamctl.config.ts` passes `isFile` twice and the warning names
  //    one file as shadowing itself under two paths. Measured, not hypothetical. It is
  //    only cosmetic because the message *describes* ("Y is the one being read") rather
  //    than *instructs*: the `shadowedBy` precedent says "port and delete", which in
  //    this state would tell someone to delete the file their config actually lives in.
  //    Pinned by the symlink test in `resolve.test.ts`, which asserts the message
  //    carries no imperative. Do not add one.
  if (shadowed.length > 0) {
    logger?.warn(
      `streamctl: ${shadowed.map(toRel).join(" and ")} ${shadowed.length > 1 ? "are" : "is"} shadowed by ${toRel(abs)}; ${toRel(abs)} is the one being read.`,
    );
  }

  if (rootAbs !== undefined && legacyAbs !== undefined) {
    logger?.warn(
      `streamctl: both ${toRel(rootAbs)} and ${toRel(legacyAbs)} exist; using ${toRel(rootAbs)} and ignoring ${toRel(legacyAbs)}.`,
    );
  }

  return { abs, rel: toRel(abs), source: rootAbs === undefined ? "legacy" : "root" };
}
