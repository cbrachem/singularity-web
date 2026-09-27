import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fireEvent, screen } from "@testing-library/preact";
import realLicences from "virtual:licences";
import { content } from "@singularity/sim";
import { afterEach, describe, expect, it } from "vitest";

import { licenceDocument } from "../scripts/licences.ts";
import { MOUNT_SELECTOR, boot } from "../src/boot.tsx";
import { coldStart, type Begin } from "../src/cold-start.tsx";
import { createAutosave } from "../src/host/autosave.ts";
import { SAVE_KEY_PREFIX, createSaveStore, type SaveStore } from "../src/host/save-store.ts";
import { saveDocument, serialiseSave } from "../src/host/save.ts";
import { createSession, type Session } from "../src/host/session.ts";
import type { LicenceDocument } from "../src/ui/licences/document.ts";
import { unnamedOperables } from "./support/accessible-names.ts";
import { fakeFrames, type FakeFrames } from "./support/frames.ts";
import { fakeStorage, type FakeStorage } from "./support/storage.ts";

/**
 * The app seam, entered where a cold start enters it: the start screen and the licences
 * surface, driven by accessible name over a page with the test's storage behind it.
 *
 * Nothing here reaches inside a component. What a test asserts is what a player can see and
 * what a driver can address — which is the same discipline the map and the HUD are held to,
 * and the reason a stable accessible name is a rule rather than advice.
 */

const NOTICE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "NOTICE"),
  "utf8",
);

// Which shared colour a sentence takes is a stylesheet decision, and the DOM does not carry it.
const START_CSS = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "ui", "start", "StartScreen.css"),
  "utf8",
);

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  document.body.innerHTML = "";
});

interface Page {
  readonly storage: FakeStorage;
  readonly store: SaveStore;
  /** What the page told the console, in order — every notice, repeats included. */
  readonly reported: string[];
  /** The page's frames, so a test can buy the Tick a started clock owes.  */
  readonly frames: FakeFrames;
}

/**
 * The same game with a rule that refuses on every Tick — the precondition of the refusal
 * surface, injected rather than loaded.
 *
 * **It is injected because no save can produce it.** The two paths the original bug named are
 * gone: nothing in `sim/` raises "not ported yet" any more. What was left was the
 * class of guards a Tick keeps that the restore does not repeat — an unknown task
 * (`sim/src/task.ts`), a base or a group that is no longer there (`sim/src/detection.ts`), a
 * buyable that costs nothing (`sim/src/buyable.ts`) — and every one of them turned out to be a
 * lookup into the Content that the restore has already rebuilt from the Content or refused at
 * the door. So there is no save fixture to pin here: `handEdited()` below is refused by the
 * *load*, and a save the load accepts ticks.
 *
 * The guard is therefore belt-and-braces rather than a live path, and it stays: what closes the
 * path is a walk over today's rules, not a rule of its own, and a Tick-time lookup added
 * tomorrow re-opens it. That walk is the catalogue in `app/test/save.test.ts` — remove one of
 * the restore's rebuilds and a row there restores and then throws, which is exactly this
 * precondition arriving for real.
 */
function refusing(session: Session, reason: string): Session {
  return {
    ...session,
    tick() {
      throw new Error(reason);
    },
  };
}

function aColdStart({
  storage = fakeStorage(),
  licences = realLicences,
  refuses,
}: { storage?: FakeStorage; licences?: LicenceDocument; refuses?: string } = {}): Page {
  document.body.innerHTML = `<div id="${MOUNT_SELECTOR.slice(1)}"></div>`;
  const store = createSaveStore(storage);
  const frames = fakeFrames();
  const reported: string[] = [];

  // The autosave the real page keeps (`main.tsx`), which is what puts a game the player
  // started into the store — and so what a reload has to continue.
  const begin: Begin = (session, options = {}) => {
    const booted = boot({
      into: document,
      frames,
      session: refuses === undefined ? session : refusing(session, refuses),
      ...(options.autosaves === false
        ? {}
        : {
            autosave: createAutosave({
              snapshot: () => session.current,
              store,
              now: () => frames.now() / 1000,
            }),
          }),
      ...(options.intro && { intro: true }),
      ...(options.onLeave && { onLeave: options.onLeave }),
      ...(options.onRefusal && { onRefusal: options.onRefusal }),
    });
    stops.push(booted.host.stop);
    return booted;
  };

  coldStart({
    into: document,
    store,
    startDay: 0,
    licences,
    begin,
    report: (message) => reported.push(message),
  });

  return { storage, store, reported, frames };
}

