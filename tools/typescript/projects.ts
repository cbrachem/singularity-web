import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

/**
 * The solution `tsc -b` builds, read out of `tsconfig.json` and its references.
 *
 * `tsc -b` typechecks exactly the files the projects of the solution include. A file no
 * project includes is compiled by nothing, so a type error in it surfaces when it runs
 * rather than when the gate runs. This module reads both halves of that comparison — the
 * files of the solution, and the TypeScript in the repository — so the gate beside it can
 * name the difference.
 */

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const host: ts.ParseConfigFileHost = {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  },
};

/** One project of the solution: where its config is, and what it compiles. */
export interface Project {
  /** Repository-relative path of the `tsconfig.json`. */
  readonly config: string;
  /** Repository-relative paths of the files it includes, TypeScript sources only. */
  readonly files: readonly string[];
}

function configPath(reference: string): string {
  return ts.sys.directoryExists(reference) ? join(reference, "tsconfig.json") : reference;
}

function isTypeScript(path: string): boolean {
  return path.endsWith(".ts") || path.endsWith(".tsx");
}

/**
 * Every project `tsc -b` reaches from the repository root, the root project first, each
 * reference after the project that names it. A project reached twice is listed once.
 */
export function solutionProjects(root: string = resolve(repoRoot, "tsconfig.json")): Project[] {
  const seen = new Set<string>();
  const projects: Project[] = [];

  const visit = (config: string): void => {
    if (seen.has(config)) return;
    seen.add(config);

    const parsed = ts.getParsedCommandLineOfConfigFile(config, undefined, host);
    if (!parsed) throw new Error(`cannot read ${relative(repoRoot, config)}`);

    projects.push({
      config: relative(repoRoot, config),
      files: parsed.fileNames
        .filter(isTypeScript)
        .map((file) => relative(repoRoot, file))
        .sort(),
    });
    for (const reference of parsed.projectReferences ?? []) visit(configPath(reference.path));
  };

  visit(root);
  return projects;
}

/**
 * Directories the sweep does not enter: `singularity/` is the vendored reference simulation,
 * read-only at a pinned revision, and the rest is install and build output.
 */
const SKIPPED: readonly string[] = ["singularity", "node_modules", "dist", "coverage"];

/**
 * Every TypeScript file authored in the repository, repository-relative.
 *
 * The walk prunes rather than filters. `readdirSync(directory, { recursive: true })` opens every
 * skipped directory before a filter can throw the entries away, and `.git`, `.venv` and
 * `node_modules` cost seconds of walking per run.
 */
export function typeScriptSources(directory: string = repoRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const skipped = entry.name.startsWith(".") || SKIPPED.includes(entry.name);
      return skipped ? [] : typeScriptSources(path);
    }
    return isTypeScript(entry.name) ? [relative(repoRoot, path)] : [];
  });
}
