/**
 * Upstream's save schema back into a State root — the inverse of `./project.ts`.
 *
 * A Save carries the projection and nothing else, so loading one is not a
 * deserialization: most of what the State root holds is *rebuilt* here, from the Content and
 * from the difficulty, exactly as `Player.deserialize_obj` (`player.py:678`) followed by
 * `Player.initialize` (`player.py:138`) rebuilds it. Two consequences shape the whole file:
 *
 * - **The order of the steps is contract, not tidiness.** Upstream reads a spec's cost through
 *   `g.pl.labor_bonus` at the moment it asks (`buyable.py:63`), and a triggered Event moves
 *   that bonus. Bases are restored before the Events and techs after them, so the two are
 *   costed against different bonuses. That is upstream's behaviour and it is reproduced, not
 *   corrected.
 * - **Nothing here draws.** Upstream shuffles a region and rolls a day of the year while
 *   loading (`player.py:99-134`), from a generator it never persisted. The port restores the
 *   generator instead (deviation 4), so a draw taken here would displace the whole
 *   later stream. The day of the year is the Host's to supply for the same reason.
 *
 * # It refuses rather than guesses
 *
 * The document reaching this function came out of storage or off a disk, so unlike the fixture
 * round trip in `./serialise.ts` it is not one the port just wrote. Every field is read
 * through a reader that throws `SaveContentError` naming the path, and the Host turns any
 * throw into "this save cannot be read" — which is the case the save store designs around, because a
 * save that cannot be read must never be overwritten by an autosave.
 */

import { finishedTechs, isAvailable } from "./availability.ts";
import { checkPower } from "./base.ts";
import { finished, newBuyable, recalcBaseCpu, specCost } from "./buyable.ts";
import { SECONDS_PER_DAY, rawDays } from "./clock.ts";
import { content } from "./content/index.ts";
import type { Modifiers } from "./content/types.ts";
import { recalcCpu } from "./cpu.ts";
import { applyConsequence } from "./gameevent.ts";
import { locationModifiers, modifyCost, modifyMaintenance } from "./location.ts";
import {
  UnknownIdError,
  contentId,
  logKindFields,
  type SavedObject,
  type SavedValue,
} from "./project.ts";
import type { Rng } from "./rng/random.ts";
import {
  CASH,
  CPU,
  ITEM_SLOTS,
  LABOR,
  MAX_LOG_ENTRIES,
  type BaseState,
  type BuyableState,
  type Cost,
  type CpuAllocation,
  type GameEventState,
  type GroupState,
  type ItemSlot,
  type ItemState,
  type LocationState,
  type LogEntry,
  type PowerState,
  type RegionState,
  type SimulationState,
  type Statistics,
  type TechState,
} from "./state.ts";

/** A Save whose persistent half this build cannot read. Always names the field. */
export class SaveContentError extends Error {}

export interface RestoreOptions {
  /**
   * The day of the year the game's clock is offset by. Upstream draws a fresh one every time
   * a game is loaded (`player.py:134`) and persists none; only the day/night display reads
   * it, so it is neither in the projection nor in a Trace. The Host chooses it, as it chooses
   * the seed of a new game.
   */
  readonly startDay: number;
}

/**
 * The State root a Save's persistent half describes, ready for the next Tick.
 *
 * `saved` is exactly what `projectPersistent` wrote, and `rng` is the generator that stood
 * beside it in the Save.
 */
