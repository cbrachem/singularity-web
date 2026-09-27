import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

import { requireInstall } from "./checkout-guard.ts";

// Before `projects`, deliberately: resolving those is what loads `app/vite.config.ts`, and
// an uninstalled checkout fails there with `@preact/preset-vite` — the wrong cause, in
// somebody else's tree. `bun run test` never gets this far because `pretest` runs the same
// guard as a command; this is the copy that catches a `vitest` invoked directly.
requireInstall(dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  test: {
    projects: ["sim", "app", "tools/vitest.config.ts"],
  },
});
