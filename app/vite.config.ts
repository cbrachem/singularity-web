import preact from "@preact/preset-vite";
import { defineConfig } from "vitest/config";

import { licencesPlugin } from "./scripts/licences-plugin.ts";

export default defineConfig({
  // Relative, so the build runs under any path prefix, such as a GitHub Pages project site.
  base: "./",
  // The licences surface is generated from NOTICE while the bundle is built and stamped with
  // the commit. The plugin is also where NOTICE having drifted from the repository
  // it describes fails the build rather than shipping.
  plugins: [preact(), licencesPlugin()],
  json: {
    // Content ships inside the bundle as one JSON.parse over a string rather than as object
    // literals. Both keys are needed: Vite's `stringify` default
    // decides per file by size, so the shipped form would otherwise depend on how large a
    // `.dat` happened to grow, and `namedExports` takes priority over it and emits a
    // literal per top-level key. Nothing imports a named export from a JSON file.
    namedExports: false,
    stringify: true,
  },
  build: {
    target: "es2022",
    // The initial transfer is a CI gate. One entry chunk keeps what the gate
    // measures the same thing the browser fetches to first paint.
    modulePreload: { polyfill: false },
  },
  test: {
    name: "app",
    environment: "happy-dom",
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
