// @vitest-environment node
//
// The host seam, headless: the driver owns the accumulator and nothing else, so it can be
// driven frame by frame without a browser in the room.
import { PAUSE } from "@singularity/sim";
import { describe, expect, it } from "vitest";

import {
  PAUSE_REQUEST,
  createScheduler,
  type SchedulerTarget,
  type SpeedSetting,
  type TaggedEffect,
} from "../src/host/scheduler.ts";
import { MAX_FRAME_SECONDS } from "../src/host/time.ts";
import { SPEEDS, quantumFor, tickPartition, type Speed } from "../src/host/tick-partition.ts";

/** The Speeds that tick. */
const RUNNING: readonly Speed[] = SPEEDS.filter((speed) => speed !== 0);

/** A start that is on no speed's grid. */
const MISALIGNED = 601;

interface FakeTarget extends SchedulerTarget {
  readonly ticks: readonly number[];
  /** How many times the driver has read the clock. */
  readonly clockReads: number;
  /** Effects the next tick returns, then the one after, and so on. */
  emit(...effects: readonly TaggedEffect[][]): void;
}

function fakeTarget(gameTime = 0): FakeTarget {
  let now = gameTime;
  let clockReads = 0;
  const ticks: number[] = [];
  const queued: (readonly TaggedEffect[])[] = [];
  return {
    ticks,
    get clockReads() {
      return clockReads;
    },
    get gameTime() {
      clockReads += 1;
      return now;
    },
    tick(gameSeconds) {
      ticks.push(gameSeconds);
      now += gameSeconds;
      return queued.shift() ?? [];
    },
    emit(...effects) {
      queued.push(...effects);
    },
  };
}

function scheduler(target: SchedulerTarget, initial: Speed) {
  const speed = { value: initial };
  const renders = { count: 0 };
  const driver = createScheduler({
    target,
    speed,
    render: () => {
      renders.count += 1;
    },
  });
  return { driver, speed, renders };
}

const SPAN_SECONDS = 3.6;
const JITTER = [0.004, 0.061, 0.017, 0.099, 0.032, 0.008, 0.045, 0.093, 0.021, 0.054, 0.072];

function evenFrames(fps: number): number[] {
  return Array.from({ length: Math.round(SPAN_SECONDS * fps) }, () => 1 / fps);
}

/** Frames of wildly uneven length, adding up to the same wall-clock span. */
function jitteredFrames(): number[] {
  const frames: number[] = [];
  for (let round = 0; round < 7; round += 1) frames.push(...JITTER);
  return [...frames, SPAN_SECONDS - frames.reduce((sum, dt) => sum + dt, 0)];
}

function run(frames: readonly number[], speed: Speed): readonly number[] {
  const target = fakeTarget(MISALIGNED);
  const { driver } = scheduler(target, speed);
  for (const dt of frames) driver.frame(dt);
  return target.ticks;
}

describe("the driver", () => {
  it("drains a frame into whole grid steps", () => {
    const target = fakeTarget();
    const { driver } = scheduler(target, 60);

    driver.frame(0.1);

    expect(target.ticks).toEqual([2, 2, 2]);
  });

  it("keeps what did not reach the next grid point and spends it on a later frame", () => {
    const target = fakeTarget();
    const { driver } = scheduler(target, 1);
    const frame = 1 / 16;

    for (let count = 0; count < 15; count += 1) driver.frame(frame);
    const beforeTheSixteenth = [...target.ticks];
    driver.frame(frame);

    expect(beforeTheSixteenth).toEqual([]);
    expect(target.ticks).toEqual([1]);
  });

  it("does not tick at speed 0, and does not render either", () => {
    const target = fakeTarget();
    const { driver, renders } = scheduler(target, 0);

    driver.frame(1);
    driver.frame(1);

    expect(target.ticks).toEqual([]);
    expect(renders.count).toBe(0);
  });

  it("does not render a frame that ran no tick", () => {
    const target = fakeTarget();
    const { driver, renders } = scheduler(target, 1);

    // A 60 fps frame at speed 1 is 1/60 of a game-second: nothing reaches the next grid
    // point, so there is no new State root and nothing to publish. 59 frames in every 60
    // look like this, and the driver may not lean on Presentation deduping them.
    driver.frame(1 / 60);

    expect(target.ticks).toEqual([]);
    expect(renders.count).toBe(0);
  });

  it("renders once however many ticks ran", () => {
    const target = fakeTarget();
    const { driver, renders } = scheduler(target, 432000);

    driver.frame(MAX_FRAME_SECONDS);

    expect(target.ticks).toHaveLength(3);
    expect(renders.count).toBe(1);
  });
});

