import type { CheckResult } from "../src/engine/check";
import type { InitResult } from "../src/engine/init";
import type { StatusResult } from "../src/engine/status";
import type { SyncResult } from "../src/engine/sync";
import type { UpgradeResult } from "../src/engine/upgrade";
import { describe, expect, it } from "vitest";
import { formatCheck, formatInit, formatStatus, formatSync, formatUpgrade, renderReport } from "../src/report";

const ESC = ""; // ANSI introducer; absence means plain output
const PLAIN = { color: false };
const COLOR = { color: true };

const syncResult: SyncResult = {
  written: ["a.ts", "b.ts"],
  skipped: ["c.ts"],
  conflicted: [{ path: "d.ts", reason: "owned edit", kind: "edit" }],
  warnings: [],
  versionChanges: [{ key: "eslint", from: "1.0.0", to: "2.0.0" }],
  versionsSkippedAhead: [],
  syncedVersion: "1.4.0",
};

const cleanSync: SyncResult = { written: [], skipped: [], conflicted: [], warnings: [], versionChanges: [], versionsSkippedAhead: [], syncedVersion: "1.4.0" };

describe("formatSync", () => {
  it("plain ASCII tokens, no ANSI, when color is off", () => {
    const out = formatSync(syncResult, PLAIN);
    expect(out).not.toContain(ESC);
    expect(out).toContain("streamctl sync · v1.4.0");
    expect(out).toContain("[+]  written");
    expect(out).toContain("[~]  reconciled");
    expect(out).toContain("[!]  edit (1)");
    expect(out).toContain("d.ts - owned edit");
    expect(out).toContain("`sync --interactive`");
    expect(out).toContain("[=]  skipped");
    expect(out).toContain("a.ts, b.ts");
    expect(out).toContain("eslint 1.0.0 → 2.0.0");
    expect(out).toContain("1 conflict(s) pending; see the per-kind guidance above.");
  });

  it("glyphs and color when color is on", () => {
    const out = formatSync(syncResult, COLOR);
    expect(out).toContain(ESC);
    expect(out).toContain("✓");
    expect(out).toContain("↻");
    expect(out).toContain("⚠");
    expect(out).toContain(`${ESC}[32m`); // green
  });

  it("collapses to a single in-sync row when nothing changed", () => {
    const out = formatSync(cleanSync, PLAIN);
    expect(out).toContain("[+]  in sync");
    expect(out).toContain("up to date, nothing to write.");
    expect(out).not.toContain("[!]");
  });

  it("truncates long file lists after the first six", () => {
    const many = Array.from({ length: 8 }, (_, i) => `f${i}.ts`);
    const out = formatSync({ ...cleanSync, written: many }, PLAIN);
    expect(out).toContain("f0.ts");
    expect(out).toContain("f5.ts");
    expect(out).toContain("… (+2 more)");
    expect(out).not.toContain("f7.ts");
  });

  it("keys already at or above the baseline floor get a floor-met row", () => {
    const ahead: SyncResult = { ...cleanSync, versionsSkippedAhead: [{ key: "devDependencies.eslint", actual: "^10.0.0", baseline: "^9.39.2" }] };
    const out = formatSync(ahead, PLAIN);
    expect(out).toContain("[=]  ≥ floor");
    expect(out).toContain("devDependencies.eslint ^10.0.0 ≥ ^9.39.2");
  });

  it("the stale-lockfile hint names whichever install command it was given", () => {
    const stale: SyncResult = { ...cleanSync, versionChanges: [{ key: "engines.node", from: "20", to: "24" }], lockfileStale: true };
    expect(formatSync(stale, PLAIN, "pnpm install")).toContain("package.json changed, so the lockfile is stale. Run `pnpm install` to update it.");
    expect(formatSync(stale, PLAIN, "npm install")).toContain("Run `npm install` to update it.");
  });

  it("no hint unless the lockfile is stale AND an install command was passed", () => {
    const stale: SyncResult = { ...cleanSync, lockfileStale: true };
    expect(formatSync(cleanSync, PLAIN, "pnpm install")).not.toContain("lockfile is stale");
    expect(formatSync(stale, PLAIN)).not.toContain("lockfile is stale");
  });

  it("every advisory in warnings[] gets its own line", () => {
    const warned: SyncResult = { ...cleanSync, warnings: ["eslint.config.ts is shadowed by eslint.config.mjs; the scaffolded config is inert until you port and delete eslint.config.mjs."] };
    const out = formatSync(warned, PLAIN);
    // Warnings get their own mark; they must not borrow the skew/conflict [!].
    expect(out).toContain("[w]");
    expect(out).not.toContain("[!]");
    expect(out).toContain("eslint.config.ts is shadowed by eslint.config.mjs");
  });
});