export function restorePersistent(
  saved: SavedObject,
  rng: Rng,
  { startDay }: RestoreOptions,
): SimulationState {
  const root = asObject(saved, "state");
  const difficulty = asText(field(root, "difficulty", "state"), "state.difficulty");
  const spec = content.difficulties.byId.get(difficulty);
  if (!spec) throw new SaveContentError(`state.difficulty: no such difficulty: ${difficulty}`);

  const gameTime = asWhole(field(root, "game_time", "state"), "state.game_time");
  if (gameTime < 0) throw new SaveContentError("state.game_time: before the start of the game");
  const player = asObject(field(root, "player", "state"), "state.player");

  // `Player.__init__` and `Player.deserialize_obj`'s own assignments, in one value: the
  // difficulty's starting figures, and the fields the schema carries verbatim.
  let state: SimulationState = {
    difficulty,
    gameTime,
    rng,
    cash: asWhole(field(player, "cash", "state.player"), "state.player.cash"),
    partialCash: asNumber(
      field(player, "partial_cash", "state.player"),
      "state.player.partial_cash",
    ),
    interestRate: spec.startingInterestRate,
    income: 0,
    cpuPool: 0,
    laborBonus: spec.laborMultiplier,
    jobBonus: 10000,
    usedCpu: asNumber(field(player, "used_cpu", "state.player"), "state.player.used_cpu"),
    hadGrace: asFlag(field(player, "had_grace", "state.player"), "state.player.had_grace"),
    apotheosis: false,
    // `player.py:748`: not persisted, and reset to the current day at load, so the three-day
    // autosave cadence restarts from wherever the game was loaded.
    lastAutosaveDay: rawDays(gameTime),
    startDay,
    displayDiscover: "none",
    availableCpus: [0, 0, 0, 0, 0],
    sleepingCpus: 0,
    cpuUsage: [],
    lastDiscovery: discovery(player, "last_discovery"),
    prevDiscovery: discovery(player, "prev_discovery"),
    log: restoreLog(field(player, "log", "state.player")),
    stats: restoreStats(field(root, "stats", "state")),
    groups: restoreGroups(
      field(player, "groups", "state.player"),
      spec.discoverMultiplier,
      spec.suspicionMultiplier,
    ),
    regions: restoreRegions(field(player, "regions", "state.player")),
    locations: [],
    techs: [],
    events: [],
  };

  const of = (name: string): SavedValue => field(player, name, "state.player");
  state = { ...state, locations: restoreLocations(state, of("locations")) };
  state = restoreEvents(state, of("events"));
  state = restoreTechs(state, of("techs"));
  state = { ...state, cpuUsage: restoreCpuUsage(state, of("cpu_usage")) };

  // `Player.initialize`: every finished base recomputes its CPU, then the player totals them.
  state = {
    ...state,
    locations: state.locations.map((location) => ({
      ...location,
      bases: location.bases.map((base) =>
        base.buyable.done
          ? recalcBaseCpu(base, locationModifiers(state.regions, location.specId))
          : base,
      ),
    })),
  };
  return recalcCpu(state);
}

/** `g.convert_internal_id`, with an unknown id turned into a refusal that names the path. */
function resolveId(type: string, value: SavedValue, where: string): string {
  const id = asText(value, where);
  try {
    return contentId(type, id);
  } catch (error) {
    if (error instanceof UnknownIdError) throw new SaveContentError(`${where}: ${error.message}`);
    throw error;
  }
}

function discovery(player: SavedObject, name: string): string | null {
  const value = player[name];
  if (value === undefined || value === null) return null;
  return resolveId("location", value, `state.player.${name}`);
}

/** `stats.deserialize_obj` (`stats.py:52`). */
function restoreStats(value: SavedValue): Statistics {
  const stats = asObject(value, "state.stats");
  const count = (name: string): number =>
    asWhole(field(stats, name, "state.stats"), `state.stats.${name}`);
  return {
    baseCreated: count("base_created"),
    cashEarned: count("cash_earned"),
    cpuUsed: count("cpu_used"),
    itemCreated: count("item_created"),
    techCreated: count("tech_created"),
  };
}

/**
 * `AbstractLogMessage.deserialize_obj` (`logmessage.py:158`), for every kind at once.
 *
 * The log is a bounded ring on this side of a Save as well: `Player.deserialize_obj` clears
 * the deque and extends it (`player.py:689`), and the deque is `maxlen=1000`
 * (`player.py:112`), so a saved log longer than the cap arrives truncated to its newest
 * entries rather than whole. Reading it whole is the one way the port's log could grow past
 * the bound the rest of it keeps.
 *
 * # A known kind is read by its own field list
 *
 * Upstream looks the class up by `log_id` and then takes each of that class's serial fields
 * by name (`logmessage.py:161`), so a saved entry of a known kind that is missing one is a
 * `KeyError` there and a refusal here. It has to be: the Presentation reads those fields by
 * name too — `app/src/host/notifications.ts` takes `tech_id` off a finished research — and
 * an entry that arrived with an empty field map would reach it as a row saying nothing.
 * Anything else the entry carries is dropped, as upstream drops it, because the fields of a
 * kind are the ones its own table names.
 *
 * A kind this build does not register is refused for the same reason: the lookup is a
 * `KeyError` in `SAVEABLE_LOG_MESSAGES` (`logmessage.py:160`) and the whole save fails to
 * load. The port keeps that rather than tolerating the entry.
 */
