/**
 * What a thing costs, and how much of it a base's items are worth.
 *
 * `buyable.py`'s two readings, without its class hierarchy: a spec's declared cost is not the
 * cost that is paid — labor is scaled by the difficulty's labor bonus and turned into
 * minutes, and CPU is turned from CPU-days into CPU-seconds — and a base's CPU is the sum of
 * its finished items' qualities through a bonus that multiplies rather than adds.
 */

import { content } from "./content/index.ts";
import type { Modifiers } from "./content/types.ts";
import { MINUTES_PER_DAY, SECONDS_PER_DAY } from "./clock.ts";
import { floorDiv, roundHalfToEven, truncate } from "./pynum.ts";
import {
  CASH,
  CPU,
  LABOR,
  allItems,
  costPaid,
  type BaseState,
  type BuyableState,
  type Cost,
  type ItemState,
} from "./state.ts";

/**
 * `BuyableSpec.cost` (`buyable.py:66`): labor becomes minutes scaled by the labor bonus, CPU
 * becomes CPU-seconds. The labor division is a float divide truncated back into an integer
 * array, which is `int()`, not a round.
 */
export function specCost(declared: Cost, laborBonus: number): Cost {
  return [
    declared[CASH],
    declared[CPU] * SECONDS_PER_DAY,
    truncate((declared[LABOR] * (MINUTES_PER_DAY * laborBonus)) / 10000),
  ];
}

/**
 * `Buyable.__init__` (`buyable.py:117`): the cost of `count` of them, except for labor —
 * buying ten computers does not take ten times as long, so the multiplication is divided
 * back out.
 */
export function newBuyable(cost: Cost, count = 1): BuyableState {
  const totalCost: Cost = [cost[CASH] * count, cost[CPU] * count, cost[LABOR]];
  return { totalCost, costLeft: totalCost, count, done: false };
}

/** `Buyable.finish` (`buyable.py:151`): nothing left to pay. */
export function finished(buyable: BuyableState): BuyableState {
  return { ...buyable, costLeft: [0, 0, 0], done: true };
}

/** What one turn of the construction kernel spent, and what it left behind. */
export interface Work {
  /** Cash, CPU and labor actually taken out of what was offered. */
  readonly spent: Cost;
  /** The buyable with its progress applied. Still unfinished — `complete` says otherwise. */
  readonly buyable: BuyableState;
  /** `(cost_left <= 0).all()`: whoever owns the buyable now finishes it. */
  readonly complete: boolean;
}

/**
 * `Buyable.calculate_work` (`buyable.py:170`) and `Buyable.work_on` (`buyable.py:194`) — the
 * construction kernel every buildable thing runs through, and the one place in the rules
 * where a rounding mode is observable.
 *
 * The shape is upstream's and it is worth reading once. Progress is a *percentage*, not an
 * amount: each of cash, CPU and labor is asked how far the resources on offer would carry
 * it, the **least complete** of the three caps the other two, and the cap is translated back
 * into whole units of each. That is why a base with no labor cost finishes the moment its
 * cash is there, and why a base with one is paid for at the rate its labor allows however
 * much cash is lying around.
 *
 * Three details are load-bearing and none of them is incidental:
 *
 * - **The rounding is half to even** (`numpy.round`), so a cap that lands a component on a
 *   `.5` boundary pays the even unit. It rounds once per Tick and construction accumulates,
 *   so a `Math.round` here is wrong by one unit per boundary crossed and stays wrong. It is
 *   a preserved defect, not a simplification to make.
 * - **A component with no cost is skipped, not divided.** `total_cost[i] == 0` makes the
 *   percentage `inf` (or `NaN` when nothing has been offered either), and upstream leans on
 *   both: the `> cap` comparison is false for `NaN`, so a `NaN` survives to be multiplied by
 *   zero, rounded, and cast to `int64` — which is `INT64_MIN`, and the `maximum` below then
 *   keeps what was already paid. `-Infinity` reproduces that outcome without pretending to
 *   be a 64-bit integer.
 * - **Progress never goes backwards.** The `maximum` against what was already paid is what
 *   makes a tick that can afford nothing cost nothing, rather than un-building.
 */