describe("the frame rate", () => {
  it("does not reach the tick partition: 60 fps, 30 fps and jitter agree", () => {
    for (const speed of [1, 60, 7200, 432000] as const) {
      const at60 = run(evenFrames(60), speed);
      const at30 = run(evenFrames(30), speed);
      const jittered = run(jitteredFrames(), speed);

      expect(at30).toEqual(at60);
      expect(jittered).toEqual(at60);
    }
  });

  it("splits a span across frames into the partition the whole span has", () => {
    // The driver partitions what it owes one frame at a time; this is the same span handed
    // to `tickPartition` in a single call. The two agreeing is the partition being additive
    // — the property that lets a Scenario state a span's ticks without a frame loop.
    const span = SPAN_SECONDS * 60;

    expect(run(evenFrames(60), 60)).toEqual(tickPartition(MISALIGNED, 60, span));
  });
});

describe("the partition", () => {
  it("is taken from the closed form: the driver reads the clock once a frame", () => {
    const target = fakeTarget(MISALIGNED);
    const { driver } = scheduler(target, 7200);

    driver.frame(MAX_FRAME_SECONDS);

    // Three ticks, one reading. A driver that re-derives the partition step by step asks the
    // clock again after every tick — the same partition, arrived at the expensive way.
    expect(target.ticks).toHaveLength(3);
    expect(target.clockReads).toBe(1);
  });
});

describe("a stall", () => {
  it("costs the player game time and leaves the partition untouched", () => {
    const target = fakeTarget();
    const { driver, speed } = scheduler(target, 432000);

    driver.frame(30);

    // 100 ms at 432,000 game-seconds per real second is 43,200 game-seconds: three whole
    // ticks, and the 29.9 s the machine was away are simply gone.
    expect(target.ticks).toEqual([14400, 14400, 14400]);
    expect(speed.value).toBe(432000);
  });

  it("clamps a hidden tab and a breakpoint alike, however long either lasted", () => {
    const oneMinute = fakeTarget();
    const oneHour = fakeTarget();
    scheduler(oneMinute, 7200).driver.frame(60);
    scheduler(oneHour, 7200).driver.frame(3600);

    expect(oneHour.ticks).toEqual(oneMinute.ticks);
  });
});

describe("a pause effect", () => {
  // The effect the tests below hand the driver is the Simulation's own `PAUSE`, not a record
  // spelled here from the driver's constant — spelling it here would make the pair agree by
  // construction and check nothing. The kind belongs to the Simulation; the driver holds the
  // only copy of it outside `sim/`, so this is where the two are made to meet.
  it("is recognised by the kind the Simulation declares, not by a spelling of the driver's", () => {
    expect(PAUSE_REQUEST).toBe(PAUSE.kind);
  });

  it("breaks the frame's remaining ticks and sets the speed to 0", () => {
    const target = fakeTarget();
    const { driver, speed } = scheduler(target, 432000);
    target.emit([PAUSE]);

    driver.frame(MAX_FRAME_SECONDS);

    expect(target.ticks).toEqual([14400]);
    expect(speed.value).toBe(0);
  });

  it("does not clear the accumulator: the game seconds it broke on are still owed", () => {
    const target = fakeTarget();
    const { driver, speed } = scheduler(target, 432000);
    target.emit([PAUSE]);

    driver.frame(MAX_FRAME_SECONDS);
    speed.value = 432000;
    driver.frame(0);

    expect(target.ticks).toEqual([14400, 14400, 14400]);
  });

  // The resume frame above is zero-length, which is the one shape the accumulator ceiling can
  // never bite: it takes nothing in. A real resume frame takes a frame's worth in on top of
  // what the broken frame left owed, and the two together are what the ceiling used to clip.
  it("owes them still when the resume frame takes a whole frame in as well", () => {
    const target = fakeTarget();
    const { driver, speed } = scheduler(target, 432000);
    target.emit([PAUSE]);

    driver.frame(MAX_FRAME_SECONDS);
    speed.value = 432000;
    driver.frame(MAX_FRAME_SECONDS);

    // Two clamped frames at top speed are 86,400 game-seconds and the stop moved none of
    // them: one Tick before it, five after it, and nothing between the two frames dropped.
    expect(target.ticks).toEqual([14400, 14400, 14400, 14400, 14400, 14400]);
    expect(target.gameTime).toBe(2 * MAX_FRAME_SECONDS * 432000);
  });

  // The other half of the same rule: what the ceiling is for is a *rate* change, and a resume
  // at a Speed the seconds were not earned at is one.
  it("banks no burst when the player resumes at a different Speed", () => {
    const target = fakeTarget();
    const { driver, speed } = scheduler(target, 432000);
    target.emit([PAUSE]);

    driver.frame(MAX_FRAME_SECONDS);
    speed.value = 1;
    driver.frame(1 / 60);

    // 28,800 seconds were owed at top speed. They are not a licence to run 28,800 one-second
    // Ticks in the frame that starts the clock again at Speed 1.
    expect(target.ticks).toEqual([14400, 1]);
  });

  it("still renders the frame it broke", () => {
    const target = fakeTarget();
    const { driver, renders } = scheduler(target, 432000);
    target.emit([PAUSE]);

    driver.frame(MAX_FRAME_SECONDS);

    expect(renders.count).toBe(1);
  });

  /**
   * A stop leaves its unrun Ticks owed and nothing spends them until a frame runs
   * unbroken, so a *run* of stops used to add up without a bound — and the first unbroken
   * frame paid the whole sum out as one burst of Ticks.
   *
   * The run is what is bounded, not the stop: one stop and two stops carry everything they
   * owe, which is the rule of the two tests above.
   */
  const stopEveryFirstTick = (rounds: number): FakeTarget => {
    const target = fakeTarget();
    const { driver, speed } = scheduler(target, 432000);
    for (let round = 0; round < rounds; round += 1) {
      target.emit([PAUSE]);
      speed.value = 432000;
      driver.frame(MAX_FRAME_SECONDS);
    }
    // The frame that runs to its end: it takes nothing in, so what it spends is the bank.
    speed.value = 432000;
    driver.frame(0);
    return target;
  };

  it("carries a bounded bank through a run of stops, however long the run is", () => {
    const five = stopEveryFirstTick(5).ticks.length;
    const fifty = stopEveryFirstTick(50).ticks.length;

    // Uncapped the bank grew 28,800 game-seconds — two Ticks — per round, so fifty rounds
    // paid out ninety Ticks more than five did.
    expect(fifty - 50).toBe(five - 5);
  });

  it("pays a run of stops out in no more Ticks than a stop's carry is worth", () => {
    const payout = stopEveryFirstTick(50).ticks.length - 50;

    // Twice the ceiling: one clamped frame to spend, and one stop's carry held on top of it.
    const ceiling = MAX_FRAME_SECONDS * 432000 + quantumFor(432000);
    expect(payout).toBeLessThanOrEqual((2 * ceiling) / quantumFor(432000));
    expect(payout).toBeGreaterThan(0);
  });
});

