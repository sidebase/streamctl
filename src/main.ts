import { defineCommand } from "citty";
import { checkCommand } from "./commands/check";
import { initCommand } from "./commands/init";
import { statusCommand } from "./commands/status";
import { syncCommand } from "./commands/sync";
import { upgradeCommand } from "./commands/upgrade";

export const main = defineCommand({
  meta: {
    name: "streamctl",
    // Injected at build time from package.json "version" (build.config.ts rollup
    // replace); avoids version bump-drift without importing package.json from src/.
    // Unbundled dev/test runs keep the literal token; the shipped dist has the real one.
    version: "__STREAMCTL_VERSION__",
    description: "Sync shared configuration from a versioned payload package across your repositories",
  },
  subCommands: {
    init: initCommand,
    sync: syncCommand,
    check: checkCommand,
    status: statusCommand,
    upgrade: upgradeCommand,
  },
});
