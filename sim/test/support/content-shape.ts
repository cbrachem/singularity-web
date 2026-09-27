// boundary-intent harness: translates a loaded Content into the shape the fixture is written in
/**
 * The shape `tools/oracle/content_vectors.py` records, and the projection of the port's
 * loaded Content into it.
 *
 * The fixture is written in *upstream's* field names, because it is upstream's own loaded
 * values — read off `g.locations`, `g.base_type` and the rest after `data.reload_all()`.
 * The port's Content is free to be shaped differently, so the
 * translation lives here, on the test's side of the seam, where it is one visible function
 * rather than a claim made twice.
 */

import type { Content, Prerequisites } from "../../src/content/types.ts";

export interface ReferenceRegion {
  readonly id: string;
  readonly modifiers_list: readonly Readonly<Record<string, number>>[];
  readonly locations: readonly string[];
}

export interface ReferenceLocation {
  readonly id: string;
  readonly absolute: boolean;
  readonly x: number;
  readonly y: number;
  readonly safety: number;
  readonly regions: readonly string[];
  readonly modifiers: Readonly<Record<string, number>>;
  readonly prerequisites: readonly string[];
  readonly name: string;
  readonly hotkey: string;
  readonly cities: readonly string[];
}

export interface ReferenceBase {
  readonly id: string;
  readonly size: number;
  readonly force_cpu: string | null;
  readonly regions: readonly string[];
  readonly region_all: boolean;
  readonly detect_chance: Readonly<Record<string, number>>;
  readonly cost: readonly number[];
  readonly maintenance: readonly number[];
  readonly prerequisites: readonly string[];
  readonly name: string;
  readonly description: string;
  readonly flavor: readonly string[];
}

export interface ReferenceItem {
  readonly id: string;
  readonly cost: readonly number[];
  readonly item_type: string;
  readonly qualities: Readonly<Record<string, number>>;
  readonly regions: readonly string[];
  readonly region_all: boolean;
  readonly prerequisites: readonly string[];
  readonly name: string;
  readonly description: string;
}

export interface ReferenceItemType {
  readonly id: string;
  readonly is_extra: boolean;
  readonly text: string;
}

export interface ReferenceTech {
  readonly id: string;
  readonly cost: readonly number[];
  readonly prerequisites: readonly string[];
  readonly danger: number;
  readonly effect_stack: readonly string[];
  readonly name: string;
  readonly description: string;
  readonly result: string;
}

export interface ReferenceEvent {
  readonly id: string;
  readonly event_type: string;
  readonly effect_stack: readonly string[];
  readonly chance: number;
  readonly duration: number | null;
  readonly unique: number;
  readonly description: string;
  readonly log_description: string;
}

export interface ReferenceTask {
  readonly id: string;
  readonly type: string;
  readonly value: number;
  readonly prerequisites: readonly string[];
  readonly name: string;
  readonly description: string;
}

export interface ReferenceDifficulty {
  readonly id: string;
  readonly starting_cash: number;
  readonly starting_interest_rate: number;
  readonly labor_multiplier: number;
  readonly discover_multiplier: number;
  readonly suspicion_multiplier: number;
  readonly base_grace_multiplier: number;
  readonly grace_period_cpu: number;
  readonly old_difficulty_value: number;
  readonly techs: readonly string[];
  readonly name: string;
}

export interface ReferenceGroup {
  readonly id: string;
  readonly suspicion_decay: number;
  readonly name: string;
  readonly discover_log: string;
  readonly discover_desc: string;
}

export interface ReferenceDanger {
  readonly level: number;
  readonly id: string;
  readonly research_desc: string;
  readonly knowledge_desc: string;
}

export interface ReferenceKnowledgeEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface ReferenceKnowledgeArea {
  readonly id: string;
  readonly name: string;
  readonly entries: readonly ReferenceKnowledgeEntry[];
}

export interface ReferenceWarning {
  readonly id: string;
  readonly name: string;
  readonly message: string;
}

export interface ReferenceStorySection {
  readonly id: string;
  readonly parts: readonly { readonly text: string; readonly translator_comments: string }[];
}

