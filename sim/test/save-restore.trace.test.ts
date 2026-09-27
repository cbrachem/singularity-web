// boundary-intent harness: a test, so it decides what to drive and what to expect
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ITEM_CONSTRUCTED,
  Rng,
  SaveContentError,
  TECH_RESEARCHED,
  advance,
  contentId,
  createInitialState,
  internalId,
  projectDerived,
  projectPersistent,
  restorePersistent,
  SECONDS_PER_DAY,
  type Draw,
  type Effect,
  type RngState,
  type SavedObject,
  type SimulationState,
} from "../src/index.ts";
import {
  SCENARIO_SUFFIX,
  loadScenario,
  scenarioDirectory,
  type Scenario,
} from "./support/scenario.ts";

/**
 * The trace seam, asked one question the reference cannot answer: **does saving and loading
 * change a Trace?**
 *
 * The Oracle is the port's own uninterrupted run rather than the reference, and that is
 * forced rather than chosen. Upstream persists no generator state at all and draws from the
 * global one while loading — a `shuffle` per region and a `randint` for the day of the year,
 * from `Player.__init__` (`player.py:99-134`), before `deserialize_obj` throws the shuffled
 * regions away again. So a reference that is saved and loaded continues on a *different*
 * stream by construction, which is deviations 2 and 4 of the register and the
 * whole reason the port carries the generator in the Save.
 *
 * What is left is an invariant of the port's own, and it is the strong one: a Trace recorded
 * across a save and a load is the Trace that would have been recorded without one — the same
 * persistent state, the same derived state, and above all the same draws.
 *
 * Nothing here reaches inside `sim/src`. A Scenario goes in; a projection and a draw log come
 * out.
 */

/** The Scenarios the port can replay — the ones whose script is nothing but advances. */
const REPLAYABLE = ["grace-quiet", "grace-full", "midnight-split", "past-grace"] as const;

function scenarioNamed(id: string): Scenario {
  return loadScenario(resolve(scenarioDirectory, `${id}${SCENARIO_SUFFIX}`));
}

interface TraceRecord {
  readonly persistent: SavedObject;
  readonly derived: SavedObject;
  readonly effects: readonly Effect[];
  readonly draws: readonly Draw[];
}

interface Run {
  readonly records: readonly TraceRecord[];
  readonly states: readonly SimulationState[];
}

/**
 * Replays a Scenario from step `from`, recording one Record per step and keeping the State
 * root each step produced.
 *
 * The starting root is built by a factory rather than handed in, because the draw observer
 * has to be inside the generator before the root exists — the same reason `createInitialState`
 * takes one.
 */
function replay(
  scenario: Scenario,
  from: number,
  begin: (observe: (draw: Draw) => void) => SimulationState,
): Run {
  let draws: Draw[] = [];
  const observe = (draw: Draw): void => {
    draws.push(draw);
  };
  let state = begin(observe);

  const records: TraceRecord[] = [];
  const states: SimulationState[] = [];
  for (const step of scenario.script.slice(from)) {
    if (!("advanceBy" in step)) throw new Error(`${scenario.id} carries a Command`);
    const result = advance(state, step.advanceBy);
    state = result.state;
    records.push({
      persistent: projectPersistent(state),
      derived: projectDerived(state),
      effects: result.effects,
      draws,
    });
    states.push(state);
    draws = [];
  }
  return { records, states };
}

/** What a Save carries of the Simulation: the projection, and the generator beside it. */
interface Saved {
  readonly state: SavedObject;
  readonly rng: RngState;
}

function save(state: SimulationState): Saved {
  return { state: projectPersistent(state), rng: state.rng.toState() };
}

function load(saved: Saved, observeDraws?: (draw: Draw) => void): SimulationState {
  return restorePersistent(saved.state, Rng.fromState(saved.rng, observeDraws), {
    // Not persisted upstream either: `Player.__init__` draws a fresh one at load
    // (`player.py:134`) and only the day/night display reads it. Choosing it is the Host's.
    startDay: 0,
  });
}

/** A fresh game of the Scenario's seed and difficulty, observed. */
function fresh(scenario: Scenario): (observe: (draw: Draw) => void) => SimulationState {
  return (observeDraws) =>
    createInitialState({ seed: scenario.seed, difficulty: scenario.difficulty, observeDraws });
}

/**
 * The derived projection minus `cpu_pool`, which is a Tick's own working figure rather than
 * something a load recomputes: `Player.__init__` leaves it at 0 (`player.py:89`) and the next
 * Tick opens by clearing it, so upstream loses it across a load too.
 */
function withoutTickInterior(derived: SavedObject): SavedObject {
  const { cpu_pool: _pool, ...rest } = derived;
  return rest;
}

