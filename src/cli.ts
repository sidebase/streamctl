#!/usr/bin/env node
import { runCli } from "./run-cli";

runCli(process.argv.slice(2)).catch((error: unknown) => {
  // Only truly unexpected errors reach here (usage errors are handled in runCli).
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
