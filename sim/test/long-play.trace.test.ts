// boundary-intent harness: a test, so it decides what to drive and what to expect
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { SECONDS_PER_DAY, allBases, allItems, resourceFlow } from "../src/index.ts";
import { compareTraces, explain } from "./support/fidelity.ts";
import { asReferenceFlow } from "./support/flow.ts";
import {
  oracleAvailable,
  oracleRequired,
  referenceResourceFlow,
  referenceTrace,
} from "./support/oracle.ts";
import {
  type DestroyBase,
  SCENARIO_SUFFIX,
  isAdvance,
  loadScenario,
  scenarioDirectory,
  scenarioPaths,
  stepKind,
  type Scenario,
} from "./support/scenario.ts";
import { recordTrace, replayStates } from "./support/trace.ts";

/**
 * The **long** Scenario: one greedy play, 1778 game-days and 2259 steps, generated once and
 * offline and committed as data.
 *
 * The spec asks for three kinds of Scenario and this is the third. The short one with no
 * Commands runs on every commit; `command-vocabulary` reaches every one of the six; this one
 * runs long enough for a difference to *accumulate*. A rounding fault that is invisible for
 * forty steps has hundreds of ticks here to move a cash balance, a suspicion figure or a
 * construction estimate somewhere the eye can see it — and the comparison is exact equality,
 * step for step, so it is the length rather than any single assertion that does the work.
 *
 * **Generated offline, exactly once.** A generator under `tools/oracle/` wrote this file and
 * is not run again: a script generated at verification time would come out of one
 * implementation's generator, and the two ends of the comparison would no longer be driven
 * by the same input. The rule has its own check in `reference-trace.test.ts`,
 * which is why the generator is not named here — nothing on the verification path may name
 * it, and that suite reads the names off the directory.
 */

const runsTheOracle = oracleAvailable || oracleRequired;
const describeOracle = describe.skipIf(!runsTheOracle);

const LONG_PLAY = "long-play";

function longPlay() {
  return loadScenario(resolve(scenarioDirectory, `${LONG_PLAY}${SCENARIO_SUFFIX}`));
}

describe("the long Scenario", () => {
  it("is the longest committed script, by a distance", () => {
    const scenario = longPlay();
    const others = scenarioPaths()
      .map(loadScenario)
      .filter((candidate) => candidate.id !== LONG_PLAY)
      .map((candidate) => candidate.script.length);

    expect(scenario.script.length).toBeGreaterThan(Math.max(...others) * 2);
  });

  // 500 is a property of the committed seed rather than of the generator. The policy loses
  // rather than wins, so how long a run lasts is mostly a draw: of the first hundred and
  // twenty seeds this one runs longest, at 1778 game-days against 1662 for the next.
  // Regenerating from another seed is expected to fail this — sweep, do not lower it.
  it("plays hundreds of game-days, in day-long advances", () => {
    const advances = longPlay().script.filter(isAdvance);

    expect(advances.length).toBeGreaterThan(500);
    expect(new Set(advances.map((step) => step.advanceBy))).toEqual(new Set([SECONDS_PER_DAY]));
  });

  // A long play is a play, not a long advance: the greedy policy that wrote it buys, builds
  // and reallocates all the way through, so the run keeps taking Commands rather than
  // settling into a state nothing touches again.
  it("keeps issuing Commands the whole way through", () => {
    const kinds = longPlay().script.map(stepKind);
    const half = Math.floor(kinds.length / 2);
    const commands = (steps: readonly string[]) =>
      new Set(steps.filter((kind) => kind !== "advance"));

    expect(commands(kinds.slice(0, half)).size).toBeGreaterThan(1);
    expect(commands(kinds.slice(half)).size).toBeGreaterThan(1);
  });

  // Building is the easy half of the estate, so the policy gives bases up and renames the
  // ones it keeps rather than only building and buying: 100 destroys and 16 renames here.
  it("gives bases up and renames them, more than once each", () => {
    const kinds = longPlay().script.map(stepKind);
    const count = (command: string) => kinds.filter((kind) => kind === command).length;

    expect(count("destroyBase")).toBeGreaterThan(1);
    expect(count("renameBase")).toBeGreaterThan(1);
  });

  // The sixth Command, and the last one this Scenario reached for. A power state is a field
  // of every Trace record, and `command-vocabulary` switches power over only forty steps.
  // The estate keeps its last standing base asleep while it is still building, so the state
  // moves both ways over hundreds of game-days — 20 switches here.
  it("puts bases to sleep and wakes them again", () => {
    const kinds = longPlay().script.map(stepKind);

    expect(kinds.filter((kind) => kind === "switchPower").length).toBeGreaterThan(1);
  });

  // `destroyBase` is the one Command that renumbers the bases under it, and every Trace
  // record carries the whole estate, so each renumbering is compared position for position.
  // This asserts the harder half: that a later Command *addresses* a base at an index a
  // destroy moved, which is where an off-by-one in the port's own renumbering would show as
  // the wrong base being renamed or bought for rather than as a differing list.
  //
  // The committed run reaches it four times, all at N AMERICA. It is a property of this run
  // rather than of the policy — the policy addresses finished bases and abandons unfinished
  // ones, so it takes a finished base sitting under an abandoned site, which the run has to
  // happen into. Read it the way
  // the seed is read, and sweep rather than lower it.
  it("addresses a base at an index a destroy moved", () => {
    const scenario = longPlay();
    const states = replayStates(scenario);
    // Not the name: the policy renames a base the day it stands, so the base a destroy moved
    // is addressed afterwards under a name it did not carry then. What it started at does not
    // move.
    const identity = (base: { specId: string; startedAtMin: number }) =>
      `${base.specId}@${base.startedAtMin}`;
    const moved = new Set<string>();
    let addressed = 0;

    scenario.script.forEach((step, index) => {
      if (index === 0 || isAdvance(step) || !("base" in step)) return;
      const estate =
        states[index - 1]?.locations.find((place) => place.specId === step.location)?.bases ?? [];
      const addressee = estate[step.base];
      if (addressee === undefined) return;
      if (stepKind(step) === "destroyBase") {
        for (const base of estate.slice((step as DestroyBase).base + 1)) moved.add(identity(base));
      } else if (moved.has(identity(addressee))) {
        addressed += 1;
      }
    });

    expect(addressed).toBeGreaterThan(0);
  });

  it("is the one the digest manifest knows", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(scenarioDirectory, "manifest.json"), "utf8"),
    ) as { scenarios: Record<string, { steps: number }> };

    expect(manifest.scenarios[LONG_PLAY]?.steps).toBe(longPlay().script.length);
  });
});

