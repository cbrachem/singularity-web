// boundary-intent harness: a test, so it decides what to drive and what to expect
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import {
  BASE_CONSTRUCTED,
  CASH,
  LABOR,
  advance,
  applyCommand,
  consideredBases,
  content,
  costPaid,
  createInitialState,
  newBuyable,
  projectPersistent,
  resourceFlow,
  roundHalfToEven,
  workOn,
  type BaseState,
  type BuyableState,
  type Command,
  type Draw,
  type ItemState,
  type LocationState,
  type SimulationState,
} from "../src/index.ts";
import { compareTraces, explain, firstDifference } from "./support/fidelity.ts";
import { oracleAvailable, oracleRequired, referenceTrace, runOracle } from "./support/oracle.ts";
import { SCENARIO_SUFFIX, loadScenario, scenarioDirectory } from "./support/scenario.ts";
import { recordTrace, type PortRecord } from "./support/trace.ts";

// The third fidelity Scenario, and the first one a player could have produced: `estate` builds
// three bases, renames one and destroys two, all inside the grace period.
//
// Staying inside grace is what makes it read: detection does not roll and events are not
// checked, so the only draws in the whole run are the ones that *name* a base, and the only
// thing spending the pools is construction. What that isolates is the construction kernel —
// including the half-to-even rounding it does once per Tick, which `Math.round` gets wrong by
// one unit on every `.5` boundary and which the Scenario crosses on its first construction
// tick (`estate` step 3, `cost_paid` `[62, 0, 60]`).

const runsTheOracle = oracleAvailable || oracleRequired;
const describeOracle = describe.skipIf(!runsTheOracle);

const ESTATE = "estate";

function estateScenario() {
  return loadScenario(resolve(scenarioDirectory, `${ESTATE}${SCENARIO_SUFFIX}`));
}

let recorded: readonly PortRecord[] | undefined;
function portTrace(): readonly PortRecord[] {
  return (recorded ??= recordTrace(estateScenario()).records);
}

function newGame(seed = 8): SimulationState {
  return createInitialState({ seed, difficulty: "normal" });
}

function basesOf(record: PortRecord): { readonly location: string; readonly name: string }[] {
  const player = record.persistent.player as {
    locations: { id: string; bases: { name: string }[] }[];
  };
  return player.locations.flatMap((location) =>
    location.bases.map((base) => ({ location: location.id, name: base.name })),
  );
}

function logOf(record: PortRecord): { log_id: string; base_name?: string }[] {
  return (record.persistent.player as { log: { log_id: string; base_name?: string }[] }).log;
}

/** The state after replaying the Scenario's first `steps` steps, without recording anything. */
function replay(steps: number): SimulationState {
  const scenario = estateScenario();
  let state = newGame(scenario.seed);
  for (const step of scenario.script.slice(0, steps)) {
    state = "advanceBy" in step ? advance(state, step.advanceBy).state : applyCommand(state, step);
  }
  return state;
}

function locationAt(state: SimulationState, locationId: string): LocationState {
  const found = state.locations.find((location) => location.specId === locationId);
  if (!found) throw new Error(`no such location: ${locationId}`);
  return found;
}

function withBases(
  state: SimulationState,
  locationId: string,
  bases: readonly BaseState[],
): SimulationState {
  return {
    ...state,
    locations: state.locations.map((location) =>
      location.specId === locationId ? { ...location, bases } : location,
    ),
  };
}

function unfinished(base: BaseState): BaseState {
  return { ...base, buyable: { ...base.buyable, done: false } };
}

