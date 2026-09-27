import { signal } from "@preact/signals";
import {
  WIN,
  applyCommand,
  createInitialState,
  type Command,
  type SimulationState,
} from "@singularity/sim";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { Notification as NotificationState } from "../src/host/notifications.ts";
import type { Speed } from "../src/host/tick-partition.ts";
import { App } from "../src/ui/App.tsx";
import { ESTATE_HOTKEYS } from "../src/ui/estate.ts";
import type { LicenceDocument } from "../src/ui/licences/document.ts";
import { accessibleName, reachableOperables } from "./support/accessible-names.ts";

afterEach(cleanup);

/**
 * The app seam: the shell booted from a State root, driven by accessible name and by key.
 * Nothing here reaches inside a component.
 *
 * One question, asked of every transient surface the shell draws: while it is up, what does
 * it own? The answer these assert: the surface in front of the player owns the
 * keyboard, and a surface that claims modality owns the pointer and the focus as well.
 */
function mount(
  initial: SimulationState = newGame(),
  { dismissable = true, licences }: { dismissable?: boolean; licences?: LicenceDocument } = {},
) {
  const published = signal(initial);
  const speed = signal<Speed>(1);
  const notification = signal<NotificationState | null>(null);
  const commands: Command[] = [];
  const container = render(
    <App
      state={published}
      speed={speed}
      notification={notification}
      {...(licences ? { licences } : {})}
      {...(dismissable
        ? {
            onDismissNotification: () => {
              notification.value = null;
            },
          }
        : {})}
      onCommand={(command) => {
        commands.push(command);
        published.value = applyCommand(published.value, command);
      }}
    />,
  ).container;
  return { commands, container, published, speed, notification };
}

function newGame(): SimulationState {
  return createInitialState({ seed: 7, difficulty: "normal" });
}

/** A document with nothing in it, which is all the licences surface needs to be a surface. */
function emptyLicences(): LicenceDocument {
  return { commit: "0".repeat(40), dirty: false, source: undefined, preamble: "", sections: [] };
}

/** Where the player is, as the two assertions below ask it: which surface, and behind what. */
function landed(): { surface: string | null; marked: boolean } {
  const active = document.activeElement ?? document.body;
  const surface =
    ["console", "licences"].find((name) => active.closest(`.${name}`) !== null) ?? null;
  return { surface, marked: active.closest("[inert]") !== null };
}

/** The state root of a game that has been won, which is the end that goes on being played. */
function won(): SimulationState {
  return { ...newGame(), apotheosis: true };
}

function basesAt(state: SimulationState, locationId: string) {
  const location = state.locations.find((candidate) => candidate.specId === locationId);
  if (!location) throw new Error(`no such location: ${locationId}`);
  return location.bases;
}

function ending(): HTMLElement {
  return screen.getByRole("alertdialog", { name: "End of game" });
}

function names(elements: readonly HTMLElement[]): string[] {
  return elements.map(accessibleName);
}

