import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Every TypeScript file under a directory, so a source rule can be applied to all of it. */
export function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((entry) => /\.tsx?$/.test(entry))
    .map((entry) => resolve(directory, entry));
}

/** `app/src`, the tree the source rules are applied to. */
export const APP_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

/** `app/test`, for the rules a test suite holds itself to. */
export const APP_TEST = resolve(dirname(fileURLToPath(import.meta.url)), "..");
