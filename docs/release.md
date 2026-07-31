# Release runbook (`@sidebase/streamctl`)

> **Status: `0.1.0` is on the registry, published by hand.** The `Release on NPM`
> workflow (`.github/workflows/release.yml`) has never published. It triggers on
> a published GitHub Release, so the deliberate human step is publishing that
> release. One setup item below is outstanding.

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

There is **no publish secret**. The workflow authenticates to npm with the OIDC
token minted by `id-token: write`, the same tokenless setup as
`sidebase/ssm-secrets` and `sidebase/nuxt-auth`. That means nothing to leak or
rotate, but it does mean npm has to be told which workflow is allowed to publish.

1. **npm org / scope.** Done. The `@sidebase` org exists and owns
   `@sidebase/streamctl`. `publishConfig.access` is already `public`.
2. **Trusted publisher.** **Outstanding, and the only thing blocking a release.**
   On npmjs.com, package settings for `@sidebase/streamctl`, add a trusted
   publisher: repository `sidebase/streamctl`, workflow `release.yml`. Without it
   the run reaches the publish step and fails on auth. Provenance additionally
   requires the repository to be **public**, which it is.

No `release` environment and no required reviewers, matching the sibling repos.
Publishing the GitHub Release is the human decision point.

## Cutting a release

The tag drives everything, so the version lands in `main` first and the release
publishes it.

1. Bump `package.json` to `X.Y.Z` on a branch, and merge it to `main`.
2. Tag that commit and push the tag:

   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
   ```

3. Create the GitHub Release for `vX.Y.Z` and **publish** it. A draft does not
   trigger anything; publishing is what starts the workflow.

   ```sh
   gh release create vX.Y.Z --title vX.Y.Z --generate-notes
   ```

Publishing the release runs the workflow, which checks out the tag, refuses if
the tag and `package.json` version disagree, runs `typecheck` → `test` → `lint`
→ `build`, then `publint` and `attw --pack . --profile esm-only`, then publishes
with `npm publish --provenance --access public`. A `vX.Y.Z-rc.1`-style tag
publishes under the `next` dist-tag instead of `latest`.

Afterwards, verify the tarball on npm and that the provenance attestation is
attached.

`--generate-notes` diffs against the previous tag, so every release needs its
predecessor tagged or the notes cover the whole history. **`0.1.0` was published
outside this workflow and left no tag.** `v0.1.0` has since been backfilled onto
`265809b` (`chore: bump deps (#6)`), the last commit carrying that version, so
the next release diffs against the right point. Nothing else needs backfilling.

Nothing is published until the release is, and a failed run leaves the tag and
release in place, so a fix plus a re-publish of the same release re-runs it.

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
