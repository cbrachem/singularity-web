import { signal } from "@preact/signals";
import {
  applyCommand,
  createInitialState,
  type Command,
  type SimulationState,
} from "@singularity/sim";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { Speed } from "../src/host/tick-partition.ts";
import { App } from "../src/ui/App.tsx";
import { ESTATE_HOTKEYS } from "../src/ui/estate.ts";
import { hotkeyMark } from "../src/ui/Hotkey.tsx";
import { shortcutsOn } from "../src/ui/shortcuts.ts";
import { SPEED_HOTKEYS } from "../src/ui/SpeedControl.tsx";

/**
 * Every shortcut the shell answers to is printed somewhere the player can read it.
 *
 * The shell had seven and told the player about two. `0`–`4` and Escape were listed in the
 * console's Settings tab, three clicks from the map they operate; the five in `ESTATE_HOTKEYS`
 * were in the source and nowhere else — no label, no tooltip, no attribute — and two of them
 * change what the player owns. A shortcut nobody can find is not a shortcut, and nothing in
 * the repository noticed, because a key that works is a key that passes its own test.
 *
 * So the guard is over the *vocabulary* rather than over a list written by hand here: it reads
 * `ESTATE_HOTKEYS` and `SPEED_HOTKEYS` and requires each of them to reach a control that says
 * so. Add a sixth estate key and this fails until the control carries it.
 */
afterEach(cleanup);

/** The app seam: the shell booted from a State root, driven by accessible name. */
function mount() {
  const published = signal(createInitialState({ seed: 7, difficulty: "normal" }));
  const speed = signal<Speed>(1);
  const container = render(
    <App
      state={published}
      speed={speed}
      onCommand={(command: Command) => {
        published.value = applyCommand(published.value, command);
      }}
    />,
  ).container;
  return { container, published, speed };
}

function basesAt(state: SimulationState, locationId: string): number {
  return state.locations.find((candidate) => candidate.specId === locationId)?.bases.length ?? 0;
}

/** The shortcuts the shell has, as the shell itself spells them. */
const EVERY_HOTKEY: readonly string[] = [...Object.values(ESTATE_HOTKEYS), ...SPEED_HOTKEYS.keys()];

function keyShortcutsOn(root: ParentNode): Set<string> {
  return new Set(
    [...root.querySelectorAll("[aria-keyshortcuts]")].map(
      (element) => element.getAttribute("aria-keyshortcuts") as string,
    ),
  );
}

describe("the shell's keyboard", () => {
  it("puts every shortcut on a control, as an attribute and as a mark", () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole("button", { name: "EUROPE" }));
    // The destroy control only exists once there is something at the location to destroy,
    // and the bulk row it sits in lives behind the Bulk actions disclosure.
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    fireEvent.click(screen.getByRole("button", { name: "Bulk actions" }));

    const carried = keyShortcutsOn(container);
    for (const key of EVERY_HOTKEY) {
      expect(carried, `no control carries aria-keyshortcuts="${key}"`).toContain(key);
    }

    // And what a driver is told is what a player is shown, on the same control.
    for (const control of container.querySelectorAll("[aria-keyshortcuts]")) {
      const key = control.getAttribute("aria-keyshortcuts") as string;
      const mark = control.querySelector("kbd");
      /*
       * The dial's two buttons are the exception: their whole label is the sign already, so a
       * mark beside it would print it twice. They are also where the difference between a
       * glyph and a key shows — the button prints `−`, the arithmetic sign, and the key is
       * the hyphen a keyboard actually has. The console's key list is what says so, which is
       * the next test.
       */
      if (key === ESTATE_HOTKEYS.more || key === ESTATE_HOTKEYS.fewer) {
        expect(control.textContent?.trim()).toBe(key === ESTATE_HOTKEYS.more ? "+" : "−");
        continue;
      }
      expect(mark, `${key} has an attribute but no mark`).toBeTruthy();
      expect(mark?.textContent).toBe(hotkeyMark(key));
    }
  });

  it("reads them all out together in one place as well", () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Console" }));
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));

    const list = container.querySelector(".console__keys");
    expect(list).toBeTruthy();
    const written = list?.textContent ?? "";
    for (const key of EVERY_HOTKEY) {
      expect(written, `the key list does not mention ${key}`).toContain(hotkeyMark(key));
    }
  });

  /**
   * The marks are decoration for assistive technology: every control carrying one already has
   * an accessible name for the action and `aria-keyshortcuts` for the key, which is the form a
   * screen reader is built to announce. A `kbd` left in the accessible name would have the
   * destroy button read as "Destroy 2 D".
   */
  it("keeps the marks out of the accessible names", () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole("button", { name: "EUROPE" }));
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    fireEvent.click(screen.getByRole("button", { name: "Bulk actions" }));

    for (const mark of container.querySelectorAll("kbd.hotkey")) {
      expect(mark.getAttribute("aria-hidden")).toBe("true");
    }
    expect(screen.getByRole("button", { name: "Select all bases" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build bases" })).toBeTruthy();
  });
});

/**
 * WCAG 2.1.4: a shortcut made of one unmodified character fires under speech input and under a
 * tremor, and two of this shell's destroy what the player owns. The criterion is met by an off
 * switch, which is in the console's Settings tab beside the list of the keys it governs — the
 * alternatives are a modifier or a remap, and both would be a different keyboard from the one
 * the reference documents (`shortcuts.ts`).
 */
describe("the off switch for the single-character shortcuts", () => {
  // The preference is a module signal, so it outlives one render: every case here starts from
  // the default the player is given.
  afterEach(() => {
    shortcutsOn.value = true;
  });

  function turnOff(): void {
    fireEvent.click(screen.getByRole("button", { name: "Console" }));
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Single-key shortcuts" }));
    fireEvent.click(screen.getByRole("button", { name: "Close console" }));
  }

  it("stops every one of them, and leaves Escape alone", () => {
    const { container, published, speed } = mount();

    // On by default: a digit is the speed, and `b` at a location is an order.
    fireEvent.keyDown(document, { key: "2" });
    expect(speed.value).toBe(60);
    fireEvent.click(screen.getByRole("button", { name: "EUROPE" }));
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.build });
    expect(basesAt(published.value, "EUROPE")).toBe(1);
    fireEvent.keyDown(document, { key: "Escape" });

    turnOff();

    fireEvent.keyDown(document, { key: "0" });
    expect(speed.value).toBe(60);
    fireEvent.click(screen.getByRole("button", { name: "EUROPE" }));
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.build });
    expect(basesAt(published.value, "EUROPE")).toBe(1);

    // Escape is a named key rather than a character, and it is the one way out of every
    // surface the shell draws. It keeps working.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBe(null);
    expect(container).toBeTruthy();
  });

  it("takes every claim to a key off the screen with them", () => {
    const { container } = mount();
    turnOff();
    fireEvent.click(screen.getByRole("button", { name: "EUROPE" }));
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    fireEvent.click(screen.getByRole("button", { name: "Bulk actions" }));

    // Neither the mark a player reads nor the attribute a screen reader is told: an offer of a
    // key that does nothing is the shell saying something untrue.
    expect(container.querySelectorAll("kbd.hotkey").length).toBe(0);
    expect(container.querySelectorAll("[aria-keyshortcuts]").length).toBe(0);

    // The controls themselves are untouched — the keys were the shortcut, not the way in.
    expect(screen.getByRole("button", { name: "Build bases" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Destroy selected bases" })).toBeTruthy();
  });
});
