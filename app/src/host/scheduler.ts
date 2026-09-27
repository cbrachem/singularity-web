/**
 * The driver: wall-clock frames in, grid-anchored Ticks out.
 *
 * ```
 * onFrame(dt):
 *   if speed == 0: return
 *   acc += min(dt, DT_MAX) * speed
 *   ceiling = DT_MAX * speed + QUANTUM[speed]
 *   acc = min(acc, speed == rate the bank was taken in at ? 2 * ceiling : ceiling)
 *   for step in tickPartition(gameTime, speed, acc):
 *     tick(step)                                       # a stopped clock ends the frame here
 *   if any tick ran: render()                          # once, however many ticks ran
 * ```
 *
 * The partition itself is in `tick-partition.ts` and has no state; everything mutable is
 * here, and it is two values: the accumulator and the Speed setting. The driver does not
 * re-derive the partition — it asks the clock once and hands `tickPartition` what it owes,
 * which is the whole point of a partition that is a closed-form function of `(game time,
 * Speed)`.
 */

import type { PauseEffect } from "@singularity/sim";

import { quantumFor, tickPartition, type Speed } from "./tick-partition.ts";
import { MAX_FRAME_SECONDS, createTickAccumulator, type TickAccumulator } from "./time.ts";

/**
 * An Effect as the driver reads it.
 *
 * The kinds are the Simulation's (`sim/src/effect.ts`) and the driver acts on exactly one of
 * them, so it reads the tag and carries none of the union: the Simulation owns the
 * vocabulary, and a kind arriving there is not a change here.
 */
export interface TaggedEffect {
  readonly kind: string;
}

/**
 * The Effect kind that asks the Host to stop the clock — `Player.pause_game` (`player.py:580`)
 * minus the assignment, because the Speed is the Host's and never the Simulation's.
 *
 * The spelling is the Simulation's, and the annotation is what says so: `PauseEffect` declares
 * the kind, so renaming it there stops this assignment typechecking instead of quietly leaving
 * the driver watching for a kind nobody emits any more. The type is erased, so nothing of the
 * Simulation reaches the bundle here — the driver still knows the one kind it acts on and none
 * of the rest of the union.
 */
export const PAUSE_REQUEST: PauseEffect["kind"] = "pause";

/**
 * Whatever the frames are driving. The Host implements it over the Simulation; a test
 * implements it over a list.
 */
export interface SchedulerTarget {
  /** Absolute game time, in game-seconds. The grid is measured against it. */
  readonly gameTime: number;
  /**
   * Runs exactly one Tick and returns its Effects, already drained. The driver reads them
   * for one thing only: a pause request, which is the Simulation asking it to stop.
   */
  tick(gameSeconds: number): readonly TaggedEffect[];
}

/**
 * The Speed setting, as a cell the driver shares with whoever offers it to the player. A
 * `signal<Speed>` satisfies it, and so does `{ value: 60 }` — the driver has no opinion,
 * because a pause is the one thing it writes and Presentation is the only thing that reads.
 */
export interface SpeedSetting {
  value: Speed;
}

export interface SchedulerOptions {
  readonly target: SchedulerTarget;
  readonly speed: SpeedSetting;
  /** Called exactly once per frame that ticked, after the last of its ticks. */
  readonly render: () => void;
}

export interface Scheduler {
  /** One frame. `realSeconds` is wall-clock time since the previous one. */
  frame(realSeconds: number): void;
}

/**
 * What the accumulator may hold at a given Speed: one clamped frame's intake, plus the Tick
 * that intake could not finish.
 *
 * That is exactly the bound steady play produces — a drained accumulator holds less than one
 * quantum, and a frame adds at most `DT_MAX × speed` — so the ceiling is invisible while the
 * Speed stays put. It bites in one place: a Speed *decrease* with a loaded accumulator, where
 * the game seconds banked at the old rate would otherwise buy a burst of ticks at the new one
 * — 13,968 of them for a single frame, dropping from top speed to speed 1. The ceiling makes
 * the frame after a Speed change worth no more than any other frame, which is what "the clamp
 * is the only degradation" has to mean if a rate change is not to be a second one.
 */
function ceilingFor(speed: Speed): number {
  return MAX_FRAME_SECONDS * speed + quantumFor(speed);
}

