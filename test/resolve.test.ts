import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SUPPORTED_EXTENSIONS } from "c12";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_FILE, configCandidates, LEGACY_CONFIG_FILE, resolveConfigFile } from "../src/config/resolve";

/**
 * Does `chmod 0o000` on a directory actually revoke traversal here? Windows can't
 * revoke it that way and root ignores the bit outright — in both cases the stat
 * succeeds and the EACCES expectation would fail.
 */
function chmodCanRevokeTraversal(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "streamctl-chmodprobe-"));
  const blocked = join(dir, "blocked");
  try {
    mkdirSync(blocked);
    chmodSync(blocked, 0o000);
    statSync(join(blocked, "child"), { throwIfNoEntry: false });
    return false; // still traversable at 0o000, so: Windows ACLs, or running as root
  } catch {
    return true;
  } finally {
    chmodSync(blocked, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
}

const canRevokeTraversal = chmodCanRevokeTraversal();

let root: string;
let warnings: string[];
const logger = { warn: (message: string) => warnings.push(message) };

beforeEach(async () => {
  // realpath'd at creation: Windows runners hand back an 8.3 short-name temp path and
  // exsolve may realpath, so an unresolved `root` would make `abs` disagree with what
  // c12 later reports for the same file.
  root = realpathSync(await mkdtemp(join(tmpdir(), "streamctl-resolve-")));
  warnings = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeRootConfig(ext = ".ts", body = "export default {}\n"): Promise<void> {
  await writeFile(join(root, `streamctl.config${ext}`), body);
}

async function writeLegacyConfig(ext = ".ts", body = "export default {}\n"): Promise<void> {
  await mkdir(join(root, ".streamctl"), { recursive: true });
  await writeFile(join(root, ".streamctl", `config${ext}`), body);
}

/** A config whose module body touches the filesystem when evaluated. */
function sideEffectConfig(sentinel: string): string {
  return `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "");\nexport default {}\n`;
}

describe("resolveConfigFile", () => {
  it("resolves a root config", async () => {
    await writeRootConfig();

    const location = await resolveConfigFile(root, logger);

    expect(location).toEqual({
      abs: join(root, "streamctl.config.ts"),
      rel: "streamctl.config.ts",
      source: "root",
    });
    expect(warnings).toEqual([]);
  });

  it("resolves a legacy config with a POSIX-separated `rel`", async () => {
    await writeLegacyConfig();

    const location = await resolveConfigFile(root, logger);

    expect(location?.source).toBe("legacy");
    expect(location?.rel).toBe(".streamctl/config.ts");
    expect(location?.rel).not.toContain("\\");
    expect(location?.abs).toBe(join(root, ".streamctl", "config.ts"));
    expect(warnings).toEqual([]);
  });

  it("returns null when neither location holds a config", async () => {
    expect(await resolveConfigFile(root, logger)).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("`abs` is absolute and agrees with `rel`", async () => {
    await writeLegacyConfig();

    const location = await resolveConfigFile(root, logger);

    expect(isAbsolute(location?.abs ?? "")).toBe(true);
    expect(location?.abs).toBe(resolve(root, location?.rel ?? ""));
  });

  describe("both locations present", () => {
    beforeEach(async () => {
      await writeRootConfig();
      await writeLegacyConfig();
    });

    it("resolves the root config and warns exactly once", async () => {
      const location = await resolveConfigFile(root, logger);

      expect(location?.source).toBe("root");
      expect(location?.rel).toBe("streamctl.config.ts");
      expect(warnings).toHaveLength(1);
    });

    it("names both paths and which one is in use", async () => {
      await resolveConfigFile(root, logger);

      // Substrings, never the whole sentence: the exact wording is still open, and a
      // verbatim assertion would make changing it expensive.
      const [warning] = warnings;
      expect(warning).toContain("streamctl.config.ts");
      expect(warning).toContain(".streamctl/config.ts");
      expect(warning).toContain("using streamctl.config.ts");
      expect(warning).toContain("ignoring .streamctl/config.ts");
    });

    it("emits nothing when no logger is passed", async () => {
      const location = await resolveConfigFile(root);

      expect(location?.source).toBe("root");
      expect(warnings).toEqual([]);
    });

    it("evaluates neither config module", async () => {
      // Structural: the resolver only stats. Pinned anyway, because a return to a
      // speculative-`loadConfig` design would evaluate the ignored config silently,
      // and this is the assertion that would catch it.
      const rootSentinel = join(root, "root-evaluated");
      const legacySentinel = join(root, "legacy-evaluated");
      await writeRootConfig(".ts", sideEffectConfig(rootSentinel));
      await writeLegacyConfig(".ts", sideEffectConfig(legacySentinel));

      await resolveConfigFile(root, logger);

      expect(existsSync(rootSentinel)).toBe(false);
      expect(existsSync(legacySentinel)).toBe(false);

      // Proof the fixture is not inert: evaluated directly, the same body does write.
      // Without this the two assertions above would also pass on a broken fixture.
      // Native ESM import of an out-of-root file — the only one in the suite; if this
      // line ever fails on CI it is a harness issue, not a resolver bug.
      const proofSentinel = join(root, "proof-evaluated");
      const proofModule = join(root, "proof.config.mjs");
      await writeFile(proofModule, sideEffectConfig(proofSentinel));
      await import(pathToFileURL(proofModule).href);
      expect(existsSync(proofSentinel)).toBe(true);
    });
  });

  describe("extensions", () => {
    it.each([".ts", ".mjs", ".mts", ".js", ".json", ".yaml"])("resolves a root config with %s", async (ext) => {
      await writeRootConfig(ext);

      const location = await resolveConfigFile(root, logger);

      expect(location?.rel).toBe(`streamctl.config${ext}`);
      expect(location?.source).toBe("root");
    });

    it("prefers .js over .ts at the same location, per c12's order", async () => {
      await writeRootConfig(".ts");
      await writeRootConfig(".js");

      const location = await resolveConfigFile(root, logger);

      expect(location?.rel).toBe("streamctl.config.js");
      // Same-location shadowing is not the both-present case.
      expect(warnings).toEqual([]);
    });

    it("builds one candidate per c12 extension, in c12's order", async () => {
      expect(SUPPORTED_EXTENSIONS.length).toBeGreaterThan(0);
      // Length and order, not just non-empty: a builder that ignored the import would
      // pass a bare non-empty check while silently disabling the whole probe.
      expect(configCandidates(CONFIG_FILE)).toEqual(SUPPORTED_EXTENSIONS.map(ext => `streamctl.config${ext}`));
      expect(configCandidates(LEGACY_CONFIG_FILE)).toHaveLength(SUPPORTED_EXTENSIONS.length);
    });
  });

  describe("directory shaped like a config", () => {
    // Distinct from `streamctl.config/index.ts`, which c12 would accept via
    // `suffixes: ["", "/index"]` and the probe deliberately does not: here the
    // *candidate itself* is a directory, so an `existsSync` probe would call it a hit.
    it("is not a hit", async () => {
      await mkdir(join(root, "streamctl.config.ts"));

      expect(await resolveConfigFile(root, logger)).toBeNull();
      expect(warnings).toEqual([]);
    });

    it("does not shadow a legacy config or trigger the warning", async () => {
      await mkdir(join(root, "streamctl.config.ts"));
      await writeLegacyConfig();

      const location = await resolveConfigFile(root, logger);

      expect(location?.source).toBe("legacy");
      expect(warnings).toEqual([]);
    });
  });

  describe("never throws", () => {
    it("does not throw for an empty cwd", async () => {
      // `resolve("", …)` falls back to `process.cwd()`, so what this reads depends on
      // the suite's working directory. Assert the contract, not this repo's contents.
      const location = await resolveConfigFile("", logger);

      if (location !== null) {
        expect(isAbsolute(location.abs)).toBe(true);
        expect(location.rel).not.toContain("\\");
      }
    });

    it("returns null for a non-existent cwd", async () => {
      expect(await resolveConfigFile(join(root, "nope"), logger)).toBeNull();
    });

    it("returns null when cwd is a file", async () => {
      const file = join(root, "package.json");
      await writeFile(file, "{}\n");

      expect(await resolveConfigFile(file, logger)).toBeNull();
    });

    it.skipIf(!canRevokeTraversal)("returns null when cwd is unreadable", async () => {
      // `throwIfNoEntry: false` suppresses ENOENT only, so this path really does raise
      // EACCES inside the probe.
      const blocked = join(root, "blocked");
      await mkdir(blocked);
      await chmod(blocked, 0o000);

      expect(await resolveConfigFile(blocked, logger)).toBeNull();

      await chmod(blocked, 0o755); // restore so cleanup can recurse
    });
  });
});
