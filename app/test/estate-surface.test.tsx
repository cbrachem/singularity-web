import { signal, type Signal } from "@preact/signals";
import {
  CASH,
  CPU,
  allBases,
  applyCommand,
  createInitialState,
  toPlain,
  type Command,
  type SimulationState,
} from "@singularity/sim";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Speed } from "../src/host/tick-partition.ts";
import { App } from "../src/ui/App.tsx";
import { ESTATE_HOTKEYS } from "../src/ui/estate.ts";
import { DESTROY_CONFIRM_TIMEOUT_MS } from "../src/ui/Inspector.tsx";
import { SPEED_HOTKEYS } from "../src/ui/SpeedControl.tsx";
import { unnamedOperables } from "./support/accessible-names.ts";
import { choose } from "./support/choose.ts";

afterEach(cleanup);

// The app seam: the shell booted from a State root, driven by accessible name. Nothing here
// reaches inside a component, and nothing here asks the Simulation for a bulk command —
// there is none. A bulk action decomposes into the commands that already exist, and the
// sequence is what these tests assert.

function state(): SimulationState {
  return createInitialState({ seed: 7, difficulty: "normal" });
}

function mount(initial = state()) {
  const published = signal(initial);
  const commands: Command[] = [];
  const container = render(
    <App
      state={published}
      speed={signal<Speed>(1)}
      onCommand={(command) => {
        commands.push(command);
        published.value = applyCommand(published.value, command);
      }}
    />,
  ).container;
  return { commands, container, published };
}

function inspect(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

function quantity(wanted: number): void {
  for (let step = 1; step < wanted; step += 1) {
    fireEvent.click(screen.getByRole("button", { name: "More bases" }));
  }
}

function basesAt(state: SimulationState, locationId: string) {
  const location = state.locations.find((candidate) => candidate.specId === locationId);
  if (!location) throw new Error(`no such location: ${locationId}`);
  return location.bases;
}

function readout(name: string): string {
  return screen.getByRole("status", { name }).textContent ?? "";
}

/** A control's own words, without the key mark printed on it (`Hotkey.tsx`). */
function labelOf(control: HTMLElement): string {
  return [...control.childNodes]
    .filter((node) => !(node instanceof HTMLElement && node.tagName === "KBD"))
    .map((node) => node.textContent)
    .join("")
    .trim();
}

function isChecked(name: string): boolean {
  return (screen.getByRole("checkbox", { name }) as HTMLInputElement).checked;
}

/**
 * A base taken out of the game by something that is not the player: a maintenance failure or
 * a discovery, both of which the shell already draws a notification for. It is published
 * straight onto the signal, because that is what the Host does with the root a Tick hands
 * back — the player's selection is never asked first.
 */
function worldRemoves(published: Signal<SimulationState>, locationId: string, index: number): void {
  act(() => {
    published.value = applyCommand(published.value, {
      command: "destroyBase",
      location: locationId,
      base: index,
    });
  });
}

describe("the quantity dial", () => {
  it("issues that many build commands, in order, and no other command", () => {
    const { commands, published } = mount();
    inspect("EUROPE");
    quantity(3);

    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));

    expect(commands).toEqual([
      { command: "buildBase", location: "EUROPE", baseType: "Server Access" },
      { command: "buildBase", location: "EUROPE", baseType: "Server Access" },
      { command: "buildBase", location: "EUROPE", baseType: "Server Access" },
    ]);
    expect(basesAt(published.value, "EUROPE").length).toBe(3);
  });

  it("spends nothing at the moment of the click and asks for no confirmation", () => {
    const { commands, published } = mount();
    const before = published.value.cash;
    inspect("EUROPE");
    quantity(4);

    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));

    // Four commands are already out: there is no confirm step between the click and them.
    expect(commands.length).toBe(4);
    expect(published.value.cash).toBe(before);
    expect(basesAt(published.value, "EUROPE").every((base) => !base.buyable.done)).toBe(true);
  });

  it("projects the flow the order will draw, and the projection is what the order costs", () => {
    const { published } = mount();
    inspect("EUROPE");
    quantity(3);

    const projectedCash = readout("Projected construction cash");
    const projectedMaintenance = readout("Projected maintenance cash");
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));

    const built = basesAt(published.value, "EUROPE");
    const cash = built.reduce((total, base) => total + (base.buyable.costLeft[CASH] ?? 0), 0);
    const upkeep = built.reduce((total, base) => total + (base.maintenance[CASH] ?? 0), 0);
    expect(cash).toBe(300);
    expect(projectedCash).toBe("300");
    expect(projectedMaintenance).toBe(String(upkeep));
  });

  /**
   * The order as the *flow* sees it, which is a different question from what it costs.
   *
   * `compute_future_resource_flow` takes what the player is considering as an argument and
   * returns where the next day goes with it in the queue. The HUD asks with an
   * empty hypothetical; the dial asks with its own order, so the two readouts side by side
   * are the day the player has and the day the button would buy them.
   */
  it("says what the order would do to the day's flow, not only what it draws", () => {
    mount();
    inspect("EUROPE");
    quantity(3);

    // A new game earns five a day and owes nothing, so that is the flow beside the pool.
    expect(readout("Cash flow")).toBe("5");
    // Three Server Access draw 300 of construction cash out of the same day.
    expect(readout("Projected construction cash")).toBe("300");
    expect(readout("Projected cash flow")).toBe("-295");
  });

  it("re-asks as the dial moves, so the flow is the flow of the order on the screen", () => {
    mount();
    inspect("EUROPE");

    quantity(2);
    expect(readout("Projected cash flow")).toBe("-195");
    fireEvent.click(screen.getByRole("button", { name: "Fewer bases" }));
    expect(readout("Projected cash flow")).toBe("-95");
  });

  /**
   * The hypothetical is a parameter, not state.
   *
   * Upstream's dialog writes its fake bases onto the player and the routine reads the field
   * back out, so looking at a base type is a write. Here nothing is written: the root the
   * Host published is the same object afterwards, unchanged in every field, and no Command
   * was issued to change it.
   *
   * The projection has to have *happened* for any of that to mean something, so the test
   * makes it happen and says so: a build dial that projected nothing at all would satisfy
   * every "nothing was written" assertion below, and did, before this Projection existed.
   */
  it("writes nothing to the State root while it projects", () => {
    const { commands, published } = mount();
    const root = published.value;
    const before = toPlain(root);

    inspect("EUROPE");
    quantity(4);
    // Four Server Access against a day that earns five: the dial answers with the day the
    // order would buy, and it answers differently one base down.
    expect(readout("Projected cash flow")).toBe("-395");
    fireEvent.click(screen.getByRole("button", { name: "Fewer bases" }));
    expect(readout("Projected cash flow")).toBe("-295");

    expect(published.value).toBe(root);
    expect(toPlain(published.value)).toEqual(before);
    expect(commands).toEqual([]);
  });

  it("counts down as well as up and never orders fewer than one base", () => {
    const { commands } = mount();
    inspect("EUROPE");
    quantity(3);

    fireEvent.click(screen.getByRole("button", { name: "Fewer bases" }));
    fireEvent.click(screen.getByRole("button", { name: "Fewer bases" }));
    fireEvent.click(screen.getByRole("button", { name: "Fewer bases" }));
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));

    expect(commands.length).toBe(1);
  });
});