/**
 * What the accumulator may hold at an unchanged Speed: the ceiling, and one stop's carry on
 * top of it.
 *
 * A stopped frame leaves its unrun Ticks owed and nothing spends them until a frame runs
 * unbroken, so a *run* of stops added up without a bound and the first unbroken frame paid
 * the whole sum out as one burst. Fifty rounds banked a hundred Ticks for one frame.
 *
 * **A run of stops is what grows the bank, and only below 30 frames a second.** A round adds
 * its frame's intake and spends the one Tick that paused it, so it grows by
 * `min(dt, DT_MAX) × speed − QUANTUM[speed]` — and every quantum but Speed 1's is
 * `speed / 30`, upstream's own frame rate (`tick-partition.ts`). Above 30 fps a round
 * therefore *shrinks* the bank, and Speed 1 cannot grow it at any rate, its quantum being a
 * whole second against a clamped frame's tenth. Below 30 fps a round adds at most two quanta,
 * and each round costs a player resume that the very next Tick pauses again.
 *
 * So the bound is not what makes a stop survivable — a player cannot drift into this. It is
 * that a burst of Ticks in one frame is the shape the clamp forbids for a rate change, and
 * leaving it reachable by another road says the rule means less than it does.
 *
 * Twice the ceiling is where it is drawn because one stop and two stops then carry everything
 * they owe: a broken frame leaves under three quanta, a resume adds three more, and the pair
 * fits under eight. The rate-change rule is untouched, and a third consecutive stop is the first
 * that loses a second — game time a run of stops was never going to spend at a playable rate
 * anyway.
 */
function bankCeilingFor(speed: Speed): number {
  return 2 * ceilingFor(speed);
}

export function createScheduler({ target, speed, render }: SchedulerOptions): Scheduler {
  const accumulator: TickAccumulator = createTickAccumulator();
  // The Speed the accumulator's contents were taken in at, which is what makes them worth a
  // number of Ticks. It is not the Speed setting: a stop writes 0 to the setting, and the
  // seconds a stopped frame left owed are still worth what they were taken in at. 0 while the
  // accumulator has never been filled, where the ceiling below has nothing to clip anyway.
  let bankedAt: Speed = 0;

  return {
    frame(realSeconds) {
      // Speed 0 does not tick, and there is nothing new to show either. The accumulator is
      // left exactly as it was: its contents are game seconds, so they are still worth the
      // same when the player starts the clock again — and the ceiling above is applied on
      // the frame that starts it, at the Speed it is started at.
      const setting = speed.value;
      if (setting === 0) return;

      accumulator.add(realSeconds, setting);
      // **The ceiling answers a rate change and nothing else.** Game seconds are
      // rate-independent only while the rate does not change, so the bank is revalued exactly
      // when the Speed that will spend it is not the Speed that took it in. Applying it every
      // frame instead reads the same in steady play — a drained accumulator holds less than a
      // quantum, so the ceiling has nothing to clip — but not after a stop: a stopped frame
      // leaves its unrun Ticks owed, and the resume frame's own intake on top of
      // them exceeds the ceiling by exactly the seconds the stop left behind. Those were owed
      // at this very Speed; clipping them makes the stop cost the player game time, which is
      // the one thing the clamp is supposed to be alone in doing. What the wider ceiling above
      // bounds is a *run* of stops, which is a different question and answered at a different
      // height.
      accumulator.capTo(setting === bankedAt ? bankCeilingFor(setting) : ceilingFor(setting));
      bankedAt = setting;

      // The clock is read once. Every step below is affordable by construction: the partition
      // is the whole Ticks the accumulator can pay for, and what it cannot pay for stays owed.
      const ticks = tickPartition(target.gameTime, setting, accumulator.owed);
      for (const step of ticks) {
        accumulator.spend(step);
        // The Simulation declared this moment blocking. The driver owns the Speed, so the
        // request becomes a write to the cell — and the rule below does the rest.
        if (pausedBy(target.tick(step))) speed.value = 0;
        // **A stopped clock ends the frame, whatever stopped it.** Two things
        // stop it mid-frame and they arrive differently: the pause request comes back with the
        // Tick's Effects, and the Host's stop for a game that has just been lost is written by
        // a drain the driver never sees (`session.ts`). They mean the same thing — no more game
        // time until the player has looked — so there is one rule and it reads one cell. The
        // driver could not narrow it to the loss anyway without being handed a second channel
        // it has no business owning. The remaining ticks are not run and their game
        // seconds stay owed.
        if (speed.value === 0) break;
      }

      // A frame that ran no tick produced no new State root, and re-publishing the old one is
      // Presentation's dedupe covering for the driver rather than the driver keeping its word.
      // At Speed 1 that is 59 frames in every 60.
      if (ticks.length > 0) render();
    },
  };
}

function pausedBy(effects: readonly TaggedEffect[]): boolean {
  return effects.some((effect) => effect.kind === PAUSE_REQUEST);
}
