import type { RunInitOptions } from "../src/engine/init";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bumpDevDeps, readPayloadOverride, runInit } from "../src/engine/init";
import { createInstaller } from "../src/engine/pm";
import { StreamctlError } from "../src/errors";
import { captureStderr } from "./helpers/streams";

// Deliberately different numbers. The CLI and the payload release independently, so a
// test that passes with one shared constant would hide a re-coupling of the two pins.
const CLI_VERSION = "1.2.3";
const PAYLOAD_VERSION = "9.9.9";

/** Fixture `@acme/payload` contents: base + nuxt-app presets behind a v2 manifest. */
const TEMPLATES: Record<string, string> = {
  "manifest.json": JSON.stringify({
    schemaVersion: 2,
    presets: ["base", "nuxt-app"],
    profiles: [
      { name: "nuxt-4", detect: { dependency: "nuxt", majorIs: 4 } },
      { name: "nuxt-3", detect: { dependency: "nuxt", majorIs: 3 } },
    ],
    defaultBase: "nuxt-app",
  }),
  "base/preset.json": JSON.stringify({
    name: "base",
    files: [
      { path: ".editorconfig", strategy: "full", source: "base/editorconfig" },
      { path: ".npmrc", strategy: "block", source: "base/npmrc", blockMark: "registry" },
    ],
  }),
  "base/editorconfig": "root = true\n",
  "base/npmrc": "@acme:registry=https://registry.example.com\nalways-auth=true\n",
  "nuxt-app/preset.json": JSON.stringify({
    name: "nuxt-app",
    extends: ["base"],
    files: [
      { path: "eslint.config.ts", strategy: "scaffold", source: "nuxt-app/eslint.config.ts" },
      { path: "prisma.config.ts", strategy: "scaffold", source: "nuxt-app/prisma.config.ts" },
    ],
    versionProfiles: {
      "nuxt-4": { "engines.node": ">=22.0.0", "devDependencies.nuxt": "^4.0.0", "devDependencies.jiti": "^2.0.0", "scripts.postinstall": "nuxt prepare" },
      "nuxt-3": {},
    },
  }),
  "nuxt-app/eslint.config.ts": "export default createStreamctlEslint()\n",
  "nuxt-app/prisma.config.ts": "export default defineConfig(buildPrismaConfig())\n",
};

let repo: string;
let configPkg: string;

/** Lay out the config package on disk the way a real install would deliver it. */
async function makeConfigPackage(): Promise<void> {
  await mkdir(join(configPkg, "presets", "base"), { recursive: true });
  await mkdir(join(configPkg, "presets", "nuxt-app"), { recursive: true });
  await writeFile(join(configPkg, "package.json"), JSON.stringify({ name: "@acme/payload", version: PAYLOAD_VERSION }));
  for (const [source, content] of Object.entries(TEMPLATES)) {
    await writeFile(join(configPkg, "presets", source), content);
  }
}

function baseOpts(overrides: Partial<RunInitOptions> = {}): RunInitOptions {
  return {
    cwd: repo,
    package: "@acme/payload",
    cliVersion: CLI_VERSION,
    // Explicit base and profile always win over manifest detection.
    base: "nuxt-app",
    profile: "nuxt-4",
    yes: true,
    install: async () => {},
    checkRegistryAuth: async () => true,
    // By default the payload's pin comes off the registry probe, never off cliVersion.
    latestProbe: async () => PAYLOAD_VERSION,
    versionExists: async () => true,
    resolvePackageDir: () => configPkg,
    ...overrides,
  };
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "streamctl-init-repo-"));
  configPkg = await mkdtemp(join(tmpdir(), "streamctl-init-pkg-"));
  await makeConfigPackage();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(repo, { recursive: true, force: true });
  await rm(configPkg, { recursive: true, force: true });
});

