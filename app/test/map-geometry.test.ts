import { SECONDS_PER_DAY, content } from "@singularity/sim";
import { describe, expect, it } from "vitest";

import {
  MASK_HEIGHT,
  MASK_WIDTH,
  createTerminator,
  dayOfYear,
  nightAlphas,
  nightOffsetFraction,
  sunDeclination,
} from "../src/ui/map/terminator.ts";
import {
  OFF_WORLD_LOCATIONS,
  ON_GLOBE_LOCATIONS,
  gridPosition,
  isUnlocked,
} from "../src/ui/map/geometry.ts";

// Pure presentation arithmetic, driven headlessly: no DOM, no component, no browser. The
// map's two numbers — where a pin goes, and where the terminator is — are decided here and
// only *placed* by the components, so the placement can be asserted as geometry rather than
// as pixels.

describe("where a location sits on the globe", () => {
  // The projection is read off the reference rather than chosen: a location's
  // `position` is a pair of percentages that decode exactly to longitude and latitude under
  // equirectangular, which is why the graphic had to be built to match the Content.
  it("decodes the Content's position to the 0-100 equirectangular grid", () => {
    const at = (id: string) => gridPosition(content.locations.byId.get(id)!);

    expect(at("N AMERICA")).toEqual({ x: 25, y: 29 });
    expect(at("EUROPE")).toEqual({ x: 55, y: 20 });
    expect(at("ANTARCTIC")).toEqual({ x: 50, y: 91 });
  });

  it("puts those percentages back on the longitude and latitude they came from", () => {
    const { x, y } = gridPosition(content.locations.byId.get("N AMERICA")!);

    expect((x / 100) * 360 - 180).toBeCloseTo(-90, 10);
    expect(90 - (y / 100) * 180).toBeCloseTo(37.8, 10);
  });

  it("is eight on the globe and three off it, with ORBIT on neither", () => {
    expect(ON_GLOBE_LOCATIONS.map((one) => one.id)).toEqual([
      "N AMERICA",
      "S AMERICA",
      "EUROPE",
      "ASIA",
      "AFRICA",
      "AUSTRALIA",
      "ANTARCTIC",
      "OCEAN",
    ]);
    // Three extraterrestrial locations become chips. ORBIT is `impossible` in the
    // Content — permanently unreachable — so it is not one of them.
    expect(OFF_WORLD_LOCATIONS.map((one) => one.id)).toEqual([
      "MOON",
      "FAR REACHES",
      "TRANSDIMENSIONAL",
    ]);
  });

  it("unlocks a location exactly when its prerequisite tech is finished", () => {
    const moon = content.locations.byId.get("MOON")!;

    expect(isUnlocked(moon, new Set())).toBe(false);
    expect(isUnlocked(moon, new Set(["Lunar Rocketry"]))).toBe(true);
    // The eight on the globe that ask for nothing are open from the first frame.
    expect(isUnlocked(content.locations.byId.get("EUROPE")!, new Set())).toBe(true);
  });
});

describe("the day/night terminator", () => {
  it("takes its day of the year from the game's own start day, as the reference does", () => {
    // `(g.pl.time_day + g.pl.start_day) % 365` (`screens/map.py:102`), no leap years.
    expect(dayOfYear(0, 40)).toBe(40);
    expect(dayOfYear(SECONDS_PER_DAY * 3, 40)).toBe(43);
    expect(dayOfYear(SECONDS_PER_DAY * 400, 0)).toBe(35);
  });

  it("tilts the sun to the solstices and back", () => {
    // -23.45 degrees, in radians, at day 355 + 10 = the cosine's own peak.
    const tropic = (23.45 / 360) * 2 * Math.PI;

    expect(sunDeclination(355)).toBeCloseTo(-tropic, 6);
    expect(sunDeclination(355 - 182)).toBeCloseTo(tropic, 3);
    expect(sunDeclination(355 + 91)).toBeCloseTo(0, 2);
  });

  it("darkens the night side and leaves the day side alone", () => {
    // Northern midsummer: the sun is over the tropic of Cancer, at the mask's centre column.
    const alphas = nightAlphas(sunDeclination(172));
    const at = (x: number, y: number): number => alphas[y * MASK_WIDTH + x] as number;
    const noon = Math.floor(MASK_WIDTH / 2);
    const equator = Math.floor(MASK_HEIGHT / 2);

    expect(at(noon, equator)).toBe(0);
    expect(at(0, equator)).toBe(255);
    // Midnight sun: the pole opposite the tilt is lit all the way round.
    expect(at(0, 0)).toBe(0);
    expect(at(noon, 0)).toBe(0);
    // And the other pole is in the dark all the way round.
    expect(at(0, MASK_HEIGHT - 1)).toBe(255);
    expect(at(noon, MASK_HEIGHT - 1)).toBe(255);
  });

  it("puts the terminator's soft edge where the sun is on the horizon", () => {
    const alphas = nightAlphas(0);
    const equator = Math.floor(MASK_HEIGHT / 2);
    const dawn = Math.floor(MASK_WIDTH / 4);

    // A quarter turn from noon the sun is exactly on the horizon: half lit, half dark.
    expect(alphas[equator * MASK_WIDTH + dawn]).toBeCloseTo(128, -1);
  });

  it("scrolls a whole width across a game day, and only its longitude depends on the hour", () => {
    // Upstream's own `int(width * (0.5 - day_portion)) % width` (`screens/map.py:180`): the
    // shape is the day's, the position is the hour's.
    expect(nightOffsetFraction(0)).toBeCloseTo(0.5, 12);
    expect(nightOffsetFraction(SECONDS_PER_DAY / 4)).toBeCloseTo(0.25, 12);
    expect(nightOffsetFraction(SECONDS_PER_DAY / 2)).toBeCloseTo(0, 12);
    expect(nightOffsetFraction(SECONDS_PER_DAY - 1)).toBeGreaterThan(0.499);
    expect(nightOffsetFraction(SECONDS_PER_DAY)).toBeCloseTo(0.5, 12);
  });
});

describe("the terminator's mask", () => {
  function counting(): { terminator: ReturnType<typeof createTerminator>; computed: number[] } {
    const computed: number[] = [];
    const terminator = createTerminator((day) => {
      computed.push(day);
      return new Uint8ClampedArray(MASK_WIDTH * MASK_HEIGHT);
    });
    return { terminator, computed };
  }

  // The measurement the map rests on: one layer moves, and it moves as a translation. If
  // the mask were rebuilt per frame the map would be a rendering problem, which is the thing
  // canvas was rejected for not solving.
  it("is recomputed once per game day, however many frames the day takes", () => {
    const { terminator, computed } = counting();

    for (let minute = 0; minute < 60 * 24 * 3; minute += 1) {
      terminator.maskFor(dayOfYear(minute * 60, 0));
    }

    expect(computed).toEqual([0, 1, 2]);
  });

  it("recomputes when the year turns over, and not when the same day comes round again", () => {
    const { terminator, computed } = counting();

    terminator.maskFor(364);
    terminator.maskFor(364);
    terminator.maskFor(0);
    terminator.maskFor(0);

    expect(computed).toEqual([364, 0]);
  });
});
