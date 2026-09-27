// boundary-intent harness: a test, so it decides what to drive and what to expect
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CASH,
  ITEM_CONSTRUCTED,
  LABOR,
  advance,
  applyCommand,
  consideredItems,
  content,
  costPaid,
  createInitialState,
  detectChance,
  newItem,
  projectPersistent,
  resourceFlow,
  stackItems,
  type BaseState,
  type Command,
  type ItemSlot,
  type ItemState,
  type LocationState,
  type SimulationState,
} from "../src/index.ts";
import { compareTraces, explain } from "./support/fidelity.ts";
import { asReferenceFlow } from "./support/flow.ts";
import {
  oracleAvailable,
  oracleRequired,
  referenceResourceFlow,
  referenceTrace,
} from "./support/oracle.ts";
import { SCENARIO_SUFFIX, loadScenario, scenarioDirectory } from "./support/scenario.ts";
import { recordTrace, replayStates, type PortRecord } from "./support/trace.ts";

// The fourth fidelity Scenario, and the one that fills a base with contents: `items` buys into
// every kind of slot, replaces an item while it is being built and again after it is done,
// runs four of them to completion, and leaves one in a base that never finishes.
//
// What it isolates is the half of construction that is *not* the kernel. Items run through the
// same kernel bases do, so the arithmetic is already pinned by `estate`; what is new here is
// when an item is worked on, in which order, what a replacement does to what was there, and
// what a completed item is then worth to its base.
//
// `cpu-stacking` is compared here too. It was authored ahead of the port and has been waiting
// for one, and it reaches the stacking path with nothing paid yet: its Storage Unit never
// finishes, so the stack it merges has never been worked on.
//
// `growing-stack` is the other half of that rule and the reason both are here. It finishes the
// Storage Unit first, so the stack inside it is built between the buys that grow it, and what
// the merge does to a *part-built* and then to a *finished* stack is compared step by step
// rather than read out of the reference by hand.

const runsTheOracle = oracleAvailable || oracleRequired;
const describeOracle = describe.skipIf(!runsTheOracle);

const ITEMS = "items";
const CPU_STACKING = "cpu-stacking";
const GROWING_STACK = "growing-stack";

const RELAY = 0;
const ECHO = 1;

function scenarioNamed(id: string) {
  return loadScenario(resolve(scenarioDirectory, `${id}${SCENARIO_SUFFIX}`));
}

function itemsScenario() {
  return scenarioNamed(ITEMS);
}

let recorded: readonly PortRecord[] | undefined;
function portTrace(): readonly PortRecord[] {
  return (recorded ??= recordTrace(itemsScenario()).records);
}

