/**
 * Commands: the input half of the seam.
 *
 * A **Command** is a single player action applied to the Simulation, and it is *data* — so
 * the same sequence runs against the port and against the Reference.
 * Six of them cover every mutation a player can make, and all six are here. The vocabulary is
 * complete in the sense the spec asks for — not that it covers six mutations, but that the
 * game can be *played* with it: a win and both losses are reachable through these six.
 *
 * # Applying one returns no Effects
 *
 * `advance` returns Effects because the tick has things to tell the Host. A Command has
 * none, and that is a property of the Reference rather than of this slice: every place
 * upstream reaches `g.map_screen` from a Command is a render invalidation, which a reactive
 * Presentation has no counterpart for and the Trace recorder filters out. So this
 * returns a State root and nothing beside it.
 *
 * # What it does not check
 *
 * A Command is not validated against the rules a *screen* enforces. Upstream's build dialog
 * lists only the base types whose prerequisites are met and whose regions allow them, but
 * `Location.add_base` checks neither, and the Reference's own recorder therefore builds
 * whatever a Scenario names. Availability is Presentation's rule, and a Scenario
 * is allowed to reach past it — what is refused here is only what cannot be *addressed*:
 * a location, a base type, an item or a base index that does not exist, and the one case
 * where a slot is not there to address either (`buyItem`, below).
 *
 * `allocateCpu` is the one exception, and it does not widen that rule. `Player`'s own setter
 * asserts that a tech is available (`player.py:246`), so the Reference stops rather than
 * recording a step, and a Scenario reaching past it would have nothing to be compared
 * against. It also clamps an allocation to the CPU that exists — a deliberate Deviation
 * (deviation 5). See the function for the whole of it.
 */

import { addBase, locationModifiers, locationOf, removeBase } from "./location.ts";
import { generateBaseName } from "./basename.ts";
import { content } from "./content/index.ts";
import { checkPower, newBase, spaceLeftFor, switchPower } from "./base.ts";
import { finishedTechs, isAvailable } from "./availability.ts";
import { recalcBaseCpu } from "./buyable.ts";
import { newItem, slotOf, stackItems } from "./item.ts";
import { rawMinutes } from "./clock.ts";
import { allocatedCpuFor, cpuLeft, recalcCpu, setAllocatedCpuFor } from "./cpu.ts";
import { CPU_POOL, JOBS, dangerFor } from "./task.ts";
import type { BaseState, SimulationState } from "./state.ts";

export interface BuildBase {
  readonly command: "buildBase";
  readonly location: string;
  readonly baseType: string;
  /** Absent means the Simulation names it, which draws from the simulation RNG. */
  readonly name?: string;
}

export interface DestroyBase {
  readonly command: "destroyBase";
  readonly location: string;
  /** An index into the location's base list — how upstream's own screen addresses one. */
  readonly base: number;
}

export interface BuyItem {
  readonly command: "buyItem";
  readonly location: string;
  readonly base: number;
  readonly itemType: string;
  /**
   * The CPU slot's alone. Every other slot takes exactly one, so carrying a count for one is
   * refused rather than read as one — see `buyItem` below.
   */
  readonly count?: number;
}

export interface AllocateCpu {
  readonly command: "allocateCpu";
  readonly task: string;
  readonly cpu: number;
}

export interface SwitchPower {
  readonly command: "switchPower";
  readonly location: string;
  readonly base: number;
}

export interface RenameBase {
  readonly command: "renameBase";
  readonly location: string;
  readonly base: number;
  readonly name: string;
}

export type Command = BuildBase | DestroyBase | BuyItem | AllocateCpu | SwitchPower | RenameBase;

/** A Command naming something the game has not got. Not a rule refusal — an address fault. */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

/**
 * Apply one Command and hand back a new State root.
 *
 * The generator is copied here for the same reason `advance` copies it: naming a base draws,
 * and the root the previous step handed out must not move underneath whoever is still
 * holding it.
 */
export function applyCommand(state: SimulationState, command: Command): SimulationState {
  const next: SimulationState = { ...state, rng: state.rng.clone() };

  switch (command.command) {
    case "buildBase":
      return buildBase(next, command);
    case "destroyBase":
      return destroyBase(next, command);
    case "renameBase":
      return renameBase(next, command);
    case "buyItem":
      return buyItem(next, command);
    case "allocateCpu":
      return allocateCpu(next, command);
    case "switchPower":
      return switchBasePower(next, command);
  }
}

/**
 * `NewBaseDialog.finish` reduced to what the Simulation does (`screens/location.py:437`,
 * `location.py:184`): name it if the Command did not, build it, place it.
 *
 * Nothing is paid here. A base costs nothing at the moment of the Command and is paid off
 * over the ticks that follow, out of the cash and CPU pools — which is why building is
 * always possible and affording it is not.
 */
