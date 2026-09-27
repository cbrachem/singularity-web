// boundary-intent harness: a test, so it decides what to drive and what to expect
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import {
  CASH,
  MAX_CASH,
  SECONDS_PER_DAY,
  WIN,
  advance,
  applyCommand,
  availablePowerStates,
  createInitialState,
  lostGame,
  projectPersistent,
  resourceFlow,
  switchPower,
  type BaseState,
  type Command,
  type Effect,
  type SimulationState,
} from "../src/index.ts";
import { compareTraces, explain } from "./support/fidelity.ts";
import { asReferenceFlow } from "./support/flow.ts";
import {
  oracleAvailable,
  oracleRequired,
  referenceResourceFlow,
  referenceTrace,
  runOracle,
} from "./support/oracle.ts";
import {
  SCENARIO_SUFFIX,
  isAdvance,
  loadScenario,
  scenarioDirectory,
  type Scenario,
} from "./support/scenario.ts";
import { recordTrace, replayStates } from "./support/trace.ts";

/**
 * The last of the tick, and the three ways a game ends.
 *
 * Everything the earlier slices left open closes here: a base's **power state** decides
 * whether its CPU is available, asleep or worth nothing at all; **jobs** are worked twice, from
 * their own allocation before research and from whatever the pool has left afterwards;
 * **apotheosis** stops maintenance being owed; and the game becomes something that can be
 * *won* as well as lost.
 *
 * Three Scenarios carry it, and between them they reach all three endings:
 *
 * - `apotheosis` — the game won. It is also the run in which the estate reaches every safety
 *   level, so the recount's five-entry table is exercised end to end rather than at level 0.
 * - `lost-to-suspicion` — a group past 10,000, which is `lost_game() == 2`.
 * - `lost-every-base` — no available CPU and none asleep either, which is `lost_game() == 1`.
 *
 * `lost_game` is a *reading* of the state rather than part of it: upstream computes it on
 * demand and only the map screen acts on it (`screens/map.py:780`), so it is in neither half
 * of a Trace record. What the record binds is everything it reads — suspicion, the CPU table
 * and the sleeping total — and the reading itself is compared against the reference by asking
 * the Oracle for it at the end of each run.
 */

const runsTheOracle = oracleAvailable || oracleRequired;
const describeOracle = describe.skipIf(!runsTheOracle);

const DAY = SECONDS_PER_DAY;

/** What each of the three Scenarios is for, and what `lost_game` reads at the end of it. */
const ENDINGS = [
  { id: "apotheosis", lost: 0, apotheosis: true },
  { id: "lost-to-suspicion", lost: 2, apotheosis: false },
  { id: "lost-every-base", lost: 1, apotheosis: false },
] as const;

function scenarioNamed(id: string): Scenario {
  return loadScenario(resolve(scenarioDirectory, `${id}${SCENARIO_SUFFIX}`));
}

/** The state after replaying the Scenario's first `steps` steps, without recording anything. */
function replay(scenario: Scenario, steps = scenario.script.length): SimulationState {
  let state = createInitialState({ seed: scenario.seed, difficulty: scenario.difficulty });
  for (const step of scenario.script.slice(0, steps)) {
    state = isAdvance(step) ? advance(state, step.advanceBy).state : applyCommand(state, step);
  }
  return state;
}

function basesOf(state: SimulationState): readonly BaseState[] {
  return state.locations.flatMap((location) => location.bases);
}

