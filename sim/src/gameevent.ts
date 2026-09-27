/**
 * Game Events: the once-per-tick roll that starts when the grace period ends, what firing one
 * does, and what expiring one undoes.
 *
 * `Player._check_event` (`player.py:452`), `Player.trigger_event` (`player.py:466`),
 * `Event.new_day` (`event.py:98`) and the instruction walker in `effect.py:38`.
 *
 * # Two words that collide, and the one that wins here
 *
 * The port reserves **Effect** for the record the Simulation hands the Host. Upstream's
 * `effect.Effect` is a different thing entirely: a stack of instructions a game Event applies
 * to the player — `["discover", "news", "-1000"]`. It is called an *event consequence* here
 * and `applyConsequence` is the walker, so neither name has to be qualified at its use site.
 *
 * A tech carries the same instruction stack and runs the same walker (`tech.py:81`), so the
 * three callers outside this file are the tick that finishes one (`./advance.ts`), the load
 * that replays one (`./restore.ts`) and the difficulty that grants one (`./newgame.ts`).
 *
 * # Order is contract
 *
 * The roll walks `content.events.all` — the parse order of `events.dat` — skips the ones
 * already triggered, and **returns on the first hit**. So the order decides which Event fires
 * and, once one is triggered and skipped, how many draws the check consumes; both move every
 * later draw in the game.
 */

import { SECONDS_PER_DAY } from "./clock.ts";
import { content } from "./content/index.ts";
import type { GameEvent } from "./content/types.ts";
import { rollInterval } from "./chance.ts";
import { PAUSE, eventTriggeredEffect, storyEffect, type Effect } from "./effect.ts";
import { alterSuspicion } from "./group.ts";
import {
  DISPLAY_DISCOVER,
  appendLog,
  type DisplayDiscover,
  type GameEventState,
  type GroupState,
  type SimulationState,
} from "./state.ts";

export interface EventResult {
  readonly state: SimulationState;
  readonly effects: readonly Effect[];
}

const NO_EFFECTS: readonly Effect[] = Object.freeze([]);

/** The story section the tick that wins the game asks the Host to show (`effect.py:65`). */
export const WIN = "Win";

/** The log kind `LogEmittedEvent` serializes itself as (`logmessage.py:179`). */
export const EVENT_EMITTED = "event-emitted";

/**
 * `Player._check_event` (`player.py:452`), rolled with the tick's *requested* seconds.
 *
 * Upstream passes `give_time`'s own argument here rather than the seconds the tick actually
 * advanced, so a tick that was cut short at midnight still rolls against the interval that
 * was asked for. The rule is kept because it is upstream's; the browser scheduler never
 * produces a tick that reaches it, and only a Scenario advancing across a day boundary can.
 */
export function checkEvents(state: SimulationState, requestedSeconds: number): EventResult {
  for (const spec of content.events.all) {
    if (triggeredState(state, spec.id) !== undefined) continue;
    if (rollInterval(state.rng, spec.chance / 10000, requestedSeconds)) {
      // One at a time: upstream returns on the first hit rather than rolling the rest.
      return triggerEvent(state, spec);
    }
  }
  return { state, effects: NO_EFFECTS };
}

/** The Event's record, when it exists and is currently triggered. */
function triggeredState(state: SimulationState, eventId: string): GameEventState | undefined {
  const found = state.events.find((candidate) => candidate.specId === eventId);
  return found && found.triggered !== 0 ? found : undefined;
}

/**
 * `Player.trigger_event` (`player.py:466`) together with `Event.trigger` (`event.py:149`).
 *
 * An Event's record is created the first time it fires and kept afterwards, which is why the
 * order of `state.events` is the order Events first fired rather than Content order — and the
 * save schema writes it out in exactly that order.
 */
export function triggerEvent(state: SimulationState, spec: GameEvent): EventResult {
  const existing = state.events.find((candidate) => candidate.specId === spec.id);
  if (existing && existing.triggered !== 0) return { state, effects: NO_EFFECTS };

  const triggered: GameEventState = {
    specId: spec.id,
    triggered: 1,
    triggeredAt: state.gameTime,
  };
  let next: SimulationState = {
    ...state,
    events: existing
      ? state.events.map((candidate) => (candidate.specId === spec.id ? triggered : candidate))
      : [...state.events, triggered],
  };

  // The consequence runs inside `Event.trigger`, so whatever it has to say is said before
  // the pause and the notification that report the Event itself (`player.py:475`).
  const applied = applyConsequence(next, spec.effectStack, 1);
  next = {
    ...applied.state,
    log: appendLog(applied.state.log, [
      { kind: EVENT_EMITTED, rawEmitTime: applied.state.gameTime, fields: { event_id: spec.id } },
    ]),
  };

  return { state: next, effects: [...applied.effects, PAUSE, eventTriggeredEffect(spec.id)] };
}

/**
 * `Event.new_day` (`event.py:98`), run for every triggered Event at midnight.
 *
 * Only an Event with a duration expires; a unique one stays triggered for the rest of the
 * game. Expiry undoes the consequence and clears the record, so a non-unique Event can be
 * rolled — and fire — again.
 */