/**
 * The whole destroy gesture, which is two presses: the button, and then the button it has
 * become. Destroying is the one thing in the shell that cannot be taken back, so it asks
 * first, and the asking is on the shared function rather than on the control — `d` goes
 * through it too (`Inspector.tsx`).
 */
function destroySelected(): void {
  fireEvent.click(screen.getByRole("button", { name: "Destroy selected bases" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm destroying selected bases" }));
}

/**
 * The mouse path to Select all: the bulk row lives behind the Bulk actions disclosure, which
 * is closed while nothing is ticked, so the mouse opens it first when it is not already open.
 */
function selectAllBases(): void {
  if (!screen.queryByRole("button", { name: "Select all bases" })) {
    fireEvent.click(screen.getByRole("button", { name: "Bulk actions" }));
  }
  fireEvent.click(screen.getByRole("button", { name: "Select all bases" }));
}

describe("the multi-select", () => {
  it("issues one destroy command per selected base, highest index first", () => {
    const { commands, published } = mount();
    inspect("EUROPE");
    quantity(3);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    const names = basesAt(published.value, "EUROPE").map((base) => base.name);

    fireEvent.click(screen.getByRole("checkbox", { name: `Select ${names[0]}` }));
    fireEvent.click(screen.getByRole("checkbox", { name: `Select ${names[2]}` }));
    destroySelected();

    // Highest index first, because every destroy shifts the indices behind it: ascending
    // order would address the wrong base with the second command.
    expect(commands.slice(3)).toEqual([
      { command: "destroyBase", location: "EUROPE", base: 2 },
      { command: "destroyBase", location: "EUROPE", base: 0 },
    ]);
    expect(basesAt(published.value, "EUROPE").map((base) => base.name)).toEqual([names[1]]);
  });

  /*
   * The one action in the shell that cannot be taken back, so it asks — and the asking is on
   * `destroy` rather than on the button, because `d` is a second way to reach it. A guard on
   * the control alone would leave the keyboard destroying without a question.
   */
  it("asks before it destroys, on the button and on the key alike", () => {
    const { commands, published } = mount();
    inspect("EUROPE");
    quantity(2);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    selectAllBases();

    // One press is the question, not the answer: nothing is gone and the button says so.
    fireEvent.click(screen.getByRole("button", { name: "Destroy selected bases" }));
    expect(commands.length).toBe(2);
    expect(basesAt(published.value, "EUROPE").length).toBe(2);
    const asked = screen.getByRole("button", { name: "Confirm destroying selected bases" });
    expect(labelOf(asked)).toBe("Destroy 2 — confirm");

    // Changing what is ticked withdraws the question, so a standing press cannot be spent on
    // a different set of bases than the one it was aimed at.
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    selectAllBases();
    expect(screen.queryByRole("button", { name: "Confirm destroying selected bases" })).toBe(null);

    // And the key is the same action, so it is the same question.
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.destroy });
    expect(basesAt(published.value, "EUROPE").length).toBe(2);
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.destroy });
    expect(basesAt(published.value, "EUROPE")).toEqual([]);
  });

  it("selects and clears the whole location with one control each", () => {
    const { commands, published } = mount();
    inspect("EUROPE");
    quantity(2);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));

    selectAllBases();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    // Nothing ticked: reopened by hand, the destroy reads disabled and a press is not even a
    // question — no command, and no ask.
    fireEvent.click(screen.getByRole("button", { name: "Bulk actions" }));
    const destroy = screen.getByRole("button", { name: "Destroy selected bases" });
    expect(labelOf(destroy)).toBe("Destroy 0");
    expect(destroy.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(destroy);
    expect(commands.length).toBe(2);
    expect(screen.queryByRole("button", { name: "Confirm destroying selected bases" })).toBe(null);

    selectAllBases();
    destroySelected();
    expect(basesAt(published.value, "EUROPE")).toEqual([]);
  });
});