function restoreLog(value: SavedValue): readonly LogEntry[] {
  const saved = asArray(value, "state.player.log");
  const kept = saved.slice(-MAX_LOG_ENTRIES);
  // What the ring dropped still counts in the path a refusal names, which is a position in
  // the document on disk rather than in what survived it.
  const dropped = saved.length - kept.length;

  return kept.map((raw, index) => {
    const where = `state.player.log[${dropped + index}]`;
    const entry = asObject(raw, where);
    const kind = asText(field(entry, "log_id", where), `${where}.log_id`);
    const known = logKindFields(kind);
    if (!known) throw new SaveContentError(`${where}.log_id: no such log kind: ${kind}`);
    const fields: Record<string, string | number> = {};
    for (const [name, type] of known) {
      const savedField = field(entry, name, where);
      fields[name] =
        type === null
          ? asScalar(savedField, `${where}.${name}`)
          : resolveId(type, savedField, `${where}.${name}`);
    }
    return {
      kind,
      rawEmitTime: asWhole(field(entry, "raw_emit_time", where), `${where}.raw_emit_time`),
      fields,
    };
  });
}

/**
 * `Group.deserialize_obj` (`group.py:56`). The two bonuses and the two decays are not in the
 * schema at all: they come from the difficulty, and a triggered Event puts back whatever it
 * had changed when it is re-applied below.
 */
function restoreGroups(
  value: SavedValue,
  discoverMultiplier: number,
  suspicionMultiplier: number,
): readonly GroupState[] {
  const saved = new Map<string, SavedObject>();
  asArray(value, "state.player.groups").forEach((raw, index) => {
    const where = `state.player.groups[${index}]`;
    const group = asObject(raw, where);
    saved.set(resolveId("group", field(group, "id", where), `${where}.id`), group);
  });

  return content.groups.all.map((group) => {
    const entry = saved.get(group.id);
    const where = `state.player.groups[${group.id}]`;
    const active = entry?.is_actively_discovering_bases;
    return {
      specId: group.id,
      suspicion: entry ? asWhole(field(entry, "suspicion", where), `${where}.suspicion`) : 0,
      changedSuspicionDecay: 0,
      baseDiscoverBonus: discoverMultiplier,
      changedDiscoverBonus: 0,
      baseDiscoverSuspicion: suspicionMultiplier,
      changedDiscoverSuspicion: 0,
      activelyDiscovering:
        active === undefined ? true : asFlag(active, `${where}.is_actively_discovering_bases`),
    };
  });
}

/**
 * `Region.deserialize_obj` (`region.py:68`), minus its repair path.
 *
 * Upstream re-assigns the unused entries when the Content has grown a location since the Save
 * was written. The port refuses instead: that only happens when the Content underneath a Save
 * has changed, which the Save's own reference revision already rejects, and a
 * silent re-assignment would move a location's modifiers without saying so.
 */
function restoreRegions(value: SavedValue): readonly RegionState[] {
  const saved = new Map<string, SavedObject>();
  asArray(value, "state.player.regions").forEach((raw, index) => {
    const where = `state.player.regions[${index}]`;
    const region = asObject(raw, where);
    saved.set(resolveId("region", field(region, "id", where), `${where}.id`), region);
  });

  return content.regions.all.map((region) => {
    const where = `state.player.regions[${region.id}]`;
    const entry = saved.get(region.id);
    if (!entry) throw new SaveContentError(`${where}: missing`);
    const assigned = new Map<string, number>();
    asArray(
      field(entry, "modifier_entry_by_location", where),
      `${where}.modifier_entry_by_location`,
    ).forEach((raw, index) => {
      const at = `${where}.modifier_entry_by_location[${index}]`;
      const pair = asObject(raw, at);
      assigned.set(
        resolveId("location", field(pair, "loc_id", at), `${at}.loc_id`),
        asWhole(field(pair, "modifier_entry", at), `${at}.modifier_entry`),
      );
    });

    return {
      specId: region.id,
      modifierEntryByLocation: region.locations.map((locationId) => {
        const entryIndex = assigned.get(locationId);
        if (entryIndex === undefined) {
          throw new SaveContentError(`${where}: no modifier entry for ${locationId}`);
        }
        return { locationId, entry: entryIndex };
      }),
    };
  });
}

