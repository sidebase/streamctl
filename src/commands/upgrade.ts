import type { SyncChange, SyncDecider, SyncPreview } from "../engine/sync";
import { defineCommand } from "citty";
import { renderDiff } from "../engine/diff";
import { createInstaller, detectPm, installCommand } from "../engine/pm";
import { colorEnabled, confirmViaStdin, createBatchDecider, createInteractiveDecider, stdinIsInteractive } from "../engine/prompt";
import { runUpgrade } from "../engine/upgrade";
import { probeLatestVersion, probeVersionExists } from "../engine/versions";
import { executeCommand, rejectEmptyFlags } from "./run";

export const upgradeCommand = defineCommand({
  meta: {
    name: "upgrade",
    description: "Move the pinned version forward, bump deps, then re-sync",
  },
  args: {
    "to": { type: "string", description: "Target version (default: latest published)", valueHint: "version" },
    "dry-run": { type: "boolean", description: "Compute and report; write nothing" },
    // Defined as `install` (default true) so citty renders + parses `--no-install`
    // correctly: an arg literally named `no-install` gets swallowed by citty's
    // `--no-<x>` negation and never sets a value.
    "install": { type: "boolean", default: true, description: "Install after bumping; --no-install bumps the pin + deps but skips install and the re-sync" },
    "yes": { type: "boolean", description: "Accept creates + safe reconciles in the chained sync (conflicts still need a TTY or --force)" },
    "force": { type: "boolean", description: "Accept all overwrites (incl. conflicts) in the chained sync" },
    "json": { type: "boolean", description: "Output a machine-readable JSON envelope" },
  },
  run({ args }) {
    const options = {
      to: typeof args.to === "string" ? args.to : undefined,
      dryRun: Boolean(args["dry-run"]),
      noInstall: args.install === false,
      yes: Boolean(args.yes),
      force: Boolean(args.force),
      json: Boolean(args.json),
    };

    return executeCommand("upgrade", options.json, async (reporter) => {
      rejectEmptyFlags(args);
      // The chained sync is interactive by default: prompt on a real TTY,
      // otherwise (CI / piped) degrade to a greppable plan on stderr.
      const color = colorEnabled();
      const preview = (change: SyncChange): string => renderDiff(change.path, change.before ?? "", change.after, { color });
      const write = (t: string): boolean => process.stderr.write(t);
      let decider: SyncDecider | undefined;
      let batchDecider: ReturnType<typeof createBatchDecider> | undefined;
      let onPreview: SyncPreview | undefined;
      if (!options.dryRun && stdinIsInteractive()) {
        decider = createInteractiveDecider({ confirm: confirmViaStdin, renderDiff: preview, write });
        batchDecider = createBatchDecider({ confirm: confirmViaStdin, renderDiff: preview, write });
      } else {
        onPreview = change => process.stderr.write(`[plan] ${change.kind} ${change.path}\n${preview(change)}`);
      }

      const cwd = process.cwd();
      // Prompt before installing only on an interactive TTY; `--yes`/`--force`
      // (like `--dry-run`/`--no-install`) run non-interactively, so no install prompt.
      const installConfirm = !options.dryRun && !options.noInstall && !options.yes && !options.force && stdinIsInteractive() ? confirmViaStdin : undefined;

      const result = await runUpgrade({
        cwd,
        to: options.to,
        dryRun: options.dryRun,
        install: createInstaller({ confirm: installConfirm, skip: options.noInstall }),
        noInstall: options.noInstall,
        latestProbe: probeLatestVersion,
        versionExists: probeVersionExists,
        yes: options.yes,
        force: options.force,
        decider,
        batchDecider,
        onPreview,
        logger: reporter,
      });

      if (options.dryRun) {
        // Non-JSON dry-run can't preview the new presets until they're installed.
        if (!options.json && result.sync === null) {
          reporter.warn(`preview unavailable: ${result.toVersion} presets not installed; run \`streamctl upgrade\` to install and sync.`);
        }
      } else if (result.sync === null) {
        // Non-dry-run `sync: null` means install was skipped (`--no-install`) or declined.
        const pm = await detectPm(cwd);
        reporter.warn(`install skipped. Run \`${pm.name} install\`, then \`streamctl sync\`.`);
      }

      // package.json got reconciled, so surface the stale-lockfile hint in the report
      // like `sync` does. `--no-install` needs the same detected-PM command for its
      // "run `<pm> install`" footer, but its `sync` is null, so this covers it too.
      const skippedInstall = !result.dryRun && result.sync === null;
      if (result.sync?.lockfileStale || skippedInstall) {
        const pm = await detectPm(cwd);
        reporter.lockfileHint = installCommand(pm.name);
      }

      return result;
    });
  },
});
