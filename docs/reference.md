# Reference

The contracts behind the CLI: exit codes, the rules `sync` and `check` follow, how conflicts are classified, structured-file safety, the `upgrade` transaction and the caveats worth knowing. For day-to-day usage see the [README](../README.md).

## Exit codes

Mapped in `src/exit-codes.ts`; success (`0`) is emitted by the reporter.

| Exit | Code | Meaning |
| ---- | ---- | ------- |
| `0` | none | Success / no-op |
| `1` | _any other actionable error_ | e.g. `NOT_INITIALIZED`, `CONFIG_INVALID`, `PAYLOAD_INVALID`, `SCHEMA_UNSUPPORTED`, `CONFIG_PKG_MISSING`, `CONFIG_VERSION_MISMATCH`, `REGISTRY_AUTH_FAILED`, `WRITE_FAILED`, `INSTALL_FAILED`, `ROLLBACK_FAILED`, `NOT_A_REPO`, `ALREADY_INITIALIZED`, `PROFILE_DETECT_FAILED`, `NO_NEWER_VERSION`, `TARGET_NOT_FOUND` |
| `2` | `CONFLICTS_PENDING` | `sync` hit an unresolved conflict: a `full`-file edit, a marker/merge fault, a structural fault, or the dirty-tree guard. Re-run with `--force` or `--interactive`. Under `upgrade` this also rolls the bump back (`rolledBack: true`, conflict `plan` in `details`) |
| `3` | `DRIFT_DETECTED` | `check` found file drift, version skew, or a structural fault |
| `4` | `OUTDATED` | `check --fail-on outdated\|any` and a newer release is published |

A **structural fault** (composed `.json*`/`.ya?ml` output that does not parse) surfaces as exit `3` under `check` (it makes `inSync` false, so `DRIFT_DETECTED`) and as exit `2` under `sync` (a hard conflict that blocks the write; `--force` cannot fix invalid output).

Loading the payload can fail in two ways, both of which exit `1`:

- `PAYLOAD_INVALID`: the installed package is not a streamctl payload. Its `presets/manifest.json` is missing, unreadable or not JSON, or a preset the manifest lists has no `preset.json`.
- `SCHEMA_UNSUPPORTED`: the payload's `manifest.json` declares a `schemaVersion` this CLI does not understand. That is a CLI/payload compatibility break, so upgrade one side or the other.

`upgrade` adds one more exit-`1` code. `ROLLBACK_FAILED` means a transactional rollback could not restore a snapshotted file and the repo needs a manual `git restore`. The message and the `details` payload (`restore[]`, `failed[]`, `recover`, `perFile[]`) name the exact files and the recovery command.

### JSON envelope

With `--json`, both success and failure print an envelope:

```json
{ "ok": true, "command": "...", "data": {}, "error": { "code": "...", "message": "...", "details": {} }, "exitCode": 0 }
```

`data` is present on success, `error` on failure.

## Operational contract

> **CI runs `check`; humans run `sync --interactive`.**

CI uses `streamctl check`, the read-only gate, and never runs `sync`. Humans run `streamctl sync --interactive` and confirm each conflict before it overwrites anything.

Run non-interactively, `sync` is still conflict-safe. A `full`-file conflict, meaning the consumer edited streamctl-owned content, aborts with exit `2` and overwrites nothing. Safe `block`/`merge` reconciles and clean creates are written as usual.

`--force` is the escape hatch. It accepts every change including `full`-conflicts, and it bypasses the dirty-tree guard. Keep it out of unattended CI.

The dirty-tree guard: if a streamctl-owned path has uncommitted tracked edits, `sync` refuses rather than clobber the work. Commit or stash and re-run, or pass `--force`. Edits to project-owned `scaffold` files only produce a warning.

`sync` is transactional: the managed set is composed and structurally validated before any file is written, so a partial-batch failure writes nothing. Per-file writes are atomic. It is also idempotent, so a second run with no upstream change writes nothing and exits `0`.

## How `init` picks the payload version