describe("formatSync conflict grouping", () => {
  const withConflicts = (conflicted: SyncResult["conflicted"]): SyncResult => ({ ...cleanSync, conflicted });

  it("groups by kind and only ever names flags that exist", () => {
    const out = formatSync(withConflicts([
      { path: "a.ts", reason: "local edits to streamctl-owned content", kind: "edit" },
      { path: "b.ts", reason: "pre-existing file streamctl now manages; adopting is expected", kind: "adoption" },
      { path: "c.json", reason: "composed output is not valid: bad JSON", kind: "fault" },
      { path: "d.ts", reason: "uncommitted changes (dirty working tree)", kind: "dirty" },
    ]), PLAIN);

    expect(out).toContain("[!]  edit (1)");
    expect(out).toContain("[!]  adoption (1)");
    expect(out).toContain("[x]  fault (1)");
    expect(out).toContain("[!]  dirty (1)");
    expect(out).toContain("b.ts - pre-existing file streamctl now manages; adopting is expected");
    expect(out).toContain("`sync --interactive`");
    expect(out).toContain("`sync --force`");
    expect(out).toContain("`--only <glob>`");
    expect(out).not.toContain("--accept");
    expect(out).not.toContain("--theirs");
    // A fault is a broken composition, so --force cannot rescue it.
    expect(out).toContain("not fixable with --force");
    expect(out).toContain("4 conflict(s) pending; see the per-kind guidance above.");
  });

  it("expected vs unexpected adoption differs only in the reason text", () => {
    const expected = formatSync(withConflicts([{ path: "a", reason: "pre-existing file streamctl now manages; adopting is expected", kind: "adoption" }]), PLAIN);
    const unexpected = formatSync(withConflicts([{ path: "a", reason: "pre-existing file differs unexpectedly; review before adopting", kind: "adoption" }]), PLAIN);
    expect(expected).toContain("adopting is expected");
    expect(unexpected).toContain("differs unexpectedly");
    expect(expected).toContain("[!]  adoption (1)");
    expect(unexpected).toContain("[!]  adoption (1)");
  });
});