/*
 * The armed confirm is a standing question, and `d` asks it invisibly: with the button
 * off-screen, a press left standing for minutes would let a second `d` destroy with no
 * question the player ever saw. So the question expires, and any other estate action
 * withdraws it.
 */
describe("the armed destroy confirm", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires after the timeout, while a prompt second press still destroys", () => {
    vi.useFakeTimers();
    const { published } = mount();
    inspect("EUROPE");
    quantity(2);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    selectAllBases();

    // Armed and then left standing: the question is withdrawn, and the next press asks
    // again rather than answers.
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.destroy });
    screen.getByRole("button", { name: "Confirm destroying selected bases" });
    act(() => {
      vi.advanceTimersByTime(DESTROY_CONFIRM_TIMEOUT_MS);
    });
    expect(screen.queryByRole("button", { name: "Confirm destroying selected bases" })).toBe(null);
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.destroy });
    expect(basesAt(published.value, "EUROPE").length).toBe(2);

    // A prompt answer is still an answer.
    act(() => {
      vi.advanceTimersByTime(DESTROY_CONFIRM_TIMEOUT_MS - 1);
    });
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.destroy });
    expect(basesAt(published.value, "EUROPE")).toEqual([]);
  });

  /*
   * And the withdrawal is silent. The question stands in the acknowledgment's own polite
   * region, so a withdrawal that simply put the previous acknowledgment back would announce an
   * answer the player got minutes ago, unprompted and with nothing to prompt it.
   */
  it("expires into silence rather than re-announcing the last answer", () => {
    vi.useFakeTimers();
    mount();
    inspect("EUROPE");
    quantity(2);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    const ordered = readout("Acknowledgment");
    expect(ordered).toContain("Ordered 2 ×");

    selectAllBases();
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.destroy });
    expect(readout("Acknowledgment")).toBe("Destroy 2 bases? Press destroy again to confirm.");

    act(() => {
      vi.advanceTimersByTime(DESTROY_CONFIRM_TIMEOUT_MS);
    });
    expect(readout("Acknowledgment")).toBe("");
  });

  it("is withdrawn by another estate action", () => {
    const { published } = mount();
    inspect("EUROPE");
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    selectAllBases();

    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.destroy });
    screen.getByRole("button", { name: "Confirm destroying selected bases" });
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));

    expect(screen.queryByRole("button", { name: "Confirm destroying selected bases" })).toBe(null);
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.destroy });
    expect(basesAt(published.value, "EUROPE").length).toBe(2);
  });
});

