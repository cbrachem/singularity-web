// boundary-intent harness: reads the workflow and the environment around the Oracle
import { describe, expect, it } from "vitest";

import { oracleAvailable, oracleRequired } from "./support/oracle.ts";
import { WORKFLOW_PATH, jobSteps, readWorkflow } from "./support/workflow.ts";

// The oracle-backed tests skip when the reference environment is absent, so that a working
// copy which has not built `.venv/` still gets a green suite. CI closes that door by
// setting SINGULARITY_ORACLE_REQUIRED, which turns the absence back into a failure. What
// has to be asserted is that CI still does it — a workflow edit could return the oracle-backed tests to skipping everywhere
// with no test going red. These are the assertions that go red instead.
//
// Headless and pure over the workflow text, so it costs nothing and runs in every suite.

const steps = jobSteps(readWorkflow(), "gates");

function step(name: string) {
  const found = steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`${WORKFLOW_PATH}: the gates job has no "${name}" step`);
  return found;
}

/** The one interpreter the gates job is allowed to install into and run from. */
const referencePython = steps.find((candidate) =>
  candidate.uses?.startsWith("actions/setup-python"),
);
const interpreter = `\${{ steps.${referencePython?.id}.outputs.python-path }}`;

describe("the required-Oracle guard", () => {
  it("has a gates job with steps to read", () => {
    expect(steps.map((candidate) => candidate.name)).toContain("Tests");
  });

  it("makes CI run the whole suite with the Oracle required", () => {
    expect(step("Tests").run).toBe("bun run test");
    expect(step("Tests").env.SINGULARITY_ORACLE_REQUIRED).toBe("1");
  });

  it("points the suite at the interpreter the workflow provisioned", () => {
    expect(referencePython?.id).toBe("reference-python");
    expect(step("Tests").env.SINGULARITY_PYTHON).toBe(interpreter);
  });

  it("installs the reference requirements into that same interpreter", () => {
    // Quotes stripped: the expression is worth quoting in the shell, and is the same
    // interpreter either way.
    const install = step("Install").run.replaceAll('"', "");

    expect(install).toContain(`${interpreter} -m pip install -r tools/requirements.txt`);
  });

  // An ambient `pip`/`python` is whichever one PATH happens to resolve, which is the
  // provisioned one only by accident of setup-python's ordering — an implicit coupling
  // between the interpreter the requirements land in and the one the suite then runs.
  it("names that interpreter rather than leaning on PATH", () => {
    const ambient = steps.flatMap((candidate) =>
      candidate.run
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^(pip3?|python3?)\s/.test(line))
        .map((line) => `${candidate.name}: ${line}`),
    );

    expect(ambient).toEqual([]);
  });

  // The guard as the suite itself sees it. The assertions above read the workflow; this one
  // reads the environment the workflow actually produced.
  it.runIf(process.env.CI)("is on, and satisfied, when CI runs this suite", () => {
    expect(oracleRequired).toBe(true);
    expect(oracleAvailable).toBe(true);
  });
});
