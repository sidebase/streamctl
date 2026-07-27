# Release runbook (`@sidebase/streamctl`)

> **Status: PARKED.** Nothing is published yet. The `Release` workflow
> (`.github/workflows/release.yml`) is a `workflow_dispatch`-only draft gated
> behind the protected `release` environment. It cannot publish anything until a
> maintainer completes the one-time setup below and dispatches it by hand.

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
- The `.streamctl/config.ts` `version` pin governs the payload package only, and
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

Use Conventional Commit subjects (and `!` / `BREAKING CHANGE:` for anything that
moves the `--json` envelope, exit codes, or the manifest `schemaVersion`) so the
history reads clearly for consumers.