function buildBase(state: SimulationState, command: BuildBase): SimulationState {
  const standing = locationOf(state, command.location);
  const place = content.locations.byId.get(command.location);
  if (!standing || !place) throw new CommandError(`no such location: ${command.location}`);
  const spec = content.bases.byId.get(command.baseType);
  if (!spec) throw new CommandError(`no such base type: ${command.baseType}`);

  // The name is drawn against the names the location already holds, before the base exists —
  // upstream's own order, and the reason the uniqueness loop can draw more than once.
  const name =
    command.name ??
    generateBaseName(state.rng, place, spec, new Set(standing.bases.map((base) => base.name)));

  const built = newBase(spec, name, rawMinutes(state.gameTime), state.laborBonus);
  const placed = addBase(state, command.location, built);

  // `Item.finish` → `Base.check_power` → `Player.recalc_cpu` (`item.py:243`, `base.py:286`):
  // a base type with a forced CPU asks the player to recount while the base is still
  // unplaced. Nothing it counts has moved, so the answer is the one already held — the call
  // is kept because its position is upstream's, not because it can change anything.
  return spec.forceCpu === null ? placed : recalcCpu(placed);
}

/**
 * `BaseScreen.set_current` reduced to what the Simulation does (`screens/base.py:475`).
 *
 * Nothing is paid here either: the item joins the base unbuilt and is worked on over the
 * ticks that follow, once its base is finished (`./advance.ts`).
 *
 * The two slots behave differently and both are upstream's:
 *
 * - **The CPU slot stacks.** More of the spec the base already holds grows the stack
 *   (`./item.ts`); a different spec replaces what is there. Either way the base's size caps
 *   it, and that cap is the one screen rule the port does enforce — a base has no room the
 *   Command could be addressing, so it is an address fault like a base index that is not
 *   there rather than a rule refusal (see this file's header).
 * - **An extra slot takes exactly one.** Buying a *different* spec throws the old item away,
 *   finished or not, and starts from nothing; buying the same one again does nothing at all,
 *   not even to a half-built item. Upstream's own caller only ever passes one for an extra
 *   (`screens/base.py:583`), so a `count` is refused here rather than read as one: a Command
 *   carrying it is addressing a quantity the slot has not got, which is the same kind of
 *   fault as a base index that is not there. Ignoring it would leave a Scenario saying three
 *   and a Trace agreeing with a Scenario that said one.
 *
 * The order of the two recounts at the end is upstream's and is observable. `check_power`
 * ends in `Player.recalc_cpu` (`base.py:286`) and the base's own `recalc_cpu` runs *after*
 * it (`screens/base.py:570`), so the player totals what the base was worth a moment before
 * the item arrived. A tidier order would be a different game.
 */
function buyItem(state: SimulationState, command: BuyItem): SimulationState {
  const standing = baseAt(state, command.location, command.base);
  const spec = content.items.byId.get(command.itemType);
  if (!spec) throw new CommandError(`no such item: ${command.itemType}`);

  const slot = slotOf(spec);
  if (slot !== "cpu" && command.count !== undefined) {
    throw new CommandError(
      `count is only for the cpu slot: ${spec.id} fills the ${slot} slot of ${standing.name}`,
    );
  }

  const held = standing.items[slot];
  let base = standing;
  let changed = true;

  if (slot === "cpu") {
    const count = command.count ?? 1;
    const spaceLeft = spaceLeftFor(standing, spec);
    if (count <= 0 || count > spaceLeft) {
      throw new CommandError(
        `${count} ${spec.id} does not fit in ${standing.name}: ${spaceLeft} slot(s) left`,
      );
    }
    const bought = newItem(spec, state.laborBonus, count);
    if (held === null || held.specId !== spec.id) {
      base = { ...standing, items: { ...standing.items, cpu: bought } };
    } else {
      const stacked = stackItems(held, bought);
      if (stacked.complete) {
        // Only a fresh half that costs nothing could do it, and every item costs cash.
        throw new Error(`stacking ${spec.id} finished it, which no item in Content can`);
      }
      // `Item.__iadd__` ends by telling the base it has no CPU for now (`item.py:271`). The
      // port leaves that to the recount at the end of this function: nothing in between reads
      // `rawCpu`, and a stack that has just grown is not done, so `recalcBaseCpu` writes the
      // same 0. Writing it here as well was proven dead — a nonsense value in its place left
      // `check:fidelity` green.
      base = { ...standing, items: { ...standing.items, cpu: stacked.item } };
    }
  } else if (held === null || held.specId !== spec.id) {
    base = { ...standing, items: { ...standing.items, [slot]: newItem(spec, state.laborBonus) } };
  } else {
    changed = false;
  }

  if (changed) base = checkPower(base);

  let next = replaceBaseAt(state, command.location, command.base, base);
  if (changed) next = recalcCpu(next);

  const modifiers = locationModifiers(next.regions, command.location);
  return replaceBaseAt(next, command.location, command.base, recalcBaseCpu(base, modifiers));
}

