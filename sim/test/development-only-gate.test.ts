// boundary-intent harness: reads the CI workflow and the package scripts around a build gate
import { describe, expect, it } from "vitest";

import { WORKFLOW_PATH, jobSteps, packageScripts, readWorkflow } from "./support/workflow.ts";

// Scenario boot and the frozen clock are development affordances that must not
// reach the shipped bundle — a build assertion, not a convention. The assertion itself lives
// in `app/scripts/`, and it works; what this asserts is that CI *runs* it. A
// gate nobody runs is not a gate: a regression that shipped the development entry point would
// have gone out with a green tree.
//
// Asserted here rather than beside the script, because this is where the workflow parser the
// other gates are checked with lives. Headless and pure over two text files, so
// it costs nothing and runs in every suite.

const DEVELOPMENT_ONLY_SCRIPT = "check:development-only";
const BUILD_SCRIPT = "build";

const steps = jobSteps(readWorkflow(), "gates");

/** The index of the first step whose body runs `bun run <script>`, or -1. */
function stepRunning(script: string): number {
  return steps.findIndex((step) =>
    step.run.split("\n").some((line) => line.trim() === `bun run ${script}`),
  );
}

describe("the development-only build gate", () => {
  it("is a script the repository defines", () => {
    expect(packageScripts()[DEVELOPMENT_ONLY_SCRIPT]).toBeDefined();
  });

  it("runs in CI, so a build that shipped scenario boot goes red", () => {
    expect(stepRunning(DEVELOPMENT_ONLY_SCRIPT)).toBeGreaterThanOrEqual(0);
  });

  // It reads what a build produced, so a run before the build has nothing to search and the
  // script exits 2 rather than passing. Order is part of the wiring, not a detail of it.
  it("runs after the build it searches", () => {
    const build = stepRunning(BUILD_SCRIPT);

    expect(build).toBeGreaterThanOrEqual(0);
    expect(stepRunning(DEVELOPMENT_ONLY_SCRIPT)).toBeGreaterThan(build);
  });

  it("is a step of its own, so the gate has a name in the log", () => {
    const step = steps[stepRunning(DEVELOPMENT_ONLY_SCRIPT)];

    expect(step?.name, `${WORKFLOW_PATH}: the gate's step is unnamed`).toBeDefined();
    expect(step?.run).toBe(`bun run ${DEVELOPMENT_ONLY_SCRIPT}`);
  });
});
