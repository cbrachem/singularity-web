/**
 * The Tick partition: how a span of game time is divided into Ticks.
 *
 * It is observable — per-tick RNG draws depend on it and the construction kernel rounds once
 * per tick — so it may not fall out of the frame rate. It is pinned instead: **a tick
 * always ends on the next multiple of the current Speed's quantum in *absolute* game time.**
 * That makes the partition a closed-form function of `(game time, Speed)`, computable without
 * simulating a single frame, which is what the fidelity harness needs of it.
 *
 * Nothing here is stateful and nothing here is a browser API. The driver that turns
 * wall-clock time into calls on this lives in `scheduler.ts`.
 */

/**
 * The Speed setting: the player's target rate of game-seconds per real second, and one of
 * exactly five values — upstream's `speeds` (`code/screens/map.py:342`). It belongs to the
 * Host, never to the Simulation, and it is a *target*: a machine that cannot keep
 * up advances game time more slowly rather than taking larger ticks.
 */
export const SPEEDS = [0, 1, 60, 7200, 432000] as const;

export type Speed = (typeof SPEEDS)[number];

/**
 * The quantum each Speed ticks at, in game-seconds.
 *
 * It is upstream's own 30 Hz tick rate — `curr_speed / FPS` with `FPS = 30`
 * (`code/graphics/g.py:91`) — but written as a table, which decouples it from the frame rate
 * and lets the one requirement the formula does not state be checked: **every quantum divides
 * a day.** That is what keeps a tick from ever straddling midnight, where daily processing
 * keys off the boundary. Speed 1 is the exception the division cannot express: upstream's
 * accumulator takes 30 frames to reach one whole game-second, so the quantum is 1.
 *
 * Speed 0 does not tick, and 0 is how that is said in the same table rather than beside it.
 */
export const QUANTUM: Readonly<Record<Speed, number>> = Object.freeze({
  0: 0,
  1: 1,
  60: 2,
  7200: 240,
  432000: 14400,
});

export function quantumFor(speed: Speed): number {
  return QUANTUM[speed];
}

/**
 * The size of the next Tick: the distance from `gameTime` to the next multiple of the
 * Speed's quantum. 0 at Speed 0, which does not tick.
 *
 * The grid is absolute rather than relative to the last tick, which is the whole decision: a
 * Speed change costs exactly one short tick and the phase is aligned again, instead of a
 * permanent offset that re-splits every game day for the rest of the session.
 */
export function nextTick(gameTime: number, speed: Speed): number {
  if (!Number.isInteger(gameTime) || gameTime < 0) {
    throw new RangeError(
      `the tick partition is a function of whole, non-negative game-seconds, got ${gameTime}`,
    );
  }
  const quantum = QUANTUM[speed];
  if (quantum === 0) return 0;
  return quantum - (gameTime % quantum);
}

/**
 * The whole Ticks a span of `gameSeconds` produces from `gameTime` at `speed`. What does not
 * reach the next grid point is not a tick; the driver keeps it owed.
 */
export function tickPartition(
  gameTime: number,
  speed: Speed,
  gameSeconds: number,
): readonly number[] {
  const ticks: number[] = [];
  let time = gameTime;
  let owed = gameSeconds;
  for (;;) {
    const tick = nextTick(time, speed);
    if (tick === 0 || owed < tick) return ticks;
    ticks.push(tick);
    owed -= tick;
    time += tick;
  }
}
