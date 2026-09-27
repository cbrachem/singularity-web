import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "tools",
    environment: "node",
    include: ["**/*.test.ts"],
    // These gates spawn ruff, `tsc -b` and a second `bun run`, which vitest's default five
    // seconds does not cover.
    testTimeout: 30_000,
  },
});
