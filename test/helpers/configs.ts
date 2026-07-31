/**
 * A config whose module body touches the filesystem when evaluated. Writing the sentinel
 * is the only observable difference between "this file was read" and "this file was
 * loaded", which is what both the resolver and the loader need to prove.
 *
 * A test using this must also prove the fixture is not inert — a body that silently
 * fails to write would make every "did not evaluate" assertion pass for the wrong
 * reason. See `test/resolve.test.ts`'s proof phase for the pattern.
 */
export function sideEffectConfig(sentinel: string, defaultExport = "{}"): string {
  return `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "");\nexport default ${defaultExport}\n`;
}

/**
 * A valid config body, for callers that reach validation. `sideEffectConfig`'s default
 * `{}` fails it — fine for the resolver, which never validates, but a loader-level test
 * needs a config that survives the whole pipeline or it fails before proving anything.
 */
export const VALID_BODY = `{ package: "@acme/payload", base: "nuxt-app", version: "1.2.3", profile: "nuxt-4" }`;