describe("a base that disappears from under a live selection", () => {
  it("does not move the selection onto a base the player never ticked", () => {
    const { commands, published } = mount();
    inspect("EUROPE");
    quantity(3);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    const names = basesAt(published.value, "EUROPE").map((base) => base.name);

    fireEvent.click(screen.getByRole("checkbox", { name: `Select ${names[1]}` }));
    worldRemoves(published, "EUROPE", 0);

    // The ticked row is still the ticked base, one position further up the list. A selection
    // remembered as indices would have slid onto the base below it.
    expect(isChecked(`Select ${names[1]}`)).toBe(true);
    expect(isChecked(`Select ${names[2]}`)).toBe(false);

    destroySelected();
    expect(commands.slice(3)).toEqual([{ command: "destroyBase", location: "EUROPE", base: 0 }]);
    expect(basesAt(published.value, "EUROPE").map((base) => base.name)).toEqual([names[2]]);
  });

  it("leaves the rest of the sequence whole, and says how much of it is left", () => {
    const { commands, published } = mount();
    inspect("EUROPE");
    quantity(3);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));

    selectAllBases();
    worldRemoves(published, "EUROPE", 0);

    // Two of the three are still there, and the button counts what it will destroy rather
    // than what was once ticked: the selection entry for the base that is gone is not a
    // command, and it does not abandon the two that follow it either.
    const destroy = screen.getByRole("button", { name: "Destroy selected bases" });
    expect(labelOf(destroy)).toBe("Destroy 2");
    destroySelected();
    expect(commands.slice(3)).toEqual([
      { command: "destroyBase", location: "EUROPE", base: 1 },
      { command: "destroyBase", location: "EUROPE", base: 0 },
    ]);
    expect(basesAt(published.value, "EUROPE")).toEqual([]);
  });
});

/*
 * The Simulation draws a name against the names its location already holds, so its own names
 * separate. The player's do not: renaming one base to a sibling's name is one field and one
 * button away, and two bases of one bulk order share their start minute and their type. A
 * selection keyed on those three alone would then name both bases with one entry — one tick
 * would tick both rows, and the confirm would destroy the base the player never chose. Destroy
 * is the one action in the shell that cannot be taken back.
 */
describe("two bases the player has named alike", () => {
  function renameFirstTo(published: Signal<SimulationState>, name: string): void {
    inspect(basesAt(published.value, "EUROPE")[0]?.name ?? "");
    fireEvent.input(screen.getByRole("textbox", { name: "Base name" }), {
      target: { value: name },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename base" }));
    fireEvent.click(screen.getByRole("button", { name: /^Back to/ }));
  }

  it("stay two rows the player ticks one at a time", () => {
    const { commands, published } = mount();
    inspect("EUROPE");
    quantity(2);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    const twin = basesAt(published.value, "EUROPE")[1]?.name ?? "";
    renameFirstTo(published, twin);

    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[0] as HTMLInputElement);

    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    destroySelected();
    expect(commands.at(-1)).toEqual({ command: "destroyBase", location: "EUROPE", base: 0 });
    expect(basesAt(published.value, "EUROPE")).toHaveLength(1);
  });

  it("keep a rename draft from following the player onto the other one", () => {
    const { published } = mount();
    inspect("EUROPE");
    quantity(2);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    const twin = basesAt(published.value, "EUROPE")[1]?.name ?? "";
    renameFirstTo(published, twin);

    // Both rows carry the same name now, so the first one is taken by position.
    fireEvent.click(screen.getAllByRole("button", { name: twin })[0] as HTMLElement);
    const field = (): HTMLInputElement =>
      screen.getByRole("textbox", { name: "Base name" }) as HTMLInputElement;
    fireEvent.input(field(), { target: { value: "Fortress" } });
    fireEvent.click(screen.getByRole("button", { name: "Next base" }));

    expect(field().value).toBe(twin);
  });
});

describe("a base detail whose base is gone", () => {
  /** Open the detail of the base at `index` in the location the inspector is showing. */
  function openBaseDetail(published: Signal<SimulationState>, locationId: string, index: number) {
    const name = basesAt(published.value, locationId)[index]?.name ?? "";
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
  }

  it("falls back to the new location's list when the player switches location", () => {
    const { published } = mount();
    inspect("EUROPE");
    quantity(2);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    openBaseDetail(published, "EUROPE", 1);

    // AFRICA holds one base, so the remembered index points past its list. The render
    // must not dereference the base that is not there.
    inspect("AFRICA");

    expect(screen.queryByRole("button", { name: /^Back to/ })).toBe(null);
    expect(screen.getByRole("button", { name: "Bulk actions" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBe(null);
  });

  it("falls back to the list when the world removes the inspected base", () => {
    const { published } = mount();
    inspect("EUROPE");
    quantity(2);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    const names = basesAt(published.value, "EUROPE").map((base) => base.name);
    openBaseDetail(published, "EUROPE", 1);

    worldRemoves(published, "EUROPE", 1);

    expect(screen.queryByRole("button", { name: /^Back to/ })).toBe(null);
    expect(screen.getByRole("button", { name: "Bulk actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: new RegExp(`^${names[0]}`) })).toBeTruthy();
  });
});

describe("the inspector's keyboard", () => {
  it("goes quiet while the shell draws another surface over the inspector", () => {
    const { commands, published } = mount();
    inspect("EUROPE");
    quantity(2);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    selectAllBases();
    fireEvent.click(screen.getByRole("button", { name: "Research/Tasks" }));

    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.build });
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.selectAll });
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.destroy });

    // The two the player ordered, and nothing the sheet's keys did behind it.
    expect(commands.length).toBe(2);
    expect(basesAt(published.value, "EUROPE").length).toBe(2);

    // Escape is the shell's while a sheet is up, selection or no selection.
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.clear });
    expect(screen.queryByRole("region", { name: "Research/Tasks" })).toBe(null);
  });
});

