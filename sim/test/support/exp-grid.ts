// boundary-intent simulation: computes the port exp over the whole compared grid
/**
 * The domain `exp` is checked over, and a command-line way to get a second engine's answer.
 *
 * The Simulation reaches exactly one transcendental: `np.exp(-interval_rate)` in
 * `roll_interval` (`singularity/singularity/code/chance.py:42`). Both factors of
 * `interval_rate` are in [0, 1] — a chance per day is carried in 0–10000 form, and
 * `portion_of_day` cannot exceed one because a Tick never crosses midnight — so the
 * argument's real domain is [-1, 0].
 *
 * The grid is `x_i = -(i / STEPS)`: one exact division rather than a `linspace`, so the
 * Python side reproduces the same doubles without inheriting numpy's stepping.
 *
 * Run directly, it prints what this engine computes, which is how the cross-runtime check
 * gets the same numbers out of a second one:
 *
 *     bun sim/test/support/exp-grid.ts digest
 *     node sim/test/support/exp-grid.ts bits
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exp } from "../../src/libm/exp.ts";
import { digest, doubleToBits, formatBits } from "./bits.ts";

/** `interval_rate` resolution: 20,000 steps across [0, 1], so 20,001 points. */
export const STEPS = 20000;
export const POINTS = STEPS + 1;

export function expArgument(index: number): number {
  return -(index / STEPS);
}

/** The port's `exp` over the whole grid, as IEEE-754 bit patterns. */
export function portExpBits(): bigint[] {
  const values: bigint[] = [];
  for (let index = 0; index < POINTS; index += 1)
    values.push(doubleToBits(exp(expArgument(index))));
  return values;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  const values = portExpBits();
  const output = process.argv[2] === "bits" ? values.map(formatBits).join("\n") : digest(values);
  process.stdout.write(`${output}\n`);
}
