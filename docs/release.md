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
`5`), not the package version. A CLI accepts a set of versions — `{2, 3, 4, 5}` today —
exported at the `./manifest` subpath as `SUPPORTED_SCHEMA_VERSION` (the current
one) plus `SUPPORTED_SCHEMA_VERSIONS` (the accepted set). Adding a version is a
minor when older ones keep parsing, **a major once one is dropped**; either way
the supporting CLI ships before any payload adopts it.

The config file's `version` pin governs the payload package only. `upgrade` moves
that pin and leaves the CLI version alone. The CLI and the payload release on
their own schedules: **no lockstep and no shared version number**, which is why
`init` writes the two devDep pins from separate values.

The `--json` envelope is append-only: new fields, never renamed or removed, so
consumer CI survives upgrades. Use Conventional Commit subjects, with `!` for
anything that moves that envelope, the exit codes, or `schemaVersion`.

## Notes for the next release

Generated notes only cover commit subjects, so add these by hand.

- **Manifest schemaVersion 5: template directives.** Templates and fragments can
  wrap lines in `streamctl:if <cond>` / `streamctl:else <cond>` /
  `streamctl:end <cond>` comments; inactive branches and all directive lines are
  removed at render. See [template directives](reference.md#template-directives).
- **Placeholder `join: "comma"`** (schemaVersion 5): a `string[]` knob renders as
  `a, b, c`, e.g. for YAML flow sequences like `branches: [${BRANCHES}]`. No
  shell-metacharacter check in this mode; use the placeholder `pattern`. Gate
  constant `COMMA_JOIN_MIN_SCHEMA_VERSION` is exported from `./manifest`.
- `scanDirectives`, `commentSyntaxFor` and `DIRECTIVES_MIN_SCHEMA_VERSION` are
  exported from `@sidebase/streamctl/manifest`; `SUPPORTED_SCHEMA_VERSION` is now 5.
- Chain resolution now reads and scans every template and fragment source,
  including files that are `off` or disabled by `enabledBy`. A payload missing a
  template source therefore fails every command up front, not only when the file
  is active.
- `init` loads the `streamctl.config.ts` it just scaffolded and runs the first sync
  with it, so payload wrapper defaults apply right away. If the file cannot be
  loaded, `init` prints a one-line warning and falls back to package, base,
  version and profile only, as before.
- Indent-aware substitution: continuation lines of a multiline placeholder value
  get the token line's indentation. Not gated; tokens at column 0 render as before.
- Placeholders are resolved and pattern-checked only when their token is reachable
  from the rendered text, directly or through another placeholder's value. A
  declared placeholder whose token is unused (or sits in a dropped directive block)
  no longer fails the render. Nested values resolve one level per substitution pass;
  the 10-pass cap is unchanged.
- v2 to v4 payloads parse unchanged; directives need `schemaVersion: 5` and this
  CLI or newer.
- Minor bump: new schema version, no removals.
