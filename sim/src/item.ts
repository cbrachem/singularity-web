/**
 * Items: what a base's numbers are made of, and what buying one into a slot does to it.
 *
 * An Item is a Buyable like a base, so it runs through the same construction kernel
 * (`./buyable.ts`) and inherits its half-to-even rounding. Two things separate the two:
 * a base's costs are read through its location's modifiers and an item's are not
 * (`Location.modify_base` touches the base and nothing inside it, `location.py:196`), and
 * an item is only ever worked on once the base holding it is finished (`./advance.ts`).
 */

import { newBuyable, specCost, workOn } from "./buyable.ts";
import type { Item } from "./content/types.ts";
import {
  CASH,
  CPU,
  ITEM_SLOTS,
  LABOR,
  costPaid,
  type BuyableState,
  type Cost,
  type ItemSlot,
  type ItemState,
} from "./state.ts";

/** `Item.__init__` (`item.py:196`) through `Buyable.__init__` (`buyable.py:117`). */
export function newItem(spec: Item, laborBonus: number, count = 1): ItemState {
  return { specId: spec.id, buyable: newBuyable(specCost(spec.cost, laborBonus), count) };
}

/** The slot a spec's item type names. Content has exactly the four (`itemtypes.dat`). */
export function slotOf(spec: Item): ItemSlot {
  const slot = ITEM_SLOTS.find((candidate) => candidate === spec.itemType);
  if (!slot) throw new Error(`item ${spec.id} has no slot: ${spec.itemType}`);
  return slot;
}

/** What stacking produced: the merged item, and whether it came out finished. */
export interface Stacked {
  readonly item: ItemState;
  /** `work_on`'s return (`buyable.py:194`). No shipped item can reach it — see below. */
  readonly complete: boolean;
}

/**
 * `Item.__iadd__` (`item.py:250`): buying more of the CPU a base already holds grows the
 * stack rather than replacing it. Cash and CPU are pooled; labor is not.
 *
 * The order of upstream's own statements is load-bearing and produces something that reads
 * like a defect and is faithfully kept. `total_cost` is grown **before** `cost_paid` is read
 * back for the labor line, so what that line compares is the *new* total minus the old
 * `cost_left` — always at least the labor the fresh half has to pay, so the `min` against
 * the fresh half's zero is zero. Adding to a stack therefore restarts its labor from
 * nothing, however nearly finished it was, which is the "I will need to take the existing
 * processors offline" the buy dialog warns about (`screens/base.py:518`).
 *
 * Upstream ends with `work_on(0, 0, 0)`, which is kept because its *return* is: nothing is
 * on offer, so the kernel's "progress never goes backwards" leaves every component where it
 * was and spends nothing. It could only report completion if the fresh half cost nothing at
 * all, and a buyable that costs nothing at all has no progress to compute.
 */
export function stackItems(existing: ItemState, bought: ItemState): Stacked {
  const wasPaid = costPaid(existing.buyable);
  const boughtPaid = costPaid(bought.buyable);
  const grownTotal = existing.buyable.totalCost.map(
    (was, index) => was + (bought.buyable.totalCost[index] as number),
  );

  // `self.cost_paid[labor]` read after `total_cost` grew, which is upstream's order.
  const laborPaid = Math.min(
    (grownTotal[LABOR] as number) - existing.buyable.costLeft[LABOR],
    boughtPaid[LABOR],
  );

  const totalCost: Cost = [
    grownTotal[CASH] as number,
    grownTotal[CPU] as number,
    bought.buyable.totalCost[LABOR],
  ];
  const paid: Cost = [wasPaid[CASH] + boughtPaid[CASH], wasPaid[CPU] + boughtPaid[CPU], laborPaid];

  const merged: BuyableState = {
    totalCost,
    costLeft: [
      totalCost[CASH] - paid[CASH],
      totalCost[CPU] - paid[CPU],
      totalCost[LABOR] - paid[LABOR],
    ],
    count: existing.buyable.count + bought.buyable.count,
    done: false,
  };

  const work = workOn(merged, [0, 0, 0]);
  return { item: { specId: existing.specId, buyable: work.buyable }, complete: work.complete };
}
