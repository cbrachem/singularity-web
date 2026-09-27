/**
 * A group that suspects the singularity: what its suspicion does to a detection chance, and
 * what a discovery does to its suspicion.
 *
 * Upstream files these as properties on `Group` (`group.py:42`). They live together here
 * because they move together and in a circle: a group's suspicion scales the chance it finds
 * a base, and finding one raises that suspicion — which is why detection is the phase that
 * accelerates once it starts.
 *
 * Nothing here derives the four-value danger level. That derivation reads exactly this
 * state, but it is Presentation's and never the Simulation's.
 */

import { content } from "./content/index.ts";
import { floorDiv } from "./pynum.ts";
import type { GroupState } from "./state.ts";

/**
 * `GroupSpec.discover_suspicion` (`group.py:36`): 1000 for every group. It is not in
 * `groups.dat` at all — the constructor writes it — so there is nothing for the Converter to
 * transcribe and it stays a rule rather than becoming Content.
 */
const DISCOVER_SUSPICION = 1000;

/** `Group.discover_bonus` (`group.py:88`). */
export function discoverBonus(group: GroupState): number {
  if (!group.activelyDiscovering) return 0;
  return Math.max(1, group.baseDiscoverBonus + group.changedDiscoverBonus);
}

/**
 * `Group.discover_suspicion` (`group.py:94`): what one discovery costs, the difficulty's
 * suspicion multiplier already in it.
 */
export function discoverSuspicion(group: GroupState): number {
  const scaled =
    DISCOVER_SUSPICION * (group.baseDiscoverSuspicion + group.changedDiscoverSuspicion);
  return Math.max(1, floorDiv(scaled, 10000));
}

/**
 * `Group.suspicion_decay` (`group.py:82`): the spec's rate, plus whatever an Event has done
 * to it, and never below 1.
 */
export function suspicionDecay(group: GroupState): number {
  const spec = content.groups.byId.get(group.specId);
  if (!spec) throw new Error(`no such group: ${group.specId}`);
  return Math.max(1, spec.suspicionDecay + group.changedSuspicionDecay);
}

/**
 * `Group.decay_rate` (`group.py:103`): how much suspicion a group sheds in a day. Quadratic
 * — a percentage of what it already suspects — with a floor of one basis point, so a group
 * that suspects nothing still decays by the floor rather than by nothing.
 *
 * The daily processing spends it (`advance.ts`, `new_day`) and the danger-level derivation
 * reads it (`app/src/ui/threat.ts`), which is why it is one function rather than two copies:
 * the detect-rate level is a statement about this number, and a Presentation that guessed at
 * it would rank the groups differently from the game that kills them.
 */
export function decayRate(group: GroupState): number {
  return Math.max(1, floorDiv(group.suspicion * suspicionDecay(group), 10000));
}

/** `Group.alter_suspicion` (`group.py:112`) — suspicion never goes below zero. */
export function alterSuspicion(group: GroupState, change: number): GroupState {
  return { ...group, suspicion: Math.max(group.suspicion + change, 0) };
}

/** `Group.discovered_a_base` (`group.py:124`). */
export function discoveredABase(group: GroupState): GroupState {
  return alterSuspicion(group, discoverSuspicion(group));
}