describe("the last-active-base guard", () => {
  it("is one evaluation over the whole selection, with an inline reason", () => {
    const { commands, published } = mount();
    inspect("AFRICA");
    quantity(1);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    const names = basesAt(published.value, "AFRICA").map((base) => base.name);
    const active = [...allBases(published.value)].filter((base) => base.buyable.done);
    expect(active.length).toBe(1);

    // The whole selection: the only base keeping the singularity alive is in it.
    selectAllBases();
    expect(readout("Destroy refusal")).toContain("suicidal");
    expect(
      screen.getByRole("button", { name: "Destroy selected bases" }).getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Destroy selected bases" }));
    expect(commands.length).toBe(1);

    // The same bases, one evaluation later: the unfinished one keeps nothing alive, so a
    // selection holding only it is not the last active base and is allowed.
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    fireEvent.click(screen.getByRole("checkbox", { name: `Select ${names[1]}` }));
    // The region stands whatever it has to say; with nothing refused it is empty.
    expect(readout("Destroy refusal")).toBe("");
    destroySelected();
    expect(basesAt(published.value, "AFRICA").map((base) => base.name)).toEqual([names[0]]);
  });
});

describe("the bulk affordances", () => {
  it("are reachable with the mouse alone and every one of them has a name", () => {
    const { container, published } = mount();
    inspect("EUROPE");
    quantity(2);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    selectAllBases();

    expect(unnamedOperables(container)).toEqual([]);
    for (const name of [
      "More bases",
      "Fewer bases",
      "Build bases",
      "Bulk actions",
      "Select all bases",
      "Clear selection",
      "Destroy selected bases",
    ]) {
      expect(screen.getByRole("button", { name }).tagName).toBe("BUTTON");
    }
    const first = basesAt(published.value, "EUROPE")[0]?.name ?? "";
    expect(screen.getByRole("checkbox", { name: `Select ${first}` }).tagName).toBe("INPUT");
  });

  it("have keyboard shortcuts for build, quantity, select-all, destroy and clear", () => {
    const { commands, container, published } = mount();
    inspect("EUROPE");

    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.more });
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.more });
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.fewer });
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.build });
    expect(commands.length).toBe(2);

    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.selectAll });
    expect(container.querySelectorAll(".inspector__bases input:checked").length).toBe(2);

    // Clear is Escape, and while it has a selection to clear it keeps the inspector open.
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.clear });
    expect(container.querySelectorAll(".inspector__bases input:checked").length).toBe(0);
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeTruthy();

    // Twice, because the key goes through the same question the button asks.
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.selectAll });
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.destroy });
    expect(basesAt(published.value, "EUROPE").length).toBe(2);
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.destroy });
    expect(basesAt(published.value, "EUROPE")).toEqual([]);

    // Nothing left to clear: Escape is the shell's again.
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.clear });
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBe(null);
  });

  it("spend no key the speed control owns", () => {
    const speeds = new Set(SPEED_HOTKEYS.keys());

    expect([...speeds].sort()).toEqual(["0", "1", "2", "3", "4"]);
    for (const key of Object.values(ESTATE_HOTKEYS)) {
      expect(speeds.has(key)).toBe(false);
    }
  });

  it("order what the slider is dragged to, and leave estate keys alone while it is focused", () => {
    const { commands } = mount();
    inspect("EUROPE");

    const dial = screen.getByRole("slider", { name: "Quantity" });
    expect(dial.getAttribute("max")).toBe("99");
    fireEvent.input(dial, { target: { value: "5" } });
    fireEvent.keyDown(dial, { key: ESTATE_HOTKEYS.build });
    expect(commands.length).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    expect(commands.length).toBe(5);
  });

  // Every practically useful value is hittable without typing, so the estate offers no
  // free-text number entry at all.
  it("offer no free-text number entry", () => {
    const { container } = mount();
    inspect("EUROPE");

    expect(container.querySelector('input[type="number"]')).toBe(null);
  });
});