describe("formatCheck", () => {
  const failing: CheckResult = {
    inSync: false,
    drift: [{ path: ".editorconfig", kind: "content" }],
    structuralFaults: [{ path: "tsconfig.json", reason: "invalid JSON" }],
    versionSkew: [{ key: "node", actual: "1.0.0", expected: "2.0.0" }],
    updateAvailable: { current: "1.4.0", latest: "1.5.0" },
  };

  it("every failing dimension shows up, plus the DRIFT verdict", () => {
    const out = formatCheck(failing, PLAIN);
    expect(out).not.toContain(ESC);
    expect(out).toContain("[x]  drift");
    expect(out).toContain("[x]  fault");
    expect(out).toContain("[!]  skew");
    expect(out).toContain("[^]  outdated");
    expect(out).toContain(".editorconfig (content)");
    expect(out).toContain("node 1.0.0 → 2.0.0");
    expect(out).toContain("1.4.0 → 1.5.0 available");
    expect(out).toContain("DRIFT_DETECTED. Run `streamctl sync` to reconcile.");
  });

  it("colors drift red when color is on", () => {
    expect(formatCheck(failing, COLOR)).toContain(`${ESC}[31m`);
  });

  it("says all clean when there is nothing to report", () => {
    const out = formatCheck({ inSync: true, drift: [], structuralFaults: [], versionSkew: [] }, PLAIN);
    expect(out).toContain("[+]  in sync");
    expect(out).toContain("all clean.");
  });

  it("in sync but outdated yields an update-available verdict", () => {
    const out = formatCheck(
      { inSync: true, drift: [], structuralFaults: [], versionSkew: [], updateAvailable: { current: "1.4.0", latest: "1.5.0" } },
      PLAIN,
    );
    expect(out).toContain("[^]  outdated");
    expect(out).toContain("update available; run `streamctl upgrade` to move to 1.5.0.");
  });
});

describe("formatInit", () => {
  it("renders the header block and the embedded sync rows", () => {
    const data: InitResult = { base: "nuxt-app", profile: "nuxt-4", version: "1.4.0", cliVersion: "0.1.0", sync: syncResult };
    const out = formatInit(data, PLAIN);
    // The header carries the CLI's version, the payload pin is its own row. Two
    // different numbers; never render them as one.
    expect(out).toContain("streamctl init · v0.1.0");
    expect(out).toContain("payload");
    expect(out).toContain("1.4.0");
    expect(out).toContain("base");
    expect(out).toContain("nuxt-app");
    expect(out).toContain("profile");
    expect(out).toContain("nuxt-4");
    expect(out).toContain("[+]  written");
    expect(out).toContain("initialized. Review changes and commit.");
  });
});

describe("formatUpgrade", () => {
  const bumps = [{ name: "@acme/payload", from: "1.0.0", to: "2.0.0" }];

  it("deps, sync rows, applied footer", () => {
    const data: UpgradeResult = { fromVersion: "1.0.0", toVersion: "2.0.0", dependencyBumps: bumps, sync: syncResult, dryRun: false };
    const out = formatUpgrade(data, PLAIN);
    expect(out).toContain("streamctl upgrade · 1.0.0 → 2.0.0");
    expect(out).toContain("[^]  deps");
    expect(out).toContain("@acme/payload");
    expect(out).toContain("upgraded to v2.0.0.");
  });

  // `sync: null` means BOTH "--dry-run (nothing written)" and "--no-install (pin +
  // devDep ARE written)". Keying the footer off it told a user who had just mutated
  // their repo that it was a dry run. `dryRun` is the real discriminator.
  it("flags a dry run only when the run really was one", () => {
    const data: UpgradeResult = { fromVersion: "1.0.0", toVersion: "2.0.0", dependencyBumps: bumps, sync: null, dryRun: true };
    const out = formatUpgrade(data, PLAIN);
    expect(out).toContain("dry run: would upgrade to v2.0.0.");
  });

  it("a dry run that produced a preview is still a dry run", () => {
    // The inverse of the same conflation: keying off `sync` made a --dry-run whose
    // target happened to be installed report "upgraded to v2.0.0".
    const data: UpgradeResult = { fromVersion: "1.0.0", toVersion: "2.0.0", dependencyBumps: bumps, sync: syncResult, dryRun: true };
    const out = formatUpgrade(data, PLAIN);
    expect(out).toContain("dry run: would upgrade to v2.0.0.");
    expect(out).not.toContain("upgraded to v2.0.0.");
  });

  it("--no-install is an applied upgrade, and says what to run next", () => {
    // The pin and devDep are on disk here, so calling it a dry run would be a lie.
    const data: UpgradeResult = { fromVersion: "1.0.0", toVersion: "2.0.0", dependencyBumps: bumps, sync: null, dryRun: false };
    const out = formatUpgrade(data, PLAIN, "pnpm install");
    expect(out).toContain("upgraded to v2.0.0");
    expect(out).not.toContain("dry run");
    expect(out).toContain("pnpm install");
    expect(out).toContain("streamctl sync");
  });

  it("falls back to a generic install hint when the PM is unknown", () => {
    const data: UpgradeResult = { fromVersion: "1.0.0", toVersion: "2.0.0", dependencyBumps: bumps, sync: null, dryRun: false };
    const out = formatUpgrade(data, PLAIN);
    expect(out).toContain("upgraded to v2.0.0");
    expect(out).not.toContain("dry run");
    expect(out).toContain("streamctl sync");
  });

  it("surfaces the stale-lockfile hint from the chained sync", () => {
    const staleSync: SyncResult = { ...cleanSync, versionChanges: [{ key: "engines.node", from: "20", to: "24" }], lockfileStale: true };
    const data: UpgradeResult = { fromVersion: "1.0.0", toVersion: "2.0.0", dependencyBumps: bumps, sync: staleSync, dryRun: false };
    expect(formatUpgrade(data, PLAIN, "pnpm install")).toContain("Run `pnpm install` to update it.");
    // no hint without the install command
    expect(formatUpgrade(data, PLAIN)).not.toContain("lockfile is stale");
  });
});