function replaceBaseAt(
  state: SimulationState,
  locationId: string,
  index: number,
  base: BaseState,
): SimulationState {
  return {
    ...state,
    locations: state.locations.map((location) =>
      location.specId === locationId
        ? { ...location, bases: location.bases.map((was, at) => (at === index ? base : was)) }
        : location,
    ),
  };
}

/**
 * `Player.set_allocated_cpu_for` (`player.py:243`): point CPU at a task, or take it away
 * again by pointing zero at it.
 *
 * Nothing is recounted here and no CPU changes hands. An allocation is a standing intent the
 * next Tick reads; what it can actually draw is settled there and by the recount that closes
 * a Tick (`./cpu.ts`), which is also the only thing that ever reduces one.
 *
 * # The two refusals are upstream's, and so is the gap between them
 *
 * This is the one Command that refuses on a rule rather than on an address, and it is
 * upstream's rule rather than a screen's: `set_allocated_cpu_for` *asserts* that a tech is
 * available, so the Reference itself stops rather than recording a step. A Scenario reaching
 * past availability here would therefore have nothing to be compared against — unlike
 * `buildBase`, where `Location.add_base` checks nothing and the Reference builds whatever it
 * is told (see this file's header).
 *
 * The negative check is narrower than it looks and the port keeps it that way: upstream's
 * `elif` chain only reaches it for `jobs` and `cpu_pool`, so a *tech* may be given a negative
 * allocation and it is simply never drawn on — `get_cpu_allocations` yields only what is
 * above zero, and so does the recount. It is a preserved defect; widening the
 * check would refuse a Command the Reference accepts.
 *
 * # The cap is a Deviation, and the only silent one here
 *
 * Upstream's setter stores whatever it is handed; the only cap on an allocation is the
 * research screen's slider maximum (`screens/research.py:183`), so a headless driver can
 * point CPU at a task that no base provides and research arbitrarily fast. The cap is a rule
 * of the game rather than of a screen, so the port clamps here to the task's own allocation
 * plus what `calc_cpu_left` reports for its danger level — recorded as deviation 5 in
 * the register. Clamped rather than refused, because upstream's slider treats an over-reach as
 * "as much as there is", not as an error. A Scenario must stay under the cap, as it must
 * stay inside availability: past either, it has nothing to be compared against.
 */
function allocateCpu(state: SimulationState, command: AllocateCpu): SimulationState {
  const { task, cpu } = command;
  if (task !== JOBS && task !== CPU_POOL) {
    const spec = content.techs.byId.get(task);
    if (!spec) throw new CommandError(`unknown task ${task}`);
    if (!isAvailable(spec.prerequisites, finishedTechs(state.techs))) {
      throw new CommandError(`cannot assign CPU to ${task}, which is not available`);
    }
  } else if (cpu < 0) {
    throw new CommandError(`cannot assign negative CPU units to ${task}`);
  }

  const most = allocatedCpuFor(state, task) + (cpuLeft(state)[dangerFor(task)] ?? 0);
  const granted = Math.min(cpu, Math.max(most, 0));
  return { ...state, cpuUsage: setAllocatedCpuFor(state.cpuUsage, task, granted) };
}

/**
 * `Base.switch_power` (`base.py:269`) together with the CPU recount it ends with.
 *
 * The recount is the whole of what the Command is *for*: a base that goes to sleep stops
 * counting towards the CPU the player can allocate and starts counting towards the sleeping
 * total instead, and the next Tick reads both (`./cpu.ts`). Nothing is refused — a base that
 * has only one available state steps back onto it, which is upstream's own wrap.
 */
function switchBasePower(state: SimulationState, command: SwitchPower): SimulationState {
  const base = baseAt(state, command.location, command.base);
  const switched = replaceBaseAt(state, command.location, command.base, switchPower(base));
  return recalcCpu(switched);
}

/** `Base.destroy` (`base.py:487`), including the CPU recount it ends with. */
function destroyBase(state: SimulationState, command: DestroyBase): SimulationState {
  baseAt(state, command.location, command.base);
  return recalcCpu(removeBase(state, command.location, command.base));
}

/** `Base.name`'s setter (`base.py:216`) — the whole of the rule. */
function renameBase(state: SimulationState, command: RenameBase): SimulationState {
  const base = baseAt(state, command.location, command.base);
  return replaceBaseAt(state, command.location, command.base, { ...base, name: command.name });
}

function baseAt(state: SimulationState, locationId: string, index: number): BaseState {
  const location = locationOf(state, locationId);
  if (!location) throw new CommandError(`no such location: ${locationId}`);
  const base = location.bases[index];
  if (!base) {
    throw new CommandError(
      `${locationId} has ${location.bases.length} base(s); asked for index ${index}`,
    );
  }
  return base;
}
