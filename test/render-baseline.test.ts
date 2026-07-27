import type { ManagedFile, StreamctlConfig } from "../src/config/types";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compose } from "../src/engine/compose";
import { resolvePresetChain } from "../src/engine/manifest";
import { resolvePayload } from "../src/payload/resolve";

// FROZEN BYTE BASELINE: do NOT regenerate with `vitest -u`. A diff here means the
// composed output changed, and that change had better be intentional.
// The synthetic `@acme/payload` fixture exercises every strategy (full, block, merge,
// scaffold), placeholders, fragment toggles, `enabledBy`, `adoption`, `shadowedBy`,
// and versionProfiles, so the engine's byte contract is frozen without depending on
// any real payload.

const configPkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/synthetic-payload");
const presetsDir = join(configPkgDir, "presets");
const PKG = "@acme/payload";
const VERSION = "1.4.0";

/** A preset's OWN declared files (path + whether it renders), straight from its manifest. */
function declaredFiles(preset: string): { path: string; renders: boolean }[] {
  const raw = readFileSync(join(presetsDir, preset, "preset.json"), "utf8");
  return ((JSON.parse(raw) as { files?: { path: string; render?: string }[] }).files ?? [])
    .map(f => ({ path: f.path, renders: f.render !== undefined }));
}

let payloadPromise: ReturnType<typeof resolvePayload> | undefined;
function payload(): ReturnType<typeof resolvePayload> {
  payloadPromise ??= resolvePayload(configPkgDir, PKG, VERSION, { resolvePackageDir: () => configPkgDir });
  return payloadPromise;
}

/**
 * Resolve a preset's OWN managed file (by path) via the v2 preset chain, so that it
 * carries its resolved `renderDef` (the generic renderer's definition).
 */
async function resolvedFile(preset: string, path: string): Promise<ManagedFile> {
  const { files } = await resolvePresetChain(await payload(), preset, "std");
  const found = files.find(f => f.path === path);
  if (found === undefined) {
    throw new Error(`preset "${preset}" did not resolve own file "${path}"`);
  }
  return found;
}

interface MatrixCase {
  name: string;
  config: Partial<StreamctlConfig>;
}

/**
 * The config toggle matrix (real config paths on the synthetic payload). Render-
 * bearing files run the FULL matrix, including knobs that do NOT affect them, so that
 * invariance is frozen too: toggling `ci.lint` must never change the Containerfile.
 * Non-render files are config-independent and collapse to `defaults`.
 */
const MATRIX: MatrixCase[] = [
  { name: "defaults", config: {} },
  { name: "ci.lint", config: { ci: { lint: true } } },
  { name: "ci.smoke", config: { ci: { smoke: true } } },
  { name: "ci.all-jobs", config: { ci: { lint: true, smoke: true } } },
  { name: "ci.custom-node", config: { ci: { nodeVersion: "22.20.0" } } },
  { name: "aptPackages", config: { aptPackages: ["openssl", "curl"] } },
  { name: "files-off", config: { files: { ".vscode/settings.json": "off" } } },
];

function configFor(base: string, overrides: Partial<StreamctlConfig>): StreamctlConfig {
  return { package: PKG, base, version: VERSION, profile: "std", ...overrides };
}

/** Compose one managed file against `currentContent: null` and return its raw target bytes. */
async function targetContent(preset: string, path: string, overrides: Partial<StreamctlConfig>): Promise<string> {
  const result = await compose(await resolvedFile(preset, path), await payload(), null, configFor(preset, overrides));
  if (result.status !== "composed") {
    throw new Error(`expected a composed result for ${path}, got "${result.status}"`);
  }
  return result.targetContent;
}

for (const preset of ["base", "app"] as const) {
  describe(`render baseline: ${preset} preset`, () => {
    for (const file of declaredFiles(preset)) {
      if (file.renders) {
        // Render-bearing file: freeze the whole config-to-bytes mapping.
        describe(file.path, () => {
          for (const matrixCase of MATRIX) {
            it(matrixCase.name, async () => {
              expect(await targetContent(preset, file.path, matrixCase.config)).toMatchSnapshot();
            });
          }
        });
      } else {
        // Config-independent file: one deterministic snapshot.
        it(file.path, async () => {
          expect(await targetContent(preset, file.path, {})).toMatchSnapshot();
        });
      }
    }
  });
}
