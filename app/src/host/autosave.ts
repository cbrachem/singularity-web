/**
 * The autosave, throttled to the wall clock.
 *
 * The Simulation asks every three game-days (`player.py:575`), which at the top speed is about
 * 1.7 times a real second — and it does not know that, because whether the Host acts on an
 * Effect is not Simulation state. So the Host complies at its own rate
 * and drops the rest.
 *
 * **The flush is the part that matters.** Dropping a request is only safe because the last one
 * before the player looks away is always honoured: the clock stopping and the tab being hidden
 * both force whatever is pending out to storage. Which is why a dropped request stays
 * *pending* rather than being forgotten — and why the write takes a fresh snapshot instead of
 * keeping the state the request arrived with.
 *
 * The fresh snapshot is also why there is a `discard`. A request is owed against a game, and
 * the game can end between the request and the flush; the flush would then write a state the
 * Simulation would never have asked to save. Whether that has happened is not something the
 * autosave can see — it holds a snapshot function and a clock, and nothing of the rules — so
 * the Host says so (`session.ts`).
 */

import type { SimulationState } from "@singularity/sim";

import { saveDocument } from "./save.ts";
import type { SaveStore, WriteOutcome } from "./save-store.ts";

/** At most one write per ten real seconds. */
export const AUTOSAVE_INTERVAL_SECONDS = 10;

export interface AutosaveOptions {
  /** The newest State root. Called at write time, never at request time. */
  readonly snapshot: () => SimulationState;
  /**
   * The end-of-game panel the player has dismissed, if any — read at write time for the same
   * reason the state is, since the player can dismiss it between a request and the flush
   * (`session.ts`). Left out by a caller with no game behind it.
   */
  readonly dismissedEnding?: () => string | null;
  readonly store: SaveStore;
  /** Wall-clock seconds. The same clock stamps the save's `savedAt`. */
  readonly now: () => number;
  readonly intervalSeconds?: number;
  /** Told about every write, including the ones storage refused. */
  readonly report?: (outcome: WriteOutcome) => void;
}

export interface Autosave {
  /** The Simulation asked. Writes if the throttle allows; otherwise the request stays owed. */
  request(): void;
  /** Forced: writes if anything is owed. The tab being hidden, and the clock stopping. */
  flush(): void;
  /** Forgets what is owed without writing it. Nothing is written and nothing stays owed. */
  discard(): void;
  /** Whether a request has arrived that has not been written yet. */
  readonly pending: boolean;
}

export function createAutosave({
  snapshot,
  dismissedEnding,
  store,
  now,
  intervalSeconds = AUTOSAVE_INTERVAL_SECONDS,
  report,
}: AutosaveOptions): Autosave {
  let writtenAt = Number.NEGATIVE_INFINITY;
  let owed = false;

  const write = (): void => {
    const at = now();
    // A refusal still counts as an attempt: the throttle is what keeps a full quota from
    // being retried on every request, and `setItem` left the existing save untouched.
    const outcome = store.autosave(saveDocument(snapshot(), at, dismissedEnding?.() ?? null));
    writtenAt = at;
    owed = false;
    report?.(outcome);
  };

  return {
    get pending() {
      return owed;
    },
    request() {
      owed = true;
      if (now() - writtenAt >= intervalSeconds) write();
    },
    flush() {
      if (owed) write();
    },
    discard() {
      owed = false;
    },
  };
}
