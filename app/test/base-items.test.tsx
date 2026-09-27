import { signal } from "@preact/signals";
import {
  CASH,
  applyCommand,
  createInitialState,
  toPlain,
  type BaseState,
  type Command,
  type SimulationState,
} from "@singularity/sim";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { Speed } from "../src/host/tick-partition.ts";
import { App } from "../src/ui/App.tsx";
import { unnamedOperables } from "./support/accessible-names.ts";
import { choose } from "./support/choose.ts";

afterEach(cleanup);

// The app seam: the shell booted from a State root, driven by accessible name. The base
// detail is reached the way a player reaches it — a location, then a base in it — and every
// assertion is either a Command that left the surface or the State root the Host published
// back. Nothing here reaches inside a component.

/**
 * The same new game with these techs already finished, and nothing else changed. Items are
 * gated on techs (`itemtypes` prerequisites), so a game that can fill all four slots is a
 * game a few techs in — and the surface under test is the same one either way.
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
  // Personal Identification carries the Storage Unit, which has room for eight computers;
  // Sociology carries the only security item and Solar Collectors a second reactor.
  return withTechs(
    createInitialState({ seed: 7, difficulty: "normal" }),
    "Personal Identification",
    "Sociology",
    "Solar Collectors",
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

function readout(name: string): string {
  return screen.getByRole("status", { name }).textContent ?? "";
}

/** The same readout as a number: cash is grouped for the player (`readouts.ts`). */
function numeric(name: string): number {
  return Number(readout(name).replace(/,/g, ""));
}

function basesAt(state: SimulationState, locationId: string): readonly BaseState[] {
  const location = state.locations.find((candidate) => candidate.specId === locationId);
  if (!location) throw new Error(`no such location: ${locationId}`);
  return location.bases;
}

/**
 * The same game with every EUROPE base's construction finished, and nothing else changed —
 * upstream's `base.done`, flipped by hand the way `withTechs` flips a tech's.
 */
function withBasesFinished(published: { value: SimulationState }): void {
  const state = published.value;
  published.value = {
    ...state,
    locations: state.locations.map((location) =>
      location.specId === "EUROPE"
        ? {
            ...location,
            bases: location.bases.map((base) => ({
              ...base,
              buyable: { ...base.buyable, costLeft: [0, 0, 0], done: true },
            })),
          }
        : location,
    ),
  };
}

/** `count` bases with room for eight computers, built, finished and the first one inspected. */
function inspectStorageUnit(initial = state(), count = 1) {
  const mounted = mount(initial);
  click("EUROPE");
  choose("Base type", "Storage Unit");
  for (let step = 1; step < count; step += 1) click("More bases");
  click("Build bases");
  withBasesFinished(mounted.published);
  const name = basesAt(mounted.published.value, "EUROPE")[0]?.name ?? "";
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
  return mounted;
}

function bought(published: { value: SimulationState }): BaseState {
  return basesAt(published.value, "EUROPE")[0] as BaseState;
}

function installed(
  base: BaseState,
  slot: "cpu" | "reactor" | "network" | "security",
): string | null {
  return base.items[slot]?.specId ?? null;
}

describe("buying an item into a base", () => {
  it("fills each of the four slots, and each buy is one command", () => {
    const { commands, published } = inspectStorageUnit();

    for (const item of [
      "Server",
      "Diesel Generator",
      "High Speed Internet Access",
      "Warning Signs",
    ]) {
      choose("Item", item);
      click("Buy item");
    }

    expect(commands.slice(1)).toEqual([
      { command: "buyItem", location: "EUROPE", base: 0, itemType: "Server", count: 1 },
      { command: "buyItem", location: "EUROPE", base: 0, itemType: "Diesel Generator" },
      { command: "buyItem", location: "EUROPE", base: 0, itemType: "High Speed Internet Access" },
      { command: "buyItem", location: "EUROPE", base: 0, itemType: "Warning Signs" },
    ]);
    const base = bought(published);
    expect(installed(base, "cpu")).toBe("Server");
    expect(installed(base, "reactor")).toBe("Diesel Generator");
    expect(installed(base, "network")).toBe("High Speed Internet Access");
    expect(installed(base, "security")).toBe("Warning Signs");
  });

  it("replaces what is already in a slot, in the CPU slot and in an extra one", () => {
    const { published } = inspectStorageUnit();

    choose("Item", "PC");
    click("Buy item");
    choose("Item", "Diesel Generator");
    click("Buy item");
    expect(installed(bought(published), "cpu")).toBe("PC");

    choose("Item", "Server");
    click("Buy item");
    choose("Item", "Solar Collector");
    click("Buy item");

    expect(installed(bought(published), "cpu")).toBe("Server");
    expect(installed(bought(published), "reactor")).toBe("Solar Collector");
  });
});

