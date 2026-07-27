import type { Installer, RegistryAuthCheck } from "./init";
import type { LatestVersionProbe, VersionExistsProbe } from "./versions";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { detectPackageManager, installDependencies } from "nypm";

const execFileAsync = promisify(execFile);

/**
 * The package managers streamctl drives. This module is the only place in
 * the CLI that names a package manager: detection, installs, and registry
 * probes all funnel through here so the rest of the code stays PM-agnostic.
 */
export type PmName = "npm" | "pnpm" | "yarn" | "bun";

const SUPPORTED_PMS: readonly PmName[] = ["npm", "pnpm", "yarn", "bun"];

/** Canonical lockfile per PM: the fallback name and what the upgrade snapshot reads. */
const LOCKFILES: Record<PmName, string> = {
  npm: "package-lock.json",
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
  bun: "bun.lock",
};

export interface DetectedPm {
  name: PmName;
  /** The lockfile the detected PM writes (best-effort; used by the upgrade snapshot). */
  lockfile: string;
}

/** npm is the safe default when nothing is detected or the PM is unsupported. */
const DEFAULT_PM: DetectedPm = { name: "npm", lockfile: LOCKFILES.npm };

function isSupported(name: string): name is PmName {
  return (SUPPORTED_PMS as readonly string[]).includes(name);
}

export async function detectPm(cwd: string): Promise<DetectedPm> {
  // ignoreArgv: nypm's argv fallback matches the running process's script path
  // (e.g. a vitest worker resolves to "pnpm"). We only want the consumer repo's
  // own files, never how streamctl itself was invoked.
  const detected = await detectPackageManager(cwd, { includeParentDirs: true, ignoreArgv: true });
  if (!detected || !isSupported(detected.name)) {
    return DEFAULT_PM;
  }
  // nypm lists a PM's legacy lockfile first (bun: `["bun.lockb", "bun.lock"]`), so the
  // head can name a file current bun never writes. The upgrade snapshot would then
  // watch a path that cannot exist and silently skip the real lockfile on rollback.
  // Take whichever candidate is actually on disk, else this PM's canonical name.
  const candidates = [detected.lockFile ?? []].flat();
  const present = candidates.find(name => findLockfile(cwd, name) !== null);
  return { name: detected.name, lockfile: present ?? LOCKFILES[detected.name] };
}

export function installCommand(pm: PmName): string {
  return `${pm} install`;
}

/**
 * The repo root: the nearest ancestor of `cwd` (inclusive) holding a `.git` entry.
 * `.git` is a directory in a normal checkout and a file in a worktree/submodule, so
 * `existsSync` covers both. `null` when `cwd` is not inside a git repo.
 */
function findGitRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null; // fs root
    }
    dir = parent;
  }
}

/**
 * Absolute path of the repo's lockfile, or `null` when it has none. Searches `cwd`
 * upward to the git root INCLUSIVE, because in a monorepo the lockfile lives at the
 * workspace root, not the package dir streamctl runs from.
 *
 * The search never leaves the repo: outside a git checkout only `cwd` is considered.
 * `upgrade`'s rollback WRITES to the path this returns, so a walk that could reach a
 * stray lockfile in an ancestor of the repo (`/tmp/pnpm-lock.yaml` above a temp dir)
 * would let a rollback clobber a file the repo does not own.
 *
 * Takes the lockfile name rather than detecting the PM, so a caller that already has
 * a {@link DetectedPm} does not pay for a second detection.
 */
export function findLockfile(cwd: string, lockfile: string): string | null {
  const root = findGitRoot(cwd);
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, lockfile);
    if (existsSync(candidate)) {
      return candidate;
    }
    if (root === null || dir === root) {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null; // fs root; unreachable while `root` is an ancestor
    }
    dir = parent;
  }
}

export async function lockfileExists(cwd: string): Promise<boolean> {
  const pm = await detectPm(cwd);
  return findLockfile(cwd, pm.lockfile) !== null;
}

