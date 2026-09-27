// boundary-intent harness: a test, so it decides what to drive and what to expect
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import {
  BASE_CONSTRUCTED,
  CPU,
  DISPLAY_DISCOVER,
  SECONDS_PER_DAY,
  TECH_RESEARCHED,
  advance,
  applyCommand,
  consideredBases,
  content,
  costPaid,
  createInitialState,
  finishedTechs,
  internalId,
  isAvailable,
  projectDerived,
  projectPersistent,
  recalcCpu,
  resourceFlow,
  restorePersistent,
  Rng,
  type FinishedTechs,
  type Command,
  type SimulationState,
  type TechState,
} from "../src/index.ts";
import { compareTraces, explain } from "./support/fidelity.ts";
import { asReferenceFlow } from "./support/flow.ts";
import {
  oracleAvailable,
  oracleRequired,
  referenceAllocationOrder,
  referenceResourceFlow,
  referenceTrace,
  runOracle,
} from "./support/oracle.ts";
import {
  SCENARIO_SUFFIX,
  isAdvance,
  loadScenario,
  scenarioDirectory,
  scenarioPaths,
  type Scenario,
} from "./support/scenario.ts";
import { recordTrace, replayStates } from "./support/trace.ts";

/**
 * The fifth fidelity Scenario, and the one that lets the player direct effort: `research`
 * allocates CPU to techs, finishes three of them, and leaves two unfinished for the reason
 * that decides this whole slice — the allocation *order*, not the need, is what settles who
 * is paid when the cash runs out.
 *
 * Three subtleties in the reference decide the phase and all three are behaviour rather than
 * arrangement, so all three are pinned here as well as inside the Scenario:
 *
 * - A tech's CPU is added to the pool and then spent from it, so the accounting nets out
 *   while the tech itself stays capped at its own allocation.
 * - The **full** cash balance is offered to every tech in turn and each deducts what it
 *   spends immediately, so the one allocated first is paid first.
 * - The CPU nobody asked for lands in the pool **last**, after research has already run, so
 *   research can never reach it.
 *
 * `head-start` is compared here too. It is the only way a Scenario reaches `display_discover`
 * at all: the two techs that switch it on cost thousands of CPU-days to research, and a
 * difficulty that grants them finished is how the reference gets there in one step.
 */

const runsTheOracle = oracleAvailable || oracleRequired;
const describeOracle = describe.skipIf(!runsTheOracle);

const RESEARCH = "research";
const DAY = SECONDS_PER_DAY;

/** Step indices into `research.scenario.json`, so a shifted script fails loudly. */
const BEFORE_FIRST_TICK = 11;
const BEFORE_INTRUSION_FINISHES = 13;
const BEFORE_THE_CASH_RUNS_SHORT = 21;

function researchScenario() {
  return loadScenario(resolve(scenarioDirectory, `${RESEARCH}${SCENARIO_SUFFIX}`));
}

/** The state after replaying the Scenario's first `steps` steps, without recording anything. */
function replay(steps: number): SimulationState {
  const scenario = researchScenario();
  let state = createInitialState({ seed: scenario.seed, difficulty: scenario.difficulty });
  for (const step of scenario.script.slice(0, steps)) {
    state = "advanceBy" in step ? advance(state, step.advanceBy).state : applyCommand(state, step);
  }
  return state;
}

function techIn(state: SimulationState, techId: string): TechState {
  const tech = state.techs.find((candidate) => candidate.specId === techId);
  if (!tech) throw new Error(`no such tech: ${techId}`);
  return tech;
}

/** What a tech has been paid in CPU-seconds so far. */
function paidCpu(state: SimulationState, techId: string): number {
  return costPaid(techIn(state, techId).buyable)[CPU];
}

/** What a tech costs in CPU-seconds altogether. */
function totalCpu(state: SimulationState, techId: string): number {
  return techIn(state, techId).buyable.totalCost[CPU];
}

function allocation(state: SimulationState, taskId: string): number | undefined {
  return state.cpuUsage.find((candidate) => candidate.taskId === taskId)?.cpu;
}

function allocate(state: SimulationState, task: string, cpu: number): SimulationState {
  return applyCommand(state, { command: "allocateCpu", task, cpu } satisfies Command);
}

