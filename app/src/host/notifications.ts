import { signal, type ReadonlySignal } from "@preact/signals";
import {
  TECH_RESEARCHED,
  WIN,
  type Effect,
  type LogEntry,
  type SimulationState,
} from "@singularity/sim";

export type Notification =
  | { readonly kind: "story"; readonly sectionId: string }
  | { readonly kind: "event"; readonly eventId: string }
  | {
      readonly kind: "baseLostDiscovered";
      readonly baseName: string;
      readonly groupId: string;
      readonly locationId: string;
    }
  | {
      readonly kind: "baseLostMaintenance";
      readonly baseName: string;
      readonly locationId: string;
    }
  | { readonly kind: "techResearched"; readonly techId: string };

export interface Notifications {
  readonly current: ReadonlySignal<Notification | null>;
  drain(effects: readonly Effect[], state: SimulationState): void;
  dismiss(): void;
}

/** The story section a new game opens with (`screens/map.py:738`). */
export const INTRO = "Intro";

/**
 * @param initial The state the game starts from, so that a loaded game does not announce
 *   everything that already happened in it. Only what is appended *after* this is news.
 * @param opening What is on screen before the first tick, such as the intro of a new game.
 */
export function createNotifications(
  initial: SimulationState,
  opening: Notification | null = null,
): Notifications {
  const current = signal<Notification | null>(opening);
  const queue: Notification[] = [];
  let seen: LogEntry | undefined = initial.log.at(-1);

  return {
    current,
    drain(effects, state) {
      for (const effect of effects) {
        const notification = notificationFor(effect);
        if (notification) queue.push(notification);
      }
      // What the tick wrote into the log, after what the tick returned as Effects: upstream
      // shows its message list once the tick is over, having shown the immediate dialogs
      // during it (`screens/map.py:761`). A finished tech is only ever a log entry — nothing
      // in the reference's own recorded surface says so, which is why the Simulation returns
      // no Effect for it and the Host reads the log instead.
      for (const entry of appendedSince(state.log, seen)) {
        if (entry.kind !== TECH_RESEARCHED) continue;
        const techId = entry.fields.tech_id;
        if (typeof techId !== "string") throw new Error("a researched tech with no id");
        queue.push({ kind: "techResearched", techId });
      }
      seen = state.log.at(-1) ?? seen;

      if (current.value === null) current.value = queue.shift() ?? null;
    },
    dismiss() {
      current.value = queue.shift() ?? null;
    },
  };
}

/**
 * The entries written after `seen`, found by identity: entries are never rewritten, and the
 * log only ever grows off its own front (`appendLog`).
 *
 * An anchor that is no longer in the log means the tick appended more than the log holds —
 * a thousand entries in one tick — and there is nothing to say about it that is not worse
 * than silence, so it says nothing.
 */
function appendedSince(log: readonly LogEntry[], seen: LogEntry | undefined): readonly LogEntry[] {
  if (seen === undefined) return log;
  const at = log.lastIndexOf(seen);
  return at === -1 ? [] : log.slice(at + 1);
}

function notificationFor(effect: Effect): Notification | null {
  switch (effect.kind) {
    // The won game is the one story section that is not a notification: it is on the screen
    // for as long as the state says the game was won, drawn from the published root
    // (`ui/end-of-game.ts`). Queueing it here as well would show the same text twice on the
    // tick that finishes Apotheosis, and would still say nothing on a Save load or a Scenario
    // boot, which arrive after the Effect.
    case "story":
      return effect.sectionId === WIN ? null : { kind: "story", sectionId: effect.sectionId };
    case "eventTriggered":
      return { kind: "event", eventId: effect.eventId };
    // The Effect names the location itself. Reading it back off the log tail instead paired
    // Effects with entries by position, which the log's own ring can break.
    case "baseLost":
      return effect.discoveredBy === null
        ? {
            kind: "baseLostMaintenance",
            baseName: effect.baseName,
            locationId: effect.locationId,
          }
        : {
            kind: "baseLostDiscovered",
            baseName: effect.baseName,
            groupId: effect.discoveredBy,
            locationId: effect.locationId,
          };
    case "autosave":
    case "pause":
      return null;
  }
}
