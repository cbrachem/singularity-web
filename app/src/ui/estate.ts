import {
  CASH,
  CPU,
  ITEM_SLOTS,
  LABOR,
  allBases,
  consideredBases,
  consideredItems,
  content,
  discoverBonus,
  finishedTechs,
  isAvailable,
  locationModifiers,
  modifyCost,
  modifyMaintenance,
  resourceFlow,
  slotOf,
  spaceLeftFor,
  specCost,
  type BaseState,
  type PowerState,
  type BaseType,
  type BuyableState,
  type Command,
  type Cost,
  type Item,
  type ResourceFlow,
  type SimulationState,
} from "@singularity/sim";

import { addCommas, toTime } from "./readouts.ts";

/**
 * The estate, as Presentation reasons about it: what may be built where, what an order of
 * *n* of them will draw, and whether a selection may be destroyed.
 *
 * Everything here is a pure function over the State root, and none of it is a Command the
 * Simulation had to grow. A bulk action decomposes into the commands that already exist —
 * *n* × build, *n* × destroy, issued in order — and command order is exactly what the Trace
 * binds, so a bulk action carries no fidelity risk.
 *
 * Three of the rules the affordance rests on live upstream in a *screen*, which is why they
 * are here rather than in `sim/`:
 *
 * - **Availability is Presentation's rule**. `Location.add_base` checks neither
 *   the prerequisites nor the regions; upstream's build dialog does (`screens/location.py:420`).
 * - **The last-active-base guard is Presentation's** (`screens/location.py:312`). Upstream
 *   asks it of one highlighted base; over a selection it becomes one evaluation, below.
 * - **Text is Presentation**, including the refusal.
 */

/**
 * `Base.maintains_singularity` (`base.py:230`): a finished base with at least one finished
 * computer in it. Anything else — a base still under construction, a base whose CPU is not
 * paid off — keeps nothing alive.
 */
export function maintainsSingularity(base: BaseState): boolean {
  const cpus = base.items.cpu;
  return base.buyable.done && cpus !== null && cpus.buyable.count >= 1 && cpus.buyable.done;
}

/**
 * `Buyable.percent_complete` (`buyable.py:167-175`): how far the buyable is paid off — the
 * least-complete of its components, and only the components that cost anything have a say.
 */
export function percentComplete(buyable: BuyableState): number {
  const shares: number[] = [];
  buyable.totalCost.forEach((total, part) => {
    if (total > 0) shares.push((total - (buyable.costLeft[part] as number)) / total);
  });
  return Math.min(...shares);
}

/**
 * One line of the status column while something builds. The words, the percent truncated to
 * an integer and space-padded to two characters, and the remaining time are upstream's format
 * string exactly (`screens/location.py:240`, `"%s: % 2s%%. %s"`) — player-visible text, so
 * fidelity binds to it. The time is the labor left, a minimum that assumes cash
 * and CPU keep up.
 */
function buildingStatus(label: string, buyable: BuyableState): string {
  const percent = String(Math.trunc(percentComplete(buyable) * 100)).padStart(2);
  return `${label}: ${percent}%. Completion in ${toTime(buyable.costLeft[LABOR])}.`;
}

/**
 * The status cell of the location's base list, in upstream's vocabulary and its order of
 * questions (`screens/location.py:240-266`): building, then the force_cpu blank, Empty,
 * Incomplete, Building CPU, Building Item, Complete.
 */
export function baseStatus(base: BaseState): string {
  if (!base.buyable.done) return buildingStatus("Building Base", base.buyable);
  if (content.bases.byId.get(base.specId)?.forceCpu != null) return "";
  if (ITEM_SLOTS.every((slot) => base.items[slot] === null)) return "Empty";
  const cpus = base.items.cpu;
  if (cpus === null) return "Incomplete";
  if (!cpus.buyable.done) return buildingStatus("Building CPU", cpus.buyable);
  const buildingExtra = ITEM_SLOTS.some((slot) => {
    const item = base.items[slot];
    return slot !== "cpu" && item !== null && !item.buyable.done;
  });
  return buildingExtra ? "Building Item" : "Complete";
}

/** `Base.power_state_name` (`code/base.py:243`): the word upstream prints for a power state. */
export function powerStateName(state: PowerState): string {
  return { offline: "Offline", active: "Active", sleep: "Sleep" }[state];
}

