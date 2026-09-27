/**
 * The loader: every reading the Converter refused.
 *
 * The line is drawn at transcription. The Converter carries Content across without
 * interpreting it — `6/5` arrives as the string `6/5`, a position as two or three strings, a
 * prerequisite as either a string or a list — and everything that *reads* those values
 * happens here, in `sim/`, inside the compared surface. A fault in a fraction or in a region
 * expansion then shows up as a trace divergence pointing at a line, instead of as two
 * numbers that differ with nothing to blame.
 *
 * Nothing here validates. The content is fixed when the build is made and checked in CI
 * twice over — `tools/convert/verify.py` against upstream's own loaders, and `tsc -b`
 * against the hand-written types in `./raw.ts`. What can still fail is parsing: `integer`
 * and `decimal` refuse a value the way Python's `int()` and `float()` refuse it, because a
 * silent `NaN` would travel much further than a thrown error.
 *
 * Order is carried everywhere, and every id map is built from its array.
 */

import type {
  RawBase,
  RawContent,
  RawDanger,
  RawDifficulty,
  RawEvent,
  RawGroup,
  RawInternalId,
  RawItem,
  RawItemType,
  RawKnowledgeArea,
  RawLocation,
  RawRegion,
  RawStorySection,
  RawStrings,
  RawTask,
  RawTech,
  RawWarning,
} from "./raw.ts";
import type {
  BaseType,
  BuildableIn,
  Catalogue,
  Content,
  Cost,
  Danger,
  Difficulty,
  GameEvent,
  Group,
  InternalIds,
  Item,
  ItemType,
  KnowledgeArea,
  KnowledgeEntry,
  Location,
  Modifiers,
  Prerequisites,
  Region,
  StorySection,
  Task,
  Tech,
  Warning,
} from "./types.ts";

export class ContentError extends Error {}

const INTEGER = /^[+-]?[0-9]+$/;
const DECIMAL = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:e[+-]?[0-9]+)?$/;

/** `int(text)`: leading and trailing whitespace allowed, nothing else. */
function integer(text: string | undefined): number {
  const trimmed = text?.trim();
  if (trimmed === undefined || !INTEGER.test(trimmed)) {
    throw new ContentError(`not an integer: ${JSON.stringify(text)}`);
  }
  return Number(trimmed);
}

/** `float(text)`, narrowed to the decimal forms — so `0x10` is refused here as it is there. */
function decimal(text: string): number {
  const trimmed = text.trim().toLowerCase();
  if (!DECIMAL.test(trimmed)) {
    throw new ContentError(`not a number: ${JSON.stringify(text)}`);
  }
  return Number(trimmed);
}

/** `spec.promote_to_list`: one string becomes a one-element list, an absent field an empty one. */
function promote(value: RawStrings | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : value;
}

/**
 * The fields upstream declares in `listttype_attrs` — `flavor` and `cities`. `load_generic_defs`
 * splits those on `|` whether or not the `.dat` wrote them as `_list`, so a future reference
 * bump that drops the suffix must not turn a list into one long string here.
 */
function splitList(value: RawStrings | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === "string" ? value.split("|").map((part) => part.trim()) : value;
}

/** `buyable.spec_parse_cost`: exactly three integers, cash then cpu then labor. */
function cost(values: readonly string[]): Cost {
  return [integer(values[0]), integer(values[1]), integer(values[2])];
}

function splitOnce(entry: string, separator: string): readonly [string, string] {
  const parts = entry.split(separator);
  if (parts.length !== 2) {
    throw new ContentError(`expected one ${separator} in ${JSON.stringify(entry)}`);
  }
  return [parts[0] as string, parts[1] as string];
}

/**
 * `g.read_modifiers_dict`: `name: value` per entry, the name lower-cased, and a value written
 * as a fraction divided out — `6/5` is 1.2 and `5/6` is 0.8333333333333334, which is the
 * division and not a rounding of it.
 */
