// boundary-intent harness: a test, so it decides what to drive and what to expect
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  Rng,
  SECONDS_PER_DAY,
  advance,
  createInitialState,
  inGracePeriod,
  lostGame,
  projectDerived,
  projectPersistent,
  type AdvanceResult,
  type BaseState,
  type Draw,
  type ItemState,
  type SimulationState,
} from "../src/index.ts";
import { DEVIATION_REGISTER, deviation } from "./support/deviations.ts";
import {
  FIXTURE_DIRECTORY,
  compareTraces,
  explain,
  firstDifference,
  fixturePaths,
  replayFixture,
  writeFixture,
  type DivergenceFixture,
} from "./support/fidelity.ts";
import { LEDGER_VARIABLE, comparedScenarios } from "./support/ledger.ts";
import {
  NORMALISATIONS,
  NormalisationRefused,
  bindingProblems,
  normalise,
  type NormalisationContext,
} from "./support/normalisation.ts";
import {
  oracleAvailable,
  oracleRequired,
  referenceTrace,
  type ReferenceRecord,
} from "./support/oracle.ts";
import {
  SCENARIO_SUFFIX,
  loadScenario,
  repoRoot,
  scenarioDirectory,
  type Scenario,
} from "./support/scenario.ts";
import {
  asReferenceEffect,
  comparableParts,
  recordTrace,
  type PortRecord,
  type PortTrace,
} from "./support/trace.ts";

// The trace seam, both sides of it: a Scenario goes in, the port and the pinned reference
// each emit a Trace, and every part of every record is compared for exact equality. Nothing here reaches inside the Simulation — a reshuffling of files or names inside
// `sim/src` leaves it green, a changed order of draws or mutations does not.
//
// The Scenario is an empty game inside the grace period. It is chosen first because event
// checking is skipped while grace holds and detection does not run, so the whole run consumes
// **zero draws** past the three the game's creation makes — which lets the state shape, the
// projection and the differ be proven before the generator's stream is.

const runsTheOracle = oracleAvailable || oracleRequired;
const describeOracle = describe.skipIf(!runsTheOracle);

const GRACE = "grace-full";

function graceScenario() {
  return loadScenario(resolve(scenarioDirectory, `${GRACE}${SCENARIO_SUFFIX}`));
}

function portTrace(): readonly PortRecord[] {
  return recordTrace(graceScenario()).records;
}

/** Ledger directories a check below wrote a probe into, removed when this file is done. */
const ledgers: string[] = [];

afterAll(() => {
  for (const directory of ledgers) rmSync(directory, { recursive: true, force: true });
});

/** The State root a Scenario of nothing but advances leaves behind. */
function runToEnd(scenario: Scenario): SimulationState {
  let state = createInitialState({ seed: scenario.seed, difficulty: scenario.difficulty });
  for (const step of scenario.script) {
    if (!("advanceBy" in step)) throw new Error(`${scenario.id} carries a Command`);
    state = advance(state, step.advanceBy).state;
  }
  return state;
}

const newGame = (difficulty = "normal"): SimulationState =>
  createInitialState({ seed: 1, difficulty });

/** The same state with its one base rewritten — the shape every refusal below is built on. */
function withFirstBase(
  state: SimulationState,
  change: (base: BaseState) => BaseState,
): SimulationState {
  let changed = false;
  const locations = state.locations.map((location) => {
    if (changed || location.bases.length === 0) return location;
    changed = true;
    return {
      ...location,
      bases: [change(location.bases[0] as BaseState), ...location.bases.slice(1)],
    };
  });
  if (!changed) throw new Error("the game has no base to change");
  return { ...state, locations };
}

describeOracle("an empty game inside the grace period", () => {
  it("matches the reference on every part of every record", () => {
    const scenario = graceScenario();
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
  });

  it("runs the whole grace period, and is still inside it at the end", () => {
    const scenario = graceScenario();
    const total = scenario.script.reduce(
      (sum, step) => sum + ("advanceBy" in step ? step.advanceBy : 0),
      0,
    );

    // 22 game-days is the whole of it: `in_grace_period` gives up at `raw_day >= 23`
    // (`player.py:541`), so the tick that lands on day 23 is where the next Scenario starts.
    expect(total).toBe(22 * SECONDS_PER_DAY);
    const state = runToEnd(scenario);
    expect(state.gameTime).toBe(total);

    // Read off the predicate that decides it, not off `had_grace`: that flag is set when the
    // game is created and nothing in the port ever clears it, so asserting it holds would be
    // an assertion that cannot fail, on the one claim the whole Scenario rests on.
    expect(inGracePeriod(state)).toBe(true);

    // And the last day of it: the day-23 tick is outside, which is where `past-grace` picks
    // the game up. This Scenario stops one tick short of it on purpose, so that everything
    // it proves is proved without a single draw in the way.
    expect(inGracePeriod({ ...state, gameTime: 23 * SECONDS_PER_DAY })).toBe(false);
    const crossing = advance(state, SECONDS_PER_DAY);
    expect(crossing.state.hadGrace).toBe(false);
    expect(crossing.effects.map((effect) => effect.kind)).toContain("story");
  });
});