/**
 * The status cell's compact form: while something builds, `50% · 5 hours` in the
 * cell and upstream's full sentence in its `title` — a conscious deviation from the verbatim
 * rule. The finished-state words pass through untouched, with no
 * title. Derived from `baseStatus`'s pinned string, so the two cannot drift apart.
 */
export function compactBaseStatus(base: BaseState): {
  readonly text: string;
  readonly title: string | null;
} {
  const full = baseStatus(base);
  const building = /^Building (?:Base|CPU): +(\d+)%\. Completion in (.+)\.$/.exec(full);
  return building
    ? { text: `${building[1]}% · ${building[2]}`, title: full }
    : { text: full, title: null };
}

/**
 * `show_cpu` (`screens/location.py:240-269`): the CPU cell is filled only when there is a
 * finished computer to count — a finished force_cpu base, or a finished computer in a
 * finished base. An unfinished or computer-less base shows nothing rather than a zero.
 */
export function showsCpu(base: BaseState): boolean {
  if (!base.buyable.done) return false;
  if (content.bases.byId.get(base.specId)?.forceCpu != null) return true;
  const cpus = base.items.cpu;
  return cpus !== null && cpus.buyable.done;
}

/**
 * Upstream's refusal, verbatim (`screens/location.py:148`). Carried rather than rewritten:
 * it is player-visible output, and fidelity binds to that.
 */
export const LAST_ACTIVE_BASE_REFUSAL =
  "Destroying my last active base would be suicidal. I cannot do that.";

/**
 * Why this whole selection may not be destroyed, or `null` when it may.
 *
 * One evaluation over the selection, not one per base: upstream refuses when the single
 * active base in the game is the highlighted one, and the generalisation that keeps that
 * answer for a selection of one is "every active base in the game is in the selection". A
 * game with no active base at all is not refused, which is upstream's answer too — its test
 * is `len(all_active) == 1`, and zero is not one.
 */
export function destroyRefusal(
  state: SimulationState,
  selection: readonly BaseState[],
): string | null {
  const active = [...allBases(state)].filter(maintainsSingularity);
  const selected = new Set(selection);
  const doomed = active.length > 0 && active.every((base) => selected.has(base));
  return doomed ? LAST_ACTIVE_BASE_REFUSAL : null;
}

/**
 * The base types the player may order here: `NewBaseDialog.show`
 * (`screens/location.py:420`) — available, buildable in this location, most expensive first.
 *
 * The order is upstream's `sorted(g.base_type.values(), reverse=True)` through
 * `BuyableSpec.__lt__` (`buyable.py:112`), which compares the cost triple as a tuple.
 */
export function buildableBaseTypes(
  state: SimulationState,
  locationId: string,
): readonly BaseType[] {
  const finished = finishedTechs(state.techs);
  return content.bases.all
    .filter(
      (spec) =>
        isAvailable(spec.prerequisites, finished) &&
        (spec.buildableIn.anywhere || spec.buildableIn.locations.includes(locationId)),
    )
    .sort((left, right) => compareCost(right.cost, left.cost));
}

