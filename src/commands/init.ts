import type { SyncChange, SyncDecider, SyncPreview } from "../engine/sync";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand } from "citty";
import { renderDiff } from "../engine/diff";
import { CLI_PKG, runInit } from "../engine/init";
import { createInstaller, createRegistryAuthCheck, detectPm } from "../engine/pm";
import { colorEnabled, confirmViaStdin, createInteractiveDecider, stdinIsInteractive } from "../engine/prompt";
import { probeLatestVersion, probeVersionExists } from "../engine/versions";
import { StreamctlError } from "../errors";
import { executeCommand, rejectEmptyFlags } from "./run";

/** Reads the running CLI's own version; the release `init` pins the repo to it. */
export function readCliVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
        if (pkg.name === CLI_PKG && typeof pkg.version === "string") {
          return pkg.version;
        }
      } catch {
        // Keep walking up to the package root.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return "0.0.0";
    }
    dir = parent;
  }
}

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Wire a repo to a preset for the first time",
  },
  args: {
    "package": { type: "string", description: "Payload package to wire (required)", valueHint: "name" },
    "payload-version": { type: "string", description: "Payload version to pin (default: latest published)", valueHint: "version" },
    "base": { type: "string", description: "Preset to derive from (defaults to the payload's defaultBase)", valueHint: "preset" },
    "profile": { type: "string", description: "Version profile (auto-detected from the payload manifest when omitted)", valueHint: "name" },
    "skip-registry-check": { type: "boolean", description: "Skip the payload registry auth probe" },
    // Defined as `install` (default true) so citty renders + parses `--no-install`
    // correctly: an arg literally named `no-install` gets swallowed by citty's
    // `--no-<x>` negation and never sets a value.
    "install": { type: "boolean", default: true, description: "Install the payload after wiring; --no-install scaffolds + wires deps but skips install and the first sync" },
    "yes": { type: "boolean", description: "Non-interactive; accept detected defaults" },
    "json": { type: "boolean", description: "Output a machine-readable JSON envelope" },
  },
  run({ args }) {
    const options = {
      package: typeof args.package === "string" ? args.package : undefined,
      payloadVersion: typeof args["payload-version"] === "string" ? args["payload-version"] : undefined,
      base: typeof args.base === "string" ? args.base : undefined,
      profile: typeof args.profile === "string" ? args.profile : undefined,
      skipRegistryCheck: Boolean(args["skip-registry-check"]),
      noInstall: args.install === false,
      yes: Boolean(args.yes),
      json: Boolean(args.json),
    };

    return executeCommand("init", options.json, async (reporter) => {
      rejectEmptyFlags(args);
      if (options.package === undefined) {
        throw new StreamctlError(
          "CONFIG_INVALID",
          "The `--package <name>` flag is required. It names the payload package to wire.",
          { issues: [{ path: "package", message: "is required" }] },
        );
      }
      const cwd = process.cwd();
      // The first sync prompts only on a real TTY; otherwise degrade to a
      // greppable plan on stderr (`--yes` skips both, headless defaults).
      const color = colorEnabled();
      const preview = (change: SyncChange): string => renderDiff(change.path, change.before ?? "", change.after, { color });
      let decider: SyncDecider | undefined;
      let onPreview: SyncPreview | undefined;
      if (!options.yes && stdinIsInteractive()) {
        decider = createInteractiveDecider({ confirm: confirmViaStdin, renderDiff: preview, write: t => process.stderr.write(t) });
      } else if (!options.yes) {
        onPreview = change => process.stderr.write(`[plan] ${change.kind} ${change.path}\n${preview(change)}`);
      }

      // Prompt before installing only on an interactive TTY (`--yes`/`--no-install` skip it).
      const installConfirm = !options.yes && !options.noInstall && stdinIsInteractive() ? confirmViaStdin : undefined;

      const result = await runInit({
        cwd,
        package: options.package,
        // The CLI's own version pins only the streamctl devDep; the payload's pin is
        // resolved separately (explicit flag, then override, then registry latest).
        cliVersion: readCliVersion(),
        payloadVersion: options.payloadVersion,
        latestProbe: probeLatestVersion,
        versionExists: probeVersionExists,
        base: options.base,
        profile: options.profile,
        yes: options.yes,
        install: createInstaller({ confirm: installConfirm, skip: options.noInstall }),
        checkRegistryAuth: createRegistryAuthCheck(),
        skipRegistryCheck: options.skipRegistryCheck,
        noInstall: options.noInstall,
        decider,
        onPreview,
        logger: reporter,
      });

      // `sync: null` means install was skipped (`--no-install`) or declined at the prompt.
      if (result.sync === null) {
        const pm = await detectPm(cwd);
        reporter.warn(`install skipped. Run \`${pm.name} install\`, then \`streamctl sync\`.`);
      }
      return result;
    });
  },
});
