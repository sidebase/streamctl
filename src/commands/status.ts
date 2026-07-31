import { defineCommand } from "citty";
import { loadStreamctlConfig } from "../config/load";
import { runStatus } from "../engine/status";
import { probeLatestVersion } from "../engine/versions";
import { resolvePayload } from "../payload/resolve";
import { readCliVersion } from "./init";
import { executeCommand } from "./run";

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Read-only managed-file state overview (informational; always exits 0)",
  },
  args: {
    json: { type: "boolean", description: "Output a machine-readable JSON envelope" },
    outdated: { type: "boolean", description: "Also probe for a newer published release (skipped silently offline)" },
  },
  run({ args }) {
    const options = { json: Boolean(args.json), outdated: Boolean(args.outdated) };

    // Unlike `check`, `status` never gates: drift/conflicts are shown, not exit-coded,
    // so a successful run always exits 0. Only a config-load/payload error takes exit-1.
    return executeCommand("status", options.json, async (reporter) => {
      const cwd = process.cwd();
      const { config } = await loadStreamctlConfig(cwd, { logger: reporter });
      const payload = await resolvePayload(cwd, config.package, config.version);
      return runStatus(cwd, payload, config, {
        cliVersion: readCliVersion(),
        outdated: options.outdated,
        latestProbe: probeLatestVersion,
        logger: reporter,
      });
    });
  },
});
