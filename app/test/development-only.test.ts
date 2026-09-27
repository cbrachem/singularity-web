import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { findLeaks, forbiddenStrings, formatLeaks, repoRoot } from "../scripts/development-only.ts";
import { developmentFlags } from "../src/development/flags.ts";
import { DEVELOPMENT_ONLY, developmentFeatures } from "../src/development/only.ts";

const developmentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "development");

/** `only.ts` is the declaration itself, so it is the one file that does not make one. */
const DECLARES_THE_RULE = "only.ts";

function developmentModules(): string[] {
  return readdirSync(developmentDir)
    .filter((name) => /\.tsx?$/.test(name) && name !== DECLARES_THE_RULE)
    .sort();
}

describe("the build assertion against development-only code", () => {
  it("fails a build that carries the marker, naming the file and the string", () => {
    const leaks = findLeaks(
      [
        { path: "index.html", text: '<div id="app"></div>' },
        { path: "assets/index-abc.js", text: `console.info("${DEVELOPMENT_ONLY}: scenario boot")` },
      ],
      [DEVELOPMENT_ONLY],
    );

    expect(leaks).toEqual([{ path: "assets/index-abc.js", found: DEVELOPMENT_ONLY }]);
    expect(formatLeaks(leaks)).toContain("assets/index-abc.js");
  });

  it("passes a build that carries none of it", () => {
    const leaks = findLeaks(
      [{ path: "assets/index-abc.js", text: "const a=1;" }],
      forbiddenStrings(),
    );

    expect(leaks).toEqual([]);
    expect(formatLeaks(leaks)).toContain("not reachable");
  });

  // A source map holds the original sources of everything, including code the bundle does
  // not contain, so searching one reports leaks that are not there.
  it("does not search a source map", () => {
    expect(
      findLeaks([{ path: "assets/index-abc.js.map", text: DEVELOPMENT_ONLY }], [DEVELOPMENT_ONLY]),
    ).toEqual([]);
  });

  it("forbids the marker and every Scenario's description", () => {
    const forbidden = forbiddenStrings();
    const scenarios = readdirSync(resolve(repoRoot, "scenarios")).filter((name) =>
      name.endsWith(".scenario.json"),
    );

    expect(forbidden[0]).toBe(DEVELOPMENT_ONLY);
    expect(forbidden).toHaveLength(scenarios.length + 1);
  });
});

// The discipline the gate rests on: the marker is carried by a top-level call, which a
// bundler may not drop, so a development-only module cannot reach a bundle silently. A file
// that forgot to declare itself would make the gate pass while the code shipped.
describe("every development-only module", () => {
  it("declares itself with a top-level developmentOnly() call", () => {
    const undeclared = developmentModules().filter((name) => {
      const source = readFileSync(resolve(developmentDir, name), "utf8");
      return !/^developmentOnly\("[^"]+"\);$/m.test(source);
    });

    expect(undeclared).toEqual([]);
  });

  it("registers itself once loaded, for the development bar to show", () => {
    developmentFlags("");

    expect(developmentFeatures()).toContain("development flags");
  });
});

// The Scenario format is a validator, and the build ships none: the
// content of a build cannot have changed since the build. It is here at all because the
// development entry point replays a Scenario and has to read it the way the harness does,
// and it is harmless there because that module does not reach a build. The
// importer list is what keeps that true — a production module reaching for the parser fails
// here rather than showing up as bytes in the transfer budget.
describe("the Scenario format the replay parses with", () => {
  const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const SCENARIO_FORMAT = "@singularity/sim/scenario-format";

  it("is imported by the development entry point and by nothing else in app/src", () => {
    const importers = readdirSync(sourceDir, { recursive: true, encoding: "utf8" })
      .filter((entry) => /\.tsx?$/.test(entry))
      .filter((entry) => readFileSync(resolve(sourceDir, entry), "utf8").includes(SCENARIO_FORMAT))
      .sort();

    expect(importers).toEqual(["development/scenarios.ts"]);
  });
});
