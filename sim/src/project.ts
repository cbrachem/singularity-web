/**
 * The projection of the State root into upstream's save schema.
 *
 * The persistent half of a Trace record adopts that schema rather than
 * inventing one: it is complete, already ordered, and its field names are the reference's own
 * vocabulary. It constrains neither the port's state shape nor its save format — this file is
 * the whole of the coupling, and it is a **pure function over a plain state value**, which is
 * what lets the same projection serve a Save and a fidelity run without either
 * having a second definition of the shape.
 *
 * Two consequences the code has to honour and neither may drift from:
 *
 * - **Every name and quirk here is upstream's**, including the fields it omits — a `count` of
 *   one is not written, a finished buyable writes `done` instead of what it paid, and a
 *   location the player cannot reach is left out of the list entirely.
 * - **The generator is not in it.** Deviation 4 of the register puts the port's generator
 *   state in the Save beside this projection rather than inside it, so the state half stays
 *   byte-identical to a Trace record.
 */

import { content } from "./content/index.ts";
import { finishedTechs, isAvailable } from "./availability.ts";
import {
  ITEM_SLOTS,
  costPaid,
  type BaseState,
  type BuyableState,
  type ItemState,
  type LogEntry,
  type SimulationState,
} from "./state.ts";

/**
 * `savegame.current_save_version` (`savegame.py:127`) — the highest format the reference
 * writes. A reference bump that moves it shows up as a trace divergence on the very first
 * step, which is the intended way to hear about it.
 */
export const SAVE_FORMAT_VERSION = "singularity_savefile_102";

/** A value in upstream's save schema: JSON, and free of floating point. */
export type SavedValue =
  | string
  | number
  | boolean
  | null
  | readonly SavedValue[]
  | { readonly [field: string]: SavedValue };

export type SavedObject = { readonly [field: string]: SavedValue };

/** `g.to_internal_id` (`g.py:301`): the id that survives a rename, or the id itself. */
export function internalId(type: string, id: string): string {
  return content.internalIds.forward.get(type)?.get(id) ?? id;
}

/**
 * `g.convert_internal_id` (`g.py:337`): the id read back out of a Save, normalised to the
 * Content id the rules use.
 *
 * The round trip is through both tables, never by searching `forward`, because an object
 * that was renamed keeps an entry under its old name. An id nothing answers to is
 * a refusal here rather than a value passed through: upstream raises for the same case
 * (`from_internal_id`), and a Save that names an object the Content does not carry is a Save
 * this build cannot read.
 */
export function contentId(type: string, id: string): string {
  const internal = id.startsWith("0x") ? id : internalId(type, id);
  const resolved = content.internalIds.backward.get(type)?.get(internal);
  if (resolved === undefined) throw new UnknownIdError(`no such ${type}: ${id}`);
  return resolved;
}

/** What `contentId` throws. Its own class so a reader can turn it into a refusal. */
export class UnknownIdError extends Error {}

/** `Buyable.serialize_buyable_fields` (`buyable.py:207`). */
function buyableFields(buyable: BuyableState): SavedObject {
  const fields: Record<string, SavedValue> = buyable.done
    ? { done: true }
    : { cost_paid: [...costPaid(buyable)] };
  if (buyable.count !== 1) fields.count = buyable.count;
  return fields;
}

/** `Item.serialize_obj` (`item.py:203`). */
function projectItem(item: ItemState): SavedObject {
  return { id: internalId("item", item.specId), ...buyableFields(item.buyable) };
}

/** `Base.serialize_obj` (`base.py:333`). */
function projectBase(base: BaseState): SavedObject {
  return {
    id: internalId("base", base.specId),
    name: base.name,
    started_at_min: base.startedAtMin,
    power_state: base.powerState,
    grace_over: base.graceOver,
    // Every slot that holds something, in slot order — including a forced CPU, so that a
    // base still loads if the spec later stops forcing one.
    items: ITEM_SLOTS.flatMap((slot) => {
      const item = base.items[slot];
      return item ? [projectItem(item)] : [];
    }),
    ...buyableFields(base.buyable),
  };
}

/**
 * A log field of a saveable kind: its name, and the id space it is written in — or `null`
 * where the schema keeps the value itself.
 */
export type LogField = readonly [name: string, idType: string | null];

/** `AbstractBaseRelatedLogMessage` (`logmessage.py:238`), which four of the kinds extend. */
const BASE_RELATED_FIELDS: readonly LogField[] = [
  ["base_name", null],
  ["base_type_id", "base"],
  ["base_location_id", "location"],
];

/** One saveable log kind: the `log_id` it is written under, and the fields it carries. */
interface LogKind {
  readonly id: string;
  readonly fields: readonly LogField[];
}

/**
 * The saveable log kinds and the fields each one carries, which is
 * `AbstractLogMessage.log_message_serial_fields` and `log_message_serial_converters`
 * (`logmessage.py:114,123`) merged into one table — the registry
 * `register_saveable_log_message` (`logmessage.py:30`) builds, flattened.
 *
 * Both halves are here because both are read by kind. The id spaces say which fields are
 * written as internal ids rather than as the id the rules use, and that belongs to the save
 * schema rather than to the rules for the same reason every other id conversion does — a
 * LogEntry carries the Content id. The names beside them are what `deserialize_obj`
 * (`logmessage.py:158`) takes from a saved entry, one by one, off the class it looked the
 * `log_id` up in: a known kind that is missing one is a `KeyError` there and a refusal in
 * `./restore.ts`.
 *
 * A list, looked up by searching it, rather than an object keyed by kind — because a save is
 * not something the port wrote. On an object literal the kind `constructor` answers with
 * `Object`, and a field named `valueOf` then answers with `Object.prototype.valueOf`, which
 * is a function the id reader would be handed.
 *
 * `raw_emit_time` is not in it: every kind carries it (`logmessage.py:69`), and both sides
 * read it on its own.
 */