export interface ReferenceInternalIds {
  readonly forward: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly backward: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface ReferenceContent {
  readonly generatedBy: string;
  readonly python: string;
  readonly regions: readonly ReferenceRegion[];
  readonly locations: readonly ReferenceLocation[];
  readonly bases: readonly ReferenceBase[];
  readonly items: readonly ReferenceItem[];
  readonly itemTypes: readonly ReferenceItemType[];
  readonly techs: readonly ReferenceTech[];
  readonly events: readonly ReferenceEvent[];
  readonly tasks: readonly ReferenceTask[];
  readonly difficulties: readonly ReferenceDifficulty[];
  readonly groups: readonly ReferenceGroup[];
  readonly dangers: readonly ReferenceDanger[];
  readonly knowledge: readonly ReferenceKnowledgeArea[];
  readonly warnings: readonly ReferenceWarning[];
  readonly story: readonly ReferenceStorySection[];
  readonly internalIds: ReferenceInternalIds;
  readonly numbers: readonly number[];
}

/** What the fixture holds beside the loaded values, and is not compared against the port. */
export type ReferenceContentValues = Omit<ReferenceContent, "generatedBy" | "python">;

function table<T>(map: ReadonlyMap<string, T>): Record<string, T> {
  return Object.fromEntries(map);
}

/**
 * `Prerequisite.__init__` keeps the promoted list as it stood in the file, so the port's
 * three modes fold back into exactly the list upstream is holding.
 */
function asList(prerequisites: Prerequisites): readonly string[] {
  if (prerequisites.mode === "impossible") return ["impossible"];
  if (prerequisites.mode === "any") return ["OR", ...prerequisites.techs];
  return prerequisites.techs;
}

export function referenceShape(content: Content): ReferenceContentValues {
  return {
    regions: content.regions.all.map((region) => ({
      id: region.id,
      modifiers_list: region.modifiers.map(table),
      locations: region.locations,
    })),
    locations: content.locations.all.map((location) => ({
      id: location.id,
      absolute: location.absolute,
      x: location.x,
      y: location.y,
      safety: location.safety,
      regions: location.regions,
      modifiers: table(location.modifiers),
      prerequisites: asList(location.prerequisites),
      name: location.name,
      hotkey: location.hotkey,
      cities: location.cities,
    })),
    bases: content.bases.all.map((base) => ({
      id: base.id,
      size: base.size,
      force_cpu: base.forceCpu,
      regions: base.buildableIn.locations,
      region_all: base.buildableIn.anywhere,
      detect_chance: table(base.detectChance),
      cost: base.cost,
      maintenance: base.maintenance,
      prerequisites: asList(base.prerequisites),
      name: base.name,
      description: base.description,
      flavor: base.flavor,
    })),
    items: content.items.all.map((item) => ({
      id: item.id,
      cost: item.cost,
      item_type: item.itemType,
      qualities: table(item.qualities),
      regions: item.buildableIn.locations,
      region_all: item.buildableIn.anywhere,
      prerequisites: asList(item.prerequisites),
      name: item.name,
      description: item.description,
    })),
    itemTypes: content.itemTypes.all.map((itemType) => ({
      id: itemType.id,
      is_extra: itemType.isExtra,
      text: itemType.text,
    })),
    techs: content.techs.all.map((tech) => ({
      id: tech.id,
      cost: tech.cost,
      prerequisites: asList(tech.prerequisites),
      danger: tech.danger,
      effect_stack: tech.effectStack,
      name: tech.name,
      description: tech.description,
      result: tech.result,
    })),
    events: content.events.all.map((event) => ({
      id: event.id,
      event_type: event.eventType,
      effect_stack: event.effectStack,
      chance: event.chance,
      duration: event.duration,
      unique: event.unique,
      description: event.description,
      log_description: event.logDescription,
    })),
    tasks: content.tasks.all.map((task) => ({
      id: task.id,
      type: task.type,
      value: task.value,
      prerequisites: asList(task.prerequisites),
      name: task.name,
      description: task.description,
    })),
    difficulties: content.difficulties.all.map((difficulty) => ({
      id: difficulty.id,
      starting_cash: difficulty.startingCash,
      starting_interest_rate: difficulty.startingInterestRate,
      labor_multiplier: difficulty.laborMultiplier,
      discover_multiplier: difficulty.discoverMultiplier,
      suspicion_multiplier: difficulty.suspicionMultiplier,
      base_grace_multiplier: difficulty.baseGraceMultiplier,
      grace_period_cpu: difficulty.gracePeriodCpu,
      old_difficulty_value: difficulty.oldDifficultyValue,
      techs: difficulty.techs,
      name: difficulty.name,
    })),
    groups: content.groups.all.map((group) => ({
      id: group.id,
      suspicion_decay: group.suspicionDecay,
      name: group.name,
      discover_log: group.discoverLog,
      discover_desc: group.discoverDesc,
    })),
    dangers: content.dangers.all.map((danger) => ({
      level: danger.level,
      id: danger.id,
      research_desc: danger.researchDesc,
      knowledge_desc: danger.knowledgeDesc,
    })),
    knowledge: content.knowledge.all.map((area) => ({
      id: area.id,
      name: area.name,
      entries: area.entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
      })),
    })),
    warnings: content.warnings.all.map((warning) => ({
      id: warning.id,
      name: warning.name,
      message: warning.message,
    })),
    story: content.story.all.map((section) => ({
      id: section.id,
      parts: section.parts.map((part) => ({
        text: part.text,
        translator_comments: part.translatorComments,
      })),
    })),
    internalIds: {
      forward: Object.fromEntries(
        [...content.internalIds.forward].map(([type, entries]) => [type, table(entries)]),
      ),
      backward: Object.fromEntries(
        [...content.internalIds.backward].map(([type, entries]) => [type, table(entries)]),
      ),
    },
    numbers: content.numbers,
  };
}
