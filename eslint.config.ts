import antfu from "@antfu/eslint-config";
import importX from "eslint-plugin-import-x";

/**
 * Lint config for the @sidebase/streamctl CLI repo itself: a minimal
 * `@antfu/eslint-config` for a TypeScript library + Node CLI, with stylistic
 * options matching the house style (double quotes, semicolons).
 */
export default antfu({
  type: "lib",
  typescript: true,
  vue: false,
  jsonc: false,
  yaml: false,
  markdown: false,
  stylistic: {
    indent: 2,
    quotes: "double",
    semi: true,
  },
  rules: {
    // Repo conventions: use the global `process`/`Buffer` (no import), skip the
    // perf-nudge static-regex rule, allow function hoisting, and keep
    // capture-groups-for-grouping (the validated regexes use them deliberately).
    "node/prefer-global/process": ["error", "always"],
    "node/prefer-global/buffer": ["error", "always"],
    "e18e/prefer-static-regex": "off",
    "regexp/no-unused-capturing-group": "off",
    "ts/no-use-before-define": ["error", { functions: false }],
    // House style: `} else` on the same line (antfu defaults to stroustrup).
    "style/brace-style": ["error", "1tbs", { allowSingleLine: true }],
    // Test titles legitimately start with an identifier/upper-case (e.g. a type name).
    "test/prefer-lowercase-title": "off",
  },
  ignores: [
    "**/dist/**",
    "**/node_modules/**",
    "**/*.snap",
    // Fixtures carry intentionally malformed or off-style content, and the
    // synthetic @acme/payload preset tree follows its own conventions.
    "test/fixtures/**",
    // Scratch directories, never linted.
    "local.*/**",
  ],
}).append({
  // Tests intentionally embed ANSI escapes (color stripping) and GitHub Actions
  // `${{ … }}` expression literals inside plain strings.
  files: ["**/*.test.ts"],
  rules: {
    "no-control-regex": "off",
    "no-template-curly-in-string": "off",
  },
}).append({
  // Enforce an acyclic import graph mechanically. antfu ships
  // `eslint-plugin-import-lite`, which has no graph analysis, so `import-x` is
  // added just for `no-cycle`. Scoped to `src/`: that's the layered
  // engine/manifest/command graph; test/ + scripts/ are flat and exempt. The TS
  // resolver lets the rule follow extensionless `.ts` imports.
  name: "streamctl/no-import-cycles",
  files: ["src/**/*.ts"],
  plugins: { "import-x": importX },
  settings: {
    // no-cycle must both RESOLVE extensionless `./x` → `x.ts` and PARSE the resolved
    // `.ts` dependency (to follow its imports for the back-edge). The TS resolver
    // handles the former; `import-x/parsers` + `.ts` extensions the latter.
    "import-x/resolver": { typescript: { project: "./tsconfig.json" } },
    "import-x/parsers": { "@typescript-eslint/parser": [".ts"] },
    "import-x/extensions": [".ts", ".js"],
  },
  rules: {
    "import-x/no-cycle": ["error", { maxDepth: Infinity, ignoreExternal: true }],
  },
});