/**
 * A pause Effect is not the only way the clock stops during a frame: whatever drains a Tick's
 * Effects runs before the driver takes its next step, and the Host stops the clock there for a
 * game that has just been lost (`host/session.ts`).
 *
 * The driver answers to neither: it ends the frame on the **Speed cell**, whatever wrote it,
 * and it cannot tell a loss from any other stop without being handed a second channel it has
 * no business owning. A stop means the same thing in both cases — no more game time until the
 * player has looked — so a drain's stop ends the frame exactly the way a pause request does,
 * and the tests below say so in the same words as the pause's.
 */
describe("a clock stopped by a drain", () => {
  /**
   * A target that drains its own Tick's Effects the way the Host does — the drain runs before
   * the driver takes its next step — and stops the clock on the `stopAt`-th Tick.
   */
  function stoppingOnTick(stopAt: number, speed: SpeedSetting) {
    const inner = fakeTarget();
    let taken = 0;
    const target: SchedulerTarget = {
      get gameTime() {
        return inner.gameTime;
      },
      tick(gameSeconds) {
        const effects = inner.tick(gameSeconds);
        taken += 1;
        if (taken === stopAt) speed.value = 0;
        return effects;
      },
    };
    return { inner, target };
  }

  it("stops the frame's remaining ticks", () => {
    const speed: SpeedSetting = { value: 432000 };
    const { inner, target } = stoppingOnTick(1, speed);
    const driver = createScheduler({ target, speed, render: () => {} });

    driver.frame(MAX_FRAME_SECONDS);

    expect(inner.ticks).toEqual([14400]);
  });

  // The stop lands in the middle of the frame rather than on its first Tick: the ticks before
  // it ran, and the ticks after it did not.
  it("stops it wherever in the frame the stop lands", () => {
    const speed: SpeedSetting = { value: 432000 };
    const { inner, target } = stoppingOnTick(2, speed);
    const driver = createScheduler({ target, speed, render: () => {} });

    driver.frame(MAX_FRAME_SECONDS);

    expect(inner.ticks).toEqual([14400, 14400]);
  });

  it("does not clear the accumulator: the game seconds it broke on are still owed", () => {
    const speed: SpeedSetting = { value: 432000 };
    const { inner, target } = stoppingOnTick(1, speed);
    const driver = createScheduler({ target, speed, render: () => {} });

    driver.frame(MAX_FRAME_SECONDS);
    speed.value = 432000;
    driver.frame(0);

    expect(inner.ticks).toEqual([14400, 14400, 14400]);
  });

  it("owes them still when the resume frame takes a whole frame in as well", () => {
    const speed: SpeedSetting = { value: 432000 };
    const { inner, target } = stoppingOnTick(1, speed);
    const driver = createScheduler({ target, speed, render: () => {} });

    driver.frame(MAX_FRAME_SECONDS);
    speed.value = 432000;
    driver.frame(MAX_FRAME_SECONDS);

    expect(inner.ticks).toEqual([14400, 14400, 14400, 14400, 14400, 14400]);
    expect(inner.gameTime).toBe(2 * MAX_FRAME_SECONDS * 432000);
  });

  it("still renders the frame it broke", () => {
    const speed: SpeedSetting = { value: 432000 };
    const { target } = stoppingOnTick(1, speed);
    let renders = 0;
    const driver = createScheduler({
      target,
      speed,
      render: () => {
        renders += 1;
      },
    });

    driver.frame(MAX_FRAME_SECONDS);

    expect(renders).toBe(1);
  });

  // The cell is the rule, not the write to it. A drain that stops the clock and a drain that
  // starts it again leave a running clock behind, and a running clock is a frame that goes on.
  it("goes on ticking when a drain stops the clock and another starts it in the same tick", () => {
    const inner = fakeTarget();
    const speed: SpeedSetting = { value: 432000 };
    const target: SchedulerTarget = {
      get gameTime() {
        return inner.gameTime;
      },
      tick(gameSeconds) {
        const effects = inner.tick(gameSeconds);
        speed.value = 0;
        speed.value = 432000;
        return effects;
      },
    };
    const driver = createScheduler({ target, speed, render: () => {} });

    driver.frame(MAX_FRAME_SECONDS);

    expect(inner.ticks).toEqual([14400, 14400, 14400]);
  });
});

