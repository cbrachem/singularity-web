import { readFileSync } from "node:fs";
import { relative } from "node:path";

import {
  SECONDS_PER_DAY,
  addChance,
  createInitialState,
  detectChance,
  type GroupState,
  type SimulationState,
} from "@singularity/sim";
import { describe, expect, it } from "vitest";

import { APP_SOURCE, sourceFiles } from "./support/source-files.ts";
import {
  DANGER_LEVELS,
  LEVEL_WORDS,
  detectsPerDay,
  detectsPerDayToDangerLevel,
  nearestPercent,
  suspicionToDangerLevel,
  threatReadout,
  toPercent,
} from "../src/ui/threat.ts";

// The danger level is Presentation's derivation over Simulation state, so it is proved
// here, beside the strings, and the band's own test asserts that what these produce
// reached the screen. Every expectation is read off the reference rather than off the
// previous run.

function game(): SimulationState {
  return createInitialState({ seed: 7, difficulty: "normal" });
}

function group(state: SimulationState, id: string, changes: Partial<GroupState> = {}): GroupState {
  const found = state.groups.find((one) => one.specId === id);
  if (!found) throw new Error(`no such group: ${id}`);
  return { ...found, ...changes };
}

describe("the danger level", () => {
  // The docstring at `g.py:155` claiming `range(5)` is stale — the cuts below it
  // produce four values and the themes define exactly `danger_level_0` through `_3`.
  it("has four values and four words, not five", () => {
    expect(DANGER_LEVELS).toBe(4);
    expect(LEVEL_WORDS).toHaveLength(4);
    expect([...LEVEL_WORDS]).toEqual(["Low", "Moderate", "High", "Critical"]);
  });
});

describe("suspicion as a danger level", () => {
  // `g.suspicion_to_danger_level` (`code/g.py:157`): a pure cut of the 10000-basis-point
  // scale at 2500 / 5000 / 7500.
  it("cuts the scale at the quarters, and on the boundary the higher level wins", () => {
    expect(suspicionToDangerLevel(0)).toBe(0);
    expect(suspicionToDangerLevel(2499)).toBe(0);
    expect(suspicionToDangerLevel(2500)).toBe(1);
    expect(suspicionToDangerLevel(4999)).toBe(1);
    expect(suspicionToDangerLevel(5000)).toBe(2);
    expect(suspicionToDangerLevel(7499)).toBe(2);
    expect(suspicionToDangerLevel(7500)).toBe(3);
    expect(suspicionToDangerLevel(10000)).toBe(3);
  });
});

describe("a detect rate as a danger level", () => {
  // `Group.detects_per_day_to_danger_level` (`code/group.py:127`). The rate is never
  // thresholded on its own: it buys suspicion at `discover_suspicion` a detection, the
  // group's own decay is taken off it, and what is left is asked how soon it reaches 100%.
  it("is the rate net of the group's decay, not the rate", () => {
    const state = game();
    // NEWS decays at 150 basis points of what it suspects; at 5000 that is 75 a day.
    const news = group(state, "news", { suspicion: 5000 });

    // 0.05 detections a day buys 50 suspicion, against 75 shed: suspicion is falling.
    expect(detectsPerDayToDangerLevel(news, 0.05)).toBe(0);
    // 0.08 buys 80 against the same 75: five a day, and 100% is 1000 days away.
    expect(detectsPerDayToDangerLevel(news, 0.08)).toBe(1);
  });

  it("reads a group at 2% a day above a group at 3%", () => {
    const state = game();
    // SCIENCE decays at 50 and suspects nothing yet, so its floor is one point a day.
    const science = group(state, "science", { suspicion: 0 });
    // PUBLIC decays at 200 and suspects 80%, so it sheds 160 a day.
    const publicOpinion = group(state, "public", { suspicion: 8000 });

    expect(detectsPerDayToDangerLevel(science, 0.02)).toBe(1);
    expect(detectsPerDayToDangerLevel(publicOpinion, 0.03)).toBe(0);
  });

  // The two "or death within" clauses, which is the half a threshold on the rate loses.
  it("is critical when 100% is ten days away, at a rate that is not critical on its own", () => {
    const state = game();
    // COVERT decays at 100. At 95% it sheds 95 a day and 0.155 detections buy 155, so
    // suspicion climbs by 60 — well under the 100-a-day cut, and 100% is ten days off.
    expect(detectsPerDayToDangerLevel(group(state, "covert", { suspicion: 9500 }), 0.155)).toBe(3);
    // The same 60 a day with room to absorb it: 0.1 detections against 40 shed at 40%.
    expect(detectsPerDayToDangerLevel(group(state, "covert", { suspicion: 4000 }), 0.1)).toBe(2);
  });

  it("is high when 100% is a hundred days away, at a rate that is not high on its own", () => {
    const state = game();
    // SCIENCE decays at 50. At 70% it sheds 35 a day and 0.07 buys 70: 35 a day left,
    // under the 50-a-day cut, and 100% a hundred days off.
    expect(detectsPerDayToDangerLevel(group(state, "science", { suspicion: 7000 }), 0.07)).toBe(2);
    // The same 35 a day at 20%, where a hundred days of it still does not finish the job.
    expect(detectsPerDayToDangerLevel(group(state, "science", { suspicion: 2000 }), 0.045)).toBe(1);
  });
});

