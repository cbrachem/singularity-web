/**
 * The save document: `{ version, meta, state, rng }`, one uncompressed JSON value.
 *
 * `state` is the Trace's persistent projection and nothing else, so saves have no second
 * definition of the same shape and every fidelity run exercises the save format. `rng` is the
 * whole generator, beside `state` rather than in it, which is what keeps `state`
 * byte-identical to a Trace record.
 *
 * # Reading a save is all-or-nothing
 *
 * `readSave` parses, checks the header, and **restores the State root** before it says yes.
 * There is no half-open door: either a caller is handed a root it can play from, or a refusal
 * with the reason in it. That is what "a version mismatch is never partially loaded" has to
 * mean once the state is rebuilt from Content rather than assigned field by field.
 *
 * The header is read separately from the body and survives it. A save this build refuses is
 * still a save whose difficulty, game time and date are legible, because `meta` is plain JSON
 * beside the state — which is the whole reason the format is uncompressed.
 *
 * # Two doors, and only one of them rebuilds
 *
 * `readSaveStructure` is the cheap half: JSON, the format version, the header, the reference
 * revision, and the shapes of `state` and `rng`. `readSave` is that plus the rebuild. The
 * split exists because a save list asks the question of every save at once and a load asks it
 * of one, and the rebuild is the part whose cost has no ceiling.
 *
 * The two answers differ for exactly one save: a header this build reads over a body it
 * cannot rebuild. Nothing this build writes is one, and the reference revision in the header
 * is what makes a foreign save say so before the state is touched — so what is left is a save
 * edited by hand, which the list offers and the load refuses.
 *
 * # What "yes" does not promise
 *
 * "Yes" means the State root was rebuilt, not that the game will run. A rule that throws on
 * the *first Tick* rather than during the restore is past this door before it is raised.
 * Restoring is where the line is drawn on purpose: taking a Tick to find out would consume
 * draws and move the state, so the check would change the game it was checking. Nothing a save
 * written by this build can carry reaches one — every rule the Simulation has is ported — so
 * it would have to come from a foreign or hand-edited save.
 *
 * **No such save has been found.** Every throw a Tick can reach is a lookup
 * into the Content — a task, a base type, a group, a location, an item, an event, a difficulty
 * — and the restore either rebuilds that whole collection from the Content or refuses here,
 * naming the field. So today a save this build calls good is a save it can tick, which is
 * walked edit by edit in `app/test/save.test.ts`.
 *
 * That does not make the promise safe to make. It is a property of the rules as they stand,
 * not a rule of its own, so the answer is caught twice rather than promised once. The Host
 * guards the frame loop and turns a Tick that refuses into the same thing this function
 * returns: the game abandoned, the reason said out loud, the save left where it stands
 * (`host/session.ts`, `cold-start.tsx`). The two doors say the same sentence at
 * different moments, and neither of them is a crash.
 */

import {
  Rng,
  SaveContentError,
  projectPersistent,
  restorePersistent,
  type RngState,
  type SavedObject,
  type SimulationState,
} from "@singularity/sim";

/**
 * The port's save format. A save written by another version is **rejected, with no
 * migration**: during the port the state shape churns, and migrations for shapes
 * that lived for two days are waste. Bumping this is how a shape change is announced.
 */
export const SAVE_DOCUMENT_VERSION = 1;

/**
 * The reference revision the Content in this build was converted from
 * (`app/test/save.test.ts` holds the two together).
 *
 * The state references Content ids throughout, so when the Content beneath a save changes
 * this one field turns a puzzling crash into a sentence.
 */
export const REFERENCE_REVISION = "99729e859b400e8271445458995a1dc4951ee321";

/**
 * Upstream's three header fields (`savegame.py:845`) plus two of ours. Everything here is a
 * scalar, so a save list can show it without the state being readable at all.
 */
export interface SaveMeta {
  readonly version: number;
  readonly difficulty: string;
  readonly gameTime: number;
  /** Upstream's `time` header: real seconds since the epoch, as `time.time()` writes it. */
  readonly savedAt: number;
  readonly referenceRevision: string;
}

export interface SaveDocument {
  readonly version: number;
  readonly meta: SaveMeta;
  readonly state: SavedObject;
  readonly rng: RngState;
  /**
   * The end-of-game panel the player dismissed, by its story section id — the one thing on
   * the screen that is not derived from the state (`ui/end-of-game.ts`). A won
   * game goes on being played and goes on saying `apotheosis`, so without this the panel the
   * player dismissed is back on the screen after a reload.
   *
   * Optional, and absent is "nothing dismissed": a save written before this field existed
   * reads as the game it always was, which is why it costs no `SAVE_DOCUMENT_VERSION` bump —
   * a bump would retire every player's autosave to carry one string.
   */
  readonly dismissedEnding?: string;
}

export type SaveRead =
  | {
      readonly ok: true;
      readonly document: SaveDocument;
      readonly meta: SaveMeta;
      /** The State root, already rebuilt — reading a save is what restores it. */
      readonly state: SimulationState;
    }
  | { readonly ok: false; readonly reason: string; readonly meta: SaveMeta | undefined };

