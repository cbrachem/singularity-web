// boundary-intent simulation: a Scenario in, a Trace out, which is the port half of every comparison
import {
  advance,
  applyCommand,
  content,
  createInitialState,
  projectDerived,
  projectPersistent,
  toPlain,
  type Draw,
  type Effect,
  type PlainState,
  type SavedObject,
  type SimulationState,
} from "../../src/index.ts";
import type { ReferenceEffect } from "./oracle.ts";
import { isAdvance, stepKind, type Scenario, type ScenarioStep } from "./scenario.ts";

/**
 * The port's half of the trace seam: a Scenario goes in, a Trace comes out, one record per
 * step, in the shape `tools/trace/` produces from the reference.
 *
 * Nothing here reaches inside the Simulation. It creates a game, applies the script, and
 * records what the projection and the seam gave back — which is why a reshuffling of files
 * or names inside `sim/src` leaves it green and a changed order of draws or mutations does
 * not.
 */

export interface PortRecord {
  readonly step: number;
  readonly kind: string;
  readonly persistent: SavedObject;
  readonly derived: SavedObject;
  readonly effects: readonly ReferenceEffect[];
  readonly draws: readonly Draw[];
  /**
   * The state this step was applied to, and the step itself. Not part of the comparison —
   * it is what a divergence writes out, so the failing step replays on its own.
   */
  readonly input: PlainState;
  readonly applied: ScenarioStep;
}

/**
 * The four parts of a Trace record, on either side of the comparison. Everything else a
 * record carries is scaffolding and is not compared.
 */
export interface ComparableRecord {
  readonly persistent: unknown;
  readonly derived: unknown;
  readonly effects: unknown;
  readonly draws: unknown;
}

export function comparableParts(record: ComparableRecord): ComparableRecord {
  return {
    persistent: record.persistent,
    derived: record.derived,
    effects: record.effects,
    draws: record.draws,
  };
}

/**
 * An Effect, in the shape the reference's recorder writes its GUI calls in.
 *
 * The two vocabularies are not the same and are not meant to be: upstream reaches into a
 * screen, the port returns a record the Host drains. What has to line up is what
 * the two say *happened*, and this is where that mapping is written down — one case per
 * Effect kind, so a new kind is a deliberate edit here rather than a silent absence from
 * every trace.
 *
 * The mapping **resolves text**, and only in this direction. An Effect names the story
 * section or the game Event it is about, because text is Presentation; the
 * reference passes the rendered words to its screen. Looking the words up out of Content
 * here is what lets the two be compared without the Simulation ever producing a string.
 *
 * What this mapping may never do is *drop* an Effect. Where the two lists genuinely differ —
 * upstream's render invalidation, which a reactive Presentation has no counterpart for — the
 * reference's recorder filters it before it reaches a Trace, and the register that decides
 * what it filters is checked against this table.
 */
export function asReferenceEffect(effect: Effect): ReferenceEffect {
  switch (effect.kind) {
    case "autosave":
      return call("auto_save");
    case "pause":
      return call("find_speed_button");
    case "story":
      return call("show_story_section", storySection(effect.sectionId));
    case "eventTriggered":
      return call("show_message", eventDescription(effect.eventId));
    case "baseLost":
      return red("show_message", baseLostMessage(effect.baseName, effect.discoveredBy));
  }
}

function call(name: string, ...args: readonly unknown[]): ReferenceEffect {
  return { kind: "call", name, args, kwargs: {} };
}

/** `g.map_screen.show_message(..., color="red")` — the keyword upstream passes for a loss. */
function red(name: string, ...args: readonly unknown[]): ReferenceEffect {
  return { kind: "call", name, args, kwargs: { color: "red" } };
}

/**
 * `AbstractLogMessage.full_message` for the two loss entries (`logmessage.py:349,407`).
 *
 * The two format strings are the reference's own source rather than Content, so they are
 * written out here — this mapping is the one place text is resolved, and resolving it is
 * what lets the Simulation compare against a reference that renders words.
 */
