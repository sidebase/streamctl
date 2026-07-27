import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The subset of `paths` (posix, CWD-relative) with TRACKED uncommitted changes.
 * Untracked (`??`) and ignored (`!!`) entries are excluded on purpose: a
 * freshly-scaffolded-but-uncommitted file, e.g. straight after `init`, is new work
 * streamctl just produced, not an edit to protect.
 *
 * Returns an empty set outside a git repo or when git is unavailable, so the
 * dirty-tree guard simply does not engage and a non-git checkout is never blocked.
 */
export async function dirtyTrackedPaths(cwd: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) {
    return new Set();
  }
  try {
    // Porcelain paths are always repo-ROOT-relative while `paths` are CWD-relative:
    // in a workspace package (`packages/app`) the two never line up, and without this
    // the guard silently matched nothing. `--show-prefix` gives cwd relative to the
    // repo root (empty at the root), which is exactly what has to come back off.
    const { stdout: rawPrefix } = await execFileAsync("git", ["rev-parse", "--show-prefix"], { cwd });
    // `-z` gives NUL-delimited, unquoted output. The pathspec still scopes the query,
    // and cwd-relative pathspecs work as-is.
    const { stdout } = await execFileAsync("git", ["status", "--porcelain", "-z", "--", ...paths], { cwd });
    // Strip only the trailing newline, not surrounding whitespace: a directory name
    // may legitimately end in a space.
    return rebaseToPrefix(parsePorcelain(stdout), rawPrefix.replace(/\r?\n$/, ""));
  } catch {
    return new Set();
  }
}

/**
 * `prefix` is a `git rev-parse --show-prefix` value: POSIX, trailing slash, empty at
 * the repo root. Entries outside that subtree are dropped, since they can never match
 * a cwd-relative managed path and keeping them risks a false match. The trailing
 * slash is what keeps containment exact, so `packages/app/` does not swallow a
 * sibling `packages/app-other/…`.
 */
export function rebaseToPrefix(paths: Iterable<string>, prefix: string): Set<string> {
  if (prefix === "") {
    return new Set(paths);
  }
  const rebased = new Set<string>();
  for (const path of paths) {
    if (path.startsWith(prefix)) {
      rebased.add(path.slice(prefix.length));
    }
  }
  return rebased;
}

/**
 * `-z` is NUL-delimited and leaves paths raw: no surrounding quotes, no C-style
 * escaping, so quoted / unicode / space-bearing paths come through verbatim. The
 * newline form quotes and escapes them instead.
 *
 * Rename/copy ordering is the trap. Under `-z` git emits two fields,
 * `XY <new>\0<old>\0`, with the new path first, the reverse of the non-`-z`
 * `old -> new`. Take the new path and consume the trailing old-path field so it is
 * not read as its own bare entry.
 */
export function parsePorcelain(stdout: string): Set<string> {
  const dirty = new Set<string>();
  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    // A valid entry is `XY <path>`: 2-char status, a space, then at least one path
    // char. Shorter fields are the trailing empty field or garbage.
    if (field === undefined || field.length < 4) {
      continue;
    }
    const status = field.slice(0, 2);
    const path = field.slice(3);
    if (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") {
      i += 1;
    }
    if (status === "??" || status === "!!") {
      continue;
    }
    dirty.add(path);
  }
  return dirty;
}