/**
 * Every Content location, carrying the bases the Save listed for it. A location the player
 * could not reach was left out of the Save entirely (`player.py:634`) and comes back empty,
 * which is what upstream's fresh `Location` gives it too.
 */
function restoreLocations(state: SimulationState, value: SavedValue): readonly LocationState[] {
  const saved = new Map<string, SavedObject>();
  asArray(value, "state.player.locations").forEach((raw, index) => {
    const where = `state.player.locations[${index}]`;
    const location = asObject(raw, where);
    saved.set(resolveId("location", field(location, "id", where), `${where}.id`), location);
  });

  return content.locations.all.map((location) => {
    const entry = saved.get(location.id);
    if (!entry) return { specId: location.id, bases: [] };
    const where = `state.player.locations[${location.id}]`;
    const modifiers = locationModifiers(state.regions, location.id);
    return {
      specId: location.id,
      bases: asArray(field(entry, "bases", where), `${where}.bases`).map((raw, index) =>
        restoreBase(state, raw, modifiers, `${where}.bases[${index}]`),
      ),
    };
  });
}

/** `Base.deserialize_obj` (`base.py:352`) followed by `Location.add_base` (`location.py:184`). */
function restoreBase(
  state: SimulationState,
  value: SavedValue,
  modifiers: Modifiers,
  where: string,
): BaseState {
  const saved = asObject(value, where);
  const specId = resolveId("base", field(saved, "id", where), `${where}.id`);
  const spec = content.bases.byId.get(specId);
  if (!spec) throw new SaveContentError(`${where}.id: no such base type: ${specId}`);

  let base: BaseState = {
    specId,
    name: asText(field(saved, "name", where), `${where}.name`),
    startedAtMin: asWhole(field(saved, "started_at_min", where), `${where}.started_at_min`),
    powerState: "offline",
    graceOver:
      saved.grace_over === undefined ? true : asFlag(saved.grace_over, `${where}.grace_over`),
    maintenance: spec.maintenance,
    rawCpu: 0,
    cpu: 0,
    items: emptySlots(),
    buyable: restoreBuyable(specCost(spec.cost, state.laborBonus), saved, where),
  };

  // A base type with a forced CPU comes with it and ignores what the Save listed, so that the
  // base still loads if the spec later stops forcing one (`base.py:357`).
  if (spec.forceCpu !== null) {
    const itemSpec = content.items.byId.get(spec.forceCpu);
    if (!itemSpec) throw new SaveContentError(`${where}: no such item: ${spec.forceCpu}`);
    base = {
      ...base,
      items: {
        ...base.items,
        cpu: {
          specId: itemSpec.id,
          buyable: finished(newBuyable(specCost(itemSpec.cost, state.laborBonus), spec.size)),
        },
      },
    };
  } else {
    const items = { ...base.items };
    asArray(field(saved, "items", where), `${where}.items`).forEach((raw, index) => {
      const item = restoreItem(state, raw, `${where}.items[${index}]`);
      items[item.slot] = item.state;
    });
    base = { ...base, items };
  }

  base = withPowerState(base, field(saved, "power_state", where), `${where}.power_state`);

  // The location's modifiers reach the base's costs and maintenance only once it stands
  // somewhere — and they are applied *after* `cost_paid` was read back, as upstream applies
  // them, so the two truncations land in upstream's order.
  return recalcBaseCpu(
    {
      ...base,
      buyable: {
        ...base.buyable,
        totalCost: modifyCost(base.buyable.totalCost, modifiers),
        costLeft: modifyCost(base.buyable.costLeft, modifiers),
      },
      maintenance: modifyMaintenance(base.maintenance, modifiers),
    },
    modifiers,
  );
}

