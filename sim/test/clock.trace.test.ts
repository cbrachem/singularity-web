// boundary-intent harness: a test, so it decides what to drive and what to expect
import { describe, expect, it } from "vitest";

import { advance, createInitialState, projectPersistent } from "../src/index.ts";
import { advances } from "./support/scenario.ts";
import { recordTrace } from "./support/trace.ts";

// The trace seam, narrowed to the clock. The Oracle these expectations were read off lives in
// tools/trace/; what is written out here is the arithmetic that has to hold whatever the
// Scenario does with it, so that a clock fault is one failing test rather than a whole trace
// out of step. Nothing below reaches inside the Simulation.

const newGame = { seed: 1, difficulty: "normal" } as const;

describe("the clock", () => {
  it("records one state per step, with game time accumulated", () => {
    const trace = recordTrace(advances(1, 2, 240, 14400)).records;

    expect(trace.map(({ step, persistent }) => ({ step, gameTime: persistent.game_time }))).toEqual(
      [
        { step: 0, gameTime: 1 },
        { step: 1, gameTime: 3 },
        { step: 2, gameTime: 243 },
        { step: 3, gameTime: 14643 },
      ],
    );
  });

  it("reaches the same game time however the span is partitioned", () => {
    const whole = recordTrace(advances(86400)).records;
    const daily = recordTrace(advances(...Array.from({ length: 360 }, () => 240))).records;

    expect(daily.at(-1)?.persistent.game_time).toBe(whole.at(-1)?.persistent.game_time);
    // Nothing in an empty game inside the grace period draws, so the generator is where the
    // game's creation left it on either partition.
    expect(daily.at(-1)?.persistent).toEqual(whole.at(-1)?.persistent);
  });

  it("breaks at midnight and carries the remainder forward", () => {
    // Deviation 1 of the register: upstream truncates a day-crossing tick to 00:00:00 and
    // drops what is left (`player.py:277`); the port keeps the break and keeps the seconds.
    const { state } = advance(createInitialState(newGame), 86400 + 3600);

    expect(state.gameTime).toBe(86400 + 3600);
  });

  it("returns a new state root every tick, so reference equality is a change check", () => {
    const before = createInitialState(newGame);
    const first = advance(before, 0);
    const second = advance(first.state, 1);

    expect(first.state).not.toBe(before);
    expect(second.state).not.toBe(first.state);
    expect(before.gameTime).toBe(0);
  });

  it("derives the next root from the one it was given, so a field it does not know survives", () => {
    // Every later slice widens the root. A root rebuilt literally would drop whatever the
    // widening added, silently.
    const widened = { ...createInitialState(newGame), unknownToThisSlice: 5 };

    const { state } = advance(widened, 60);

    expect(state).toMatchObject({ gameTime: 60, unknownToThisSlice: 5 });
    expect(widened).toMatchObject({ gameTime: 0, unknownToThisSlice: 5 });
  });

  it("returns a plain value, not an instance of anything", () => {
    const { state } = advance(createInitialState(newGame), 1);

    expect(Object.getPrototypeOf(state)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(projectPersistent(state))).toBe(Object.prototype);
  });

  it("refuses a span that is not a whole number of game-seconds", () => {
    const state = createInitialState(newGame);

    expect(() => advance(state, 0.5)).toThrow(RangeError);
    expect(() => advance(state, -1)).toThrow(RangeError);
    expect(() => advance(state, Number.NaN)).toThrow(RangeError);
  });
});
