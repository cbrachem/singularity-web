import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { advance, projectPersistent } from "@singularity/sim";
import { describe, expect, it } from "vitest";

import { createSession } from "../src/host/session.ts";
import {
  REFERENCE_REVISION,
  SAVE_DOCUMENT_VERSION,
  readSave,
  saveDocument,
  serialiseSave,
} from "../src/host/save.ts";
import { AUTOSAVE_KEY, SAVE_KEY_PREFIX, createSaveStore } from "../src/host/save-store.ts";
import { fakeStorage } from "./support/storage.ts";

/**
 * The host seam: the save document and the one slot it lives in. Headless — no DOM, and no
 * clock except the one the test holds.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A game with something in it: past the grace period, with a log and a triggered event. */
function played(gameSeconds = 40 * 86400) {
  const session = createSession({ seed: 43, difficulty: "normal" });
  session.advanceBy(gameSeconds);
  return session;
}

/**
 * A save whose header stands and whose body only fails when the State root is rebuilt: the
 * version, the reference revision, the meta and the generator are all this build's, and
 * `state.difficulty` names a difficulty the Content does not have.
 *
 * It is the one save a structural check and a full restore disagree about, so it is the
 * fingerprint of the rebuild — and the reason it is reachable at all is that it was written
 * by hand rather than by this build (`save.ts`).
 */
function handEdited(): string {
  const document = saveDocument(played(5 * 86400).current, 1_700_000_000);
  return serialiseSave({
    ...document,
    state: { ...document.state, difficulty: "no-such-difficulty" },
  });
}

describe("the save document", () => {
  it("carries the trace projection as its state, unmodified", () => {
    const session = played();

    const document = saveDocument(session.current, 1_700_000_000);

    // Not a re-implementation of the shape: the projection itself, which is what makes every
    // fidelity run an exercise of the save format.
    expect(document.state).toEqual(projectPersistent(session.current));
  });

  it("puts the whole generator state beside the state rather than inside it", () => {
    const session = played();

    const document = saveDocument(session.current, 1_700_000_000);

    expect(document.rng).toEqual(session.current.rng.toState());
    expect(document.rng.key).toHaveLength(624);
    expect(typeof document.rng.index).toBe("number");
    expect(JSON.stringify(document.state)).not.toContain("rng");
  });

  it("carries the format version and the reference revision beside upstream's fields", () => {
    const session = played(3 * 86400);

    const { meta, version } = saveDocument(session.current, 1_700_000_000);

    expect(version).toBe(SAVE_DOCUMENT_VERSION);
    expect(meta).toEqual({
      version: SAVE_DOCUMENT_VERSION,
      referenceRevision: REFERENCE_REVISION,
      // `write_game_to_fd` (`savegame.py:845`) writes exactly these three.
      difficulty: "normal",
      gameTime: 3 * 86400,
      savedAt: 1_700_000_000,
    });
  });

  it("is one uncompressed JSON document", () => {
    const text = serialiseSave(saveDocument(played(86400).current, 1));

    expect(text.startsWith("{")).toBe(true);
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["version", "meta", "state", "rng"]);
  });

  it("names the revision the Content was converted from", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(repoRoot, "scenarios/manifest.json"), "utf8"),
    ) as { reference: string };

    expect(REFERENCE_REVISION).toBe(manifest.reference);
  });

  it("round-trips: what is written is what is read back", () => {
    const session = played();
    const before = projectPersistent(session.current);

    const read = readSave(serialiseSave(saveDocument(session.current, 5)));
    if (!read.ok) throw new Error(read.reason);

    expect(projectPersistent(read.state)).toEqual(before);
    expect(read.state.rng.toState()).toEqual(session.current.rng.toState());
  });

  /**
   * The end-of-game panel the player dismissed, which is the one thing on the screen the state
   * does not say: a won game goes on being played and goes on saying `apotheosis`
   * (`ui/end-of-game.ts`). It sits beside the state rather than in it, so `state`
   * stays byte-identical to a Trace record.
   */
  it("carries the ending the player dismissed, and nothing where they dismissed none", () => {
    const session = played();

    const dismissed = readSave(serialiseSave(saveDocument(session.current, 5, "Win")));
    const untouched = readSave(serialiseSave(saveDocument(session.current, 5)));
    if (!dismissed.ok || !untouched.ok) throw new Error("both saves should read");

    expect(dismissed.document.dismissedEnding).toBe("Win");
    expect(untouched.document.dismissedEnding).toBeUndefined();
  });
});