// `advance` partitions a day-crossing step at the boundary and runs its tick loop more than
// once (`advance.ts:72`). That loop is the hardest thing in the file and the fidelity
// Scenario never enters it, because upstream cannot be driven across a midnight at all:
// `give_time` backs up to 00:00:00 and discards the remainder (`player.py:277`), which is
// deviation 1 and which no transformation of two records can cancel.
//
// So the comparison that reaches the loop is this one. The reference is driven with the
// halves — a Scenario split exactly at each boundary, which is what the scheduler does in
// play — and the port is driven with the whole. One port record then has to be
// what three reference records say happened, field for field and effect for effect. The days
// after the crossing are part of it: `last_autosave_day` is not in the save schema, so the
// only way a rollover counted once instead of twice becomes visible is the autosave rhythm
// it leaves behind, which is why the Scenario keeps going for four more days.
describeOracle("a step that crosses midnight", () => {
  const MIDNIGHT = "midnight-split";
  /** Steps 3 to 5 of the Scenario are the halves the port merges into one crossing step. */
  const FIRST_HALF = 3;
  const LAST_HALF = 5;

  function midnightScenario(): Scenario {
    return loadScenario(resolve(scenarioDirectory, `${MIDNIGHT}${SCENARIO_SUFFIX}`));
  }

  it("matches the reference on every record when the Scenario is split at the boundary", () => {
    const scenario = midnightScenario();
    const divergence = compareTraces({
      scenario,
      port: recordTrace(scenario),
      reference: referenceTrace(`scenarios/${scenario.id}${SCENARIO_SUFFIX}`),
    });

    expect(
      divergence === undefined
        ? undefined
        : `step ${divergence.step} (${divergence.kind})\n${explain(divergence.difference)}`,
    ).toBeUndefined();
  });

  it("produces from one crossing step what the reference produces from the halves", () => {
    const scenario = midnightScenario();
    const reference = referenceTrace(`scenarios/${scenario.id}${SCENARIO_SUFFIX}`);
    const spans = scenario.script.map((step) => ("advanceBy" in step ? step.advanceBy : 0));
    const crossing = spans.slice(FIRST_HALF, LAST_HALF + 1).reduce((sum, s) => sum + s, 0);

    // The merged step really does cross two midnights: 23:00 on day 2 to 00:30 on day 4.
    expect(spans.slice(0, FIRST_HALF).reduce((sum, s) => sum + s, 0)).toBe(255600);
    expect(crossing).toBe(91800);
    // And the reference stopped at each of them, which is the deviation made visible.
    expect(reference.records[FIRST_HALF]?.persistent.game_time).toBe(3 * SECONDS_PER_DAY);
    expect(reference.records[LAST_HALF]?.persistent.game_time).toBe(4 * SECONDS_PER_DAY + 1800);

    let draws: Draw[] = [];
    let state = createInitialState({
      seed: scenario.seed,
      difficulty: scenario.difficulty,
      observeDraws: (draw) => draws.push(draw),
    });

    const differences: string[] = [];
    const compare = (label: string, result: AdvanceResult, from: number, to: number): void => {
      const window = reference.records.slice(from, to + 1) as readonly ReferenceRecord[];
      const last = window.at(-1) as ReferenceRecord;
      const difference = firstDifference(
        {
          persistent: projectPersistent(result.state),
          derived: projectDerived(result.state),
          effects: result.effects.map(asReferenceEffect),
          draws,
        },
        {
          persistent: last.persistent,
          derived: last.derived,
          // What the reference did across the halves, in the order it did it.
          effects: window.flatMap((record) => record.effects),
          draws: window.flatMap((record) => record.draws),
        },
      );
      if (difference) differences.push(`${label}\n${explain(difference)}`);
      draws = [];
    };

    for (let index = 0; index < spans.length; index += 1) {
      const merging = index === FIRST_HALF;
      const result = advance(state, merging ? crossing : (spans[index] as number));
      compare(
        merging ? `steps ${FIRST_HALF}-${LAST_HALF}, as one crossing step` : `step ${index}`,
        result,
        index,
        merging ? LAST_HALF : index,
      );
      state = result.state;
      if (merging) index = LAST_HALF;
    }

    expect(differences).toEqual([]);
    expect(state.gameTime).toBe(7 * SECONDS_PER_DAY);
  });
});

