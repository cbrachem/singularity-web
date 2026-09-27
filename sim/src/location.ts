/**
 * A location's modifiers, what they do to a cost, and the estate that stands in it.
 *
 * Upstream caches the merged table on the `Location` object (`location.py:139`); the port
 * derives it, because a cache of a pure function over the State root is a second copy of the
 * same shape and the merge is four multiplications.
 *
 * The modifiers are the one place the Simulation's arithmetic is not integer: `6/5` and `5/6`
 * are floats in the reference, they multiply into a bonus, and the result meets `int()` or
 * `//` immediately afterwards. `./pynum.ts` carries those two operations.
 */

import { recalcBaseCpu } from "./buyable.ts";
import { content } from "./content/index.ts";
import type { Modifiers } from "./content/types.ts";
import { truncate } from "./pynum.ts";
import {
  CASH,
  CPU,
  LABOR,
  type BaseState,
  type Cost,
  type LocationState,
  type RegionState,
  type SimulationState,
} from "./state.ts";

function mergeInto(into: Map<string, number>, source: Modifiers): void {
  for (const [id, value] of source) into.set(id, (into.get(id) ?? 1) * value);
}

/**
 * The table a location's costs, CPU and detection are read through: the entry each of its
 * regions drew for it, merged, and then the location's own modifiers on top — the order
 * `Location.modifiers` merges them in (`location.py:141`).
 */
export function locationModifiers(regions: readonly RegionState[], locationId: string): Modifiers {
  const merged = new Map<string, number>();
  const location = content.locations.byId.get(locationId);
  if (!location) throw new Error(`no such location: ${locationId}`);

  for (const regionId of location.regions) {
    const regionState = regions.find((candidate) => candidate.specId === regionId);
    const regionSpec = content.regions.byId.get(regionId);
    if (!regionState || !regionSpec) throw new Error(`no such region: ${regionId}`);
    const assigned = regionState.modifierEntryByLocation.find(
      (entry) => entry.locationId === locationId,
    );
    // A region may hold more locations than it has modifiers — URBAN has six and five — and
    // the locations that drew a high entry get no modifier at all (`region.py:50`).
    const table = assigned && regionSpec.modifiers[assigned.entry];
    if (table) mergeInto(merged, table);
  }

  mergeInto(merged, location.modifiers);
  return merged;
}

/** `Location.modify_cost` (`location.py:166`): thrift inverts onto cash and CPU, speed onto labor. */
export function modifyCost(cost: Cost, modifiers: Modifiers): Cost {
  const modified: [number, number, number] = [cost[CASH], cost[CPU], cost[LABOR]];
  const thrift = modifiers.get("thrift");
  if (thrift !== undefined) {
    modified[CASH] = truncate(modified[CASH] / thrift);
    modified[CPU] = truncate(modified[CPU] / thrift);
  }
  const speed = modifiers.get("speed");
  if (speed !== undefined) modified[LABOR] = truncate(modified[LABOR] / speed);
  return modified;
}

/** `Location.modify_maintenance` (`location.py:177`): thrift only, and no labor to invert. */
export function modifyMaintenance(maintenance: Cost, modifiers: Modifiers): Cost {
  const modified: [number, number, number] = [
    maintenance[CASH],
    maintenance[CPU],
    maintenance[LABOR],
  ];
  const thrift = modifiers.get("thrift");
  if (thrift !== undefined) {
    modified[CASH] = truncate(modified[CASH] / thrift);
    modified[CPU] = truncate(modified[CPU] / thrift);
  }
  return modified;
}

/**
 * `Location.add_base` (`location.py:184`): the base joins the location's list, and only then
 * do the location's modifiers reach its costs and its maintenance.
 *
 * The order is the reason `BaseState` carries the modified figures rather than the spec's:
 * a base is built at a price its location set, and that price has to survive the base being
 * finished later (`./state.ts`, on `costLeft`).
 */
export function addBase(
  state: SimulationState,
  locationId: string,
  base: BaseState,
): SimulationState {
  const modifiers = locationModifiers(state.regions, locationId);
  const placed = recalcBaseCpu(
    {
      ...base,
      buyable: {
        ...base.buyable,
        totalCost: modifyCost(base.buyable.totalCost, modifiers),
        costLeft: modifyCost(base.buyable.costLeft, modifiers),
      },
      maintenance: modifyMaintenance(base.maintenance, modifiers),
    },
    modifiers,
  );

  return {
    ...state,
    locations: state.locations.map((location) =>
      location.specId === locationId
        ? { ...location, bases: [...location.bases, placed] }
        : location,
    ),
  };
}

/**
 * `Base.destroy` (`base.py:487`): the base leaves its location, taking its items with it.
 *
 * Upstream destroys the items one by one, which is `Buyable.destroy` and does nothing
 * (`buyable.py:213`) — an Item holds no resource outside the base that holds it, so
 * dropping the base is the whole of it. The CPU recount `destroy` ends with belongs to the
 * caller, which is the only one that holds the State root.
 */
export function removeBase(
  state: SimulationState,
  locationId: string,
  index: number,
): SimulationState {
  return {
    ...state,
    locations: state.locations.map((location) =>
      location.specId === locationId
        ? { ...location, bases: location.bases.filter((_, at) => at !== index) }
        : location,
    ),
  };
}

/** The location a Command addresses, or `undefined` when there is no such place. */
export function locationOf(state: SimulationState, locationId: string): LocationState | undefined {
  return state.locations.find((location) => location.specId === locationId);
}