/** `Item.deserialize_obj` (`item.py:211`), plus the slot the item goes into. */
function restoreItem(
  state: SimulationState,
  value: SavedValue,
  where: string,
): { readonly slot: ItemSlot; readonly state: ItemState } {
  const saved = asObject(value, where);
  const specId = resolveId("item", field(saved, "id", where), `${where}.id`);
  const spec = content.items.byId.get(specId);
  if (!spec) throw new SaveContentError(`${where}.id: no such item: ${specId}`);
  const slot = ITEM_SLOTS.find((candidate) => candidate === spec.itemType);
  if (slot === undefined) throw new SaveContentError(`${where}: no such slot: ${spec.itemType}`);

  return {
    slot,
    state: { specId, buyable: restoreBuyable(specCost(spec.cost, state.laborBonus), saved, where) },
  };
}

/**
 * `Base.check_power` (`base.py:281`) over a stored state, with upstream's fallback for one it
 * no longer knows: the two historical stasis names become `sleep`, anything else `active`.
 */
function withPowerState(base: BaseState, value: SavedValue, where: string): BaseState {
  const stored = asText(value, where);
  const known = (["offline", "active", "sleep"] as const).find(
    (candidate): candidate is PowerState => candidate === stored,
  );
  const powerState: PowerState =
    known ?? (stored === "statis" || stored === "entering_stasis" ? "sleep" : "active");
  return checkPower({ ...base, powerState });
}

/** `Buyable.restore_buyable_fields` (`buyable.py:239`). */
function restoreBuyable(cost: Cost, saved: SavedObject, where: string): BuyableState {
  const count = saved.count === undefined ? 1 : asWhole(saved.count, `${where}.count`);
  if (count < 1) throw new SaveContentError(`${where}.count: not a count: ${count}`);
  const buyable = newBuyable(cost, count);
  if (saved.done !== undefined && asFlag(saved.done, `${where}.done`)) return finished(buyable);

  const paid = asCost(field(saved, "cost_paid", where), `${where}.cost_paid`);
  return {
    ...buyable,
    costLeft: [
      buyable.totalCost[CASH] - paid[CASH],
      buyable.totalCost[CPU] - paid[CPU],
      buyable.totalCost[LABOR] - paid[LABOR],
    ],
  };
}

/**
 * `Event.deserialize_obj` (`event.py:124`): a triggered Event is triggered again, which is
 * what puts its standing consequence back — none of them are persisted. One that outlived its
 * duration while the Save sat on disk expires instead of being re-applied.
 */
function restoreEvents(state: SimulationState, value: SavedValue): SimulationState {
  let next = state;
  const events: GameEventState[] = [];

  asArray(value, "state.player.events").forEach((raw, index) => {
    const where = `state.player.events[${index}]`;
    const saved = asObject(raw, where);
    const specId = resolveId("event", field(saved, "id", where), `${where}.id`);
    const spec = content.events.byId.get(specId);
    if (!spec) throw new SaveContentError(`${where}.id: no such event: ${specId}`);

    const triggered = asWhole(field(saved, "triggered", where), `${where}.triggered`);
    if (triggered === 0) {
      events.push({ specId, triggered: 0, triggeredAt: -1 });
      return;
    }

    const triggeredAt = asWhole(field(saved, "triggered_at", where), `${where}.triggered_at`);
    const expired =
      spec.duration !== null && next.gameTime - triggeredAt > spec.duration * SECONDS_PER_DAY;
    if (expired) {
      events.push({ specId, triggered: 0, triggeredAt: -1 });
      return;
    }

    events.push({ specId, triggered, triggeredAt });
    next = applyConsequence(next, spec.effectStack, 1, true).state;
  });

  return { ...next, events };
}

/**
 * `Tech.deserialize_obj` (`tech.py:99`), costed against the labor bonus the Events left — and
 * **a finished Tech is finished again**, which is what puts its standing consequence back.
 *
 * None of interest rate, income, labor bonus or job bonus is persisted: `Player.serialize_obj`
 * (`player.py:629`) writes a Tech as one `done` flag and nothing else. They exist after a load
 * only because upstream re-triggers every finished Tech's effect on the way in —
 * `restore_buyable_fields` (`buyable.py:239`) calls `finish(is_player=False,
 * loading_savegame=True)` and `Tech.finish` (`tech.py:81`) triggers `spec.effect`. Stopping at
 * the flag would restore a game silently missing everything the player researched, and a Save
 * is the one place that cannot be recovered from.
 *
 * The consequence is applied *between* one Tech and the next, as upstream's loop does, because
 * a `cost_labor` Tech moves the bonus the Tech after it is costed against. Nothing in this
 * Content rests on it — no Tech has a labor cost — but the order is upstream's and is kept
 * rather than flattened.
 *
 * `is_player=False` is why `stats.tech_created` does not move here: a Tech restored was not
 * researched again.
 */
