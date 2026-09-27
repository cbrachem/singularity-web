/**
 * Content as the Simulation's rules see it: every reference resolved, every number parsed,
 * every collection still in the order the `.dat` file had it.
 *
 * The shape is the port's own. The port is bound to upstream's *behaviour*
 * rather than its class layout, so nothing here mirrors a Python class; what is carried over
 * unchanged is the set of values and — the part that is contract — their order.
 */

/** `[cash, cpu, labor]`, as `buyable.spec_parse_cost` parses it. */
export type Cost = readonly [cash: number, cpu: number, labor: number];

/**
 * A location or region bonus table — `cpu`, `stealth`, `thrift`, `speed` — keyed by the
 * lower-cased name, with the `6/5` form already divided out.
 */
export type Modifiers = ReadonlyMap<string, number>;

/**
 * A collection in `.dat` parse order, plus the id map built from it.
 *
 * Both halves matter. Collection ordering is contract because event checking
 * rolls per event and returns on the first hit, so the order decides which event fires and
 * how many draws are consumed — and therefore the whole later RNG stream. The map is built
 * *from* the array for the same reason: an object literal's key order is a guarantee too
 * subtle to rest a contract on.
 */
export interface Catalogue<T> {
  readonly all: readonly T[];
  readonly byId: ReadonlyMap<string, T>;
}

/**
 * What a spec needs before it becomes available, as `prerequisite.Prerequisite` reads it: a
 * plain list is an AND, a list led by `OR` is an OR, and the single entry `impossible` is
 * never satisfied. An empty `all` is satisfied from the start.
 */
export type Prerequisites =
  | { readonly mode: "all"; readonly techs: readonly string[] }
  | { readonly mode: "any"; readonly techs: readonly string[] }
  | { readonly mode: "impossible" };

/**
 * Where a base type or an item may be built, after `BuyableSpec.regions` has replaced every
 * region id with that region's locations.
 */
export interface BuildableIn {
  /** Upstream's `_region_all`, which `ALL` anywhere in the list sets. */
  readonly anywhere: boolean;
  /** Upstream's `_regions`: location ids, in expansion order. Empty when `anywhere`. */
  readonly locations: readonly string[];
}

export interface Region {
  readonly id: string;
  /** `modifier1`, `modifier2`, … in source order. `Region` assigns one per Location by index. */
  readonly modifiers: readonly Modifiers[];
  /**
   * The locations that name this region, in location source order. Contract: upstream
   * shuffles a list of indices against exactly this list when a game starts.
   */
  readonly locations: readonly string[];
}

export interface Location {
  readonly id: string;
  /** Whether the position is placed against the screen rather than against the map. */
  readonly absolute: boolean;
  /** `int(x) / -100`, as `location.position_data_parser` computes it. */
  readonly x: number;
  readonly y: number;
  readonly safety: number;
  readonly regions: readonly string[];
  readonly modifiers: Modifiers;
  readonly prerequisites: Prerequisites;
  readonly name: string;
  readonly hotkey: string;
  /** Drawn from when the Simulation names a base, so the order is part of the draw log. */
  readonly cities: readonly string[];
}

export interface BaseType {
  readonly id: string;
  readonly size: number;
  /** The one CPU this base type is stuck with, or null when it may hold any. */
  readonly forceCpu: string | null;
  readonly buildableIn: BuildableIn;
  /** `group:chance`, keyed by group id exactly as written. */
  readonly detectChance: ReadonlyMap<string, number>;
  readonly cost: Cost;
  readonly maintenance: Cost;
  readonly prerequisites: Prerequisites;
  readonly name: string;
  readonly description: string;
  /** Drawn from when the Simulation names a base. */
  readonly flavor: readonly string[];
}

export interface ItemType {
  readonly id: string;
  readonly isExtra: boolean;
  /** Still carrying its `&` hotkey marker, which is Presentation's to read. */
  readonly text: string;
}