describe("runInit", () => {
  it("happy path on a clean Nuxt 4 repo", async () => {
    await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }, null, 2)}\n`);
    const install = vi.fn(async () => {});

    const result = await runInit(baseOpts({ install }));

    expect(result.base).toBe("nuxt-app");
    expect(result.profile).toBe("nuxt-4");
    expect(install).toHaveBeenCalledTimes(1);

    const config = await readFile(join(repo, "streamctl.config.ts"), "utf8");
    expect(config).toContain(`import { defineStreamctlConfig } from "@sidebase/streamctl"`);
    expect(config).toContain(`package: "@acme/payload"`);
    expect(config).toContain(`base: "nuxt-app"`);
    expect(config).toContain(`profile: "nuxt-4"`);
    expect(config).toContain(`version: "${PAYLOAD_VERSION}"`);
    // `existsSync`, not this file's `readFile(...).catch(() => null)` idiom: `readFile`
    // on a directory throws EISDIR, the catch swallows it, and the assertion would
    // report "absent" for a `.streamctl/` sitting right there.
    expect(existsSync(join(repo, ".streamctl"))).toBe(false);

    // `.npmrc` is a preset-managed block written by the first sync, not by init itself.
    const npmrc = await readFile(join(repo, ".npmrc"), "utf8");
    expect(npmrc).toContain("always-auth=true");
    expect(npmrc).toContain("@acme:registry=https://registry.example.com");
    expect(npmrc).toContain("# BEGIN streamctl MANAGED BLOCK registry");

    const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    // The two pins are independent: the CLI devDep comes from cliVersion, the payload
    // devDep from the probe.
    expect(pkg.devDependencies["@sidebase/streamctl"]).toBe(CLI_VERSION);
    expect(pkg.devDependencies["@acme/payload"]).toBe(PAYLOAD_VERSION);
    // jiti is not wired by init; it lands via the first sync's version reconcile.
    expect(pkg.devDependencies.jiti).toBe("^2.0.0");

    // The chained sync wrote the wrappers and base files from the installed payload.
    expect(await readFile(join(repo, "eslint.config.ts"), "utf8")).toBe("export default createStreamctlEslint()\n");
    expect(await readFile(join(repo, "prisma.config.ts"), "utf8")).toBe("export default defineConfig(buildPrismaConfig())\n");
    expect(await readFile(join(repo, ".editorconfig"), "utf8")).toBe("root = true\n");
    expect(result.sync.written).toContain("eslint.config.ts");
  });

  it("prefers the payload's config.template.ts when it ships one", async () => {
    await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }, null, 2)}\n`);
    // Payload-root convention, not something listed in preset.json.
    await writeFile(
      join(configPkg, "presets", "config.template.ts"),
      "import { defineNuxtBaseConfig } from \"@acme/payload/config\";\n\nexport default defineNuxtBaseConfig({\n  package: \"__PACKAGE__\",\n  base: \"__BASE__\",\n  version: \"__VERSION__\",\n  profile: \"__PROFILE__\",\n});\n",
    );

    await runInit(baseOpts());

    const config = await readFile(join(repo, "streamctl.config.ts"), "utf8");
    expect(config).toContain("import { defineNuxtBaseConfig } from \"@acme/payload/config\"");
    expect(config).not.toContain("defineStreamctlConfig");
    expect(config).toContain("package: \"@acme/payload\"");
    expect(config).toContain("base: \"nuxt-app\"");
    expect(config).toContain(`version: "${PAYLOAD_VERSION}"`);
    expect(config).toContain("profile: \"nuxt-4\"");
    expect(config).not.toContain("__PACKAGE__");
    expect(config).not.toContain("__PROFILE__");
  });

  it("does not overwrite a pre-existing wrapper", async () => {
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }));
    await writeFile(join(repo, "eslint.config.ts"), "export default localOverride()\n");

    const result = await runInit(baseOpts());

    expect(await readFile(join(repo, "eslint.config.ts"), "utf8")).toBe("export default localOverride()\n");
    expect(result.sync.skipped).toContain("eslint.config.ts");
  });

  it("runs the chained sync interactively when a decider is supplied", async () => {
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }));
    const calls: string[] = [];
    const decider = vi.fn(async (change: { path: string }) => {
      calls.push(change.path);
      return "accept" as const;
    });

    await runInit(baseOpts({ yes: false, decider }));

    // Clean full-file create is offered to the decider; scaffold wrappers never are.
    expect(calls).toContain(".editorconfig");
    expect(calls).not.toContain("eslint.config.ts");
    expect(await readFile(join(repo, ".editorconfig"), "utf8")).toBe("root = true\n");
  });

  it("uses the explicit --profile", async () => {
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "app" }));
    const result = await runInit(baseOpts({ profile: "nuxt-4" }));
    expect(result.profile).toBe("nuxt-4");
  });

  // The flag always wins over detection, so an undeclared `--profile` used to sail
  // through and resolve the version baseline to `{}`, silently disabling reconcile.
  it("rejects an explicit --profile the payload does not declare", async () => {
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "app" }));
    const error = await runInit(baseOpts({ profile: "n5" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).toContain("\"n5\"");
    expect((error as StreamctlError).message).toContain("nuxt-4"); // lists the declared names
  });

  it("rejects an already-initialized repo with ALREADY_INITIALIZED", async () => {
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }));
    await mkdir(join(repo, ".streamctl"), { recursive: true });
    await writeFile(join(repo, ".streamctl", "config.ts"), "export default {}\n");

    const error = await runInit(baseOpts()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("ALREADY_INITIALIZED");
    // The legacy repo is told about the file it has, not about a root file that does
    // not exist. A code-only assertion passes either way.
    expect((error as StreamctlError).message).toContain(".streamctl/config.ts");
  });

  it("rejects a root-config repo with ALREADY_INITIALIZED naming the root file", async () => {
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }));
    await writeFile(join(repo, "streamctl.config.ts"), "export default {}\n");

    const error = await runInit(baseOpts()).catch((e: unknown) => e);
    expect((error as StreamctlError).code).toBe("ALREADY_INITIALIZED");
    expect((error as StreamctlError).message).toContain("streamctl.config.ts");
    // Not redundant with the line above: neither path is a substring of the other, so
    // the positive already distinguishes them. This catches a later copy change that
    // names *both* locations — accurate for the guard, but useless to someone holding
    // only one of the two files.
    expect((error as StreamctlError).message).not.toContain(".streamctl/config.ts");
  });

  it("rejects a non-repo with NOT_A_REPO", async () => {
    const error = await runInit(baseOpts()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("NOT_A_REPO");
  });

  it("checks for a repo before checking for a config", async () => {
    // A config with no `package.json` must still fail NOT_A_REPO. The only other
    // NOT_A_REPO test has neither file, so it cannot see the ordering — and the config
    // guard is now an awaited resolver call doing up to 24 stats, which invites being
    // hoisted above the cheap synchronous probe.
    await writeFile(join(repo, "streamctl.config.ts"), "export default {}\n");

    const error = await runInit(baseOpts()).catch((e: unknown) => e);
    expect((error as StreamctlError).code).toBe("NOT_A_REPO");
  });

  it("blocks a both-present repo without emitting the ambiguity warning", async () => {
    // The one deliberate deviation in the feature: `resolveConfigFile` takes an optional
    // logger with no `stderrLogger` fallback, and `init` passes none, so a warning cannot
    // precede the failure. That has two independent halves, and they need two channels:
    // the spy proves `init` does not forward its own logger; the stderr capture proves
    // the resolver has no house default behind it. A spy alone is blind to
    // `(logger ?? stderrLogger).warn(...)`, which writes past it to the real stream.
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }));
    await writeFile(join(repo, "streamctl.config.ts"), "export default {}\n");
    await mkdir(join(repo, ".streamctl"), { recursive: true });
    await writeFile(join(repo, ".streamctl", "config.ts"), "export default {}\n");
    const warn = vi.fn();
    const stderr = captureStderr();

    const error = await runInit(baseOpts({ logger: { warn } })).catch((e: unknown) => e);

    // Root wins, so the message names the file `init` would otherwise have written.
    expect((error as StreamctlError).code).toBe("ALREADY_INITIALIZED");
    expect((error as StreamctlError).message).toContain("streamctl.config.ts");
    expect(stderr.join("")).toBe("");
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("streamctl:"));
    // Also catches a reworded warning that drops the prefix. `init`'s legitimate warnings
    // (profile detection) never name a config path, so this cannot false-fire.
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/streamctl\.config\.ts|\.streamctl\/config\.ts/u));
  });

  it("surfaces REGISTRY_AUTH_FAILED when packages are unreadable", async () => {
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }));
    const error = await runInit(baseOpts({ checkRegistryAuth: async () => false })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("REGISTRY_AUTH_FAILED");
    expect((error as StreamctlError).message).toContain("configure registry access");
    // It failed before writing the manifest, so a retry is not blocked.
    expect(await readFile(join(repo, "streamctl.config.ts")).catch(() => null)).toBeNull();
  });

  it("--skip-registry-check bypasses the probe entirely", async () => {
    await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }, null, 2)}\n`);
    const checkRegistryAuth = vi.fn(async () => false);

    // With the registry off-limits the pin can't be probed, so it must be named.
    const result = await runInit(baseOpts({ skipRegistryCheck: true, payloadVersion: PAYLOAD_VERSION, checkRegistryAuth }));

    expect(checkRegistryAuth).not.toHaveBeenCalled();
    expect(result.base).toBe("nuxt-app");
    expect(await readFile(join(repo, "streamctl.config.ts"), "utf8")).toContain(`package: "@acme/payload"`);
  });

  it("skips the probe when pnpm.overrides already resolves the payload", async () => {
    await writeFile(
      join(repo, "package.json"),
      `${JSON.stringify({
        name: "app",
        devDependencies: { nuxt: "^4.0.0" },
        pnpm: { overrides: { "@acme/payload": `file:./vendor/config-${PAYLOAD_VERSION}.tgz` } },
      }, null, 2)}\n`,
    );
    const checkRegistryAuth = vi.fn(async () => false);

    const result = await runInit(baseOpts({ checkRegistryAuth }));

    expect(checkRegistryAuth).not.toHaveBeenCalled();
    expect(result.base).toBe("nuxt-app");
  });

  it("same for an npm-style root overrides entry", async () => {
    await writeFile(
      join(repo, "package.json"),
      `${JSON.stringify({
        name: "app",
        devDependencies: { nuxt: "^4.0.0" },
        overrides: { "@acme/payload": `file:./vendor/config-${PAYLOAD_VERSION}.tgz` },
      }, null, 2)}\n`,
    );
    const checkRegistryAuth = vi.fn(async () => false);

    const result = await runInit(baseOpts({ checkRegistryAuth }));

    expect(checkRegistryAuth).not.toHaveBeenCalled();
    expect(result.base).toBe("nuxt-app");
  });

  it("pins the payload from the registry probe, not from the CLI's own version", async () => {
    await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }, null, 2)}\n`);
    const latestProbe = vi.fn(async () => PAYLOAD_VERSION);

    const result = await runInit(baseOpts({ latestProbe }));

    expect(latestProbe).toHaveBeenCalledWith(repo, "@acme/payload");
    expect(result.version).toBe(PAYLOAD_VERSION);
    expect(result.cliVersion).toBe(CLI_VERSION);
    const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies["@acme/payload"]).toBe(PAYLOAD_VERSION);
    expect(pkg.devDependencies["@sidebase/streamctl"]).toBe(CLI_VERSION);
    expect(await readFile(join(repo, "streamctl.config.ts"), "utf8")).toContain(`version: "${PAYLOAD_VERSION}"`);
  });

  it("an explicit payloadVersion wins over the probe but is still checked against the registry", async () => {
    await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }, null, 2)}\n`);
    const latestProbe = vi.fn(async () => "0.0.1");
    const versionExists = vi.fn(async () => true);

    const result = await runInit(baseOpts({ payloadVersion: PAYLOAD_VERSION, latestProbe, versionExists }));

    expect(latestProbe).not.toHaveBeenCalled();
    expect(versionExists).toHaveBeenCalledWith(repo, "@acme/payload", PAYLOAD_VERSION);
    expect(result.version).toBe(PAYLOAD_VERSION);
  });

  it("rejects an unpublished payloadVersion and leaves package.json untouched", async () => {
    const before = `${JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }, null, 2)}\n`;
    await writeFile(join(repo, "package.json"), before);

    const error = await runInit(baseOpts({ payloadVersion: "4.0.4", versionExists: async () => false })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("TARGET_NOT_FOUND");
    expect(await readFile(join(repo, "package.json"), "utf8")).toBe(before);
  });

  it("writes nothing when the latest release can't be resolved, e.g. offline", async () => {
    const before = `${JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }, null, 2)}\n`;
    await writeFile(join(repo, "package.json"), before);

    const error = await runInit(baseOpts({ latestProbe: async () => null })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).toContain("--payload-version");
    // The repo is left exactly as it was, so a retry isn't blocked.
    expect(await readFile(join(repo, "package.json"), "utf8")).toBe(before);
    expect(await readFile(join(repo, "streamctl.config.ts")).catch(() => null)).toBeNull();
  });

  it("--skip-registry-check takes an explicit payloadVersion as-is", async () => {
    await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }, null, 2)}\n`);
    const latestProbe = vi.fn(async () => "0.0.1");
    const versionExists = vi.fn(async () => false);

    const result = await runInit(baseOpts({ skipRegistryCheck: true, payloadVersion: PAYLOAD_VERSION, latestProbe, versionExists }));

    expect(latestProbe).not.toHaveBeenCalled();
    expect(versionExists).not.toHaveBeenCalled();
    expect(result.version).toBe(PAYLOAD_VERSION);
  });

  it("--skip-registry-check without a payloadVersion or override fails instead of probing", async () => {
    await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }, null, 2)}\n`);
    const latestProbe = vi.fn(async () => PAYLOAD_VERSION);

    const error = await runInit(baseOpts({ skipRegistryCheck: true, latestProbe })).catch((e: unknown) => e);

    expect(latestProbe).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).toContain("--payload-version");
  });

  it("takes the pin from an override's embedded version", async () => {
    await writeFile(
      join(repo, "package.json"),
      `${JSON.stringify({
        name: "app",
        devDependencies: { nuxt: "^4.0.0" },
        pnpm: { overrides: { "@acme/payload": `file:./vendor/config-${PAYLOAD_VERSION}.tgz` } },
      }, null, 2)}\n`,
    );
    const latestProbe = vi.fn(async () => "0.0.1");

    const result = await runInit(baseOpts({ latestProbe }));

    expect(latestProbe).not.toHaveBeenCalled();
    expect(result.version).toBe(PAYLOAD_VERSION);
  });

  it("fails with CONFIG_INVALID when an override carries no version and none was passed", async () => {
    await writeFile(
      join(repo, "package.json"),
      `${JSON.stringify({
        name: "app",
        devDependencies: { nuxt: "^4.0.0" },
        pnpm: { overrides: { "@acme/payload": "link:../config" } },
      }, null, 2)}\n`,
    );

    const error = await runInit(baseOpts()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).toContain("--payload-version");
  });

  it("--no-install scaffolds and wires devDeps but skips the first sync", async () => {
    await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }, null, 2)}\n`);

    // A skip-installer no-ops; runInit then returns before resolving/syncing the payload.
    const result = await runInit(baseOpts({ noInstall: true, install: createInstaller({ skip: true }) }));

    expect(result.sync).toBeNull();
    // Config and devDeps are still written; only the install and first sync are skipped.
    expect(await readFile(join(repo, "streamctl.config.ts"), "utf8")).toContain(`package: "@acme/payload"`);
    const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies["@acme/payload"]).toBe(PAYLOAD_VERSION);
    expect(await readFile(join(repo, ".editorconfig")).catch(() => null)).toBeNull();
  });

  it("--no-install without --profile fails before wiring devDeps", async () => {
    const original = `${JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }, null, 2)}\n`;
    await writeFile(join(repo, "package.json"), original);
    const install = vi.fn(async () => {});

    const error = await runInit(baseOpts({ profile: undefined, noInstall: true, install })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("PROFILE_DETECT_FAILED");
    // Known-impossible upfront, so no side effects: install never ran and package.json
    // is byte-identical.
    expect(install).not.toHaveBeenCalled();
    expect(await readFile(join(repo, "package.json"), "utf8")).toBe(original);
    expect(await readFile(join(repo, "streamctl.config.ts")).catch(() => null)).toBeNull();
  });

  // nypm throws plain Errors. `upgrade` has always re-labelled them; `init` did not, so
  // the same registry/EACCES/peer-dep failure surfaced as `code: "UNKNOWN"` in --json.
  it("labels a plain installer failure INSTALL_FAILED, like upgrade does", async () => {
    await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "app" }, null, 2)}\n`);
    const install = async (): Promise<void> => {
      throw new Error("ECONNRESET fetching @acme/payload");
    };

    const error = await runInit(baseOpts({ install })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("INSTALL_FAILED");
    expect((error as StreamctlError).message).toContain("ECONNRESET");
  });

  it("passes a coded installer error through untouched", async () => {
    await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "app" }, null, 2)}\n`);
    const install = async (): Promise<void> => {
      throw new StreamctlError("REGISTRY_AUTH_FAILED", "no token");
    };

    const error = await runInit(baseOpts({ install })).catch((e: unknown) => e);
    expect((error as StreamctlError).code).toBe("REGISTRY_AUTH_FAILED");
  });

  it("declining the install prompt skips the sync instead of erroring", async () => {
    await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }, null, 2)}\n`);

    // The payload never lands, so runInit must not barrel into CONFIG_PKG_MISSING.
    // It returns sync: null, same as --no-install.
    const result = await runInit(baseOpts({ install: createInstaller({ confirm: async () => false }) }));

    expect(result.sync).toBeNull();
    expect(await readFile(join(repo, "streamctl.config.ts"), "utf8")).toContain(`package: "@acme/payload"`);
    expect(await readFile(join(repo, ".editorconfig")).catch(() => null)).toBeNull();
  });
});

/**
 * Promote the v1 fixture payload to v2 by dropping a `presets/manifest.json` in; its
 * preset.json files are already a valid v2 shape. Two detectable profiles, so a wrong
 * dependency major comes out ambiguous or absent rather than a silent single match.
 */
async function writeV2Manifest(): Promise<void> {
  await writeFile(
    join(configPkg, "presets", "manifest.json"),
    JSON.stringify({
      schemaVersion: 2,
      presets: ["base", "nuxt-app"],
      profiles: [
        { name: "nuxt-4", detect: { dependency: "nuxt", majorIs: 4 } },
        { name: "nuxt-3", detect: { dependency: "nuxt", majorIs: 3 } },
      ],
      defaultBase: "nuxt-app",
    }),
  );
}

describe("runInit (v2 manifest auto-detection)", () => {
  it("detects the profile and defaults the base when both flags are omitted", async () => {
    await writeV2Manifest();
    await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.2.0" } }, null, 2)}\n`);
    const warn = vi.fn();

    const result = await runInit(baseOpts({ base: undefined, profile: undefined, logger: { warn } }));

    // Profile from `profiles[].detect`, base from `defaultBase`.
    expect(result.profile).toBe("nuxt-4");
    expect(result.base).toBe("nuxt-app");
    expect(await readFile(join(repo, "streamctl.config.ts"), "utf8")).toContain(`profile: "nuxt-4"`);
    // Detection is never silent: the evidence is logged.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("detected profile \"nuxt-4\""));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("nuxt ^4.2.0 in devDependencies"));
  });

  it("detects the other profile from a different dependency major", async () => {
    await writeV2Manifest();
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "app", dependencies: { nuxt: "~3.13.0" } }));

    const result = await runInit(baseOpts({ base: undefined, profile: undefined }));

    expect(result.profile).toBe("nuxt-3");
  });

  it("fails with PROFILE_DETECT_FAILED when nothing detectable is present", async () => {
    await writeV2Manifest();
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "app", devDependencies: { vue: "^3.0.0" } }));

    const error = await runInit(baseOpts({ base: undefined, profile: undefined })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("PROFILE_DETECT_FAILED");
    expect((error as StreamctlError).message).toContain("pass --profile");
    // The message enumerates the manifest's profiles so the user knows the valid set.
    expect((error as StreamctlError).message).toContain("nuxt-4, nuxt-3");
  });

  it("an explicit --profile overrides detection even when the dependency disagrees", async () => {
    await writeV2Manifest();
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "app", devDependencies: { nuxt: "^3.0.0" } }));

    const result = await runInit(baseOpts({ base: undefined, profile: "nuxt-4" }));

    expect(result.profile).toBe("nuxt-4");
    expect(result.base).toBe("nuxt-app"); // still defaulted from the manifest
  });
});

