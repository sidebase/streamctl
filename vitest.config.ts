import { defineConfig } from "vitest/config";

// Scope discovery to `test/` so vitest never globs untracked working copies
// sitting at the repo root.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