describeOracle("a game the player directs effort in", () => {
  it("matches the reference on every part of every record", () => {
    const scenario = researchScenario();
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

  /**
   * `Player.compute_future_resource_flow` (`player.py:770`) as a Projection: a State root
   * goes in, the two dry-run halves come out, and nothing is written anywhere.
   *
   * `research` is what the comparison needs in one script — bases under construction on the
   * first steps, techs allocated from step 11 on, and the CPU nobody asked for reaching jobs
   * through the pool. It is compared step for step rather than at one chosen state, because
   * every branch of the routine is entered by a different shape of estate and the run walks
   * through several of them.
   */
  it("computes the reference's own resource flow, step for step", () => {
    const scenario = researchScenario();
    const reference = referenceResourceFlow(`scenarios/${scenario.id}${SCENARIO_SUFFIX}`);
    const port = replayStates(scenario).map((state) => asReferenceFlow(resourceFlow(state)));

    expect(port).toHaveLength(reference.length);
    expect(port).toEqual(reference);
  });

  // The comparison above is only worth its run if the Scenario reaches the branches. Read
  // off the reference's own answers rather than off the port's, so it says what the *other*
  // side of the comparison was made to do.
  it("drives it through construction, research and job earnings", () => {
    const flows = referenceResourceFlow(`scenarios/${RESEARCH}${SCENARIO_SUFFIX}`);

    expect(flows.some((flow) => (flow.cash.construction_needed ?? 0) > 0)).toBe(true);
    expect(flows.some((flow) => (flow.cash.tech ?? 0) > 0)).toBe(true);
    expect(flows.some((flow) => (flow.cpu.tech ?? 0) > 0)).toBe(true);
    expect(flows.some((flow) => (flow.cash.jobs ?? 0) > 0)).toBe(true);
    expect(flows.some((flow) => (flow.cash.maintenance_needed ?? 0) > 0)).toBe(true);
  });

  /**
   * The hypothetical, which is the whole reason this is a Projection rather than a field.
   *
   * Upstream's build dialog writes its fake bases onto `Player.considered_buyables` and the
   * routine reads them back out; here they are an argument. The recorder writes
   * the field for the length of one call so that both sides are asked the same question,
   * and what is compared is that the *answers* agree — including where the order runs the
   * CPU pool dry and the cash estimate falls short of what the order would cost.
   */
  it("answers the same with an order the player is only considering", () => {
    const scenario = researchScenario();
    const order = { location: "N AMERICA", baseType: "Datacenter", count: 3 };
    const reference = referenceResourceFlow(`scenarios/${scenario.id}${SCENARIO_SUFFIX}`, [order]);
    const spec = content.bases.byId.get(order.baseType);
    if (!spec) throw new Error(`no such base type: ${order.baseType}`);

    const port = replayStates(scenario).map((state) =>
      asReferenceFlow(
        resourceFlow(state, consideredBases(state, order.location, spec, order.count)),
      ),
    );

    expect(port).toHaveLength(reference.length);
    expect(port).toEqual(reference);
  });

  // And the argument is not decorative: an order the player is considering moves the answer.
  it("costs the considered order into the flow rather than ignoring it", () => {
    const scenario = researchScenario();
    const idle = referenceResourceFlow(`scenarios/${scenario.id}${SCENARIO_SUFFIX}`);
    const considering = referenceResourceFlow(`scenarios/${scenario.id}${SCENARIO_SUFFIX}`, [
      { location: "N AMERICA", baseType: "Datacenter", count: 3 },
    ]);

    expect(considering).not.toEqual(idle);
    expect(
      considering.filter(
        (flow, step) =>
          (flow.cash.construction_needed ?? 0) > (idle[step]?.cash.construction_needed ?? 0),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("matches the reference where the difficulty grants finished techs", () => {
    const scenario = loadScenario(resolve(scenarioDirectory, `head-start${SCENARIO_SUFFIX}`));
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
});

describe("a tech's CPU", () => {
  // The netting is the whole of the rule: `real_cpu` goes into the pool and `work_on` takes
  // what it spent back out of the same pool (`player.py:341`, `buyable.py:203`), so a tick's
  // pool is the player's whole CPU minus what research consumed — however the allocations are
  // spread. What stops a tech reaching further is that it is offered `real_cpu` rather than
  // the pool, which is a different number from the moment anything else is allocated.
  it("is added to the pool and spent from it, and never reaches past its own allocation", () => {
    const before = replay(BEFORE_INTRUSION_FINISHES);
    const available = before.availableCpus[0] as number;
    expect(allocation(before, "Stock Manipulation")).toBe(40);
    expect(available).toBeGreaterThan(40 + (allocation(before, "Intrusion") as number));

    const after = advance(before, DAY).state;

    // Its own allocation, not the pool the whole estate filled.
    expect(paidCpu(after, "Stock Manipulation")).toBe(40 * DAY);
    // And a tech is capped the other way too: Intrusion was allocated 60 and cost 15.
    expect(paidCpu(after, "Intrusion")).toBe(totalCpu(after, "Intrusion"));

    const spent = paidCpu(after, "Intrusion") + paidCpu(after, "Stock Manipulation");
    expect(after.cpuPool).toBe(available * DAY - spent);
  });

  // The discriminating case for "the unallocated CPU lands last": one CPU on a tech, a
  // hundred unallocated. A pool filled before research ran would carry the tech to the end of
  // its cost in a single tick; upstream's order leaves it a hundredth of the way there.
  it("is what the tech gets even when the pool around it is a hundred times larger", () => {
    const before = allocate(replay(BEFORE_FIRST_TICK), "Stock Manipulation", 1);
    const available = before.availableCpus[0] as number;
    expect(available).toBeGreaterThan(100);

    const after = advance(before, DAY).state;

    expect(paidCpu(after, "Stock Manipulation")).toBe(1 * DAY);
    expect(after.cpuPool).toBe(available * DAY - 1 * DAY);
  });

  // Upstream's `work_on` returns before it touches anything when the buyable is done
  // (`buyable.py:198`), but the loop has already added the allocation to the pool. So CPU
  // pointed at a finished tech is a roundabout way of pointing it at the pool.
  it("reaches the pool untouched when the tech is already finished", () => {
    const before = replay(BEFORE_INTRUSION_FINISHES + 1);
    expect(techIn(before, "Intrusion").buyable.done).toBe(true);

    const idle = advance(before, DAY).state;
    const pointed = advance(allocate(before, "Intrusion", 7), DAY).state;

    expect(paidCpu(pointed, "Intrusion")).toBe(paidCpu(idle, "Intrusion"));
    expect(pointed.cpuPool).toBe(idle.cpuPool);
    expect(allocation(pointed, "Intrusion")).toBe(7);
  });
});

// `work_on` is handed `self.cash` — the whole balance, every time — and subtracts what it
// spent from it before the next tech is asked (`buyable.py:204`). So two techs that both want
// more cash than there is do not share it: the first one allocated takes what it can and the
// second is left with the remainder, which is often nothing.
describe("cash a tick cannot cover", () => {
  it("goes to whichever tech was allocated first", () => {
    const before = replay(BEFORE_THE_CASH_RUNS_SHORT);
    // Telepresence costs 15,000 and Stealth 800, against a balance in the hundreds: whichever
    // runs first is paid, and the other is held back by cash rather than by CPU.
    const telepresenceFirst = advance(
      allocate(allocate(before, "Telepresence", 20), "Stealth", 40),
      DAY,
    ).state;
    const stealthFirst = advance(
      allocate(allocate(before, "Stealth", 40), "Telepresence", 20),
      DAY,
    ).state;

    expect(paidCpu(telepresenceFirst, "Telepresence")).toBe(20 * DAY);
    expect(paidCpu(telepresenceFirst, "Stealth")).toBeLessThan(40 * DAY);

    expect(paidCpu(stealthFirst, "Stealth")).toBe(40 * DAY);
    expect(paidCpu(stealthFirst, "Telepresence")).toBeLessThan(20 * DAY);
  });

  // Re-allocating a task that is already there must not promote it to the end of the queue:
  // `cpu_usage` is a dict, and assigning to a key it already holds leaves the key where it is.
  it("is unmoved by re-allocating a task that was already allocated", () => {
    const before = replay(BEFORE_THE_CASH_RUNS_SHORT);
    const ordered = allocate(allocate(before, "Telepresence", 20), "Stealth", 40);

    const asIs = advance(ordered, DAY).state;
    const reallocated = advance(allocate(ordered, "Telepresence", 20), DAY).state;

    expect(reallocated.cpuUsage).toEqual(ordered.cpuUsage);
    expect(paidCpu(reallocated, "Stealth")).toBe(paidCpu(asIs, "Stealth"));
  });
});

/**
 * The order itself, compared against the reference rather than inferred from who was paid.
 *
 * The rule above is pinned by its consequence: the Scenario is arranged so that the order
 * decides *who gets the cash*, and that reaches the compared surface. The order does not. A
 * Trace record carries `cpu_usage` in upstream's own save schema — an object — and the
 * recorder's canonical line sorts every object's keys, because that line is what the digest
 * manifest is measured on. Both differs then walk it by sorted name, so two
 * traces whose allocations differ only in order compare equal, and a port that lost the
 * order would go red only where a Scenario happened to be short of cash at that moment.
 *
 * So the order is recorded beside the trace, by the same run through the same script, and
 * compared on its own.
 */
describeOracle("the order of the allocations", () => {
  const allocating: readonly Scenario[] = scenarioPaths()
    .map(loadScenario)
    .filter((scenario) =>
      scenario.script.some((step) => !isAdvance(step) && step.command === "allocateCpu"),
    );

  const referenceOrders = new Map<string, readonly (readonly string[])[]>();

  function referenceOrder(scenario: Scenario): readonly (readonly string[])[] {
    const cached = referenceOrders.get(scenario.id);
    if (cached) return cached;
    const fresh = referenceAllocationOrder(`scenarios/${scenario.id}${SCENARIO_SUFFIX}`);
    referenceOrders.set(scenario.id, fresh);
    return fresh;
  }

  /** The keys of the port's projected `cpu_usage`, in the order the projection wrote them. */
  function portOrder(scenario: Scenario): readonly (readonly string[])[] {
    return recordTrace(scenario).records.map((record) => {
      const player = (record.persistent as { player: { cpu_usage: Record<string, number> } })
        .player;
      return Object.keys(player.cpu_usage);
    });
  }

  /** The first step of the first Scenario whose order is not the sorted one. */
  function firstUnsorted(): { scenario: Scenario; step: number; order: readonly string[] } {
    for (const scenario of allocating) {
      const orders = referenceOrder(scenario);
      const step = orders.findIndex((order) => !isSorted(order));
      if (step !== -1) return { scenario, step, order: orders[step] as readonly string[] };
    }
    throw new Error("no committed Scenario reaches an allocation order that sorting would move");
  }

  it("matches the reference, step for step, in every Scenario that allocates CPU", () => {
    expect(allocating.map((scenario) => scenario.id)).toContain(RESEARCH);

    for (const scenario of allocating) {
      expect(portOrder(scenario), scenario.id).toEqual(referenceOrder(scenario));
    }
  });

  // The comparison above says nothing unless something in it is *not* alphabetical: a port
  // that sorted its allocations would satisfy an all-sorted set of Scenarios exactly.
  it("is not the sorted order, in a Scenario that is compared", () => {
    const { order } = firstUnsorted();

    expect([...order]).not.toEqual([...order].sort());
  });

  // And this is why the comparison above exists at all rather than riding on the record.
  // Should a later change make a Trace record carry the order, this goes red and the
  // separate run can be taken out.
  it("is dropped by the record the two Traces are compared on", () => {
    const { scenario, step, order } = firstUnsorted();
    const record = referenceTrace(`scenarios/${scenario.id}${SCENARIO_SUFFIX}`).records[step];
    const player = (record as unknown as { persistent: { player: { cpu_usage: object } } })
      .persistent.player;

    expect(Object.keys(player.cpu_usage)).toEqual([...order].sort());
    expect(Object.keys(player.cpu_usage)).not.toEqual([...order]);
  });
});

function isSorted(keys: readonly string[]): boolean {
  return keys.every((key, index) => index === 0 || (keys[index - 1] as string) <= key);
}

describe("a tech that completes", () => {
  it("loses its allocation and appends its log entry in the completion phase", () => {
    const before = replay(BEFORE_INTRUSION_FINISHES);
    expect(allocation(before, "Intrusion")).toBe(60);

    const after = advance(before, DAY).state;

    expect(allocation(after, "Intrusion")).toBeUndefined();
    // Only the one that finished: the rest of the allocations stand.
    expect(allocation(after, "Stock Manipulation")).toBe(40);
    expect(after.log.slice(before.log.length)).toEqual([
      { kind: TECH_RESEARCHED, rawEmitTime: after.gameTime, fields: { tech_id: "Intrusion" } },
    ]);
    expect(after.stats.techCreated).toBe(before.stats.techCreated + 1);
  });

  // The completion phase is one list after another, in upstream's order (`player.py:386-412`),
  // and the log is what preserves it.
  it("writes its entry before a base that finished in the same tick", () => {
    const before = applyCommand(replay(BEFORE_INTRUSION_FINISHES), {
      command: "buildBase",
      location: "N AMERICA",
      baseType: "Server Access",
      name: "Late",
    } satisfies Command);

    const after = advance(before, DAY).state;

    expect(after.log.slice(before.log.length).map((entry) => entry.kind)).toEqual([
      TECH_RESEARCHED,
      BASE_CONSTRUCTED,
    ]);
  });

  // `Tech.finish` triggers the consequence where the tech finished, inside the research loop
  // (`tech.py:81`) — not in the completion phase, and not at the end of the tick.
  it("applies its consequence on the tick it finished", () => {
    let state = replay(BEFORE_INTRUSION_FINISHES);
    const before = state.interestRate;

    // `Stock Manipulation` is `interest 10`, and it is the only thing in this run that moves
    // the rate.
    for (let day = 0; day < 8 && techIn(state, "Stock Manipulation").buyable.done === false;) {
      expect(state.interestRate).toBe(before);
      state = advance(state, DAY).state;
      day += 1;
    }
    expect(techIn(state, "Stock Manipulation").buyable.done).toBe(true);
    expect(state.interestRate).toBe(before + 10);
  });
});

/**
 * Everything a finished tech is worth is **derived**, not persisted: `Player.serialize_obj`
 * writes a tech as one `done` flag (`player.py:629`), and the interest rate, income, bonuses
 * and readout that follow from it exist after a load only because upstream re-triggers every
 * finished tech's consequence on the way in (`buyable.py:239`, `tech.py:81`). That is exactly
 * why the derived half is in a Trace record at all — a fault in the replay shows up
 * there rather than in a save nobody can read back.
 */
describe("a Save taken in the middle of research", () => {
  function saveAndLoad(state: SimulationState): SimulationState {
    return restorePersistent(projectPersistent(state), Rng.fromState(state.rng.toState()), {
      startDay: state.startDay,
    });
  }

  /**
   * The Scenario's state with its OCEAN base taken out first.
   *
   * `Player.serialize_obj` writes out only the locations the player can reach
   * (`player.py:639`), and OCEAN stands behind a tech nothing in this run researches — so the
   * base the Scenario deliberately put there to move `available_cpus[1]` is not in a Save at
   * all, and a round trip that kept it would be testing something upstream does not do.
   */
  function saveable(steps: number): SimulationState {
    return applyCommand(replay(steps), {
      command: "destroyBase",
      location: "OCEAN",
      base: 0,
    } satisfies Command);
  }

  it("rebuilds the standing consequences of every tech it says is finished", () => {
    const state = saveable(BEFORE_THE_CASH_RUNS_SHORT);
    expect(state.interestRate).toBe(11);

    const restored = saveAndLoad(state);

    // `cpu_pool` is a tick's own working figure and upstream loses it across a load too.
    const { cpu_pool: _pool, ...derived } = projectDerived(state);
    const { cpu_pool: _restoredPool, ...restoredDerived } = projectDerived(restored);
    expect(restoredDerived).toEqual(derived);
    expect(projectPersistent(restored)).toEqual(projectPersistent(state));
  });

  it("keeps the allocations, in the order that decides who is paid first", () => {
    const state = allocate(
      allocate(saveable(BEFORE_THE_CASH_RUNS_SHORT), "Telepresence", 20),
      "Stealth",
      40,
    );

    const restored = saveAndLoad(state);

    expect(restored.cpuUsage).toEqual(state.cpuUsage);
    // And the order is behaviour, not bookkeeping: the run continues the same way.
    expect(projectPersistent(advance(restored, DAY).state)).toEqual(
      projectPersistent(advance(state, DAY).state),
    );
  });

  // `Player.deserialize_obj`'s own loop drops it (`player.py:743`): a Save can be older than
  // the Content it is read against, and CPU pointed at a tech this build cannot research is
  // not an allocation any more.
  it("drops an allocation pointed at a tech that is no longer available", () => {
    const state = saveable(BEFORE_THE_CASH_RUNS_SHORT);
    const saved = projectPersistent(state) as {
      player: { cpu_usage: Record<string, number> };
    };
    const tampered = {
      ...saved,
      player: {
        ...saved.player,
        cpu_usage: { ...saved.player.cpu_usage, [internalId("tech", "Simulacra")]: 5 },
      },
    };

    const restored = restorePersistent(tampered, Rng.fromState(state.rng.toState()), {
      startDay: state.startDay,
    });

    expect(allocation(restored, "Simulacra")).toBeUndefined();
    expect(restored.cpuUsage).toEqual(state.cpuUsage);
  });
});

describe("prerequisites", () => {
  // The reading is one method on one class that techs, bases, items, locations and tasks all
  // inherit (`prerequisite.py:31`), so it is checked against the reference for all of them at
  // once rather than through whichever of them a Scenario happens to reach.
  const AVAILABILITY_PROBE = (finished: readonly string[]): string =>
    [
      "import contextlib,io,json,os,random,sys",
      'sys.path.insert(0, os.path.join(os.getcwd(), "tools", "oracle"))',
      'sys.path.insert(0, os.path.join(os.getcwd(), "singularity"))',
      "import pygame_stub; pygame_stub.install()",
      "from singularity.code import data, dirs, g",
      "buf = io.StringIO()",
      "with contextlib.redirect_stdout(buf):",
      "    dirs.create_directories(True)",
      "    data.reload_all()",
      "    random.seed(1)",
      '    g.new_game("normal", 1)',
      `    for tech_id in ${JSON.stringify([...finished])}:`,
      "        g.pl.techs[tech_id].finish(is_player=False, loading_savegame=True)",
      "print(json.dumps({",
      '  "techs": {i: s.available() for i, s in g.techs.items()},',
      '  "bases": {i: s.available() for i, s in g.base_type.items()},',
      '  "items": {i: s.available() for i, s in g.items.items()},',
      '  "locations": {i: s.available() for i, s in g.locations.items()},',
      "}))",
    ].join("\n");

  function referenceAvailability(finished: readonly string[]) {
    const probe = runOracle(["-c", AVAILABILITY_PROBE(finished)]);
    expect(probe.status, probe.stderr).toBe(0);
    return JSON.parse(probe.stdout) as Record<string, Record<string, boolean>>;
  }

  const oracleIt = it.skipIf(!runsTheOracle);

  oracleIt("read the same way the reference reads them, for techs, bases and items", () => {
    // Two of the three shapes the loader recognises are reachable in the shipped Content and
    // both are in the answer: an `all` list of one, of two and of three — `Simulacra` needs
    // three techs at once — and `impossible`, which is `ORBIT` and which nothing satisfies.
    // The third, `OR`, appears nowhere in the Content and is exercised on a record of the
    // loader suite's own making (`content.trace.test.ts`).
    const finished = ["Intrusion", "Personal Identification", "Stealth", "Sociology"];
    const reference = referenceAvailability(finished);
    const done: FinishedTechs = new Set(finished);

    const port = {
      techs: Object.fromEntries(
        content.techs.all.map((tech) => [tech.id, isAvailable(tech.prerequisites, done)]),
      ),
      bases: Object.fromEntries(
        content.bases.all.map((base) => [base.id, isAvailable(base.prerequisites, done)]),
      ),
      items: Object.fromEntries(
        content.items.all.map((item) => [item.id, isAvailable(item.prerequisites, done)]),
      ),
      locations: Object.fromEntries(
        content.locations.all.map((place) => [place.id, isAvailable(place.prerequisites, done)]),
      ),
    };

    expect(port).toEqual(reference);
    // The comparison would pass on two tables of `false`, and does not: the free techs open
    // some of each kind and leave the rest shut.
    for (const kind of ["techs", "bases", "items", "locations"] as const) {
      const values = Object.values(port[kind]);
      expect(values).toContain(true);
      expect(values).toContain(false);
    }
  });

  // `set_allocated_cpu_for` asserts availability (`player.py:246`), which is the one rule the
  // Command layer enforces — see `sim/src/command.ts`.
  it("refuse CPU pointed at a tech whose prerequisites are not met", () => {
    const state = replay(BEFORE_FIRST_TICK);

    expect(() => allocate(state, "Simulacra", 1)).toThrow(/not available/);
    expect(() => allocate(state, "Telekinesis", 1)).toThrow(/unknown task/);
    expect(() => allocate(state, "Intrusion", 1)).not.toThrow();

    // The negative refusal is narrower than the availability one, because upstream's `elif`
    // chain never reaches it for a tech. Preserved rather than tidied.
    expect(() => allocate(state, "jobs", -1)).toThrow(/negative/);
    expect(() => allocate(state, "Intrusion", -1)).not.toThrow();
  });
});

/**
 * Deviation 5: the cap upstream leaves to the research screen's slider maximum
 * (`screens/research.py:183`) is the Command's own rule here. Clamped, not refused.
 */
describe("the allocation cap", () => {
  it("clamps an allocation to the task's own share plus the CPU still unallocated", () => {
    const state = replay(BEFORE_FIRST_TICK);
    const available = state.availableCpus[0] as number;
    expect(state.cpuUsage).toEqual([]);

    const greedy = allocate(state, "Intrusion", available + 1000);
    expect(allocation(greedy, "Intrusion")).toBe(available);

    // Under the cap, the Command stores what it was asked — including taking CPU back.
    const modest = allocate(greedy, "Intrusion", 3);
    expect(allocation(modest, "Intrusion")).toBe(3);

    // And a second task is offered only the remainder.
    expect(allocation(allocate(modest, "jobs", available), "jobs")).toBe(available - 3);
  });

  // The preserved defect above stays out of the cap's reach: `min` leaves a negative alone.
  it("stores a negative tech allocation as handed, not clamped up to zero", () => {
    const state = allocate(replay(BEFORE_FIRST_TICK), "Intrusion", -1);

    expect(allocation(state, "Intrusion")).toBe(-1);
  });
});

describe("display_discover", () => {
  it("is simulation state with three values", () => {
    expect([...DISPLAY_DISCOVER]).toEqual(["none", "partial", "full"]);
  });

  // Reached by tech and by nothing else: `Socioanalytics` sets it to `partial` and
  // `Advanced Socioanalytics` to `full` (`effect.py:54`), and a difficulty that grants them
  // finished applies the same instruction at creation. That is the only reach a Scenario has,
  // which is why every difficulty is compared rather than the one a Scenario runs.
  const oracleIt = it.skipIf(!runsTheOracle);

  oracleIt("reaches its values by the techs the reference reaches them by", () => {
    const probe = runOracle([
      "-c",
      [
        "import contextlib,io,json,os,random,sys",
        'sys.path.insert(0, os.path.join(os.getcwd(), "tools", "oracle"))',
        'sys.path.insert(0, os.path.join(os.getcwd(), "singularity"))',
        "import pygame_stub; pygame_stub.install()",
        "from singularity.code import data, difficulty, dirs, g",
        "buf = io.StringIO()",
        "found = {}",
        "with contextlib.redirect_stdout(buf):",
        "    dirs.create_directories(True)",
        "    data.reload_all()",
        "    for name in difficulty.difficulties:",
        "        random.seed(1)",
        "        g.new_game(name, 1)",
        "        found[name] = [g.pl.display_discover,",
        "                       sorted(t.spec.id for t in g.pl.techs.values() if t.done)]",
        "print(json.dumps(found))",
      ].join("\n"),
    ]);
    expect(probe.status, probe.stderr).toBe(0);
    const reference = JSON.parse(probe.stdout) as Record<string, [string, string[]]>;

    const port = Object.fromEntries(
      content.difficulties.all.map((spec) => {
        const state = createInitialState({ seed: 1, difficulty: spec.id });
        return [
          spec.id,
          [state.displayDiscover, [...finishedTechs(state.techs)].sort()] as [string, string[]],
        ];
      }),
    );

    expect(port).toEqual(reference);
    // All three values appear, so the comparison is not two tables of "none".
    const reached = new Set(Object.values(port).map(([value]) => value));
    expect([...reached].sort()).toEqual(["full", "none", "partial"]);
  });
});

/**
 * `Player.recalc_cpu`'s second half (`player.py:499`): when a danger level is asked for more
 * CPU than it has, every allocation *at that level* is scaled by the same fraction and
 * truncated.
 *
 * The Scenario pins the level-0 case five times over, by destroying bases out from under a
 * set of allocations. It cannot reach any other level: a task's danger is its tech's, every
 * tech with a danger above zero stands behind prerequisites costing tens of thousands of
 * CPU-days, and `set_allocated_cpu_for` refuses an unavailable one. So the multi-level case is
 * built rather than played, on both sides, and compared.
 */
describe("the recount when a danger level is oversubscribed", () => {
  const CLAMP_PROBE = [
    "import contextlib,io,json,os,random,sys",
    'sys.path.insert(0, os.path.join(os.getcwd(), "tools", "oracle"))',
    'sys.path.insert(0, os.path.join(os.getcwd(), "singularity"))',
    "import pygame_stub; pygame_stub.install()",
    "from singularity.code import base as base_mod, data, dirs, g",
    "class Screen:",
    "    def __getattr__(self, name): return lambda *a, **k: None",
    "    def __setattr__(self, n, v): object.__setattr__(self, n, v)",
    "buf = io.StringIO()",
    "with contextlib.redirect_stdout(buf):",
    "    dirs.create_directories(True)",
    "    data.reload_all()",
    "    random.seed(1)",
    "    g.map_screen = Screen()",
    '    g.new_game("normal", 1)',
    '    for tech_id in ["Intrusion", "Telepresence", "Parallel Computation",',
    '                    "Microchip Design", "Autonomous Vehicles"]:',
    "        g.pl.techs[tech_id].finish(is_player=False, loading_savegame=True)",
    '    for loc_id, count in (("N AMERICA", 3), ("OCEAN", 2)):',
    "        for index in range(count):",
    '            built = base_mod.Base("B%d" % index, g.base_type["Server Access"], built=True)',
    "            g.pl.locations[loc_id].add_base(built)",
    '    g.pl.cpu_usage = {"jobs": 30, "Heat Signature Reduction": 40, "cpu_pool": 20}',
    "    g.pl.recalc_cpu()",
    'print(json.dumps({"available": [int(x) for x in g.pl.available_cpus],',
    '                  "usage": dict(g.pl.cpu_usage)}))',
  ].join("\n");

  /**
   * The same estate, built with Commands and paid off by one tick — where the probe above
   * builds it finished, because the reference has no Command for that. Neither of the two
   * things compared depends on the difference: what a base is worth in CPU and which danger
   * levels its location covers are the same on the day it finishes as on any later one.
   */
  function estate(): SimulationState {
    let state = createInitialState({ seed: 1, difficulty: "normal" });
    for (const [location, count] of [
      ["N AMERICA", 3],
      ["OCEAN", 2],
    ] as const) {
      for (let index = 0; index < count; index += 1) {
        state = applyCommand(state, {
          command: "buildBase",
          location,
          baseType: "Server Access",
          name: `B${index}`,
        } satisfies Command);
      }
    }
    return advance(state, DAY).state;
  }

  const oracleIt = it.skipIf(!runsTheOracle);

  oracleIt("scales every allocation at that level, and each one only once", () => {
    const probe = runOracle(["-c", CLAMP_PROBE]);
    expect(probe.status, probe.stderr).toBe(0);
    const reference = JSON.parse(probe.stdout) as {
      available: number[];
      usage: Record<string, number>;
    };

    // The allocation is built rather than commanded: `Heat Signature Reduction` carries
    // danger 1 and its prerequisite is unmet, so the Command refuses it exactly as the
    // reference's own setter does.
    const before: SimulationState = {
      ...estate(),
      cpuUsage: [
        { taskId: "jobs", cpu: 30 },
        { taskId: "Heat Signature Reduction", cpu: 40 },
        { taskId: "cpu_pool", cpu: 20 },
      ],
    };
    const after = recalcCpu(before);

    expect([...after.availableCpus]).toEqual(reference.available);
    expect(Object.fromEntries(after.cpuUsage.map(({ taskId, cpu }) => [taskId, cpu]))).toEqual(
      reference.usage,
    );

    // Two levels were both oversubscribed and the danger-1 task was scaled by its own level's
    // fraction alone — not by that one and then by level 0's as well.
    expect(reference.available[0]).toBeLessThan(30 + 40 + 20);
    expect(reference.available[1]).toBeLessThan(40);
    expect(after.cpuUsage.map((entry) => entry.cpu)).not.toContain(0);
  });
});