/** An Effect list minus the autosave requests — see `the autosave cadence` below. */
function withoutAutosave(effects: readonly Effect[]): readonly Effect[] {
  return effects.filter((effect) => effect.kind !== "autosave");
}

describe("a game restored from its saved persistent state", () => {
  it.each(REPLAYABLE)("%s: projects back to the state it was saved from", (id) => {
    const scenario = scenarioNamed(id);
    const { states } = replay(scenario, 0, fresh(scenario));
    const end = states.at(-1) as SimulationState;

    const saved = save(end);
    const restored = load(saved);

    expect(projectPersistent(restored)).toEqual(saved.state);
  });

  it.each(REPLAYABLE)("%s: rebuilds the derived state upstream recomputes at load", (id) => {
    const scenario = scenarioNamed(id);
    const { states } = replay(scenario, 0, fresh(scenario));
    const end = states.at(-1) as SimulationState;

    const restored = load(save(end));

    expect(withoutTickInterior(projectDerived(restored))).toEqual(
      withoutTickInterior(projectDerived(end)),
    );
  });

  it.each(REPLAYABLE)("%s: continues the run the interrupted game would have had", (id) => {
    const scenario = scenarioNamed(id);
    const whole = replay(scenario, 0, fresh(scenario));
    const at = Math.floor(scenario.script.length / 2);

    const saved = save(whole.states[at] as SimulationState);
    const tail = replay(scenario, at + 1, (observe) => load(saved, observe));

    expect(tail.records.map((record) => record.persistent)).toEqual(
      whole.records.slice(at + 1).map((record) => record.persistent),
    );
    expect(tail.records.map((record) => withoutTickInterior(record.derived))).toEqual(
      whole.records.slice(at + 1).map((record) => withoutTickInterior(record.derived)),
    );
    expect(tail.records.map((record) => record.draws)).toEqual(
      whole.records.slice(at + 1).map((record) => record.draws),
    );
    expect(tail.records.map((record) => withoutAutosave(record.effects))).toEqual(
      whole.records.slice(at + 1).map((record) => withoutAutosave(record.effects)),
    );
  });

  it("carries the generator outside the state, and draws nothing while loading", () => {
    const scenario = scenarioNamed("past-grace");
    const { states } = replay(scenario, 0, fresh(scenario));
    const saved = save(states.at(-1) as SimulationState);

    const drawn: Draw[] = [];
    const restored = load(saved, (draw) => drawn.push(draw));

    expect(JSON.stringify(saved.state)).not.toContain("rng");
    expect(drawn).toEqual([]);
    expect(restored.rng.toState()).toEqual(saved.rng);
  });

  /**
   * `last_autosave_day` is not persisted and `player.py:748` resets it to the current day at
   * load, so the three-day cadence restarts from wherever the game was loaded. Upstream's
   * behaviour, and the reason the tail comparison above sets autosave requests aside.
   */
  it("restarts the autosave cadence from the day the game was loaded", () => {
    const scenario = scenarioNamed("grace-quiet");
    const { states } = replay(scenario, 0, fresh(scenario));
    const restored = load(save(states.at(-1) as SimulationState));

    const day = 86400;
    const asked = (state: SimulationState, days: number): number[] => {
      let current = state;
      const on: number[] = [];
      for (let elapsed = 1; elapsed <= days; elapsed += 1) {
        const result = advance(current, day);
        current = result.state;
        if (result.effects.some((effect) => effect.kind === "autosave")) on.push(elapsed);
      }
      return on;
    };

    expect(asked(restored, 7)).toEqual([3, 6]);
  });
});

describe("a persistent state that cannot be read", () => {
  const good = (): SavedObject =>
    save(replay(scenarioNamed("grace-quiet"), 0, fresh(scenarioNamed("grace-quiet"))).states[2]!)
      .state;
  const rng = (): RngState => Rng.seeded(1).toState();

  const restore = (state: SavedObject): SimulationState =>
    restorePersistent(state, Rng.fromState(rng()), { startDay: 0 });

  function edited(change: (player: Record<string, unknown>) => void): SavedObject {
    const state = JSON.parse(JSON.stringify(good())) as Record<string, unknown>;
    change(state.player as Record<string, unknown>);
    return state as SavedObject;
  }

  it("refuses a field that is missing", () => {
    expect(() =>
      restore(
        edited((player) => {
          delete player.cash;
        }),
      ),
    ).toThrow(SaveContentError);
  });

  it("refuses a field that is the wrong shape", () => {
    expect(() =>
      restore(
        edited((player) => {
          player.groups = "all of them";
        }),
      ),
    ).toThrow(SaveContentError);
  });

  it("refuses an id the Content does not carry", () => {
    expect(() =>
      restore(
        edited((player) => {
          (player.techs as { id: string }[])[0]!.id = "0xdeadbeef";
        }),
      ),
    ).toThrow(SaveContentError);
  });

  it("refuses a difficulty the Content does not carry", () => {
    const state = JSON.parse(JSON.stringify(good())) as Record<string, unknown>;
    state.difficulty = "trivial";
    expect(() => restore(state as SavedObject)).toThrow(SaveContentError);
  });

  it("refuses a region whose entries do not cover its locations", () => {
    expect(() =>
      restore(
        edited((player) => {
          (
            player.regions as { modifier_entry_by_location: unknown[] }[]
          )[0]!.modifier_entry_by_location.pop();
        }),
      ),
    ).toThrow(SaveContentError);
  });
});

