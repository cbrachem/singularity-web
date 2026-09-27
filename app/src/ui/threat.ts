import {
  addChance,
  content,
  decayRate,
  detectChance,
  discoverSuspicion,
  settleGrace,
  type GroupState,
  type SimulationState,
} from "@singularity/sim";

import { plainLabel } from "./readouts.ts";

/**
 * The eight values the reserved band shows: four groups, each with its suspicion and the
 * rate at which the estate is being detected, and the danger level behind both.
 *
 * # Why the derivations live here
 *
 * The danger level is Presentation's. It reads Simulation state
 * and nothing else, it is what upstream's own map screen computes at render time, and the
 * Simulation never stores it — the word shown at `display_discover: none` *is* the level, so
 * a level in the state root would be a second copy of something already derivable.
 *
 * What is **not** Presentation's is the arithmetic underneath. `Group.decay_rate`,
 * `Group.discover_suspicion` and `chance.add` are rules the daily processing spends, so they
 * are imported from `sim/` rather than restated: the detect-rate level is a claim about the
 * same numbers that decide whether the player survives, and a Presentation that re-derived
 * them could rank the groups differently from the game.
 *
 * # Why the ladder is not redundant beside the number
 *
 * For suspicion it nearly is — `suspicion_to_danger_level` is a pure cut of the scale. For
 * the detect rate it is not: `Group.detects_per_day_to_danger_level` (`code/group.py:127`)
 * asks how fast suspicion would grow *net of the group's decay*, and how soon that reaches
 * 100%. A group shedding 160 points a day is calmer at 3% a day than a group shedding one is
 * at 2%, and no ordering of the printed numbers can say so.
 */

/**
 * Four, and not the five `g.py:155`'s docstring claims. The cuts below it produce four
 * values and the themes define exactly `danger_level_0` through `danger_level_3`; the
 * docstring is stale.
 */
export const DANGER_LEVELS = 4;

export type DangerLevel = 0 | 1 | 2 | 3;

/**
 * `g.danger_level_to_detect_str` (`code/g.py:150`), spelled out. Upstream abbreviates to
 * `LOW`, `MODR`, `HIGH` and `CRIT` because its bar has four characters to say it in; the
 * band has room, and `Critical` is the string every value cell is sized for.
 */
export const LEVEL_WORDS = ["Low", "Moderate", "High", "Critical"] as const;

/** `g.suspicion_to_danger_level` (`code/g.py:157`): the 10000-point scale cut at quarters. */
export function suspicionToDangerLevel(suspicion: number): DangerLevel {
  if (suspicion < 2500) return 0;
  if (suspicion < 5000) return 1;
  if (suspicion < 7500) return 2;
  return 3;
}

/**
 * `detect_chance_to_danger_level` (`code/base.py:536`): one base's per-group detection
 * chance, on the 10000-point scale, cut where upstream cuts it. The base detail's ramp
 * — a different question from the estate-wide detect rate below.
 */
export function detectChanceToDangerLevel(chance: number): DangerLevel {
  if (chance > 225) return 3;
  if (chance > 150) return 2;
  if (chance > 75) return 1;
  return 0;
}

/** `Group.detects_per_day_to_danger_level` (`code/group.py:127`). */
export function detectsPerDayToDangerLevel(group: GroupState, detects: number): DangerLevel {
  const perDay = detects * discoverSuspicion(group) - decayRate(group);

  // +1%/day or death within 10 days.
  if (perDay > 100 || group.suspicion + perDay * 10 >= 10000) return 3;
  // +0.5%/day or death within 100 days.
  if (perDay > 50 || group.suspicion + perDay * 100 >= 10000) return 2;
  if (perDay > 0) return 1;
  return 0;
}

/**
 * How many times a day each group would find *something*, over the whole estate —
 * `MapScreen.rebuild`'s own loop (`code/screens/map.py:836`).
 *
 * A base still inside its own grace period cannot be detected and contributes nothing. Its
 * latch is asked and the answer thrown away: `Base.has_grace` sets `grace_over` when it
 * expires and that is simulation despite a render path calling it, so the readout
 * reads the answer and leaves the state alone.
 */
export function detectsPerDay(state: SimulationState): ReadonlyMap<string, number> {
  const perGroup = new Map<string, number>(state.groups.map((group) => [group.specId, 0]));

  for (const location of state.locations) {
    for (const base of location.bases) {
      if (settleGrace(state, base).hasGrace) continue;
      const chances = detectChance(state, base, location.specId);
      for (const group of state.groups) {
        const chance = chances.get(group.specId) ?? 0;
        perGroup.set(group.specId, addChance(perGroup.get(group.specId) ?? 0, chance / 10000));
      }
    }
  }

  return perGroup;
}

/**
 * `g.to_percent` (`code/g.py:114`) with `show_full` set, which is what the map screen passes
 * both measures: two places, always, so the cell never changes width.
 */
export function toPercent(rawPercent: number): string {
  return `${(rawPercent / 100).toFixed(2)}%`;
}

/** `g.nearest_percent` (`code/g.py:135`): onto the step, with the half going up. */
export function nearestPercent(value: number, step: number): number {
  const subPercent = value % step;
  return 2 * subPercent <= step ? value - subPercent : value + (step - subPercent);
}

/** One measure as the band draws it: a level for the ladder, and a string for the cell. */
export interface ThreatValue {
  readonly level: DangerLevel;
  readonly text: string;
}

export interface GroupThreat {
  readonly id: string;
  readonly name: string;
  readonly suspicion: ThreatValue;
  readonly detect: ThreatValue;
}

/**
 * The eight values, in the Content's own group order.
 *
 * `display_discover` moves the *text* and nothing else: `none` prints the level's
 * own word, `partial` rounds onto a step, `full` prints the figure. The level is the same at
 * all three, which is what lets the geometry be identical at all three.
 */
export function threatReadout(state: SimulationState): readonly GroupThreat[] {
  const rates = detectsPerDay(state);
  const precision = state.displayDiscover;

  return state.groups.map((group) => {
    const detects = rates.get(group.specId) ?? 0;
    const suspicionLevel = suspicionToDangerLevel(group.suspicion);
    const detectLevel = detectsPerDayToDangerLevel(group, detects);

    return {
      id: group.specId,
      name: plainLabel(content.groups.byId.get(group.specId)?.name ?? group.specId),
      suspicion: {
        level: suspicionLevel,
        text:
          precision === "full"
            ? toPercent(group.suspicion)
            : precision === "partial"
              ? toPercent(nearestPercent(group.suspicion, 500))
              : LEVEL_WORDS[suspicionLevel],
      },
      detect: {
        level: detectLevel,
        text:
          precision === "full"
            ? toPercent(detects * 10000)
            : precision === "partial"
              ? toPercent(nearestPercent(detects * 10000, 100))
              : LEVEL_WORDS[detectLevel],
      },
    };
  });
}
