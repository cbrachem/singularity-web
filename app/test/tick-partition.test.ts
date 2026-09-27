// @vitest-environment node
//
// The host seam, headless on purpose: the tick partition is a closed-form function of
// (game time, Speed) and has no browser in it. Running this file under Node
// rather than happy-dom is what says so — a `document` reached for here is a failure.
import { SECONDS_PER_DAY } from "@singularity/sim";
import { describe, expect, it } from "vitest";

import {
  QUANTUM,
  SPEEDS,
  nextTick,
  quantumFor,
  tickPartition,
  type Speed,
} from "../src/host/tick-partition.ts";

/** The Speeds that tick. Speed 0 is the pause and is handled on its own. */
const RUNNING: readonly Speed[] = SPEEDS.filter((speed) => speed !== 0);

/** A start that is on no speed's grid, so every quantum has a phase to correct. */
const MISALIGNED = 601;

function takeTicks(gameTime: number, speed: Speed, count: number): number[] {
  const ticks: number[] = [];
  let time = gameTime;
  for (let index = 0; index < count; index += 1) {
    const tick = nextTick(time, speed);
    ticks.push(tick);
    time += tick;
  }
  return ticks;
}

describe("the quantum table", () => {
  it("is upstream's five speeds", () => {
    // `speeds` in `code/screens/map.py:342`.
    expect(SPEEDS).toEqual([0, 1, 60, 7200, 432000]);
  });

  it("is the reference's 30 Hz tick rate, as a table rather than a division by the frame rate", () => {
    // `curr_speed / FPS` with `FPS = 30` (`code/graphics/g.py:91`), except at speed 1,
    // where upstream's accumulator takes 30 frames to reach one whole game-second.
    expect(QUANTUM).toEqual({ 0: 0, 1: 1, 60: 2, 7200: 240, 432000: 14400 });
  });

  it("gives every running speed a quantum that divides a day", () => {
    for (const speed of RUNNING) {
      expect(SECONDS_PER_DAY % quantumFor(speed)).toBe(0);
    }
  });

  it("does not tick at speed 0", () => {
    expect(nextTick(MISALIGNED, 0)).toBe(0);
    expect(tickPartition(MISALIGNED, 0, 10 * SECONDS_PER_DAY)).toEqual([]);
  });

  it("refuses a game time that is not a whole number of game-seconds", () => {
    expect(() => nextTick(1.5, 60)).toThrow(RangeError);
    expect(() => nextTick(-1, 60)).toThrow(RangeError);
  });
});

describe("the grid", () => {
  it("ends every tick on a multiple of the quantum in absolute game time", () => {
    for (const speed of RUNNING) {
      const quantum = quantumFor(speed);
      let time = MISALIGNED;
      for (const tick of takeTicks(MISALIGNED, speed, 200)) {
        time += tick;
        expect(time % quantum).toBe(0);
      }
    }
  });

  it("never produces a tick that crosses midnight, from any start at any speed", () => {
    const starts = [0, 1, MISALIGNED, SECONDS_PER_DAY - 1, 22 * SECONDS_PER_DAY + 13_337];
    for (const speed of RUNNING) {
      for (const start of starts) {
        let time = start;
        for (const tick of takeTicks(start, speed, 200)) {
          const dayAtStart = Math.floor(time / SECONDS_PER_DAY);
          const dayAtLastSecond = Math.floor((time + tick - 1) / SECONDS_PER_DAY);
          expect(dayAtLastSecond).toBe(dayAtStart);
          time += tick;
        }
      }
    }
  });

  it("costs one short tick for a misaligned phase and is exactly the quantum after it", () => {
    for (const speed of RUNNING) {
      const quantum = quantumFor(speed);
      const [first, ...rest] = takeTicks(MISALIGNED, speed, 200);

      expect(first).toBe(quantum - (MISALIGNED % quantum));
      expect(new Set(rest)).toEqual(new Set([quantum]));
    }
  });

  it("charges a speed change exactly one short tick, and the phase is aligned again", () => {
    // Aligned on the 2-second grid of speed 60, misaligned on the 240-second grid of 7200.
    const afterASpeedChange = 602;

    const ticks = takeTicks(afterASpeedChange, 7200, 200);

    expect(ticks[0]).toBe(118);
    expect(ticks[0]).toBeLessThan(quantumFor(7200));
    expect(ticks.slice(1)).toEqual(Array.from({ length: 199 }, () => 240));
  });

  it("is a function of the clock alone, whatever partition led to that clock", () => {
    const viaOneSpeed = takeTicks(0, 432000, 4).reduce((sum, tick) => sum + tick, 0);
    const viaAnother = takeTicks(0, 60, 28_800).reduce((sum, tick) => sum + tick, 0);

    expect(viaOneSpeed).toBe(viaAnother);
    expect(nextTick(viaOneSpeed, 7200)).toBe(nextTick(viaAnother, 7200));
  });
});

describe("the partition of a span", () => {
  it("is computable without simulating a frame", () => {
    expect(tickPartition(MISALIGNED, 7200, 1000)).toEqual([119, 240, 240, 240]);
  });

  it("carries no partial tick: what does not fit is left owed", () => {
    expect(tickPartition(0, 60, 5)).toEqual([2, 2]);
    expect(tickPartition(0, 60, 0)).toEqual([]);
  });

  it("adds up to the whole span when the span lands on the grid", () => {
    const ticks = tickPartition(0, 432000, 2 * SECONDS_PER_DAY);

    expect(ticks.reduce((sum, tick) => sum + tick, 0)).toBe(2 * SECONDS_PER_DAY);
  });
});