function modifiers(entries: readonly string[] | undefined): Modifiers {
  const table = new Map<string, number>();
  for (const entry of entries ?? []) {
    const [name, written] = splitOnce(entry, ":");
    const text = written.toLowerCase().trim();
    if (text.includes("/")) {
      const [left, right] = splitOnce(text, "/");
      table.set(name.toLowerCase().trim(), decimal(left) / decimal(right));
    } else {
      table.set(name.toLowerCase().trim(), decimal(text));
    }
  }
  return table;
}

/**
 * `base.parse_detect_chance`. The group name is *not* stripped, unlike a modifier's name —
 * a difference in upstream's two parsers, kept because the ids are what a save is keyed on.
 */
function detectChance(entries: readonly string[]): ReadonlyMap<string, number> {
  const table = new Map<string, number>();
  for (const entry of entries) {
    const [group, written] = splitOnce(entry, ":");
    table.set(group, integer(written));
  }
  return table;
}

/**
 * `item.convert_item_qualities`: a flat list read as name/value pairs.
 */
function qualities(values: readonly string[]): ReadonlyMap<string, number> {
  const table = new Map<string, number>();
  for (let at = 0; at + 1 < values.length; at += 2) {
    table.set(values[at] as string, integer(values[at + 1]));
  }
  return table;
}

/**
 * `prerequisite.Prerequisite`, read the way `available()` reads it. Upstream asserts that
 * `impossible` stands alone and that `OR` leads the list; here the same two shapes are
 * recognised and anything else stays an AND, which is what `available()` does with it.
 */
function prerequisites(value: RawStrings | undefined): Prerequisites {
  const named = promote(value);
  if (named.length === 1 && named[0] === "impossible") return { mode: "impossible" };
  if (named[0] === "OR") return { mode: "any", techs: named.slice(1) };
  return { mode: "all", techs: named };
}

/**
 * `location.position_data_parser`: two elements, or three with `absolute` first. The division
 * by −100 is upstream's own — a position is a percentage, and the sign is what tells its
 * widget the number is a fraction of the parent rather than a pixel count.
 */
function position(values: readonly string[]): { absolute: boolean; x: number; y: number } {
  if (values.length === 3) {
    if (values[0] !== "absolute") {
      throw new ContentError(`a three-element position must start with "absolute"`);
    }
    return { absolute: true, x: integer(values[1]) / -100, y: integer(values[2]) / -100 };
  }
  if (values.length !== 2) {
    throw new ContentError(`a position is two or three elements, got ${values.length}`);
  }
  return { absolute: false, x: integer(values[0]) / -100, y: integer(values[1]) / -100 };
}

/**
 * `BuyableSpec.regions`: a region id is replaced by that region's locations, a location id is
 * kept, and `ALL` sets a flag instead.
 *
 * The flag short-circuits everything else, because upstream re-tests `"ALL" in value` on every
 * iteration — so a list naming `ALL` anywhere contributes no locations at all, whatever else
 * it names. Reproduced rather than tidied: it is behaviour, and the reference is the
 * specification.
 */
function buildableIn(value: RawStrings | undefined, regions: Catalogue<Region>): BuildableIn {
  const named = promote(value);
  if (named.includes("ALL")) return { anywhere: true, locations: [] };

  const locations: string[] = [];
  for (const name of named) {
    const region = regions.byId.get(name);
    if (region) locations.push(...region.locations);
    else locations.push(name);
  }
  return { anywhere: false, locations };
}

/** The ordering contract in one function: the array is the source of truth, the map follows it. */
function catalogue<T extends { readonly id: string }>(all: readonly T[]): Catalogue<T> {
  return { all, byId: new Map(all.map((entry) => [entry.id, entry])) };
}

function loadRegions(
  records: readonly RawRegion[],
  locations: readonly RawLocation[],
): Catalogue<Region> {
  const membership = new Map<string, string[]>();

  const all = records.map((record): Region => {
    const tables: Modifiers[] = [];
    // load_regions scans modifier1, modifier2, … and stops at the first gap.
    for (let index = 1; record[`modifier${index}`] !== undefined; index += 1) {
      tables.push(modifiers(record[`modifier${index}`]));
    }
    membership.set(record.id, []);
    return { id: record.id, modifiers: tables, locations: membership.get(record.id) as string[] };
  });

  // load_locations appends each location to every region it names, in location order — which
  // is the list Region shuffles a set of modifier indices against when a game starts.
  for (const record of locations) {
    for (const region of promote(record.region)) membership.get(region)?.push(record.id);
  }

  return catalogue(all);
}

