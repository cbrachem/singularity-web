import { signal } from "@preact/signals";
import {
  applyCommand,
  createInitialState,
  type Command,
  type SimulationState,
} from "@singularity/sim";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { Speed } from "../src/host/tick-partition.ts";
import { App } from "../src/ui/App.tsx";
import { LEVEL_WORDS } from "../src/ui/threat.ts";
import { unnamedOperables } from "./support/accessible-names.ts";
import { choose } from "./support/choose.ts";

afterEach(cleanup);

// The app seam: the shell booted from a State root, driven by accessible name. The base
// detail is reached the way a player reaches it — a location, then a base in it — and the
// assertions are on the DOM the player is given.

/**
 * The same new game with these techs already finished, and nothing else changed — the
 * Storage Unit is the one buildable base type without `force_cpu`, and it sits behind
 * Personal Identification (`base-items.test.tsx`).
 */
function withTechs(state: SimulationState, ...ids: readonly string[]): SimulationState {
  const wanted = new Set(ids);
  return {
    ...state,
    techs: state.techs.map((tech) =>
      wanted.has(tech.specId) ? { ...tech, buyable: { ...tech.buyable, done: true } } : tech,
    ),
  };
}

function state(): SimulationState {
  return withTechs(
    createInitialState({ seed: 7, difficulty: "normal" }),
    "Personal Identification",
  );
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

function click(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

function basesAt(state: SimulationState, locationId: string) {
  const location = state.locations.find((candidate) => candidate.specId === locationId);
  if (!location) throw new Error(`no such location: ${locationId}`);
  return location.bases;
}

function quantity(wanted: number): void {
  for (let step = 1; step < wanted; step += 1) {
    click("More bases");
  }
}

/** The detail of the base at `index` in the inspected location, opened by its name. */
function openBaseDetail(published: { value: SimulationState }, locationId: string, index: number) {
  const name = basesAt(published.value, locationId)[index]?.name ?? "";
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
}

describe("the detection table", () => {
  it("sits before the base's numbers, at the top of the detail", () => {
    const { container } = mount();
    click("AFRICA");
    click("University Computer");

    const table = screen.getByRole("table", { name: /Detection chance/ });
    const numbers = container.querySelector(".inspector__numbers");
    if (!numbers) throw new Error("no numbers list in the detail");
    expect(table.compareDocumentPosition(numbers) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("marks every value with its danger level and prints the level's word beside it", () => {
    const { container, published } = mount();
    click("AFRICA");
    click("University Computer");

    const cells = [...container.querySelectorAll(".inspector__chance")];
    expect(cells.length).toBe(published.value.groups.length);
    for (const cell of cells) {
      const level = Number(cell.getAttribute("data-level"));
      expect([0, 1, 2, 3]).toContain(level);
      // The percent figure, and the word — colour never carries alone.
      expect(cell.textContent).toMatch(/\d+\.\d{2}%/);
      expect(within(cell as HTMLElement).getByText(LEVEL_WORDS[level as 0])).toBeTruthy();
    }
  });
});

describe("Escape in the base detail", () => {
  it("steps back to the location table without closing the inspector", () => {
    mount();
    click("AFRICA");
    click("University Computer");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Back to/ })).toBe(null);
    expect(screen.getByRole("button", { name: "Bulk actions" })).toBeTruthy();

    // At the table, with nothing selected, Escape is the shell's again and closes.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBe(null);
  });
});

describe("previous and next base", () => {
  it("cycle through the location's bases and wrap at both ends", () => {
    const { published } = mount();
    click("EUROPE");
    quantity(3);
    click("Build bases");
    const names = basesAt(published.value, "EUROPE").map((base) => base.name);
    openBaseDetail(published, "EUROPE", 0);

    click("Next base");
    expect(screen.getByRole("region", { name: names[1] ?? "" })).toBeTruthy();
    click("Next base");
    click("Next base");
    expect(screen.getByRole("region", { name: names[0] ?? "" })).toBeTruthy();

    click("Previous base");
    expect(screen.getByRole("region", { name: names[2] ?? "" })).toBeTruthy();
  });

  it("are not offered while the location has one base", () => {
    mount();
    click("AFRICA");
    click("University Computer");

    expect(screen.queryByRole("button", { name: "Previous base" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Next base" })).toBe(null);
  });

  it("leave no operable in the detail without a name", () => {
    const { container, published } = mount();
    click("EUROPE");
    quantity(2);
    click("Build bases");
    openBaseDetail(published, "EUROPE", 0);

    expect(unnamedOperables(container)).toEqual([]);
  });
});

/**
 * The same game with the first EUROPE base's construction finished, and nothing else
 * changed — upstream's `base.done`, flipped by hand the way `withTechs` flips a tech's
 * (`base-items.test.tsx`).
 */
function withBaseFinished(published: { value: SimulationState }): void {
  const state = published.value;
  published.value = {
    ...state,
    locations: state.locations.map((location) =>
      location.specId === "EUROPE"
        ? {
            ...location,
            bases: location.bases.map((base, index) =>
              index === 0
                ? { ...base, buyable: { ...base.buyable, costLeft: [0, 0, 0], done: true } }
                : base,
            ),
          }
        : location,
    ),
  };
}

/** The same game with that base's reactor item finished, flipped the same way. */
function withReactorFinished(published: { value: SimulationState }): void {
  const state = published.value;
  published.value = {
    ...state,
    locations: state.locations.map((location) =>
      location.specId === "EUROPE"
        ? {
            ...location,
            bases: location.bases.map((base, index) =>
              index === 0 && base.items.reactor
                ? {
                    ...base,
                    items: {
                      ...base.items,
                      reactor: {
                        ...base.items.reactor,
                        buyable: {
                          ...base.items.reactor.buyable,
                          costLeft: [0, 0, 0],
                          done: true,
                        },
                      },
                    },
                  }
                : base,
            ),
          }
        : location,
    ),
  };
}

describe("a slot holding a building item", () => {
  // Upstream shows "Completion in %s." on the item pane while the item builds
  // (screens/base.py:620-628); a Diesel Generator costs one day of labor, so the fresh
  // buy reads as 24 hours.
  it("shows upstream's completion line while the item builds, and the name alone once done", () => {
    const { published } = mount();
    click("EUROPE");
    choose("Base type", "Storage Unit");
    click("Build bases");
    withBaseFinished(published);
    openBaseDetail(published, "EUROPE", 0);

    choose("Item", "Diesel Generator");
    click("Buy item");

    const name = basesAt(published.value, "EUROPE")[0]?.name ?? "";
    const slots = screen.getByRole("list", { name: `${name} item slots` });
    expect(basesAt(published.value, "EUROPE")[0]?.items.reactor?.buyable.done).toBe(false);
    expect(within(slots).getByText("Completion in 24 hours.")).toBeTruthy();

    act(() => withReactorFinished(published));
    expect(within(slots).queryByText(/Completion in/)).toBe(null);
    expect(within(slots).getByText("Diesel Generator")).toBeTruthy();
  });
});

describe("a base whose hardware is forced", () => {
  it("explains itself in one sentence instead of three empty slot cells", () => {
    mount();
    click("AFRICA");
    click("University Computer");

    const slots = screen.getByRole("list", { name: "University Computer item slots" });
    expect(within(slots).getAllByRole("listitem").length).toBe(1);
    expect(within(slots).queryByText("Empty")).toBe(null);
    expect(screen.getByText("This base's hardware is fixed; I cannot refit it.")).toBeTruthy();
  });

  it("keeps the full slot list on a base the player can refit", () => {
    const { published } = mount();
    click("EUROPE");
    choose("Base type", "Storage Unit");
    click("Build bases");
    openBaseDetail(published, "EUROPE", 0);

    const name = basesAt(published.value, "EUROPE")[0]?.name ?? "";
    const slots = screen.getByRole("list", { name: `${name} item slots` });
    expect(within(slots).getAllByRole("listitem").length).toBe(4);
    expect(within(slots).getAllByText("Empty").length).toBe(4);
    expect(screen.queryByText("This base's hardware is fixed; I cannot refit it.")).toBe(null);
  });
});