const LOG_KINDS: readonly LogKind[] = [
  { id: "event-emitted", fields: [["event_id", "event"]] },
  { id: "tech-researched", fields: [["tech_id", "tech"]] },
  { id: "base-constructed", fields: BASE_RELATED_FIELDS },
  { id: "base-lost-maint", fields: BASE_RELATED_FIELDS },
  {
    id: "base-lost-discovered",
    fields: [...BASE_RELATED_FIELDS, ["discovered_by_group_id", "group"]],
  },
  {
    id: "item-in-base-constructed",
    // Emit order, so a save and a load reproduce the entry they were taken from
    // (itemConstructedLog, sim/src/advance.ts).
    fields: [["item_spec_id", "item"], ["item_count", null], ...BASE_RELATED_FIELDS],
  },
];

/**
 * The `log_id` of every saveable kind, in registry order — what a save may carry, what
 * `./restore.ts` accepts, and the only list the Presentation has to agree with. The Console
 * keeps a table of its own for the headings, and this is what holds the two together.
 */
export const SAVEABLE_LOG_KINDS: readonly string[] = LOG_KINDS.map(({ id }) => id);

/** The fields of a saveable kind, or `undefined` where this build knows no such kind. */
export function logKindFields(kind: string): readonly LogField[] | undefined {
  return LOG_KINDS.find((known) => known.id === kind)?.fields;
}

/** The id space a field of this kind is written in, or `null` for the value itself. */
function logFieldIdType(kind: string, name: string): string | null {
  return logKindFields(kind)?.find(([field]) => field === name)?.[1] ?? null;
}

/** `AbstractLogMessage.serialize_obj` (`logmessage.py:131`). */
function projectLogEntry(entry: LogEntry): SavedObject {
  const fields = Object.fromEntries(
    Object.entries(entry.fields).map(([name, value]) => {
      const type = logFieldIdType(entry.kind, name);
      return [name, type === null ? value : internalId(type, String(value))];
    }),
  );
  return { raw_emit_time: entry.rawEmitTime, ...fields, log_id: entry.kind };
}

/** `Player.serialize_obj` (`player.py:629`) plus the two header fields it leaves out. */
export function projectPersistent(state: SimulationState): SavedObject {
  const finished = finishedTechs(state.techs);

  // The key order is behaviour, not bookkeeping: upstream walks `cpu_usage` in insertion
  // order and the allocation made first is paid first when the cash runs short. A Trace
  // record cannot carry it — the canonical line sorts keys — so it is compared beside the
  // record instead.
  const cpuUsage: Record<string, SavedValue> = {};
  for (const { taskId, cpu } of state.cpuUsage) {
    cpuUsage[taskId === "cpu_pool" || taskId === "jobs" ? taskId : internalId("tech", taskId)] =
      cpu;
  }

  return {
    version: SAVE_FORMAT_VERSION,
    difficulty: state.difficulty,
    game_time: state.gameTime,
    player: {
      cash: state.cash,
      partial_cash: state.partialCash,
      regions: state.regions.map((region) => ({
        id: internalId("region", region.specId),
        // The entry, not the modifier: the modifier is recovered from it, and the entry is
        // what the shuffle actually produced.
        modifier_entry_by_location: region.modifierEntryByLocation.map((assigned) => ({
          loc_id: assigned.locationId,
          modifier_entry: assigned.entry,
        })),
      })),
      locations: state.locations
        .filter((location) => {
          const spec = content.locations.byId.get(location.specId);
          if (!spec) throw new Error(`no such location: ${location.specId}`);
          return isAvailable(spec.prerequisites, finished);
        })
        .map((location) => ({
          id: internalId("location", location.specId),
          bases: location.bases.map(projectBase),
        })),
      cpu_usage: cpuUsage,
      last_discovery:
        state.lastDiscovery === null ? null : internalId("location", state.lastDiscovery),
      prev_discovery:
        state.prevDiscovery === null ? null : internalId("location", state.prevDiscovery),
      log: state.log.map(projectLogEntry),
      used_cpu: state.usedCpu,
      had_grace: state.hadGrace,
      groups: state.groups.map((group) => ({
        id: internalId("group", group.specId),
        suspicion: group.suspicion,
        is_actively_discovering_bases: group.activelyDiscovering,
      })),
      events: state.events.map((event) => ({
        id: internalId("event", event.specId),
        triggered: event.triggered,
        triggered_at: event.triggeredAt,
      })),
      techs: state.techs.map((tech) => ({
        id: internalId("tech", tech.specId),
        ...buyableFields(tech.buyable),
      })),
    },
    stats: {
      base_created: state.stats.baseCreated,
      cash_earned: state.stats.cashEarned,
      cpu_used: state.stats.cpuUsed,
      item_created: state.stats.itemCreated,
      tech_created: state.stats.techCreated,
    },
  };
}

/**
 * What upstream rebuilds at load and therefore does not persist. Traced anyway: a
 * fault in the CPU recalculation reaches this one tick before it reaches anything saved.
 */
export function projectDerived(state: SimulationState): SavedObject {
  return {
    apotheosis: state.apotheosis,
    available_cpus: [...state.availableCpus],
    cpu_pool: state.cpuPool,
    display_discover: state.displayDiscover,
    income: state.income,
    interest_rate: state.interestRate,
    job_bonus: state.jobBonus,
    labor_bonus: state.laborBonus,
    sleeping_cpus: state.sleepingCpus,
  };
}
