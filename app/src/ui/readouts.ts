import { MAX_CASH, SECONDS_PER_DAY } from "@singularity/sim";

import type { Speed } from "../host/tick-partition.ts";

/**
 * Numbers and names, as the player reads them.
 *
 * Text is Presentation: the Simulation hands over counts and the Content keeps
 * upstream's own strings, markers and all, because the Converter transcribes rather than
 * reads. Turning either into something on the screen happens here.
 *
 * Both functions are transcriptions of the reference's, because both are player-visible
 * output and fidelity binds to that — including the joke at the top of the cash
 * scale, which is upstream's and is carried rather than tidied away.
 */

const MILLION = 10 ** 6;
const BILLION = 10 ** 9;
const TRILLION = 10 ** 12;
const QUADRILLION = 10 ** 15;

/** Two decimal places, and the grouping upstream's locale gives an English build. */
const GROUPED = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * `g.add_commas` (`code/g.py:95`): the amount to two places, grouped, with the decimals
 * dropped again when they are zeros.
 *
 * The reference strips them character by character against its locale's separators, which is
 * what leaves `1,000.50` as `1,000.5` rather than rounding it — the trailing zero goes and
 * the five stays.
 */
export function addCommas(amount: number): string {
  const grouped = GROUPED.format(amount);
  return grouped.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * `g.to_money` (`code/g.py:177`): grouped below a million, and abbreviated above it to two
 * places with a two-letter unit.
 */
export function toMoney(amount: number): string {
  const size = Math.abs(amount);
  if (size < MILLION) return addCommas(amount);

  const [divisor, unit] =
    size < BILLION
      ? [MILLION, "mi"]
      : size < TRILLION
        ? [BILLION, "bi"]
        : size < QUADRILLION
          ? [TRILLION, "tr"]
          : [QUADRILLION, "qu"];

  // "Congratulations, you broke the bank!" — at the top of the scale the reference replaces
  // every character of the amount with a pi, sign apart.
  if (size >= MAX_CASH - divisor / 100 / 2) {
    const width = `${(1).toFixed(2)}${unit}`.length;
    return (amount < 0 ? "-" : "") + "π".repeat(width);
  }

  return addCommas(round(amount / divisor, 2)) + unit;
}

/**
 * `g.to_cpu` (`code/g.py:170`): a CPU cost is carried in CPU-seconds and read in CPU-days,
 * so the readout divides before it groups.
 */
export function toCpu(amount: number): string {
  return addCommas(amount / SECONDS_PER_DAY);
}

/**
 * `g.to_time` (`code/g.py:229`): a number of minutes, bucketed for display — days past 48
 * hours, hours past one hour, minutes otherwise. Floor division throughout, so 119 minutes is
 * still minutes. The day and hour buckets never hold a 1, so only the minute is pluralised.
 */
export function toTime(rawMinutes: number): string {
  const hours = Math.floor(rawMinutes / 60);
  if (hours > 48) return `${Math.floor(rawMinutes / (24 * 60))} days`;
  if (hours > 1) return `${hours} hours`;
  return `${rawMinutes} ${rawMinutes === 1 ? "minute" : "minutes"}`;
}

/** Python's `round(x, 2)` for the range this reaches: half away from zero is not in it. */
function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/**
 * `g.strip_hotkey` (`code/g.py:417`): a name without the `&` markers upstream writes its
 * hotkeys with.
 *
 * A `&` before a letter or a digit is a marker and goes; `&&` is an escaped ampersand and
 * becomes one; anything else — `Romeo & Juliet`, a trailing `&` — is left exactly as it is.
 */
export function plainLabel(name: string): string {
  let text = name;
  let at = text.indexOf("&");
  while (at >= 0) {
    const next = text.slice(at + 1, at + 2);
    if (next === "&" || /[\p{L}\p{N}]/u.test(next)) text = text.slice(0, at) + text.slice(at + 1);
    at = text.indexOf("&", at + 1);
  }
  return text;
}

/**
 * The Speed setting as a readout: the pause by name, and every other setting by the rate it
 * is a target for.
 *
 * The five values are upstream's (`screens/map.py:342`) and the Speed belongs to the Host,
 * so this says what the Host is set to and asks the Simulation nothing.
 */
export function speedLabel(speed: Speed): string {
  return speed === 0 ? "Paused" : `${toMoney(speed)}x`;
}
