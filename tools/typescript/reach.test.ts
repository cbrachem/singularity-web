import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { repoRoot, solutionProjects, typeScriptSources } from "./projects.ts";

// `tsc -b` is only a gate over the files some project of the solution includes. Anything
// else — a config at the repository root, the gates under `tools/` — is compiled by
// whatever happens to run it, and a type error in it waits for that run. This test is what
// notices, rather than the next reader of the file.

const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

const projects = solutionProjects();

describe("the TypeScript gate", () => {
  it("is reachable from the repository root, the way the other gates are", () => {
    expect(packageJson.scripts["typecheck"]).toBe("tsc -b");
    expect(packageJson.scripts["check:typescript"]).toBe("vitest run --project tools typescript");
  });

  it("builds a solution of more than the two packages", () => {
    expect(projects.map((project) => project.config)).toContain("tsconfig.root.json");
  });
});

describe("`tsc -b`", () => {
  it("reaches every TypeScript file in the repository, none exempted", () => {
    const compiled = new Set(projects.flatMap((project) => project.files));
    const sources = typeScriptSources();
    const missed = sources.filter((file) => !compiled.has(file));

    // A sweep that finds nothing is subtracted to nothing, and the gate then agrees with the
    // solution about no files at all. Named files rather than a count, because the walk has
    // to reach all three of the places it sweeps.
    expect(sources).toContain("sim/src/index.ts");
    expect(sources).toContain("app/src/ui/App.tsx");
    expect(sources).toContain("tools/typescript/projects.ts");
    expect(missed).toEqual([]);
  });

  it("gives every file exactly one project to be compiled by", () => {
    const owners = new Map<string, string[]>();
    for (const project of projects) {
      for (const file of project.files) {
        owners.set(file, [...(owners.get(file) ?? []), project.config]);
      }
    }
    const shared = [...owners].filter(([, configs]) => configs.length > 1);

    expect(Object.fromEntries(shared)).toEqual({});
  });
});