The `streamctl.config.ts` `version` pin is the payload's version, never the CLI's. The two
packages release on their own cadence. `init` resolves the pin in this order, before it
writes anything:

1. `--payload-version <version>`, checked against the registry unless the registry is
   off-limits (see below). An unpublished version fails with `TARGET_NOT_FOUND`.
2. The version embedded in a local override value, when the payload is pinned through
   `pnpm.overrides` / `overrides` (`file:/…/payload-1.4.0.tgz` gives `1.4.0`).
3. The latest published release, probed from the registry.

If none of those resolves, `init` fails with `CONFIG_INVALID` naming `--payload-version`.
Nothing has been written at that point, so a retry is never blocked.

`--skip-registry-check` and an override both mean "no registry traffic for this payload",
so neither probe runs. With an override the version is read from its value; without one,
`--payload-version` becomes required.

The `@sidebase/streamctl` devDep is pinned separately, to the version of the CLI that ran
`init`. `upgrade` moves the payload pin only.

## Conflict kinds

Every conflict carries a `kind`, both in the `--json` `conflicted[]` entries and in the grouped human report. It tells you whether you are being asked to adopt a file or to review something you changed:

| `kind` | What it means | What to do |
| ------ | ------------- | ---------- |
| `edit` | A managed file diverged from its target after being in-sync | `sync --interactive` (accept/skip per file), or `sync --force` to overwrite |
| `adoption` | A pre-existing `full` file the payload now manages (declared via the manifest's `adoption` hint). `expected` softens the wording, `unexpected` warns; messaging only, same exit code | `sync --interactive` to adopt per file, `sync --force` to take ownership, or `--only <glob>` to scope |
| `fault` | A structural impossibility (broken block markers, unparseable merge/compose output) | Not fixable with `--force`; fix the payload. `--only <glob>` can skip it meanwhile |
| `dirty` | The dirty-tree guard: an owned path has uncommitted tracked edits | Commit or stash, or re-run with `sync --force` |

The classification is informational. Exit `2` (`CONFLICTS_PENDING`) semantics are unchanged.

## Structured-file safety

`block` is forbidden on structured paths (`.json`, `.jsonc`, `.json5`, `.yaml`, `.yml`), because block's append semantics corrupt a single-root document. A preset that declares `block` on such a path fails to load with `CONFIG_INVALID` (`block strategy is not allowed on structured file ...`). Use `full` or `merge` for those files.

Composed output is also parse-validated before it is written. A `.json*`/`.ya?ml` target whose composed content does not parse counts as a structural fault and never reaches disk (see [Exit codes](#exit-codes)).

`strategy` is a closed set: a value outside `full`/`block`/`merge`/`scaffold` fails at load against the payload's manifest schema (`CONFIG_INVALID`). The old internal `deferred` skip-status was removed, so an unknown strategy can no longer silently fall through.

## Stale-lockfile hint

When the version reconcile edits `package.json` (non-`--dry-run`) and a lockfile exists, the `sync` report appends a one-line hint naming the detected package manager's plain install command (e.g. `pnpm install` / `npm install`), and the `--json` `data` adds `lockfileStale: true`. The hint is informational and never affects the exit code. `sync` does not install anything, so refreshing the lockfile is your job; only `init` and `upgrade` run installs of their own.

`check --json` carries the same `lockfileStale: true` when reconcile drift would edit `package.json` and a lockfile exists (i.e. a `sync` would stale it). Also informational, never exit-affecting.

## The upgrade transaction

`upgrade` is the only command that moves the pinned version forward. Either it applies in full, or it puts the repo back exactly as it was.

The flow runs in this order. Resolve the target, which is the latest published version or whatever `--to` names. Snapshot the three files a failed run could leave inconsistent: the config file (wherever it resolved), `package.json`, and the detected package manager's lockfile. Bump the pin and the payload devDependency, leaving the CLI's own version alone. Install, so the new bundled presets land on disk. Preflight and apply the first `sync` against the new version. Finally, when that sync's version reconcile edited `package.json` and a lockfile exists, install once more so the lockfile matches, without a second prompt.

The preflight comes for free from `sync` being transactional. It composes and validates the whole batch and writes nothing until the batch is clean, so a non-interactive conflict or an invalid new payload throws before any managed file changes.

Any failure after the snapshot rolls back. The three files are restored byte-for-byte and the original error is re-thrown with `rolledBack: true`. If the install had already completed, the rollback re-runs the package manager's install so `node_modules` matches the restored `package.json` again. That reinstall is best-effort: when it fails you get a `node_modules is stale -- run <pm> install` hint and the original error is still preserved. And if the restore itself fails, `ROLLBACK_FAILED` (exit `1`) names the exact files and prints a `git restore` recovery command.

`--no-install` bumps the pin and devDependency but skips the install and the preflight sync. The bump is kept (this path is exempt from rollback); the report tells you to install and run `sync` yourself.

The `--json` `data` adds `rolledBack: boolean` and `plan: { path, kind }[]` (the preflight summary of what the sync would do); on a rolled-back failure, the same `plan` and `rolledBack` ride in the error `details`.

### Upgrading over a payload override

When the payload is pinned through a **local override** (a `pnpm.overrides` / root `overrides` entry pointing at a `file:` tarball or dir), its latest release cannot be resolved from the registry, so `upgrade` requires an explicit `--to <version>`.

Keep the override itself in step. Before `upgrade` bumps or installs anything it reads the override value, and if that value embeds a different version than `--to` (say `file:/.../config-0.1.2.tgz` while you pass `--to 0.1.3`), it fails fast with `CONFIG_INVALID` and tells you to point the override at the `0.1.3` artifact first. It will not rewrite the override for you, since the syntax is package-manager-specific. A version-less override, a bare dir path or a `link:`, is only noted; the post-install version check still catches a real mismatch.

## Status states

Per-file `state` in `streamctl status` is one of:

| State | Meaning |
| ----- | ------- |
| `in-sync` | Matches the composed target |
| `drift` | A `block`/`merge` region a `sync` would reconcile |
| `conflict` | A `full` file that differs |
| `missing` | The managed file does not exist yet |
| `off` | Opted out via `files: "off"` |
| `disabled` | The preset's `enabledBy` condition is false |
| `scaffolded` | A `scaffold` file's steady state (project-owned) |
| `fault` | A structural impossibility |

The `--json` `data` is `{ files: { path, state, strategy }[], payload: { package, pinned, installed, latest? }, profile, cliVersion, lockfileStale }`.

## Template directives

Payload templates and fragments can mark runs of whole lines as conditional. Requires manifest `schemaVersion: 5` (`DIRECTIVES_MIN_SCHEMA_VERSION`). Below schemaVersion 5, `streamctl:` comments are plain content; only a well-formed `if`/`else`/`end` line is detected, to raise the `schema-version` error.

### Grammar

One directive per line: optional indent, the file's comment token, optional spaces, `streamctl:`, the verb, one or more spaces, the condition, and for HTML-comment files optional spaces then `-->`. Nothing else may follow.

```
<token> streamctl:if <condition>
<token> streamctl:else <condition>   (optional, at most one)
<token> streamctl:end <condition>
```

- The condition is `[!]segment(.segment)*`, segments `[A-Za-z0-9_-]+`. `!` negates.
- `else` and `end` repeat the `if` condition byte for byte, `!` included.
- Blocks do not nest. Empty bodies and empty `else` branches are allowed.
- A trailing `\r` is tolerated; every other line is kept byte for byte.
- Only a line that starts (after whitespace) with the comment token and `streamctl:` is a directive. `run: echo "# streamctl:if x"` is content.

### Where directives work

| Comment token | Files |
| ------------- | ----- |
| `#` | YAML, Dockerfile, ignore files, `.editorconfig`, ini, sh, any unknown extension |
| `//` | js, mjs, cjs, ts, mts, cts (json, jsonc and json5 also use `//` but reject directives) |
| `<!-- ... -->` | md, markdown, html, htm, vue |

`full`, `scaffold` and `block` templates accept directives, with or without a `render` definition, as do fragment sources. `.json`, `.jsonc` and `.json5` targets reject them (`structured-json`), and so do `merge` templates (`merge-strategy`). The token is chosen by the target path for templates and by the source path for fragments.

### Pipeline order

1. When the preset chain resolves, every template and fragment source is read and scanned, including files switched off by `files: off` or `enabledBy`. Syntax, placement, schema-version and condition-declaration errors fail every command here.
2. Per active file: the directive pass runs on the template body, then on each fragment body.
3. Fragments are appended (`toggle`, `forEach`).
4. Placeholders are substituted. A `${TOKEN}` inside a dropped block is gone and needs no value: placeholders are only resolved and pattern-checked when their token is reachable from the rendered text.
5. Structured output (`.json*`, `.ya?ml`) is parse-checked.

The directive pass removes every directive line, the `if` branch of a false block and the `else` branch of a true one.

### Condition truthiness

The condition must be declared in the merged `configKeys`, either exactly or under an `object` key (`ci` declared as `object` allows `ci.lint`). Naming the `object` key itself is an error.

| Config value | Result |
| ------------ | ------ |
| `true` | true |
| non-empty string | true |
| array with at least one element | true |
| absent, `false`, `""`, `[]` | false |
| number, object, `null` | `CONFIG_INVALID` (`unevaluable-value`) |

### Placement rules

- `if`, `else` and `end` use identical leading whitespace.
- In `.yaml`/`.yml` targets every non-blank line of both branches starts with the directives' indentation. YAML itself allows comments at any indentation; this is a deliberate lint.
- With `else`, the template must stay valid with both branches present. Alternative list items, Dockerfile instructions, Markdown paragraphs or TS statements are fine. Two versions of the same YAML mapping key are not (the YAML language server flags the duplicate); use a placeholder for key-level variants.

### Reserved namespace

From `schemaVersion: 5`, `streamctl:` right after a comment token is reserved. Prose like `# streamctl: the CLI` is an `unknown-directive` error. The verbs `each`, `insert` and `raw` are reserved for a future version and fail the same way with a hint.

### Errors

Every directive error is `CONFIG_INVALID` (exit `1`), with `details.reason` set to one of the values below.

- Parse and chain-time errors read `presets/<source>:<line>: <sentence>`. `details` carries `file`, `line`, `reason` and, where relevant, `directive`, `condition`, `expected`, `openedAt`, `found`, `required`.
- `undeclared-condition` uses the message shared with placeholders and `enabledBy`: `template "presets/<source>" line N references config path "...", which no preset declares in configKeys.` (`fragment "..."` for fragments). `details` carries `path`, `declared`, `file`, `line`, `condition`, `reason`.
- `unevaluable-value` is raised at render time against the target path: `<target>: condition "..." has a <type> value in the config, ...`. `details` is `{ file, condition, reason, found }`, without `line`.

| `reason` | Meaning |
| -------- | ------- |
| `unknown-directive` | Verb is not `if`, `else` or `end` (reserved verbs get a hint) |
| `missing-condition` | Directive without a condition |
| `malformed-condition` | Condition fails the grammar, extra text on the line, or missing `-->` |
| `unopened-end` | `end` with no open block |
| `unopened-else` | `else` with no open block |
| `duplicate-else` | Second `else` in one block |
| `unclosed-if` | `if` without `end` before the end of the text |
| `end-mismatch` | `end` names a different condition than the open `if` |
| `else-mismatch` | `else` names a different condition than the open `if` |
| `nested-if` | `if` while another block is open |
| `indent-mismatch` | `else` or `end` indented differently from its `if` |
| `body-outdented` | YAML only: a body line indented less than the directives |
| `structured-json` | Directive in a `.json`/`.jsonc`/`.json5` target |
| `merge-strategy` | Directive in a `merge` template |
| `schema-version` | Well-formed directive present but the manifest declares `schemaVersion` below 5 |
| `undeclared-condition` | Condition not declared in any preset's `configKeys` |
| `object-condition` | Condition names an `object` key exactly |
| `unevaluable-value` | At render: the consumer config holds a number, object or `null` at the condition |

Payload tooling can list a template's blocks with `scanDirectives(text, path)` from `@sidebase/streamctl/manifest`.

### Caveats

- `scaffold` files evaluate directives once, when they are written. Later config changes do not touch them.
- Dockerfile parser directives (`# syntax=`, `# escape=`) must stay the first lines. Docker stops looking for them after the first ordinary comment, so put streamctl directives after them. A block inside a `RUN \` continuation must not hold the line that ends the continuation: dropping it leaves a dangling `\`.
- Inside a YAML block scalar (`run: |`) a `# streamctl:if` line is string content to YAML but still a directive to streamctl. It is removed before YAML parses the output.
- Flipping a knob that changes a block in a `full` file is a render change like any other: `check` reports drift (exit `3`), `status` shows the file as `conflict`, and `sync` blocks it as an `edit` conflict until you resolve it with `--interactive` or `--force` (see [Known caveats](#known-caveats)).

### Indent-aware substitution

A multiline placeholder value takes the indentation of the line holding its token: continuation lines get that line's leading whitespace, empty continuation lines stay empty. Tokens at column 0 render as before. This is not gated by `schemaVersion`.

```yaml
run: |
  ${SCRIPT}
```

With `SCRIPT` = `"pnpm lint\npnpm test"` this renders both commands at the `run` body's indentation.

### Placeholder join modes

A `string[]` placeholder value is deduped and sorted alphabetically (not config order), then joined per `join`:

| `join` | Separator | Shell-metacharacter check | Needs `schemaVersion` |
| --- | --- | --- | --- |
| `space` (default) | `" "` | yes, per item | 2 |
| `lines` | `"\n"` | no | 2 |
| `comma` | `", "` | no | 5 |

The metacharacter check rejects whitespace and `` ; | & $ ` < > ( ) { } \ ' " * ? [ ] `` in each item, because space-joined values typically land in an unquoted shell interpolation. `comma` targets YAML flow sequences such as `branches: [${BRANCHES}]` and skips it, so `release/*` passes; guard it with the placeholder `pattern`, which is tested against the whole joined value in every mode.

## Known caveats

**Type-aware lint needs generated types first.** With `LINT_TYPEAWARE=true`, the Prisma client and the Nuxt types have to exist before `lint` (and `typecheck`) runs, so run `prisma generate` and `nuxi prepare` first. The managed `ci.yaml` already orders `prisma generate` ahead of `lint`, and `postinstall: "nuxt prepare"` covers local installs. There is no preflight check for this.

Local-tarball adoption skips `init`'s registry probe. If a `pnpm.overrides` or root `overrides` entry already resolves the payload package, an auth probe against the registry proves nothing, so `init` skips it. `--skip-registry-check` is still there for other setups.

**Payload content that changes under the same version shows up as an `edit` conflict.** Drift is derived and there is no state file, so sync cannot tell a repacked local tarball apart from a local edit. It blocks and asks for review (`--interactive` or `--force`). Fleet updates are better carried by a version bump and `streamctl upgrade`, where the preflight previews the change for you.

Config changes hit the same wall. Edit a `streamctl.config.ts` knob that feeds a `full`-strategy render (placeholders, fragment toggles) and the next `sync` reports the render delta as `edit`/`adoption` conflicts and exits `2`. Resolve with `sync --interactive`, `sync --force` or `--only <glob>`. `block`/`merge` reconciles are unaffected. A rendered-content baseline would remove this friction, and may show up later.

**The shipped ESLint wrapper is not a drop-in for a complex repo.** A bare `createStreamctlEslint()` lints everything, scratch and artifact directories included. Real adopters chain their own ignores onto it: `createStreamctlEslint().append({ ignores: ["scratch/**", /* ... */] })`.

The Node `engines` floor is inherited. `^22.22.2 || ^24.15.0 || >=26.0.0` copies `write-file-atomic@8`'s own `engines` requirement verbatim, because that atomic-write dependency is what sets the real floor. Relaxing streamctl's range below it would just move the install warning down to the dependency.