describe("formatStatus", () => {
  const base: StatusResult = {
    files: [
      { path: ".editorconfig", strategy: "full", state: "in-sync" },
      { path: ".npmrc", strategy: "block", state: "drift" },
      { path: "Makefile", strategy: "full", state: "conflict" },
      { path: "eslint.config.ts", strategy: "scaffold", state: "scaffolded" },
    ],
    payload: { package: "@acme/cfg", pinned: "1.0.0", installed: "1.0.0" },
    profile: "nuxt-4",
    cliVersion: "0.1.0",
    lockfileStale: false,
  };

  it("summary block, per-file state table, and pointers to sync/check", () => {
    const out = formatStatus(base, PLAIN);
    expect(out).toContain("streamctl status");
    expect(out).toContain("package  @acme/cfg");
    expect(out).toContain("pinned");
    expect(out).toContain("installed");
    expect(out).toContain("profile  nuxt-4");
    expect(out).toContain("in-sync");
    expect(out).toContain("drift");
    expect(out).toContain("conflict");
    expect(out).toContain("scaffolded");
    expect(out).toContain(".editorconfig");
    // Actionable states point at the tools. status never renders a verdict.
    expect(out).toContain("run `streamctl sync` to reconcile");
    expect(out).toContain("`streamctl check` is the CI gate");
  });

  it("update-available line only appears when `latest` is set", () => {
    const out = formatStatus({ ...base, payload: { ...base.payload, latest: "2.0.0" }, lockfileStale: true }, PLAIN);
    expect(out).toContain("2.0.0 available");
    expect(out).toContain("lockfile");
    expect(out).toContain("stale");
    expect(formatStatus(base, PLAIN)).not.toContain("available");
  });

  it("reports all-in-sync when nothing is actionable", () => {
    const out = formatStatus({ ...base, files: [{ path: ".editorconfig", strategy: "full", state: "in-sync" }] }, PLAIN);
    expect(out).toContain("all managed files in sync.");
  });
});