function restoreTechs(state: SimulationState, value: SavedValue): SimulationState {
  const saved = new Map<string, SavedObject>();
  asArray(value, "state.player.techs").forEach((raw, index) => {
    const where = `state.player.techs[${index}]`;
    const tech = asObject(raw, where);
    saved.set(resolveId("tech", field(tech, "id", where), `${where}.id`), tech);
  });

  let next = state;
  const techs: TechState[] = [];
  for (const tech of content.techs.all) {
    const cost = specCost(tech.cost, next.laborBonus);
    const entry = saved.get(tech.id);
    const buyable = entry
      ? restoreBuyable(cost, entry, `state.player.techs[${tech.id}]`)
      : newBuyable(cost);
    techs.push({ specId: tech.id, buyable });
    if (buyable.done) next = applyConsequence(next, tech.effectStack, 1, true).state;
  }

  return { ...next, techs };
}

/**
 * `Player.deserialize_obj`'s `cpu_usage` loop (`player.py:733`): an allocation pointed at a
 * tech the player cannot research any more is dropped rather than restored.
 */
function restoreCpuUsage(state: SimulationState, value: SavedValue): readonly CpuAllocation[] {
  const usage = asObject(value, "state.player.cpu_usage");
  const done = finishedTechs(state.techs);
  const allocations: CpuAllocation[] = [];

  for (const [taskId, cpu] of Object.entries(usage)) {
    const where = `state.player.cpu_usage.${taskId}`;
    if (taskId === "cpu_pool" || taskId === "jobs") {
      allocations.push({ taskId, cpu: asWhole(cpu, where) });
      continue;
    }
    const techId = resolveId("tech", taskId, where);
    const spec = content.techs.byId.get(techId);
    if (!spec || !isAvailable(spec.prerequisites, done)) continue;
    allocations.push({ taskId: techId, cpu: asWhole(cpu, where) });
  }
  return allocations;
}

function emptySlots(): Record<ItemSlot, ItemState | null> {
  return Object.fromEntries(ITEM_SLOTS.map((slot) => [slot, null])) as Record<
    ItemSlot,
    ItemState | null
  >;
}

function field(object: SavedObject, name: string, where: string): SavedValue {
  const value = object[name];
  if (value === undefined) throw new SaveContentError(`${where}.${name}: missing`);
  return value;
}

function asObject(value: SavedValue, where: string): SavedObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SaveContentError(`${where}: not an object`);
  }
  // `Array.isArray` does not narrow a `readonly` array out of the union, so the cast stands
  // in for the check above rather than replacing it.
  return value as SavedObject;
}

function asArray(value: SavedValue, where: string): readonly SavedValue[] {
  if (!Array.isArray(value)) throw new SaveContentError(`${where}: not an array`);
  return value;
}

function asNumber(value: SavedValue, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SaveContentError(`${where}: not a number`);
  }
  return value;
}

function asWhole(value: SavedValue, where: string): number {
  const number = asNumber(value, where);
  if (!Number.isInteger(number)) throw new SaveContentError(`${where}: not a whole number`);
  return number;
}

function asText(value: SavedValue, where: string): string {
  if (typeof value !== "string") throw new SaveContentError(`${where}: not a string`);
  return value;
}

function asFlag(value: SavedValue, where: string): boolean {
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return value === 1;
  throw new SaveContentError(`${where}: not a boolean`);
}

/** A log field, which the schema keeps as a string or a number and nothing else. */
function asScalar(value: SavedValue, where: string): string | number {
  if (typeof value === "string" || typeof value === "number") return value;
  throw new SaveContentError(`${where}: not a string or a number`);
}

function asCost(value: SavedValue, where: string): Cost {
  const parts = asArray(value, where);
  if (parts.length !== 3) throw new SaveContentError(`${where}: not three cost units`);
  return [
    asWhole(parts[CASH] as SavedValue, `${where}[0]`),
    asWhole(parts[CPU] as SavedValue, `${where}[1]`),
    asWhole(parts[LABOR] as SavedValue, `${where}[2]`),
  ];
}
