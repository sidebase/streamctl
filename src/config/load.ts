import type { Logger } from "../logger";
import type { ConfigFileLocation } from "./resolve";
import type { StreamctlConfig } from "./types";
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { loadConfig } from "c12";
import { StreamctlError } from "../errors";
import { relativizeForDisplay } from "../paths";
import { CONFIG_FILE, LEGACY_CONFIG_FILE, resolveConfigFile } from "./resolve";
import { validateStreamctlConfig } from "./validate";

export interface LoadedStreamctlConfig {
  config: StreamctlConfig;
  location: ConfigFileLocation;
}

/**
 * Do two paths name the same underlying file? Not a string comparison, for three
 * independent reasons: c12 takes its path helpers from pathe, which always emits
 * forward slashes, while `location.abs` comes from `node:path` and is backslashed on
 * Windows; exsolve may expand a Windows 8.3 short name; and `statSync` follows
 * symlinks, so the probe reports the link while c12 may report its target.
 *
 * `realpathSync` throws if either path vanished between the probe and the load, which
 * counts as a disagreement rather than an fs error to surface.
 */
function sameFile(a: string, b: string): boolean {
  const norm = (path: string): string => realpathSync(path).split(sep).join("/");
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/**
 * Resolve, load and validate this repo's config: `streamctl.config.ts` at `cwd`, or a
 * legacy `.streamctl/config.ts`.
 *
 * - Missing config: throws `NOT_INITIALIZED`, without loading anything.
 * - Schema failure: throws `CONFIG_INVALID` (naming the offending field/path).
 *
 * The location is resolved before c12 is involved, so `loadConfig` runs exactly once
 * for a file already known to exist — and never at all for an uninitialized repo.
 *
 * There is deliberately no framework detection in the CLI; detection is
 * payload-driven.
 */
export async function loadStreamctlConfig(
  cwd: string,
  opts?: { logger?: Logger },
): Promise<LoadedStreamctlConfig> {
  const location = await resolveConfigFile(cwd, opts?.logger);
  if (location === null) {
    throw new StreamctlError(
      "NOT_INITIALIZED",
      "No streamctl config found (streamctl.config.ts, or a legacy .streamctl/config.ts). Run `streamctl init` first.",
    );
  }

  // The relative spelling, never `location.abs`: c12 builds jiti's base as
  // `join(cwd, configFile)` (`dist/index.mjs:123`), which doubles an absolute path.
  const { config, _configFile } = await loadConfig<Partial<StreamctlConfig>>({
    cwd,
    name: "streamctl",
    configFile: location.source === "root" ? CONFIG_FILE : LEGACY_CONFIG_FILE,
    rcFile: false,
    globalRc: false,
    packageJson: false,
    dotenv: false,
    envName: false,
  });

  // The probe and c12 must agree on which file won. Disagreement means c12 found
  // something the probe did not — i.e. the `.config/` exclusion has broken — so it is a
  // broken installation or a c12 behavior change, not a user error.
  if (_configFile === undefined || !sameFile(_configFile, location.abs)) {
    throw new StreamctlError(
      "CONFIG_INVALID",
      `Resolved ${location.rel}, but c12 loaded a different file. This is a streamctl or c12 bug, not a problem with your config.`,
      {
        path: location.rel,
        loaded: _configFile === undefined ? null : relativizeForDisplay(cwd, _configFile),
      },
    );
  }

  return { config: validateStreamctlConfig(config), location };
}