export function workOn(buyable: BuyableState, available: Cost): Work {
  const total = buyable.totalCost;
  const wasComplete = costPaid(buyable);

  const percentage = wasComplete.map(
    (paid, index) => (paid + (available[index] as number)) / (total[index] as number),
  );

  // `min_valid` (`buyable.py:167`): only the components that cost something have a say.
  const priced = percentage.filter((_, index) => (total[index] as number) > 0);
  if (priced.length === 0) {
    throw new RangeError("a buyable that costs nothing at all has no progress to compute");
  }
  const cap = Math.min(1, Math.min(...priced));

  const paid = percentage.map((share, index) => {
    const raw = (share > cap ? cap : share) * (total[index] as number);
    const rounded = Number.isNaN(raw) ? Number.NEGATIVE_INFINITY : roundHalfToEven(raw);
    return Math.max(rounded, wasComplete[index] as number);
  });

  const costLeft: Cost = [
    (total[CASH] as number) - (paid[CASH] as number),
    (total[CPU] as number) - (paid[CPU] as number),
    (total[LABOR] as number) - (paid[LABOR] as number),
  ];

  return {
    spent: [
      (paid[CASH] as number) - (wasComplete[CASH] as number),
      (paid[CPU] as number) - (wasComplete[CPU] as number),
      (paid[LABOR] as number) - (wasComplete[LABOR] as number),
    ],
    buyable: { ...buyable, costLeft },
    complete: costLeft.every((left) => left <= 0),
  };
}

/** `chance.add` (`chance.py:68`) — the correct way to add two chances in 0–1 form. */
export function addChance(first: number, second: number): number {
  return 1 - (1 - first) * (1 - second);
}

function itemQuality(item: ItemState, quality: string): number {
  const spec = content.items.byId.get(item.specId);
  if (!spec) throw new Error(`no such item: ${item.specId}`);
  const value = spec.qualities.get(quality) ?? 0;
  // `Item.get_quality_for` (`item.py:243`): a modifier is a rate and does not stack with the
  // count; anything else is per unit.
  return quality.endsWith("_modifier") ? value : value * item.buyable.count;
}

/**
 * `Base.get_quality_for` (`base.py:428`). A modifier is combined as a chance rather than
 * summed, which is why two 50% reductions do not make a 100% one.
 *
 * Upstream's `pending_ok` is not here. Its only caller is `Base.pending_compute_bonus`
 * (`base.py:316`), which only `ItemSpec.get_quality_info` (`item.py:165`) reads, to put a
 * "CPU per day (pending)" line in an item's info text. That is a Projection over the estate,
 * so it arrives with the readout that needs it rather than with the rules — every rule that
 * asks a base what it is worth asks about items that are done.
 */
export function baseQuality(base: BaseState, quality: string): number {
  const values: number[] = [];
  for (const item of allItems(base)) {
    if (item.buyable.done) values.push(itemQuality(item, quality));
  }
  if (!quality.endsWith("_modifier")) return values.reduce((sum, value) => sum + value, 0);
  return values.reduce((combined, value) => addChance(combined, value / 10000), 0) * 10000;
}

/** `Base.compute_bonus` (`base.py:304`): the item bonus adds, the location's multiplies. */
export function computeBonus(base: BaseState, modifiers: Modifiers): number {
  const bonus = 10000 + baseQuality(base, "cpu_modifier");
  const cpuModifier = modifiers.get("cpu");
  return cpuModifier === undefined ? bonus : bonus * cpuModifier;
}

/** `Base.recalc_cpu` (`base.py:324`): a base that produces anything produces at least one. */
export function recalcBaseCpu(base: BaseState, modifiers: Modifiers): BaseState {
  const rawCpu = baseQuality(base, "cpu");
  if (rawCpu === 0) return { ...base, rawCpu, cpu: 0 };
  return {
    ...base,
    rawCpu,
    cpu: Math.max(1, truncate(floorDiv(rawCpu * computeBonus(base, modifiers), 10000))),
  };
}
