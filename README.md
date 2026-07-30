<div align="center">
   <p>
      <picture>
         <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/sidebase/streamctl/main/assets/banner-dark.svg">
         <img src="https://raw.githubusercontent.com/sidebase/streamctl/main/assets/banner-light.svg" alt="streamctl" width="560">
      </picture>
   </p>
   <p>
      <a href="https://www.npmjs.com/package/@sidebase/streamctl">
         <picture>
            <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/npm/v/@sidebase/streamctl?logo=npm&label=npm&color=5bf3c7&labelColor=202127&logoColor=5bf3c7">
            <img alt="npm version" src="https://img.shields.io/npm/v/@sidebase/streamctl?logo=npm&label=npm&color=1a7f52&labelColor=e2e2e3&logoColor=1a7f52"/>
         </picture>
      </a>
      <a href="https://nodejs.org">
         <picture>
            <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/node/v/@sidebase/streamctl?logo=nodedotjs&label=node&color=42b883&labelColor=202127&logoColor=42b883">
            <img alt="Node engine" src="https://img.shields.io/node/v/@sidebase/streamctl?logo=nodedotjs&label=node&color=30a36c&labelColor=e2e2e3&logoColor=30a36c"/>
         </picture>
      </a>
      <a href="https://github.com/sidebase/streamctl/actions/workflows/ci-pr.yml">
         <picture>
            <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/github/actions/workflow/status/sidebase/streamctl/ci-pr.yml?branch=main&logo=githubactions&label=ci&color=7bceb6&labelColor=202127&logoColor=7bceb6">
            <img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/sidebase/streamctl/ci-pr.yml?branch=main&logo=githubactions&label=ci&color=179974&labelColor=e2e2e3&logoColor=179974"/>
         </picture>
      </a>
      <a href="https://github.com/sidebase/streamctl/blob/main/LICENSE">
         <picture>
            <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/license-MIT-30a36c?labelColor=202127">
            <img alt="MIT License" src="https://img.shields.io/badge/license-MIT-0f6a45?labelColor=e2e2e3"/>
         </picture>
      </a>
   </p>
   <hr>
   <p>
      <h3>One payload, every repo in sync</h3>
      <div>streamctl syncs a versioned configuration payload into your repo: CI workflows, editor settings, lint wrappers, whatever the payload ships.</div>
      <div>It blocks on conflicts instead of clobbering your edits, keeps a small package.json version allow-list reconciled, and fails CI when files drift.</div>
   </p>
</div>

## How it works

The payload is a normal npm package that ships preset templates, for example `@your-org/config`. streamctl reads those templates straight out of the installed package in `node_modules`, so there is no tag fetch, no network call and no cache to invalidate. To roll a config change across many repos you publish a new payload version and run `streamctl upgrade` in each one.

## Install

`streamctl init` wires both `streamctl` and the payload as devDependencies, so there is nothing to install globally. Run it through your package manager:

```bash
pnpm streamctl <command> [flags]
```

## Quick start

```bash
pnpm streamctl init --package @your-org/config   # scaffold config + wrappers, first sync
pnpm streamctl sync --interactive   # reconcile managed files (prompts on conflicts)
pnpm streamctl check                # read-only CI gate (no writes)
pnpm streamctl status               # per-file state overview (always exit 0)
pnpm streamctl upgrade              # move the pinned version forward, re-sync
```

> **The one rule:** CI runs `check`; humans run `sync --interactive`.

## Commands

### `streamctl init`

Wire a repo to a payload for the first time. Reads the payload's manifest to pick the base preset and auto-detect the profile (the manifest ships the detection probes, so the CLI has no framework knowledge), scaffolds `streamctl.config.ts` from the payload's own template, adds the devDependencies, runs the install, then runs the first `sync`.

