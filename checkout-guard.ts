import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every checkout installs its own `node_modules`, and one that has not does not fail
 * cleanly.
 *
 * `vitest` and `tsc` are resolved *upwards*, so a fresh worktree silently borrows the main
 * checkout's tree: the suite gets far enough to start and then dies in project setup naming
 * `@preact/preset-vite` — an `app/` dependency, so a symptom rather than the cause — after
 * writing its `node_modules/.vite-temp` scratch into the tree it borrowed from. `tsc -b`
 * borrows the same tree and says nothing at all.
 *
 * One `existsSync` in front of each gate replaces that with a sentence. It is a command, so
 * `package.json` can run it before the tool starts, and a function, so the root config can
 * run it again for a `vitest` that was invoked directly.
 */
export function missingInstall(checkout: string): string | undefined {
  return existsSync(resolve(checkout, "node_modules"))
    ? undefined
    : `${checkout}: no node_modules here — run \`bun install\``;
}

/** The same check where a thrown error is what gets read: a config file. */
export function requireInstall(checkout: string): void {
  const complaint = missingInstall(checkout);
  if (complaint !== undefined) throw new Error(complaint);
}

// As a command, the checkout is the working directory — which is where `bun run` starts a
// package script, whichever directory the gate was typed in.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const complaint = missingInstall(process.cwd());
  if (complaint !== undefined) {
    console.error(complaint);
    process.exit(1);
  }
}