function loadLocations(records: readonly RawLocation[]): Catalogue<Location> {
  return catalogue(
    records.map((record): Location => {
      const { absolute, x, y } = position(record.position);
      return {
        id: record.id,
        absolute,
        x,
        y,
        safety: record.safety === undefined ? 0 : integer(record.safety),
        regions: promote(record.region),
        modifiers: modifiers(record.modifier),
        prerequisites: prerequisites(record.pre),
        name: record.name,
        hotkey: record.hotkey,
        cities: splitList(record.cities),
      };
    }),
  );
}

function loadBases(records: readonly RawBase[], regions: Catalogue<Region>): Catalogue<BaseType> {
  // No danger: BaseSpec declares the field and its constructor does not name it, so
  // create_from_data_file drops it and upstream holds no such attribute (see ./raw.ts).
  return catalogue(
    records.map((record): BaseType => ({
      id: record.id,
      size: integer(record.size),
      forceCpu: record.force_cpu ?? null,
      buildableIn: buildableIn(record.allowed, regions),
      detectChance: detectChance(record.detect_chance),
      cost: cost(record.cost),
      maintenance: cost(record.maint),
      prerequisites: prerequisites(record.pre),
      name: record.name,
      description: record.description,
      flavor: splitList(record.flavor),
    })),
  );
}

function loadItems(records: readonly RawItem[], regions: Catalogue<Region>): Catalogue<Item> {
  return catalogue(
    records.map((record): Item => ({
      id: record.id,
      cost: cost(record.cost),
      itemType: record.type,
      qualities: qualities(record.quality),
      buildableIn: buildableIn(record.build, regions),
      prerequisites: prerequisites(record.pre),
      name: record.name,
      description: record.description,
    })),
  );
}

function loadItemTypes(records: readonly RawItemType[]): Catalogue<ItemType> {
  return catalogue(
    records.map((record): ItemType => ({
      id: record.id,
      isExtra: integer(record.is_extra) !== 0,
      text: record.text,
    })),
  );
}

function loadTechs(records: readonly RawTech[]): Catalogue<Tech> {
  return catalogue(
    records.map((record): Tech => ({
      id: record.id,
      cost: cost(record.cost),
      prerequisites: prerequisites(record.pre),
      danger: record.danger === undefined ? 0 : integer(record.danger),
      effectStack: record.effect ?? [],
      name: record.name,
      description: record.description,
      result: record.result,
    })),
  );
}

function loadEvents(records: readonly RawEvent[]): Catalogue<GameEvent> {
  return catalogue(
    records.map((record): GameEvent => {
      const duration = record.duration === undefined ? 0 : integer(record.duration);
      return {
        id: record.id,
        eventType: record.type,
        effectStack: record.effect,
        chance: integer(record.chance),
        duration: duration > 0 ? duration : null,
        unique: record.unique === undefined ? 0 : integer(record.unique),
        description: record.description,
        logDescription: record.log_description,
      };
    }),
  );
}

function loadTasks(records: readonly RawTask[]): Catalogue<Task> {
  return catalogue(
    records.map((record): Task => {
      // load_tasks ignores whatever a cpu_pool task writes for value and pre.
      const pooled = record.type === "cpu_pool";
      return {
        id: record.id,
        type: record.type,
        value: pooled ? 0 : integer(record.value),
        prerequisites: pooled ? { mode: "all", techs: [] } : prerequisites(record.pre),
        name: record.name,
        description: record.description,
      };
    }),
  );
}

