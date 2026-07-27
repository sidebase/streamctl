#!/usr/bin/env node
// Distribution-path E2E gate for the @sidebase/streamctl CLI. The CLI is
// payload-agnostic, so the engine is exercised against the synthetic
// `@acme/payload` in test/fixtures/synthetic-payload.
//
// For the package manager named by E2E_PM (npm, pnpm, yarn or bun) it runs
// three legs on a throwaway repo pinned to that PM via `packageManager`:
//
//   1. init --no-install --skip-registry-check. Scaffolds .streamctl/config.ts
//      and reports `<pm> install`. No registry traffic.
//   2. Read-only adoption. "Install" the payload by copying the fixture into
//      node_modules/@acme/payload, seed-sync, then `check` and `sync --dry-run`
//      must both exit 0 with a byte-identical tree.
//   3. Payload-only extension. Append a new managed file to the installed
//      payload's preset.json and its source, then re-sync with the same binary.
//      It has to land, which is what proves the CLI is payload-driven rather
//      than org-coded.
//
// Every PM runs all three. Beyond detection and the install-command name (both
// from engine/pm.ts) the behavior is PM-agnostic.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.mjs");
const payloadFixture = join(root, "test", "fixtures", "synthetic-payload");

const PKG = "@acme/payload";
// The payload's own version, deliberately not the CLI's. A leg that silently
// pinned the payload to the CLI's release would fail here.
const PAYLOAD_VERSION = "1.4.0";
const PMS = new Set(["npm", "pnpm", "yarn", "bun"]);
const E2E_PM = process.env.E2E_PM ?? "pnpm";

/** Abort the whole gate with a loud, unambiguous message. */
function die(message, detail) {
  console.error(`✗ ${message}`);
  if (detail) {
    console.error(detail.trim());
  }
  process.exit(1);
}

/** Run the built CLI in `cwd` (non-TTY: interactive degrades to the headless plan path). */
function streamctl(cwd, args, extraEnv) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
}

/** A content fingerprint of the working tree (excluding node_modules + .git). */
function treeHash(dir) {
  const entries = [];
  const walk = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      const child = join(abs, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else {
        entries.push(`${relative(dir, child)}\0${readFileSync(child, "utf8")}`);
      }
    }
  };
  walk(dir);
  return createHash("sha256").update(entries.join("\0\0")).digest("hex");
}

function fail(step, result) {
  console.error(`✗ ${step} (exit ${result.status})`);
  if (result.stdout)
    console.error(result.stdout.trim());
  if (result.stderr)
    console.error(result.stderr.trim());
  process.exitCode = 1;
}

/** Copy the synthetic payload fixture into `<work>/node_modules/@acme/payload` (the bytes an install delivers). */
function installPayload(work) {
  const dest = join(work, "node_modules", "@acme", "payload");
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(payloadFixture, dest, { recursive: true });
  return dest;
}

/** A throwaway repo pinned to `pm` with a scaffolded `.streamctl/config.ts`. */
function makeRepo(pm) {
  const work = mkdtempSync(join(tmpdir(), `streamctl-e2e-${pm}-`));
  writeFileSync(join(work, "package.json"), `${JSON.stringify({ name: "app", private: true, packageManager: `${pm}@1.0.0` }, null, 2)}\n`);
  mkdirSync(join(work, ".streamctl"), { recursive: true });
  writeFileSync(
    join(work, ".streamctl", "config.ts"),
    `export default { package: "${PKG}", base: "app", version: "${PAYLOAD_VERSION}", profile: "std" };\n`,
  );
  return work;
}

let passed = 0;

