/**
 * The one place `sim/` reaches out of its own package, and the CI check that the committed
 * Converter output still says what the port's types say it says.
 *
 * `content/` is a top-level directory beside `sim/` and the
 * loader lives here, so this module imports across a package boundary that
 * `sim/test/support/source-rules.ts` otherwise forbids outright. The allowance is named
 * there — `content/*.json` and nothing else.
 *
 * Assigning the imports to `RawContent` is what makes `tsc -b` read every committed document
 * and fail when one stops matching the hand-written types. It costs nothing at play time:
 * the check is the compiler's, and no validator ships.
 *
 * One import per file, spelled out, because a bundler resolves a static specifier and not a
 * computed one. `sim/test/content.trace.test.ts` asserts this list is exactly what
 * `content/index.json` names, so a document added by a future reference bump cannot arrive
 * unnoticed.
 */

import bases from "../../../content/bases.json";
import dangers from "../../../content/dangers.json";
import difficulties from "../../../content/difficulties.json";
import events from "../../../content/events.json";
import groups from "../../../content/groups.json";
import index from "../../../content/index.json";
import internalId from "../../../content/internal_id.json";
import itemtypes from "../../../content/itemtypes.json";
import items from "../../../content/items.json";
import knowledge from "../../../content/knowledge.json";
import locations from "../../../content/locations.json";
import numbers from "../../../content/numbers.json";
import regions from "../../../content/regions.json";
import story from "../../../content/story.json";
import tasks from "../../../content/tasks.json";
import techs from "../../../content/techs.json";
import warnings from "../../../content/warnings.json";

import type { RawContent } from "./raw.ts";

export const rawContent: RawContent = {
  index,
  internal_id: internalId,
  dangers,
  numbers,
  story,
  warnings,
  groups,
  knowledge,
  difficulties,
  tasks,
  events,
  regions,
  locations,
  techs,
  itemtypes,
  items,
  bases,
};
