import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatReport, measureTransfer } from "./transfer-budget.ts";

const distDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");

if (!existsSync(resolve(distDir, "index.html"))) {
  console.error(`No build at ${distDir}. Run \`bun run build\` first.`);
  process.exit(2);
}

const report = measureTransfer(distDir);
console.log(formatReport(report));

// A reference with no file behind it fails the gate on its own: the byte count it produced
// is an undercount of a first paint that is broken anyway.
if (report.missing.length > 0) {
  console.error(
    `The document references ${report.missing.length} file(s) the build does not have: ${report.missing.join(", ")}`,
  );
}

process.exit(report.withinBudget && report.missing.length === 0 ? 0 : 1);