function compareCost(left: Cost, right: Cost): number {
  for (const part of [CASH, CPU, LABOR]) {
    const difference = (left[part] ?? 0) - (right[part] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * What an order of `quantity` bases of this type will draw — the hypothetical that upstream
 * leaves on `Player` as `considered_buyables` and reads back out of it
 * (`player.py:841`). The port turned that write into an argument: the projection is computed
 * from what the player is considering, and nothing is written anywhere.
 *
 * It is the *whole* of what the order costs, because building costs nothing at the moment of
 * the click: a base is paid off over the ticks that follow, out of the cash and CPU pools.
 * So the affordance projects rather than confirms — the decision is to dilute construction
 * throughput, not to spend.
 *
 * The arithmetic is `newBase` followed by `addBase`, which is why the numbers are the ones
 * the commands actually produce: the spec's declared cost through the difficulty's labor
 * bonus, then through the location's modifiers, then multiplied by the quantity.
 */
export interface BuildProjection {
  readonly quantity: number;
  /** Cash the order will draw over the ticks that build it. */
  readonly constructionCash: number;
  /** CPU-seconds the order will draw over the same ticks. */
  readonly constructionCpu: number;
  /** What the finished order adds to the daily maintenance drain. */
  readonly maintenanceCash: number;
  readonly maintenanceCpu: number;
  /**
   * Minutes of labor one base of the order takes — the part of upstream's
   * `Build cost: … CPU, … money, … days` line (`describe_cost`, `buyable.py:72`) the cash
   * and CPU projections do not carry. Per base, not per order: bases in a queue are paid
   * off one after another, and the dialog upstream shows describes one.
   */
  readonly constructionTime: number;
}

export function buildProjection(
  state: SimulationState,
  locationId: string,
  spec: BaseType,
  quantity: number,
): BuildProjection {
  const modifiers = locationModifiers(state.regions, locationId);
  const cost = modifyCost(specCost(spec.cost, state.laborBonus), modifiers);
  const maintenance = modifyMaintenance(spec.maintenance, modifiers);
  return {
    quantity,
    constructionCash: (cost[CASH] ?? 0) * quantity,
    constructionCpu: (cost[CPU] ?? 0) * quantity,
    maintenanceCash: (maintenance[CASH] ?? 0) * quantity,
    maintenanceCpu: (maintenance[CPU] ?? 0) * quantity,
    constructionTime: cost[LABOR] ?? 0,
  };
}

/**
 * `BaseSpec.get_detect_info` (`base.py:125`): the chances the New Base dialog shows for a
 * base that does not exist yet — `calc_discovery_chance` with the location's stealth as its
 * `extra_factor`. The passes and their truncations are upstream's, in upstream's order:
 * suspicion, then the group's discover bonus, each a floor division on the 10000-point
 * scale, then the stealth factor under `int()`. Groups the type does not name show zero,
 * and the result holds every group in player order, which is how `get_detect_info`
 * (`base.py:547`) prints them.
 *
 * Deliberately not `sim/`'s `detectChance`: that one asks about a standing base — its
 * quality, its power, the location's recent discoveries — and none of that exists for a
 * type the player is only considering.
 */
export function specDetectChance(
  state: SimulationState,
  locationId: string,
  spec: BaseType,
): ReadonlyMap<string, number> {
  const stealth = locationModifiers(state.regions, locationId).get("stealth") ?? 1;
  const chances = new Map<string, number>();
  for (const group of state.groups) {
    const declared = spec.detectChance.get(group.specId);
    if (declared === undefined) {
      chances.set(group.specId, 0);
      continue;
    }
    let chance = Math.floor((declared * (10000 + group.suspicion)) / 10000);
    chance = Math.floor((chance * discoverBonus(group)) / 10000);
    chances.set(group.specId, Math.trunc(chance / stealth));
  }
  return chances;
}

/**
 * Where the next day goes **with this order in the construction queue**, which is a different
 * question from what the order costs.
 *
 * `buildProjection` above answers "what will this draw"; this answers "what will the day look
 * like if I place it". Both are wanted at once — the first is the price tag, the second is
 * whether the estate can carry it — and only the second one accounts for the cash the day
 * earns, the maintenance it owes and the bases already being paid off ahead of this order.
 *
 * The hypothetical is an argument and nothing is written anywhere. That is the whole of
 * the port's ruling on `considered_buyables`: upstream's dialog writes its fake bases onto
 * the player and `compute_future_resource_flow` reads the field back out, so *looking* at a
 * base type is a mutation there and is not one here.
 */
export function orderFlow(
  state: SimulationState,
  locationId: string,
  spec: BaseType,
  quantity: number,
): ResourceFlow {
  return resourceFlow(state, consideredBases(state, locationId, spec, quantity));
}

/** The order as commands: *n* × build, in order, and no name — the Simulation names them. */
export function buildOrder(
  locationId: string,
  spec: BaseType,
  quantity: number,
): readonly Command[] {
  return Array.from({ length: quantity }, () => ({
    command: "buildBase" as const,
    location: locationId,
    baseType: spec.id,
  }));
}

/**
 * The items the player may install in a base standing here: `BuildDialog.show`
 * (`screens/base.py:60`) — available, buildable in this location, most expensive first.
 *
 * The same rule as `buildableBaseTypes` and here for the same reason: availability is
 * Presentation's. `buyItem` refuses an item that does not exist and nothing else,
 * so a Scenario may install whatever it names and the surface may not.
 *
 * Upstream opens one dialog per slot and fills it with the items of that type. The port asks
 * once and keeps every slot's items in one list, because the slot is the item's own
 * (`slotOf`) rather than a second choice the player has to make — picking a reactor *is*
 * picking the reactor slot.
 */
export function buyableItems(state: SimulationState, locationId: string): readonly Item[] {
  const finished = finishedTechs(state.techs);
  return content.items.all
    .filter(
      (spec) =>
        isAvailable(spec.prerequisites, finished) &&
        (spec.buildableIn.anywhere || spec.buildableIn.locations.includes(locationId)),
    )
    .sort((left, right) => compareCost(right.cost, left.cost));
}

/**
 * How many of this item the base can still be given — `Base.space_left_for` for the CPU slot
 * (`base.py:295`), and one for the three that hold exactly one.
 *
 * A CPU of a *different* spec replaces what is there rather than joining it, so it needs the
 * whole base and the room it asks for is the base's own size again.
 */
export function roomFor(base: BaseState, spec: Item): number {
  return slotOf(spec) === "cpu" ? spaceLeftFor(base, spec) : 1;
}

/**
 * Upstream's refusal, verbatim (`screens/base.py:498`). Carried rather than rewritten, for
 * the same reason `LAST_ACTIVE_BASE_REFUSAL` is: it is player-visible output.
 */
export function noRoomRefusal(itemName: string): string {
  return `The base cannot support any additional number of ${itemName}.`;
}

/**
 * What an order of `count` of this item will draw, and where the next day goes with it in
 * the construction queue — the item dialogs' half of `considered_buyables`
 * (`screens/base.py:103`), which is the same hypothetical the build dial projects
 * and is an argument rather than a write.
 *
 * Both halves are read off the *one* buyable `consideredItems` builds, so the price tag and
 * the flow are the same arithmetic the Command will perform: an item is one buyable carrying
 * the count, and the location's modifiers do not reach inside a base.
 */
export interface ItemProjection {
  /** Cash the order will draw over the ticks that install it. */
  readonly constructionCash: number;
  /** CPU-seconds the order will draw over the same ticks. */
  readonly constructionCpu: number;
  /** The next day with the order in the queue, beside the day the HUD is showing. */
  readonly flow: ResourceFlow;
  /**
   * Minutes of labor the order takes — the part of upstream's cost line
   * (`describe_cost`, `buyable.py:72`) the cash and CPU projections do not carry. The
   * count does not stretch it: `newBuyable` divides the multiplication back out.
   */
  readonly constructionTime: number;
}

export function itemProjection(state: SimulationState, spec: Item, count: number): ItemProjection {
  const considered = consideredItems(state, spec, count);
  const cost: Cost = considered[0]?.totalCost ?? [0, 0, 0];
  return {
    constructionCash: cost[CASH],
    constructionCpu: cost[CPU],
    flow: resourceFlow(state, considered),
    constructionTime: cost[LABOR],
  };
}

/**
 * `g.to_percent` (`code/g.py:114`) with `show_full` left off, which is what
 * `get_quality_info` passes: whole percents drop their decimals, anything finer keeps
 * both places. `threat.ts` carries the `show_full` variant the map screen uses.
 */
function toPercent(rawPercent: number): string {
  if (rawPercent % 100 === 0) return `${rawPercent / 100}%`;
  return `${(rawPercent / 100).toFixed(2)}%`;
}

/**
 * What an item's qualities say about it before it is ordered, in upstream's words:
 * the CPU line of `ItemSpec.get_info` (`item.py:135-139`) and the bonus lines
 * of `get_quality_info` (`item.py:186-190`). The per-day CPU arithmetic with the base's
 * bonuses stays upstream's CPU dialog's and is not carried here.
 */
export function itemQualityLines(spec: Item): readonly string[] {
  const lines: string[] = [];
  for (const [quality, value] of spec.qualities) {
    if (quality === "cpu") lines.push(`Generates ${addCommas(value)} CPU (base).`);
    else if (quality === "cpu_modifier") lines.push(`CPU bonus: ${toPercent(value)}`);
    else if (quality === "discover_modifier")
      lines.push(`Detection chance reduction: ${toPercent(value)}`);
  }
  return lines;
}

/**
 * The order as a command. **The count is the CPU slot's alone**: the other three take exactly
 * one, and a Command carrying a count for them is refused rather than read as one
 * (`sim/src/command.ts`, `BuyItem`). So the field is left off entirely
 * rather than sent as `1`.
 */
export function buyItemOrder(locationId: string, base: number, spec: Item, count: number): Command {
  return {
    command: "buyItem",
    location: locationId,
    base,
    itemType: spec.id,
    ...(slotOf(spec) === "cpu" && { count }),
  };
}

/**
 * Which base a selection entry means, independently of where that base currently sits.
 *
 * An index is not an identity. The world removes bases behind the player's back — a
 * maintenance failure and a discovery both do, and the shell draws a notification for each
 * (`App.tsx`) — and every removal shifts the indices behind it. A selection remembered as
 * indices therefore starts naming other bases the moment one disappears, which is how a
 * player ends up destroying a base they never ticked.
 *
 * So the selection is remembered as identities and the index is derived from the list the
 * player is looking at, at the moment the commands are issued. The three parts are the ones
 * a base carries for its whole life: the minute it was started, its type, and its name. They
 * are joined as JSON because a base name is player text and may hold whatever a separator
 * would have been.
 *
 * **Those three do not separate on their own, because the player names bases too.** The
 * Simulation draws a name against the names its location already holds (`command.ts`,
 * `buildBase`), so its own names separate even twenty bases ordered in one click; a rename
 * (`renameBase`) is not drawn against anything, and two bases of one bulk order already share
 * their start minute and their type. Naming one after its twin would give both the same
 * identity — one tick would tick both rows, and the confirm would destroy a base the player
 * never chose, which is the one thing in this shell that cannot be taken back. So the keys
 * are made for a list rather than for a base, and a repeat of an identity carries how many
 * stood before it. Two bases the player named alike are then two entries, and the ordinal
 * moves only when one of that pair is removed — at which point the survivor is the pair, and
 * the honest report is an unticked row.
 *
 * A rename changes the identity, and the base drops out of the selection — its row shows
 * unticked, which is the honest report: a selection is only ever what the checkboxes say.
 */
export function baseKeys(bases: readonly BaseState[]): readonly string[] {
  const seen = new Map<string, number>();
  return bases.map((base) => {
    const identity = JSON.stringify([base.startedAtMin, base.specId, base.name]);
    const nth = seen.get(identity) ?? 0;
    seen.set(identity, nth + 1);
    return `${identity}#${nth}`;
  });
}

/** The selected bases, in list order — the entries that still name a base standing here. */
export function selectedBases(
  bases: readonly BaseState[],
  selected: ReadonlySet<string>,
): readonly BaseState[] {
  const keys = baseKeys(bases);
  return bases.filter((_, index) => selected.has(keys[index] as string));
}

/**
 * The selection as commands: one destroy per selected base, **highest index first**.
 *
 * A destroy command addresses a base by its index in the location's list, which is how
 * upstream's own screen addresses one, and every destroy shifts the indices behind it. So
 * ascending order would address the wrong base with the second command. Descending order is
 * the one order in which every index in the sequence still names the base the player picked.
 *
 * The indices are read out of `bases` here rather than carried from the selection, so they
 * are the indices of the root the sequence is about to be applied to. An identity that no
 * longer stands here contributes no command at all: the sequence is whole or it is empty,
 * and it never addresses a base the player did not tick.
 */
export function destroyOrder(
  locationId: string,
  bases: readonly BaseState[],
  selected: ReadonlySet<string>,
): readonly Command[] {
  const keys = baseKeys(bases);
  const order: Command[] = [];
  for (let index = bases.length - 1; index >= 0; index -= 1) {
    if (selected.has(keys[index] as string)) {
      order.push({ command: "destroyBase", location: locationId, base: index });
    }
  }
  return order;
}

/**
 * The bulk path's keyboard. Note what is *not* here: `0`–`4` belong to the speed control
 * (`SpeedControl.tsx`) and cannot be spent on quantity. `app/test/estate-surface.test.tsx`
 * holds the two sets apart.
 *
 * Every one of these has a control beside it, so nothing on this surface requires a keyboard.
 */
export const ESTATE_HOTKEYS = {
  build: "b",
  more: "+",
  fewer: "-",
  selectAll: "a",
  destroy: "d",
  clear: "Escape",
} as const;

/** The largest order the dial will take. A dial without a stop is a typo waiting to land. */
export const MAX_ORDER = 99;