/** The most game time a single frame spends at `speed` when the Speed has not changed. */
function steadyMaxSpend(speed: Speed): number {
  const target = fakeTarget(MISALIGNED);
  const { driver } = scheduler(target, speed);
  let most = 0;
  let spent = 0;
  for (let frame = 0; frame < 200; frame += 1) {
    const before = target.ticks.length;
    driver.frame(MAX_FRAME_SECONDS);
    const frameSpend = target.ticks
      .slice(before)
      .reduce((sum: number, tick: number) => sum + tick, 0);
    most = Math.max(most, frameSpend);
    spent += frameSpend;
  }
  expect(spent).toBeGreaterThan(0);
  return most;
}

/** Loads the accumulator at `from`, changes to `to`, and reports the next frame's ticks. */
function afterAChangeTo(from: Speed, to: Speed): readonly number[] {
  const target = fakeTarget(MISALIGNED);
  const { driver, speed } = scheduler(target, from);
  // 99 ms rather than 100 leaves a large leftover at every speed instead of a round nothing.
  driver.frame(0.099);
  const banked = target.ticks.length;
  speed.value = to;
  driver.frame(1 / 60);
  return target.ticks.slice(banked);
}

describe("a speed change", () => {
  it("does not spend the seconds banked at the old rate as a burst at the new one", () => {
    const target = fakeTarget();
    const { driver, speed } = scheduler(target, 432000);

    // 99 ms at top speed is 42,768 game-seconds: two whole ticks, and 13,968 left owed.
    driver.frame(0.099);
    const banked = target.ticks.length;
    // The player slows the game right down, which is what a player does when something needs
    // their attention. The 13,968 seconds were earned at 432,000x and are not a licence to
    // run 13,968 one-second ticks in the very next frame.
    speed.value = 1;
    driver.frame(1 / 60);
    const afterTheChange = target.ticks.slice(banked);

    expect(target.ticks.slice(0, banked)).toEqual([14400, 14400]);
    expect(afterTheChange).toHaveLength(1);
    expect(afterTheChange).toEqual([1]);
  });

  it("leaves the frame after it worth no more than a frame at the new speed, plus a tick", () => {
    for (const to of RUNNING) {
      const ceiling = steadyMaxSpend(to) + quantumFor(to);
      for (const from of RUNNING) {
        const spent = afterAChangeTo(from, to).reduce((sum, tick) => sum + tick, 0);

        expect(spent, `${from} -> ${to}`).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it("costs one short tick, after which the phase is aligned again", () => {
    const target = fakeTarget();
    const { driver, speed } = scheduler(target, 60);

    driver.frame(MAX_FRAME_SECONDS);
    speed.value = 7200;
    driver.frame(MAX_FRAME_SECONDS);

    expect(target.ticks.slice(0, 3)).toEqual([2, 2, 2]);
    const afterTheChange = target.ticks.slice(3);
    expect(afterTheChange[0]).toBe(234);
    expect(afterTheChange.slice(1)).toEqual([240, 240]);
  });
});