/** Leg 1: init --no-install detection + skip-install guidance (no payload, no registry). */
function runInitSmoke(pm) {
  const work = mkdtempSync(join(tmpdir(), `streamctl-e2e-init-${pm}-`));
  try {
    writeFileSync(join(work, "package.json"), `${JSON.stringify({ name: "smoke", private: true, packageManager: `${pm}@1.0.0` }, null, 2)}\n`);
    // `--payload-version` is REQUIRED alongside `--skip-registry-check`: with the
    // registry off-limits the payload's own release line can't be probed, and it is
    // never inherited from the CLI's version (they ship independently).
    const res = streamctl(work, ["init", "--package", PKG, "--payload-version", PAYLOAD_VERSION, "--base", "app", "--profile", "std", "--no-install", "--skip-registry-check", "--yes"]);
    if (res.status !== 0) {
      fail(`init:${pm}`, res);
      return;
    }
    if (!existsSync(join(work, ".streamctl", "config.ts"))) {
      console.error(`✗ init:${pm}: did not scaffold .streamctl/config.ts`);
      process.exitCode = 1;
      return;
    }
    // The scaffolded pin is the PAYLOAD's version, never the CLI's own.
    const scaffolded = readFileSync(join(work, ".streamctl", "config.ts"), "utf8");
    if (!scaffolded.includes(`version: "${PAYLOAD_VERSION}"`)) {
      console.error(`✗ init:${pm}: scaffolded pin is not the payload version ${PAYLOAD_VERSION}`);
      process.exitCode = 1;
      return;
    }
    if (!`${res.stdout}${res.stderr}`.includes(`${pm} install`)) {
      console.error(`✗ init:${pm}: skip-install guidance did not name \`${pm} install\``);
      process.exitCode = 1;
      return;
    }
    console.log(`✓ init:${pm}: detected ${pm}; --no-install scaffolded config + reported \`${pm} install\``);
    passed += 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Leg 2: read-only adoption gate against the installed synthetic payload. */
function runReadonlyGate(pm) {
  const work = makeRepo(pm);
  try {
    const configDir = installPayload(work);
    if (!existsSync(join(configDir, "presets", "app", "preset.json"))) {
      console.error(`✗ readonly:${pm}: installed payload is missing presets/app/preset.json`);
      process.exitCode = 1;
      return;
    }

    const seed = streamctl(work, ["sync"]);
    if (seed.status !== 0) {
      fail(`readonly:${pm} seed sync`, seed);
      return;
    }
    // Assert a versionProfile dep landed via the seed sync's reconcile (payload-driven).
    const seededPkg = JSON.parse(readFileSync(join(work, "package.json"), "utf8"));
    if (!seededPkg.devDependencies?.["acme-runtime"]) {
      fail(`readonly:${pm} acme-runtime not reconciled into devDependencies`, seed);
      return;
    }

    const check = streamctl(work, ["check"]);
    if (check.status !== 0) {
      fail(`readonly:${pm} check`, check);
      return;
    }

    const before = treeHash(work);
    const dry = streamctl(work, ["sync", "--dry-run"]);
    if (dry.status !== 0) {
      fail(`readonly:${pm} sync --dry-run`, dry);
      return;
    }
    if (treeHash(work) !== before) {
      fail(`readonly:${pm} sync --dry-run mutated the working tree`, dry);
      return;
    }
    console.log(`✓ readonly:${pm}: payload resolved from node_modules; check + sync --dry-run clean, read-only`);
    passed += 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Leg 3: a payload can add a managed file with ZERO CLI change. */
function runPayloadExtension(pm) {
  const work = makeRepo(pm);
  try {
    const configDir = installPayload(work);
    const seed = streamctl(work, ["sync"]);
    if (seed.status !== 0) {
      fail(`ext:${pm} seed sync`, seed);
      return;
    }

    const extPath = ".acme-payload-ext";
    const marker = "generated by the payload, not the CLI\n";
    const presetJson = join(configDir, "presets", "base", "preset.json");
    const preset = JSON.parse(readFileSync(presetJson, "utf8"));
    preset.files.push({ path: extPath, strategy: "full", source: "base/payload-ext" });
    writeFileSync(presetJson, `${JSON.stringify(preset, null, 2)}\n`);
    writeFileSync(join(configDir, "presets", "base", "payload-ext"), marker);

    const resync = streamctl(work, ["sync"]);
    if (resync.status !== 0) {
      fail(`ext:${pm} payload-extension sync`, resync);
      return;
    }
    const landed = join(work, extPath);
    if (!existsSync(landed) || readFileSync(landed, "utf8") !== marker) {
      console.error(`✗ ext:${pm}: payload-declared ${extPath} was not synced (payload-driven contract broken)`);
      process.exitCode = 1;
      return;
    }
    console.log(`✓ ext:${pm}: payload added a managed file with zero CLI change, and it synced`);
    passed += 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Leg 4: `upgrade` bumps the pin against a newer vendored payload and chains a
 * sync. Uses npm regardless of E2E_PM (a real install must land the payload; npm
 * always ships with Node). The `file:` override skips the registry probes; npm
 * rejects an override whose direct devDep spec differs (EOVERRIDE), so they match.
 */
function runUpgradeLeg() {
  const work = mkdtempSync(join(tmpdir(), "streamctl-e2e-upgrade-"));
  try {
    // Vendor a copy of the payload bumped to a newer version. The install
    // delivers this one through the file: override, standing in for a published
    // newer release.
    const vendor = join(work, "vendor", "acme-payload");
    mkdirSync(vendor, { recursive: true });
    cpSync(payloadFixture, vendor, { recursive: true });
    const vendorPkgPath = join(vendor, "package.json");
    const vendorPkg = JSON.parse(readFileSync(vendorPkgPath, "utf8"));
    const fromVersion = vendorPkg.version;
    const toVersion = "1.5.0";
    if (fromVersion === toVersion) {
      die(`upgrade leg: fixture already at ${toVersion}, pick a distinct newer version`);
    }
    vendorPkg.version = toVersion;
    writeFileSync(vendorPkgPath, `${JSON.stringify(vendorPkg, null, 2)}\n`);

    writeFileSync(join(work, "package.json"), `${JSON.stringify({
      name: "app",
      private: true,
      devDependencies: { [PKG]: "file:./vendor/acme-payload" },
      overrides: { [PKG]: "file:./vendor/acme-payload" },
    }, null, 2)}\n`);
    // Multi-line config: `upgrade`'s version-pin bump is line-anchored (`version:` on
    // its own line), unlike the single-line config the other legs scaffold.
    mkdirSync(join(work, ".streamctl"), { recursive: true });
    writeFileSync(
      join(work, ".streamctl", "config.ts"),
      `export default {\n  package: "${PKG}",\n  base: "app",\n  version: "${fromVersion}",\n  profile: "std",\n};\n`,
    );

    // Non-TTY `upgrade` degrades to headless: `--yes` accepts the chained sync's
    // creates + safe reconciles. Silence npm audit/fund (no network, cleaner output).
    const res = streamctl(work, ["upgrade", "--to", toVersion, "--yes"], { npm_config_audit: "false", npm_config_fund: "false" });
    if (res.status !== 0) {
      fail("upgrade", res);
      return;
    }

    // (a) the pin moved in the consumer config.
    const config = readFileSync(join(work, ".streamctl", "config.ts"), "utf8");
    if (!new RegExp(`version:\\s*"${toVersion}"`).test(config)) {
      console.error(`✗ upgrade: config pin did not bump to ${toVersion}`);
      process.exitCode = 1;
      return;
    }
    // The install genuinely delivered the NEWER payload (not a no-op).
    const installedPkg = JSON.parse(readFileSync(join(work, "node_modules", PKG, "package.json"), "utf8"));
    if (installedPkg.version !== toVersion) {
      console.error(`✗ upgrade: installed payload is ${installedPkg.version}, expected ${toVersion}`);
      process.exitCode = 1;
      return;
    }
    // (b) the chained sync applied: a base-preset managed file landed AND a
    // versionProfile dep reconciled into package.json.
    if (!existsSync(join(work, "AGENTS.md"))) {
      console.error("✗ upgrade: chained sync did not write the payload's managed AGENTS.md");
      process.exitCode = 1;
      return;
    }
    const consumerPkg = JSON.parse(readFileSync(join(work, "package.json"), "utf8"));
    if (!consumerPkg.devDependencies?.["acme-runtime"]) {
      console.error("✗ upgrade: chained sync did not reconcile acme-runtime into devDependencies");
      process.exitCode = 1;
      return;
    }
    console.log(`✓ upgrade: pin ${fromVersion} to ${toVersion}, newer payload installed and the chained sync applied`);
    passed += 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Leg 5: the built `dist/cli.mjs --version` must report a real semver, proving
 * `build.config.ts` injected `__STREAMCTL_VERSION__` from package.json. Dev and
 * test leave the token uninjected, so this only works on the built artifact.
 */
function runVersionCheck() {
  const res = streamctl(root, ["--version"]);
  const out = `${res.stdout}${res.stderr}`.trim();
  // citty may tag or decorate the `--version` line depending on its reporter,
  // so extract the semver token rather than anchor-matching the whole line.
  const token = out.match(/\b\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?\b/i);
  if (res.status !== 0 || out.includes("__STREAMCTL_VERSION__") || !token) {
    console.error(`✗ --version: expected an injected semver, got ${JSON.stringify(out)} (exit ${res.status})`);
    if (out.includes("__STREAMCTL_VERSION__")) {
      console.error("  build-time version injection did not run (raw __STREAMCTL_VERSION__ token present).");
    }
    process.exitCode = 1;
    return;
  }
  console.log(`✓ --version: built CLI reports injected semver ${token[0]}`);
  passed += 1;
}

/**
 * Leg 6: a usage error under `--json` must stay machine-readable. citty colors
 * the offending name inside its `CLIError` message and resolves color support
 * once at import time, ignoring whether stdout is a TTY, so a consumer piping
 * `--json` to a file still gets ANSI unless `run-cli.ts` strips it.
 *
 * Only a subprocess can prove this, since `FORCE_COLOR` has to be set before
 * citty is imported. In a unit test vitest's own env disables citty's color at
 * import and the assertion passes whether or not the strip is there.
 */
function runJsonUsageCheck() {
  const esc = String.fromCharCode(27);
  const res = streamctl(root, ["bogus-command", "--json"], { FORCE_COLOR: "1" });
  const out = res.stdout.trim();

  if (res.status !== 1 || !out) {
    console.error(`✗ --json usage: expected exit 1 with a JSON envelope, got exit ${res.status} and ${JSON.stringify(out)}`);
    process.exitCode = 1;
    return;
  }

  let envelope;
  try {
    envelope = JSON.parse(out);
  } catch {
    console.error(`✗ --json usage: envelope is not valid JSON: ${JSON.stringify(out)}`);
    process.exitCode = 1;
    return;
  }
  if (envelope.ok !== false || envelope.error?.code !== "USAGE" || envelope.exitCode !== 1) {
    console.error(`✗ --json usage: unexpected envelope ${JSON.stringify(envelope)}`);
    process.exitCode = 1;
    return;
  }
  // Assert on the PARSED message, not the wire bytes: JSON.stringify re-encodes an
  // ESC as the literal text `\u001b`, so the raw stdout never carries a control
  // character and a byte-level scan here would always pass.
  if (envelope.error.message.includes(esc)) {
    console.error(`✗ --json usage: message carries ANSI, so a consumer printing it gets escape codes: ${JSON.stringify(envelope.error.message)}`);
    process.exitCode = 1;
    return;
  }

  console.log("✓ --json usage: unknown command yields a color-free USAGE envelope + exit 1");
  passed += 1;
}

if (!PMS.has(E2E_PM)) {
  die(`unknown E2E_PM="${E2E_PM}" (expected one of ${[...PMS].join(", ")})`);
}
if (!existsSync(cli)) {
  die("CLI is not built. Run `pnpm build` before the e2e gate (dist/cli.mjs missing).");
}
console.log(`▶ E2E_PM=${E2E_PM}: synthetic-payload distribution gate`);

runInitSmoke(E2E_PM);
runReadonlyGate(E2E_PM);
runPayloadExtension(E2E_PM);
runUpgradeLeg();
runVersionCheck();
runJsonUsageCheck();

const expected = 6;
if (process.exitCode) {
  console.error(`\nDistribution E2E gate FAILED (${passed}/${expected} legs clean).`);
} else {
  console.log(`\nDistribution E2E gate passed: ${passed}/${expected} legs clean on the synthetic @acme/payload (E2E_PM=${E2E_PM}).`);
}