export function expireEvents(state: SimulationState): SimulationState {
  let next = state;
  for (const event of state.events) {
    if (event.triggered === 0) continue;
    const spec = eventSpec(event.specId);
    if (spec.duration === null) continue;
    if (next.gameTime - event.triggeredAt <= spec.duration * SECONDS_PER_DAY) continue;

    // An undo says nothing: every instruction that emits is one-shot and refuses at -1.
    next = applyConsequence(next, spec.effectStack, -1).state;
    next = {
      ...next,
      events: next.events.map((candidate) =>
        candidate.specId === event.specId
          ? { ...candidate, triggered: 0, triggeredAt: -1 }
          : candidate,
      ),
    };
  }
  return next;
}

function eventSpec(eventId: string): GameEvent {
  const spec = content.events.byId.get(eventId);
  if (!spec) throw new Error(`no such event: ${eventId}`);
  return spec;
}

/**
 * `Effect._apply_effect` (`effect.py:38`): the instruction stack a game Event carries, walked
 * once forward, with `modifier` at `1` to apply it and `-1` to undo it.
 *
 * Undoing by multiplying by -1 is upstream's own trick and it is why an instruction that
 * cannot be reversed — a one-shot — refuses instead. Upstream asserts; the port throws, for
 * the same reason and at the same three instructions.
 *
 * `loadingSave` is upstream's `loading_savegame` (`effect.py:38`), and it changes exactly two
 * instructions: a one-time suspicion reduction is already *in* the suspicion a Save carries,
 * so re-applying it while restoring one would pay it twice, and a game that was already won
 * is not won again while it is being read back. Everything else is re-applied, because a
 * triggered Event's standing consequences are not persisted at all.
 *
 * One instruction has something to tell the Host, which is why this returns Effects rather
 * than only a State root. They are the caller's to place: a consequence runs where the rule
 * that carries it runs — inside `Event.trigger`, inside `Tech.finish` — and not at the end of
 * the Tick.
 */
export function applyConsequence(
  state: SimulationState,
  stack: readonly string[],
  modifier: 1 | -1,
  loadingSave = false,
): EventResult {
  const effects: Effect[] = [];
  let next = state;
  let at = 0;
  const take = (): string => {
    const value = stack[at];
    if (value === undefined) {
      throw new Error(`event consequence ends mid-instruction: ${stack.join(" ")}`);
    }
    at += 1;
    return value;
  };
  const amount = (): number => modifier * integer(take());
  const oneShot = (instruction: string): void => {
    if (modifier === -1) throw new Error(`${instruction} is one-shot and cannot be undone`);
  };

  while (at < stack.length) {
    const instruction = take();
    switch (instruction) {
      case "interest":
        next = { ...next, interestRate: next.interestRate + amount() };
        break;
      case "income":
        next = { ...next, income: next.income + amount() };
        break;
      case "cost_labor":
        next = { ...next, laborBonus: next.laborBonus - amount() };
        break;
      case "job_profit":
        next = { ...next, jobBonus: next.jobBonus + amount() };
        break;
      case "display_discover":
        oneShot(instruction);
        next = { ...next, displayDiscover: displayDiscover(take()) };
        break;
      // Winning (`effect.py:59`). The music is out of scope and the story section is a
      // request rather than a call, so what is left in the rules is three assignments: no
      // group looks for bases any more, maintenance stops being owed, and the grace period
      // becomes permanent — `in_grace_period` returns on `apotheosis` before it reads the
      // latch, and `had_grace` is set all the same because a Save carries it.
      //
      // Restoring a Save re-applies this like every other finished tech, and the one thing it
      // must not do again is tell the Host the game was just won.
      case "endgame":
        oneShot(instruction);
        if (!loadingSave) effects.push(storyEffect(WIN));
        next = mapGroups(next, (group) => ({ ...group, activelyDiscovering: false }));
        next = { ...next, apotheosis: true, hadGrace: true };
        break;
      case "suspicion": {
        const who = take();
        const value = amount();
        if (who === "onetime") {
          oneShot(instruction);
          if (!loadingSave) next = mapGroups(next, (group) => alterSuspicion(group, -value));
          break;
        }
        next = mapGroup(next, who, (group) => ({
          ...group,
          changedSuspicionDecay: group.changedSuspicionDecay + value,
        }));
        break;
      }
      case "discover": {
        const who = take();
        const value = amount();
        next = mapGroup(next, who, (group) => ({
          ...group,
          changedDiscoverBonus: group.changedDiscoverBonus - value,
        }));
        break;
      }
      default:
        throw new Error(`unknown event consequence: ${instruction}`);
    }
  }
  return { state: next, effects: effects.length === 0 ? NO_EFFECTS : effects };
}

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed))
    throw new Error(`event consequence wants a whole number: ${value}`);
  return parsed;
}

function displayDiscover(value: string): DisplayDiscover {
  const known = DISPLAY_DISCOVER.find((candidate) => candidate === value);
  if (known === undefined) throw new Error(`unknown display_discover level: ${value}`);
  return known;
}

function mapGroups(
  state: SimulationState,
  change: (group: GroupState) => GroupState,
): SimulationState {
  return { ...state, groups: state.groups.map(change) };
}

function mapGroup(
  state: SimulationState,
  groupId: string,
  change: (group: GroupState) => GroupState,
): SimulationState {
  if (!state.groups.some((group) => group.specId === groupId)) {
    throw new Error(`unknown group in an event consequence: ${groupId}`);
  }
  return mapGroups(state, (group) => (group.specId === groupId ? change(group) : group));
}