describe("the percentages the reference prints", () => {
  // `g.to_percent` (`code/g.py:114`) with `show_full`, which is what the map screen passes.
  it("are two places of a basis-point value", () => {
    expect(toPercent(0)).toBe("0.00%");
    expect(toPercent(3472)).toBe("34.72%");
    expect(toPercent(5000)).toBe("50.00%");
    expect(toPercent(10000)).toBe("100.00%");
  });

  // `g.nearest_percent` (`code/g.py:135`): half-up onto the step, which is what
  // `display_discover: partial` shows instead of the exact figure.
  it("round onto a step, with the half going up", () => {
    expect(nearestPercent(5400, 500)).toBe(5500);
    expect(nearestPercent(5249, 500)).toBe(5000);
    expect(nearestPercent(5250, 500)).toBe(5000);
    expect(nearestPercent(5251, 500)).toBe(5500);
    expect(nearestPercent(180, 100)).toBe(200);
    expect(nearestPercent(150, 100)).toBe(100);
  });
});

describe("the detect rate of the whole estate", () => {
  it("is zero for every group while every base still has its own grace", () => {
    const state = game();
    const rates = detectsPerDay(state);

    expect([...rates.keys()]).toEqual(state.groups.map((one) => one.specId));
    for (const rate of rates.values()) expect(rate).toBe(0);
  });

  it("counts a base whose own grace is over, and leaves the latch alone", () => {
    const state = exposed(game());
    const rates = detectsPerDay(state);

    expect([...rates.values()].some((rate) => rate > 0)).toBe(true);
    // Presentation may not mutate Simulation state, and `Base.has_grace` is the
    // named case: it is simulation despite a render path calling it. The readout reads the
    // answer and leaves the latch where it found it.
    expect(state.locations.flatMap((one) => one.bases).map((one) => one.graceOver)).toEqual([
      false,
    ]);
    expect(detectsPerDay(state)).toEqual(rates);
  });

  // `MapScreen.rebuild` (`code/screens/map.py:836`) folds each base in with `chance.add`,
  // which is a rule of the reference and belongs to the Simulation — the readout imports it
  // rather than restating it. Two bases are what tells the two ways apart:
  // adding the chances would make one detection twice as likely, and `chance.add` does not.
  it("folds the estate together with the Simulation's own `chance.add`", () => {
    const state = twinned(exposed(game()));
    const perBase = state.locations.flatMap((location) =>
      location.bases.map((base) => detectChance(state, base, location.specId)),
    );
    expect(perBase).toHaveLength(2);

    const rates = detectsPerDay(state);

    for (const group of state.groups) {
      const chances = perBase.map((one) => (one.get(group.specId) ?? 0) / 10000);
      expect(rates.get(group.specId)).toBe(chances.reduce((sum, one) => addChance(sum, one), 0));
    }

    const news = perBase.map((one) => (one.get("news") ?? 0) / 10000);
    expect(news[0]).toBeGreaterThan(0);
    expect(rates.get("news")).toBeLessThan(news[0]! + news[1]!);
  });
});