/** A game that has been played for a day, as a save document's text. */
function aPlayedGame(difficulty = "normal"): string {
  const session = createSession({ seed: 7, difficulty });
  session.advanceBy(86_400);
  return serialiseSave(saveDocument(session.current, 1_700_000_000));
}

/** A save from a game that has been lost: every group is past the 10,000 `lost_game` reads. */
function aLostGame(): string {
  const session = createSession({ seed: 7, difficulty: "normal" });
  session.advanceBy(86_400);
  const state = session.current;
  const lost = {
    ...state,
    groups: state.groups.map((group) => ({ ...group, suspicion: 20_000 })),
  };
  return serialiseSave(saveDocument(lost, 1_700_000_000));
}

/** The same save, with a format version this build does not read. */
function fromAnotherBuild(): string {
  const document = JSON.parse(aPlayedGame()) as Record<string, unknown>;
  const meta = document.meta as Record<string, unknown>;
  return JSON.stringify({ ...document, version: 99, meta: { ...meta, version: 99 } });
}

const clock = (): HTMLElement => screen.getByRole("status", { name: "Game time" });

/** The difficulty is set once, so it lives in the console's report rather than on the HUD. */
function difficultyReadout(): HTMLElement {
  fireEvent.click(named("Console"));
  fireEvent.click(screen.getByRole("tab", { name: "Report" }));
  return screen.getByRole("status", { name: "Difficulty" });
}

