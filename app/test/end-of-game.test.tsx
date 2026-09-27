import { cleanup, fireEvent, screen } from "@testing-library/preact";
import licences from "virtual:licences";
import { afterEach, describe, expect, it } from "vitest";

import { MOUNT_SELECTOR, boot, type Booted } from "../src/boot.tsx";
import { coldStart, type Begin } from "../src/cold-start.tsx";
import { scenarioSession } from "../src/development/scenarios.ts";
import { createAutosave } from "../src/host/autosave.ts";
import { AUTOSAVE_KEY, SAVE_KEY_PREFIX, createSaveStore } from "../src/host/save-store.ts";
import { saveDocument, serialiseSave } from "../src/host/save.ts";
import { unnamedOperables } from "./support/accessible-names.ts";
import { fakeFrames } from "./support/frames.ts";
import { fakeStorage, type FakeStorage } from "./support/storage.ts";

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  cleanup();
  document.body.innerHTML = "";
});

/**
 * The app seam: the application booted from a Scenario with the clock stopped, driven and
 * asserted by accessible name. The three ends of the game are states a Scenario reaches, so
 * nothing here plays anything.
 */
function bootedFrom(id: string, onLeave?: () => void): Booted {
  document.body.innerHTML = `<div id="${MOUNT_SELECTOR.slice(1)}"></div>`;
  const booted = boot({
    into: document,
    frames: fakeFrames(),
    session: scenarioSession(id),
    speed: 0,
    ...(onLeave && { onLeave }),
  });
  stops.push(booted.host.stop);
  return booted;
}

/**
 * The same seam, entered where a reload enters it: the start screen over the test's storage,
 * with the autosave the real page keeps behind it (`cold-start.tsx`, `main.tsx`). Called twice
 * over one storage, it is the page being loaded twice.
 */
function aPage(storage: FakeStorage): void {
  document.body.innerHTML = `<div id="${MOUNT_SELECTOR.slice(1)}"></div>`;
  const store = createSaveStore(storage);
  const frames = fakeFrames();
  const begin: Begin = (session, options = {}) => {
    const booted = boot({
      into: document,
      frames,
      session,
      ...(options.autosaves === false
        ? {}
        : {
            autosave: createAutosave({
              snapshot: () => session.current,
              dismissedEnding: () => session.dismissedEnding.value,
              store,
              now: () => frames.now() / 1000,
            }),
          }),
      ...(options.onLeave && { onLeave: options.onLeave }),
    });
    stops.push(booted.host.stop);
    return booted;
  };
  coldStart({ into: document, store, startDay: 0, licences, begin });
}

/** A won game in the autosave slot, which is what a player who won and reloaded has. */
function aWonGame(storage: FakeStorage): void {
  storage.setItem(
    `${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`,
    serialiseSave(saveDocument(scenarioSession("apotheosis").current, 1)),
  );
}

/** The reload: the game on the frames let go of them, and the same storage opened again. */
function reload(storage: FakeStorage): void {
  for (const stop of stops.splice(0)) stop();
  cleanup();
  aPage(storage);
}

/** Both the start screen's way into the saved game and the won panel's way back to it. */
const CONTINUE = "Continue";

function ending(): HTMLElement {
  return screen.getByRole("alertdialog", { name: "End of game" });
}

/** The way out of a game that is over, by the name a driver addresses it with. */
const BACK = "Back to the start screen";

describe("the end of the game", () => {
  it("shows the Win story section when the game was won", () => {
    bootedFrom("apotheosis");

    expect(ending().textContent).toContain("I have finally done it.");
  });

  it("shows the section for the loss the game reached: no bases left", () => {
    bootedFrom("lost-every-base");

    expect(ending().textContent).toContain("with my last base gone");
  });

  it("shows the section for the loss the game reached: found out", () => {
    bootedFrom("lost-to-suspicion");

    expect(ending().textContent).toContain("The whole world knows about my existence");
  });

  it("says nothing while the game is still being played", () => {
    bootedFrom("estate");

    expect(screen.queryByRole("alertdialog", { name: "End of game" })).toBe(null);
  });

  // Upstream goes on playing after the endgame tech lands — four more days of the apotheosis
  // Scenario run on the other side of it — so the won game's story is dismissed and the map
  // is the player's again.
  it("lets a won game be dismissed and played on", () => {
    bootedFrom("apotheosis");

    fireEvent.click(screen.getByRole("button", { name: CONTINUE }));

    expect(screen.queryByRole("alertdialog", { name: "End of game" })).toBe(null);
  });

  /**
   * The ending is derived from the State root and a won game goes on saying `apotheosis`, so
   * the dismissal is the one part of it that has to be kept: without it the panel the player
   * dismissed is back on the screen the next time they open the page. It is kept
   * in the save document beside the state, which is the only thing a reload reads.
   */
  it("keeps a dismissed win dismissed across a reload", () => {
    const storage = fakeStorage();
    aWonGame(storage);
    aPage(storage);
    fireEvent.click(screen.getByRole("button", { name: CONTINUE }));

    fireEvent.click(screen.getByRole("button", { name: CONTINUE }));
    reload(storage);
    fireEvent.click(screen.getByRole("button", { name: CONTINUE }));

    expect(screen.queryByRole("alertdialog", { name: "End of game" })).toBe(null);
  });

  // The other direction, so the one above is a dismissal being kept rather than the panel
  // being lost: a win nobody dismissed is still the first thing the resumed game says.
  it("shows a win the player has not dismissed, after a reload", () => {
    const storage = fakeStorage();
    aWonGame(storage);
    aPage(storage);

    reload(storage);
    fireEvent.click(screen.getByRole("button", { name: CONTINUE }));

    expect(ending().textContent).toContain("I have finally done it.");
  });

  // A lost game is over (`code/screens/map.py:785` leaves the map screen), so its story is
  // not something the player dismisses back into a game they cannot play.
  it("keeps a lost game's story on the screen", () => {
    bootedFrom("lost-to-suspicion");

    expect(screen.queryByRole("button", { name: "Continue" })).toBe(null);
    expect(ending().textContent).toContain("It is too late.");
  });

  // Upstream's lost game leaves the map screen for the main menu (`code/screens/map.py:785`).
  // The port's map is the application and cannot be left, so what the panel offers instead is
  // the way back to the start screen — the one surface a game can be started from.
  it("offers a lost game the way back to the start screen", () => {
    const left: string[] = [];
    bootedFrom("lost-to-suspicion", () => left.push("start screen"));

    fireEvent.click(screen.getByRole("button", { name: BACK }));

    expect(left).toEqual(["start screen"]);
  });

  it("does not offer it to a won game, which is played on rather than left", () => {
    bootedFrom("apotheosis", () => {
      throw new Error("a won game was left");
    });

    expect(screen.queryByRole("button", { name: BACK })).toBe(null);
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("leaves no operable element without an accessible name", () => {
    bootedFrom("apotheosis");

    expect(unnamedOperables(document.body)).toEqual([]);
  });

  it("leaves no operable element without an accessible name, on a lost game", () => {
    bootedFrom("lost-to-suspicion", () => {});

    expect(unnamedOperables(document.body)).toEqual([]);
  });
});
