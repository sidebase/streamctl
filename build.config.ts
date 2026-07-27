import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineBuildConfig } from "unbuild";
import { z } from "zod";

// Single source of version truth. Read package.json at build time and
// substitute the `__STREAMCTL_VERSION__` token in src/main.ts's `--version`
// string, so no hand-maintained literal can drift from the published version
// and src/ never has to import package.json.
const { version } = z.object({ version: z.string() }).parse(
  JSON.parse(readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8")),
);

export default defineBuildConfig({
  entries: ["src/index", "src/cli", "src/manifest/index"],
  declaration: true,
  clean: true,
  replace: {
    // Flat key→value form (unbuild merges its own `preventAssignment: true`). The
    // value is injected verbatim between the token's surrounding quotes, so it is
    // the bare version (no extra quoting) → `version: "0.1.0"`. A distinctive token
    // avoids colliding with ordinary identifiers in the bundled sources.
    __STREAMCTL_VERSION__: version,
  },
});
