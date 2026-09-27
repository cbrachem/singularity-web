/**
 * Creating a game — `g.new_game` (`g.py:262`) together with `Player.__init__`
 * (`player.py:72`) and `Player.initialize` (`player.py:138`).
 *
 * Three draws happen here and their order is binding: one `shuffle` per region to
 * assign its modifiers, one `randint` for the day of the year the game starts on, and one
 * `choice` for where the first base stands. They ride on the first Trace record, because the
 * Scenario has no step for them and dropping them would leave the order that moves the whole
 * later stream unbound.
 */

import { newBase } from "./base.ts";
import { finished, newBuyable, recalcBaseCpu, specCost } from "./buyable.ts";
import { rawMinutes } from "./clock.ts";
import { content } from "./content/index.ts";
import { recalcCpu } from "./cpu.ts";
import { finishedTechs, isAvailable } from "./availability.ts";
import { applyConsequence } from "./gameevent.ts";
import { addBase, locationModifiers } from "./location.ts";
import { Rng, type DrawObserver } from "./rng/random.ts";
import { withCash } from "./statistics.ts";
import {
  type GroupState,
  type LocationState,
  type RegionState,
  type SimulationState,
  type Statistics,
  type TechState,
} from "./state.ts";

/** The name upstream gives the base a game starts with (`g.py:283`). */
export const STARTING_BASE_NAME = "University Computer";
export const STARTING_BASE_TYPE = "Stolen Computer Time";

const NO_STATISTICS: Statistics = {
  cashEarned: 0,
  cpuUsed: 0,
  techCreated: 0,
  baseCreated: 0,
  itemCreated: 0,
};

export interface NewGameOptions {
  readonly seed: number | bigint;
  readonly difficulty: string;
  /**
   * Where the game's generator reports its draws, for the half of a Trace record that binds
   * sequencing. Creating a game draws three times before the first Tick, so the
   * observer has to be in place before the root exists rather than attached to it after.
   */
  readonly observeDraws?: DrawObserver;
}

/**
 * A fresh game: the State root a Scenario's first step is applied to.
 *
 * The generator is seeded here rather than reached for, which is the second entry in the
 * deviation register — upstream never calls `seed()` at all, so a shipped game is not
 * reproducible and a trace comparison would be impossible.
 */
export function createInitialState({
  seed,
  difficulty,
  observeDraws,
}: NewGameOptions): SimulationState {
  const spec = content.difficulties.byId.get(difficulty);
  if (!spec) throw new Error(`no such difficulty: ${difficulty}`);

  const rng = Rng.seeded(seed, observeDraws);

  const groups: GroupState[] = content.groups.all.map((group) => ({
    specId: group.id,
    suspicion: 0,
    changedSuspicionDecay: 0,
    baseDiscoverBonus: spec.discoverMultiplier,
    changedDiscoverBonus: 0,
    baseDiscoverSuspicion: spec.suspicionMultiplier,
    changedDiscoverSuspicion: 0,
    activelyDiscovering: true,
  }));

  // One shuffle per region, in region order, before anything else draws.
  const regions: RegionState[] = content.regions.all.map((region) => {
    const entries = region.locations.map((_, index) => index);
    rng.shuffle(entries);
    return {
      specId: region.id,
      modifierEntryByLocation: region.locations.map((locationId, index) => ({
        locationId,
        entry: entries[index] as number,
      })),
    };
  });

  const locations: LocationState[] = content.locations.all.map((location) => ({
    specId: location.id,
    bases: [],
  }));

  const techs: TechState[] = content.techs.all.map((tech) => ({
    specId: tech.id,
    buyable: newBuyable(specCost(tech.cost, spec.laborMultiplier)),
  }));

  const startDay = rng.randint(0, 365);

  let state: SimulationState = {
    difficulty,
    gameTime: 0,
    rng,
    cash: 0,
    partialCash: 0,
    interestRate: spec.startingInterestRate,
    income: 0,
    cpuPool: 0,
    laborBonus: spec.laborMultiplier,
    jobBonus: 10000,
    usedCpu: 0,
    hadGrace: true,
    apotheosis: false,
    lastAutosaveDay: 0,
    startDay,
    displayDiscover: "none",
    availableCpus: [0, 0, 0, 0, 0],
    sleepingCpus: 0,
    cpuUsage: [],
    lastDiscovery: null,
    prevDiscovery: null,
    log: [],
    stats: NO_STATISTICS,
    groups,
    regions,
    locations,
    techs,
    events: [],
  };

  // `Player.__init__` assigns cash through the observed property, so the starting cash is
  // the first thing the "cash earned" statistic counts.
  state = withCash(state, spec.startingCash);

  // The difficulty's free techs (`g.py:280`), finished without crediting the player for them
  // — `is_player=False`, so `tech_created` does not move — and **with their consequences
  // applied**, because `Tech.finish` triggers the effect whoever calls it (`tech.py:81`).
  // Stopping at the flag would start an easy game silently missing the readout it is given.
  //
  // The order is the difficulty's own list rather than Content order, and the consequence of
  // one is applied before the next is finished: `very-easy` grants `Socioanalytics` and then
  // `Advanced Socioanalytics`, which set `display_discover` to `partial` and then to `full`.
  for (const techId of spec.techs) {
    const index = state.techs.findIndex((tech) => tech.specId === techId);
    const granted = content.techs.byId.get(techId);
    const tech = state.techs[index];
    if (!tech || !granted) throw new Error(`no such tech: ${techId}`);
    state = {
      ...state,
      techs: state.techs.map((was, at) =>
        at === index ? { ...was, buyable: finished(was.buyable) } : was,
      ),
    };
    // Nothing a difficulty grants has anything to tell the Host, and creating a game has no
    // channel for it to say it in: `createInitialState` returns a State root and nothing
    // beside it. The one instruction that emits is `endgame`, and no difficulty in Content
    // grants the tech that carries it — so this refuses rather than dropping it quietly.
    const applied = applyConsequence(state, granted.effectStack, 1);
    if (applied.effects.length > 0) {
      throw new Error(`${techId} is granted at creation and has an Effect to report`);
    }
    state = applied.state;
  }

  const finishedIds = finishedTechs(state.techs);
  const open = content.locations.all.filter((location) =>
    isAvailable(location.prerequisites, finishedIds),
  );
  const startsAt = rng.choice(open);

  state = addStartingBase(state, startsAt.id);

  // `Player.initialize`: every finished base recomputes its CPU, then the player totals them.
  state = {
    ...state,
    locations: state.locations.map((location) => ({
      ...location,
      bases: location.bases.map((base) =>
        base.buyable.done
          ? recalcBaseCpu(base, locationModifiers(state.regions, location.specId))
          : base,
      ),
    })),
  };
  return recalcCpu(state);
}

function addStartingBase(state: SimulationState, locationId: string): SimulationState {
  const spec = content.bases.byId.get(STARTING_BASE_TYPE);
  if (!spec) throw new Error(`no such base type: ${STARTING_BASE_TYPE}`);

  // `built=True` (`g.py:283`): the base is finished before its forced CPU exists, which is
  // why it is offline until the item's own completion re-checks it (`./base.ts`). Neither
  // the base nor the item is credited to the player.
  const base = newBase(
    spec,
    STARTING_BASE_NAME,
    rawMinutes(state.gameTime),
    state.laborBonus,
    true,
  );
  return addBase(state, locationId, base);
}
