import { describe, expect, it } from "vitest";

import simulationSuite from "../../sim/vitest.config.ts";

// Every oracle-backed test spawns the pinned reference and waits for Python to walk a
// Scenario (`tools/trace/`). That costs seconds, and it costs more of them the
// busier the machine is. Vitest's own default of five seconds is a number nobody here chose
// — it is what a suite gets for saying nothing — and under the parallelism of `bun run test`
// on a loaded machine the recorder walk crosses it. Every worker then reports a red suite it
// did not cause, which is the one failure that says nothing about the code.
//
// So the sim project declares a timeout it means, and this is where the number is answerable.

/** Vitest's own default `testTimeout`, in milliseconds: the budget of a suite that is silent. */
const VITEST_DEFAULT = 5000;

/**
 * The slowest oracle-backed test on the shared budget, in milliseconds, measured in a full run
 * of the sim project on a 24-core Linux workstation with 24 spinning processes beside it:
 *
 *     sim/test/reference-trace.test.ts > the reference recorder
 *       > emits one record per Scenario step, in order — 6410 ms
 *
 * The same test costs 2522 ms in an unloaded full-suite run on that machine, and 2901 ms in a
 * run of its own file alone. The margin is a property of the machine rather than of the test,
 * which is why the loaded number is the one the timeout is sized against.
 *
 * Tests that already name a larger timeout of their own are not bound by this: the two-run
 * determinism check walks every Scenario twice and keeps its own 60 s.
 */
const MEASURED_UNDER_LOAD = 6410;

/**
 * How much slower still a machine may be before the suite calls a slow run a failure. Four,
 * the factor a CI core is taken to be slower by than the workstation measured on.
 */
const LOAD_HEADROOM = 4;

const declared = simulationSuite.test?.testTimeout;

describe("the sim project's test timeout", () => {
  it("is declared rather than left at vitest's default", () => {
    expect(declared, "sim/vitest.config.ts sets no testTimeout").toBeTypeOf("number");
    expect(declared ?? VITEST_DEFAULT).toBeGreaterThan(VITEST_DEFAULT);
  });

  it("fits the slowest oracle-backed test on a machine slower than the one measured on", () => {
    expect(declared ?? VITEST_DEFAULT).toBeGreaterThanOrEqual(MEASURED_UNDER_LOAD * LOAD_HEADROOM);
  });
});