describe("renderReport", () => {
  it("dispatches by command to the matching formatter", () => {
    expect(renderReport("sync", syncResult, PLAIN)).toContain("streamctl sync");
    expect(renderReport("check", { inSync: true, drift: [], structuralFaults: [], versionSkew: [] }, PLAIN)).toContain("streamctl check");
  });

  it("returns null for data that does not match the command's result shape", () => {
    expect(renderReport("sync", { nope: true }, PLAIN)).toBeNull();
    expect(renderReport("check", undefined, PLAIN)).toBeNull();
  });

  // A malformed `details` payload (a StreamctlError thrown with an out-of-shape
  // result) must fall back to the marker line rather than throw INSIDE the formatter:
  // a throw there escapes executeCommand's never-throw boundary in non-JSON mode.
  // Each case below omits exactly one field the formatter reads unguarded; before the
  // fix these threw "Cannot read properties of undefined".
  //
  // The fixtures are deliberately NOT typed as their result interfaces. They model the
  // out-of-shape payloads the guards must reject, so a compiler-satisfying "fix" of
  // their shape would defeat the regression they pin. Leave them raw.
  describe("guards on every field the formatter reads", () => {
    it("sync: missing versionChanges falls back", () => {
      const malformed = { written: [], conflicted: [], skipped: [], versionsSkippedAhead: [], warnings: [], syncedVersion: "1.0.0" };
      expect(() => renderReport("sync", malformed, PLAIN)).not.toThrow();
      expect(renderReport("sync", malformed, PLAIN)).toBeNull();
    });

    it("check: missing structuralFaults falls back", () => {
      const malformed = { inSync: false, drift: [], versionSkew: [] };
      expect(() => renderReport("check", malformed, PLAIN)).not.toThrow();
      expect(renderReport("check", malformed, PLAIN)).toBeNull();
    });

    it("upgrade: a non-null but malformed sync never reaches syncRows", () => {
      // The guard checked fromVersion/toVersion/dryRun/dependencyBumps but not sync,
      // while formatUpgrade feeds a truthy sync straight into syncRows.
      const malformed = { fromVersion: "1.0.0", toVersion: "2.0.0", dryRun: false, dependencyBumps: [], sync: { garbage: true } };
      expect(() => renderReport("upgrade", malformed, PLAIN)).not.toThrow();
      expect(renderReport("upgrade", malformed, PLAIN)).toBeNull();
    });

    it("status: a files entry with no state", () => {
      // formatStatus maps every entry to a label of `file.state`, and renderRows then
      // reads `label.length`. A state-less entry throws there (empty payload strings are
      // fine, those only interpolate), so guard the entry shape, not just the array.
      const malformed = { files: [{}], payload: { package: "p", pinned: "1", installed: "1" }, cliVersion: "1", profile: "p", lockfileStale: false };
      expect(() => renderReport("status", malformed, PLAIN)).not.toThrow();
      expect(renderReport("status", malformed, PLAIN)).toBeNull();
    });

    it("upgrade: missing dryRun falls back", () => {
      // dryRun is the real dry-run vs --no-install discriminator. Without it the footer
      // misleads, so the guard has to reject details that lack it.
      const malformed = { fromVersion: "1.0.0", toVersion: "2.0.0", dependencyBumps: [] };
      expect(renderReport("upgrade", malformed, PLAIN)).toBeNull();
    });

    it("valid details of every kind still render", () => {
      const upgrade: UpgradeResult = { fromVersion: "1.0.0", toVersion: "2.0.0", dependencyBumps: [], sync: null, dryRun: false };
      const status: StatusResult = { files: [{ path: ".npmrc", strategy: "block", state: "drift" }], payload: { package: "p", pinned: "1", installed: "1" }, profile: "nuxt-4", cliVersion: "0.1.0", lockfileStale: false };
      expect(renderReport("sync", syncResult, PLAIN)).toContain("streamctl sync");
      expect(renderReport("check", { inSync: true, drift: [], structuralFaults: [], versionSkew: [] }, PLAIN)).toContain("streamctl check");
      expect(renderReport("upgrade", upgrade, PLAIN)).toContain("streamctl upgrade");
      // The last two are the ones the per-entry status guard and the nested-sync
      // guard could plausibly have over-tightened.
      expect(renderReport("status", status, PLAIN)).toContain("streamctl status");
      expect(renderReport("upgrade", { ...upgrade, sync: cleanSync }, PLAIN)).toContain("streamctl upgrade");
    });
  });
});