/** `spec` is `<pkg>` (latest) or `<pkg>@<version>` (existence). npm/pnpm print a bare version; yarn prints JSON. */
export function viewArgv(pm: PmName, spec: string): { command: string; args: string[] } {
  switch (pm) {
    case "yarn":
      return { command: "yarn", args: ["npm", "info", spec, "--fields", "version", "--json"] };
    case "bun":
      return { command: "bun", args: ["pm", "view", spec, "version"] };
    case "npm":
    case "pnpm":
      return { command: pm, args: ["view", spec, "version"] };
  }
}

/** Injectable command runner: resolves stdout, rejects on a non-zero exit. Real spawns only outside tests. */
export type PmRunner = (command: string, args: string[], cwd: string) => Promise<string>;

const defaultRunner: PmRunner = async (command, args, cwd) => {
  const { stdout } = await execFileAsync(command, args, { cwd });
  return stdout;
};

/** Extract a version from a `view` result: JSON for yarn, bare string otherwise. `null` when absent/unparsable. */
function parseVersion(pm: PmName, stdout: string): string | null {
  const raw = stdout.trim();
  if (raw.length === 0) {
    return null;
  }
  if (pm === "yarn") {
    try {
      const parsed = JSON.parse(raw) as { version?: unknown };
      return typeof parsed.version === "string" ? parsed.version : null;
    } catch {
      return null;
    }
  }
  return raw;
}

/** On a spawn error (PM missing / no view subcommand) retries once with `npm view`. */
async function runView(pm: PmName, spec: string, cwd: string, run: PmRunner): Promise<string | null> {
  const primary = viewArgv(pm, spec);
  try {
    return parseVersion(pm, await run(primary.command, primary.args, cwd));
  } catch {
    if (pm === "npm") {
      return null;
    }
    const fallback = viewArgv("npm", spec);
    try {
      return parseVersion("npm", await run(fallback.command, fallback.args, cwd));
    } catch {
      return null;
    }
  }
}

export function createLatestProbe(run: PmRunner = defaultRunner): LatestVersionProbe {
  return async (cwd, packageName) => {
    const pm = await detectPm(cwd);
    return runView(pm.name, packageName, cwd, run);
  };
}

export function createExistsProbe(run: PmRunner = defaultRunner): VersionExistsProbe {
  return async (cwd, packageName, version) => {
    const pm = await detectPm(cwd);
    return (await runView(pm.name, `${packageName}@${version}`, cwd, run)) !== null;
  };
}

export function createRegistryAuthCheck(run: PmRunner = defaultRunner): RegistryAuthCheck {
  return async (cwd, packageName) => {
    const pm = await detectPm(cwd);
    return (await runView(pm.name, packageName, cwd, run)) !== null;
  };
}

export interface CreateInstallerOptions {
  /** Present only on a real TTY. Defaults to yes, unlike sync's destructive prompts, since installing is the safe path here. */
  confirm?: (question: string, defaultYes: boolean) => Promise<boolean>;
  /** `--no-install`: resolve without installing (the caller reports the skip). */
  skip?: boolean;
  /** Install seam (defaults to nypm `installDependencies`); injected in tests. */
  install?: (cwd: string, pm: PmName) => Promise<void>;
}

async function defaultInstallDeps(cwd: string, pm: PmName): Promise<void> {
  await installDependencies({ cwd, packageManager: pm });
}

/** Used by `upgrade`'s rollback to reconcile `node_modules` with the restored `package.json` after a failed run. */
export async function reinstallDependencies(cwd: string, install: (cwd: string, pm: PmName) => Promise<void> = defaultInstallDeps): Promise<void> {
  const pm = await detectPm(cwd);
  await install(cwd, pm.name);
}

export function createInstaller(opts: CreateInstallerOptions = {}): Installer {
  const install = opts.install ?? defaultInstallDeps;
  return async (cwd) => {
    if (opts.skip === true) {
      return { installed: false };
    }
    const pm = await detectPm(cwd);
    if (opts.confirm && !(await opts.confirm(`Run ${pm.name} install now? [Y/n]`, true))) {
      return { installed: false };
    }
    await install(cwd, pm.name);
    return { installed: true };
  };
}