function baseLostMessage(baseName: string, discoveredBy: string | null): string {
  if (discoveredBy === null) {
    return `The base ${baseName} has fallen into disrepair; I can no longer use it.`;
  }
  const spec = content.groups.byId.get(discoveredBy);
  if (!spec) throw new Error(`no such group: ${discoveredBy}`);
  return `My use of ${baseName} has been discovered. ${spec.discoverDesc}`;
}

/**
 * `show_story_section` takes the section's id, not its text — the reference's own screen
 * looks the words up afterwards. So this is an identity that still has to hold: an id the
 * Content does not carry would reach the reference's screen as a missing section.
 */
function storySection(sectionId: string): string {
  if (!content.story.byId.has(sectionId)) throw new Error(`no such story section: ${sectionId}`);
  return sectionId;
}

/** `Event.description` (`event.py:71`) — what `trigger_event` shows (`player.py:479`). */
function eventDescription(eventId: string): string {
  const spec = content.events.byId.get(eventId);
  if (!spec) throw new Error(`no such event: ${eventId}`);
  return spec.description;
}

const NO_EFFECTS: readonly Effect[] = Object.freeze([]);

/**
 * The State root after each Scenario step, and nothing else.
 *
 * What a Projection is computed from. A Trace record carries the *save schema*, which is a
 * projection of its own and cannot be handed back to a pure function over the State root —
 * so a comparison of a Projection replays the script for the roots rather than reading them
 * out of a Trace.
 */
export function replayStates(scenario: Scenario): readonly SimulationState[] {
  let state: SimulationState = createInitialState({
    seed: scenario.seed,
    difficulty: scenario.difficulty,
  });

  return scenario.script.map((step) => {
    state = isAdvance(step) ? advance(state, step.advanceBy).state : applyCommand(state, step);
    return state;
  });
}

/**
 * The port's Trace, which Scenario it ran and what the run seeded it from.
 *
 * The shape mirrors `ReferenceTrace`, and for the same reason: deviation 2's Normalisation
 * holds both streams to one seed, and it can only check that on what each side *says* it ran
 * with. Reading the port's seed back off the Scenario argument would be that argument
 * compared to itself, and a Trace of one game handed to a comparison of another would read
 * as a divergence at the first record rather than as the mistake it is.
 *
 * The seed does not name the game, though — several committed Scenarios carry the same one —
 * so the Trace says which Scenario it ran as well. That is what the comparison holds its
 * label to, and what the ledger records.
 */
export interface PortTrace {
  readonly records: readonly PortRecord[];
  /** The Scenario this run drove, taken where the run took its script from. */
  readonly scenario: string;
  /** What this run created the State root with, taken at the call that created it. */
  readonly seed: number;
}

export function recordTrace(scenario: Scenario): PortTrace {
  let draws: Draw[] = [];
  const ran = scenario.id;
  const seed = scenario.seed;
  let state: SimulationState = createInitialState({
    seed,
    difficulty: scenario.difficulty,
    observeDraws: (draw) => draws.push(draw),
  });

  const trace: PortRecord[] = [];
  scenario.script.forEach((step, index) => {
    const input = toPlain(state);
    // The two halves of the seam, and the whole of the difference between them: a Tick has
    // Effects to report, a Command has none (`sim/src/command.ts`).
    let effects: readonly Effect[] = NO_EFFECTS;
    if (isAdvance(step)) {
      const result = advance(state, step.advanceBy);
      state = result.state;
      effects = result.effects;
    } else {
      state = applyCommand(state, step);
    }
    trace.push({
      step: index,
      kind: stepKind(step),
      persistent: projectPersistent(state),
      derived: projectDerived(state),
      effects: effects.map(asReferenceEffect),
      // Creating the game draws before the first step, and those draws ride on the first
      // record — the first place they can go without inventing a step the Scenario has not
      // got. Dropping them would leave the order that moves the whole stream unbound.
      draws,
      input,
      applied: step,
    });
    draws = [];
  });
  return { records: trace, scenario: ran, seed };
}