/** The state after replaying the Scenario's first `steps` steps, without recording anything. */
function replay(steps: number): SimulationState {
  const scenario = itemsScenario();
  let state = createInitialState({ seed: scenario.seed, difficulty: scenario.difficulty });
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

function baseAt(state: SimulationState, index: number, locationId = "N AMERICA"): BaseState {
  const base = locationAt(state, locationId).bases[index];
  if (!base) throw new Error(`${locationId} has no base ${index}`);
  return base;
}

function itemIn(state: SimulationState, index: number, slot: ItemSlot): ItemState {
  const item = baseAt(state, index).items[slot];
  if (!item) throw new Error(`base ${index} has nothing in its ${slot} slot`);
  return item;
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

function buyAt(
  state: SimulationState,
  location: string,
  base: number,
  itemType: string,
  count?: number,
) {
  const command: Command =
    count === undefined
      ? { command: "buyItem", location, base, itemType }
      : { command: "buyItem", location, base, itemType, count };
  return applyCommand(state, command);
}

function buy(state: SimulationState, base: number, itemType: string, count?: number) {
  return buyAt(state, "N AMERICA", base, itemType, count);
}

describeOracle("an estate the player fills with items", () => {
  it("matches the reference on every part of every record", () => {
    const scenario = itemsScenario();
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

  // `cpu-stacking` was authored with the reference recorder and has been waiting for a port
  // to compare against. It reaches `Item.__iadd__` with a base still under construction, so
  // what it pins is the merge's arithmetic on an item nothing has been paid into yet.
  it("matches the reference where a base stacks CPUs of one spec", () => {
    expectIdenticalTrace(CPU_STACKING);
  });

  // The same path with the base finished, so the stack is *worked on* between the buys that
  // grow it. Two merges are compared: one into a pair that has paid part of its cash and part
  // of its labor, and one into a stack that is finished and is holding the base's CPU.
  it("matches the reference where a stack grows while it is being built", () => {
    expectIdenticalTrace(GROWING_STACK);
  });

  function expectIdenticalTrace(id: string): void {
    const scenario = scenarioNamed(id);
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
  }
});

/**
 * The item dialogs' hypothetical, which is the other half of `considered_buyables`.
 *
 * Upstream writes the field from two places. The build dialog puts fake Bases there
 * (`screens/location.py:411`, `sim/src/flow.ts`, `consideredBases`); the item dialogs put a
 * plain `buyable.Buyable(item_spec, count=n)` there — one when a slot's item is highlighted,
 * one carrying the slider's count in the multiple-build dialog, and one per slot when the
 * base screen offers to fill every empty slot at once (`screens/base.py:103,182,446`).
 *
 * The port makes both an argument to the same pure Projection, so what is compared here is the
 * *answer*: the port's `resourceFlow` over `consideredItems` against the reference's
 * `compute_future_resource_flow` with the same buyable written on the player for the length of
 * one call. `items` is the Scenario to ask it on, because it is the one that fills bases.
 */
describeOracle("an item the player is looking at inside a base", () => {
  // A CPU item with no prerequisite, so the dialog it stands for could really be offering it,
  // and a count above one, so an order that ignored the count could not pass.
  const order = { item: "Server", count: 5 };

  it("computes the reference's own resource flow for it, step for step", () => {
    const scenario = itemsScenario();
    const reference = referenceResourceFlow(`scenarios/${scenario.id}${SCENARIO_SUFFIX}`, [order]);
    const spec = content.items.byId.get(order.item);
    if (!spec) throw new Error(`no such item: ${order.item}`);

    const port = replayStates(scenario).map((state) =>
      asReferenceFlow(resourceFlow(state, consideredItems(state, spec, order.count))),
    );

    expect(port).toHaveLength(reference.length);
    expect(port).toEqual(reference);
  });

  // And the argument is not decorative: an item the player is only looking at moves the
  // answer. Read off the reference's own two runs, so it says what the *other* side of the
  // comparison above was made to do.
  it("costs the considered item into the flow rather than ignoring it", () => {
    const idle = referenceResourceFlow(`scenarios/${ITEMS}${SCENARIO_SUFFIX}`);
    const considering = referenceResourceFlow(`scenarios/${ITEMS}${SCENARIO_SUFFIX}`, [order]);

    expect(considering).not.toEqual(idle);
    expect(
      considering.filter(
        (flow, step) =>
          (flow.cash.construction_needed ?? 0) > (idle[step]?.cash.construction_needed ?? 0),
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe("when an item is worked on", () => {
  // Upstream sorts the estate into two lists at the top of the tick and only a base that is
  // already done contributes its items to the second (`player.py:294-303`). So a base that
  // finishes *during* a tick leaves its items untouched until the next one — a rule that is
  // silent when it is wrong, because the item merely progresses one tick early.
  it("is never before its base is finished, not even on the tick that finishes it", () => {
    // Built inside the grace period, where nothing rolls, so the only thing moving is
    // construction. A Datacenter takes several days to pay for; the item in it takes none of
    // them.
    const site = { location: "EUROPE", index: 0 };
    const building = buyAt(
      applyCommand(replay(4), {
        command: "buildBase",
        location: site.location,
        baseType: "Datacenter",
        name: "Vault",
      } satisfies Command),
      site.location,
      site.index,
      "High Speed Internet Access",
    );

    let state = building;
    const held = () => locationAt(state, site.location).bases[site.index] as BaseState;
    expect(held().buyable.done, "the Datacenter is still being built").toBe(false);

    let finished: SimulationState | undefined;
    for (let day = 0; day < 15 && finished === undefined; day += 1) {
      // Every tick until the base is done leaves the item exactly where it was.
      expect(costPaid((held().items.network as ItemState).buyable)).toEqual([0, 0, 0]);
      state = advance(state, 86400).state;
      if (held().buyable.done) finished = state;
    }
    expect(finished, "the Datacenter finishes inside the run").toBeDefined();

    // Including the tick that finished it: the estate was sorted into two lists before the
    // base was paid off, and this base was in the wrong one.
    expect(costPaid((held().items.network as ItemState).buyable)).toEqual([0, 0, 0]);

    state = advance(state, 86400).state;
    expect(costPaid((held().items.network as ItemState).buyable)[LABOR]).toBeGreaterThan(0);
  });

  it("comes after base construction, and takes what the bases left", () => {
    // Step 34 puts a Datacenter under construction beside a base whose reactor is unbuilt.
    // The Datacenter is worked on first, and there is nothing left when the item's turn
    // comes — which is only visible because both are hungry for the same cash.
    const together = advance(replay(36), 86400).state;
    expect(costPaid(itemIn(together, RELAY, "reactor").buyable)).toEqual([0, 0, 0]);

    // Take the Datacenter away and the same tick pays the item instead.
    const alone = advance(withBases(replay(36), "EUROPE", []), 86400).state;
    expect(costPaid(itemIn(alone, RELAY, "reactor").buyable)[CASH]).toBeGreaterThan(0);
  });
});

describe("the order items are worked on", () => {
  // `(base, slot)`: `g.all_bases()` order, then `Base.all_items()` order, which is the order
  // the slots dictionary was built in (`base.py:196`) and not the order they were bought in.
  // As with the base loop, the order is shown by reordering for real and watching the
  // compared record move.

  /** Cash for a slice of one item, so whoever is asked first takes all of it. */
  function starve(state: SimulationState): SimulationState {
    return { ...state, cash: 40, partialCash: 0 };
  }

  it("takes the bases in their own order, so the first is paid and the second waits", () => {
    const built = replay(4);
    const pinned = starve(buy(buy(built, RELAY, "Warning Signs"), ECHO, "PC"));
    expect(itemIn(pinned, RELAY, "security").buyable.done).toBe(false);
    expect(itemIn(pinned, ECHO, "cpu").buyable.done).toBe(false);

    const bases = locationAt(pinned, "N AMERICA").bases;
    const swapped = withBases(pinned, "N AMERICA", [
      bases[ECHO] as BaseState,
      bases[RELAY] as BaseState,
      ...bases.slice(2),
    ]);

    const forwards = advance(pinned, 86400).state;
    const backwards = advance(swapped, 86400).state;

    expect(costPaid(itemIn(forwards, RELAY, "security").buyable)[CASH]).toBeGreaterThan(0);
    expect(costPaid(itemIn(forwards, ECHO, "cpu").buyable)[CASH]).toBe(0);
    // Swapped, the same two items are read at the other index, and the answer follows the
    // position rather than the base.
    expect(costPaid(itemIn(backwards, 1, "security").buyable)[CASH]).toBe(0);
    expect(costPaid(itemIn(backwards, 0, "cpu").buyable)[CASH]).toBeGreaterThan(0);
  });

  it("takes a base's slots in slot order, whatever order they were bought in", () => {
    const rich = replay(4);
    const reactorFirst = buy(
      buy(rich, RELAY, "Diesel Generator"),
      RELAY,
      "High Speed Internet Access",
    );
    const networkFirst = buy(
      buy(rich, RELAY, "High Speed Internet Access"),
      RELAY,
      "Diesel Generator",
    );

    const one = advance(starve(reactorFirst), 86400).state;
    const other = advance(starve(networkFirst), 86400).state;

    for (const state of [one, other]) {
      expect(costPaid(itemIn(state, RELAY, "reactor").buyable)[CASH]).toBeGreaterThan(0);
      expect(costPaid(itemIn(state, RELAY, "network").buyable)[CASH]).toBe(0);
    }
  });
});

describe("buying into an occupied slot", () => {
  it("throws the old extra away, finished or not, and starts the new one from nothing", () => {
    // Step 33 replaces a *finished* Diesel Generator with a Solar Collector.
    const before = replay(33);
    const done = itemIn(before, RELAY, "reactor");
    expect(done.specId).toBe("Diesel Generator");
    expect(done.buyable.done).toBe(true);

    const after = replay(34);
    const fresh = itemIn(after, RELAY, "reactor");
    expect(fresh.specId).toBe("Solar Collector");
    expect(fresh.buyable.done).toBe(false);
    expect(costPaid(fresh.buyable)).toEqual([0, 0, 0]);
    // What the old one was worth is gone with it.
    expect(baseAt(after, RELAY).items.reactor).not.toEqual(done);
  });

  it("leaves a half-built extra of the same spec exactly where it was", () => {
    // Buying the spec that is already there is not a rule refusal and not a restart: upstream
    // simply does nothing at all (`screens/base.py:566`).
    const building = advance(buy(replay(4), RELAY, "Diesel Generator"), 43200).state;
    const partial = itemIn(building, RELAY, "reactor");
    expect(costPaid(partial.buyable)[CASH]).toBeGreaterThan(0);

    const again = buy(building, RELAY, "Diesel Generator");
    expect(itemIn(again, RELAY, "reactor")).toEqual(partial);
    expect(projectPersistent(again)).toEqual(projectPersistent(building));
  });

  it("replaces a CPU of a different spec, which takes the base offline until it is built", () => {
    const before = replay(12);
    const echo = baseAt(before, ECHO);
    expect((echo.items.cpu as ItemState).specId, "the forced CPU the base came with").toBe(
      "Server",
    );
    expect(echo.powerState).toBe("active");

    const after = buy(before, ECHO, "PC");
    const bought = itemIn(after, ECHO, "cpu");
    expect(bought.specId).toBe("PC");
    expect(bought.buyable.done).toBe(false);
    expect(baseAt(after, ECHO).powerState, "no computer, no power").toBe("offline");
    expect(baseAt(after, ECHO).cpu).toBe(0);
    expect(after.availableCpus[0]).toBe((before.availableCpus[0] as number) - echo.cpu);
  });

  it("stacks a CPU of the same spec, pooling cash and restarting the labor", () => {
    // `Item.__iadd__` (`item.py:250`), read straight, on numbers chosen to make each half of
    // the rule visible on its own. The rule itself is compared against the reference on
    // `growing-stack`, which reaches a half-built stack for real.
    const spec = content.items.byId.get("PC");
    if (!spec) throw new Error("no such item: PC");

    const held: ItemState = {
      specId: "PC",
      buyable: {
        totalCost: [1000, 0, 1440],
        costLeft: [200, 0, 240],
        count: 2,
        done: false,
      },
    };
    const stacked = stackItems(held, newItem(spec, 10000, 3));

    expect(stacked.complete).toBe(false);
    expect(stacked.item.buyable.count).toBe(5);
    // Cash pools: what was paid stays paid, and the new ones are added to the bill.
    expect(stacked.item.buyable.totalCost[CASH]).toBe(1000 + 500 * 3);
    expect(costPaid(stacked.item.buyable)[CASH]).toBe(800);
    // Labor does not pool, and it starts again from nothing however nearly done it was.
    expect(stacked.item.buyable.totalCost[LABOR]).toBe(1440);
    expect(costPaid(stacked.item.buyable)[LABOR]).toBe(0);
    expect(stacked.item.buyable.done).toBe(false);
  });

  it("refuses a count the base has no room for, and an item that does not exist", () => {
    const state = replay(12);

    // Server Access is size 1 and already holds one Server, so another Server does not fit.
    expect(() => buy(state, ECHO, "Server")).toThrow(/does not fit/);
    // A different CPU replaces rather than joins, so exactly one of it fits and no more.
    expect(() => buy(state, ECHO, "PC", 2)).toThrow(/does not fit/);
    expect(() => buy(state, ECHO, "PC", 0)).toThrow(/does not fit/);
    expect(() => buy(state, ECHO, "Orbital Abacus")).toThrow(/no such item/);
    expect(() =>
      applyCommand(state, {
        command: "buyItem",
        location: "ATLANTIS",
        base: 0,
        itemType: "PC",
      } satisfies Command),
    ).toThrow(/no such location/);
  });

  // `count` is the CPU slot's alone. Upstream's own caller passes one for every other slot
  // (`screens/base.py:583`), so a reactor, network or security item is built exactly once
  // whatever the dialog asked. A Scenario carrying `count` for one of them therefore says
  // something the game cannot do, and reading it as one and building one anyway is the
  // silent half of that: the file means three and the Trace agrees with a file meaning one.
  // The recorder refuses the same step, in `reference-trace.test.ts`.
  it("refuses a count on a slot that has no count, rather than reading it as one", () => {
    const state = replay(12);

    expect(() => buy(state, RELAY, "Diesel Generator", 3)).toThrow(/only for the cpu slot/);
    // One is refused too. It means what an absent count means, so nothing is lost by
    // allowing it — but then the rule would be "a count of one is a count of one", and a
    // Scenario author would learn the real rule from the one value that does not hold.
    expect(() => buy(state, RELAY, "Diesel Generator", 1)).toThrow(/only for the cpu slot/);
    // Every slot but the CPU's, not the reactor's alone.
    expect(() => buy(state, RELAY, "Warning Signs", 1)).toThrow(/only for the cpu slot/);
    expect(() => buy(state, RELAY, "Network Backbone", 2)).toThrow(/only for the cpu slot/);

    // And it is the count that is refused, not the buy: the same step without one goes
    // through, which is what makes the refusal a fault in the Scenario rather than in the item.
    expect(itemIn(buy(state, RELAY, "Diesel Generator"), RELAY, "reactor").specId).toBe(
      "Diesel Generator",
    );
  });

  it("leaves the State root it was handed alone", () => {
    const before = replay(12);
    const persistent = projectPersistent(before);
    buy(before, ECHO, "PC");
    expect(projectPersistent(before)).toEqual(persistent);
  });
});

describe("what a finished item is worth to its base", () => {
  it("sums the qualities into the base's CPU, and only the finished ones count", () => {
    const before = replay(23);
    const echo = baseAt(before, ECHO);
    expect((echo.items.cpu as ItemState).buyable.done, "the PC is still being built").toBe(false);
    expect(echo.cpu).toBe(0);

    const after = replay(24);
    const built = baseAt(after, ECHO);
    expect((built.items.cpu as ItemState).buyable.done).toBe(true);
    // `PC` is worth one CPU, which the location's own modifier multiplies.
    expect(built.rawCpu).toBe(1);
    expect(built.cpu).toBeGreaterThanOrEqual(1);
    expect(after.availableCpus[0]).toBe((before.availableCpus[0] as number) + built.cpu);
  });

  it("reads the discover modifier into the base's detection profile", () => {
    // Relay holds a finished Diesel Generator at step 23; the same base without it is the
    // comparison, and nothing else about the two differs.
    const state = replay(24);
    const relay = baseAt(state, RELAY);
    expect((relay.items.reactor as ItemState).specId).toBe("Diesel Generator");
    expect((relay.items.reactor as ItemState).buyable.done).toBe(true);

    const bare: BaseState = { ...relay, items: { ...relay.items, reactor: null } };
    const shielded = detectChance(state, relay, "N AMERICA");
    const exposed = detectChance(state, bare, "N AMERICA");

    expect([...exposed.keys()]).toEqual([...shielded.keys()]);
    for (const [groupId, chance] of exposed) {
      expect(shielded.get(groupId), groupId).toBeLessThanOrEqual(chance);
    }
    // And at least one group is measurably harder to be found by.
    expect(
      [...exposed].some(([groupId, chance]) => (shielded.get(groupId) as number) < chance),
    ).toBe(true);
  });
});

describe("an item that finishes", () => {
  it("writes one log entry, counts itself, and the tick recounts the CPU", () => {
    const before = replay(23);
    const after = replay(24);

    expect(after.stats.itemCreated).toBe(before.stats.itemCreated + 2);
    const entries = after.log.filter((entry) => entry.kind === ITEM_CONSTRUCTED);
    expect(entries).toHaveLength(after.stats.itemCreated);

    const written = entries.at(-1);
    expect(written?.rawEmitTime).toBe(after.gameTime);
    expect(written?.fields).toEqual({
      item_spec_id: "PC",
      item_count: 1,
      base_name: "Echo",
      base_type_id: "Server Access",
      base_location_id: "N AMERICA",
    });

    // The recount that closes the tick has run: what the finished item is worth is in the
    // player's total, not only in the base's own.
    expect(after.availableCpus[0]).toBe(
      (before.availableCpus[0] as number) + baseAt(after, ECHO).cpu,
    );
  });

  it("is written into the trace where the reference writes it, after the bases", () => {
    const trace = portTrace();
    const kinds = trace.flatMap((record) => logKinds(record));
    expect(kinds.filter((kind) => kind === ITEM_CONSTRUCTED).length).toBeGreaterThan(0);

    for (const [index, record] of trace.entries()) {
      const before = index === 0 ? [] : logKinds(trace[index - 1] as PortRecord);
      const appended = logKinds(record).slice(before.length);
      if (appended.length === 0) continue;
      // Only an advance finishes anything, and within one tick the bases are logged first.
      expect(record.kind).toBe("advance");
      const firstItem = appended.indexOf(ITEM_CONSTRUCTED);
      if (firstItem >= 0) {
        expect(appended.slice(firstItem).every((kind) => kind === ITEM_CONSTRUCTED)).toBe(true);
      }
    }
  });
});

describe("the items Scenario", () => {
  it("exercises every part of the rule it is named for", () => {
    const scenario = itemsScenario();
    const bought = scenario.script.filter(
      (step) => !("advanceBy" in step) && step.command === "buyItem",
    );
    expect(bought.length).toBeGreaterThanOrEqual(6);

    const last = portTrace().at(-1) as PortRecord;
    const player = last.persistent.player as {
      locations: { bases: { name: string; items: { id: string; done?: boolean }[] }[] }[];
    };
    const bases = player.locations.flatMap((location) => location.bases);

    const relay = bases.find((base) => base.name === "Relay");
    expect(relay?.items.filter((item) => item.done === true)).toHaveLength(3);
    // The reactor was replaced after it was finished, so it is back to being built.
    expect(relay?.items.filter((item) => item.done === undefined)).toHaveLength(1);

    const vault = bases.find((base) => base.name === "Vault");
    expect(
      vault?.items.some((item) => item.done === undefined),
      "an item in an unbuilt base",
    ).toBe(true);

    // Four items ran to completion, and the run ends past the grace period.
    const stats = last.persistent.stats as { item_created: number };
    expect(stats.item_created).toBe(4);
    expect((last.persistent.player as { had_grace: boolean }).had_grace).toBe(false);
  });

  it("is the one the digest manifest knows", async () => {
    const manifest = JSON.parse(
      await import("node:fs").then((fs) =>
        fs.readFileSync(resolve(scenarioDirectory, "manifest.json"), "utf8"),
      ),
    ) as { scenarios: Record<string, { steps: number }> };

    expect(manifest.scenarios[ITEMS]?.steps).toBe(itemsScenario().script.length);
  });
});

/**
 * What `growing-stack` is for, read off the port's own replay of it.
 *
 * The comparison above is the proof; this is the statement of what it covers, so a later
 * edit that shortens the script or moves a buy cannot quietly turn the comparison into a
 * second `cpu-stacking`. Every figure here was measured on this Scenario.
 */
describe("the growing-stack Scenario", () => {
  /** The Storage Unit, built after the eight Server Access relays that pay for it. */
  const DEPOT = 8;

  let replayed: readonly SimulationState[] | undefined;
  function states(): readonly SimulationState[] {
    return (replayed ??= replayStates(scenarioNamed(GROWING_STACK)));
  }

  /** The three buys: the first stack, the merge into a part-built one, the merge into a finished one. */
  function buys(): readonly number[] {
    return scenarioNamed(GROWING_STACK).script.flatMap((step, index) =>
      !("advanceBy" in step) && step.command === "buyItem" ? [index] : [],
    );
  }

  function at(step: number): SimulationState {
    const state = states()[step];
    if (!state) throw new Error(`growing-stack has no step ${step}`);
    return state;
  }

  function stackAt(step: number): ItemState {
    return itemIn(at(step), DEPOT, "cpu");
  }

  it("has three buys into one slot, the last two of them merges", () => {
    expect(buys()).toHaveLength(3);
  });

  it("works the pair on before it is grown, which cpu-stacking never does", () => {
    const [, second] = buys();
    const working = at((second as number) - 1);
    expect(baseAt(working, DEPOT).buyable.done, "the Storage Unit is finished").toBe(true);

    const pair = itemIn(working, DEPOT, "cpu");
    expect(pair.buyable.count).toBe(2);
    expect(pair.buyable.done).toBe(false);
    // Two hours of a six-hour labor bill, and the cash the same fraction carried.
    expect(costPaid(pair.buyable)).toEqual([333, 0, 120]);

    // `cpu-stacking` merges into a stack in a base that is still being built, so the item it
    // grows has never been worked on and the rule below has nothing to act on.
    const stacking = scenarioNamed(CPU_STACKING);
    const firstBuy = stacking.script.findIndex(
      (step) => !("advanceBy" in step) && step.command === "buyItem",
    );
    const bought = replayStates(stacking)[firstBuy] as SimulationState;
    expect(baseAt(bought, 0).buyable.done, "its Storage Unit never finishes").toBe(false);
    const untouched = itemIn(bought, 0, "cpu");
    expect(untouched.buyable.count).toBe(4);
    expect(costPaid(untouched.buyable)).toEqual([0, 0, 0]);
  });

  it("keeps the cash the pair had paid and starts its labor again from nothing", () => {
    const [, second] = buys();
    const grown = stackAt(second as number);

    expect(grown.buyable.count).toBe(5);
    // Cash pools: 1000 for the pair plus 500 each for the three, and the 333 stays paid.
    expect(grown.buyable.totalCost).toEqual([2500, 0, 360]);
    expect(costPaid(grown.buyable)).toEqual([333, 0, 0]);
    expect(grown.buyable.done).toBe(false);
  });

  it("takes the base's CPU away when the stack it grows was finished", () => {
    const [, , third] = buys();
    const before = at((third as number) - 1);
    const running = itemIn(before, DEPOT, "cpu");
    expect(running.buyable.done, "five PCs, finished and holding the base up").toBe(true);
    expect(baseAt(before, DEPOT).rawCpu).toBe(5);
    expect(baseAt(before, DEPOT).powerState).toBe("active");

    const after = at(third as number);
    const grown = itemIn(after, DEPOT, "cpu");
    expect(grown.buyable.count).toBe(8);
    expect(grown.buyable.done).toBe(false);
    expect(grown.buyable.totalCost).toEqual([4000, 0, 360]);
    // Everything the five had paid stays paid; the labor of all eight starts again.
    expect(costPaid(grown.buyable)).toEqual([2500, 0, 0]);
    expect(baseAt(after, DEPOT).rawCpu, "no CPU until the grown stack is built").toBe(0);
    expect(baseAt(after, DEPOT).powerState).toBe("offline");
  });

  it("finishes the grown stack, inside the grace period, so nothing else moves", () => {
    const last = at(states().length - 1);
    const stack = itemIn(last, DEPOT, "cpu");

    expect(stack.buyable.done).toBe(true);
    expect(stack.buyable.count).toBe(8);
    expect(baseAt(last, DEPOT).rawCpu).toBe(8);
    expect(baseAt(last, DEPOT).powerState).toBe("active");
    // Two items finished — the five and then the eight — and no detection ever rolled.
    expect(last.stats.itemCreated).toBe(2);
    expect(last.hadGrace).toBe(true);
  });

  it("is the one the digest manifest knows", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(scenarioDirectory, "manifest.json"), "utf8"),
    ) as { scenarios: Record<string, { steps: number }> };

    expect(manifest.scenarios[GROWING_STACK]?.steps).toBe(
      scenarioNamed(GROWING_STACK).script.length,
    );
  });
});

function logKinds(record: PortRecord): string[] {
  return (record.persistent.player as { log: { log_id: string }[] }).log.map(
    (entry) => entry.log_id,
  );
}
