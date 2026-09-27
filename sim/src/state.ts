/**
 * The State root: the value `advance` returns and the only thing Presentation reads.
 *
 * There is exactly one. The Host replaces it whole after each tick, so reference equality
 * against the previous one is a valid change check.
 *
 * # Shape
 *
 * The shape is the port's own, but it is not free of
 * constraint: everything upstream persists has to be *derivable* from it, because a Trace
 * record's persistent half is upstream's save schema and the projection into it is a pure
 * function over this value. So the root carries what the reference's `Player`,
 * its locations, bases, items, techs, groups, regions and events carry, in the port's names,
 * plus the statistics counter and the generator.
 *
 * Upstream's eight clock fields are the one deliberate simplification: they are a cache of
 * `raw_sec` that `update_times` rebuilds (`player.py:185`), so the root keeps the second
 * count and `./clock.ts` derives the rest.
 *
 * # Values, not objects
 *
 * Every field here is plain data, so the whole root round-trips through JSON with only the
 * generator needing a hand (`./serialise.ts`). That is what lets a divergent step be written
 * out as a standalone fixture and replayed without Python, and it is the same
 * projection a Save is built from.
 */

import { Rng } from "./rng/random.ts";

/** `[cash, cpu, labor]`, in the order `buyable.py` indexes them. */
export type Cost = readonly [cash: number, cpu: number, labor: number];

export const CASH = 0;
export const CPU = 1;
export const LABOR = 2;

/**
 * What upstream's `Buyable` carries: what a thing costs in total, what is left to pay, and
 * whether it is finished.
 *
 * `costLeft` rather than the save schema's `cost_paid`, because the two are not
 * interchangeable: a location's modifiers are applied to `total_cost` *after* a base is
 * finished (`location.py:188`), and only the pair upstream keeps stays consistent through
 * that. `cost_paid` is the difference, and the projection computes it.
 */
export interface BuyableState {
  readonly totalCost: Cost;
  readonly costLeft: Cost;
  readonly count: number;
  readonly done: boolean;
}

/** The four slots a base holds, in the order upstream's dict was built (`base.py:196`). */
export const ITEM_SLOTS = ["cpu", "reactor", "network", "security"] as const;
export type ItemSlot = (typeof ITEM_SLOTS)[number];

export type PowerState = "offline" | "active" | "sleep";

/**
 * The three values `display_discover` takes, in the order the readout widens.
 *
 * Simulation state, not a Presentation setting: a tech's `display_discover` instruction
 * assigns it (`effect.py:54`), and what the threat readout is allowed to show follows from
 * it. Written down as a value rather than only as a type, because the rules read it back out
 * of a Save and the set of legal readings is one of them.
 */
export const DISPLAY_DISCOVER = ["none", "partial", "full"] as const;

export type DisplayDiscover = (typeof DISPLAY_DISCOVER)[number];

export interface ItemState {
  readonly specId: string;
  readonly buyable: BuyableState;
}

export interface BaseState {
  readonly specId: string;
  readonly name: string;
  /** `Base.started_at`, in whole minutes of game time — what `has_grace` measures against. */
  readonly startedAtMin: number;
  readonly powerState: PowerState;
  readonly graceOver: boolean;
  /** The spec's maintenance after the location's modifiers, per day. */
  readonly maintenance: Cost;
  readonly rawCpu: number;
  readonly cpu: number;
  readonly items: Readonly<Record<ItemSlot, ItemState | null>>;
  readonly buyable: BuyableState;
}

export interface LocationState {
  readonly specId: string;
  readonly bases: readonly BaseState[];
}

/**
 * A region's assignment of modifier entries to its locations. An ordered list rather than a
 * map: the order is the shuffle's output order and the save schema writes it out.
 */
export interface RegionState {
  readonly specId: string;
  readonly modifierEntryByLocation: readonly {
    readonly locationId: string;
    readonly entry: number;
  }[];
}

export interface GroupState {
  readonly specId: string;
  readonly suspicion: number;
  readonly changedSuspicionDecay: number;
  readonly baseDiscoverBonus: number;
  readonly changedDiscoverBonus: number;
  readonly baseDiscoverSuspicion: number;
  readonly changedDiscoverSuspicion: number;
  readonly activelyDiscovering: boolean;
}