describe("the grace period's Scenario", () => {
  it("consumes zero RNG draws after the three that create the game", () => {
    const trace = portTrace();

    // Asserted, not assumed, and twice over. First: the draw log the record carries.
    expect(trace[0]?.draws.map((draw: Draw) => draw[0])).toEqual(["shuffle", "randint", "choice"]);
    expect(trace.slice(1).flatMap((record) => record.draws)).toEqual([]);

    // Second: the generator itself, which never moves once the game exists. A draw made and
    // not reported would pass the first check and fail this one.
    const scenario = graceScenario();
    let state: SimulationState = createInitialState({
      seed: scenario.seed,
      difficulty: scenario.difficulty,
    });
    const created = state.rng.toState();
    for (const step of scenario.script) {
      if (!("advanceBy" in step)) throw new Error("the grace Scenario carries no Command");
      state = advance(state, step.advanceBy).state;
      expect(state.rng.toState()).toEqual(created);
    }
  });

  // The boundary this Scenario is drawn at. Inside it nothing draws at all, which is what
  // lets the state shape, the projection and the differ be proven before the stream is; the
  // tick that crosses it turns on detection and event checking, and is `past-grace`'s.
  it("draws nothing until the tick that leaves the grace period", () => {
    const lastDay = { ...newGame(), gameTime: 22 * SECONDS_PER_DAY };
    const before = advance(lastDay, SECONDS_PER_DAY - 1);

    expect(before.state.gameTime).toBe(23 * SECONDS_PER_DAY - 1);
    expect(before.state.rng.toState()).toEqual(lastDay.rng.toState());
    expect(before.effects).toEqual([]);

    // The one that reaches day 23 rolls, and says so — and so does one that leaves the
    // grace period for any of the other reasons.
    expect(advance(lastDay, SECONDS_PER_DAY).state.rng.toState()).not.toEqual(
      lastDay.rng.toState(),
    );
    const byCpu = advance({ ...newGame(), usedCpu: 5000 * SECONDS_PER_DAY + 1 }, 60);
    expect(byCpu.effects.map((effect) => effect.kind)).toEqual(["pause", "story"]);
  });

  // The crossing itself is compared in "a step that crosses midnight" above, against a
  // Scenario split at the boundary — this asserts only that *this* Scenario stays out of it.
  it("never crosses a midnight, which is what keeps deviation 1 out of the comparison", () => {
    let gameTime = 0;
    for (const step of graceScenario().script) {
      const seconds = "advanceBy" in step ? step.advanceBy : 0;
      const day = Math.floor(gameTime / 86400);
      gameTime += seconds;
      // Landing exactly on midnight is the break, not a crossing: upstream discards nothing.
      expect(gameTime, `a step from ${gameTime - seconds}`).toBeLessThanOrEqual((day + 1) * 86400);
    }
  });
});