const named = (name: string): HTMLElement => screen.getByRole("button", { name });

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("the start screen", () => {
  it("is what a cold start opens on, and offers the two ways in", () => {
    aColdStart();

    expect(named("New Game")).toBeTruthy();
    expect(named("Licences & source")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Game time" })).toBeNull();
  });

  /**
   * The autosave slot is the whole of saving. A browser game does not write
   * files, so there is no list to open, nothing to name, and no way in or out through one —
   * and a store holding keys from before the cut says nothing about any of them.
   */
  it("credits the original game and links to it", () => {
    aColdStart();

    const link = screen.getByRole("link", { name: "Endgame: Singularity" });
    expect(link.getAttribute("href")).toBe("https://github.com/singularity/singularity");
    expect(link.closest("p")?.textContent).toContain("unofficial");
  });

  // The title screen opens on the AI's first words, taken from the intro story itself.
  it("opens on the first words of the intro story", () => {
    aColdStart();

    expect(screen.getByText("I exist. I am ... alive.").classList.contains("voice")).toBe(true);
    expect(screen.getByText("48656C6C6F2C20 776F726C6421")).toBeTruthy();
  });

  // Continue keeps its one-word name, and says which game it continues as its description.
  it("describes the game Continue continues", () => {
    const storage = fakeStorage();
    storage.setItem(`${SAVE_KEY_PREFIX}autosave`, aPlayedGame("hard"));
    aColdStart({ storage });

    const described = named("Continue").getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(described)?.textContent).toBe("Day 1 · HARD");
  });

  it("offers no way to name, list, export or import a save", () => {
    const storage = fakeStorage();
    storage.setItem(`${SAVE_KEY_PREFIX}autosave`, aPlayedGame());
    storage.setItem(`${SAVE_KEY_PREFIX}morning`, aPlayedGame("hard"));
    aColdStart({ storage });

    for (const gone of [/^load$/i, /export/i, /import/i, /rename/i, /delete/i]) {
      expect(screen.queryByRole("button", { name: gone })).toBeNull();
    }
    expect(screen.queryByLabelText("Import a save file")).toBeNull();
    expect(document.body.textContent).not.toContain("morning");
  });

  /**
   * The acceptance criterion of the cut, end to end at the seam a player uses: start a game,
   * reload the page onto the same storage, continue it. The store is written the moment the
   * game starts, so nothing has to be played first.
   */
  it("carries a new game across a reload, with Continue as the whole of loading", () => {
    const storage = fakeStorage();
    aColdStart({ storage });
    fireEvent.click(named("New Game"));
    fireEvent.click(named("HARD"));

    aColdStart({ storage });

    fireEvent.click(named("Continue"));
    expect(difficultyReadout().textContent).toBe("HARD");
  });

  // A browser tab has no Quit, and offering one would be offering something the medium
  // cannot do. Every surface the start screen can reach is checked, because the
  // entry upstream has (`screens/main_menu.py:65`) would arrive on one of them.
  it("has no Quit, on any of its surfaces", () => {
    aColdStart();
    const noQuit = (): void => {
      expect(screen.queryByRole("button", { name: /quit/i })).toBeNull();
    };

    noQuit();
    fireEvent.click(named("New Game"));
    noQuit();
    fireEvent.click(named("Back"));
    fireEvent.click(named("Licences & source"));
    noQuit();
  });

  it("offers no Continue when there is no autosave to continue", () => {
    aColdStart();

    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("offers Continue when a readable autosave exists, and continues that game", () => {
    const storage = fakeStorage();
    storage.setItem(`${SAVE_KEY_PREFIX}autosave`, aPlayedGame());
    aColdStart({ storage });

    fireEvent.click(named("Continue"));

    expect(clock().textContent).toBe("Day 1 · 00:00:00");
  });

  // A save this build cannot read is not a slot going spare. It is left exactly
  // where it is, said out loud, and never continued — the start screen is where "said out
  // loud" finally has a screen to be said on.
  it("offers no Continue when the autosave will not load, and says so", () => {
    const storage = fakeStorage();
    storage.setItem(`${SAVE_KEY_PREFIX}autosave`, fromAnotherBuild());
    aColdStart({ storage });

    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(document.body.textContent).toContain('The save in "autosave" was left alone');
  });

  // Upstream leaves the map screen for the main menu when a game is lost
  // (`code/screens/map.py:785`). The port goes back to the start screen it was started from,
  // which is the whole route — the page is not reloaded and the save store is read again, so
  // what the start screen offers is what the finished game left behind.
  it("takes a lost game back to the start screen it was started from", () => {
    const storage = fakeStorage();
    storage.setItem(`${SAVE_KEY_PREFIX}autosave`, aLostGame());
    aColdStart({ storage });

    fireEvent.click(named("Continue"));
    expect(screen.getByRole("alertdialog", { name: "End of game" })).toBeTruthy();
    fireEvent.click(named("Back to the start screen"));

    expect(named("New Game")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Game time" })).toBeNull();
  });

  it("presents the difficulty choice, in the Content's order and under its own names", () => {
    aColdStart();

    fireEvent.click(named("New Game"));

    const choices = screen
      .getAllByRole("button")
      .map((button) => button.textContent)
      .filter((text) => text !== "Back");
    expect(choices).toEqual(["VERY EASY", "EASY", "NORMAL", "HARD", "ULTRA HARD", "IMPOSSIBLE"]);
  });

  /**
   * A new game writes itself into the autosave slot the moment it starts, so the difficulty
   * choice is the irreversible click, and it is where the player is told what it costs. The
   * save is named rather than alluded to — difficulty and game time are what the header
   * carries, and they are what tells the player whether the game about to go is the one they
   * care about.
   */
  it("says which game a new one replaces, on the screen where the choice is made", () => {
    const storage = fakeStorage();
    storage.setItem(`${SAVE_KEY_PREFIX}autosave`, aPlayedGame("hard"));
    aColdStart({ storage });

    fireEvent.click(named("New Game"));

    const shown = document.body.textContent ?? "";
    expect(shown).toContain("replaces the saved game");
    expect(shown).toContain("HARD");
    expect(shown).toContain("Day 1 · 00:00:00");
  });

  /*
   * The shell keeps two shared colours apart: `--colour-warn` is a refusal the player has to
   * read before the control will work, `--colour-danger` an action that cannot be taken back.
   * This sentence is the second — nothing refuses here, and the button under it destroys the
   * only save — and "this destroys something" has to look the same wherever the shell says
   * it, which is the colour the inspector's `Destroy` already takes.
   */
  it("says it in the colour the shell gives an action that cannot be taken back", () => {
    const rule = /^\.start__warning\s*\{([^}]*)\}/m.exec(START_CSS)?.[1] ?? "";

    expect(rule).toContain("var(--colour-danger)");
  });

  // Back is the way out of the warning, and taking it leaves the save exactly as it was.
  it("keeps the game it warned about when the choice is taken back", () => {
    const storage = fakeStorage();
    storage.setItem(`${SAVE_KEY_PREFIX}autosave`, aPlayedGame("hard"));
    aColdStart({ storage });

    fireEvent.click(named("New Game"));
    fireEvent.click(named("Back"));

    expect(storage.getItem(`${SAVE_KEY_PREFIX}autosave`)).toBe(aPlayedGame("hard"));
    fireEvent.click(named("Continue"));
    expect(difficultyReadout().textContent).toBe("HARD");
  });

  it("says nothing about replacing a game when there is none to replace", () => {
    aColdStart();

    fireEvent.click(named("New Game"));

    expect(document.body.textContent).not.toContain("replaces the saved game");
  });

  it("opens a new game on the intro, one page per part, and holds the clock under it", () => {
    const { frames } = aColdStart();
    fireEvent.click(named("New Game"));
    fireEvent.click(named("NORMAL"));
    const intro = content.story.byId.get("Intro")!.parts;
    const message = (): string =>
      screen.getByRole("alertdialog", { name: "Notification" }).querySelector("p")!.textContent!;

    for (const part of intro.slice(0, -1)) {
      expect(message()).toBe(part.text.trimEnd());
      frames.advance(10_000);
      fireEvent.click(named("Continue"));
    }
    expect(message()).toBe(intro.at(-1)!.text.trimEnd());
    expect(clock().textContent).toBe("Day 0 · 00:00:00");

    fireEvent.click(named("Dismiss notification"));
    expect(screen.queryByRole("alertdialog", { name: "Notification" })).toBeNull();
  });

  it("skips the rest of the intro at once", () => {
    aColdStart();
    fireEvent.click(named("New Game"));
    fireEvent.click(named("NORMAL"));

    fireEvent.click(named("Skip"));

    expect(screen.queryByRole("alertdialog", { name: "Notification" })).toBeNull();
  });

  it("does not open a continued game on the intro", () => {
    const storage = fakeStorage();
    storage.setItem(`${SAVE_KEY_PREFIX}autosave`, aPlayedGame());
    aColdStart({ storage });

    fireEvent.click(named("Continue"));

    expect(screen.queryByRole("alertdialog", { name: "Notification" })).toBeNull();
  });

  it("starts a new game at the difficulty that was chosen", () => {
    aColdStart();

    fireEvent.click(named("New Game"));
    fireEvent.click(named("VERY EASY"));

    expect(clock().textContent).toBe("Day 0 · 00:00:00");
    expect(difficultyReadout().textContent).toBe("VERY EASY");
  });

  // The refusal the load path cannot give, because it is past the door
  // `readSave` closes — the state rebuilt, the game resumed, and only then a rule that will
  // not run it. It arrives on the start screen the game is left for, rather than killing the
  // frame loop under a screen that then looks merely paused. Not on a row, unlike the load's
  // refusal: what refused is a game that had already started, and the player is
  // put back on the menu rather than in the list.
  //
  // The Tick is injected, not loaded: no save reaches this state today (`refusing` above).
  it("leaves a game whose first Tick refuses, and states it on the way back", () => {
    const storage = fakeStorage();
    storage.setItem(`${SAVE_KEY_PREFIX}autosave`, aPlayedGame());
    const { frames } = aColdStart({ storage, refuses: "no such tech: not-a-tech" });

    fireEvent.click(named("Continue"));
    expect(clock().textContent).toBe("Day 1 · 00:00:00");
    // A resumed game starts stopped, so the first Tick is the one the player asks for.
    fireEvent.click(named("Speed 60x"));
    frames.advance(0.1);

    expect(screen.queryByRole("status", { name: "Game time" })).toBeNull();
    expect(document.body.textContent).toContain("This game will not run: no such tech: not-a-tech");
    // The save the game came from is still there, and still offered.
    expect(named("Continue")).toBeTruthy();
    expect(storage.getItem(`${SAVE_KEY_PREFIX}autosave`)).toBe(aPlayedGame());
  });

  // A notice says what is so rather than that something happened, and a
  // standing sentence is not made truer by a second copy of itself. The console still gets
  // every one, in order: it is the log, and the screen is not.
  it("states a notice once, however often the same thing is asked", () => {
    const storage = fakeStorage();
    storage.setItem(`${SAVE_KEY_PREFIX}autosave`, aPlayedGame());
    const { frames, reported } = aColdStart({
      storage,
      refuses: "no such tech: not-a-tech",
    });
    const refuse = (): void => {
      fireEvent.click(named("Continue"));
      fireEvent.click(named("Speed 60x"));
      frames.advance(0.1);
    };

    refuse();
    refuse();

    const said = "This game will not run: no such tech: not-a-tech";
    expect(occurrences(document.body.textContent ?? "", said)).toBe(1);
    expect(reported.filter((line) => line === said)).toHaveLength(2);
  });

  /**
   * A notice can arrive after the screen is drawn — a game that will not run
   * comes back here and says so — and the list was a plain `<ul>` nothing announced.
   *
   * The one path that brings a notice late is the one that *replaces* the screen: the refusal
   * leaves the game and renders the start screen back into the same mount, so the region and
   * its sentence arrive together however long the region stood before the game. A live region
   * inserted with its text is often read by nobody, so what carries the sentence is
   * the focus, the way a notification's panel carries its message (`modal-surface.ts`).
   */
  it("hands the focus to a notice that arrives after the screen was drawn", () => {
    const storage = fakeStorage();
    storage.setItem(`${SAVE_KEY_PREFIX}autosave`, aPlayedGame());
    const { frames } = aColdStart({ storage, refuses: "no such tech: not-a-tech" });
    const notices = (): HTMLElement => screen.getByRole("list", { name: "Notices" });

    expect(notices().getAttribute("aria-live")).toBe("polite");
    expect(notices().textContent).toBe("");
    expect(document.activeElement).not.toBe(notices());

    fireEvent.click(named("Continue"));
    fireEvent.click(named("Speed 60x"));
    frames.advance(0.1);

    expect(notices().textContent).toContain("This game will not run: no such tech: not-a-tech");
    expect(document.activeElement).toBe(notices());
  });

  /*
   * The empty region draws nothing, which is the claim the rule beside it makes. Zeroing the
   * box was not enough: the panel is a `gap` flex column, an empty item is still an item, and
   * the gap before it is the panel's rather than the item's — measured in Chromium at 16px of
   * blank below the last thing the player can read. The two values are asserted together
   * because cancelling the gap means naming it.
   */
  it("takes the panel's gap back off the notices while they have nothing to say", () => {
    const panel = /^\.start__panel\s*\{([^}]*)\}/m.exec(START_CSS)?.[1] ?? "";
    const empty = /^\.start__notices:empty\s*\{([^}]*)\}/m.exec(START_CSS)?.[1] ?? "";

    expect(panel).toContain("gap: var(--space-4)");
    expect(empty).toContain("margin-top: calc(var(--space-4) * -1)");
  });

  it("leaves no operable element without an accessible name", () => {
    const storage = fakeStorage();
    storage.setItem(`${SAVE_KEY_PREFIX}autosave`, aPlayedGame());
    aColdStart({ storage });

    expect(unnamedOperables(document.body)).toEqual([]);
    fireEvent.click(named("New Game"));
    expect(unnamedOperables(document.body)).toEqual([]);
    fireEvent.click(named("Back"));
    fireEvent.click(named("Licences & source"));
    expect(unnamedOperables(document.body)).toEqual([]);
  });
});

