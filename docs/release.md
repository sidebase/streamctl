# Release runbook (`@sidebase/streamctl`)

> **`0.1.0` is on npm, published by hand.** The `Release on NPM` workflow has
> never run. One setup item below still blocks it.

ESM-only, published public under the `@sidebase` scope, tarball ships only `dist/`.

## Blocking: register the trusted publisher

There is no publish secret. The workflow authenticates with the OIDC token from
`id-token: write`, the same tokenless setup as `sidebase/ssm-secrets` and
`sidebase/nuxt-auth`. npm still has to be told which workflow may publish.

On npmjs.com, package settings for `@sidebase/streamctl`, add a trusted publisher
for repository `sidebase/streamctl`, workflow `release.yml`. Until then a run
fails at publish on auth, having changed nothing.

## Cutting a release

From `main`, up to date. `npm version` bumps `package.json`, commits it with the
bare version as the subject, and tags that commit, so the bump and the tag cannot
drift apart.

```sh
npm version minor          # or patch / major
git push --follow-tags
gh release create vX.Y.Z --title vX.Y.Z --generate-notes
```

Then **publish** the release. A draft triggers nothing.

The bump commit goes straight to `main`, no PR, matching `sidebase/ssm-secrets`
and `sidebase/nuxt-auth`.

Publishing runs the workflow: checks out the tag, refuses if the tag and
`package.json` version disagree, runs `typecheck` / `test` / `lint` / `build`
plus `publint` and `attw`, then `npm publish --provenance`. A `vX.Y.Z-rc.1` tag
goes to the `next` dist-tag instead of `latest`.

Nothing ships until you publish the release, and a failed run leaves the tag and
release intact, so re-publishing the same release re-runs it. Afterwards, check
the tarball on npm and that provenance is attached.

Two things worth knowing:

- `--generate-notes` diffs against the previous tag. That is why `v0.1.0` was
  backfilled onto `265809b`; nothing else needs backfilling.
- `--version` is baked in at build time from `package.json`, so a tag that
  disagrees would ship a CLI that misreports itself. Hence the check.

## Versioning

What couples the CLI to a payload is the manifest's `schemaVersion` (currently
`2`), not the package version. A CLI major supports exactly one, exported at the
`./manifest` subpath. **Bumping it is a CLI major**, and the supporting CLI has
to ship before any payload adopts it.

The config file's `version` pin governs the payload package only. `upgrade` moves
that pin and leaves the CLI version alone. The CLI and the payload release on
their own schedules: **no lockstep and no shared version number**, which is why
`init` writes the two devDep pins from separate values.

The `--json` envelope is append-only: new fields, never renamed or removed, so
consumer CI survives upgrades. Use Conventional Commit subjects, with `!` for
anything that moves that envelope, the exit codes, or `schemaVersion`.

## Notes for the next release

Generated notes only cover commit subjects, so add these by hand.

- **The default config location moved** to `streamctl.config.ts` in the repo
  root. `init` writes it there.
- **`.streamctl/config.*` keeps working, permanently.** Not deprecated, no
  warning, no removal planned. Existing repos need to do nothing.
- **One break:** `.config/.streamctl/config.ts` used to resolve through c12's
  `.config/` convention and now raises `NOT_INITIALIZED`. Fix:

  ```sh
  git mv .config/.streamctl/config.ts streamctl.config.ts
  ```

  Nothing else under `.config/` was ever read. Realistically nobody is affected:
  the layout is undocumented, and it only ever worked on trees resolving
  c12 >= 3.2.0.
- **New warning:** two extensions at one location (`streamctl.config.js` beside
  `streamctl.config.ts`) now warn on stderr which one is being read, since c12
  orders `.js` ahead of `.ts`. Nothing is read differently than before, so a repo
  that sees it needs no migration.
- Minor bump: new default, no removals.
