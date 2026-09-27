/**
 * `chance.roll_interval` (`chance.py:39`): the one kernel every recurring risk in the game
 * is rolled through, and the only place the live path meets a transcendental.
 *
 * A chance is quoted per day. A tick is not a day, so the rate is scaled by the portion of a
 * day the tick covers and the probability of at least one occurrence in that interval is
 * taken from the Poisson distribution — which is what makes the distribution independent of
 * how the day was partitioned into ticks.
 *
 * The arithmetic is transcribed rather than simplified. `1 - exp(-rate)` is not rewritten as
 * `-expm1(-rate)` and the two multiplications are not folded: the comparison against the
 * draw is decided in the last bit, and `exp` comes from `./libm/exp.ts` rather than from the
 * runtime because JavaScript engines do not agree with each other about it.
 */

import { SECONDS_PER_DAY } from "./clock.ts";
import { exp } from "./libm/exp.ts";
import type { Rng } from "./rng/random.ts";

/**
 * One draw, always: the roll is made whether or not the chance is zero. That is not a
 * detail — the draw log is compared, and a roll skipped because it could not have succeeded
 * would displace every draw after it.
 */
export function rollInterval(rng: Rng, chancePerDay: number, seconds: number): boolean {
  const portionOfDay = seconds / SECONDS_PER_DAY;
  const intervalRate = chancePerDay * portionOfDay;
  const chance = 1 - exp(-intervalRate);
  return rng.random() < chance;
}