// No unported rule is silently skipped: every one of them throws. That claim is only worth
// what its throw sites are worth, and a throw site nothing reaches is a comment. So each is
// reached here, from a state built to reach it.
describe("the rules this slice refuses", () => {
  // `Player.in_grace_period` (`player.py:530`), branch by branch. It decides whether the
  // whole Scenario is what it says it is, and `advance` throws the moment it turns false.
  it("is inside the grace period until day 23, and says why when it is not", () => {
    const state = newGame();

    expect(inGracePeriod(state)).toBe(true);
    expect(inGracePeriod({ ...state, gameTime: 22 * SECONDS_PER_DAY })).toBe(true);
    expect(inGracePeriod({ ...state, gameTime: 23 * SECONDS_PER_DAY - 1 })).toBe(true);
    expect(inGracePeriod({ ...state, gameTime: 23 * SECONDS_PER_DAY })).toBe(false);

    // Once lost it stays lost, unless the player is a god.
    expect(inGracePeriod({ ...state, hadGrace: false })).toBe(false);
    expect(inGracePeriod({ ...state, hadGrace: false, apotheosis: true })).toBe(true);
    expect(inGracePeriod({ ...state, apotheosis: true, gameTime: 100 * SECONDS_PER_DAY })).toBe(
      true,
    );

    // The CPU limit: `normal` allows 5000 cpu-days, and the second past it ends the grace.
    const limit = 5000 * SECONDS_PER_DAY;
    expect(inGracePeriod({ ...state, usedCpu: limit })).toBe(true);
    expect(inGracePeriod({ ...state, usedCpu: limit + 1 })).toBe(false);
    // `very-easy` sets it to -1, which is no limit at all.
    expect(inGracePeriod({ ...newGame("very-easy"), usedCpu: limit * 1000 })).toBe(true);
  });

  // `Player.lost_game` (`player.py:751`). Nothing in this slice can lose the game, and the
  // autosave asks it every midnight, so a wrong answer here is a save that stops happening.
  it("reports the game lost only when upstream would", () => {
    const state = newGame();

    expect(lostGame(state)).toBe(0);

    const suspicious = (suspicion: number): SimulationState => ({
      ...state,
      groups: state.groups.map((group, index) => (index === 0 ? { ...group, suspicion } : group)),
    });
    expect(lostGame(suspicious(10000))).toBe(0);
    expect(lostGame(suspicious(10001))).toBe(2);

    const noCpu = { ...state, availableCpus: [0, 0, 0, 0, 0], sleepingCpus: 0 };
    expect(lostGame(noCpu)).toBe(1);
    expect(lostGame({ ...noCpu, sleepingCpus: 1 })).toBe(0);

    // Apotheosis is checked first, and answers 0 to both.
    expect(lostGame({ ...suspicious(10001), apotheosis: true })).toBe(0);
    expect(lostGame({ ...noCpu, apotheosis: true })).toBe(0);
  });

  it("builds a base that is still being built, and an item too", () => {
    // Both are proven against the reference in `estate.trace.test.ts` and
    // `items.trace.test.ts`. What is checked here is only that neither is still a refusal, because this is the list a refusal is written into.
    const unbuiltBase = withFirstBase(newGame(), (base) => ({
      ...base,
      buyable: { ...base.buyable, done: false },
    }));
    expect(() => advance(unbuiltBase, 60)).not.toThrow();

    const unbuiltItem = withFirstBase(newGame(), (base) => {
      // The starting base type comes with its CPU already built (`base.py:211`), which is the
      // item this reaches: unfinish it and the tick meets an item under construction.
      const cpu = base.items.cpu as ItemState;
      return {
        ...base,
        items: { ...base.items, cpu: { ...cpu, buyable: { ...cpu.buyable, done: false } } },
      };
    });
    expect(() => advance(unbuiltItem, 60)).not.toThrow();
    // It had nothing left to pay, so the tick that collects it also completes it.
    expect(advance(unbuiltItem, 60).state.stats.itemCreated).toBe(
      unbuiltItem.stats.itemCreated + 1,
    );
  });

  it("refuses CPU pointed at a task the Content has not got", () => {
    const state = newGame();

    // The two pseudo-tasks and a tech all pass through.
    expect(() => advance({ ...state, cpuUsage: [{ taskId: "jobs", cpu: 1 }] }, 60)).not.toThrow();
    expect(() =>
      advance({ ...state, cpuUsage: [{ taskId: "cpu_pool", cpu: 1 }] }, 60),
    ).not.toThrow();
    expect(() =>
      advance({ ...state, cpuUsage: [{ taskId: "Autonomous Vehicles", cpu: 1 }] }, 60),
    ).not.toThrow();

    // Upstream indexes `self.techs` with it and raises a `KeyError` (`player.py:341`).
    expect(() => advance({ ...state, cpuUsage: [{ taskId: "Telekinesis", cpu: 1 }] }, 60)).toThrow(
      /no such tech: Telekinesis/,
    );
    // Zero CPU on a task is not an allocation, and reaches nothing.
    expect(() =>
      advance({ ...state, cpuUsage: [{ taskId: "Telekinesis", cpu: 0 }] }, 60),
    ).not.toThrow();
  });

  // Maintenance the tick cannot pay puts every base that owes it at a 1.5% chance of dying,
  // per unpaid resource (`player.py:905`). Inside the grace period nothing else rolls at all,
  // so the draw log holds the maintenance rolls and nothing but them — which is what makes
  // "one roll per unpaid resource the base owes" readable here rather than in a full tick.
  it("rolls once for each unpaid resource a base owes, and not at all when it is paid", () => {
    const draws: Draw[] = [];
    const seeded = (): SimulationState =>
      createInitialState({
        seed: 1,
        difficulty: "normal",
        observeDraws: (draw) => draws.push(draw),
      });

    const owesCash = withFirstBase({ ...seeded(), cash: 0 }, (base) => ({
      ...base,
      maintenance: [1_000_000, 0, 0],
    }));
    draws.length = 0;
    advance(owesCash, 3600);
    expect(draws).toHaveLength(1);

    const owesCpu = withFirstBase(seeded(), (base) => ({
      ...base,
      maintenance: [0, 1_000_000, 0],
    }));
    draws.length = 0;
    advance(owesCpu, 3600);
    expect(draws).toHaveLength(1);

    // Both at once is two rolls, not one: the pools are separate and each is drained on its
    // own. A base already killed by the first would skip the second, and neither roll hits
    // at this seed.
    const owesBoth = withFirstBase({ ...seeded(), cash: 0 }, (base) => ({
      ...base,
      maintenance: [1_000_000, 1_000_000, 0],
    }));
    draws.length = 0;
    const both = advance(owesBoth, 3600);
    expect(draws).toHaveLength(2);
    expect(both.state.log).toEqual([]);

    // Maintenance that is paid is not rolled for at all: the base owes it and the cash covers
    // it, so the shortfall the walk reads is zero.
    const affordable = withFirstBase({ ...seeded(), cash: 1_000_000 }, (base) => ({
      ...base,
      maintenance: [1, 0, 0],
    }));
    draws.length = 0;
    advance(affordable, 3600);
    expect(draws).toEqual([]);
  });
});

