import type { StreamctlConfig } from "./types";
import { loadConfig } from "c12";
import { StreamctlError } from "../errors";
import { validateStreamctlConfig } from "./validate";

/**
 * Load and validate `.streamctl/config.ts` from `cwd`.
 *
 * - Missing config: throws `NOT_INITIALIZED`.
 * - Schema failure: throws `CONFIG_INVALID` (naming the offending field/path).
 *
 * There is deliberately no framework detection in the CLI; detection is
 * payload-driven.
 */
export async function loadStreamctlConfig(cwd: string): Promise<StreamctlConfig> {
  const { config, _configFile } = await loadConfig<Partial<StreamctlConfig>>({
    cwd,
    name: "streamctl",
    configFile: ".streamctl/config",
    rcFile: false,
    globalRc: false,
    packageJson: false,
    dotenv: false,
    envName: false,
  });

  if (!_configFile) {
    throw new StreamctlError(
      "NOT_INITIALIZED",
      "No .streamctl/config.ts found in this repo. Run `streamctl init` first.",
    );
  }

  return validateStreamctlConfig(config);
}
