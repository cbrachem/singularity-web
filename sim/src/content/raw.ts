/**
 * The shape of the committed Converter output under `content/` — one type per object type,
 * hand-written, in the field names the JSON actually carries.
 *
 * Hand-written throughout, and deliberately so: upstream's `spec_data_fields`
 * declarations are machine-readable but cover only eight of the fifteen object types, and a
 * schema generated for eight and written by hand for seven leaves nobody able to say which
 * half is safe to edit.
 *
 * These types are also the CI check. `./documents.ts` assigns the committed JSON to
 * `RawContent`, so `tsc -b` reads every file under `content/` and fails if one of them stops
 * matching. Nothing validates at play time: the content is fixed when the build is made, and
 * a runtime validator would ship bytes to every player to check something that cannot have
 * changed since.
 *
 * What these types do *not* cover is unknown keys — an imported JSON module is not a fresh
 * object literal, so TypeScript performs no excess-property check on it. That half is the
 * Converter's: `tools/convert/schema.py` rejects a record with a key it does not name, and
 * `tools/convert/verify.py` runs it in CI.
 *
 * The Converter transcribes and does not interpret, so every value here is text: an integer
 * is a string, a modifier written as `6/5` is the string `6/5`, and a field that upstream
 * splits on `|` is already an array. The reading happens in `./load.ts`.
 */

/**
 * A field upstream promotes to a list with `promote_to_list` — written either as `pre` (one
 * string) or as `pre_list` (split on `|` by the Converter).
 */
export type RawStrings = string | readonly string[];

/** Every Converter document names the `.dat` files it was read from. */
export interface RawDocument<T> {
  readonly sources: readonly string[];
  readonly records: readonly T[];
}

/** `internal_id.dat`: the identity that survives renaming — `type|human id = 0xNNNN`. */
export interface RawInternalId {
  readonly type: string;
  readonly id: string;
  readonly internal_id: string;
}

/** `dangers_str.dat`. The level is carried in the id, as `danger_N`. */
export interface RawDanger {
  readonly id: string;
  readonly research_desc: string;
  readonly knowledge_desc: string;
}

/** `numbers.dat`: a plain list of integers, the one document that holds no objects. */
export interface RawNumbersDocument {
  readonly sources: readonly string[];
  readonly numbers: readonly number[];
}

export interface RawStoryPart {
  readonly text: string;
  readonly translator_comments: string;
}

/** `story.dat`: a block format rather than INI, so it gets its own record shape. */
export interface RawStorySection {
  readonly id: string;
  readonly parts: readonly RawStoryPart[];
}

/**
 * `load_warning_defs` writes these as Python literals, so they have no source file and the
 * diff over `content/` cannot see an upstream change to them. The document says so itself.
 */
export interface RawWarning {
  readonly id: string;
  readonly name: string;
  readonly message: string;
}

export interface RawWarningsDocument extends RawDocument<RawWarning> {
  readonly literal: boolean;
  readonly note: string;
}

/** `groups.dat` + `groups_str.dat`. */
export interface RawGroup {
  readonly id: string;
  readonly suspicion_decay?: string;
  readonly name: string;
  readonly discover_log: string;
  readonly discover_desc: string;
}

/**
 * `knowledge_str.dat`. Every field beside `id` and `name` is a help entry written as a
 * name/description pair, and the field name is its key — so the record is open-ended and the
 * type has to be too.
 */
export interface RawKnowledgeArea {
  readonly [entry: string]: string | readonly string[];
  readonly id: string;
  readonly name: string;
}

/** `difficulties.dat` + `difficulties_str.dat`. */
export interface RawDifficulty {
  readonly id: string;
  readonly starting_cash: string;
  readonly starting_interest_rate: string;
  readonly labor_multiplier: string;
  readonly discover_multiplier: string;
  readonly suspicion_multiplier: string;
  readonly base_grace_multiplier: string;
  readonly grace_period_cpu: string;
  readonly old_difficulty_value: string;
  readonly tech?: RawStrings;
  readonly name: string;
}

/** `tasks.dat` + `tasks_str.dat`. `value` is mandatory for a `jobs` task only. */
export interface RawTask {
  readonly id: string;
  readonly type: string;
  readonly value?: string;
  readonly pre?: RawStrings;
  readonly name: string;
  readonly description: string;
}