describeOracle("the long play against the reference", () => {
  it("matches on every part of every record", () => {
    const scenario = longPlay();
    const divergence = compareTraces({
      scenario,
      port: recordTrace(scenario),
      reference: referenceTrace(`scenarios/${scenario.id}${SCENARIO_SUFFIX}`),
    });

    expect(
      divergence === undefined
        ? undefined
        : `step ${divergence.step} (${divergence.kind})\n${explain(divergence.difference)}\n` +
            `fixture: ${divergence.fixture}`,
    ).toBeUndefined();
  }, 60_000);

  /**
   * The resource-flow Projection over the whole play (`player.py:770`).
   *
   * `research` compares the same Projection over forty steps; this one is the accumulating
   * half of the claim, and it is the only committed script that allocates CPU to **jobs**
   * explicitly and keeps items under construction inside finished bases. Both are branches
   * of the routine that a shorter Scenario never enters.
   */
  it("computes the reference's own resource flow for every one of its steps", () => {
    const scenario = longPlay();
    const reference = referenceResourceFlow(`scenarios/${scenario.id}${SCENARIO_SUFFIX}`);
    const port = replayStates(scenario).map((state) => asReferenceFlow(resourceFlow(state)));

    expect(port).toHaveLength(reference.length);
    expect(port).toEqual(reference);
  }, 60_000);

  it("drives it through explicit job allocations and items under construction", () => {
    const flows = referenceResourceFlow(`scenarios/${LONG_PLAY}${SCENARIO_SUFFIX}`);

    expect(flows.some((flow) => (flow.cpu.explicit_jobs ?? 0) > 0)).toBe(true);
    // Interest is the one term the reference's own docstring calls a known omission of the
    // day's *simulation*, and the routine adds it anyway. A long play is where a balance
    // large enough to produce one exists at all.
    expect(flows.some((flow) => (flow.cash.interest ?? 0) > 0)).toBe(true);

    // A construction figure above zero says only that *something* is being built, which is
    // true of every Scenario from its first step and therefore says nothing about the branch
    // this run is here for. The estate splits in two (`flow.ts`): an unfinished base is
    // itself the thing being built, and a finished one contributes its unfinished *items*.
    // The second half is what only a long play reaches, so the estate is what is asked.
    expect(stepsWithItemsInsideFinishedBases(longPlay())).toBeGreaterThan(0);
  });
});

/** Steps whose estate holds an item still being built inside a base that is already finished. */
function stepsWithItemsInsideFinishedBases(scenario: Scenario): number {
  return replayStates(scenario).filter((state) =>
    Array.from(allBases(state)).some(
      (base) => base.buyable.done && Array.from(allItems(base)).some((item) => !item.buyable.done),
    ),
  ).length;
}