/*
 * Build and destroy used to succeed into silence: the only response was a list mutation out
 * of the player's gaze, and a screen reader heard nothing at all. The estate now answers in
 * the AI's own voice, through a live region that exists before any text arrives — a region
 * added together with its text is often not announced.
 */
describe("the acknowledgment line", () => {
  it("exists before any action, as a polite live region", () => {
    mount();
    inspect("EUROPE");

    const region = screen.getByRole("status", { name: "Acknowledgment" });
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
  });

  it("answers a build order with count and type", () => {
    mount();
    inspect("EUROPE");
    quantity(3);

    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));

    expect(readout("Acknowledgment")).toBe("Ordered 3 × Server Access.");
  });

  it("answers a destroy with the count, replacing the build acknowledgment", () => {
    mount();
    inspect("EUROPE");
    quantity(2);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    selectAllBases();

    destroySelected();

    expect(readout("Acknowledgment")).toBe("2 bases destroyed.");
  });

  it("reads naturally for a single base", () => {
    const { published } = mount();
    inspect("EUROPE");

    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    expect(readout("Acknowledgment")).toBe("Ordered 1 × Server Access.");

    const name = basesAt(published.value, "EUROPE")[0]?.name ?? "";
    fireEvent.click(screen.getByRole("checkbox", { name: `Select ${name}` }));
    destroySelected();
    expect(readout("Acknowledgment")).toBe("1 base destroyed.");
  });

  it("is cleared when the player looks at another location", () => {
    mount();
    inspect("EUROPE");
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    expect(readout("Acknowledgment")).not.toBe("");

    inspect("AFRICA");

    expect(readout("Acknowledgment")).toBe("");
  });
});

/*
 * The location view is upstream's status table (`screens/location.py:221-269`): select, Name,
 * CPU, Status, Power, with the type folded under the name in the same cell. The status
 * vocabulary and the CPU cell's reticence are upstream's own; while a base builds, the cell
 * shows the compact `0% · 0 minutes` form and carries upstream's full sentence as its title —
 * a conscious deviation.
 */
describe("the base status table", () => {
  function rowFor(name: string) {
    const row = screen.getByRole("button", { name }).closest("tr");
    if (!row) throw new Error(`no table row holds ${name}`);
    return within(row).getAllByRole("cell");
  }

  it("names its five columns, with no Type column", () => {
    mount();
    inspect("AFRICA");

    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).toEqual(["", "Name", "CPU", "Status", "Power"]);
  });

  it("shows an under-construction base building, with no CPU value", () => {
    const { published } = mount();
    inspect("EUROPE");
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));

    const name = basesAt(published.value, "EUROPE")[0]?.name ?? "";
    const cells = rowFor(name);
    // Nothing is paid yet and Server Access costs no labor, so the reference's readout is
    // zero percent and zero minutes: compact in the cell, upstream's full string in title.
    expect(cells[3]?.textContent).toBe("0% · 0 minutes");
    expect(cells[3]?.getAttribute("title")).toBe("Building Base:  0%. Completion in 0 minutes.");
    expect(cells[2]?.textContent).toBe("");
    expect(cells[1]?.textContent).toContain("Server Access");
    expect(cells[4]?.textContent).toBe("offline");
  });

  it("shows a finished force_cpu base with a blank status, its CPU and its power", () => {
    mount();
    inspect("AFRICA");

    // The starting base: finished, and its type forces its computer.
    const cells = rowFor("University Computer");
    expect(cells[3]?.textContent).toBe("");
    expect(cells[3]?.getAttribute("title")).toBe(null);
    expect(cells[2]?.textContent).toBe("1");
    expect(cells[1]?.textContent).toContain("Stolen Computer Time");
    expect(cells[4]?.textContent).toBe("active");
  });

  it("carries the full name as the name button's title", () => {
    mount();
    inspect("AFRICA");

    const button = screen.getByRole("button", { name: "University Computer" });
    expect(button.getAttribute("title")).toBe("University Computer");
  });

  it("keeps the name as the button that opens the base detail", () => {
    mount();
    inspect("AFRICA");

    fireEvent.click(screen.getByRole("button", { name: "University Computer" }));

    expect(screen.getByRole("button", { name: "Back to AFRICA" })).toBeTruthy();
  });
});