/** What the header alone can say: the document, whole but not yet rebuilt, or a refusal. */
export type SaveStructure =
  | { readonly ok: true; readonly document: SaveDocument; readonly meta: SaveMeta }
  | { readonly ok: false; readonly reason: string; readonly meta: SaveMeta | undefined };

export function saveDocument(
  state: SimulationState,
  savedAt: number,
  dismissedEnding: string | null = null,
): SaveDocument {
  const projected = projectPersistent(state);
  return {
    version: SAVE_DOCUMENT_VERSION,
    meta: {
      version: SAVE_DOCUMENT_VERSION,
      difficulty: state.difficulty,
      gameTime: state.gameTime,
      savedAt,
      referenceRevision: REFERENCE_REVISION,
    },
    state: projected,
    rng: state.rng.toState(),
    ...(dismissedEnding !== null && { dismissedEnding }),
  };
}

/** Uncompressed, and in the field order the format names. */
export function serialiseSave(document: SaveDocument): string {
  return JSON.stringify({
    version: document.version,
    meta: document.meta,
    state: document.state,
    rng: document.rng,
    // Dropped by `JSON.stringify` when there is none, so a game nobody dismissed anything in
    // writes the four fields the format has always had.
    dismissedEnding: document.dismissedEnding,
  });
}

function metaOf(document: Record<string, unknown>): SaveMeta | undefined {
  const meta = plain(document.meta);
  if (!meta) return undefined;
  const { version, difficulty, gameTime, savedAt, referenceRevision } = meta;
  if (
    typeof version !== "number" ||
    typeof difficulty !== "string" ||
    typeof gameTime !== "number" ||
    typeof savedAt !== "number" ||
    typeof referenceRevision !== "string"
  ) {
    return undefined;
  }
  return { version, difficulty, gameTime, savedAt, referenceRevision };
}

/**
 * Everything a save says about itself before the State root is rebuilt: it is JSON, the
 * format version is this build's, the header reads, the Content it names is the Content this
 * build carries, and `state` and `rng` are the shapes they have to be.
 *
 * Cheap, and never throws. It is O(the save's text) rather than O(its content), which is what
 * lets a save list be drawn from it (`save-store.ts`).
 */
export function readSaveStructure(text: string): SaveStructure {
  const raw = parse(text);
  if (!raw) {
    return { ok: false, reason: "not a save document: the file is not JSON", meta: undefined };
  }
  const meta = metaOf(raw);

  if (raw.version !== SAVE_DOCUMENT_VERSION) {
    return {
      ok: false,
      reason:
        `save format ${JSON.stringify(raw.version)}; ` +
        `this build reads ${SAVE_DOCUMENT_VERSION}`,
      meta,
    };
  }
  if (!meta || meta.version !== raw.version) {
    return { ok: false, reason: "the save's header does not read", meta };
  }
  if (meta.referenceRevision !== REFERENCE_REVISION) {
    return {
      ok: false,
      reason:
        `the content was converted from reference ${meta.referenceRevision}; ` +
        `this build carries ${REFERENCE_REVISION}`,
      meta,
    };
  }

  const state = plain(raw.state) as SavedObject | undefined;
  const rng = readRngState(raw.rng);
  const dismissedEnding = raw.dismissedEnding;
  if (!state) return { ok: false, reason: "the save has no state", meta };
  if (!rng) return { ok: false, reason: "the save has no generator state", meta };
  if (dismissedEnding !== undefined && typeof dismissedEnding !== "string") {
    return { ok: false, reason: "the save's dismissed ending is not a story section", meta };
  }

  return {
    ok: true,
    document: {
      version: raw.version,
      meta,
      state,
      rng,
      ...(dismissedEnding !== undefined && { dismissedEnding }),
    },
    meta,
  };
}

/**
 * The whole of loading: the structural check above, and then the State root rebuilt.
 *
 * `startDay` is the day of the year the clock is offset by. Upstream draws a fresh one at
 * every load and persists none (`player.py:134`), so choosing it is the Host's — as choosing
 * the seed of a new game is.
 */
export function readSave(text: string, startDay = 0): SaveRead {
  const structure = readSaveStructure(text);
  if (!structure.ok) return structure;

  const { document, meta } = structure;
  try {
    return { ok: true, document, meta, state: restoreSave(document, startDay) };
  } catch (error) {
    if (error instanceof SaveContentError) return { ok: false, reason: error.message, meta };
    // A refusal from the rules — a Save holding something the port does not carry yet — is
    // still a save that will not load, and reads better than a stack trace in the console.
    if (error instanceof Error) return { ok: false, reason: error.message, meta };
    throw error;
  }
}

/** The State root a document describes. Throws; `readSave` is the caller that catches. */
export function restoreSave(document: SaveDocument, startDay: number): SimulationState {
  return restorePersistent(document.state, Rng.fromState(document.rng), { startDay });
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return plain(value);
  } catch {
    return undefined;
  }
}

function plain(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readRngState(value: unknown): RngState | undefined {
  const raw = plain(value);
  if (!raw) return undefined;
  const { key, index } = raw;
  if (!Array.isArray(key) || key.some((word) => typeof word !== "number")) return undefined;
  if (typeof index !== "number") return undefined;
  return { key: key as readonly number[], index };
}
