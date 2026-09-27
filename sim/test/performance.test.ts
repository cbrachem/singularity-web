// boundary-intent harness: a test, so it decides what to drive and what to expect
import { describe, expect, it, vi } from "vitest";

import {
  SECONDS_PER_DAY,
  advance,
  allBases,
  applyCommand,
  content,
  createInitialState,
  type AdvanceResult,
  type SimulationState,
} from "../src/index.ts";

/**
 * The performance tripwire.
 *
 * The supported worst case is **1000 bases**, and the Simulation has some 250× of headroom
 * there. So this is not a budget and must never be read as one:
 * it is a tripwire on the *shape* of the tick — an accidental O(n²), a deep clone per tick,
 * Content rebuilt inside the loop — set far enough above the measured value that CI noise
 * cannot reach it and an algorithmic regression cannot miss it.
 *
 * # The measurement behind the ceiling
 *
 * `MEASURED` is what {@link runTripwire} took on the machine this was written on — a Linux
 * workstation, Vitest, 2026-08-24:
 *
 * | run                                      | wall clock inside the tick |
 * | ---------------------------------------- | -------------------------- |
 * | 50 post-grace game-days, 1000 bases held | 287, 285, 357 ms           |
 *
 * The runs are {@link RUNS} and `MEASURED` is the slowest of them, asserted below because a
 * measurement kept as prose drifts into a number nobody took. The ceiling is
 * {@link CEILING}, which is {@link RATIO_FLOOR}–{@link RATIO_CEILING}× that, and that ratio
 * is asserted too, so the pair cannot drift apart in an edit. **A tripwire being approached
 * is already a bug**: the answer to a run that creeps towards this number is to find what
 * changed, never to raise it.
 *
 * # The ceiling is one number, wide enough for the slowest machine that runs it
 *
 * The measurement is a Linux workstation, and the gate also runs on a CI runner whose cores
 * are materially slower. The ceiling is therefore set for the slower of the two rather than
 * split into a CI-specific bound: one number is one thing to reason about, a pair invites a
 * CI value raised on its own until it stops meaning anything, and the
 * {@link RATIO_FLOOR}–{@link RATIO_CEILING}× band is wide enough to hold both. A run
 * {@link CI_SLOWDOWN}× slower than the measurement must still sit {@link CI_HEADROOM}× under
 * the ceiling, which is asserted below. The regressions this catches are thousands of times
 * slower than the tick, so nothing is lost by the width.
 *
 * # What is measured, and what is not
 *
 * Only the tick. The estate is topped back up to 1000 bases before each day — a thousand
 * bases discovered in a day is the worst case, and without the top-up the
 * worst case would evaporate a few days in — and that rebuilding is outside the clock,
 * because it is the harness holding the worst case rather than the work being measured.
 *
 * The run starts **past the grace period**, where every base is rolled against every group
 * that can find it. That is the loop over the estate, and a benchmark inside the grace
 * period would leave it out.
 */

/** The supported worst case. */
const BASES = 1000;

/** How many game-days the tripwire advances at that worst case. */
const DAYS = 50;

/** Days advanced before the estate is built, so the run measures post-grace ticks. */
const WARMUP_DAYS = 30;

/** Every timed run behind the ceiling, in milliseconds. See the note above. */
const RUNS = [287, 285, 357];

/** The slowest of {@link RUNS} — the measurement the ceiling is a multiple of. */
const MEASURED = 357;

/** The tripwire itself, in milliseconds of wall clock. */
const CEILING = 10_000;

const RATIO_FLOOR = 10;
const RATIO_CEILING = 30;

/**
 * How much slower per core a CI runner is taken to be than the machine measured on.
 *
 * **Measured once, kept as margin.** A CI run on `ubuntu-latest` read 452 ms against the
 * 357 ms measured here: about 1.3×. One reading on a shared runner is noisy, so the constant
 * stays 4, a margin over that reading. {@link runTripwire} prints the wall clock on every run, so each
 * CI log carries a new reading.
 */
const CI_SLOWDOWN = 4;

/** How far a CI-slow run of the measurement must still stay under the ceiling. */
const CI_HEADROOM = 5;

/**
 * Long enough for a run that has to trip {@link CEILING} to get there on a CI-slow machine,
 * with the warmup and the top-up on top. Derived, because a timeout under the ceiling turns
 * the proof below into a timeout rather than a trip.
 */
const TIMEOUT = CEILING * CI_SLOWDOWN * 3;

/** The worst-case base type: free, maintenance-free, and easily found. */
const WORST_CASE_BASE = "Stolen Computer Time";

/** One tick, as the seam offers it — the thing under measurement. */
type Tick = (state: SimulationState, gameSeconds: number) => AdvanceResult;

interface TripwireRun {
  /** How many days it got through before it stopped. */
  readonly days: number;
  /** Wall clock spent inside the tick, in milliseconds. */
  readonly elapsed: number;
  /** Whether the ceiling was passed, which is the whole verdict. */
  readonly tripped: boolean;
  /** The smallest estate any measured day started with. */
  readonly smallestEstate: number;
}

function basesIn(state: SimulationState): number {
  return [...allBases(state)].length;
}

