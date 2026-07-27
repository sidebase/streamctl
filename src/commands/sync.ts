import type { SyncChange, SyncDecider, SyncPreview } from "../engine/sync";
import { defineCommand } from "citty";
import { loadStreamctlConfig } from "../config/load";
import { validateStreamctlConfigWithKeys } from "../config/validate";
import { warnProfileMismatch } from "../engine/detect";
import { renderDiff } from "../engine/diff";
import { resolvePresetChain } from "../engine/manifest";
import { detectPm, installCommand } from "../engine/pm";
import { colorEnabled, confirmViaStdin, createBatchDecider, createInteractiveDecider, stdinIsInteractive } from "../engine/prompt";
import { runSync } from "../engine/sync";
import { resolvePayload } from "../payload/resolve";
import { executeCommand, rejectEmptyFlags } from "./run";

export const syncCommand = defineCommand({
  meta: {
    name: "sync",
    description: "Compose preset + project deltas, detect drift, write managed files",
  },
  args: {
    "interactive": { type: "boolean", description: "Per-file accept/skip prompts" },
    "dry-run": { type: "boolean", description: "Compute and report; write nothing" },
    "only": { type: "string", description: "Glob: limit to matching files", valueHint: "glob" },
    "version-sync": { type: "boolean", description: "Reconcile the version allow-list", default: true },
    "yes": { type: "boolean", description: "Accept creates + safe reconciles without prompting (conflicts still need --interactive or --force)" },
    "force": { type: "boolean", description: "Accept all overwrites without prompting" },
    "json": { type: "boolean", description: "Output a machine-readable JSON envelope" },
  },
  run({ args }) {
    const options = {
      interactive: Boolean(args.interactive),
      dryRun: Boolean(args["dry-run"]),
      only: typeof args.only === "string" ? args.only : undefined,
      versionSync: args["version-sync"] !== false,
      yes: Boolean(args.yes),
      force: Boolean(args.force),
      json: Boolean(args.json),
    };

    return executeCommand("sync", options.json, async (reporter) => {
      rejectEmptyFlags(args);
      const cwd = process.cwd();
      const loaded = await loadStreamctlConfig(cwd);
      const config = options.versionSync ? loaded : { ...loaded, versionSync: false };
      const payload = await resolvePayload(cwd, config.package, config.version);
      await warnProfileMismatch(cwd, payload, config.profile, reporter);
      const { files: managedFiles, baseline, configKeys } = await resolvePresetChain(payload, config.base, config.profile);
      // Stage 2: validate payload-declared config knobs against the merged
      // configKeys; a payload without configKeys makes this a no-op.
      validateStreamctlConfigWithKeys(config, configKeys);

      // Prompt only on a real TTY; otherwise (CI / piped) degrade to a deterministic,
      // greppable plan printed to stderr while applying the headless policy.
      const color = colorEnabled();
      const preview = (change: SyncChange): string => renderDiff(change.path, change.before ?? "", change.after, { color });
      const canPrompt = options.interactive && !options.dryRun && !options.force && stdinIsInteractive();

      const write = (t: string): boolean => process.stderr.write(t);
      let decider: SyncDecider | undefined;
      let batchDecider: ReturnType<typeof createBatchDecider> | undefined;
      let onPreview: SyncPreview | undefined;
      if (canPrompt) {
        decider = createInteractiveDecider({ confirm: confirmViaStdin, renderDiff: preview, write });
        batchDecider = createBatchDecider({ confirm: confirmViaStdin, renderDiff: preview, write });
      } else if (options.interactive || options.dryRun) {
        onPreview = change => process.stderr.write(`[plan] ${change.kind} ${change.path}\n${preview(change)}`);
      }

      const result = await runSync({
        cwd,
        payload,
        config,
        managedFiles,
        baseline,
        dryRun: options.dryRun,
        yes: options.yes,
        force: options.force,
        only: options.only,
        decider,
        batchDecider,
        onPreview,
        logger: reporter,
      });

      // package.json changed and a lockfile exists: name the detected PM's install
      // command in the report (sync itself never installs; init/upgrade own that).
      if (result.lockfileStale) {
        const pm = await detectPm(cwd);
        reporter.lockfileHint = installCommand(pm.name);
      }

      return result;
    });
  },
});