describeOracle("the three ways a game ends", () => {
  it.each([...ENDINGS.map((ending) => ending.id), "command-vocabulary"])(
    "%s matches the reference on every part of every record",
    (id) => {
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
    },
  );

  /**
   * The resource-flow Projection through apotheosis (`player.py:770`).
   *
   * `research` and `long-play` compare the same Projection over a game that is still paying
   * for itself. This is the branch neither of them reaches: an ascended player owes no
   * maintenance at all, and the routine zeroes both halves of it rather than letting the
   * estate's own figures through.
   */
  it.each(ENDINGS.map((ending) => ending.id))(
    "%s computes the reference's own resource flow, step for step",
    (id) => {
      const scenario = scenarioNamed(id);
      const reference = referenceResourceFlow(`scenarios/${scenario.id}${SCENARIO_SUFFIX}`);
      const port = replayStates(scenario).map((state) => asReferenceFlow(resourceFlow(state)));

      expect(port).toHaveLength(reference.length);
      expect(port).toEqual(reference);
    },
  );

  it("reaches a state with nothing owed at all, which is what apotheosis changes", () => {
    const ascended = replay(scenarioNamed("apotheosis"));
    const owing = basesOf(ascended).filter(
      (base) => base.buyable.done && base.maintenance[CASH] > 0,
    );

    expect(ascended.apotheosis).toBe(true);
    expect(owing.length, "bases that would owe if the player had not ascended").toBeGreaterThan(0);
    expect(resourceFlow(ascended).cash.maintenanceNeeded).toBe(0);
    expect(resourceFlow(ascended).cpu.maintenanceNeeded).toBe(0);
  });

  /**
   * `Player.lost_game` (`player.py:751`) at the end of each run, asked of the reference
   * directly because a Trace record does not carry it.
   *
   * The three answers are all present and they are different, so the comparison cannot pass on
   * three zeroes: a won game is immortal, a group past 10,000 is 2, and an estate with no CPU
   * left — awake or asleep — is 1.
   */
  it("agrees with the reference on which of them each Scenario reached", () => {
    const probe = runOracle([
      "-c",
      [
        "import json, sys",
        "from tools.trace.reference import ReferenceRun",
        "from tools.trace.scenario import load_scenario",
        "answers = {}",
        "for scenario_id in json.loads(sys.argv[1]):",
        '    path = "scenarios/%s.scenario.json" % scenario_id',
        "    run = ReferenceRun(load_scenario(path))",
        "    for _ in run.records():",
        "        pass",
        "    from singularity.code import g",
        "    answers[scenario_id] = {",
        '        "lost": g.pl.lost_game(),',
        '        "apotheosis": g.pl.apotheosis,',
        '        "available": [int(value) for value in g.pl.available_cpus],',
        '        "sleeping": int(g.pl.sleeping_cpus),',
        "    }",
        "print(json.dumps(answers))",
      ].join("\n"),
      JSON.stringify(ENDINGS.map((ending) => ending.id)),
    ]);
    expect(probe.status, probe.stderr).toBe(0);
    const reference = JSON.parse(probe.stdout) as Record<
      string,
      { lost: number; apotheosis: boolean; available: number[]; sleeping: number }
    >;

    const port = Object.fromEntries(
      ENDINGS.map((ending) => {
        const state = replay(scenarioNamed(ending.id));
        return [
          ending.id,
          {
            lost: lostGame(state),
            apotheosis: state.apotheosis,
            available: [...state.availableCpus],
            sleeping: state.sleepingCpus,
          },
        ];
      }),
    );

    expect(port).toEqual(reference);
    // Named in the register above as well, so a Scenario that stops reaching its ending fails
    // here rather than quietly agreeing with a reference that also stopped.
    for (const ending of ENDINGS) {
      expect(port[ending.id]?.lost).toBe(ending.lost);
      expect(port[ending.id]?.apotheosis).toBe(ending.apotheosis);
    }
  });

  /**
   * `self.cash = min(self.cash, g.max_cash)` (`player.py:378`), which no Scenario can reach:
   * pi quadrillion is some millions of game-days away from the richest run there is. So the
   * balance is put there on both sides and one tick is compared — the same comparison a Trace
   * record makes, over a state a Scenario cannot produce.
   */
  it("caps the cash where the reference caps it", () => {
    const probe = runOracle([
      "-c",
      [
        "import contextlib, io, json, os, random, sys",
        'sys.path.insert(0, os.path.join(os.getcwd(), "tools", "oracle"))',
        'sys.path.insert(0, os.path.join(os.getcwd(), "singularity"))',
        "import pygame_stub; pygame_stub.install()",
        "from singularity.code import base as base_mod, data, dirs, g",
        "from singularity.code import stats as stats_mod",
        "class Screen:",
        "    def __getattr__(self, name): return lambda *a, **k: None",
        "    def __setattr__(self, n, v): object.__setattr__(self, n, v)",
        "with contextlib.redirect_stdout(io.StringIO()):",
        "    dirs.create_directories(True)",
        "    data.reload_all()",
        "    random.seed(4)",
        "    g.map_screen = Screen()",
        '    g.new_game("normal", 1)',
        '    place = g.pl.locations["N AMERICA"]',
        '    place.add_base(base_mod.Base("Vault", g.base_type["Large Warehouse"]))',
        "    g.pl.give_time(86400)",
        "    g.pl.cash = int(g.max_cash) - 1000",
        "    g.pl.income = 10**12",
        "    g.pl.give_time(86400)",
        'print(json.dumps({"cash": g.pl.cash, "partial_cash": g.pl.partial_cash,',
        '                  "stats": stats_mod.itself.serialize_obj()}))',
      ].join("\n"),
    ]);
    expect(probe.status, probe.stderr).toBe(0);
    const reference = JSON.parse(probe.stdout) as {
      cash: number;
      partial_cash: number;
      stats: Record<string, number>;
    };

    const built = applyCommand(createInitialState({ seed: 4, difficulty: "normal" }), {
      command: "buildBase",
      location: "N AMERICA",
      baseType: "Large Warehouse",
      name: "Vault",
    } satisfies Command);
    const rich = advance(built, DAY).state;
    const overflowing: SimulationState = { ...rich, cash: MAX_CASH - 1000, income: 10 ** 12 };
    const after = advance(overflowing, DAY).state;
    const saved = projectPersistent(after) as {
      player: { cash: number; partial_cash: number };
      stats: Record<string, number>;
    };

    expect(reference.cash).toBe(MAX_CASH);
    expect(saved.player.cash).toBe(reference.cash);
    expect(saved.player.partial_cash).toBe(reference.partial_cash);

    // Every statistic but one, compared as it stands. `cash_earned` counts *increases* of the
    // balance, and the two sides were put at the overflowing one by different means — an
    // assignment through upstream's own property, which counts, against a value written into a
    // State root, which does not. So the difference between them is exactly the jump, and the
    // tick's own earning is what is left once it is taken out.
    const { cash_earned: referenceEarned, ...referenceStats } = reference.stats;
    const { cash_earned: portEarned, ...portStats } = saved.stats;
    expect(portStats).toEqual(referenceStats);
    expect((referenceEarned as number) - (portEarned as number)).toBe(MAX_CASH - 1000 - rich.cash);
  });
});

