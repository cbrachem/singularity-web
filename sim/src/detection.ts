/**
 * How a base is lost: `_check_for_dead_bases` (`player.py:905`), the detection chance it
 * rolls against, and `Player.remove_bases` (`player.py:585`), which is what a hit costs.
 *
 * This is the tick's most RNG-dense phase and the one where iteration order shows most
 * plainly. Three orderings are contract here and each of them moves the whole later stream:
 *
 * - **Bases, in `g.all_bases()` order.** Unpaid maintenance is a shortfall *pool*, drained
 *   base by base as the walk passes them, so which bases are exposed to the destruction roll
 *   — and how many rolls the tick makes at all — depends on where in the walk the pool runs
 *   dry.
 * - **Groups, in the order `detectChance` returns them.** One draw per group per base per
 *   tick, whether or not that group's chance is zero, and the first group to roll true claims
 *   the base and stops the loop early.
 * - **The dead, in the order they were condemned.** Removal walks them in that order, and
 *   each one raises a group's suspicion and recounts the player's CPU before the next is
 *   touched.
 *
 * A base already condemned for maintenance is not rolled for detection, and — because
 * `Base.has_grace` is only *asked* when the base is still alive — its own grace latch is not
 * settled either. Both fall out of upstream's `not (grace or dead or base.has_grace())`.
 */

import { hasPower } from "./base.ts";
import { baseQuality } from "./buyable.ts";
import { currentShare, rawMinutes } from "./clock.ts";
import { content } from "./content/index.ts";
import { rollInterval } from "./chance.ts";
import { recalcCpu } from "./cpu.ts";
import { PAUSE, baseLostEffect, type Effect } from "./effect.ts";
import { discoverBonus, discoveredABase } from "./group.ts";
import { locationModifiers, locationOf, removeBase } from "./location.ts";
import { floorDiv, truncate } from "./pynum.ts";
import {
  CASH,
  CPU,
  LABOR,
  appendLog,
  type BaseState,
  type GroupState,
  type LocationState,
  type LogEntry,
  type SimulationState,
} from "./state.ts";

/** The chance per day that an unmaintained base falls over (`player.py:917,930`). */
const MAINTENANCE_FAILURE_CHANCE = 0.015;

/** `LogBaseLostMaintenance` (`logmessage.py:312`), by the id it serializes itself as. */
export const BASE_LOST_MAINTENANCE = "base-lost-maint";

/** `LogBaseDiscovered` (`logmessage.py:357`), likewise. */
export const BASE_LOST_DISCOVERED = "base-lost-discovered";

export interface DeadBaseCheck {
  /** Whether the game is still inside the grace period, as this tick computed it. */
  readonly grace: boolean;
  readonly unpaidCash: number;
  readonly unpaidCpu: number;
  readonly secondsIntoDay: number;
  readonly seconds: number;
}

/** One base the tick has condemned, and what condemned it. */
export interface CondemnedBase {
  readonly locationId: string;
  /**
   * The base as the walk left it — the same value that stands in the returned state, which
   * is what removal finds it by.
   */
  readonly base: BaseState;
  /** The group that found it, or `null` when unpaid maintenance is what killed it. */
  readonly discoveredBy: string | null;
}

export interface DeadBases {
  /** Each surviving base's own grace latch settled (written, never derived). */
  readonly state: SimulationState;
  readonly condemned: readonly CondemnedBase[];
}

export interface RemovalResult {
  readonly state: SimulationState;
  readonly effects: readonly Effect[];
}

/**
 * The loop over every base, in location order and then in the order they were added.
 *
 * The two shortfall pools are *arguments* upstream reassigns as it walks (`player.py:914`,
 * `player.py:925`), so a base that owes nothing in the unpaid resource is passed over
 * without a draw, and a base reached after the pool has emptied is passed over as well.
 * That is the whole of "the maintenance shortfall drains in base order".
 */
