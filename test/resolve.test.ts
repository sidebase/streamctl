import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SUPPORTED_EXTENSIONS } from "c12";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_FILE, configCandidates, LEGACY_CONFIG_FILE, resolveConfigFile } from "../src/config/resolve";
import { sideEffectConfig } from "./helpers/configs";
import { captureStderr } from "./helpers/streams";

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
  // This file has no other spies, but `captureStderr` installs one and vitest is not
  // configured with `restoreMocks`, so without this the stub leaks into every later
  // test in the file and swallows output silently.
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function writeRootConfig(ext = ".ts", body = "export default {}\n"): Promise<void> {
  await writeFile(join(root, `streamctl.config${ext}`), body);
}

async function writeLegacyConfig(ext = ".ts", body = "export default {}\n"): Promise<void> {
  await mkdir(join(root, ".streamctl"), { recursive: true });
  await writeFile(join(root, ".streamctl", `config${ext}`), body);
}

/** Write a file under `.config/`, creating its parents. */
async function writeConfigDirFile(rel: string, body = "export default {}\n"): Promise<void> {
  const abs = join(root, ".config", rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, body);
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
      // Both channels, because each is blind to the other's failure. `warnings` is the
      // injected array, which stays empty under `(logger ?? stderrLogger).warn(...)` —
      // that writes past it to the real stream. The capture is what sees the house
      // default, and the house default is the deviation this test exists to guard.
      const stderr = captureStderr();

      const location = await resolveConfigFile(root);

      expect(location?.source).toBe("root");
      expect(warnings).toEqual([]);
      expect(stderr.join("")).toBe("");
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

  /**
   * Characterization tests for a deliberate decision: `90_questions.md`, "What should
   * happen to c12's `.config/` directory probing? — **Suppress it**" (2026-07-30).
   *
   * The exclusion is structural, not checked — confirming an intended candidate exists
   * before anything loads makes c12's `.config/` branches (`dist/index.mjs:313`)
   * unreachable. So there is no rejection code to review, and nothing visibly breaks if
   * a refactor undoes it. These tests are the only guard. A failure here means the
   * probe-before-load ordering was lost; do not "fix" it by re-admitting `.config/`.
   *
   * Measured against c12 3.3.4 — `loadConfig` alone, no probe, `_configFile`:
   *
   * ```
   * fixture                        configFile: ".streamctl/config"   configFile: "streamctl.config"
   * .config/.streamctl/config.ts   .config/.streamctl/config.ts      (none)
   * .config/streamctl.ts           (none)                            .config/streamctl.ts
   * .config/streamctl.config.ts    (none)                            .config/streamctl.config.ts
   * ```
   *
   * The right-hand column is the point: under the spelling this feature adopted, c12
   * would in fact reach into `.config/` for two of the three, and the existence probe is the
   * only reason it never gets the chance. Left column, top row, is the one real
   * behavior change in the feature — see that test below. Both were reasoned about for
   * two gates before being measured; the numbers are here so the next reader inherits
   * a measurement rather than the argument.
   */
  describe(".config/ is deliberately not supported", () => {
    it("does not resolve .config/streamctl.ts", async () => {
      // Not a regression: under the pre-change `configFile: ".streamctl/config"` this
      // never resolved either, because c12 probes `.config/.streamctl/config` and never
      // `.config/streamctl`. Switching to the root spelling is what *would* have
      // started resolving it — verified against c12 3.3.4. This prevents that.
      //
      // The side-effect body closes a blind spot the `null` assertion alone leaves: a
      // regression that loads speculatively and *then* rejects `.config/` hits would
      // still return `null` here, having already executed this file. That is the
      // strictly-worse design `20_architecture.md` rejects — post-hoc rejection cannot
      // undo an evaluation, because c12 loads as part of resolving.
      const sentinel = join(root, "config-dir-evaluated");
      await writeConfigDirFile("streamctl.ts", sideEffectConfig(sentinel));

      expect(await resolveConfigFile(root, logger)).toBeNull();
      expect(existsSync(sentinel)).toBe(false);
      expect(warnings).toEqual([]);
    });

    it("does not resolve .config/streamctl.config.ts", async () => {
      // Same as above: never resolved before, and would have started under the root
      // spelling (`.replace(/\.config$/, "")` strips the suffix, so c12 probes
      // `.config/streamctl`, and its third branch probes `.config/streamctl.config`).
      await writeConfigDirFile("streamctl.config.ts");

      expect(await resolveConfigFile(root, logger)).toBeNull();
      expect(warnings).toEqual([]);
    });

    it("does not resolve .config/.streamctl/config.ts", async () => {
      // The one real break in this block: this path DOES resolve today, because
      // `.streamctl/config` ends in `/config` (no dot), survives the `.replace`, and
      // c12 probes `.config/.streamctl/config`. Removing it is intentional and is
      // called out in the release notes (P03-T03).
      //
      // This case guards a *different* regression than the other four: measured, it
      // still passes if the root spelling is delegated to `loadConfig`, because the
      // root spelling never probes this path. Only delegating the legacy spelling
      // re-admits it. A refactor touching just the legacy path would leave the other
      // four green and fail only here — do not dismiss that as a flake.
      await writeConfigDirFile(join(".streamctl", "config.ts"));

      expect(await resolveConfigFile(root, logger)).toBeNull();
      expect(warnings).toEqual([]);
    });

    it("resolves the legacy config when .config/streamctl.ts also exists", async () => {
      // Compatibility, not exclusion, and the most important case here: this repo shape
      // reads the legacy file today. A design delegating resolution to c12 would have
      // flipped it to the `.config/` file — a silent behavior change in exactly the
      // population promised byte-identical behavior.
      await writeConfigDirFile("streamctl.ts", "export default { base: \"from-config-dir\" }\n");
      await writeLegacyConfig(".ts", "export default { base: \"from-legacy\" }\n");

      const location = await resolveConfigFile(root, logger);

      expect(location?.source).toBe("legacy");
      expect(location?.rel).toBe(".streamctl/config.ts");
      // Read back through the resolved path, so this proves *which* file was selected
      // rather than merely that something was.
      expect(await readFile(location?.abs ?? "", "utf8")).toContain("from-legacy");
      expect(warnings).toEqual([]);
    });
  });

  describe("directory-shaped config via c12's /index suffix", () => {
    it("does not resolve streamctl.config/index.ts", async () => {
      // A real, intentional divergence, recorded as deliberate in `20_architecture.md`
      // ("Resolution strategy" — the one property given up by probe-then-load): c12
      // accepts this form via `suffixes: ["", "/index"]` (`dist/index.mjs:338`) —
      // verified, it loads — and the probe does not mirror it, because a directory-shaped
      // config is outside the two-locations promise. Deleting this test is a spec change,
      // not a cleanup. Distinct from the `streamctl.config.ts`-as-a-directory case above,
      // where the candidate itself is the directory.
      await mkdir(join(root, "streamctl.config"));
      await writeFile(join(root, "streamctl.config", "index.ts"), "export default {}\n");

      expect(await resolveConfigFile(root, logger)).toBeNull();
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