/**
 * `Base.available_power_states` (`base.py:264`) and `Base.switch_power` (`base.py:269`).
 *
 * Upstream lists three states and only two of them are ever switched *to*: a finished base
 * with a finished computer alternates between `active` and `sleep`, and everything else has
 * `offline` as its only option. `offline` is where `check_power` puts a base that cannot hold
 * what it had, never where the Command leaves one.
 */
describe("a base's power state", () => {
  const scenario = () => scenarioNamed("lost-every-base");

  function annex(state: SimulationState): BaseState {
    const base = basesOf(state).find((candidate) => candidate.name === "Annex");
    if (!base) throw new Error("the Scenario has no base called Annex");
    return base;
  }

  it("offers only offline until the base and its computer are both built", () => {
    // Step 1 builds it; step 2 is the first day, which is not enough to finish it.
    const ordered = annex(replay(scenario(), 2));
    expect(ordered.buyable.done).toBe(false);
    expect([...availablePowerStates(ordered)]).toEqual(["offline"]);
    expect(switchPower(ordered).powerState).toBe("offline");

    const standing = annex(replay(scenario(), 4));
    expect(standing.buyable.done).toBe(true);
    expect([...availablePowerStates(standing)]).toEqual(["active", "sleep"]);
  });

  it("alternates between active and sleep, and never lands on offline", () => {
    let base = annex(replay(scenario(), 4));
    expect(base.powerState).toBe("active");

    const visited: string[] = [];
    for (let step = 0; step < 5; step += 1) {
      base = switchPower(base);
      visited.push(base.powerState);
    }
    expect(visited).toEqual(["sleep", "active", "sleep", "active", "sleep"]);
  });

  // `switch_power` ends in `Player.recalc_cpu` (`base.py:279`), which is the whole point of
  // the Command: a sleeping base stops counting towards what can be allocated and starts
  // counting towards the sleeping total instead.
  it("moves the base's CPU between the available table and the sleeping total", () => {
    const awake = replay(scenario(), 4);
    const asleep = applyCommand(awake, {
      command: "switchPower",
      location: annexLocation(awake),
      base: 1,
    } satisfies Command);

    expect(annex(awake).cpu).toBeGreaterThan(0);
    expect(asleep.sleepingCpus).toBe(annex(awake).cpu);
    expect(asleep.availableCpus[0]).toBe((awake.availableCpus[0] as number) - annex(awake).cpu);
  });

  function annexLocation(state: SimulationState): string {
    const found = state.locations.find((location) =>
      location.bases.some((base) => base.name === "Annex"),
    );
    if (!found) throw new Error("the Scenario has no base called Annex");
    return found.specId;
  }
});

/**
 * `Player.lost_game` (`player.py:751`) read as the Simulation offers it: a pure function over
 * the State root, with no Effect and no state of its own. Presentation is what acts on it.
 */