| Flag | Type | Effect |
| ---- | ---- | ------ |
| `--package <name>` | string (**required**) | The payload package to wire (e.g. `@your-org/config`) |
| `--base <preset>` | string | Override the base preset (defaults to the payload manifest's `defaultBase`) |
| `--profile <name>` | string | Override the profile (auto-detected when omitted) |
| `--payload-version <version>` | string | Pin a specific payload version (defaults to the latest published; required alongside `--skip-registry-check`) |
| `--skip-registry-check` | boolean | Skip the payload registry auth probe |
| `--no-install` | boolean | Scaffold + wire devDeps but skip the install **and** the first sync |
| `--yes` | boolean | Non-interactive: accept detected defaults, run the first sync headlessly |

```bash
pnpm dlx @sidebase/streamctl init --package @your-org/config
```

### `streamctl sync`

Composes the managed file set from the payload plus your config, then writes it in one transaction. The whole batch is validated up front, so a failure writes nothing at all. Safe changes (`block`/`merge` reconciles, new files) go straight to disk. A conflict on a file streamctl fully owns aborts with exit `2` and leaves your edit alone. A run with nothing to do writes nothing and exits `0`.

One thing to expect: if you change a config knob that feeds a fully-owned render (placeholders, fragment toggles, `aptPackages`, `ci.*`), the next `sync` reports the difference as conflicts. That is deliberate. Drift is derived and there is no state file, so streamctl has no way to tell "my config changed" apart from "someone edited the file". Resolve per file with `sync --interactive`, accept everything with `sync --force`, or narrow the run with `--only <glob>`. `block`/`merge` reconciles still apply on their own.

| Flag | Type | Effect |
| ---- | ---- | ------ |
| `--interactive` | boolean | Per-file accept/skip prompt (TTY only; non-TTY degrades to a printed plan) |
| `--dry-run` | boolean | Compute and report the plan; write nothing |
| `--only <glob>` | string | Restrict to managed paths matching the glob |
| `--version-sync` | boolean (default `true`) | Reconcile the version allow-list; use `--no-version-sync` to skip |
| `--yes` | boolean | Accept creates + safe reconciles without prompting (conflicts still need `--interactive` or `--force`) |
| `--force` | boolean | Accept all changes incl. conflicts **and** bypass the dirty-tree guard. Escape hatch, never the CI default |
| `--json` | boolean | Emit a machine-readable JSON envelope |

```bash
pnpm streamctl sync --interactive
pnpm streamctl sync --dry-run --json
pnpm streamctl sync --only ".github/workflows/*" --force
```

Uncommitted edits on a streamctl-owned path make `sync` refuse rather than clobber your work. Commit, stash, or pass `--force`.

When the version reconcile edits `package.json`, the report reminds you to run your package manager's install. `sync` never installs anything itself. See the [stale-lockfile contract](docs/reference.md#stale-lockfile-hint).

### `streamctl check`

The read-only CI gate. It recomputes the expected content, diffs it against the working tree and reports drift, version skew and (if you ask for it) an outdated payload. It writes nothing and keeps no state file.

| Flag | Type | Effect |
| ---- | ---- | ------ |
| `--fail-on <drift\|outdated\|any>` | string (default `drift`) | Failure threshold (see below) |
| `--json` | boolean | Emit a machine-readable JSON envelope |

- `drift` (default): exit `3` on file drift, version skew, or a structural fault. Offline, no registry probe.
- `outdated`: exit `4` when a newer payload version is published. Probes the registry (see [CI setup](#ci-setup)).
- `any`: both gates; file drift (exit `3`) takes precedence over outdated. Probes the registry.

```bash
pnpm streamctl check                 # CI gate (exit 3 on drift)
pnpm streamctl check --fail-on any --json
```

### `streamctl status`

A read-only overview of what streamctl manages and each file's current state (`in-sync`, `drift`, `conflict`, `missing`, and a few more; [full list](docs/reference.md#status-states)). Always exits `0` on a successful computation: drift and conflicts are shown, not exit-coded.

| Flag | Type | Effect |
| ---- | ---- | ------ |
| `--outdated` | boolean | Also probe for a newer published release. Skipped silently on failure, so `status` works offline |
| `--json` | boolean | Emit a machine-readable JSON envelope |

```bash
pnpm streamctl status                # per-file state table, exit 0
pnpm streamctl status --outdated --json | jq '.data.files'
```

#### `status` vs `check`

| | `streamctl status` | `streamctl check` |
| --- | --- | --- |
| Audience | humans, "what state is my repo in?" | CI, the pass/fail gate |
| Exit code | **always `0`** (informational) | `0` clean, `3` drift, `4` outdated |
| Output | per-file state table + summary | dimension report + verdict |
| Network | none (unless `--outdated`, silent-skip) | none (unless `--fail-on outdated`) |
| Writes | never | never |

### `streamctl upgrade`

The only command that moves the pinned payload version forward. Before it touches anything it snapshots the config file, `package.json` and the lockfile, and any failure along the way (a bad install, an invalid new payload, a conflict) restores all three byte-for-byte. The [reference](docs/reference.md#the-upgrade-transaction) covers the full transaction, including upgrading over a local `file:` override.

| Flag | Type | Effect |
| ---- | ---- | ------ |
| `--to <version>` | string | Target version (default: latest published; **required** when the payload is pinned through a local override) |
| `--dry-run` | boolean | Compute and report; write nothing |
| `--no-install` | boolean | Bump the pin + devDep but skip the install and the sync; the bump is kept and you install + `sync` yourself |
| `--yes` | boolean | Accept creates + safe reconciles in the chained sync (conflicts still need a TTY or `--force`) |
| `--force` | boolean | Accept all overwrites incl. conflicts in the chained sync |
| `--json` | boolean | Emit a machine-readable JSON envelope |

```bash
pnpm streamctl upgrade               # to the latest published version
pnpm streamctl upgrade --to 1.3.0 --dry-run
pnpm streamctl upgrade --no-install  # bump the pin + deps only; install + sync later
```

## How syncing works

Each managed file declares a composition `strategy`:

| Strategy | Behavior | Drift-checked |
| -------- | -------- | ------------- |
| `full` | streamctl owns the whole file; composed content replaces it verbatim | yes |
| `block` | streamctl owns only the `# BEGIN/END streamctl MANAGED BLOCK` region; the rest of the file is the project's. Markers absent, the block is appended | yes (managed region only) |
| `merge` | structured JSONC deep-merge; streamctl owns its keys, the project keeps the rest | yes (owned keys only) |
| `scaffold` | write **once if absent**, then project-owned and never overwritten (the `eslint.config.ts` / `prisma.config.ts` wrappers) | no |

When `sync` cannot proceed on a file, the conflict carries a `kind`, so the report can say "this file is new to streamctl" instead of a flat "conflict":

| `kind` | Meaning |
| ------ | ------- |
| `edit` | A managed file diverged after being in-sync; confirm with `--interactive` or `--force` |
| `adoption` | A pre-existing file the payload now manages; adopt per file with `--interactive` |
| `fault` | A structural impossibility (broken markers, unparseable output); not fixable with `--force`, fix the payload |
| `dirty` | Uncommitted edits on an owned path; commit, stash, or `--force` |

Structured files (`.json*`, `.ya?ml`) get extra safety: composed output is parse-validated before writing, and the `block` strategy is forbidden on them. Details in [structured-file safety](docs/reference.md#structured-file-safety).

## Configuration

`init` scaffolds `streamctl.config.ts` at the repo root, from the payload's own template. The payload exports a typed define function (via its `./config` subpath), so the knobs get full editor inference:

```ts
import { defineConfig } from "@your-org/config/config";

export default defineConfig({
  package: "@your-org/config", // the payload package this repo syncs from
  base: "nuxt-app",        // preset to derive from (validated against the payload's presets)
  version: "0.1.0",        // pinned payload version (bumped by `upgrade`)
  profile: "nuxt-4",       // version-allow-list profile declared by the payload's manifest
  // versionSync: true,           // master opt-out for package.json reconcile
  // versionSyncExclude: [],      // specific allow-list keys to skip
  // aptPackages: ["openssl"],    // injected into the Dockerfile APT_PACKAGES arg
  // ci: { unitTests: true, e2e: false, nodeVersion: "24.13.0", pnpmVersion: "10.28.1" },
  // files: { ".vscode/settings.json": "off" }, // per-file opt-out
  // eslint: { /* forwarded to the ESLint factory; the call lives in eslint.config.ts */ },
});
```

A payload that ships no `config.template.ts` gets a generic fallback that imports the CLI's own `defineStreamctlConfig` from `@sidebase/streamctl` (same fields, minus the typed knobs).

### Where the config lives

Exactly two locations are read, and no others:

1. `streamctl.config.ts` at the repo root — the default, and what `init` writes.
2. `.streamctl/config.<ext>` — the original location, read **permanently**. It is not
   deprecated, there is no warning, and there is no plan to remove it.

Nothing under `.config/` is read. Both locations accept any extension c12 supports
(`.ts`, `.js`, `.mjs`, `.json`, `.yaml`, …).

Moving an existing config is a plain `git mv .streamctl/config.ts streamctl.config.ts`
and nothing else — every command behaves identically either way. `status` is the case
held to that by test: `test/status.command.test.ts` runs it against one repo in both
layouts and asserts the two reports are equal, down to the absence of any trace of which
file was read. If both files exist the root one wins and `streamctl` says so
on stderr once; delete the legacy file to silence it.

## CI setup

Add the gate to your pipeline; exit `3` means the tree drifted from the payload:

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm streamctl check
```

To also fail when a newer payload is published, use `pnpm streamctl check --fail-on any` (exit `4`). Note that this is the one thing `check` does that is not offline: to know whether a newer version exists it has to ask the registry, which it does by running your package manager's `view` for the payload package (falling back to `npm view`). So the job needs registry auth, the same credentials `pnpm install` uses — for a payload on GitHub Packages that means a token with `read:packages`, or you get [`REGISTRY_AUTH_FAILED`](#troubleshooting).

The probe degrades quietly. If the registry cannot be reached, `check` skips the outdated verdict rather than failing the build, and still gates on drift (exit `3`).

## Troubleshooting

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| `NOT_INITIALIZED` | no `streamctl.config.ts` (and no legacy `.streamctl/config.ts`) | run `streamctl init` first |
| `CONFIG_PKG_MISSING` | the payload package is not installed | `pnpm install` |
| `CONFIG_VERSION_MISMATCH` | installed payload version differs from the pinned `version` | `streamctl upgrade` or `pnpm install` |
| `CONFIG_INVALID` | bad `streamctl.config.ts`, malformed `preset.json`/`package.json`, or an invalid knob | fix the offending file/value (the `details.path` names it) |
| exit `2` (`CONFLICTS_PENDING`) | a `full` file you edited, a marker/merge/structural fault, or a dirty owned path | review the plan; `sync --interactive` to confirm, or `--force` to accept |
| exit `3` (`DRIFT_DETECTED`) | the working tree drifted from the payload (CI gate) | run `streamctl sync` and commit |
| `REGISTRY_AUTH_FAILED` | cannot read the payload from GitHub Packages | check the token's `read:packages` scope |

For the full exit-code table, the operational contract, the upgrade transaction, and known caveats, see the [reference](docs/reference.md).

## Docs

- [Reference](docs/reference.md): exit codes, contracts, conflict kinds, upgrade transaction, caveats
- [Adoption guide](docs/adoption.md)
- [Release process](docs/release.md)

## Contributing

Contributions are welcome. See the [contributing guide](.github/CONTRIBUTING.md) for bug reports, feature requests, and the pull-request workflow. Security vulnerabilities go to the [security reporting guide](SECURITY.md), never the issue tracker. For everything else, [join our Discord](https://discord.gg/NDDgQkcv3s).