describe("a save this build will not load", () => {
  const good = (): string => serialiseSave(saveDocument(played(5 * 86400).current, 42));

  function alter(change: (document: Record<string, unknown>) => void): string {
    const document = JSON.parse(good()) as Record<string, unknown>;
    change(document);
    return JSON.stringify(document);
  }

  it("rejects a version mismatch, with a message, and reads nothing else", () => {
    const read = readSave(
      alter((document) => {
        document.version = SAVE_DOCUMENT_VERSION + 1;
        document.state = "not a state at all";
      }),
    );

    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.reason).toContain(String(SAVE_DOCUMENT_VERSION));
    expect(read.reason).toContain(String(SAVE_DOCUMENT_VERSION + 1));
    // The header stays legible, which is what the list shows.
    expect(read.meta?.difficulty).toBe("normal");
  });

  it("rejects content converted from another reference revision", () => {
    const read = readSave(
      alter((document) => {
        (document.meta as Record<string, unknown>).referenceRevision = "0".repeat(40);
      }),
    );

    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.reason).toContain("0000000000");
  });

  it("rejects a state it cannot read, and still hands back the header", () => {
    const read = readSave(
      alter((document) => {
        delete (document.state as Record<string, unknown>).player;
      }),
    );

    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.reason).toContain("player");
    expect(read.meta?.gameTime).toBe(5 * 86400);
  });

  it("rejects a dismissed ending that is not a story section id", () => {
    const read = readSave(
      alter((document) => {
        document.dismissedEnding = 7;
      }),
    );

    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.reason).toContain("dismissed ending");
  });

  it("rejects text that is not a document at all, and has no header to show", () => {
    const read = readSave("<html>404</html>");

    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.meta).toBeUndefined();
  });
});

/**
 * The promise `readSave` deliberately does **not** make, checked rather than
 * assumed.
 *
 * "Yes" from `readSave` means the State root was rebuilt, not that the game will run: a rule
 * that throws on the first Tick is past that door, which is the case the Host's `onRefusal`
 * guard exists for (`host/session.ts`). The guard was proven with an injected
 * throw because no concrete save was found that passes the restore and then refuses.
 *
 * This is the walk that says why. Every throw a Tick can reach is a lookup into the Content —
 * a task, a base type, a group, a location, an item, an event, a difficulty — and the restore
 * either rebuilds that collection from the Content itself or refuses at the door, naming the
 * field. So a save this build calls good is a save it can tick, and each edit below is one of
 * the ways a foreign or hand-edited save was expected to break that.
 *
 * The catalogue is the regression, not the conclusion: an edit that begins to restore *and*
 * throw is a hole in `restore.ts`, and this is where it is heard about.
 */