describeOracle("an estate the player builds, renames and tears down", () => {
  it("matches the reference on every part of every record", () => {
    const scenario = estateScenario();
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

  // The kernel's rounding mode is the one thing in this slice that a Scenario could pass by
  // accident — a run that never lands on a `.5` boundary compares equal under either mode. So
  // the boundary is pinned twice: here against the reference's own `numpy.round`, and below
  // against the step of the Scenario that actually crosses one.
  it("rounds half to even where numpy does, and not where Math.round does", () => {
    const halves = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 3.5, 62.5, 187.5, 250.5];
    const script =
      "import json,numpy;print(json.dumps([int(numpy.round(x)) for x in " +
      JSON.stringify(halves) +
      "]))";
    const numpy = runOracle(["-c", script]);
    expect(numpy.stderr, "numpy answers for the reference").toBe("");

    const rounded = halves.map(roundHalfToEven);
    expect(rounded).toEqual(JSON.parse(numpy.stdout));
    // And it really is a different answer from the obvious spelling, on most of them.
    expect(rounded).not.toEqual(halves.map((half) => Math.round(half)));
  });
});

describe("the construction kernel", () => {
  // `Datacenter` at a location with neither a thrift nor a speed modifier: 1500 cash and one
  // day of labor, which the loader turns into 1440 minutes. An hour of a tick therefore buys
  // 60/1440 of it, and 1500 × 60/1440 is exactly 62.5 — the boundary.
  const datacenter: BuyableState = newBuyable([1500, 0, 1440]);

  it("pins a .5 boundary, and pays the even unit rather than the higher one", () => {
    const work = workOn(datacenter, [1000, 39600, 60]);

    expect(work.spent[LABOR]).toBe(60);
    expect(work.spent[CASH]).toBe(62);
    expect(Math.round(1500 * (60 / 1440)), "the spelling this is not").toBe(63);
    expect(work.complete).toBe(false);
    expect(work.buyable.costLeft).toEqual([1500 - 62, 0, 1440 - 60]);
  });

  it("is capped by the least complete resource, not by the most", () => {
    // Cash enough for the whole thing, an hour of labor: labor is what it gets.
    const rich = workOn(datacenter, [1_000_000, 39600, 60]);
    expect(rich.spent).toEqual([62, 0, 60]);

    // Labor enough for the whole thing, almost no cash: now cash is the cap.
    const poor = workOn(datacenter, [15, 39600, 100_000]);
    expect(poor.spent).toEqual([15, 0, Math.round(1440 * (15 / 1500))]);
  });

  it("costs nothing when nothing is on offer, and never un-builds", () => {
    const paid = workOn(datacenter, [1000, 39600, 60]).buyable;
    const broke = workOn(paid, [0, 0, 0]);

    expect(broke.spent).toEqual([0, 0, 0]);
    expect(broke.buyable.costLeft).toEqual(paid.costLeft);
  });

  // A component with no cost at all divides by zero, which is `inf` — or `NaN` when nothing
  // has been offered for it either. Both are upstream's, and both have to come out as "this
  // component is already paid for" rather than as a number.
  it("skips a component that costs nothing, whether or not anything is offered for it", () => {
    const free = newBuyable([100, 0, 0]);

    expect(workOn(free, [100, 0, 0]).spent).toEqual([100, 0, 0]);
    expect(workOn(free, [100, 0, 0]).complete).toBe(true);
    expect(workOn(free, [100, 39600, 60]).spent).toEqual([100, 0, 0]);
    expect(workOn(free, [40, 39600, 60]).spent).toEqual([40, 0, 0]);
  });

  it("refuses a buyable that costs nothing at all, as numpy's empty minimum does", () => {
    expect(() => workOn(newBuyable([0, 0, 0]), [1, 1, 1])).toThrow(/no progress to compute/);
  });
});

describe("a base under construction", () => {
  // Upstream sorts the estate into two lists at the top of the tick and a base only reaches
  // the one that pays maintenance once it is done (`player.py:294-303`). Both halves of that
  // are checked here, because both are silent when they are wrong.
  it("owes no maintenance: the only thing it costs the tick is its own construction", () => {
    const idle = replay(11);
    const building = applyCommand(idle, {
      command: "buildBase",
      location: "EUROPE",
      baseType: "Datacenter",
      name: "Deep Storage Two",
    } satisfies Command);

    const site = locationAt(building, "EUROPE").bases.at(-1) as BaseState;
    expect(site.buyable.done, "it is still being built").toBe(false);
    expect(site.maintenance[CASH], "and it would owe, once it is not").toBeGreaterThan(0);

    // To the next midnight, which is a day's worth of maintenance for everything that owes it.
    const alone = advance(idle, 68400).state;
    const busy = advance(building, 68400).state;

    const after = locationAt(busy, "EUROPE").bases.at(-1) as BaseState;
    const spent =
      (after.buyable.totalCost[CASH] as number) - (after.buyable.costLeft[CASH] as number);

    expect(after.buyable.done, "and still being built at the end of the tick").toBe(false);
    expect(spent).toBeGreaterThan(0);
    // Cash to the unit: construction and nothing else. A maintenance share would show up here.
    expect(busy.cash).toBe((alone.cash as number) - spent);
    // And it contributes no CPU either, finished or not — `recalc_cpu` counts only done bases.
    expect(busy.availableCpus).toEqual(alone.availableCpus);
  });

  it("works on none of its items, where a finished base's unfinished item is built", () => {
    const state = newGame();
    const withItem = (base: BaseState, done: boolean): BaseState => ({
      ...base,
      items: {
        ...base.items,
        cpu: {
          ...(base.items.cpu as ItemState),
          buyable: { ...(base.items.cpu as ItemState).buyable, done },
        },
      },
    });

    const located = state.locations.find((location) => location.bases.length > 0) as LocationState;
    const only = located.bases[0] as BaseState;
    // The starting base's CPU was finished when the base was created, so what un-finishing it
    // leaves behind is an item with nothing left to pay: whether it is collected at all is
    // the whole of the difference between the two ticks below.
    expect(costPaid((only.items.cpu as ItemState).buyable)).not.toEqual([0, 0, 0]);
    const built = (state: SimulationState) =>
      ((locationAt(state, located.specId).bases[0] as BaseState).items.cpu as ItemState).buyable
        .done;

    // Done base, unfinished item: the tick collects it and completes it.
    const done = advance(withBases(state, located.specId, [withItem(only, false)]), 60).state;
    expect(built(done)).toBe(true);
    expect(done.stats.itemCreated).toBe(state.stats.itemCreated + 1);

    // Unfinished base, unfinished item: upstream never collects it, so neither does the port.
    const building = advance(
      withBases(state, located.specId, [unfinished(withItem(only, false))]),
      60,
    ).state;
    expect(built(building)).toBe(false);
    expect(building.stats.itemCreated).toBe(state.stats.itemCreated);
  });
});

describe("the order bases are worked on", () => {
  // `g.all_bases()` is location order and then the order the bases were added, and the tick
  // offers each base what is *left* of the cash — so the order decides who is paid and who
  // waits. That the order is *contract* is shown the only way it can be: by reordering for
  // real and watching the compared record move.
  //
  // No draw moves with it, and that is a property of this Scenario rather than a gap. Inside
  // the grace period nothing rolls per base at all, and past it every base still costs one
  // roll per group whatever its position — so the estate's order is carried by the state,
  // where `estate` reads it, and never by the draw log.

  /** Two Datacenters under construction, and cash for a fraction of one of them. */
  function twoUnderConstruction(first: string, second: string): SimulationState {
    const built = replay(11);
    const one = applyCommand(built, {
      command: "buildBase",
      location: first,
      baseType: "Datacenter",
      name: "First",
    } satisfies Command);
    const two = applyCommand(one, {
      command: "buildBase",
      location: second,
      baseType: "Datacenter",
      name: "Second",
    } satisfies Command);
    return { ...two, cash: 40 };
  }

  function paidBy(state: SimulationState, name: string): number {
    const base = state.locations
      .flatMap((location) => location.bases)
      .find((each) => each.name === name);
    if (!base) throw new Error(`no base named ${name}`);
    return (base.buyable.totalCost[CASH] as number) - (base.buyable.costLeft[CASH] as number);
  }

  it("pays the first of two in a location, and swapping them moves the trace", () => {
    const pinned = twoUnderConstruction("N AMERICA", "N AMERICA");
    const bases = locationAt(pinned, "N AMERICA").bases;
    const swapped = withBases(pinned, "N AMERICA", [
      ...bases.slice(0, -2),
      bases.at(-1) as BaseState,
      bases.at(-2) as BaseState,
    ]);

    const after = advance(pinned, 3600).state;
    const other = advance(swapped, 3600).state;

    expect(paidBy(after, "First")).toBeGreaterThan(0);
    expect(paidBy(after, "Second")).toBe(0);
    expect(paidBy(other, "Second")).toBeGreaterThan(0);
    expect(paidBy(other, "First")).toBe(0);

    // The whole point: the difference is inside the compared half of a Trace record, and it
    // is not merely the two names having changed places — read by name, what each base has
    // left to pay moved with the order.
    const owing = (state: SimulationState) =>
      Object.fromEntries(
        state.locations
          .flatMap((location) => location.bases)
          .map((base) => [base.name, base.buyable.costLeft]),
      );

    expect(owing(after)).not.toEqual(owing(other));
    expect(
      firstDifference(projectPersistent(after), projectPersistent(other)),
      "the swap has to reach the compared record",
    ).toBeDefined();
  });

  it("takes the locations in their own order too", () => {
    // `N AMERICA` comes before `EUROPE` in the order the loader pinned, so it is paid first.
    const pinned = twoUnderConstruction("N AMERICA", "EUROPE");
    const reversed = { ...pinned, locations: [...pinned.locations].reverse() };

    const forwards = advance(pinned, 3600).state;
    const backwards = advance(reversed, 3600).state;

    expect(paidBy(forwards, "First")).toBeGreaterThan(0);
    expect(paidBy(forwards, "Second")).toBe(0);
    expect(paidBy(backwards, "Second")).toBeGreaterThan(0);
    expect(paidBy(backwards, "First")).toBe(0);
  });
});

/**
 * The same order rule, in the queue the resource-flow Projection walks.
 *
 * `compute_future_resource_flow` appends what the player is only *considering* after
 * everything already under construction (`player.py:841`, `flow.ts`), and walks the queue
 * taking CPU out of one pool as it goes. So the position is not decoration: whatever comes
 * first is served from a full pool, and whatever comes second is served from what is left.
 *
 * A day of one CPU against two buyables that each want hundreds of CPU-days is the
 * discriminating case — the first entry drains the pool outright and the second is offered
 * nothing, so the cash estimate names which of the two the queue reached first.
 */
describe("the queue the resource flow walks", () => {
  /** One Covert Base under construction: 190,000 cash and 900 CPU-days still to pay. */
  function underConstruction(): SimulationState {
    return applyCommand(createInitialState({ seed: 7, difficulty: "normal" }), {
      command: "buildBase",
      location: "EUROPE",
      baseType: "Covert Base",
    } satisfies Command);
  }

  /** One Time Capsule the player is looking at: 25,000 cash and 25,000 CPU-days. */
  function anOrderInMind(state: SimulationState): readonly BuyableState[] {
    const spec = content.bases.byId.get("Time Capsule");
    if (!spec) throw new Error("no such base type: Time Capsule");
    return consideredBases(state, "N AMERICA", spec, 1);
  }

  it("serves what is already being built before what is only being considered", () => {
    const state = underConstruction();
    const order = anOrderInMind(state);

    // A day of one CPU is a hundredth of what the Covert Base alone wants, so the pool is
    // dry by the time the queue reaches the order: considering it costs the day nothing.
    expect(state.availableCpus[0]).toBe(1);
    expect(resourceFlow(state, order).cash.constructionNeeded).toBe(
      resourceFlow(state).cash.constructionNeeded,
    );

    // And that is a statement about the *order*, not about the order being free: served
    // first, out of the same day's pool, it draws a different figure entirely.
    const bare = createInitialState({ seed: 7, difficulty: "normal" });
    expect(resourceFlow(bare).cash.constructionNeeded).toBe(0);
    expect(resourceFlow(bare, anOrderInMind(bare)).cash.constructionNeeded).toBeGreaterThan(0);
    expect(resourceFlow(bare, anOrderInMind(bare)).cash.constructionNeeded).not.toBe(
      resourceFlow(state).cash.constructionNeeded,
    );
  });

  // The other half of the routine's twin pass is deliberately blind to the queue: what the
  // estate *wants* is asked of the full remaining cost every time, so a considered order adds
  // its CPU wherever it sits. Asserting both is what keeps the pair from being read as one.
  it("counts what the order wants wherever the queue put it", () => {
    const state = underConstruction();
    const order = anOrderInMind(state);

    expect(resourceFlow(state, order).cpu.constructionNeeded).toBeGreaterThan(
      resourceFlow(state).cpu.constructionNeeded,
    );
  });
});

describe("the Commands this slice carries", () => {
  it("names a base from the simulation RNG when the Command carries no name", () => {
    const scenario = estateScenario();
    const unnamed = scenario.script.filter(
      (step) => !("advanceBy" in step) && step.command === "buildBase" && step.name === undefined,
    );
    expect(unnamed.length, "the Scenario has to exercise generation").toBeGreaterThan(0);

    // Four draws, in this order: the coin that chooses between a significant number and an
    // arbitrary one, the number itself, the city, the base type's flavour.
    const generating = portTrace().filter(
      (record) => record.kind === "buildBase" && record.draws.length > 0,
    );
    expect(generating).toHaveLength(unnamed.length);
    for (const record of generating) {
      // The first record also carries what creating the game drew, ahead of the name's own.
      const names = record.draws.slice(record.draws.length - 4) as readonly Draw[];
      expect(names.map((draw) => draw[0])).toEqual([
        "random",
        names[1]?.[0] === "choice" ? "choice" : "randint",
        "choice",
        "choice",
      ]);
    }
  });

  it("gives the base the reference's name, composed from a city, a flavour and a number", () => {
    const last = portTrace().at(-1) as PortRecord;
    const generated = basesOf(last).map((base) => base.name);
    expect(generated).toContain("Indianapolis Node Lease 1985");

    const cities = content.locations.byId.get("N AMERICA")?.cities ?? [];
    const flavors = content.bases.byId.get("Server Access")?.flavor ?? [];
    expect(cities).toContain("Indianapolis");
    expect(flavors).toContain("Node Lease");
  });

  it("never names a base twice in one location", () => {
    for (const record of portTrace()) {
      const perLocation = new Map<string, string[]>();
      for (const base of basesOf(record)) {
        perLocation.set(base.location, [...(perLocation.get(base.location) ?? []), base.name]);
      }
      for (const [location, names] of perLocation) {
        expect(new Set(names).size, `${location} at step ${record.step}`).toBe(names.length);
      }
    }
  });

  it("renames a base and nothing else", () => {
    const before = replay(5);
    const after = applyCommand(before, {
      command: "renameBase",
      location: "N AMERICA",
      base: 1,
      name: "Alpha",
    } satisfies Command);

    expect(locationAt(after, "N AMERICA").bases[1]?.name).toBe("Alpha");
    const blind = (state: SimulationState) =>
      withBases(
        state,
        "N AMERICA",
        locationAt(state, "N AMERICA").bases.map((base) => ({ ...base, name: "" })),
      );
    expect(projectPersistent(blind(after))).toEqual(projectPersistent(blind(before)));
  });

  it("destroys a base: it leaves its location with its items, and the CPU is recounted", () => {
    const before = replay(8);
    const doomed = locationAt(before, "N AMERICA").bases[1] as BaseState;
    expect(doomed.buyable.done).toBe(true);
    expect(doomed.items.cpu).not.toBeNull();
    expect(doomed.cpu).toBeGreaterThan(0);

    const after = applyCommand(before, {
      command: "destroyBase",
      location: "N AMERICA",
      base: 1,
    } satisfies Command);

    expect(locationAt(after, "N AMERICA").bases.map((base) => base.name)).not.toContain(
      doomed.name,
    );
    expect(locationAt(after, "N AMERICA").bases).toHaveLength(
      locationAt(before, "N AMERICA").bases.length - 1,
    );
    expect(after.availableCpus[0]).toBe((before.availableCpus[0] as number) - doomed.cpu);
  });

  it("refuses an address the game has not got", () => {
    const state = replay(1);

    expect(() =>
      applyCommand(state, {
        command: "buildBase",
        location: "ATLANTIS",
        baseType: "Server Access",
      } satisfies Command),
    ).toThrow(/no such location/);
    expect(() =>
      applyCommand(state, {
        command: "buildBase",
        location: "N AMERICA",
        baseType: "Orbital Cathedral",
      } satisfies Command),
    ).toThrow(/no such base type/);
    expect(() =>
      applyCommand(state, {
        command: "destroyBase",
        location: "EUROPE",
        base: 0,
      } satisfies Command),
    ).toThrow(/asked for index 0/);
  });

  it("leaves the State root it was handed alone, generator included", () => {
    const before = replay(1);
    const state = before.rng.toState();

    applyCommand(before, {
      command: "buildBase",
      location: "N AMERICA",
      baseType: "Server Access",
    } satisfies Command);

    expect(before.rng.toState()).toEqual(state);
    expect(locationAt(before, "N AMERICA").bases).toHaveLength(
      locationAt(replay(1), "N AMERICA").bases.length,
    );
  });
});

describe("a base that finishes", () => {
  it("writes one log entry, switches itself on, and the tick recounts the CPU", () => {
    const before = replay(2);
    const building = applyCommand(before, {
      command: "buildBase",
      location: "N AMERICA",
      baseType: "Server Access",
      name: "Relay",
    } satisfies Command);

    expect(building.availableCpus[0]).toBe(before.availableCpus[0]);
    const after = advance(building, 3600).state;

    const relay = locationAt(after, "N AMERICA").bases.find((base) => base.name === "Relay");
    expect(relay?.buyable.done).toBe(true);
    expect(relay?.powerState).toBe("active");
    expect(after.availableCpus[0]).toBe((before.availableCpus[0] as number) + (relay?.cpu ?? 0));
    expect(after.stats.baseCreated).toBe(before.stats.baseCreated + 1);

    const entries = after.log.filter((entry) => entry.kind === BASE_CONSTRUCTED);
    expect(entries.map((entry) => entry.fields.base_name)).toContain("Relay");
    const written = entries.at(-1);
    expect(written?.rawEmitTime).toBe(after.gameTime);
    expect(written?.fields).toEqual({
      base_name: "Relay",
      base_type_id: "Server Access",
      base_location_id: "N AMERICA",
    });
  });

  it("is written into the trace exactly where the reference writes it", () => {
    const trace = portTrace();
    const appended = trace.filter(
      (record, index) =>
        logOf(record).length > (index === 0 ? 0 : logOf(trace[index - 1] as PortRecord).length),
    );

    expect(appended.length).toBeGreaterThan(0);
    // Only an advance can finish a base; a Command never does, so no Command writes a log.
    expect(new Set(appended.map((record) => record.kind))).toEqual(new Set(["advance"]));
    expect(
      appended.every((record) => (logOf(record).at(-1)?.log_id as string) === BASE_CONSTRUCTED),
    ).toBe(true);
  });
});

describe("maintenance", () => {
  it("is totalled over the finished bases and charged in two cash attempts and one in CPU", () => {
    const state = replay(11);
    const bases = locationAt(state, "N AMERICA").bases;
    const owing = bases.filter((base) => base.buyable.done);
    expect(owing.length).toBeGreaterThan(1);

    const total = owing.reduce((sum, base) => sum + (base.maintenance[CASH] as number), 0);
    expect(total).toBeGreaterThan(owing[0]?.maintenance[CASH] as number);

    // The second cash attempt is what lets a base live on money the same tick earned: with no
    // cash at the start of the tick and jobs earning during it, the day is still paid for.
    const broke = { ...state, cash: 0, partialCash: 0 };
    expect(() => advance(broke, 86400)).not.toThrow();
    expect(advance(broke, 86400).state.cash).toBeGreaterThanOrEqual(0);

    // And the CPU attempt takes its share out of the pool before construction sees it.
    const owingCpu = withBases(
      state,
      "N AMERICA",
      bases.map((base, index) =>
        index === 0 ? { ...base, maintenance: [base.maintenance[CASH], 1, 0] as const } : base,
      ),
    );
    const drained = advance(owingCpu, 3600).state;
    expect(drained.cpuPool).toBeLessThan(advance(state, 3600).state.cpuPool);
    expect((drained.cpuPool as number) + 3600).toBe(advance(state, 3600).state.cpuPool);
  });
});

describe("the estate Scenario", () => {
  it("stays inside the grace period, so nothing but naming a base draws", () => {
    const trace = portTrace();
    const withDraws = trace.filter((record) => record.draws.length > 0);

    expect(withDraws.map((record) => record.kind)).toEqual(["buildBase", "buildBase"]);
    // Three of the first record's draws created the game; the rest named the first base.
    expect(withDraws[0]?.draws).toHaveLength(3 + 4);
    expect(withDraws[1]?.draws).toHaveLength(4);
  });

  it("crosses a .5 rounding boundary, which is what makes the comparison catch the mode", () => {
    const paid = portTrace()
      .map((record) => {
        const player = record.persistent.player as {
          locations: { bases: { name: string; cost_paid?: number[] }[] }[];
        };
        return player.locations
          .flatMap((location) => location.bases)
          .find((base) => base.name === "Deep Storage")?.cost_paid;
      })
      .filter((entry): entry is number[] => entry !== undefined);

    // 1500 × 60/1440 is 62.5 exactly: half to even pays 62, half up would pay 63.
    expect(paid).toContainEqual([62, 0, 60]);
    expect(paid).not.toContainEqual([63, 0, 60]);
  });

  it("builds, renames and destroys, and ends with what it kept", () => {
    const trace = portTrace();
    const kinds = trace.map((record) => record.kind);

    expect(kinds).toContain("buildBase");
    expect(kinds).toContain("renameBase");
    expect(kinds).toContain("destroyBase");
    expect(kinds.filter((kind) => kind === "buildBase")).toHaveLength(3);
    expect(kinds.filter((kind) => kind === "destroyBase")).toHaveLength(2);

    const started = basesOf(trace[0] as PortRecord).length;
    const ended = basesOf(trace.at(-1) as PortRecord).length;
    expect(started).toBe(2);
    expect(ended).toBe(2);
  });

  it("is the one the digest manifest knows", async () => {
    const manifest = JSON.parse(
      await import("node:fs").then((fs) =>
        fs.readFileSync(resolve(scenarioDirectory, "manifest.json"), "utf8"),
      ),
    ) as { scenarios: Record<string, { steps: number }> };

    expect(manifest.scenarios[ESTATE]?.steps).toBe(estateScenario().script.length);
  });
});