describe("the projection into upstream's save schema", () => {
  const scenario = { seed: 1, difficulty: "normal" } as const;

  it("is a pure function over a plain state value", () => {
    const state = createInitialState(scenario);
    const once = projectPersistent(state);

    expect(projectPersistent(state)).toEqual(once);
    // Nothing about the projection reads the generator or anything else behind a method.
    const plain = JSON.parse(JSON.stringify({ ...state, rng: state.rng.toState() }));
    expect(projectPersistent({ ...plain, rng: state.rng } as SimulationState)).toEqual(once);
  });

  it("traces derived state beside persistent state", () => {
    const derived = projectDerived(createInitialState(scenario));

    // Upstream rebuilds all nine at load and persists none of them.
    expect(Object.keys(derived).sort()).toEqual([
      "apotheosis",
      "available_cpus",
      "cpu_pool",
      "display_discover",
      "income",
      "interest_rate",
      "job_bonus",
      "labor_bonus",
      "sleeping_cpus",
    ]);
  });

  it("keeps the generator out of the persistent half", () => {
    const persistent = projectPersistent(createInitialState(scenario));

    expect("rng" in persistent).toBe(false);
    expect("rng" in (persistent.player as object)).toBe(false);
  });

  it("holds no floating-point value anywhere", () => {
    const state = createInitialState(scenario);
    const offenders = (value: unknown, path = ""): string[] => {
      if (typeof value === "number") {
        return Number.isInteger(value) ? [] : [`${path} = ${value}`];
      }
      if (Array.isArray(value)) {
        return value.flatMap((entry, index) => offenders(entry, `${path}[${index}]`));
      }
      if (value && typeof value === "object") {
        return Object.entries(value).flatMap(([key, entry]) => offenders(entry, `${path}.${key}`));
      }
      return [];
    };

    expect(offenders(projectPersistent(state), "persistent")).toEqual([]);
    expect(offenders(projectDerived(state), "derived")).toEqual([]);
  });
});

describe("the state root", () => {
  it("is replaced whole by every advance, and never mutated", () => {
    const before = createInitialState({ seed: 3, difficulty: "normal" });
    const snapshot = JSON.stringify(projectPersistent(before));

    const first = advance(before, 3600);
    const second = advance(first.state, 3600);

    expect(first.state).not.toBe(before);
    expect(second.state).not.toBe(first.state);
    expect(JSON.stringify(projectPersistent(before))).toBe(snapshot);
    expect(Object.getPrototypeOf(first.state)).toBe(Object.prototype);
  });

  it("carries the generator, so a tick is reproducible from its input alone", () => {
    const before = createInitialState({ seed: 3, difficulty: "normal" });

    const once = advance(before, 3600).state;
    const again = advance(before, 3600).state;

    expect(projectPersistent(again)).toEqual(projectPersistent(once));
    expect(again.rng.toState()).toEqual(once.rng.toState());
  });
});