describe("a save this build calls good is a save it can tick", () => {
  /**
   * A game whose estate is exposed: past the player's grace period and past every base's own,
   * so a Tick reaches detection — which is the phase that asks the Content the most questions.
   */
  function exposed(document: Record<string, unknown>): void {
    const player = (document.state as Record<string, unknown>).player as Record<string, unknown>;
    player.had_grace = false;
    for (const location of player.locations as Record<string, unknown>[]) {
      for (const base of location.bases as Record<string, unknown>[]) base.grace_over = true;
    }
  }

  const player = (document: Record<string, unknown>): Record<string, unknown> =>
    (document.state as Record<string, unknown>).player as Record<string, unknown>;

  const bases = (document: Record<string, unknown>): Record<string, unknown>[] =>
    (player(document).locations as Record<string, unknown>[]).flatMap(
      (location) => location.bases as Record<string, unknown>[],
    );

  /**
   * One hand edit, named for the Tick-time lookup it was expected to reach.
   *
   * `restores` is pinned rather than inferred, because a row the restore starts refusing is a
   * row that stops saying anything about a Tick — and an all-refusal catalogue would pass
   * while checking nothing.
   */
  const HAND_EDITS: readonly {
    readonly name: string;
    readonly restores: boolean;
    readonly edit: (document: Record<string, unknown>) => void;
  }[] = [
    {
      // `task.ts`, `dangerFor` — and `advance.ts`, the research loop.
      name: "CPU pointed at a task the Content does not carry",
      restores: false,
      edit: (document) => {
        (player(document).cpu_usage as Record<string, unknown>)["not-a-tech"] = 1000;
      },
    },
    {
      // `cpu.ts`, `recalcCpu` — an allocation for a tech nothing has unlocked. Dropped by the
      // restore rather than refused (`player.py:733`), so the Tick never sees it.
      name: "CPU pointed at a tech whose prerequisites are not done",
      restores: true,
      edit: (document) => {
        (player(document).cpu_usage as Record<string, unknown>)["Apotheosis"] = 1000;
      },
    },
    {
      // `detection.ts`, `detectChance` — the base type's own detection table.
      name: "a base type the Content does not carry",
      restores: false,
      edit: (document) => {
        for (const base of bases(document)) base.id = "not-a-base-type";
      },
    },
    {
      // `detection.ts`, `group` — the groups a base type's detection table names. The restore
      // rebuilds every Content group whatever the save listed, which is what closes this one.
      name: "an estate whose groups the save left out",
      restores: true,
      edit: (document) => {
        exposed(document);
        player(document).groups = [];
      },
    },
    {
      // `cpu.ts`, `locationSafety`, and `location.ts`, `locationModifiers`.
      name: "a base standing in a location the Content does not carry",
      restores: false,
      edit: (document) => {
        (player(document).locations as Record<string, unknown>[])[0]!.id = "ATLANTIS";
      },
    },
    {
      // `buyable.ts`, `itemQuality`. The base type is one that forces no CPU of its own, or
      // the restore would ignore the save's items entirely (`base.py:357`).
      name: "an item the Content does not carry",
      restores: false,
      edit: (document) => {
        for (const base of bases(document)) {
          base.id = "Storage Unit";
          base.items = [{ id: "not-an-item", done: true }];
        }
      },
    },
    {
      // `gameevent.ts`, `eventSpec`, reached by the midnight expiry walk.
      name: "an event the Content does not carry",
      restores: false,
      edit: (document) => {
        player(document).events = [{ id: "not-an-event", triggered: 1, triggered_at: 0 }];
      },
    },
    {
      // `advance.ts`, `difficulty`, and `detection.ts`, `settleGrace`.
      name: "a difficulty the Content does not carry",
      restores: false,
      edit: (document) => {
        (document.state as Record<string, unknown>).difficulty = "no-such-difficulty";
      },
    },
    {
      // `location.ts`, `locationModifiers` — the entry a region drew for a location. A region
      // may hold more locations than modifiers, so a high entry is no modifier at all rather
      // than a refusal (`region.py:50`).
      name: "a region entry past the end of its modifier table",
      restores: true,
      edit: (document) => {
        for (const region of player(document).regions as Record<string, unknown>[]) {
          for (const pair of region.modifier_entry_by_location as Record<string, unknown>[]) {
            pair.modifier_entry = 99;
          }
        }
      },
    },
    {
      // `buyable.ts`, `workOn` — a buyable that costs nothing at all has no progress to
      // compute. The total is rebuilt from the Content spec, so only what is *paid* moves.
      name: "a base paid past its own total",
      restores: true,
      edit: (document) => {
        for (const base of bases(document)) {
          delete base.done;
          base.cost_paid = [10 ** 15, 10 ** 15, 10 ** 15];
        }
      },
    },
    {
      // The estate a Tick works hardest on: everything exposed, every group at the edge of
      // the loss the Host stops for.
      name: "an exposed estate with every group one point below the loss",
      restores: true,
      edit: (document) => {
        exposed(document);
        for (const group of player(document).groups as Record<string, unknown>[]) {
          group.suspicion = 9_999;
        }
      },
    },
    {
      // Nothing checks that a base type belongs where it stands — upstream does not either.
      name: "a base standing where its type cannot be built",
      restores: true,
      edit: (document) => {
        exposed(document);
        for (const base of bases(document)) base.id = "Reality Bubble";
      },
    },
    {
      // Every standing consequence re-applied at once, then a Tick over the top of it.
      name: "every tech done",
      restores: true,
      edit: (document) => {
        for (const tech of player(document).techs as Record<string, unknown>[]) {
          delete tech.cost_paid;
          tech.done = true;
        }
      },
    },
  ];

  it.each(HAND_EDITS)("refuses or survives thirty days of $name", ({ edit, restores }) => {
    const document = JSON.parse(
      serialiseSave(saveDocument(played(5 * 86400).current, 42)),
    ) as Record<string, unknown>;
    edit(document);

    const read = readSave(JSON.stringify(document));

    expect(read.ok).toBe(restores);
    // A refusal is the other half of the property: the door said no, so no Tick follows.
    if (!read.ok) return;
    expect(() => advance(read.state, 30 * 86_400)).not.toThrow();
  });
});