// The rule has one home: `chance.add` is `sim/`'s, and a second transcription in `app/src`
// is two copies of one reference rule that can drift apart.
describe("app/src", () => {
  it("restates no `chance.add` of its own", () => {
    const formula = /1\s*-\s*\(\s*1\s*-\s*[^)]+\)\s*\*\s*\(\s*1\s*-\s*[^)]+\)/;

    const restated = sourceFiles(APP_SOURCE)
      .filter((path) => formula.test(readFileSync(path, "utf8")))
      .map((path) => relative(APP_SOURCE, path));

    expect(restated).toEqual([]);
  });
});

describe("the readout the band draws", () => {
  it("is the four groups in the Content's order, each with both measures", () => {
    const state = { ...game(), displayDiscover: "none" as const };
    const readout = threatReadout(state);

    expect(readout.map((one) => one.name)).toEqual(["NEWS", "SCIENCE", "COVERT", "PUBLIC"]);
    for (const one of readout) {
      expect(one.suspicion.text).toBe("Low");
      expect(one.detect.text).toBe("Low");
    }
  });

  // Only the text gains precision; the level the ladder draws is the same one at
  // every `display_discover`, and at `none` the word *is* the level.
  it("gains precision with display_discover and never changes the level", () => {
    const base = exposed(game());
    const suspicious = {
      ...base,
      groups: base.groups.map((one) => (one.specId === "news" ? { ...one, suspicion: 5400 } : one)),
    };

    const levels = (state: SimulationState): number[] =>
      threatReadout(state).flatMap((one) => [one.suspicion.level, one.detect.level]);

    const none = threatReadout({ ...suspicious, displayDiscover: "none" });
    const partial = threatReadout({ ...suspicious, displayDiscover: "partial" });
    const full = threatReadout({ ...suspicious, displayDiscover: "full" });

    expect(none[0]?.suspicion.text).toBe("High");
    expect(partial[0]?.suspicion.text).toBe("55.00%");
    expect(full[0]?.suspicion.text).toBe("54.00%");

    expect(levels({ ...suspicious, displayDiscover: "partial" })).toEqual(
      levels({ ...suspicious, displayDiscover: "none" }),
    );
    expect(levels({ ...suspicious, displayDiscover: "full" })).toEqual(
      levels({ ...suspicious, displayDiscover: "none" }),
    );
  });

  // The cells are fixed and sized for the widest string any level produces, so a
  // level that could produce a wider one would move the band the day Socioanalytics lands.
  it("produces no string wider than the cell is sized for", () => {
    const widest = Math.max(...LEVEL_WORDS.map((word) => word.length));

    expect(widest).toBe("Critical".length);
    // 100.00% is the longest figure either measure can print, and it is shorter still.
    expect(toPercent(10000).length).toBeLessThanOrEqual(widest);
  });
});

/**
 * The same game a year on: far enough past the starting base's own grace period that
 * `Base.has_grace` is false, and with the player's grace period behind it — but with the
 * latch itself untouched, so a readout that set it would be visible.
 */
function exposed(state: SimulationState): SimulationState {
  return { ...state, hadGrace: false, gameTime: SECONDS_PER_DAY * 365 };
}

/** The same estate with its one base standing twice, so a second chance has to be folded in. */
function twinned(state: SimulationState): SimulationState {
  return {
    ...state,
    locations: state.locations.map((location) =>
      location.bases.length === 0
        ? location
        : {
            ...location,
            bases: location.bases.flatMap((base) => [base, { ...base, name: `${base.name} II` }]),
          },
    ),
  };
}