describe("the end conditions", () => {
  it("count sleeping CPU as alive, and nothing at all as lost", () => {
    const scenario = scenarioNamed("lost-every-base");

    // Step 6 destroys the base the game started with, leaving one base asleep: no available
    // CPU anywhere, and the game still running.
    const asleep = replay(scenario, 7);
    expect(asleep.availableCpus[0]).toBe(0);
    expect(asleep.sleepingCpus).toBeGreaterThan(0);
    expect(lostGame(asleep)).toBe(0);

    // The last step but one destroys that base too.
    const gone = replay(scenario);
    expect(gone.sleepingCpus).toBe(0);
    expect(lostGame(gone)).toBe(1);
  });

  it("read a group past ten thousand as the other loss", () => {
    const state = replay(scenarioNamed("lost-to-suspicion"));
    expect(state.groups.filter((group) => group.suspicion > 10000)).toHaveLength(1);
    expect(lostGame(state)).toBe(2);
  });

  // `if self.apotheosis: return 0` is the first line of it, so a won game cannot be lost —
  // not to suspicion and not to an empty estate.
  it("are all closed once the game is won", () => {
    const won = replay(scenarioNamed("apotheosis"));
    expect(won.apotheosis).toBe(true);

    const doomed: SimulationState = {
      ...won,
      availableCpus: [0, 0, 0, 0, 0],
      sleepingCpus: 0,
      groups: won.groups.map((group) => ({ ...group, suspicion: 20000 })),
    };
    expect(lostGame(doomed)).toBe(0);
  });
});

/**
 * The `endgame` consequence (`effect.py:59`), which is the only instruction in the whole
 * vocabulary that has something to tell the Host.
 */
