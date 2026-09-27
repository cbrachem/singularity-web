import { signal } from "@preact/signals";
import { applyCommand, createInitialState, type Command } from "@singularity/sim";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SAVE_KEY_PREFIX } from "../src/host/save-store.ts";
import type { Speed } from "../src/host/tick-partition.ts";

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
});

// The app seam, with one addition the other files here do not need: a reload. The preference
// is a module signal (`shortcuts.ts`), so the honest model of a page load is a fresh module
// graph — `vi.resetModules()` and an `import()` — and everything the player does is still done
// by accessible name on the shell that graph mounts.

/** A page load: the modules read again, and the shell mounted on a new game. */
async function load() {
  vi.resetModules();
  const { App } = await import("../src/ui/App.tsx");
  const published = signal(createInitialState({ seed: 7, difficulty: "normal" }));
  const speed = signal<Speed>(1);
  const commands: Command[] = [];
  render(
    <App
      state={published}
      speed={speed}
      onCommand={(command) => {
        commands.push(command);
        published.value = applyCommand(published.value, command);
      }}
    />,
  );
  return { commands, speed };
}

function shortcutBox(): HTMLInputElement {
  fireEvent.click(screen.getByRole("button", { name: "Console" }));
  fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
  return screen.getByRole("checkbox", { name: "Single-key shortcuts" }) as HTMLInputElement;
}

function closeConsole(): void {
  fireEvent.click(screen.getByRole("button", { name: "Close console" }));
}

function savedKeys(): readonly string[] {
  return Object.keys(localStorage).filter((key) => key.startsWith(SAVE_KEY_PREFIX));
}

/**
 * WCAG 2.1.4's off switch is worth what it remembers: a player who needs the single-character
 * keys off needs them off every session, and the switch was a module signal nothing wrote down.
 */
describe("the single-key shortcut preference", () => {
  it("is still off after a reload", async () => {
    await load();
    fireEvent.click(shortcutBox());
    closeConsole();
    cleanup();

    const reloaded = await load();
    expect(shortcutBox().checked).toBe(false);
    closeConsole();

    fireEvent.keyDown(document, { key: "2" });
    expect(reloaded.speed.value).toBe(1);
  });

  it("is still on after a reload when the player turns it back on", async () => {
    await load();
    fireEvent.click(shortcutBox());
    fireEvent.click(shortcutBox());
    closeConsole();
    cleanup();

    const reloaded = await load();
    expect(shortcutBox().checked).toBe(true);
    closeConsole();

    fireEvent.keyDown(document, { key: "2" });
    expect(reloaded.speed.value).toBe(60);
  });

  it("comes up on for a player who has never touched it", async () => {
    const { speed } = await load();

    expect(shortcutBox().checked).toBe(true);
    closeConsole();
    fireEvent.keyDown(document, { key: "2" });
    expect(speed.value).toBe(60);
  });

  /*
   * It is a per-viewer convenience and never game state, so it lives in its own key beside the
   * saves rather than inside one. A preference in the save document would ride the save's
   * version rule — a format change retires every player's autosave, and it would
   * take their accessibility setting with it — and it could only be written by writing the
   * save, which a Scenario boot must not do in either direction.
   */
  it("is written beside the saves and never into one", async () => {
    await load();
    fireEvent.click(shortcutBox());

    expect(savedKeys()).toEqual([]);
    expect(localStorage.getItem("singularity.shortcuts")).toBe("off");
  });
});
