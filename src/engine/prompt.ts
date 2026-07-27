import type { SyncBatchDecider, SyncChange, SyncDecider } from "./sync";
import { createInterface } from "node:readline";

/** True only when both stdin and stdout are TTYs; gates prompting vs CI plan. */
export function stdinIsInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

export function colorEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

/**
 * Read a single yes/no answer from stdin (prompt text on stderr to keep stdout
 * clean). Defaults to no; pass `defaultYes` for a Y/n prompt where an empty
 * answer or anything but an explicit "no" means yes.
 *
 * EOF (Ctrl-D) declines. readline never invokes the question callback on EOF,
 * only `close`, so without the listener below the promise never settles and the
 * process exits 0 mid-command with no report. Declining on EOF holds even under
 * `defaultYes`: abandoning the prompt is an abort signal, not consent. Same
 * reason EOF resolves `null` rather than `""` (empty means "take the default";
 * conflating the two would turn Ctrl-D into a yes).
 *
 * `rl.question` matters here: on close, readline still flushes an unsubmitted
 * partial line ("y" with no Enter) as a `line` event, only the pending question
 * callback gets skipped. Switch to `rl.on("line")` and that stray "y" becomes a
 * silent accept.
 */
export async function confirmViaStdin(question: string, defaultYes = false): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // `null` = EOF/closed before an answer was submitted.
    const answer = await new Promise<string | null>((resolve) => {
      // `close` also fires after a normal answer, so a stray decline must never clobber it.
      let settled = false;
      const settle = (value: string | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      rl.on("close", () => settle(null));
      rl.question(`${question} `, settle);
    });
    if (answer === null) {
      return false;
    }
    const trimmed = answer.trim();
    if (trimmed === "") {
      return defaultYes;
    }
    return defaultYes ? !/^no?$/i.test(trimmed) : /^y(es)?$/i.test(trimmed);
  } finally {
    rl.close();
  }
}

export interface InteractiveDeciderOptions {
  confirm: (question: string) => Promise<boolean>;
  renderDiff: (change: SyncChange) => string;
  write: (text: string) => void;
}

export function createInteractiveDecider(opts: InteractiveDeciderOptions): SyncDecider {
  const { confirm, renderDiff, write } = opts;
  return async (change) => {
    const tag = change.kind === "conflict" ? "CONFLICT" : change.kind;
    write(`\n[${tag}] ${change.path}\n`);
    write(renderDiff(change));
    const question = change.kind === "conflict"
      ? `Overwrite owned content in ${change.path}? [y/N]`
      : `Apply ${change.path}? [y/N]`;
    return (await confirm(question)) ? "accept" : "skip";
  };
}

export interface BatchDeciderOptions {
  confirm: (question: string, defaultYes?: boolean) => Promise<boolean>;
  renderDiff: (change: SyncChange) => string;
  write: (text: string) => void;
}

/**
 * Batch accept/skip decider: previews every safe change, then asks one
 * default-yes question instead of prompting per file. Full-file conflicts are
 * never batched; those stay per-file via {@link createInteractiveDecider}.
 */
export function createBatchDecider(opts: BatchDeciderOptions): SyncBatchDecider {
  const { confirm, renderDiff, write } = opts;
  return async (changes) => {
    for (const change of changes) {
      write(`\n[${change.kind}] ${change.path}\n`);
      write(renderDiff(change));
    }
    const noun = changes.length === 1 ? "update" : "updates";
    return (await confirm(`Apply ${changes.length} safe managed-file ${noun}? [Y/n]`, true)) ? "accept" : "skip";
  };
}