/**
 * Hold the estate at the worst case and advance a day at a time, timing only the tick.
 *
 * It stops as soon as the ceiling is passed rather than running to the end: a tick that has
 * gone quadratic is thousands of times slower than this one, and a gate that waited for it
 * would take an hour to say so.
 *
 * It reports its wall clock on the way out, pass or fail. That line is the reading
 * {@link CI_SLOWDOWN} needs and no assertion can take, so it leaves through the log.
 */
function runTripwire(tick: Tick = advance): TripwireRun {
  const locations = [...content.locations.byId.keys()];
  let serial = 0;

  const topUp = (state: SimulationState): SimulationState => {
    let out = state;
    for (let held = basesIn(out); held < BASES; held += 1) {
      out = applyCommand(out, {
        command: "buildBase",
        location: locations[held % locations.length] as string,
        baseType: WORST_CASE_BASE,
        name: `Worst ${serial++}`,
      });
    }
    return out;
  };

  let state = createInitialState({ seed: 1, difficulty: "normal" });
  for (let day = 0; day < WARMUP_DAYS; day += 1) state = advance(state, SECONDS_PER_DAY).state;

  let elapsed = 0;
  let days = 0;
  let smallestEstate = Number.POSITIVE_INFINITY;
  while (days < DAYS && elapsed <= CEILING) {
    state = topUp(state);
    smallestEstate = Math.min(smallestEstate, basesIn(state));
    const started = performance.now();
    state = tick(state, SECONDS_PER_DAY).state;
    elapsed += performance.now() - started;
    days += 1;
  }

  console.info(
    `Performance tripwire: ${days} game-days at ${BASES} bases in ${elapsed.toFixed(0)} ms, ` +
      `against a ${CEILING} ms ceiling and a measured ${MEASURED} ms`,
  );

  return { days, elapsed, tripped: elapsed > CEILING, smallestEstate };
}

describe("the supported worst case", () => {
  it(
    "advances fifty game-days at a thousand bases inside the ceiling, and says how long it took",
    () => {
      const reported = vi.spyOn(console, "info");
      const run = runTripwire();

      expect(run.smallestEstate, "the estate is held at the worst case").toBe(BASES);
      expect(run.days).toBe(DAYS);

      // Only a CI run can measure {@link CI_SLOWDOWN}, and this run is that measurement. Its
      // wall clock is therefore reported rather than kept for a
      // failure message a green run never prints, and the reporting is guarded here rather
      // than trusted: dropping the line silently loses the number.
      expect(
        reported,
        "the run has to print its wall clock, or a green CI run hands nothing over",
      ).toHaveBeenCalledWith(expect.stringContaining(`in ${run.elapsed.toFixed(0)} ms`));

      expect(
        run.elapsed,
        `${DAYS} game-days at ${BASES} bases took ${run.elapsed.toFixed(0)} ms, past the ` +
          `${CEILING} ms tripwire. It is set ${RATIO_FLOOR}–${RATIO_CEILING}× above a ` +
          `measured ${MEASURED} ms, so this is an algorithmic regression rather than a slow ` +
          `machine: look for work that has become quadratic in the estate, a clone per tick, ` +
          `or Content rebuilt inside the loop`,
      ).toBeLessThanOrEqual(CEILING);
      reported.mockRestore();
    },
    TIMEOUT,
  );

  // The ceiling is a multiple of a measurement, and the measurement is written down. Left
  // unchecked, the pair drifts: a ceiling raised to quiet a failure turns the tripwire into
  // a budget, and one lowered towards the measurement turns it into CI noise.
  it("keeps the ceiling a tripwire rather than a budget", () => {
    expect(CEILING / MEASURED).toBeGreaterThanOrEqual(RATIO_FLOOR);
    expect(CEILING / MEASURED).toBeLessThanOrEqual(RATIO_CEILING);
  });

  // The measurement is prose about runs that happened, so nothing stops it from becoming a
  // number nobody took. It is the slowest run rather than a mean, because the ceiling has to
  // clear the worst measured tick and not an average one.
  it("takes the measurement from the slowest run recorded", () => {
    expect(RUNS).toContain(MEASURED);
    expect(MEASURED).toBe(Math.max(...RUNS));
  });

  // The measurement is a Linux workstation; the gate also runs on a CI runner with slower
  // cores. A healthy run there must stay far from the wire, or the tripwire reports the
  // machine instead of the code.
  it("leaves a CI runner clear of the wire", () => {
    expect(CEILING / (MEASURED * CI_SLOWDOWN)).toBeGreaterThanOrEqual(CI_HEADROOM);
  });

  /**
   * The tripwire has to be able to fire, or the run above is a test that can only pass.
   *
   * The defect is the most likely one: work that was done once per tick is done
   * once per base instead. Nothing about the tick changes — it is the same `advance` over
   * the same estate — so what this measures is the cost of the shape, not of an invented
   * slow function.
   */
  it(
    "fires on a deliberately quadratic tick",
    () => {
      const quadratic: Tick = (state, gameSeconds) => {
        const result = advance(state, gameSeconds);
        for (let repeat = 1; repeat < basesIn(state); repeat += 1) advance(state, gameSeconds);
        return result;
      };

      const run = runTripwire(quadratic);

      expect(run.tripped).toBe(true);
      expect(run.days).toBeLessThan(DAYS);
    },
    TIMEOUT,
  );
});