/**
 * A log entry is read by **kind**. `AbstractLogMessage.deserialize_obj`
 * (`logmessage.py:158`) looks the class up by `log_id` and then takes each of that class's
 * serial fields by name (`logmessage.py:161`), so a known kind whose field is missing is a
 * `KeyError` upstream and a refusal here. The port converted whatever fields an entry
 * happened to carry instead, which let a `base-lost-maint` entry with no `base_location_id`
 * restore with an empty field map — and `app/src/host/notifications.ts` reads that field off
 * one.
 */
describe("a saved log entry", () => {
  const scenario = (): Scenario => scenarioNamed("grace-quiet");
  const saved = (): Saved =>
    save(replay(scenario(), 0, fresh(scenario())).states[2] as SimulationState);

  /** The same Save carrying exactly this log. */
  function logging(entries: readonly SavedObject[]): Saved {
    const base = saved();
    const state = JSON.parse(JSON.stringify(base.state)) as Record<string, any>;
    state.player.log = entries;
    return { state: state as SavedObject, rng: base.rng };
  }

  const researched = (extra: SavedObject = {}): SavedObject => ({
    log_id: TECH_RESEARCHED,
    raw_emit_time: 120,
    tech_id: internalId("tech", "Stealth"),
    ...extra,
  });

  const restoredTech = [
    { kind: TECH_RESEARCHED, rawEmitTime: 120, fields: { tech_id: contentId("tech", "Stealth") } },
  ];

  it("restores a known kind with its ids read back as Content ids", () => {
    expect(load(logging([researched()])).log).toEqual(restoredTech);
  });

  it("refuses a known kind whose field is missing", () => {
    expect(() => load(logging([{ log_id: TECH_RESEARCHED, raw_emit_time: 120 }]))).toThrow(
      SaveContentError,
    );
  });

  /**
   * A kind this build does not register is refused, as `deserialize_obj` refuses one — the
   * `log_id` is a `KeyError` in `SAVEABLE_LOG_MESSAGES` (`logmessage.py:160`) and the whole
   * save fails to load.
   */
  it("refuses a kind this build does not register", () => {
    expect(() =>
      load(logging([{ log_id: "tech-researchd", raw_emit_time: 120, tech_id: "unclaimed" }])),
    ).toThrow(SaveContentError);
  });

  /**
   * Neither the kinds nor their converters answer to a name they never carried. While the
   * table was an object literal, the kind `constructor` was `Object` and the converter for a
   * field named `valueOf` was `Object.prototype.valueOf`, so the id reader was handed a
   * function — a refusal by accident rather than by a check.
   */
  it("reads neither a kind nor a converter off Object.prototype", () => {
    expect(load(logging([researched({ valueOf: "unclaimed" })])).log).toEqual(restoredTech);
    expect(() =>
      load(logging([{ log_id: "constructor", raw_emit_time: 120, valueOf: "unclaimed" }])),
    ).toThrow(SaveContentError);
  });

  /**
   * The kind's field list is also the order a restored entry carries, so it has to be the order
   * the Simulation emits in (`itemConstructedLog`, `sim/src/advance.ts`). Read any other way, a
   * save and a load stop reproducing the entry they were taken from, and the Console — which
   * labels a row from the first field it finds — reads a different word after a load than
   * before one. `toEqual` does not see key order, which is why this asks for the keys.
   */
  it("restores a kind's fields in the order the Simulation emits them", () => {
    const emitted = {
      log_id: ITEM_CONSTRUCTED,
      raw_emit_time: 120,
      item_spec_id: internalId("item", "PC"),
      item_count: 1,
      base_name: "Site",
      base_type_id: internalId("base", "Stolen Computer Time"),
      base_location_id: internalId("location", "N AMERICA"),
    };
    const restored = load(logging([emitted])).log[0];

    expect(Object.keys(restored?.fields ?? {})).toEqual([
      "item_spec_id",
      "item_count",
      "base_name",
      "base_type_id",
      "base_location_id",
    ]);
  });
});