describe("the differ", () => {
  const record = (persistent: unknown) => ({
    persistent,
    derived: {},
    effects: [],
    draws: [],
  });

  it("names the first differing path within the record", () => {
    const difference = firstDifference(
      record({ player: { locations: [{ bases: [{ name: "Alpha" }] }] } }),
      record({ player: { locations: [{ bases: [{ name: "Beta" }] }] } }),
    );

    expect(difference?.path).toBe("persistent.player.locations[0].bases[0].name");
    expect(difference?.port).toBe("Alpha");
    expect(difference?.reference).toBe("Beta");
  });

  it("reports a missing field, an extra field and a shorter list as differences", () => {
    expect(firstDifference(record({ a: 1 }), record({ a: 1, b: 2 }))?.why).toMatch(
      /reference has field\(s\) the port does not: b/,
    );
    expect(firstDifference(record({ a: 1, b: 2 }), record({ a: 1 }))?.why).toMatch(
      /port has field\(s\) the reference does not: b/,
    );
    expect(firstDifference(record({ a: [1, 2] }), record({ a: [1] }))?.path).toBe("persistent.a");
  });

  it("compares exactly, with no tolerance, and refuses a float outright", () => {
    expect(firstDifference(record({ cash: 1000 }), record({ cash: 1001 }))?.why).toBe(
      "they differ",
    );
    // A value that is off by a hair is not nearly right: the compared surface has no
    // floating-point value in it at all, so one is a fault in the projection.
    expect(firstDifference(record({ cash: 1000.0001 }), record({ cash: 1000 }))?.why).toMatch(
      /not a whole number/,
    );
    expect(firstDifference(record({ done: true }), record({ done: 1 }))?.why).toBe(
      "one is a number",
    );
  });

  /**
   * A reference trace made out of the port's own records, so the only differences in a
   * comparison are the ones a test plants. `seed` stands for what the recorder reported it
   * ran with, which is the half of deviation 2's check that does not come from the Scenario;
   * `scenario` for the Scenario the recorder said it loaded, which is the half of the label
   * check that does not either.
   */
  const asReference = (truth: PortTrace, seed: number, scenario: string = GRACE) => ({
    scenario,
    lines: [],
    records: truth.records.map((entry) => ({
      step: entry.step,
      kind: entry.kind,
      persistent: entry.persistent as Record<string, unknown>,
      derived: entry.derived as Record<string, unknown>,
      effects: entry.effects,
      draws: entry.draws,
    })),
    seed,
    // Nothing here compares the effect surface's coverage; that is the trace-seam suite's
    // own gate, over the committed Scenarios.
    reachedSites: [],
    // Nor does anything here open either of upstream's dialogs: that is the trace-seam
    // suite's gate too.
    consideredBases: 0,
    consideredItems: 0,
  });

  it("stops at the first differing step, and every step after it is noise", () => {
    const scenario = graceScenario();
    const truth = recordTrace(scenario);
    // The reference is the port's own trace, so the only differences are the ones planted:
    // one at step 2 and one at step 5. The first is the one that has to be reported.
    const reference = asReference(truth, scenario.seed);
    const port: PortTrace = {
      ...truth,
      records: truth.records.map((entry) =>
        entry.step === 2 || entry.step === 5
          ? { ...entry, derived: { ...entry.derived, cpu_pool: -1 } }
          : entry,
      ),
    };

    const divergence = compareTraces({ scenario, port, reference });

    expect(divergence?.step).toBe(2);
    expect(divergence?.difference.path).toBe("derived.cpu_pool");
    rmSync(divergence?.fixture as string, { force: true });
  });

  // Deviation 2's Normalisation only holds the two streams to one seed if the two seeds have
  // separate provenance. Every suite records the reference from a Scenario *file* and the
  // port from a Scenario *object*, and only the Scenario's id ties the two together — so a
  // suite that named the wrong file would compare two different games and read the result as
  // a divergence. Here the reference reports a seed the port's run does not carry, and the
  // comparison has to refuse rather than compare.
  it("refuses a reference that reports a seed the Scenario does not carry", () => {
    const scenario = graceScenario();
    const truth = recordTrace(scenario);
    const reference = asReference(truth, scenario.seed + 1);

    expect(() => compareTraces({ scenario, port: truth, reference })).toThrow(/seeded-stream/);
    // The two seeds are named, because the refusal is the whole message a run gets.
    expect(() => compareTraces({ scenario, port: truth, reference })).toThrow(
      new RegExp(`seeded from ${scenario.seed} .*reported running with ${scenario.seed + 1}`, "s"),
    );
  });

  // And the port half of it. The seed the comparison holds the port to is what `recordTrace`
  // reports it created the state with, not what the Scenario argument says — so a comparison
  // handed one game's Trace beside another game's Scenario refuses, instead of reading the
  // whole run as a divergence at the first record.
  it("refuses a port trace recorded from a Scenario other than the one compared", () => {
    const scenario = graceScenario();
    const elsewhere = { ...scenario, seed: scenario.seed + 1 };
    const port = recordTrace(elsewhere);
    // The reference is that same Trace, reported with the compared Scenario's own seed: the
    // records agree everywhere, so nothing but the port's provenance can raise the refusal.
    const reference = asReference(port, scenario.seed);

    expect(() => compareTraces({ scenario, port, reference })).toThrow(/seeded-stream/);
    expect(() => compareTraces({ scenario, port, reference })).toThrow(
      new RegExp(`seeded from ${elsewhere.seed} .*reported running with ${scenario.seed}`, "s"),
    );
  });

  it("compares a reference that reports the Scenario's own seed", () => {
    const scenario = graceScenario();
    const truth = recordTrace(scenario);

    expect(
      compareTraces({ scenario, port: truth, reference: asReference(truth, scenario.seed) }),
    ).toBeUndefined();
  });

  /**
   * The label, and the two Traces under it.
   *
   * The seeds have separate provenance and hold the two streams to one value, but a seed does
   * not name a game: several committed Scenarios carry the same one. So a run recorded from
   * one of them and compared under another's name matches at every record, and the comparison
   * writes a name whose file never ran into the ledger and into any fixture.
   * Each Trace therefore says which Scenario it ran, and the comparison holds the label to
   * both before the loop. The Scenario used here shares the compared one's seed, so nothing
   * but the label can raise the refusal.
   */
  const SAME_SEED = "grace-quiet";

  const sameSeedScenario = () =>
    loadScenario(resolve(scenarioDirectory, `${SAME_SEED}${SCENARIO_SUFFIX}`));

  /** Run something with the comparison ledger pointed at a directory of this test's own. */
  function withLedger<T>(directory: string, run: () => T): T {
    const previous = process.env[LEDGER_VARIABLE];
    process.env[LEDGER_VARIABLE] = directory;
    try {
      return run();
    } finally {
      if (previous === undefined) delete process.env[LEDGER_VARIABLE];
      else process.env[LEDGER_VARIABLE] = previous;
    }
  }

  function ledgerDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "comparison-ledger-grace-"));
    ledgers.push(directory);
    return directory;
  }

  it("refuses a port trace recorded from a Scenario that only shares the compared one's seed", () => {
    const scenario = graceScenario();
    // Same seed, other name: the records agree everywhere and deviation 2 is satisfied.
    expect(sameSeedScenario().seed).toBe(scenario.seed);
    const port = recordTrace({ ...scenario, id: SAME_SEED });
    const reference = asReference(port, scenario.seed);

    const compare = () =>
      withLedger(ledgerDirectory(), () => compareTraces({ scenario, port, reference }));
    expect(compare).toThrow(new RegExp(`port's Trace says it ran ${SAME_SEED}`));
    expect(compare).toThrow(new RegExp(`compared as ${scenario.id}`));
  });

  it("refuses a reference trace recorded from a Scenario that only shares the compared one's seed", () => {
    const scenario = graceScenario();
    const truth = recordTrace(scenario);
    const reference = asReference(truth, scenario.seed, SAME_SEED);

    const compare = () =>
      withLedger(ledgerDirectory(), () => compareTraces({ scenario, port: truth, reference }));
    expect(compare).toThrow(new RegExp(`reference's Trace says it ran ${SAME_SEED}`));
    expect(compare).toThrow(new RegExp(`compared as ${scenario.id}`));
  });

  // And what the ledger keeps of a run that was labelled wrongly: the Scenario the port's run
  // says it drove, not the argument. The fidelity gate reads that ledger back as what it
  // compared, so an entry no run produced is a false claim.
  it("writes into the ledger the Scenario the port's Trace ran, not the label it was given", () => {
    const scenario = graceScenario();
    const port = recordTrace({ ...scenario, id: SAME_SEED });
    const reference = asReference(port, scenario.seed, SAME_SEED);
    const directory = ledgerDirectory();

    expect(() =>
      withLedger(directory, () => compareTraces({ scenario, port, reference })),
    ).toThrow();

    expect(comparedScenarios(directory)).toEqual([SAME_SEED]);
  });
});

