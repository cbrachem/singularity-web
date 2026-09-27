/**
 * A base: how one comes into being, how it finishes, and what its power state depends on.
 *
 * The power rule is kept in two places upstream — a tuple of the states that are available
 * (`base.py:264`) and a check that drags the current state back into it (`base.py:279`) —
 * and both matter, because a base whose computer is still being built cannot be switched on
 * and a base that has just finished one must be.
 *
 * Placing a base in a Location is `./location.ts`, because upstream files it there and
 * because that is where the modifiers a base's costs are read through come from.
 */

import { finished, newBuyable, recalcBaseCpu, specCost } from "./buyable.ts";
import { content } from "./content/index.ts";
import type { BaseType, Item, Modifiers } from "./content/types.ts";
import { newItem } from "./item.ts";
import {
  ITEM_SLOTS,
  type BaseState,
  type ItemSlot,
  type ItemState,
  type PowerState,
} from "./state.ts";

const ACTIVE_STATES: readonly PowerState[] = ["active", "sleep"];
const OFFLINE_ONLY: readonly PowerState[] = ["offline"];

const EMPTY_SLOTS: Readonly<Record<ItemSlot, ItemState | null>> = Object.freeze(
  Object.fromEntries(ITEM_SLOTS.map((slot) => [slot, null])) as Record<ItemSlot, ItemState | null>,
);

/**
 * What a base's costs are read through before it stands anywhere — `Base.location is None`.
 * Built per call rather than kept as a module constant: `sim/` holds no module-level mutable
 * state, and an empty `Map` is mutable whether or not anything writes to it.
 */
function unplaced(): Modifiers {
  return new Map<string, number>();
}

/** `Base.available_power_states` (`base.py:262`). */
export function availablePowerStates(base: BaseState): readonly PowerState[] {
  const cpus = base.items.cpu;
  return base.buyable.done && cpus && cpus.buyable.done ? ACTIVE_STATES : OFFLINE_ONLY;
}

/**
 * `Base.space_left_for` (`base.py:295`): how many of this spec still fit.
 *
 * Only the CPUs of the *same* spec are deducted, because a CPU of a different spec replaces
 * what is there rather than joining it — so it needs the whole base. Upstream's own caller
 * uses this number unmodified (`screens/base.py:481`), and so does the port.
 */
export function spaceLeftFor(base: BaseState, spec: Item): number {
  const type = content.bases.byId.get(base.specId);
  if (!type) throw new Error(`no such base type: ${base.specId}`);
  const cpus = base.items.cpu;
  return type.size - (cpus && cpus.specId === spec.id ? cpus.buyable.count : 0);
}

/**
 * `Item.finish` (`item.py:239`) for the item in one slot: the buyable is paid off, the base
 * recounts what its items are worth, and the power state it could not hold while its
 * computer was unbuilt is re-checked.
 *
 * The order is upstream's and it is the opposite of the one a *purchase* uses — see
 * `buyItem` in `./command.ts`. The statistic and the player-level recount belong to the
 * caller, which is the only one holding the State root.
 */
export function finishItem(base: BaseState, slot: ItemSlot, modifiers: Modifiers): BaseState {
  const item = base.items[slot];
  if (!item) throw new Error(`${base.name} has nothing in its ${slot} slot`);
  const paid: BaseState = {
    ...base,
    items: { ...base.items, [slot]: { ...item, buyable: finished(item.buyable) } },
  };
  return checkPower(recalcBaseCpu(paid, modifiers));
}

/**
 * `Base.switch_power` (`base.py:269`): step to the next state the base can hold, wrapping.
 *
 * The list is short and the cycle is what the player sees: a finished base with a finished
 * computer alternates between `active` and `sleep`, and every other base has `offline` as its
 * only option and stays there. `offline` is therefore never *switched* to — it is what
 * `checkPower` falls back to — and the third state upstream lists is reachable only that way.
 *
 * Upstream guards the lookup with `except IndexError`, which `list.index` does not raise; the
 * branch is dead because `check_power` has already dragged the state into the list. The port
 * keeps the same answer for the case it cannot reach — an unheld state steps to the first one
 * — rather than reproducing a guard that never fires.
 *
 * The player-level recount `switch_power` ends with (`base.py:279`) is not here: it belongs to
 * the caller, which is the only one that holds the State root.
 */
export function switchPower(base: BaseState): BaseState {
  const possible = availablePowerStates(base);
  const next = possible[(possible.indexOf(base.powerState) + 1) % possible.length] as PowerState;
  return { ...base, powerState: next };
}

/** `Base.has_power` (`base.py:288`) — sleeping is not powered. */
export function hasPower(base: BaseState): boolean {
  return base.powerState === "active";
}

/** `Base.check_power` (`base.py:281`): a state the base can no longer hold falls back. */
export function checkPower(base: BaseState): BaseState {
  const possible = availablePowerStates(base);
  if (possible.includes(base.powerState)) return base;
  return { ...base, powerState: possible[0] as PowerState };
}

/**
 * `Base.finish` (`base.py:508`): the buyable is paid off, the base recounts its CPU, and the
 * power state it could not hold while unbuilt is re-checked — which is what switches a
 * finished base on without anybody asking it to.
 *
 * The player-level recount `check_power` triggers (`base.py:286`) is *not* here: it belongs
 * to the caller, which is the only one that holds the State root.
 */
export function finishBase(base: BaseState, modifiers: Modifiers): BaseState {
  return checkPower(recalcBaseCpu({ ...base, buyable: finished(base.buyable) }, modifiers));
}

/**
 * `Base.__init__` (`base.py:181`), including the forced CPU a base type may come with.
 *
 * Two orderings inside it are observable and both are upstream's. A base created `built`
 * finishes **before** the forced CPU exists, so the `check_power` inside that finish sees no
 * computer and leaves the base offline; the item's own completion then re-checks it
 * (`Item.finish`, `item.py:239`) and that is what turns it on. And neither the base nor the
 * item is credited to the player here — the base's statistic is counted when construction
 * completes, and a forced CPU is never counted at all.
 */
export function newBase(
  spec: BaseType,
  name: string,
  startedAtMin: number,
  laborBonus: number,
  built = false,
): BaseState {
  let base: BaseState = {
    specId: spec.id,
    name,
    startedAtMin,
    powerState: "offline",
    graceOver: false,
    maintenance: spec.maintenance,
    rawCpu: 0,
    cpu: 0,
    items: EMPTY_SLOTS,
    buyable: newBuyable(specCost(spec.cost, laborBonus)),
  };

  if (built) base = finishBase(base, unplaced());

  if (spec.forceCpu !== null) {
    const itemSpec = content.items.byId.get(spec.forceCpu);
    if (!itemSpec) throw new Error(`no such item: ${spec.forceCpu}`);
    base = {
      ...base,
      items: { ...base.items, cpu: newItem(itemSpec, laborBonus, spec.size) },
    };
    // `self.cpus.finish(is_player=False)`: the item is not credited to the player, and its
    // finish is what re-checks the power state a base created `built` could not hold.
    base = finishItem(base, "cpu", unplaced());
  }

  return base;
}