/**
 * A finished Tech's standing consequence is **not** in the Save. `Player.serialize_obj`
 * (`player.py:629`) writes no interest rate, no income, no labor bonus and no job bonus at
 * all; a Tech is one `done` flag. Upstream puts the consequences back by finishing every
 * saved Tech again while loading — `restore_buyable_fields` (`buyable.py:239`) calls
 * `finish(is_player=False, loading_savegame=True)`, and `Tech.finish` (`tech.py:81`) triggers
 * `spec.effect`. Marking the buyable done and stopping there hands back a game quietly
 * missing everything the player researched, which is the one direction a Save cannot be
 * recovered from.
 */
describe("a Save whose Techs are finished", () => {
  const scenario = (): Scenario => scenarioNamed("grace-quiet");
  const saved = (): Saved =>
    save(replay(scenario(), 0, fresh(scenario())).states[2] as SimulationState);

  /** The same Save with those Techs marked finished, as upstream's schema marks one. */
  function finishing(base: Saved, names: readonly string[]): Saved {
    const wanted = new Set(names.map((name) => internalId("tech", name)));
    const state = JSON.parse(JSON.stringify(base.state)) as Record<string, any>;
    state.player.techs = state.player.techs.map((tech: { id: string }) =>
      wanted.has(tech.id) ? { id: tech.id, done: 1 } : tech,
    );
    return { state: state as SavedObject, rng: base.rng };
  }

  const groupNamed = (state: SimulationState, id: string) => {
    const group = state.groups.find((candidate) => candidate.specId === id);
    if (!group) throw new Error(`no such group: ${id}`);
    return group;
  };

  it("re-applies the player-wide bonuses a finished Tech stands for", () => {
    const base = saved();
    const plain = load(base);

    // `Leech Satellite` is `interest 10`, `Arbitrage` is `income 1000`, `Telepresence` is
    // `cost_labor 1000`, `Advanced Simulacra` is `job_profit 1000`.
    const restored = load(
      finishing(base, ["Leech Satellite", "Arbitrage", "Telepresence", "Advanced Simulacra"]),
    );

    expect(restored.interestRate).toBe(plain.interestRate + 10);
    expect(restored.income).toBe(plain.income + 1000);
    expect(restored.laborBonus).toBe(plain.laborBonus - 1000);
    expect(restored.jobBonus).toBe(plain.jobBonus + 1000);
  });

  it("re-applies the ones a single group carries", () => {
    const base = saved();
    const plain = load(base);

    // `Stealth` is `discover covert 500`; `Memetics` is `suspicion public 50`.
    const restored = load(finishing(base, ["Stealth", "Memetics"]));

    expect(groupNamed(restored, "covert").changedDiscoverBonus).toBe(
      groupNamed(plain, "covert").changedDiscoverBonus - 500,
    );
    expect(groupNamed(restored, "public").changedSuspicionDecay).toBe(
      groupNamed(plain, "public").changedSuspicionDecay + 50,
    );
  });

  // `display_discover` is a one-shot that assigns rather than accumulates, so re-applying it
  // is safe and upstream re-applies it (`effect.py:54`).
  it("re-applies the readout a finished Tech switches on", () => {
    expect(load(saved()).displayDiscover).toBe("none");
    expect(load(finishing(saved(), ["Advanced Socioanalytics"])).displayDiscover).toBe("full");
  });

  /**
   * The one-time suspicion reduction is the single instruction `loading_savegame` suppresses
   * (`effect.py:80`): the reduction is already inside the suspicion the Save carries, so
   * paying it again would pay it twice.
   */
  it("does not pay a one-time suspicion reduction a second time", () => {
    const base = saved();
    const plain = load(base);
    const restored = load(finishing(base, ["Project: Impossibility Theorem"]));

    for (const group of restored.groups) {
      expect(group.suspicion).toBe(groupNamed(plain, group.specId).suspicion);
    }
  });

  /**
   * The won game is the other side of the same rule, and the one instruction that has
   * something to *say*: `endgame` announces the win to the Host, and re-announcing it while a
   * Save is being read back would show the story section to a player who is loading rather
   * than winning (`effect.py:63`). Everything else it does is a standing consequence and is
   * re-applied like any other, because none of it is in the Save.
   */
  it("restores a won game without winning it again", () => {
    const restored = load(finishing(saved(), ["Apotheosis"]));

    expect(restored.apotheosis).toBe(true);
    expect(restored.hadGrace).toBe(true);
    expect(restored.groups.map((group) => group.activelyDiscovering)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    // Restoring has no channel to say it in, and the ticks that follow do not say it either:
    // the consequence runs where a tech *finishes*, and this one finished before the Save.
    const played = advance(restored, SECONDS_PER_DAY).effects;
    expect(played.filter((effect) => effect.kind === "story")).toEqual([]);
  });
});
