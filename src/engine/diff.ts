import { diffLines } from "diff";

const RED = "[31m";
const GREEN = "[32m";
const RESET = "[0m";

export interface RenderDiffOptions {
  color?: boolean;
}

/**
 * Render a readable line diff with `+`/`-`/` ` markers (jsdiff). Plain by
 * default; color only when explicitly enabled, so `NO_COLOR` and non-TTY output
 * stays ANSI-free and greppable.
 */
export function renderDiff(path: string, before: string, after: string, opts: RenderDiffOptions = {}): string {
  const color = opts.color ?? false;
  const lines: string[] = [`--- ${path}`, `+++ ${path}`];

  for (const part of diffLines(before, after)) {
    const sign = part.added ? "+" : part.removed ? "-" : " ";
    const body = part.value.split("\n");
    if (body.at(-1) === "") {
      body.pop();
    }
    for (const line of body) {
      const text = `${sign}${line}`;
      if (color && sign === "+") {
        lines.push(`${GREEN}${text}${RESET}`);
      } else if (color && sign === "-") {
        lines.push(`${RED}${text}${RESET}`);
      } else {
        lines.push(text);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}