export interface TechState {
  readonly specId: string;
  readonly buyable: BuyableState;
}

export interface GameEventState {
  readonly specId: string;
  readonly triggered: number;
  readonly triggeredAt: number;
}

/**
 * One log entry, in the port's own shape: which kind, when, and the kind's own fields —
 * which is exactly what upstream's `AbstractLogMessage.serialize_obj` writes
 * (`logmessage.py:131`), minus its display strings.
 *
 * The six kinds arrive with the rules that emit them. An empty game inside the grace period
 * appends none, so the shape is stated here and no constructor exists yet.
 */
export interface LogEntry {
  readonly kind: string;
  readonly rawEmitTime: number;
  readonly fields: Readonly<Record<string, string | number>>;
}

export const MAX_LOG_ENTRIES = 1000;

export function appendLog(
  existing: readonly LogEntry[],
  entries: readonly LogEntry[],
): readonly LogEntry[] {
  return [...existing, ...entries].slice(-MAX_LOG_ENTRIES);
}

/**
 * The five single-game statistics upstream keeps (`stats.py`). Two of them count *increases*
 * of a player field rather than the field itself, which is why they live beside the state
 * rather than being derived from it.
 */
export interface Statistics {
  readonly cashEarned: number;
  readonly cpuUsed: number;
  readonly techCreated: number;
  readonly baseCreated: number;
  readonly itemCreated: number;
}

export interface CpuAllocation {
  readonly taskId: string;
  readonly cpu: number;
}

export interface SimulationState {
  /** The difficulty the game was created with; the save header carries it. */
  readonly difficulty: string;
  /** Whole game-seconds elapsed since the start of the game — upstream's `raw_sec`. */
  readonly gameTime: number;
  /**
   * The Simulation's random number generator, carried in the state rather than reached for
   * as a module singleton — which is what makes a Tick reproducible from its input alone,
   * and a divergent step writable as a standalone fixture.
   */
  readonly rng: Rng;

  readonly cash: number;
  /** Sub-day cash, in cash-seconds: the accumulator interest, income and jobs feed. */
  readonly partialCash: number;
  readonly interestRate: number;
  readonly income: number;
  readonly cpuPool: number;
  readonly laborBonus: number;
  readonly jobBonus: number;
  readonly usedCpu: number;

  readonly hadGrace: boolean;
  readonly apotheosis: boolean;
  readonly lastAutosaveDay: number;
  /** Drawn once when the game is created; upstream's day-of-year for the day/night display. */
  readonly startDay: number;
  readonly displayDiscover: DisplayDiscover;

  /** Available CPU per danger level, index 0 being "usable anywhere". Five entries. */
  readonly availableCpus: readonly number[];
  readonly sleepingCpus: number;
  /** Task id to CPU, in the order the allocations were first made — Python's dict order. */
  readonly cpuUsage: readonly CpuAllocation[];

  readonly lastDiscovery: string | null;
  readonly prevDiscovery: string | null;
  readonly log: readonly LogEntry[];

  readonly stats: Statistics;
  readonly groups: readonly GroupState[];
  readonly regions: readonly RegionState[];
  readonly locations: readonly LocationState[];
  readonly techs: readonly TechState[];
  readonly events: readonly GameEventState[];
}

/** `Buyable.cost_paid` (`buyable.py:145`) — what the save schema writes. */
export function costPaid(buyable: BuyableState): Cost {
  return [
    buyable.totalCost[CASH] - buyable.costLeft[CASH],
    buyable.totalCost[CPU] - buyable.costLeft[CPU],
    buyable.totalCost[LABOR] - buyable.costLeft[LABOR],
  ];
}

/** Every base in the game, in location order and then in the order they were added. */
export function* allBases(state: SimulationState): Generator<BaseState> {
  for (const location of state.locations) yield* location.bases;
}

/** A base's items in slot order, skipping the empty slots — upstream's `all_items`. */
export function* allItems(base: BaseState): Generator<ItemState> {
  for (const slot of ITEM_SLOTS) {
    const item = base.items[slot];
    if (item) yield item;
  }
}
