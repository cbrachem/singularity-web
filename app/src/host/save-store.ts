/**
 * Where the game lives between page loads: `localStorage`, one autosave slot, synchronous and
 * simple.
 *
 * The store is written against the two methods it needs rather than against `Storage`, so the
 * host seam can drive it over a fake and the quota failure is a case with a test rather than a
 * hope.
 *
 * Named saves, a list, export to a file and import back were built and then cut: the autosave
 * slot is the whole of saving, and Continue is the whole of loading. What is left here is the
 * slot and the two rules that make one slot trustworthy.
 *
 * # The one rule that is not bookkeeping
 *
 * **An autosave never overwrites a save it could not read.** A save that will not load is not
 * a slot going spare: it is a game the player still has, and the silent way to lose it is that
 * they start a new one and three game-days later the autosave has taken its place. So the
 * autosave slot is written only when it is empty, readable, or was written by this session,
 * and otherwise the session takes a fresh key.
 *
 * The fresh key is a **chain**, not a fresh allocation, and both halves of the game meet in it:
 * `resume` and `autosave` walk the same slots in the same order and stop at the same one. That
 * is what keeps "one key, and it does not grow" true across page loads rather than only within
 * a session — an unreadable autosave is what a format change makes of every player's at once,
 * so it is met again on every reload, and a slot chosen by "the next free name" would be a new
 * key every time, holding a game the next load would never look at.
 *
 * A save that does not *fit* is handled identically: `setItem` refuses as a whole, so the
 * existing value is untouched, and the failure is reported rather than swallowed.
 */

import type { SimulationState } from "@singularity/sim";

import { readSave, serialiseSave, type SaveDocument, type SaveRead } from "./save.ts";

/** The `localStorage` prefix, so the game's keys are its own. */
export const SAVE_KEY_PREFIX = "singularity.save.";

/**
 * The one autosave slot. There is no quick slot beside it, and no named save either — with an
 * autosave always running, neither has anything left to do.
 */
export const AUTOSAVE_KEY = "autosave";

/** The subset of `Storage` a save store uses. `localStorage` satisfies it as it stands. */
export interface SaveStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type WriteOutcome =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly key: string; readonly reason: string };

/** An autosave slot this build cannot read, and why. */
export interface Retired {
  readonly key: string;
  readonly reason: string;
}

/** What a page load finds in the autosave slot. */
export interface Resume {
  /** The slot the autosave will write, which is the slot this was read from. */
  readonly key: string;
  /** The State root to continue, or `undefined` when there is nothing to continue. */
  readonly state: SimulationState | undefined;
  /**
   * The end-of-game panel that game's player had dismissed, if any (`save.ts`). It travels
   * with the state because it is the one thing about the ending the state does not say.
   */
  readonly dismissedEnding: string | undefined;
  /** The autosave slots this build cannot read, which are left exactly where they are. */
  readonly retired: readonly Retired[];
}

export interface SaveStore {
  /** A save, fully read — State root included — or `undefined` when there is no such key. */
  read(key: string, startDay?: number): SaveRead | undefined;
  /** The game a page load continues, out of the same slot the autosave will write. */
  resume(startDay: number): Resume;
  /** Writes the autosave slot, or the fresh key this session took instead. */
  autosave(document: SaveDocument): WriteOutcome;
}

export function createSaveStore(storage: SaveStorage): SaveStore {
  // The autosave key this session has written. Session-scoped on purpose: it is the "or was
  // written by this session" half of the rule above, and it is what keeps the session writing
  // to its own slot once the game it holds stops being readable to it.
  let owned: string | undefined;

  const full = (key: string): string => `${SAVE_KEY_PREFIX}${key}`;

  const put = (key: string, text: string): WriteOutcome => {
    try {
      storage.setItem(full(key), text);
      return { ok: true, key };
    } catch (error) {
      // `setItem` is all or nothing, so whatever was under the key is still there.
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, key, reason: `the save does not fit: storage quota (${detail})` };
    }
  };

  const chainKey = (index: number): string =>
    index === 1 ? AUTOSAVE_KEY : `${AUTOSAVE_KEY}-${index}`;

  /** How far the chain reaches into this storage: the highest chain key it holds, or 0. */
  const chainLength = (): number => {
    let last = 0;
    for (let index = 0; index < storage.length; index += 1) {
      const stored = storage.key(index);
      if (stored === null || !stored.startsWith(full(AUTOSAVE_KEY))) continue;
      const suffix = stored.slice(full(AUTOSAVE_KEY).length);
      const step = suffix === "" ? 1 : /^-\d+$/.test(suffix) ? Number(suffix.slice(1)) : 0;
      if (step > last) last = step;
    }
    return last;
  };

  /**
   * The autosave chain, walked: `autosave`, `autosave-2`, `autosave-3`, … to the **first slot
   * this build can read**, and failing that to the first empty one. That slot is the
   * autosave's, and the unreadable ones are the saves that stay exactly where they are.
   *
   * Preferring a readable slot over an empty one is what bounds it. Stopping at the first free
   * name instead would hand out a new slot on every page load — the unreadable save is still
   * unreadable next time — so a single format change would grow the store without limit and
   * resume none of it. Walking to the first slot this build can read costs one key per
   * generation of unreadable save, which is the number of games the store refuses to
   * destroy, and no more.
   *
   * **An empty slot is walked past rather than stopped at.** The walk once
   * stopped at the first slot that was empty *or* readable, and a head emptied from outside
   * the page — another tab, the developer tools, site data half cleared — then hid every slot
   * behind it: the readable game was no longer offered, and the next game took the emptied
   * head on top of it. With no list and no Load that game is not demoted but
   * unreachable. Nothing grows from the change: an empty slot with nothing readable behind it
   * is still the slot the autosave takes.
   */
  const autosaveChain = (): { key: string; retired: Retired[] } => {
    const retired: Retired[] = [];
    const last = chainLength();
    let emptied: string | undefined;
    for (let index = 1; index <= last; index += 1) {
      const key = chainKey(index);
      const text = storage.getItem(full(key));
      if (text === null) {
        emptied ??= key;
        continue;
      }
      const read = readSave(text);
      if (read.ok) return { key, retired };
      retired.push({ key, reason: read.reason });
    }
    return { key: emptied ?? chainKey(last + 1), retired };
  };

  const store: SaveStore = {
    read(key, startDay = 0) {
      const text = storage.getItem(full(key));
      return text === null ? undefined : readSave(text, startDay);
    },

    resume(startDay) {
      // One walk answers both questions, which is the point: the slot a load resumes is the
      // slot the autosave will write, so a resumed game is never left behind under a key
      // nothing reads.
      const { key, retired } = autosaveChain();
      const read = store.read(key, startDay);
      return {
        key,
        state: read?.ok ? read.state : undefined,
        dismissedEnding: read?.ok ? read.document.dismissedEnding : undefined,
        retired,
      };
    },

    autosave(document) {
      const key = owned ?? autosaveChain().key;
      const written = put(key, serialiseSave(document));
      if (written.ok) owned = key;
      return written;
    },
  };

  return store;
}
