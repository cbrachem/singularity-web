import { content, isAvailable, type FinishedTechs, type Location } from "@singularity/sim";

/**
 * Where the map's twelve locations go, and which of them the player may reach yet.
 *
 * The projection is not a choice. A location's `position` in the Content is a pair of
 * percentages that decode exactly to longitude and latitude under equirectangular
 * — `N AMERICA` at `25 | 29` is 90 degrees west, 37.8 north — so the graphic was built to
 * match the Content rather than the other way round (`./land.ts`). Everything
 * here is therefore arithmetic on Content that is already correct, and never a placement
 * somebody chose by eye.
 */

/** 360 degrees of longitude over 180 of latitude: the globe's aspect, everywhere. */
export const GLOBE_ASPECT = 2;

/** A place on the 0-100 grid the land path is drawn in. */
export interface GridPosition {
  readonly x: number;
  readonly y: number;
}

/**
 * The Content's position, back in the percentages it was written as.
 *
 * The loader divides by -100, because upstream's negative co-ordinates mean "a fraction of
 * the box" (`location.position_data_parser`); this undoes exactly that and nothing else.
 *
 * The rounding is that division's own residue — `29 / -100 * -100` is `28.999999999999996`
 * in binary floating point — and not a tolerance. The Content writes whole percentages, so
 * six decimals recovers the number that was written without asserting it was whole.
 */
export function gridPosition(location: Location): GridPosition {
  return { x: percentage(location.x), y: percentage(location.y) };
}

function percentage(fraction: number): number {
  return Math.round(fraction * -100 * 1e6) / 1e6;
}

/** The eight locations that sit on the globe, in Content order. */
export const ON_GLOBE_LOCATIONS: readonly Location[] = content.locations.all.filter(
  (location) => !location.absolute,
);

/**
 * The three extraterrestrial locations, left to right as their positions place them.
 *
 * Of the twelve locations, four are placed against the screen rather than against
 * the map, and one of those — `ORBIT` — is `impossible` in the Content and can never be
 * reached. It is not a chip the player is waiting for, so it is not a chip.
 */
export const OFF_WORLD_LOCATIONS: readonly Location[] = content.locations.all
  .filter((location) => location.absolute && location.prerequisites.mode !== "impossible")
  .sort((first, second) => gridPosition(first).x - gridPosition(second).x);

/**
 * Whether the player may build here yet — `Prerequisite.available`, read through the
 * Simulation's own rule rather than re-derived from the tech list.
 */
export function isUnlocked(location: Location, finished: FinishedTechs): boolean {
  return isAvailable(location.prerequisites, finished);
}
