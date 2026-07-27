/**
 * Diagnostics seam: warnings/info route here (never raw `console.*`) so `--json`
 * callers get a clean stdout; implementations write to stderr or their own channel.
 */
export interface Logger {
  warn: (message: string) => void;
}

/** Default logger for use outside a command context. */
export const stderrLogger: Logger = {
  warn(message) {
    process.stderr.write(`${message}\n`);
  },
};