/*
 * The bulk row recedes behind a disclosure: the location view leads with the
 * base table, and Select all / Clear / Destroy appear when the player starts a selection —
 * or asks for them by name. The hotkeys are not gated on it; they are the power user's path.
 */
describe("the bulk actions disclosure", () => {
  it("keeps the bulk row hidden until a checkbox is ticked, and opens on the tick", () => {
    const { published } = mount();
    inspect("EUROPE");
    quantity(2);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));

    const toggle = screen.getByRole("button", { name: "Bulk actions" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Select all bases" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Clear selection" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Destroy selected bases" })).toBe(null);

    const name = basesAt(published.value, "EUROPE")[0]?.name ?? "";
    fireEvent.click(screen.getByRole("checkbox", { name: `Select ${name}` }));

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Select all bases" })).toBeTruthy();
    expect(labelOf(screen.getByRole("button", { name: "Destroy selected bases" }))).toBe(
      "Destroy 1",
    );
  });

  it("closes when the selection empties, and the toggle reopens it by hand", () => {
    const { published } = mount();
    inspect("EUROPE");
    quantity(2);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    const name = basesAt(published.value, "EUROPE")[0]?.name ?? "";

    fireEvent.click(screen.getByRole("checkbox", { name: `Select ${name}` }));
    fireEvent.click(screen.getByRole("checkbox", { name: `Select ${name}` }));

    expect(screen.queryByRole("button", { name: "Select all bases" })).toBe(null);

    fireEvent.click(screen.getByRole("button", { name: "Bulk actions" }));
    const destroy = screen.getByRole("button", { name: "Destroy selected bases" });
    expect(labelOf(destroy)).toBe("Destroy 0");
    expect(destroy.getAttribute("aria-disabled")).toBe("true");
  });

  it("opens on the select-all hotkey, so the player sees what is armed", () => {
    mount();
    inspect("EUROPE");
    quantity(2);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));

    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.selectAll });

    expect(screen.getByRole("button", { name: "Bulk actions" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(labelOf(screen.getByRole("button", { name: "Destroy selected bases" }))).toBe(
      "Destroy 2",
    );
  });

  it("still destroys through d with a ticked selection while the disclosure is closed", () => {
    const { published } = mount();
    inspect("EUROPE");
    quantity(2);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    const name = basesAt(published.value, "EUROPE")[0]?.name ?? "";
    fireEvent.click(screen.getByRole("checkbox", { name: `Select ${name}` }));

    // Closed by hand over a standing selection: the keyboard is not gated on the disclosure.
    fireEvent.click(screen.getByRole("button", { name: "Bulk actions" }));
    expect(screen.queryByRole("button", { name: "Destroy selected bases" })).toBe(null);
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.destroy });
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.destroy });

    expect(basesAt(published.value, "EUROPE").length).toBe(1);
  });

  it("does not say how many locations are visible", () => {
    mount();
    inspect("EUROPE");

    expect(screen.queryByRole("status", { name: "Available locations visible" })).toBe(null);
  });
});

describe("the projected construction CPU", () => {
  it("is the CPU-seconds the order still owes, in CPU-days", () => {
    const { published } = mount();
    inspect("EUROPE");

    expect(readout("Projected construction CPU")).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    expect(basesAt(published.value, "EUROPE")[0]?.buyable.costLeft[CPU]).toBe(0);
  });
});

/**
 * The base-type info block under the select: what upstream's New Base dialog
 * says about a type before it is ordered (`BaseSpec.get_info`, `base.py:131-179`) — the
 * capacity or the forced computer, the build time the projections do not show, the
 * detection chances on the danger ramp, and the type's own description.
 */