function loadDifficulties(records: readonly RawDifficulty[]): Catalogue<Difficulty> {
  return catalogue(
    records.map((record): Difficulty => ({
      id: record.id,
      startingCash: integer(record.starting_cash),
      startingInterestRate: integer(record.starting_interest_rate),
      laborMultiplier: integer(record.labor_multiplier),
      discoverMultiplier: integer(record.discover_multiplier),
      suspicionMultiplier: integer(record.suspicion_multiplier),
      baseGraceMultiplier: integer(record.base_grace_multiplier),
      gracePeriodCpu: integer(record.grace_period_cpu),
      oldDifficultyValue: integer(record.old_difficulty_value),
      techs: promote(record.tech),
      name: record.name,
    })),
  );
}

function loadGroups(records: readonly RawGroup[]): Catalogue<Group> {
  return catalogue(
    records.map((record): Group => ({
      id: record.id,
      suspicionDecay: record.suspicion_decay === undefined ? 100 : integer(record.suspicion_decay),
      name: record.name,
      discoverLog: record.discover_log,
      discoverDesc: record.discover_desc,
    })),
  );
}

function loadDangers(records: readonly RawDanger[]): Catalogue<Danger> {
  // load_danger keys its table by the level it reads out of the id.
  return catalogue(
    records.map((record): Danger => ({
      id: record.id,
      level: integer(record.id.slice("danger_".length)),
      researchDesc: record.research_desc,
      knowledgeDesc: record.knowledge_desc,
    })),
  );
}

function loadKnowledge(records: readonly RawKnowledgeArea[]): Catalogue<KnowledgeArea> {
  return catalogue(
    records.map((record): KnowledgeArea => {
      const entries: KnowledgeEntry[] = [];
      for (const [key, value] of Object.entries(record)) {
        if (key === "id" || key === "name" || typeof value === "string") continue;
        const [entryName = "", description = ""] = value;
        entries.push({ id: key, name: entryName, description });
      }
      return { id: record.id, name: record.name, entries };
    }),
  );
}

function loadWarnings(records: readonly RawWarning[]): Catalogue<Warning> {
  return catalogue(records.map((record) => ({ ...record })));
}

function loadStory(records: readonly RawStorySection[]): Catalogue<StorySection> {
  return catalogue(
    records.map((record): StorySection => ({
      id: record.id,
      parts: record.parts.map((part) => ({
        text: part.text,
        translatorComments: part.translator_comments,
      })),
    })),
  );
}

function loadInternalIds(records: readonly RawInternalId[]): InternalIds {
  const forward = new Map<string, Map<string, string>>();
  const backward = new Map<string, Map<string, string>>();

  for (const record of records) {
    let ahead = forward.get(record.type);
    let back = backward.get(record.type);
    if (!ahead || !back) {
      ahead = new Map();
      back = new Map();
      forward.set(record.type, ahead);
      backward.set(record.type, back);
    }
    ahead.set(record.id, record.internal_id);
    back.set(record.internal_id, record.id);
  }

  return { forward, backward };
}

/**
 * Resolve the committed Converter output into the Content the rules operate on.
 *
 * The order of the calls is `data.reload_all()`'s: regions before the locations that name
 * one, and both before the base types and items whose `allowed` and `build` lists are
 * expanded through them.
 */
export function loadContent(raw: RawContent): Content {
  const regions = loadRegions(raw.regions.records, raw.locations.records);

  return {
    regions,
    locations: loadLocations(raw.locations.records),
    bases: loadBases(raw.bases.records, regions),
    items: loadItems(raw.items.records, regions),
    itemTypes: loadItemTypes(raw.itemtypes.records),
    techs: loadTechs(raw.techs.records),
    events: loadEvents(raw.events.records),
    tasks: loadTasks(raw.tasks.records),
    difficulties: loadDifficulties(raw.difficulties.records),
    groups: loadGroups(raw.groups.records),
    dangers: loadDangers(raw.dangers.records),
    knowledge: loadKnowledge(raw.knowledge.records),
    warnings: loadWarnings(raw.warnings.records),
    story: loadStory(raw.story.records),
    internalIds: loadInternalIds(raw.internal_id.records),
    numbers: raw.numbers.numbers,
  };
}