describe("the tech that wins the game", () => {
  const scenario = () => scenarioNamed("apotheosis");

  it("asks for the story section once, on the tick that finishes it", () => {
    const script = scenario().script;
    // The last four steps are the days that run on the other side of the win.
    const before = replay(scenario(), script.length - 5);
    expect(before.apotheosis).toBe(false);

    const winning = advance(before, DAY);
    expect(winning.state.apotheosis).toBe(true);
    expect(winning.effects.filter((effect) => effect.kind === "story")).toEqual([
      { kind: "story", sectionId: WIN },
    ]);

    // And never again: the consequence runs where the tech finishes and nowhere else.
    const after: Effect[] = [];
    let state = winning.state;
    for (let day = 0; day < 4; day += 1) {
      const tick = advance(state, DAY);
      state = tick.state;
      after.push(...tick.effects);
    }
    expect(after.filter((effect) => effect.kind === "story")).toEqual([]);
  });

  it("stops every group looking for a base, and makes the grace period permanent", () => {
    const won = replay(scenario());
    expect(won.groups.map((group) => group.activelyDiscovering)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(won.hadGrace).toBe(true);
  });

  /**
   * "Gods don't need no stinking maintenance" (`player.py:307`). The estate the won game ends
   * with owes hundreds a day, and the same estate under a game that has *not* been won pays
   * it — which is the discriminating case, because a cap that never fires and a cost that is
   * never charged both look like a balance that only goes up.
   */
  it("stops maintenance being owed at all", () => {
    const won = replay(scenario());
    const owed = basesOf(won)
      .filter((base) => base.buyable.done)
      .reduce((total, base) => total + base.maintenance[0], 0);
    expect(owed).toBeGreaterThan(0);

    const asGod = advance(won, DAY).state;
    const asMortal = advance({ ...won, apotheosis: false }, DAY).state;
    expect(asGod.cash - won.cash).toBe(asMortal.cash - won.cash + owed);
  });
});

/**
 * `Player.give_time`'s two calls to `do_jobs` (`player.py:315`, `player.py:365`).
 *
 * The allocation earns *before* research and never reaches the pool; the pool earns *after*
 * construction has taken what it needs. So the same CPU pays for different things depending on
 * which of the two it is in, and that is what the Scenario's explicit jobs allocation is for.
 */
describe("jobs", () => {
  /**
   * A base that costs CPU and no cash, standing beside one that is finished: the only thing
   * that can build it is the pool, and the only thing that can fill the pool is CPU nobody
   * pointed at anything.
   */
  function pending(): SimulationState {
    let state = createInitialState({ seed: 4, difficulty: "normal" });
    state = applyCommand(state, {
      command: "buildBase",
      location: "N AMERICA",
      baseType: "Server Access",
      name: "Relay",
    } satisfies Command);
    state = advance(state, DAY).state;
    return applyCommand(state, {
      command: "buildBase",
      location: "N AMERICA",
      baseType: "Stolen Computer Time",
      name: "Scrap",
    } satisfies Command);
  }

  function paidCpu(state: SimulationState, name: string): number {
    const base = basesOf(state).find((candidate) => candidate.name === name);
    if (!base) throw new Error(`no base called ${name}`);
    return base.buyable.totalCost[1] - base.buyable.costLeft[1];
  }

  it("are worked from the allocation before research and from the pool afterwards", () => {
    const before = pending();
    const available = before.availableCpus[0] as number;
    expect(available).toBeGreaterThan(0);
    expect(paidCpu(before, "Scrap")).toBe(0);

    const fromThePool = advance(before, DAY).state;
    const fromTheAllocation = advance(
      applyCommand(before, {
        command: "allocateCpu",
        task: "jobs",
        cpu: available,
      } satisfies Command),
      DAY,
    ).state;

    // Pointed at jobs, the CPU earns before research and never reaches the pool, so the base
    // under construction is offered nothing at all.
    expect(paidCpu(fromThePool, "Scrap")).toBeGreaterThan(0);
    expect(paidCpu(fromTheAllocation, "Scrap")).toBe(0);

    // Both worked jobs with it, so the difference is where the CPU went and not whether it
    // was counted — the pool pays construction first and works only what is left.
    expect(fromThePool.cash).toBeGreaterThan(before.cash);
    expect(fromTheAllocation.cash).toBeGreaterThan(fromThePool.cash);
  });
});

/**
 * `Player.recalc_cpu`'s first half (`player.py:485`): every finished base adds its CPU to every
 * danger level its location is safe for, a sleeping one adds to the sleeping total instead, and
 * an unpowered or unfinished one adds to neither.
 *
 * The `apotheosis` Scenario is the only run that reaches all five levels — it has to, because
 * the last four techs on the way there carry dangers 1 to 4 — so the whole table is compared
 * against the reference rather than only its first entry.
 */
describe("the CPU table", () => {
  it("fills every safety level the estate reaches, and never inverts", () => {
    const won = replay(scenarioNamed("apotheosis"));
    const table = [...won.availableCpus];

    expect(table).toHaveLength(5);
    for (const level of table) expect(level).toBeGreaterThan(0);
    for (let level = 1; level < table.length; level += 1) {
      // A base safe at one level is safe at every lower one, so the table only ever falls.
      expect(table[level] as number).toBeLessThanOrEqual(table[level - 1] as number);
    }
    expect(table[4] as number).toBeLessThan(table[0] as number);
  });

  it("leaves out a base that is not finished, and one that is not powered", () => {
    const scenario = scenarioNamed("lost-every-base");
    const building = replay(scenario, 2);
    const standing = replay(scenario, 4);
    const asleep = replay(scenario, 5);

    const unfinished = basesOf(building).find((base) => base.name === "Annex") as BaseState;
    expect(unfinished.buyable.done).toBe(false);
    expect(building.availableCpus[0]).toBe(startingCpu(building));

    expect(standing.availableCpus[0]).toBeGreaterThan(startingCpu(standing));
    expect(asleep.availableCpus[0]).toBe(startingCpu(asleep));
    expect(asleep.sleepingCpus).toBeGreaterThan(0);
  });

  /**
   * The third case, and the one that is neither: a base that is *finished* and holds a
   * computer that is not. `check_power` drags it back to `offline` (`base.py:281`), which is
   * neither powered nor asleep, so it counts nowhere at all — and it is the only way a
   * finished base is ever offline.
   *
   * `command-vocabulary` reaches it by buying a PC into the base's CPU slot, which throws away
   * the finished computer the base type came with and starts building a new one.
   */
  it("counts a finished base with an unbuilt computer in neither total", () => {
    const scenario = scenarioNamed("command-vocabulary");
    const before = replay(scenario, 4);
    const after = replay(scenario, 5);

    const base = basesOf(after).find((candidate) => candidate.name === "Relay") as BaseState;
    expect(base.buyable.done).toBe(true);
    expect(base.items.cpu?.buyable.done).toBe(false);
    expect(base.powerState).toBe("offline");
    expect([...availablePowerStates(base)]).toEqual(["offline"]);

    expect((before.availableCpus[0] as number) - (after.availableCpus[0] as number)).toBe(
      basesOf(before).find((candidate) => candidate.name === "Relay")?.cpu,
    );
    expect(after.sleepingCpus).toBe(0);
  });

  /** What the base the game starts with is worth, which is all the estate had before Annex. */
  function startingCpu(state: SimulationState): number {
    const base = basesOf(state).find((candidate) => candidate.name !== "Annex");
    if (!base) throw new Error("the game has lost the base it started with");
    return base.cpu;
  }
});