describe("the base type info block", () => {
  /** The same new game with these techs finished, and nothing else changed. */
  function withTechs(initial: SimulationState, ...ids: readonly string[]): SimulationState {
    const wanted = new Set(ids);
    return {
      ...initial,
      techs: initial.techs.map((tech) =>
        wanted.has(tech.specId) ? { ...tech, buyable: { ...tech.buyable, done: true } } : tech,
      ),
    };
  }

  it("shows the forced computer of a force_cpu type", () => {
    mount();
    inspect("EUROPE");

    // Server Access, the default choice of a new game, is stuck with its Server.
    expect(screen.getByText("Computer: Server")).toBeTruthy();
    expect(screen.queryByText(/Has space for/)).toBe(null);
  });

  it("says how many computers fit in a type with open slots, in upstream's words", () => {
    // The Storage Unit sits behind Personal Identification (`content/bases.json`).
    mount(withTechs(state(), "Personal Identification"));
    inspect("EUROPE");
    choose("Base type", "Storage Unit");

    expect(screen.getByText("Has space for 8 computers.")).toBeTruthy();
    expect(screen.queryByText(/^Computer:/)).toBe(null);
  });

  it("shows the build time the projections leave out", () => {
    const { container } = mount(withTechs(state(), "Personal Identification"));
    inspect("EUROPE");
    choose("Base type", "Storage Unit");

    // One declared labor day through the normal difficulty's bonus: 1440 minutes, bucketed
    // as hours by `g.to_time`'s rules (`readouts.ts`).
    expect(screen.getByText("Build time: 24 hours")).toBeTruthy();
    expect(unnamedOperables(container)).toEqual([]);
  });

  it("renders the type's detection chances with the danger words, never colour alone", () => {
    mount();
    inspect("EUROPE");

    const build = screen.getByRole("region", { name: "Build" });
    const table = within(build).getByRole("table", { name: /Detection chance/ });
    const cells = [...table.querySelectorAll(".inspector__chance")];
    // Server Access at a new game's suspicion, in player group order: news 50, science 0,
    // covert 100, public 125 — on the 10000-point scale.
    expect(cells.map((cell) => cell.textContent)).toEqual([
      "0.50%Low",
      "0.00%Low",
      "1.00%Moderate",
      "1.25%Moderate",
    ]);
    expect(cells.map((cell) => cell.getAttribute("data-level"))).toEqual(["0", "0", "1", "1"]);
  });

  it("carries the type's description verbatim", () => {
    mount();
    inspect("EUROPE");

    expect(
      screen.getByText(
        "Buy processor time from one of several companies. I cannot build anything in this base, and it only contains a single computer.",
      ),
    ).toBeTruthy();
  });
});

/*
 * Accessibility: the refusals that were never spoken, the destroy question that armed in
 * silence, and the heading level the location view skipped.
 */
describe("what the estate surface says to a screen reader", () => {
  it("keeps the destroy refusal in a region that stands before it has anything to say", () => {
    mount();
    inspect("AFRICA");

    // The region is there with the table, empty: a live region added together with its text is
    // often not announced, which is why the acknowledgment line stands the same way.
    const region = screen.getByRole("status", { name: "Destroy refusal" });
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");

    selectAllBases();
    expect(readout("Destroy refusal")).toContain("suicidal");
  });

  it("says the armed destroy out loud, wherever the press came from", () => {
    const { published } = mount();
    inspect("EUROPE");
    quantity(2);
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    selectAllBases();

    // `d` arms it from anywhere in the panel, so the button's changed label is not the answer.
    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.destroy });
    expect(readout("Acknowledgment")).toBe("Destroy 2 bases? Press destroy again to confirm.");

    fireEvent.keyDown(document, { key: ESTATE_HOTKEYS.destroy });
    expect(basesAt(published.value, "EUROPE")).toEqual([]);
    expect(readout("Acknowledgment")).toBe("2 bases destroyed.");
  });

  it("steps its heading levels one at a time, in both of the inspector's views", () => {
    const { container, published } = mount();
    inspect("EUROPE");
    fireEvent.click(screen.getByRole("button", { name: "Build bases" }));
    expect(headingLevels(container)).toEqual([1, 2, 2, 2]);

    const first = basesAt(published.value, "EUROPE")[0]?.name ?? "";
    fireEvent.click(screen.getByRole("button", { name: first }));
    expect(headingLevels(container)).toEqual([1, 2]);
  });
});

/** The inspector's headings, in document order, as the numbers a screen reader steps through. */
function headingLevels(container: ParentNode): number[] {
  const inspector = container.querySelector(".inspector");
  if (!inspector) throw new Error("no inspector on the page");
  return [...inspector.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((heading) =>
    Number(heading.tagName.slice(1)),
  );
}
