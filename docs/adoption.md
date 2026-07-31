# streamctl adoption runbook

How to adopt a repo onto a streamctl preset payload, wire up the CI drift gate,
converge versions and roll back. streamctl is payload-agnostic: it reads whatever
package you pass to `--package`. The examples below use `@your-org/config` as the
payload, so substitute your own. Adopt brownfield repos one at a time, smallest
blast radius first.

## Prerequisites

- Read access to your payload package's registry. If it is published to a private
  registry (e.g. GitHub Packages), supply the token in `NODE_AUTH_TOKEN` (scope
  `read:packages`); a payload on public npm needs no token. `init` scaffolds the
  `.npmrc` registry block as a managed file when required.
- Node `^22.22.2 || ^24.15.0 || >=26` (the CLI floor) and a supported package
  manager (npm / pnpm / yarn / bun).

## Phased migration

This order keeps the blast radius small:

1. Pilot: adopt one repo end to end and prove CI stays green.
2. Smallest diff first: land any pure code swaps the payload calls for (e.g. lint
   or build-tool factory imports) before the first file-sync.
3. Roll out: repeat for the remaining repos, one at a time.
4. Converge versions: enable `versionSync` to pull every repo onto the profile
   baseline, and record the opt-outs you had to make.
5. Rollback: every step lands as a reviewable PR, so undoing one is a `git revert`.

## 1. `init`

```sh
pnpm dlx @sidebase/streamctl init --package @your-org/config     # interactive
# or non-interactive, accepting detected defaults:
pnpm dlx @sidebase/streamctl init --package @your-org/config --yes
```

`init` detects the Nuxt major from `package.json` and proposes `base: "nuxt-app"`
+ `profile: "nuxt-4"`. It then:

- writes `streamctl.config.ts` at the repo root (the pinned `version` + your knobs),
- scaffolds the `.npmrc` registry block (incl. `always-auth=true`),
- adds the `@sidebase/streamctl` + your payload (`@your-org/config`) + `jiti`
  devDependencies and runs the install (so the preset payload lands on disk),
- scaffolds `eslint.config.ts` + `prisma.config.ts` wrappers **only if absent**
  (existing files are never overwritten),
- chains into the first `sync`.

Overrides: `--base <nuxt-app|base>`, `--profile <nuxt-4|nuxt-3>`. If the Nuxt major can't
be detected and no `--profile` is given, `init` fails with `PROFILE_DETECT_FAILED`.

## 2. Interactive first `sync`

The first sync against a brownfield repo is large. Review it file-by-file:

```sh
pnpm streamctl sync --interactive
```

On a real TTY you get a per-file accept/skip prompt; in CI / piped contexts it
degrades to a deterministic, greppable `[plan] <kind> <path>` on stderr and
applies the headless policy (no hang). Use `--only <glob>` to stage the rollout
(e.g. `--only 'eslint.config.ts'` first), and `--dry-run` to preview without
writing.

### Reconcile guidance: what the prompts mean

streamctl owns the content inside `BEGIN/END streamctl MANAGED BLOCK <mark>`
markers, plus any full file it manages. The markers say so in the file itself: the
region is managed and will be overwritten on the next sync. Keep your edits
outside them.

| Change kind | What it is | Default (headless) behavior |
| ----------- | ---------- | --------------------------- |
| `create` | File is absent | Written (clean add) |
| `reconcile` | A `block`/`merge` difference: only the streamctl-owned region/keys change | Written; your out-of-region lines and project fields are preserved |
| `conflict` | A `full`-file difference: you edited streamctl-owned content | **Skipped** and reported; nothing is written |

A `conflict` means owned content was hand-edited. Either move your change out of
the managed file, or accept the preset version with `--force` or `accept` in
`--interactive`. An unresolved conflict makes `sync` exit `2`
(`CONFLICTS_PENDING`) and the conflicting files are left untouched.

The `scaffold` wrappers (`eslint.config.ts`, `prisma.config.ts`) are written only
if absent. After that they are never drift-checked or re-prompted, so your local
customizations are safe.

## 3. Wire `streamctl check` into CI (the drift gate)

```yaml
# .github/workflows/ci.yaml
- run: pnpm streamctl check        # default: --fail-on drift
```

`check` is read-only. It recomposes the expected content and diffs it against the
working tree, reconciles the version allow-list without writing, and probes for a
newer release only under `--fail-on outdated|any`. The threshold flag is
`--fail-on <drift|outdated|any>` and defaults to `drift`. Add `--json` for machine
output.

### Exit codes

| Code | Meaning | Emitted by |
| ---- | ------- | ---------- |
| `0` | In sync / success | all |
| `2` | `CONFLICTS_PENDING`: owned content edited; resolve or `--force` | `sync`, `upgrade` |
| `3` | `DRIFT_DETECTED`: files drifted or versions skewed | `check` (`--fail-on drift\|any`) |
| `4` | `OUTDATED`: a newer release than the pin is published | `check` (`--fail-on outdated\|any`) |

The default `drift` gate stays **offline** (no registry call) so CI is fast and
deterministic.

## 4. Version convergence (`versionSync`)

`sync` and `check` reconcile a fixed version allow-list against the active profile
baseline: `engines.*`, `packageManager`, a small set of `devDependencies`, and any
`scripts.*` the baseline declares (e.g. `postinstall`, `lint`). A baseline-declared
script is a plain **overwrite**: unlike a version pin it has no forward floor (a
script is not a semver), so it replaces whatever the repo has — opt out per-key with
`versionSyncExclude`. Everything the baseline does not list (`vue`, `tailwindcss`,
app deps, your own scripts) is project-owned and never touched.

Disable globally or per-key in `streamctl.config.ts`:

```ts
export default {
  base: "nuxt-app",
  version: "1.2.3",
  profile: "nuxt-4",
  versionSync: false,                              // opt out entirely
  versionSyncExclude: ["devDependencies.typescript"], // or per allow-list key
};
```

When a single repo has to hold one pin back, reach for `versionSyncExclude` rather
than turning `versionSync` off wholesale, and record why (a comment in
`streamctl.config.ts` or the PR description). An exclude entry that is not an
active allow-list key is rejected with `CONFIG_INVALID`.

## 5. `upgrade` (moving the pin forward)

`upgrade` is the only command that moves the pinned `version`:

```sh
pnpm streamctl upgrade            # to the latest published release
pnpm streamctl upgrade --to 1.4.0 # to an explicit version
pnpm streamctl upgrade --dry-run  # resolve target + intended bumps, write nothing
```

It resolves the target first (`NO_NEWER_VERSION` if you are already on the latest,
`TARGET_NOT_FOUND` if `--to` names an unpublished version), bumps the
config-file pin and the payload devDep in lockstep, runs the install,
then runs `sync`, interactive by default. Review the diff and commit. A `--dry-run`
issued before the new presets are installed prints `preview unavailable:
<version> presets not installed` instead of a misleading empty plan.

## 6. Rollback

Every adoption and upgrade step is a single reviewable PR, so undoing one is a
`git revert` of that commit. The `version` pin makes composition deterministic, so
a later `sync` reproduces the same managed bytes and re-adoption lands where you
left off. Try the revert on a branch first, before you need it in anger.

## Read-only E2E gate

`pnpm e2e:dry-run` (in CI: `.github/workflows/e2e-dry-run.yml`) builds the CLI and
runs `init --no-install`, `check` and `sync --dry-run` against the synthetic
`@acme/payload` fixture on every package manager. It asserts that the read-only
commands exit cleanly and write nothing to the scratch repo's tracked tree.
