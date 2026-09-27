import { signal } from "@preact/signals";
import {
  applyCommand,
  createInitialState,
  type BaseState,
  type Command,
  type SimulationState,
} from "@singularity/sim";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { createSession } from "../src/host/session.ts";
import type { Speed } from "../src/host/tick-partition.ts";
import { App } from "../src/ui/App.tsx";
import { unnamedOperables } from "./support/accessible-names.ts";
import { choose } from "./support/choose.ts";

afterEach(cleanup);

// The app seam: the shell booted from a State root, driven by accessible name. Renaming is
// asserted as the Command that left the surface, the State root the Host published back, and
// the log the Simulation wrote afterwards. Nothing here reaches inside a component.

const NAME_FIELD = "Base name";
const RENAME = "Rename base";

function mount(initial = createInitialState({ seed: 7, difficulty: "normal" })) {
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

function click(name: string | RegExp): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

function type(value: string): void {
  fireEvent.input(screen.getByRole("textbox", { name: NAME_FIELD }), { target: { value } });
}

function field(): HTMLInputElement {
  return screen.getByRole("textbox", { name: NAME_FIELD }) as HTMLInputElement;
}

function basesAt(state: SimulationState, locationId: string): readonly BaseState[] {
  const location = state.locations.find((candidate) => candidate.specId === locationId);
  if (!location) throw new Error(`no such location: ${locationId}`);
  return location.bases;
}

function openBase(published: { value: SimulationState }, locationId: string, index: number): void {
  const name = basesAt(published.value, locationId)[index]?.name ?? "";
  click(new RegExp(`^${name}`));
}

/** `count` bases of the cheapest buildable type, built in EUROPE and the first one opened. */
function buildAndOpen(count = 1) {
  const mounted = mount();
  click("EUROPE");
  choose("Base type", "Server Access");
  for (let step = 1; step < count; step += 1) click("More bases");
  click("Build bases");
  openBase(mounted.published, "EUROPE", 0);
  return mounted;
}

describe("renaming a base", () => {
  it("sends the name the player typed and the surface carries it", () => {
    const { commands, published } = buildAndOpen();
    const given = basesAt(published.value, "EUROPE")[0]?.name ?? "";
    expect(field().value).toBe(given);

    type("Fortress");
    click(RENAME);

    expect(commands.slice(1)).toEqual([
      { command: "renameBase", location: "EUROPE", base: 0, name: "Fortress" },
    ]);
    expect(basesAt(published.value, "EUROPE")[0]?.name).toBe("Fortress");
    expect(screen.getByRole("region", { name: "Fortress" })).toBeTruthy();
  });

  /*
   * Upstream renames on `if name:` and does nothing at all otherwise
   * (`screens/location.py:346`), so an empty field is refused without a sentence of the
   * port's own being invented for it.
   */
  it("sends nothing at all for an empty name", () => {
    const { commands, published } = buildAndOpen();
    const given = basesAt(published.value, "EUROPE")[0]?.name ?? "";

    type("");
    click(RENAME);

    expect(commands).toHaveLength(1);
    expect(basesAt(published.value, "EUROPE")[0]?.name).toBe(given);
    expect(screen.getByRole("button", { name: RENAME }).getAttribute("aria-disabled")).toBe("true");
  });

  /*
   * The field belongs to the base it was filled from. The detail is re-rendered with another
   * base's props by the Prev/Next cycle rather than remounted, so a draft that outlived that
   * would be pointed at a base the player never typed it for.
   */
  it("follows the base the player is looking at through the Prev/Next cycle", () => {
    const { commands, published } = buildAndOpen(2);
    const [first, second] = basesAt(published.value, "EUROPE");
    type("Fortress");

    click("Next base");

    expect(field().value).toBe(second?.name);
    click(RENAME);
    expect(commands.at(-1)).toEqual({
      command: "renameBase",
      location: "EUROPE",
      base: 1,
      name: second?.name,
    });

    click("Previous base");
    expect(field().value).toBe(first?.name);
  });

  it("is reachable with the mouse alone and every control has a name", () => {
    const { container } = buildAndOpen();

    expect(unnamedOperables(container)).toEqual([]);
    expect(screen.getByRole("button", { name: RENAME }).tagName).toBe("BUTTON");
    expect(field().tagName).toBe("INPUT");
  });
});

/**
 * The other half of the criterion: a renamed base is named by the player everywhere the
 * Simulation would have named it itself — the log a finished base writes carries whatever
 * name the base has at the moment it finishes (`sim/src/advance.ts`, `baseConstructedLog`).
 */
describe("the renamed base in the log", () => {
  it("is written under the player's name, not the one the Simulation drew", () => {
    const session = createSession({ seed: 7, difficulty: "normal" });
    render(
      <App
        state={session.state}
        speed={signal<Speed>(1)}
        onCommand={(command) => session.apply(command)}
      />,
    );
    click("EUROPE");
    choose("Base type", "Server Access");
    click("Build bases");
    const given = basesAt(session.current, "EUROPE")[0]?.name ?? "";
    openBase({ value: session.current }, "EUROPE", 0);

    type("Fortress");
    click(RENAME);
    session.advanceBy(86400);

    click("Console");
    const rows = screen
      .getAllByRole("button", { name: /Base constructed:/ })
      .map((row) => row.textContent ?? "");
    expect(rows).toContainEqual(expect.stringContaining("Base constructed: Fortress"));
    expect(rows.join(" ")).not.toContain(given);
  });
});