export function checkDeadBases(state: SimulationState, check: DeadBaseCheck): DeadBases {
  const locations: LocationState[] = [];
  const condemned: CondemnedBase[] = [];
  let unpaidCash = check.unpaidCash;
  let unpaidCpu = check.unpaidCpu;

  for (const location of state.locations) {
    const bases: BaseState[] = [];
    for (const original of location.bases) {
      let base = original;
      let dead = false;
      let discoveredBy: string | null = null;

      // Maintenance deaths. Only a finished base owes anything, and only a base that owes
      // the resource that fell short is exposed — the conditions are upstream's shape rather
      // than "there is a shortfall somewhere", because each one costs a draw.
      if (base.buyable.done) {
        if (unpaidCpu !== 0 && base.maintenance[CPU] !== 0) {
          unpaidCpu = Math.max(0, unpaidCpu - base.maintenance[CPU] * check.seconds);
          if (rollInterval(state.rng, MAINTENANCE_FAILURE_CHANCE, check.seconds)) dead = true;
        }
        if (unpaidCash !== 0) {
          const share = currentShare(base.maintenance[CASH], check.secondsIntoDay, check.seconds);
          if (share !== 0) {
            unpaidCash = Math.max(0, unpaidCash - share);
            // The second roll is skipped outright when the first one already killed it, so a
            // base cannot cost two draws in one tick.
            if (!dead && rollInterval(state.rng, MAINTENANCE_FAILURE_CHANCE, check.seconds)) {
              dead = true;
            }
          }
        }
      }

      // Discoveries. A condemned base is not rolled for, and its grace latch is not settled
      // either: upstream reaches `base.has_grace()` only when the base is still alive.
      if (!check.grace && !dead) {
        const settled = settleGrace(state, base);
        base = settled.base;
        if (!settled.hasGrace) {
          const found = rollForDetection(state, base, location.specId, check.seconds);
          if (found !== undefined) {
            dead = true;
            discoveredBy = found;
          }
        }
      }

      bases.push(base);
      if (dead) condemned.push({ locationId: location.specId, base, discoveredBy });
    }
    locations.push({ ...location, bases });
  }

  return { state: { ...state, locations }, condemned };
}

/**
 * `Player.remove_bases` (`player.py:585`), in the order the bases were condemned.
 *
 * Each loss writes its log entry, asks the Host to pause, takes the base and its items out
 * of the game, and reports itself — and a base a group found also raises that group's
 * suspicion, *before* the entry that names it is written. The pause and the notification are
 * observable only in the effect list, which is why Effects are part of the Trace.
 */
export function removeBases(
  state: SimulationState,
  condemned: readonly CondemnedBase[],
): RemovalResult {
  const effects: Effect[] = [];
  // Where a group found something, in condemnation order. Upstream filters out locations of
  // `None` here, which a base in the port can never stand in.
  const discoveries: string[] = [];
  let next = state;

  for (const { locationId, base, discoveredBy } of condemned) {
    if (discoveredBy !== null) {
      discoveries.push(locationId);
      next = withGroup(next, discoveredBy, discoveredABase);
    }
    next = {
      ...next,
      log: appendLog(next.log, [lossEntry(next.gameTime, base, locationId, discoveredBy)]),
    };
    effects.push(PAUSE);
    next = destroy(next, locationId, base);
    effects.push(baseLostEffect(base.name, locationId, discoveredBy));
  }

  return { state: settleDiscoveries(next, discoveries), effects };
}

/**
 * The two recent-discovery slots (`player.py:611-624`), including the shuffle upstream
 * reaches for when more than one base fell in the same tick — and the odd two-step
 * assignment that makes the *second* shuffled location the previous discovery.
 *
 * The shuffle draws, so it is not an implementation detail of picking two out of a list: a
 * tick that lost two bases consumes draws a tick that lost one does not.
 */
function settleDiscoveries(
  state: SimulationState,
  discoveries: readonly string[],
): SimulationState {
  if (discoveries.length === 0) return state;

  const shuffled = [...discoveries];
  let lastDiscovery = state.lastDiscovery;
  if (shuffled.length > 1) {
    state.rng.shuffle(shuffled);
    lastDiscovery = shuffled[1] as string;
  }
  return { ...state, prevDiscovery: lastDiscovery, lastDiscovery: shuffled[0] as string };
}

/**
 * `Base.destroy` (`base.py:474`) together with the player-level recount it ends with. The
 * base is found by identity rather than by an index, because an earlier removal in the same
 * tick has already moved every index after it.
 */
function destroy(state: SimulationState, locationId: string, base: BaseState): SimulationState {
  const location = locationOf(state, locationId);
  const index = location?.bases.indexOf(base) ?? -1;
  if (index < 0) throw new Error(`${base.name} no longer stands in ${locationId}`);
  return recalcCpu(removeBase(state, locationId, index));
}

function withGroup(
  state: SimulationState,
  groupId: string,
  change: (group: GroupState) => GroupState,
): SimulationState {
  if (!state.groups.some((candidate) => candidate.specId === groupId)) {
    // Upstream prints "base destroyed for unknown reason" and carries on (`player.py:598`).
    // Nothing can reach it: the only reasons are `maint` and a key of `get_detect_chance`,
    // which the player's own groups fill in.
    throw new Error(`no such group: ${groupId}`);
  }
  return {
    ...state,
    groups: state.groups.map((group) => (group.specId === groupId ? change(group) : group)),
  };
}

/**
 * `LogBaseLostMaintenance` and `LogBaseDiscovered` (`logmessage.py:311,356`), in the port's
 * structured shape. Both carry the base's own name, because the base is about to stop
 * existing and the entry has to outlive it.
 */
