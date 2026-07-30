import { defineCommand } from "citty";
import { loadStreamctlConfig } from "../config/load";
import { FAIL_ON_VALUES, isFailOn, runCheck } from "../engine/check";
import { StreamctlError } from "../errors";
import { resolvePayload } from "../payload/resolve";
import { executeCommand } from "./run";

export const checkCommand = defineCommand({
  meta: {
    name: "check",
    description: "Read-only drift + version-skew + outdated report (the CI gate)",
  },
  args: {
    "json": { type: "boolean", description: "Output a machine-readable JSON envelope" },
    "fail-on": {
      type: "string",
      description: "Failure threshold",
      valueHint: FAIL_ON_VALUES.join("|"),
      default: "drift",
    },
  },
  run({ args }) {
    const failOn = args["fail-on"];
    const json = Boolean(args.json);

    return executeCommand("check", json, async (reporter) => {
      // Rejected, not coerced: a typo'd gate (`outdate`) used to silently fall back
      // to `drift`, so CI passed while the user believed the outdated gate was armed.
      if (!isFailOn(failOn)) {
        throw new StreamctlError(
          "CONFIG_INVALID",
          `Unknown \`--fail-on\` value \`${String(failOn)}\`; allowed: ${FAIL_ON_VALUES.join(", ")}.`,
          { issues: [{ path: "fail-on", message: `must be one of: ${FAIL_ON_VALUES.join(", ")}` }] },
        );
      }
      const cwd = process.cwd();
      const { config } = await loadStreamctlConfig(cwd, { logger: reporter });
      const payload = await resolvePayload(cwd, config.package, config.version);
      return runCheck(cwd, payload, config, failOn, { logger: reporter });
    });
  },
});
