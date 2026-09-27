/**
 * An Effect is a serializable, tagged record the Simulation returns to say something
 * happened that the Host may act on — a notification, a pause request, an autosave
 * request. Ordered, part of the Trace, and never a callback.
 *
 * The kinds arrive with the rules that emit them. An empty game inside the grace period
 * reaches exactly one of them; losing the grace period reaches three more, and the first
 * base the game takes away reaches the fifth.
 *
 * # What an Effect carries, and what it does not
 *
 * Identifiers, never display strings: **text is presentation**, so a
 * notification names the story section or the game Event it is about and the Host resolves
 * the words. That is also what keeps the union comparable against the reference, whose
 * recorder captures the *rendered* argument — the mapping between the two vocabularies is
 * written down once, in `sim/test/support/trace.ts`.
 *
 * # What is deliberately not here
 *
 * Render invalidation. Upstream sets `g.map_screen.needs_rebuild` to say "the displayed
 * state moved"; a reactive Presentation has no such concept, so the port neither has nor can
 * have a counterpart. It is filtered out of the compared surface by the reference's own
 * recorder rather than by anything here.
 */

/**
 * The Simulation has reached a point at which the game should be saved.
 *
 * Upstream writes the file from inside `new_day` (`player.py:576`), mid-tick and before the
 * tick's final `recalc_cpu`. The port cannot: browser storage is asynchronous and the
 * Simulation may not call out. So the request is emitted at the end of the tick
 * and the Host drains it afterwards — the third entry in the deviation register, and the one
 * a Normalisation cancels in the Trace.
 */
export interface AutosaveEffect {
  readonly kind: "autosave";
}

/**
 * `Player.pause_game` (`player.py:580`), minus the assignment.
 *
 * Upstream sets `g.curr_speed = 0` and then tells the speed control to catch up. Speed is
 * never persisted and is forced to 0 on load, so it was never Simulation state:
 * the port asks, and the Host decides. A pause is therefore a **request**, and the fact that
 * the grace transition makes one is observable only here.
 */
export interface PauseEffect {
  readonly kind: "pause";
}

/**
 * `g.map_screen.show_story_section(id)` — a story section the Host should show, named by its
 * Content id. The grace warning is the first one a game reaches.
 */
export interface StoryEffect {
  readonly kind: "story";
  readonly sectionId: string;
}

/**
 * A game Event fired. Named for the Event rather than for the message, because the message
 * is the Event's `description` and resolving it is Presentation's job.
 */
export interface EventTriggeredEffect {
  readonly kind: "eventTriggered";
  readonly eventId: string;
}

/**
 * A base is gone — found by a group, or left standing in disrepair nobody paid for.
 *
 * `Player.remove_bases` (`player.py:585`) shows the loss as a red message naming the base
 * and, when a group found it, what that group has to say about it. Both halves are named
 * here rather than rendered: the words are Presentation's, and the group's are in
 * Content under its id.
 *
 * The base's *name* is the exception that proves the rule. It is not a display string the
 * Simulation invented — it is state the player chose — and by the time the Host drains this
 * the base is gone, so nothing could look it up again. Where it stood is here for the same
 * reason: the Host marks the location on the map, and the base it would have asked is gone.
 */
export interface BaseLostEffect {
  readonly kind: "baseLost";
  readonly baseName: string;
  /** The location the base stood in, by its Content id. */
  readonly locationId: string;
  /** The group that found it, or `null` when unpaid maintenance is what killed it. */
  readonly discoveredBy: string | null;
}

export type Effect =
  | AutosaveEffect
  | PauseEffect
  | StoryEffect
  | EventTriggeredEffect
  | BaseLostEffect;

export const AUTOSAVE: Effect = Object.freeze({ kind: "autosave" });
export const PAUSE: Effect = Object.freeze({ kind: "pause" });

export function storyEffect(sectionId: string): Effect {
  return Object.freeze({ kind: "story", sectionId });
}

export function eventTriggeredEffect(eventId: string): Effect {
  return Object.freeze({ kind: "eventTriggered", eventId });
}

export function baseLostEffect(
  baseName: string,
  locationId: string,
  discoveredBy: string | null,
): Effect {
  return Object.freeze({ kind: "baseLost", baseName, locationId, discoveredBy });
}