export interface Item {
  readonly id: string;
  readonly cost: Cost;
  readonly itemType: string;
  readonly qualities: ReadonlyMap<string, number>;
  readonly buildableIn: BuildableIn;
  readonly prerequisites: Prerequisites;
  readonly name: string;
  readonly description: string;
}

export interface Tech {
  readonly id: string;
  readonly cost: Cost;
  readonly prerequisites: Prerequisites;
  readonly danger: number;
  /**
   * Upstream's `Effect.effect_stack` — an instruction list read left to right when the tech
   * finishes. Deliberately not called an Effect: the port reserves that word for what
   * the Simulation hands the Host.
   */
  readonly effectStack: readonly string[];
  readonly name: string;
  readonly description: string;
  readonly result: string;
}

/** A game event. Named `GameEvent` so it never reads as the port's Effect. */
export interface GameEvent {
  readonly id: string;
  readonly eventType: string;
  readonly effectStack: readonly string[];
  readonly chance: number;
  /** Days the event lasts, or null when it does not expire. */
  readonly duration: number | null;
  readonly unique: number;
  readonly description: string;
  readonly logDescription: string;
}

export interface Task {
  readonly id: string;
  readonly type: string;
  readonly value: number;
  readonly prerequisites: Prerequisites;
  readonly name: string;
  readonly description: string;
}

export interface Difficulty {
  readonly id: string;
  readonly startingCash: number;
  readonly startingInterestRate: number;
  readonly laborMultiplier: number;
  readonly discoverMultiplier: number;
  readonly suspicionMultiplier: number;
  readonly baseGraceMultiplier: number;
  readonly gracePeriodCpu: number;
  readonly oldDifficultyValue: number;
  readonly techs: readonly string[];
  readonly name: string;
}

export interface Group {
  readonly id: string;
  readonly suspicionDecay: number;
  readonly name: string;
  readonly discoverLog: string;
  readonly discoverDesc: string;
}

export interface Danger {
  readonly id: string;
  /** Read off the id, which upstream writes as `danger_N`. */
  readonly level: number;
  readonly researchDesc: string;
  readonly knowledgeDesc: string;
}

export interface KnowledgeEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface KnowledgeArea {
  readonly id: string;
  readonly name: string;
  readonly entries: readonly KnowledgeEntry[];
}

export interface Warning {
  readonly id: string;
  readonly name: string;
  readonly message: string;
}

export interface StoryPart {
  readonly text: string;
  readonly translatorComments: string;
}

export interface StorySection {
  readonly id: string;
  readonly parts: readonly StoryPart[];
}

/**
 * The identity that survives renaming, and the input to the Save format rather than to the
 * rules: object type -> human id -> `0xNNNN`, and back.
 *
 * `forward` is not injective and `backward` is not its inverse. An object that was renamed
 * keeps an entry under its old name pointing at the same internal id, so that an id written
 * before the rename still resolves; `backward` answers with the name that survived.
 * Read `backward` for that direction — never search `forward`.
 */
export interface InternalIds {
  readonly forward: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly backward: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** Every object type, resolved. Fifteen of them, plus the plain list of numbers. */
export interface Content {
  readonly regions: Catalogue<Region>;
  readonly locations: Catalogue<Location>;
  readonly bases: Catalogue<BaseType>;
  readonly items: Catalogue<Item>;
  readonly itemTypes: Catalogue<ItemType>;
  readonly techs: Catalogue<Tech>;
  readonly events: Catalogue<GameEvent>;
  readonly tasks: Catalogue<Task>;
  readonly difficulties: Catalogue<Difficulty>;
  readonly groups: Catalogue<Group>;
  readonly dangers: Catalogue<Danger>;
  readonly knowledge: Catalogue<KnowledgeArea>;
  readonly warnings: Catalogue<Warning>;
  readonly story: Catalogue<StorySection>;
  readonly internalIds: InternalIds;
  readonly numbers: readonly number[];
}
