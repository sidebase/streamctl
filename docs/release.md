# Release runbook (`@sidebase/streamctl`)

> **Status: 0.1.0 is on the registry.** The `Release` workflow
> (`.github/workflows/release.yml`) stays `workflow_dispatch`-only and gated behind
> the protected `release` environment, so every publish is a deliberate manual
> dispatch by a maintainer who has completed the one-time setup below.

`streamctl` publishes to the public npm registry under the `@sidebase` scope. It
is an intentionally ESM-only package; the published tarball ships only `dist/`.

## Compatibility contract: `schemaVersion`

What couples the CLI to a payload is the payload manifest's integer
**`schemaVersion`** (currently `2`), not the package version.

- A CLI major supports exactly one `schemaVersion`. The supported value is exported
  at the CLI's `./manifest` subpath — the same zod schema a payload validates its
  presets against.
- If the running CLI does not support a payload's `schemaVersion`, the user gets a
  dedicated "payload requires a newer/older streamctl" error rather than a generic
  `CONFIG_INVALID`. The loader leaves room for per-version migrations later.
- The config file's `version` pin governs the payload package only, and
  `CONFIG_VERSION_MISMATCH` compares the installed payload against that pin.
  `upgrade` moves the payload pin and its devDep, and leaves the CLI version alone.

**Bumping `schemaVersion` is a CLI major.** Ship a CLI major that supports the new
schema before any payload adopts it, or existing installs break.

## How `--version` is produced

The CLI's `--version` is injected at build time from `package.json`
(`build.config.ts` rollup replace of the `__STREAMCTL_VERSION__` token). Set the
version, then build, then publish — the workflow already orders these correctly.
The JSON envelope (`--json`) is **append-only** (new fields, never renamed or
removed) so consumer CI that parses it survives CLI upgrades.

## One-time setup

Done as of `0.1.0`. Kept as a record of what the release path depends on, and as
the checklist to re-run if the org, token or environment is ever rebuilt.

1. **npm org / scope.** Create/claim the `@sidebase` org on npmjs.com and add the
   release machine account. Confirm the package name `@sidebase/streamctl` is free
   (or owned). `publishConfig.access` is already `public` in `package.json`.
2. **Token / secret.** Mint an npm **automation** token (bypasses 2FA for CI) with
   publish rights on `@sidebase`, and store it as the `NPM_TOKEN` secret **on the
   protected `release` environment** (not repo-wide). The workflow uses OIDC
   (`id-token: write`) for `--provenance`; provenance additionally requires the
   repository to be **public**.
3. **Environment protection.** Add required reviewer(s) to the `release`
   environment so a dispatch pauses for approval before publish.

## Cutting a release

Dispatch the `Release` workflow with the target `X.Y.Z` (no leading `v`) and
approve the environment gate. The workflow:

1. Refuses if the `vX.Y.Z` tag already exists on origin.
2. Sets `package.json` version to the input, then runs the full gate:
   `typecheck` → `test` → `lint` → `build`, then `publint` and
   `attw --pack . --profile esm-only`.
3. Commits `release: vX.Y.Z` and an annotated `vX.Y.Z` tag.
4. Publishes with `pnpm publish --access public --provenance`.
5. Pushes the release commit + tag to `main` **only after** a successful publish,
   so a failed publish leaves origin untouched.
6. Creates a GitHub Release for the tag with notes generated from the commit
   subjects since the previous tag (`gh release create --generate-notes`).

After the run, verify the published tarball on npm, the `vX.Y.Z` tag, and the
generated GitHub Release notes.

Step 6 diffs against the previous tag, so every release needs its predecessor
tagged or the notes cover the whole history. **`0.1.0` was published outside this
workflow and left no tag.** `v0.1.0` has since been backfilled onto
`265809b` (`chore: bump deps (#6)`), the last commit carrying that version, so
the next release diffs against the right point. Nothing else needs backfilling.

The version is an input, not something you edit first. Do not bump
`package.json` by hand before dispatching: step 2 sets it, and a pre-bumped
working tree just means the release commit contains no version change.

## Notes for the next release

Include these in the release notes; the rest is generated from commit subjects.

- **The config file's default location moved** to `streamctl.config.ts` at the repo
  root. `init` writes it there.
- **`.streamctl/config.*` keeps working, permanently.** Not deprecated, no warning,
  no removal planned. Existing repos need to do nothing. A repo that *does* move its
  config needs this CLI version or newer.
- **One breaking edge:** a config at `.config/.streamctl/config.ts` resolved before
  this release and does not now — it raises `NOT_INITIALIZED`. Measured against
  c12 3.3.4: the old `configFile: ".streamctl/config"` spelling made c12 probe
  `.config/.streamctl/config`, and the new spelling does not. The form is
  undocumented and nested, so realistically nobody is on it, but the fix is one
  command:

  ```sh
  git mv .config/.streamctl/config.ts streamctl.config.ts
  ```

  Nothing else under `.config/` is read by streamctl, before or after this release.

  The affected population is narrower than it reads: below c12 3.2.0 there is no
  `_configFile`, so the old loader raised `NOT_INITIALIZED` from any location. A
  repo on this layout was only ever working if its tree resolved c12 >= 3.2.0.
  The `git mv` is worth doing either way, so the instruction above is not
  conditional on that.
- **New warning:** two extensions of the same config at one location
  (`streamctl.config.js` next to `streamctl.config.ts`) now warn on stderr that one is
  *shadowed by* the other, naming the one being read. c12's order puts `.js` ahead of
  `.ts`, which surprises most people. **Nothing is read differently than before** — this
  is a new diagnostic, not new behaviour, so a repo that sees it needs no migration.
- Minor bump: new default, no removals.

Use Conventional Commit subjects (and `!` / `BREAKING CHANGE:` for anything that
moves the `--json` envelope, exit codes, or the manifest `schemaVersion`) so the
history reads clearly for consumers.
