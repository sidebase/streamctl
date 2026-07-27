import type { ArgsDef } from "citty";
import { parseArgs } from "citty";
import { describe, expect, it } from "vitest";
import { initCommand } from "../src/commands/init";
import { syncCommand } from "../src/commands/sync";
import { upgradeCommand } from "../src/commands/upgrade";

// citty turns `--no-<x>` into `x: false`, so a boolean arg literally named
// `no-install` would never be set. The flag is declared as `install` (default
// true) instead, and both commands read `args.install === false`.
describe("--no-install parsing", () => {
  const commands = [
    ["init", initCommand],
    ["upgrade", upgradeCommand],
  ] as const;

  for (const [name, command] of commands) {
    it(`${name}: --no-install gives install=false, and it defaults to true`, () => {
      const args = command.args as ArgsDef;
      expect(parseArgs(["--no-install"], args).install).toBe(false);
      expect(parseArgs([], args).install).toBe(true);
    });
  }
});

describe("--yes / --force flags", () => {
  const commands = [
    ["sync", syncCommand],
    ["upgrade", upgradeCommand],
  ] as const;

  for (const [name, command] of commands) {
    it(`${name}: --yes and --force parse to booleans`, () => {
      const args = command.args as ArgsDef;
      expect(parseArgs(["--yes"], args).yes).toBe(true);
      expect(parseArgs(["--force"], args).force).toBe(true);
      expect(parseArgs([], args).yes).toBeUndefined();
      expect(parseArgs([], args).force).toBeUndefined();
    });
  }
});