describe("the surface in front of the player", () => {
  // The ending is dismissible and the game goes on afterwards, so a digit reaching the Speed
  // through it is the clock being set from a surface that shows no clock.
  it("keeps the speed hotkeys from the map while the ending is up", () => {
    const { speed } = mount(won());
    expect(ending()).toBeTruthy();

    fireEvent.keyDown(document, { key: "0" });

    expect(speed.value).toBe(1);

    // And the map has them back the moment the ending is gone, or this asserts nothing.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.keyDown(document, { key: "0" });
    expect(speed.value).toBe(0);
  });

  // The shell does not close the inspector when the game ends, so `b`, `a` and `d` would
  // otherwise stay live behind the ending: keying them would order and destroy bases through
  // a surface that shows neither a base list nor a build control.
  it("keeps the estate hotkeys from the inspector while the ending is over it", () => {
    const { commands, published, speed } = mount();
    fireEvent.click(screen.getByRole("button", { name: "EUROPE" }));
    fireEvent.click(screen.getByRole("button", { name: "More bases" }));
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    expect(basesAt(published.value, "EUROPE").length).toBe(2);

    // The game ends under the open inspector, the way a Tick ends it.
    act(() => {
      published.value = { ...published.value, apotheosis: true };
    });
    expect(ending()).toBeTruthy();

    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.build });
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.selectAll });
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.destroy });
    fireEvent.keyDown(document, { key: "0" });

    // The two the player ordered, and nothing the keys did behind the ending.
    expect(commands.length).toBe(2);
    expect(basesAt(published.value, "EUROPE").length).toBe(2);
    expect(speed.value).toBe(1);

    // One rule, read from both places. Dismissing the ending hands the keyboard to the
    // inspector, which is what is in front now — so `b` builds again and the digits still
    // are not the map's, because the map is still not the surface in front of the player.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.build });
    fireEvent.keyDown(document, { key: "0" });
    expect(commands.length).toBe(4);
    expect(speed.value).toBe(1);

    // Closing the inspector puts the map in front, and the digits are its own again.
    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    fireEvent.keyDown(document, { key: "0" });
    expect(speed.value).toBe(0);
  });

  // `aria-modal="true"` tells assistive technology that everything else is unavailable. The
  // panel is a centred box, so without this the map, the HUD and the speed control stay
  // clickable underneath a dialog that says they are not.
  it("puts everything the shell drew behind a modal surface out of reach", () => {
    const { container } = mount(won());

    expect(names(reachableOperables(container))).toEqual(["Continue"]);
  });

  /**
   * The notification half of the shell's guard, which no test carried: it is the
   * one surface of the set that holds no text field, so "a digit typed into it is a digit" is
   * not the argument here. The argument is the same one as everywhere else — the game is
   * paused behind it, and setting the Speed of a game that is not running is a
   * setting made at a surface that shows no clock.
   */
  it("keeps the speed hotkeys from the map while a notification is up", () => {
    const { notification, speed } = mount();
    act(() => {
      notification.value = { kind: "story", sectionId: WIN };
    });

    fireEvent.keyDown(document, { key: "0" });

    expect(speed.value).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    fireEvent.keyDown(document, { key: "0" });
    expect(speed.value).toBe(0);
  });

  it("does the same for the notification, the other alertdialog", () => {
    const { container, notification } = mount();
    fireEvent.click(screen.getByRole("button", { name: "EUROPE" }));
    expect(reachableOperables(container).length).toBeGreaterThan(1);

    act(() => {
      notification.value = { kind: "story", sectionId: WIN };
    });

    expect(names(reachableOperables(container))).toEqual(["Dismiss notification"]);
  });

  // A screen reader user was told a modal opened and was left outside it.
  it("takes focus when it opens, keeps Tab inside it, and gives focus back", () => {
    const { notification } = mount();
    const research = screen.getByRole("button", { name: "Research/Tasks" });
    research.focus();

    act(() => {
      notification.value = { kind: "story", sectionId: WIN };
    });
    const panel = screen.getByRole("alertdialog", { name: "Notification" });
    expect(document.activeElement).toBe(panel);

    const dismiss = screen.getByRole("button", { name: "Dismiss notification" });
    fireEvent.keyDown(panel, { key: "Tab" });
    expect(document.activeElement).toBe(dismiss);
    fireEvent.keyDown(dismiss, { key: "Tab" });
    expect(document.activeElement).toBe(panel);
    fireEvent.keyDown(panel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(dismiss);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("alertdialog", { name: "Notification" })).toBe(null);
    // Focus goes back to a button that sits inside the grouping the shell marks inert while
    // the panel is up, and the shell is what gives it back — taken during the render before
    // the marking goes on, handed back in an Effect after it comes off (`ui/App.tsx`). The
    // order is the whole of it and happy-dom cannot see any of it: it implements no part of
    // `inert`, so it blurs nothing and refuses nothing, and the two errors this arrangement
    // replaced passed here in both directions. The browser's half is measured in
    // `app/test/viewport.test.ts`.
    expect(document.activeElement).toBe(research);
  });

  /**
   * The same lend, one level in, where the element the shell borrows from is behind an opaque
   * surface and cannot be given the focus back. A browser refuses it —
   * `focus()` into a marked subtree is refused, and the element is usually gone from the
   * focus anyway by then — and the player lands on `<body>` in front of a console the shell
   * was supposed to have chosen a landing place inside.
   *
   * happy-dom refuses nothing, so what is asserted here is the shell's *choice* rather than
   * the browser's answer: it does not offer the focus to something it has marked, and the
   * player lands inside the surface that is in front. The browser's half of route 1 is
   * measured in `app/test/viewport.test.ts`.
   */
  it("hands the focus into the console when the ending borrowed from behind it", () => {
    const { published } = mount();
    const opener = screen.getByRole("button", { name: "Console" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("region", { name: "Console" })).toBeTruthy();

    // What the console left behind it: the button that opened it, still holding the focus and
    // now inside the marking the console causes.
    expect(document.activeElement).toBe(opener);
    expect(opener.closest("[inert]")).not.toBe(null);

    // The game ends over the open console, the way a Tick ends it, and is continued.
    act(() => {
      published.value = { ...published.value, apotheosis: true };
    });
    expect(document.activeElement).toBe(ending());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(landed()).toEqual({ surface: "console", marked: false });
  });

  /** The third of the same shape: a notification over the surface the console opened. */
  it("hands the focus into the licences surface when a notification borrowed from behind it", () => {
    const { notification } = mount(newGame(), { licences: emptyLicences() });
    const opener = screen.getByRole("button", { name: "Console" });
    opener.focus();
    fireEvent.click(opener);
    const toLicences = screen.getByRole("button", { name: "Licences & source" });
    toLicences.focus();
    fireEvent.click(toLicences);
    expect(screen.getByRole("region", { name: "Licences and source" })).toBeTruthy();
    expect(document.activeElement).toBe(toLicences);
    expect(toLicences.closest("[inert]")).not.toBe(null);

    act(() => {
      notification.value = { kind: "story", sectionId: WIN };
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));

    expect(screen.getByRole("region", { name: "Licences and source" })).toBeTruthy();
    expect(landed()).toEqual({ surface: "licences", marked: false });
  });

  /**
   * The held notification is owed the focus half of modality when it finally arrives, rather
   * than never: the ending had the focus, the ending is dismissed, and
   * the surface that takes its place is a modal one that has to be told so.
   */
  it("takes focus when the ending it was held behind is dismissed", () => {
    const { notification } = mount(won());
    act(() => {
      notification.value = { kind: "story", sectionId: WIN };
    });
    expect(document.activeElement).toBe(ending());

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const panel = screen.getByRole("alertdialog", { name: "Notification" });
    expect(document.activeElement).toBe(panel);
    const dismiss = screen.getByRole("button", { name: "Dismiss notification" });
    fireEvent.keyDown(panel, { key: "Tab" });
    expect(document.activeElement).toBe(dismiss);
  });

  /**
   * The stack and the markup have to agree about what is up. The shell counted a notification
   * from the signal alone while the panel is drawn only where there is a way to dismiss one,
   * so a caller handing in one without the other got the worst of both: everything behind the
   * notification out of reach, and no notification drawn to reach instead.
   */
  it("has no notification in front of the player when there is no way to dismiss one", () => {
    const { container, notification, speed } = mount(newGame(), { dismissable: false });
    act(() => {
      notification.value = { kind: "story", sectionId: WIN };
    });

    expect(screen.queryByRole("alertdialog", { name: "Notification" })).toBe(null);
    expect(reachableOperables(container).length).toBeGreaterThan(1);

    // And the map is still the surface in front of the player, so the digits are still its.
    fireEvent.keyDown(document, { key: "0" });
    expect(speed.value).toBe(0);
  });

  /**
   * A surface that is opaque and full height to the reserved band takes what it
   * covers, whether or not it claims modality. The console paints over the whole shell, so a
   * player who cannot see the map, the HUD or an open inspector cannot Tab to them either,
   * and a screen reader is not offered them.
   *
   * It is the surface's own controls that are left, and nothing else: asserted as "everything
   * reachable is inside the console" rather than as a list, so the console growing a control
   * does not rewrite this.
   */
  it("puts everything an opaque surface covers out of reach", () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole("button", { name: "EUROPE" }));
    expect(names(reachableOperables(container))).toContain("Research/Tasks");

    fireEvent.click(screen.getByRole("button", { name: "Console" }));

    const reachable = reachableOperables(container);
    expect(reachable.length).toBeGreaterThan(0);
    expect(names(reachable.filter((element) => element.closest(".console") === null))).toEqual([]);

    // And the map has itself back the moment the console is gone, or this asserts nothing.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(names(reachableOperables(container))).toContain("EUROPE");
  });

  /**
   * The scrim is modality's, not coverage's: it exists to say that what is still visible
   * behind a centred panel is unavailable. An opaque surface has painted over all
   * of it already, so a scrim would dim nothing but itself.
   */
  it("draws no scrim for an opaque surface, and one for a modal surface", () => {
    const { container, notification } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Console" }));

    expect(container.querySelector(".shell-scrim")).toBe(null);

    act(() => {
      notification.value = { kind: "story", sectionId: WIN };
    });

    expect(container.querySelector(".shell-scrim")).toBeTruthy();
  });

  it("hands Escape to the front surface and no further", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "EUROPE" }));
    fireEvent.click(screen.getByRole("button", { name: "Research/Tasks" }));

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("region", { name: "Research/Tasks" })).toBe(null);
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBe(null);
  });

  /**
   * The ending is alone. A notification that is up when the game ends
   * used to be drawn behind the ending: two centred alertdialogs at once, the one behind
   * unreachable until the one in front was gone, and never dismissed while it sat there — so a
   * won game that was continued walked straight back into it.
   *
   * The shell holds the queue instead. Nothing is drawn and nothing is dismissed while the
   * ending is up; the notification arrives when the ending is dismissed, which only a won game
   * that is continued ever does. A lost game never dismisses it, so a notification queued at
   * the end of a lost game is never shown at all.
   *
   * The ending is also the surface Escape does not close: a lost game has nothing to be
   * dismissed into, and a won one is continued on purpose.
   */
  it("holds a notification while the ending is up and shows it when the ending is dismissed", () => {
    const { container, notification } = mount(won());
    act(() => {
      notification.value = { kind: "story", sectionId: WIN };
    });

    expect(screen.queryByRole("alertdialog", { name: "Notification" })).toBe(null);
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(ending()).toBeTruthy();
    expect(names(reachableOperables(container))).toEqual(["Continue"]);

    // Continuing the won game is what lets the held notification through, and it is still the
    // same one: the shell held the queue rather than dismissing it.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("alertdialog", { name: "Notification" })).toBeTruthy();
    expect(names(reachableOperables(container))).toEqual(["Dismiss notification"]);
    expect(notification.value).toEqual({ kind: "story", sectionId: WIN });
  });
});
