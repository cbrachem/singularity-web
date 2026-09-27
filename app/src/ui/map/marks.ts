import { detectChance, type LocationState, type SimulationState } from "@singularity/sim";

import { percentComplete, showsCpu } from "../estate.ts";
import { LEVEL_WORDS, detectChanceToDangerLevel, type DangerLevel } from "../threat.ts";

/**
 * What a location's mark on the map says, and nothing it does not: its share of the AI's
 * CPU, its least finished base while one is under construction, and the highest detection
 * level among its bases. Every value is read from the state as it is.
 */
export interface LocationMark {
  /** This location's CPU over all the CPU the estate has, 0 to 1. */
  readonly share: number;
  /** The least finished base under construction here, 0 to 1, or `null` when none is. */
  readonly building: number | null;
  /** The highest per-group detection level of any base here, or `null` without bases. */
  readonly risk: DangerLevel | null;
  /** The same three values in words, for the pin's accessible description. */
  readonly description: string;
}

export function locationMarks(state: SimulationState): ReadonlyMap<string, LocationMark> {
  const cpuAt = new Map(state.locations.map((location) => [location.specId, cpuOf(location)]));
  const total = [...cpuAt.values()].reduce((sum, cpu) => sum + cpu, 0);

  return new Map(
    state.locations.map((location) => {
      const share = total > 0 ? (cpuAt.get(location.specId) ?? 0) / total : 0;
      const building = leastFinished(location);
      const risk = highestRisk(state, location);
      return [
        location.specId,
        { share, building, risk, description: describe(share, building, risk) },
      ];
    }),
  );
}

function cpuOf(location: LocationState): number {
  return location.bases.reduce((sum, base) => sum + (showsCpu(base) ? base.cpu : 0), 0);
}

function leastFinished(location: LocationState): number | null {
  const unfinished = location.bases.filter((base) => !base.buyable.done);
  return unfinished.length === 0
    ? null
    : Math.min(...unfinished.map((base) => percentComplete(base.buyable)));
}

function highestRisk(state: SimulationState, location: LocationState): DangerLevel | null {
  if (location.bases.length === 0) return null;
  let highest: DangerLevel = 0;
  for (const base of location.bases) {
    for (const chance of detectChance(state, base, location.specId).values()) {
      highest = Math.max(highest, detectChanceToDangerLevel(chance)) as DangerLevel;
    }
  }
  return highest;
}

function describe(share: number, building: number | null, risk: DangerLevel | null): string {
  if (risk === null) return "No bases";
  const parts = [`${Math.round(share * 100)}% of your CPU`, `detection ${LEVEL_WORDS[risk]}`];
  if (building !== null) parts.push(`a base ${Math.trunc(building * 100)}% built`);
  return parts.join(" · ");
}
