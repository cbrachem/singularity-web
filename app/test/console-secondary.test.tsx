import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fireEvent, screen } from "@testing-library/preact";
import realLicences from "virtual:licences";
import { afterEach, describe, expect, it } from "vitest";

import { MOUNT_SELECTOR, boot } from "../src/boot.tsx";
import { coldStart, type Begin } from "../src/cold-start.tsx";
import { createAutosave } from "../src/host/autosave.ts";
import { createSaveStore } from "../src/host/save-store.ts";
import { reachableOperables, unnamedOperables } from "./support/accessible-names.ts";
import { fakeFrames } from "./support/frames.ts";
import { fakeStorage, type FakeStorage } from "./support/storage.ts";

/**
 * The app seam, entered at the console: the licences surface, opened from inside a running
 * game rather than from the start screen.
 *
 * It is the same component the start screen opens — the point is that it is mounted a second
 * time rather than written a second time — so what is asserted here is what only the console
 * can be asked: that it opens over the console and closes back to it.
 *
 * The save list was the other surface the console opened, and it is gone with the named-save
 * surface itself. What is left of it here is the assertion that the console
 * offers no way to it.
 */

const NOTICE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "NOTICE"),
  "utf8",
);

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  document.body.innerHTML = "";
});

function aColdStart(storage: FakeStorage = fakeStorage()): void {
  document.body.innerHTML = `<div id="${MOUNT_SELECTOR.slice(1)}"></div>`;
  const store = createSaveStore(storage);

  const begin: Begin = (session, options = {}) => {
    const frames = fakeFrames();
    const booted = boot({
      into: document,
      frames,
      session,
      // The autosave the real page keeps (`main.tsx`), on this game's own clock.
      ...(options.autosaves === false
        ? {}
        : {
            autosave: createAutosave({
              snapshot: () => session.current,
              store,
              now: () => frames.now() / 1000,
            }),
          }),
      ...(options.licences && { licences: options.licences }),
      ...(options.onLeave && { onLeave: options.onLeave }),
      ...(options.onRefusal && { onRefusal: options.onRefusal }),
    });
    stops.push(booted.host.stop);
    return booted;
  };

  coldStart({ into: document, store, startDay: 0, licences: realLicences, begin });
}

const named = (name: string): HTMLElement => screen.getByRole("button", { name });

const consoleSurface = (): HTMLElement | null => screen.queryByRole("region", { name: "Console" });

/** A new game, started from the start screen, with its console open. */
function aGameWithTheConsoleOpen(storage?: FakeStorage): void {
  aColdStart(storage);
  fireEvent.click(named("New Game"));
  fireEvent.click(named("NORMAL"));
  fireEvent.click(named("Console"));
}

describe("the licences surface, opened from the console", () => {
  it("opens over the console and closes back to it", () => {
    aGameWithTheConsoleOpen();

    fireEvent.click(named("Licences & source"));
    const surface = screen.getByRole("region", { name: "Licences and source" });
    expect(surface).toBeTruthy();
    // Opaque and full height to the reserved band, which is what takes the console it was
    // opened from out of reach behind it.
    expect(surface.getAttribute("data-opaque")).toBe("true");
    expect(reachableOperables(document.body).some((element) => element.closest(".console"))).toBe(
      false,
    );

    fireEvent.click(named("Back"));

    expect(screen.queryByRole("region", { name: "Licences and source" })).toBe(null);
    expect(consoleSurface()).toBeTruthy();
  });

  it("takes Escape from the console while it is the surface in front", () => {
    aGameWithTheConsoleOpen();
    fireEvent.click(named("Licences & source"));

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("region", { name: "Licences and source" })).toBe(null);
    expect(consoleSurface()).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(consoleSurface()).toBe(null);
  });

  // The same document the start screen shows, because it is the same surface over the same
  // generated module and not a second copy of the prose.
  it("reproduces the same NOTICE the start screen reproduces", () => {
    aGameWithTheConsoleOpen();

    fireEvent.click(named("Licences & source"));

    const shown = document.body.textContent ?? "";
    for (const heading of ["The port", "Upstream", "Carried-in assets", "Source offer"]) {
      expect(shown).toContain(heading);
      expect(NOTICE).toContain(heading);
    }
    expect(screen.getByText(realLicences.commit).textContent).toMatch(/^[0-9a-f]{40}$/);
  });

  // The save list was the console's other entry. One autosave slot is the whole
  // of saving, so there is no list to open and no entry beside Licences & source to open it.
  it("offers no way to a save list, and no save list to reach", () => {
    aGameWithTheConsoleOpen();

    for (const gone of [/load/i, /save/i, /export/i, /import/i]) {
      expect(screen.queryByRole("button", { name: gone })).toBeNull();
    }
    expect(screen.queryByRole("region", { name: "Saves" })).toBeNull();
  });

  it("leaves no operable element without an accessible name", () => {
    aGameWithTheConsoleOpen();
    expect(unnamedOperables(document.body)).toEqual([]);

    fireEvent.click(named("Licences & source"));

    expect(unnamedOperables(document.body)).toEqual([]);
  });
});