/** `events.dat` + `events_str.dat`. */
export interface RawEvent {
  readonly id: string;
  readonly type: string;
  /** An instruction stack read left to right at trigger time, not a port Effect. */
  readonly effect: readonly string[];
  readonly chance: string;
  readonly unique?: string;
  readonly duration?: string;
  readonly description: string;
  readonly log_description: string;
}

/**
 * `regions.dat`. `load_regions` scans `modifier1`, `modifier2`, … and stops at the first
 * gap, so the field set is open-ended in exactly that one direction.
 */
export interface RawRegion {
  readonly [modifier: `modifier${number}`]: readonly string[];
  readonly id: string;
}

/** `locations.dat` + `locations_str.dat`. */
export interface RawLocation {
  readonly id: string;
  /** Two elements, or three with `absolute` first. */
  readonly position: readonly string[];
  readonly region?: RawStrings;
  readonly safety?: string;
  readonly modifier?: readonly string[];
  readonly pre?: RawStrings;
  readonly name: string;
  readonly hotkey: string;
  readonly cities?: RawStrings;
}

/** `techs.dat` + `techs_str.dat`. */
export interface RawTech {
  readonly id: string;
  readonly cost: readonly string[];
  readonly pre?: RawStrings;
  readonly effect?: readonly string[];
  readonly danger?: string;
  readonly name: string;
  readonly description: string;
  readonly result: string;
}

/** `itemtypes.dat` + `itemtypes_str.dat`. */
export interface RawItemType {
  readonly id: string;
  readonly is_extra: string;
  readonly text: string;
}

/** `items.dat` + `items_str.dat`. */
export interface RawItem {
  readonly id: string;
  readonly cost: readonly string[];
  readonly type: string;
  /** Name/value pairs, flattened: `["cpu", "1"]`. */
  readonly quality: readonly string[];
  readonly build?: RawStrings;
  readonly pre?: RawStrings;
  readonly name: string;
  readonly description: string;
}

/**
 * `bases.dat` + `bases_str.dat`.
 *
 * `danger` is declared because the Converter accepts it, and it is carried no further:
 * `BaseSpec.__init__` does not name it, and `create_from_data_file` passes only what the
 * constructor names, so upstream holds no such attribute for a base. Reproduced rather than
 * corrected — it is behaviour, and the pinned reference is the specification.
 */
export interface RawBase {
  readonly id: string;
  readonly size: string;
  readonly force_cpu?: string;
  readonly allowed: RawStrings;
  /** `group:chance`, one entry per group that can find this base type. */
  readonly detect_chance: readonly string[];
  readonly cost: readonly string[];
  readonly pre?: RawStrings;
  readonly danger?: string;
  readonly maint: readonly string[];
  readonly name: string;
  readonly description: string;
  readonly flavor: RawStrings;
}

/** One entry of `content/index.json`, which names every document the Converter writes. */
export interface RawIndexEntry {
  readonly name: string;
  readonly file: string;
  readonly sources: readonly string[];
  readonly literal: boolean;
  readonly count: number;
}

export interface RawIndexDocument {
  readonly files: readonly RawIndexEntry[];
}

/**
 * Every committed document, in `data.reload_all()`'s own load order — item types before the
 * items that name one, regions before the locations that name one.
 */
export interface RawContent {
  readonly index: RawIndexDocument;
  readonly internal_id: RawDocument<RawInternalId>;
  readonly dangers: RawDocument<RawDanger>;
  readonly numbers: RawNumbersDocument;
  readonly story: RawDocument<RawStorySection>;
  readonly warnings: RawWarningsDocument;
  readonly groups: RawDocument<RawGroup>;
  readonly knowledge: RawDocument<RawKnowledgeArea>;
  readonly difficulties: RawDocument<RawDifficulty>;
  readonly tasks: RawDocument<RawTask>;
  readonly events: RawDocument<RawEvent>;
  readonly regions: RawDocument<RawRegion>;
  readonly locations: RawDocument<RawLocation>;
  readonly techs: RawDocument<RawTech>;
  readonly itemtypes: RawDocument<RawItemType>;
  readonly items: RawDocument<RawItem>;
  readonly bases: RawDocument<RawBase>;
}