describe("a divergence", () => {
  it("writes a fixture that replays the step without Python and without the steps before it", () => {
    const scenario = graceScenario();
    const trace = recordTrace(scenario).records;
    const failing = trace[7] as PortRecord;
    const context: NormalisationContext = {
      scenarioId: scenario.id,
      portSeed: scenario.seed,
      referenceSeed: scenario.seed,
      previousGameTime: (trace[6] as PortRecord).persistent.game_time as number,
    };

    const fixture: DivergenceFixture = {
      formatVersion: 1,
      scenario: scenario.id,
      step: failing.step,
      kind: failing.kind,
      path: "persistent.player.cash",
      applied: failing.applied,
      input: failing.input,
      expected: comparableParts(failing),
      context,
    };
    const path = writeFixture(fixture);

    try {
      expect(path.startsWith(resolve(repoRoot, FIXTURE_DIRECTORY))).toBe(true);
      const reloaded = JSON.parse(readFileSync(path, "utf8")) as DivergenceFixture;
      // The whole point: the step runs from the fixture alone.
      expect(replayFixture(reloaded)).toBeUndefined();
    } finally {
      rmSync(path, { force: true });
    }
  });

  // The fixture is how a divergence is reproduced without Python, so what
  // has to be shown is that it can *fail*. The test above replays a fixture whose expected
  // half is the port's own record, which compares the port to itself; this one moves one
  // field of the expected half by one and requires the replay to name that field.
  it("names the differing path when the expected half no longer matches", () => {
    const scenario = graceScenario();
    const trace = recordTrace(scenario).records;
    const failing = trace[9] as PortRecord;
    const truth = comparableParts(failing);
    const player = (truth.persistent as { player: Record<string, unknown> }).player;
    const cash = player.cash as number;

    const path = writeFixture({
      formatVersion: 1,
      scenario: scenario.id,
      step: failing.step,
      kind: failing.kind,
      path: "persistent.player.cash",
      applied: failing.applied,
      input: failing.input,
      expected: {
        ...truth,
        persistent: {
          ...(truth.persistent as object),
          player: { ...player, cash: cash + 1 },
        },
      },
      context: {
        scenarioId: scenario.id,
        portSeed: scenario.seed,
        referenceSeed: scenario.seed,
        previousGameTime: (trace[8] as PortRecord).persistent.game_time as number,
      },
    });

    try {
      const reloaded = JSON.parse(readFileSync(path, "utf8")) as DivergenceFixture;
      const difference = replayFixture(reloaded);

      expect(difference?.path).toBe("persistent.player.cash");
      expect(difference?.port).toBe(cash);
      expect(difference?.reference).toBe(cash + 1);
      expect(difference?.why).toBe("they differ");
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("replays every fixture that is committed beside the tests", () => {
    for (const path of fixturePaths()) {
      const fixture = JSON.parse(readFileSync(path, "utf8")) as DivergenceFixture;
      const difference = replayFixture(fixture);
      expect(
        difference === undefined ? undefined : `${path}\n${explain(difference)}`,
      ).toBeUndefined();
    }
  });
});

describe("Normalisations", () => {
  it("are bound 1:1 to the deviation register", () => {
    expect(bindingProblems()).toEqual([]);
    expect(NORMALISATIONS).toHaveLength(DEVIATION_REGISTER.length);
    expect(NORMALISATIONS.map((normalisation) => normalisation.deviation.id)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("cannot be registered against an entry the register does not have", () => {
    // The registry is built through `deviation()`, so a Normalisation for a deviation nobody
    // wrote down never gets constructed — which is what forbids a per-field allowlist.
    expect(() => deviation(6)).toThrow(/no deviation 6/);
  });

  it("move the autosave to the end of the step on both sides", () => {
    const trace = portTrace();
    const withAutosave = trace.find((record) => record.effects.length > 0) as PortRecord;
    const notice = { kind: "call" as const, name: "show_message", args: [], kwargs: {} };
    const autosave = { kind: "call" as const, name: "auto_save", args: [], kwargs: {} };

    const normalised = normalise(
      {
        port: { ...withAutosave, effects: [autosave, notice] },
        reference: {
          step: withAutosave.step,
          kind: withAutosave.kind,
          persistent: { game_time: withAutosave.persistent.game_time as number },
          derived: {},
          effects: [autosave, notice],
          draws: [],
        },
      },
      {
        scenarioId: GRACE,
        portSeed: 1,
        referenceSeed: 1,
        previousGameTime:
          (withAutosave.persistent.game_time as number) -
          (("advanceBy" in withAutosave.applied ? withAutosave.applied.advanceBy : 0) as number),
      },
    );

    expect(normalised.port.effects).toEqual([notice, autosave]);
    expect(normalised.reference.effects).toEqual([notice, autosave]);
  });

  it("refuse rather than pretend, when a deviation reaches the comparison", () => {
    const trace = portTrace();
    const first = trace[0] as PortRecord;
    const pair = {
      port: first,
      reference: {
        step: 0,
        kind: "advance",
        // A reference that discarded a remainder at midnight: deviation 1, made visible.
        persistent: { game_time: 0 },
        derived: {},
        effects: [],
        draws: [],
      },
    };

    expect(() =>
      normalise(pair, {
        scenarioId: GRACE,
        portSeed: 1,
        referenceSeed: 1,
        previousGameTime: 0,
      }),
    ).toThrow(NormalisationRefused);

    expect(() =>
      normalise(
        { ...pair, reference: { ...pair.reference, persistent: { game_time: 1 } } },
        { scenarioId: GRACE, portSeed: 1, referenceSeed: 7, previousGameTime: 0 },
      ),
    ).toThrow(/seeded-stream/);
  });

  it("refuse a generator that reaches the persistent half", () => {
    const first = portTrace()[0] as PortRecord;

    expect(() =>
      normalise(
        {
          port: {
            ...first,
            persistent: { ...first.persistent, rng: Rng.seeded(1).toState() as never },
          },
          reference: {
            step: 0,
            kind: "advance",
            persistent: { game_time: first.persistent.game_time as number },
            derived: {},
            effects: [],
            draws: [],
          },
        },
        { scenarioId: GRACE, portSeed: 1, referenceSeed: 1, previousGameTime: 0 },
      ),
    ).toThrow(/generator-outside-the-save/);
  });
});

// This comparison runs on every commit, inside `bun run test`, with the Oracle
// required — which `oracle-guard.test.ts` is what asserts. What is left here is the half that
// is about this Scenario: a Scenario the manifest does not know is a comparison against
// nothing.
describe("the fidelity gate", () => {
  it("has a Scenario to run, and it is the one the manifest knows", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(scenarioDirectory, "manifest.json"), "utf8"),
    ) as { scenarios: Record<string, { steps: number }> };

    expect(manifest.scenarios[GRACE]?.steps).toBe(graceScenario().script.length);
  });
});