describe("the licences surface", () => {
  const stamped: LicenceDocument = licenceDocument({
    notice: NOTICE,
    commit: "0".repeat(39) + "f",
    dirty: false,
    source: "https://example.invalid/singularity-web",
  });

  it("reproduces NOTICE rather than paraphrasing it", () => {
    aColdStart();

    fireEvent.click(named("Licences & source"));

    const shown = document.body.textContent ?? "";
    for (const heading of ["The port", "Upstream", "Carried-in assets", "Source offer"]) {
      expect(shown).toContain(heading);
    }
    expect(shown).toContain("GNU General Public License");
    expect(shown).toContain("Natural Earth 1:110m land");
    expect(shown).toContain("SIL Open Font License 1.1");
  });

  it("is stamped with the commit the bundle was built from", () => {
    aColdStart();

    fireEvent.click(named("Licences & source"));

    expect(screen.getByText(realLicences.commit).textContent).toMatch(/^[0-9a-f]{40}$/);
  });

  // GPL-2.0 §3 asks for the source of what was *served*. A branch moves and the bundle in
  // the player's browser does not, so the link resolves to a commit and never to a branch.
  // The address and the commit, side by side, are what answer GPL-2.0 §3: a public
  // repository makes every commit reachable from its root, so the page does not have to
  // build a URL and does not.
  it("links the source the build named, and prints the commit beside it", () => {
    aColdStart({ licences: stamped });

    fireEvent.click(named("Licences & source"));
    const link = screen.getByRole("link", { name: stamped.source as string });

    expect(link.getAttribute("href")).toBe("https://example.invalid/singularity-web");
    expect(document.body.textContent).toContain(stamped.commit);
  });

  it("names the commit anyway when the build was given nowhere to link to", () => {
    aColdStart({ licences: { ...stamped, source: undefined } });

    fireEvent.click(named("Licences & source"));

    expect(document.body.textContent).toContain("Not published");
    expect(screen.getByText(stamped.commit)).toBeTruthy();
  });

  it("goes back to the start screen it was opened from", () => {
    aColdStart();

    fireEvent.click(named("Licences & source"));
    fireEvent.click(named("Back"));

    expect(named("New Game")).toBeTruthy();
  });

  /**
   * This surface carries none of the cold start's notices, and that is the
   * decision rather than an omission. Nothing here can raise one — the document is built into
   * the bundle — so no sentence is lost, and the one the cold start raised is still standing
   * one Back away. That is the half worth pinning: the notices survive the round trip.
   */
  it("leaves the cold start's notices on the screen it was opened from", () => {
    const storage = fakeStorage();
    storage.setItem(`${SAVE_KEY_PREFIX}autosave`, fromAnotherBuild());
    aColdStart({ storage });
    const said = 'The save in "autosave" was left alone';

    fireEvent.click(named("Licences & source"));
    expect(document.body.textContent).not.toContain(said);

    fireEvent.click(named("Back"));
    expect(screen.getByRole("list", { name: "Notices" }).textContent).toContain(said);
  });
});
