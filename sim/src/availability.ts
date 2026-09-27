/**
 * Whether a spec's prerequisites are met — `prerequisite.Prerequisite.available`
 * (`prerequisite.py:31`).
 *
 * The loader has already read the three forms out of the data (`content/types.ts`), so all
 * that is left here is the reading of them against the techs the player has finished.
 */

import type { Prerequisites } from "./content/types.ts";
import type { TechState } from "./state.ts";

export type FinishedTechs = ReadonlySet<string>;

export function finishedTechs(techs: readonly TechState[]): FinishedTechs {
  return new Set(techs.filter((tech) => tech.buyable.done).map((tech) => tech.specId));
}

export function isAvailable(prerequisites: Prerequisites, finished: FinishedTechs): boolean {
  switch (prerequisites.mode) {
    case "impossible":
      return false;
    case "any":
      return prerequisites.techs.some((techId) => finished.has(techId));
    case "all":
      return prerequisites.techs.every((techId) => finished.has(techId));
  }
}
