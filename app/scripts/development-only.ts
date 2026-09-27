import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEVELOPMENT_ONLY } from "../src/development/only.ts";

/**
 * Scenario boot and the frozen clock are development affordances that **must not reach the
 * shipped bundle** — a build assertion, not a convention. This is that
 * assertion, as a pure function over the files a build produced.
 *
 * It looks for two things, and they fail for different reasons:
 *
 * - **The marker.** Every module under `app/src/development/` calls `developmentOnly()` at
 *   the top level, and that call carries `DEVELOPMENT_ONLY` into whatever bundle the module
 *   ends up in. A top-level call into another module is a side effect a bundler may not drop,
 *   so the marker cannot be minified away while the module survives.
 * - **The Scenario descriptions.** Belt as well as braces: a Scenario reaches the bundle only
 *   through a module that imports it, so the marker already covers it — but the descriptions
 *   are long and unique, and checking them turns "no dev module shipped" into "no Scenario
 *   shipped" without depending on the argument.
 *
 * A `.map` file is not searched: it is a development artefact by nature, it is not fetched
 * unless devtools are open, and it holds the original sources of everything, so searching it
 * would report the sources of code the bundle does not contain.
 */

export interface Leak {
  /** The built file, relative to the build directory. */
  readonly path: string;
  /** The string that should not have been in it. */
  readonly found: string;
}

const NOT_SEARCHED = /\.map$/;

/** Every built file that names something development-only. */
export function findLeaks(
  files: readonly { readonly path: string; readonly text: string }[],
  forbidden: readonly string[],
): Leak[] {
  return files.flatMap((file) =>
    NOT_SEARCHED.test(file.path)
      ? []
      : forbidden
          .filter((needle) => file.text.includes(needle))
          .map((found) => ({ path: file.path, found })),
  );
}

export function buildFiles(distDir: string): { readonly path: string; readonly text: string }[] {
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    });

  return walk(distDir).map((path) => ({
    path: relative(distDir, path),
    text: readFileSync(path, "latin1"),
  }));
}

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * What no built file may contain: the marker, and enough of each Scenario's description to
 * be unmistakable.
 */
export function forbiddenStrings(scenariosDir = resolve(repoRoot, "scenarios")): string[] {
  const descriptions = readdirSync(scenariosDir)
    .filter((name) => name.endsWith(".scenario.json"))
    .sort()
    .map((name) => {
      const document: unknown = JSON.parse(readFileSync(resolve(scenariosDir, name), "utf8"));
      const description = (document as { description?: unknown }).description;
      return typeof description === "string" ? description.slice(0, 60) : "";
    })
    .filter((description) => description !== "");

  return [DEVELOPMENT_ONLY, ...descriptions];
}

export function formatLeaks(leaks: readonly Leak[]): string {
  if (leaks.length === 0) {
    return "No development-only code in the build: scenario boot and the frozen clock are not reachable.";
  }
  return [
    "Development-only code reached the build:",
    ...leaks.map((leak) => `  ${leak.path}  contains  ${JSON.stringify(leak.found)}`),
  ].join("\n");
}