function lossEntry(
  rawEmitTime: number,
  base: BaseState,
  locationId: string,
  discoveredBy: string | null,
): LogEntry {
  const fields = {
    base_name: base.name,
    base_type_id: base.specId,
    base_location_id: locationId,
  };
  return discoveredBy === null
    ? { kind: BASE_LOST_MAINTENANCE, rawEmitTime, fields }
    : {
        kind: BASE_LOST_DISCOVERED,
        rawEmitTime,
        fields: { ...fields, discovered_by_group_id: discoveredBy },
      };
}

/**
 * `Base.has_grace` (`base.py:460`): a base is invisible until it has stood for as long as its
 * own labor cost, scaled by the difficulty. The latch is one-way and it is state, because the
 * values it is measured against can move.
 */
export function settleGrace(
  state: SimulationState,
  base: BaseState,
): { readonly base: BaseState; readonly hasGrace: boolean } {
  if (base.graceOver) return { base, hasGrace: false };

  const spec = content.difficulties.byId.get(state.difficulty);
  if (!spec) throw new Error(`no such difficulty: ${state.difficulty}`);
  const age = rawMinutes(state.gameTime) - base.startedAtMin;
  const graceTime = (base.buyable.totalCost[LABOR] * spec.baseGraceMultiplier) / 10000;

  if (age > graceTime) return { base: { ...base, graceOver: true }, hasGrace: false };
  return { base, hasGrace: true };
}

/**
 * `_check_base_detection` (`player.py:944`). Every group is rolled in turn and the first one
 * to roll true claims the base, so the group order biases who finds you — and, once a hit
 * stops the loop early, how many draws the tick consumed.
 */
function rollForDetection(
  state: SimulationState,
  base: BaseState,
  locationId: string,
  seconds: number,
): string | undefined {
  for (const [groupId, groupChance] of detectChance(state, base, locationId)) {
    if (rollInterval(state.rng, groupChance / 10000, seconds)) return groupId;
  }
  return undefined;
}

/**
 * `Base.get_detect_chance` (`base.py:396`) over `BaseSpec.calc_discovery_chance`
 * (`base.py:97`), in chances per day in 0–10000 form.
 *
 * The iteration order is the result's order and it is not the group list: the base type's own
 * `detect_chance` comes first, in the order `bases.dat` wrote it, and the groups it does not
 * name are appended afterwards in player order with a chance of zero. They are rolled all the
 * same.
 */
export function detectChance(
  state: SimulationState,
  base: BaseState,
  locationId: string,
): ReadonlyMap<string, number> {
  const spec = content.bases.byId.get(base.specId);
  if (!spec) throw new Error(`no such base type: ${base.specId}`);

  const chances = new Map<string, number>(spec.detectChance);
  const scale = (by: (groupId: string, chance: number) => number): void => {
    for (const [groupId, chance] of chances) chances.set(groupId, by(groupId, chance));
  };

  // `calc_discovery_chance`, over the base type's own groups: suspicion, then the group's
  // discover bonus, each as a separate pass in upstream's own order.
  scale((groupId, chance) => floorDiv(chance * (10000 + group(state, groupId).suspicion), 10000));
  scale((groupId, chance) => floorDiv(chance * discoverBonus(group(state, groupId)), 10000));
  // `extra_factor` is 1 at every call site the Simulation makes; the truncation is not.
  scale((_, chance) => truncate(chance));

  for (const known of state.groups) {
    if (!chances.has(known.specId)) chances.set(known.specId, 0);
  }

  const quality = baseQuality(base, "discover_modifier");
  scale((_, chance) => floorDiv(chance * (10000 - quality), 10000));

  const multiplier = discoveryBonus(state, locationId);
  scale((_, chance) => floorDiv(chance * multiplier, 100));

  if (!hasPower(base)) scale((_, chance) => floorDiv(chance, 4));

  return chances;
}

function group(state: SimulationState, groupId: string): GroupState {
  const found = state.groups.find((candidate) => candidate.specId === groupId);
  if (!found) throw new Error(`no such group: ${groupId}`);
  return found;
}

/**
 * `Location.discovery_bonus` (`location.py:158`), as a percentage. The two recent-discovery
 * multipliers are floats and the whole thing meets `int()`, which is why they are not folded
 * into one constant.
 */
function discoveryBonus(state: SimulationState, locationId: string): number {
  let bonus = 1;
  if (state.lastDiscovery === locationId) bonus *= 1.2;
  if (state.prevDiscovery === locationId) bonus *= 1.1;
  const stealth = locationModifiers(state.regions, locationId).get("stealth");
  if (stealth !== undefined) bonus /= stealth;
  return truncate(bonus * 100);
}