let hasGit = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  hasGit = false;
}

describe.skipIf(!hasGit)("runInit on a git repo with a pre-committed .npmrc", () => {
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=test", ...args], { cwd: repo, stdio: "ignore" });
  };

  it("does not refuse its own first sync", async () => {
    await writeFile(join(repo, "package.json"), `${JSON.stringify({ name: "app", devDependencies: { nuxt: "^4.0.0" } }, null, 2)}\n`);
    // The repo already tracks a committed .npmrc, so init appends its managed block and
    // dirties a tracked owned file. The guard must not treat that as someone else's edit.
    await writeFile(join(repo, ".npmrc"), "save-exact=true\n");
    git("init");
    git("add", "-A");
    git("commit", "-m", "init");

    const result = await runInit(baseOpts());

    expect(result.base).toBe("nuxt-app");
    const npmrc = await readFile(join(repo, ".npmrc"), "utf8");
    expect(npmrc).toContain("save-exact=true"); // pre-existing content preserved
    expect(npmrc).toContain("# BEGIN streamctl MANAGED BLOCK registry");
    expect(result.sync.written).toContain(".editorconfig");
  });
});

describe("readPayloadOverride", () => {
  let dir: string;
  const PKG = "@acme/payload";
  const writePkg = (obj: unknown): Promise<void> => writeFile(join(dir, "package.json"), JSON.stringify(obj, null, 2));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "streamctl-override-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a pnpm.overrides value", async () => {
    await writePkg({ name: "app", pnpm: { overrides: { [PKG]: "file:./vendor/config-1.2.3.tgz" } } });
    expect(await readPayloadOverride(dir, PKG)).toBe("file:./vendor/config-1.2.3.tgz");
  });

  it("matches an npm-style `${name}@range` selector key in root overrides", async () => {
    await writePkg({ name: "app", overrides: { [`${PKG}@^1`]: "file:./vendor/config.tgz" } });
    expect(await readPayloadOverride(dir, PKG)).toBe("file:./vendor/config.tgz");
  });

  it("returns null when the payload isn't overridden at all", async () => {
    await writePkg({ name: "app", pnpm: { overrides: { "some-other-pkg": "1.0.0" } } });
    expect(await readPayloadOverride(dir, PKG)).toBeNull();
  });

  it("ignores a non-string override value", async () => {
    await writePkg({ name: "app", pnpm: { overrides: { [PKG]: { ".": "1.0.0" } } } });
    expect(await readPayloadOverride(dir, PKG)).toBeNull();
  });
});

describe("bumpDevDeps", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "streamctl-proto-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("never rewrites portal: or git: protocol specs to a bare range", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      name: "app",
      devDependencies: { "pkg-portal": "portal:../pkg-portal", "pkg-git": "git+https://example.com/pkg.git" },
    }, null, 2));

    const bumps = await bumpDevDeps(dir, { "pkg-portal": "1.2.3", "pkg-git": "1.2.3" }, true);

    // Protocol specs are managed-exempt, so nothing is reported and nothing changes.
    expect(bumps).toEqual([]);
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies["pkg-portal"]).toBe("portal:../pkg-portal");
    expect(pkg.devDependencies["pkg-git"]).toBe("git+https://example.com/pkg.git");
  });

  it("throws a clean CONFIG_INVALID (no absolute path) when package.json is absent", async () => {
    // `dir` has no package.json. The read must surface a repo-relative message,
    // never a raw fs error carrying the absolute path.
    const error = await bumpDevDeps(dir, { foo: "1.2.3" }, true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).not.toContain(dir);
  });
});
