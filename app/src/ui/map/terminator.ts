import { SECONDS_PER_DAY, rawDays, timeOfDay } from "@singularity/sim";

/**
 * The day/night terminator: the only thing on the map that moves per frame.
 *
 * The structure is read off the reference, and it is the reason the map is not a canvas.
 * In equirectangular the terminator's *shape* depends on the day —
 * through the sun's declination — and only its *longitude* on the hour. So upstream computes
 * a mask once per game day (`screens/map.py:_compute_night_mask_step`) and then scrolls it,
 * and so does this: one small mask, recomputed when the day of the year changes, and a
 * translation the rest of the time.
 *
 * The mask is deliberately small. Its horizontal gradient is a `tanh` over the sun's altitude
 * whose whole transition is a few degrees wide, so the shape carries no detail a
 * 180-column bitmap loses — the browser's own bilinear scaling puts the soft edge back at
 * whatever size the globe is drawn at, and a mask sized to the globe would be recomputed on
 * every resize for nothing.
 *
 * # Not the simulation's business
 *
 * Nothing here reads or writes simulation state; it is a pure function of `gameTime` and the
 * game's `startDay`, both of which are already on the State root. Upstream additionally
 * offsets the scroll by the wall-clock second the process started (`compute_night_start`),
 * which would make the same Scenario render differently on every run — exactly what the
 * frozen clock and a screenshot comparison exist to rule out, so the port leaves
 * it out and derives the position from game time alone.
 */

/**
 * The mask's resolution: 2 degrees of longitude by 2 of latitude, in the same 2:1
 * equirectangular grid as the land.
 */
export const MASK_WIDTH = 180;
export const MASK_HEIGHT = 90;

/**
 * How wide the twilight is: the altitude over which the ramp runs from full day to full
 * night, as the sine of that angle.
 *
 * Upstream uses `EarthImage.sun_radius`, half a degree — the sun's own disc. Geometrically
 * exact and, drawn, wrong: half a degree of altitude is a transition narrower than one column
 * of a 180-wide mask, so the browser's bilinear scaling has nothing to interpolate and the
 * terminator lands as a hard-edged disc with a grey seam around it. It reads as a broken
 * radial gradient rather than as nightfall.
 *
 * Two degrees is the width that reads as nightfall at the sizes the globe is actually drawn
 * at. It was tried at six — real civil twilight — and that is too wide here for a different
 * reason: the mask is 90 rows tall and stretched over 700, so a broad ramp spends most of the
 * globe in mid-tones and the row quantisation shows up as horizontal banding. Two degrees is
 * four times the sun's own disc, which is enough for the browser to interpolate, and narrow
 * enough that the picture is a day side and a night side rather than a wash.
 *
 * The mask's shape, its poles and the half-lit point at dawn are unchanged at any of these
 * widths; only the gradient between them is (`app/test/map-geometry.test.ts` holds all three).
 */
const TWILIGHT = Math.sin((2 * Math.PI) / 180);

/** `screens/map.py:102`: "no leap years, sorry". */
const DAYS_PER_YEAR = 365;

/** The axial tilt the declination swings between, in radians. */
const TROPIC = (-23.45 / 360) * 2 * Math.PI;

/** The day of the year the game is on, counted from the day it started on. */
export function dayOfYear(gameTime: number, startDay: number): number {
  return (rawDays(gameTime) + startDay) % DAYS_PER_YEAR;
}

/**
 * The sun's declination on that day, in radians — the reference's own approximation
 * (`screens/map.py:119`), a cosine peaking ten days after new year at the southern solstice.
 */
export function sunDeclination(day: number): number {
  return TROPIC * Math.cos(((2 * Math.PI) / DAYS_PER_YEAR) * (day + 10));
}

/**
 * The mask for one day: how dark each point of the globe is, 0 in full daylight and 255 in
 * full night, row-major from the north pole down.
 *
 * The subsolar meridian is the middle column, which is what makes the mask a shape rather
 * than a position — `nightOffsetFraction` puts it over the right longitude.
 */
export function nightAlphas(declination: number): Uint8ClampedArray {
  const alphas = new Uint8ClampedArray(MASK_WIDTH * MASK_HEIGHT);
  const sinDeclination = Math.sin(declination);
  const cosDeclination = Math.cos(declination);

  for (let row = 0; row < MASK_HEIGHT; row += 1) {
    const latitude = Math.PI / 2 - (row / (MASK_HEIGHT - 1)) * Math.PI;
    const sinLatitude = Math.sin(latitude);
    const cosLatitude = Math.cos(latitude);
    for (let column = 0; column < MASK_WIDTH; column += 1) {
      const hourAngle = ((2 * Math.PI) / MASK_WIDTH) * column - Math.PI;
      const sinAltitude =
        cosLatitude * cosDeclination * Math.cos(hourAngle) + sinLatitude * sinDeclination;
      const light = 0.5 * (Math.tanh(sinAltitude / TWILIGHT) + 1);
      alphas[row * MASK_WIDTH + column] = 255 * (1 - light);
    }
  }
  return alphas;
}

/**
 * Where the mask's left edge belongs, as a fraction of the globe's width.
 *
 * Upstream's `int(width * (0.5 - day_portion)) % width` (`screens/map.py:180`), without the
 * rounding to whole pixels — the port hands the fraction to CSS and lets the compositor place
 * it, which is the same arithmetic one layer down.
 */
export function nightOffsetFraction(gameTime: number): number {
  const dayPortion = timeOfDay(gameTime) / SECONDS_PER_DAY;
  return (((0.5 - dayPortion) % 1) + 1) % 1;
}

/** How a mask is built, so a test can count the times it was. */
export type ComputeMask = (day: number) => Uint8ClampedArray;

export interface Terminator {
  /** The mask for that day of the year, rebuilt only when the day has changed. */
  maskFor(day: number): Uint8ClampedArray;
}

/**
 * The memo that makes "once per game day" true: one mask is held, and a request for the day
 * it was built for is answered with it.
 *
 * Deliberately a value rather than a hook, so what it promises can be driven and counted
 * without a component around it.
 */
export function createTerminator(
  compute: ComputeMask = (day) => nightAlphas(sunDeclination(day)),
): Terminator {
  let heldDay: number | undefined;
  let held: Uint8ClampedArray | undefined;

  return {
    maskFor(day) {
      if (held === undefined || heldDay !== day) {
        heldDay = day;
        held = compute(day);
      }
      return held;
    },
  };
}
