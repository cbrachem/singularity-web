import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FORMAT_ARGUMENTS,
  LINT_ARGUMENTS,
  REACH_ARGUMENTS,
  complaint,
  repoRoot,
  ruffAvailable,
  ruffRequired,
  runRuff,
} from "./ruff.ts";

// `tools/` is Python that nothing else typechecks, so an unused import or a shadowed name
// lives there until somebody reads the file. ruff is the gate that reads it instead.

const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** Skip where there is no environment to lint from; fail where one is required. */
const runs = ruffAvailable || ruffRequired;

function pythonFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".py") && !entry.includes("__pycache__"))
    .map((entry) => relative(repoRoot, resolve(directory, entry)));
}

describe("the Python gate", () => {
  it("is reachable from the repository root, the way the other gates are", () => {
    expect(packageJson.scripts["check:python"]).toBe("vitest run --project tools python");
  });

  it("installs its linter from the shared requirements", () => {
    const requirements = readFileSync(resolve(repoRoot, "tools/requirements.txt"), "utf8");

    expect(requirements).toMatch(/^ruff==\d+\.\d+\.\d+$/m);
  });
});

describe("ruff over tools/", () => {
  it.runIf(runs)("reaches every Python file there, none exempted", () => {
    const listed = new Set(
      runRuff(REACH_ARGUMENTS)
        .stdout.split("\n")
        .filter((line) => line.length > 0)
        .map((line) => relative(repoRoot, line)),
    );
    const missed = pythonFiles(resolve(repoRoot, "tools")).filter((file) => !listed.has(file));

    expect(missed).toEqual([]);
  });

  it.runIf(runs)("finds nothing to lint", () => {
    expect(complaint(runRuff(LINT_ARGUMENTS))).toBe("");
  });

  it.runIf(runs)("finds nothing to reformat", () => {
    expect(complaint(runRuff(FORMAT_ARGUMENTS))).toBe("");
  });
});
