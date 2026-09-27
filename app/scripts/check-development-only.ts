import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildFiles, findLeaks, forbiddenStrings, formatLeaks } from "./development-only.ts";

const distDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");

if (!existsSync(resolve(distDir, "index.html"))) {
  console.error(`No build at ${distDir}. Run \`bun run build\` first.`);
  process.exit(2);
}

const leaks = findLeaks(buildFiles(distDir), forbiddenStrings());
console.log(formatLeaks(leaks));
process.exit(leaks.length === 0 ? 0 : 1);
