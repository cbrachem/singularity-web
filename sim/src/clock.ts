/**
 * Game time, in whole game-seconds, and the two things the rules ask of it: what the clock
 * reads, and how a per-day quantity is spread across a tick.
 *
 * The Simulation keeps one number — the seconds elapsed since the game began — and derives
 * the rest. Upstream keeps eight fields and a method that rebuilds them (`player.py:179`),
 * which is arrangement rather than behaviour; what is behaviour is the day
 * boundary, because daily processing keys off it, and the sharing formula, because
 * maintenance is charged against it.
 */

export const SECONDS_PER_MINUTE = 60;
export const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;
export const MINUTES_PER_DAY = MINUTES_PER_HOUR * HOURS_PER_DAY;
export const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
export const SECONDS_PER_DAY = SECONDS_PER_HOUR * HOURS_PER_DAY;

/** Upstream's `g.max_cash` — pi quadrillion, and a float in the reference too. */
export const MAX_CASH = 3.14 * 10 ** 15;

/** Whole minutes elapsed, which is what construction is measured in. */
export function rawMinutes(gameTime: number): number {
  return Math.floor(gameTime / SECONDS_PER_MINUTE);
}

/** Whole days elapsed, which is what the grace period and daily processing key off. */
export function rawDays(gameTime: number): number {
  return Math.floor(gameTime / SECONDS_PER_DAY);
}

/** Seconds since the last midnight. */
export function timeOfDay(gameTime: number): number {
  return gameTime % SECONDS_PER_DAY;
}

/**
 * `g.current_share` (`g.py:203`): how much of a per-day quantity falls inside this tick.
 *
 * Not `numPerDay * seconds / 86400`. It is the difference between two truncated running
 * totals, so the shares of a day's ticks sum to the day's quantity however the day was
 * partitioned — and a tick that reaches back over midnight is charged against yesterday's
 * total as well, which the recursion is for.
 */
export function currentShare(
  numPerDay: number,
  secondsIntoDay: number,
  secondsPassed: number,
): number {
  const lastTime = secondsIntoDay - secondsPassed;
  const shareYesterday = lastTime < 0 ? currentShare(numPerDay, SECONDS_PER_DAY, -lastTime) : 0;
  const from = lastTime < 0 ? 0 : lastTime;

  const previouslyPassed = Math.floor((numPerDay * from) / SECONDS_PER_DAY);
  const currentPassed = Math.floor((numPerDay * secondsIntoDay) / SECONDS_PER_DAY);

  return shareYesterday + (currentPassed - previouslyPassed);
}