describe("the save store", () => {
  it("writes one autosave key and does not grow", () => {
    const storage = fakeStorage();
    const store = createSaveStore(storage);
    const session = played(3 * 86400);

    for (let write = 0; write < 5; write += 1) {
      session.advanceBy(86400);
      expect(store.autosave(saveDocument(session.current, write)).ok).toBe(true);
    }

    expect(storage.keys()).toEqual([`${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`]);
  });

  it("takes a fresh key rather than overwriting an autosave it could not read", () => {
    const storage = fakeStorage();
    const stale = serialiseSave({
      ...saveDocument(played(9 * 86400).current, 1),
      version: SAVE_DOCUMENT_VERSION + 1,
    });
    storage.setItem(`${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`, stale);
    const store = createSaveStore(storage);

    const written = store.autosave(saveDocument(played(86400).current, 2));

    expect(written.ok).toBe(true);
    expect(written.key).not.toBe(AUTOSAVE_KEY);
    expect(storage.getItem(`${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`)).toBe(stale);

    // And that fresh key is now this session's, so the next autosave does not take another.
    const again = store.autosave(saveDocument(played(2 * 86400).current, 3));
    expect(again.key).toBe(written.key);
    expect(storage.keys()).toHaveLength(2);
  });

  /**
   * The chain used to stop at the first slot that was empty *or* readable, so an
   * emptied head hid every slot behind it — the readable game in `autosave-2` stopped being
   * offered and the next game took `autosave` on top of it. With no list and no Load
   * that game is not demoted but unreachable, which is the loss the save store exists to
   * refuse.
   *
   * A head only goes empty from outside the page: another tab, the developer tools, site data
   * half cleared. The walk answers for it rather than trusting that it cannot happen.
   */
  it("walks past an emptied slot to the readable game behind it", () => {
    const storage = fakeStorage();
    const kept = serialiseSave(saveDocument(played(9 * 86400).current, 1));
    storage.setItem(`${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`, "{ not a save this build reads }");
    storage.setItem(`${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}-2`, kept);
    // The unreadable head goes, from outside this page.
    storage.removeItem(`${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`);
    const store = createSaveStore(storage);

    const resumed = store.resume(0);

    expect(resumed.key).toBe(`${AUTOSAVE_KEY}-2`);
    expect(resumed.state).toBeDefined();
    // Both ends of the chain take the same walk, so the game that is offered is the game the
    // autosave goes on writing.
    expect(store.autosave(saveDocument(played(86400).current, 2)).key).toBe(`${AUTOSAVE_KEY}-2`);
  });

  // The emptied slot is reused rather than skipped when nothing readable stands behind it, so
  // a hole in the chain costs no key.
  it("takes the emptied slot back when the only save behind it is unreadable", () => {
    const storage = fakeStorage();
    const stale = "{ not a save this build reads }";
    storage.setItem(`${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`, stale);
    storage.setItem(`${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}-2`, stale);
    storage.removeItem(`${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`);
    const store = createSaveStore(storage);

    const resumed = store.resume(0);

    expect(resumed.key).toBe(AUTOSAVE_KEY);
    expect(resumed.state).toBeUndefined();
    expect(resumed.retired.map((slot) => slot.key)).toEqual([`${AUTOSAVE_KEY}-2`]);
    expect(store.autosave(saveDocument(played(86400).current, 2)).key).toBe(AUTOSAVE_KEY);
    expect(storage.getItem(`${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}-2`)).toBe(stale);
  });

  it("keeps overwriting a slot this session wrote, even once it stops being readable", () => {
    const storage = fakeStorage();
    const store = createSaveStore(storage);
    store.autosave(saveDocument(played(86400).current, 1));

    storage.setItem(`${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`, "{ corrupted by something else }");
    const written = store.autosave(saveDocument(played(2 * 86400).current, 2));

    expect(written.key).toBe(AUTOSAVE_KEY);
  });

  // The autosave rule turns on "would actually load", so the walk that chooses the autosave slot
  // rebuilds the State root rather than reading the header. `handEdited` is the one save the
  // two questions disagree about: a header this build reads over a body only the restore
  // refuses.
  it("still refuses to load, or to overwrite, a save whose state will not rebuild", () => {
    const storage = fakeStorage();
    const handWritten = handEdited();
    storage.setItem(`${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`, handWritten);
    const store = createSaveStore(storage);

    const read = store.read(AUTOSAVE_KEY);
    expect(read?.ok).toBe(false);
    if (read?.ok !== false) throw new Error("expected a refusal");
    expect(read.reason).toContain("no such difficulty");

    expect(store.resume(0).state).toBeUndefined();
    const written = store.autosave(saveDocument(played(86400).current, 2));
    expect(written.key).not.toBe(AUTOSAVE_KEY);
    expect(storage.getItem(`${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`)).toBe(handWritten);
  });

  it("reports a save that does not fit, and leaves the existing one alone", () => {
    const storage = fakeStorage({ quota: 400 });
    const store = createSaveStore(storage);
    const small = serialiseSave(saveDocument(played(86400).current, 1));
    storage.setItem(`${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`, "kept");

    const written = store.autosave(saveDocument(played(2 * 86400).current, 2));

    expect(small.length).toBeGreaterThan(400);
    expect(written.ok).toBe(false);
    if (written.ok) throw new Error("expected a refusal");
    expect(written.reason).toContain("quota");
    expect(storage.getItem(`${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`)).toBe("kept");
  });

  // Upstream has autosave, quicksave and named saves. With an autosave always
  // running the quick slot had nothing left to do, and the named saves were cut after
  // them — one slot is the whole of saving. Asserted as the store's whole surface, so growing
  // any of it back is an edit here rather than a quiet addition.
  it("has one slot, and no way to name, list, export or import a second", () => {
    const store = createSaveStore(fakeStorage());

    expect(Object.keys(store).sort()).toEqual([
      "autosave",
      "read",
      // Not a second slot: `resume` reads the autosave slot the next write will take, which is
      // what keeps the two ends of the chain from disagreeing.
      "resume",
    ]);
    expect(AUTOSAVE_KEY).toBe("autosave");
  });
});