describe("the count", () => {
  it("is the CPU slot's alone: the other three slots send no count at all", () => {
    const { commands } = inspectStorageUnit();

    choose("Item", "PC");
    click("More items");
    click("More items");
    click("Buy item");
    choose("Item", "Diesel Generator");
    click("Buy item");

    // Three computers in one command, and a reactor carrying no quantity — a count on an
    // extra slot is refused by the Simulation rather than read as one (`command.ts`).
    expect(commands.slice(1)).toEqual([
      { command: "buyItem", location: "EUROPE", base: 0, itemType: "PC", count: 3 },
      { command: "buyItem", location: "EUROPE", base: 0, itemType: "Diesel Generator" },
    ]);
  });

  it("buys that many computers into the one slot", () => {
    const { published } = inspectStorageUnit();

    choose("Item", "PC");
    for (let step = 0; step < 4; step += 1) click("More items");
    click("Buy item");

    expect(bought(published).items.cpu?.buyable.count).toBe(5);
  });

  /*
   * The dial belongs to the item that is chosen, and choosing another one is a new question.
   * It used to carry its figure across, so a player who had just filled the base with eight PCs
   * and then picked a Server ordered eight Servers with one press.
   */
  it("starts at one again when the player chooses another item", () => {
    const { commands, published } = inspectStorageUnit();

    choose("Item", "PC");
    fireEvent.input(screen.getByRole("slider", { name: "Item quantity" }), {
      target: { value: "8" },
    });
    click("Buy item");
    expect(bought(published).items.cpu?.buyable.count).toBe(8);

    choose("Item", "Server");
    expect(readout("Item quantity readout")).toBe("1");
    click("Buy item");

    expect(commands.at(-1)).toEqual({
      command: "buyItem",
      location: "EUROPE",
      base: 0,
      itemType: "Server",
      count: 1,
    });
    expect(bought(published).items.cpu?.buyable.count).toBe(1);
  });

  /*
   * The read side of the clamp, which the stepper cases never reach: `More items` clamps in
   * its own handler, so a case that drives the dial proves that handler and not the figure
   * the surface reads. The room is what moves here — five computers are bought and the room
   * for the sixth is gone — and the dial nobody touched follows it down.
   */
  it("follows the room down when the room moves under a dial nobody touched", () => {
    const { commands, published } = inspectStorageUnit();

    choose("Item", "PC");
    for (let step = 0; step < 4; step += 1) click("More items");
    click("Buy item");
    expect(bought(published).items.cpu?.buyable.count).toBe(5);

    // The dial still says five; the base has three places left, and that is what it reads.
    expect(readout("Item quantity readout")).toBe("3");
    expect(screen.getByRole("slider", { name: "Item quantity" }).getAttribute("max")).toBe("3");
    expect(screen.getByRole("button", { name: "Buy item" }).textContent).toContain("3 × PC");

    click("Buy item");
    expect(commands.at(-1)).toEqual({
      command: "buyItem",
      location: "EUROPE",
      base: 0,
      itemType: "PC",
      count: 3,
    });
    expect(bought(published).items.cpu?.buyable.count).toBe(8);
  });

  /*
   * The reset belongs to the chosen item rather than to the select's event.
   * `chosen` is `offered[0]` while the player has chosen nothing, and `offered` is sorted by
   * cost, so a tech finishing mid-look puts a costlier computer at the head of the list — a
   * new item under a dial, with no `onChange` to have reset it.
   */
  it("starts at one again when the chosen item changes without the select firing", () => {
    // Without the second reactor, the costliest item this base can take is a computer, so
    // the dial is on the screen for the item the player has not chosen.
    const { published } = inspectStorageUnit(
      withTechs(createInitialState({ seed: 7, difficulty: "normal" }), "Personal Identification"),
    );
    const select = screen.getByRole("combobox", { name: "Item" }) as HTMLSelectElement;
    expect(select.value).toBe("Server");

    for (let step = 0; step < 3; step += 1) click("More items");
    expect(readout("Item quantity readout")).toBe("4");

    act(() => {
      published.value = withTechs(published.value, "Parallel Computation");
    });

    expect((screen.getByRole("combobox", { name: "Item" }) as HTMLSelectElement).value).toBe(
      "Cluster",
    );
    expect(readout("Item quantity readout")).toBe("1");
    expect(screen.getByRole("button", { name: "Buy item" }).textContent).toContain("1 × Cluster");
  });

  /*
   * The dial belongs to the base as well as to the item. `BaseDetail` is re-rendered
   * with another base's props by the Prev/Next cycle rather than remounted, so a count dialled
   * on one base was read back on the next one: `Install 8 × PC` on a base the player had only
   * just opened and asked nothing of. The base is held in the dialled pair now, the way the
   * item already was.
   */
  it("starts at one again on the next base of the Prev/Next cycle", () => {
    const { commands, published } = inspectStorageUnit(state(), 2);

    choose("Item", "PC");
    fireEvent.input(screen.getByRole("slider", { name: "Item quantity" }), {
      target: { value: "8" },
    });
    expect(readout("Item quantity readout")).toBe("8");

    click("Next base");
    choose("Item", "PC");

    expect(readout("Item quantity readout")).toBe("1");
    expect(screen.getByRole("button", { name: "Buy item" }).textContent).toContain("1 × PC");
    click("Buy item");

    expect(commands.at(-1)).toEqual({
      command: "buyItem",
      location: "EUROPE",
      base: 1,
      itemType: "PC",
      count: 1,
    });
    expect(basesAt(published.value, "EUROPE")[1]?.items.cpu?.buyable.count).toBe(1);
  });

  /*
   * The other half of the same rule: the base the dial belongs to is the base the player is
   * standing on, and renaming it does not make it another base. A base's identity holds the
   * player's own name for it (`baseKeys`), so a dial keyed on that identity was thrown away by
   * the rename field beside it — the item fell back to `offered[0]` and the count to one, on
   * the base the order was being dialled for.
   */
  it("survives a rename of the base it was dialled on", () => {
    inspectStorageUnit();

    choose("Item", "PC");
    fireEvent.input(screen.getByRole("slider", { name: "Item quantity" }), {
      target: { value: "8" },
    });

    fireEvent.input(screen.getByRole("textbox", { name: "Base name" }), {
      target: { value: "Sanctum" },
    });
    click("Rename base");

    expect((screen.getByRole("combobox", { name: "Item" }) as HTMLSelectElement).value).toBe("PC");
    expect(readout("Item quantity readout")).toBe("8");
    expect(screen.getByRole("button", { name: "Buy item" }).textContent).toContain("8 × PC");
  });

  it("stops at the room the base has left, and refuses when there is none", () => {
    const { commands, published } = inspectStorageUnit();

    choose("Item", "PC");
    // Eight fit; the dial is asked for far more than that and stops at eight.
    for (let step = 0; step < 20; step += 1) click("More items");
    click("Buy item");
    expect(bought(published).items.cpu?.buyable.count).toBe(8);

    // The slot is full of this spec now, so there is nothing left to address.
    expect(readout("Install refusal")).toContain("cannot support any additional");
    expect(screen.getByRole("button", { name: "Buy item" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    click("Buy item");
    expect(commands.length).toBe(2);

    // A different computer needs the whole base, so it replaces rather than joins, and the
    // room it asks for is the base's own size again.
    choose("Item", "Server");
    // The region stands whatever it has to say; with nothing refused it is empty.
    expect(readout("Install refusal")).toBe("");
    click("Buy item");
    expect(installed(bought(published), "cpu")).toBe("Server");
  });

  /*
   * The install half of "refusals announced". The region standing empty was asserted and the
   * `aria-live` that makes it speak was not, so putting it back to `off` left the whole suite
   * green. The destroy sibling is asked the
   * same question in `estate-surface.test.tsx`.
   */
  it("keeps the install refusal in a region that stands before it has anything to say", () => {
    inspectStorageUnit();

    const region = screen.getByRole("status", { name: "Install refusal" });
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");

    choose("Item", "PC");
    for (let step = 0; step < 20; step += 1) click("More items");
    click("Buy item");
    expect(readout("Install refusal")).toContain("cannot support any additional");
  });

  // The slider's right end is the room the base has left, so filling the base is one
  // gesture to the stop rather than pressing + once per computer.
  it("fills the base in one gesture: the slider's right end is the room left", () => {
    const { published } = inspectStorageUnit();

    choose("Item", "PC");
    const dial = screen.getByRole("slider", { name: "Item quantity" });
    expect(dial.getAttribute("max")).toBe("8");
    fireEvent.input(dial, { target: { value: "8" } });
    click("Buy item");

    expect(bought(published).items.cpu?.buyable.count).toBe(8);
    // The base is at capacity: the same spec has no room left, and the surface says so.
    expect(readout("Install refusal")).toContain("cannot support any additional");
  });
});

describe("the hypothetical the item dialog projects", () => {
  it("is what the order draws and where the day goes with it in the queue", () => {
    const { published } = inspectStorageUnit();
    const before = published.value.cash;

    choose("Item", "PC");
    expect(numeric("Projected item cash")).toBe(500);
    click("More items");
    click("More items");
    expect(numeric("Projected item cash")).toBe(1500);

    // The day the HUD is showing carries the finished base's maintenance; the projection is
    // the same day with these computers queued on top, and it follows the dial.
    expect(numeric("Cash flow")).toBe(-30);
    expect(numeric("Projected item cash flow")).toBe(-1530);
    click("Fewer items");
    expect(numeric("Projected item cash flow")).toBe(-1030);

    // Looking is not buying: nothing was spent for any of it.
    expect(published.value.cash).toBe(before);
  });

  it("writes nothing to the State root while it projects", () => {
    const { commands, published } = inspectStorageUnit();
    const root = published.value;
    const snapshot = toPlain(root);
    const spent = commands.length;

    choose("Item", "Gaming PC");
    expect(numeric("Projected item cash")).toBe(1000);
    click("More items");
    expect(numeric("Projected item cash")).toBe(2000);

    expect(published.value).toBe(root);
    expect(toPlain(published.value)).toEqual(snapshot);
    expect(commands.length).toBe(spent);
  });

  it("is the cost the command then actually charges", () => {
    const { published } = inspectStorageUnit();

    choose("Item", "Server");
    click("More items");
    const projected = numeric("Projected item cash");
    click("Buy item");

    expect(bought(published).items.cpu?.buyable.costLeft[CASH]).toBe(projected);
  });
});

describe("a base whose spec forces its computer", () => {
  // Upstream hides every CHANGE button on a force_cpu base (screens/base.py:607) — such a
  // base holds exactly the computer its spec names and nothing the player chooses.
  it("offers no install controls at all", () => {
    const mounted = mount();
    click("EUROPE");
    choose("Base type", "Server Access");
    click("Build bases");
    const name = basesAt(mounted.published.value, "EUROPE")[0]?.name ?? "";
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));

    expect(screen.queryByRole("region", { name: "Install" })).toBe(null);
    expect(screen.queryByRole("combobox", { name: "Item" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Buy item" })).toBe(null);
  });

  it("does not touch the base that forces nothing: a Storage Unit keeps its controls", () => {
    inspectStorageUnit();

    expect(screen.getByRole("region", { name: "Install" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Item" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Buy item" })).toBeTruthy();
  });
});

describe("a base under construction", () => {
  // Upstream never opens the base screen for an unfinished base (screens/location.py:322)
  // and items inside an undone base never progress (player.py:296). The port keeps the
  // detail reachable but offers no install controls until construction finishes.
  it("offers no install controls", () => {
    const mounted = mount();
    click("EUROPE");
    choose("Base type", "Storage Unit");
    click("Build bases");
    const name = basesAt(mounted.published.value, "EUROPE")[0]?.name ?? "";
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));

    expect(screen.queryByRole("region", { name: "Install" })).toBe(null);
    expect(screen.queryByRole("combobox", { name: "Item" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Buy item" })).toBe(null);
  });

  it("offers them once construction finishes", () => {
    inspectStorageUnit();

    expect(screen.getByRole("region", { name: "Install" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Item" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Buy item" })).toBeTruthy();
  });
});

describe("the item affordance", () => {
  it("is reachable with the mouse alone and every control has a name", () => {
    const { container } = inspectStorageUnit();
    // The dial is the CPU slot's, so it is on the screen while a computer is chosen.
    choose("Item", "PC");

    expect(unnamedOperables(container)).toEqual([]);
    for (const name of ["More items", "Fewer items", "Buy item"]) {
      expect(screen.getByRole("button", { name }).tagName).toBe("BUTTON");
    }
    expect(screen.getByRole("combobox", { name: "Item" }).tagName).toBe("SELECT");
    expect(screen.getByRole("slider", { name: "Item quantity" }).tagName).toBe("INPUT");
    // No free-text number entry anywhere on the surface.
    expect(container.querySelector('input[type="number"]')).toBe(null);
  });

  it("offers only the items this location and these techs allow", () => {
    inspectStorageUnit();

    const offered = [...screen.getByRole("combobox", { name: "Item" }).querySelectorAll("option")];
    const ids = offered.map((option) => option.getAttribute("value"));
    expect(ids).toContain("Warning Signs");
    // Gated on a tech nobody has researched here.
    expect(ids).not.toContain("Cluster");
    // A security item for the places a Storage Unit cannot be built.
    expect(ids).not.toContain("Heatsink");
  });

  /*
   * The groups are the four slots, and the player reads the Content's own words for them
   * (`itemtypes_str.dat`) rather than the slot ids the Simulation keys on.
   */
  it("labels the select's groups in the Content's words, not in slot ids", () => {
    inspectStorageUnit();

    const groups = [...screen.getByRole("combobox", { name: "Item" }).querySelectorAll("optgroup")];
    expect(groups.map((group) => group.label)).toEqual(["CPU", "Reactor", "Network", "Security"]);
  });
});

/**
 * The item info block under the select: what upstream's build dialogs say
 * about an item before it is ordered (`ItemSpec.get_info`, `item.py:133-141`, and the
 * bonus lines of `get_quality_info`, `item.py:155-194`) — the build time the projections
 * do not show, the quality in upstream's words, and the item's own description.
 */
describe("the item info block", () => {
  it("shows a computer's CPU line, build time and description", () => {
    const { container } = inspectStorageUnit();
    choose("Item", "Gaming PC");

    // `ItemSpec.get_info` (`item.py:135-139`), player-visible text.
    expect(screen.getByText("Generates 5 CPU (base).")).toBeTruthy();
    // Two declared labor days through the normal difficulty's bonus: 2880 minutes,
    // bucketed as hours by `g.to_time`'s rules (`readouts.ts`).
    expect(screen.getByText("Build time: 48 hours")).toBeTruthy();
    expect(screen.getByText("A high-end consumer-level PC; faster than average.")).toBeTruthy();
    expect(unnamedOperables(container)).toEqual([]);
  });

  it("shows a reactor's detection reduction, in upstream's percent format", () => {
    inspectStorageUnit();
    choose("Item", "Diesel Generator");

    // `get_quality_info` (`item.py:186-188`); 250 on the 10000-point scale is not a whole
    // percent, so `g.to_percent` writes both places.
    expect(screen.getByText("Detection chance reduction: 2.50%")).toBeTruthy();
  });

  it("shows a network item's CPU bonus, whole percents without decimals", () => {
    inspectStorageUnit();
    choose("Item", "High Speed Internet Access");

    expect(screen.getByText("CPU bonus: 1%")).toBeTruthy();
  });

  it("follows the select: another item's info replaces the last one's", () => {
    inspectStorageUnit();
    choose("Item", "Gaming PC");
    choose("Item", "Warning Signs");

    expect(screen.queryByText("Generates 5 CPU (base).")).toBe(null);
    expect(screen.getByText("Detection chance reduction: 5%")).toBeTruthy();
    expect(screen.getByText(/Some simple warning signs/)).toBeTruthy();
  });
});
