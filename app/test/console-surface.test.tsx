import { signal } from "@preact/signals";
import {
  ITEM_CONSTRUCTED,
  SAVEABLE_LOG_KINDS,
  createInitialState,
  type SimulationState,
} from "@singularity/sim";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { Speed } from "../src/host/tick-partition.ts";
import { App } from "../src/ui/App.tsx";
import { unnamedOperables } from "./support/accessible-names.ts";

afterEach(cleanup);

function mount(initial = createInitialState({ seed: 7, difficulty: "normal" })) {
  const state = signal<SimulationState>(initial);
  const container = render(<App state={state} speed={signal<Speed>(1)} />).container;
  return { container, state };
}

describe("the console", () => {
  it("opens one opaque surface over the map, changes tabs, and closes with Escape", () => {
    const { container } = mount();

    fireEvent.click(screen.getByRole("button", { name: "Console" }));

    expect(screen.getByRole("region", { name: "Console" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "World map" })).toBeTruthy();
    expect(container.querySelector(".console")?.getAttribute("data-bottom")).toBe("reserved-band");
    expect(container.querySelector(".console")?.getAttribute("data-opaque")).toBe("true");
    expect(screen.getByRole("tab", { name: "Log" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: "Report" }));
    expect(screen.getByRole("heading", { name: "Financial report" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "CPU usage" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Statistics" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Console" })).toBe(null);
  });

  it("filters and expands log rows in place while virtualising a 1000-entry log", () => {
    const initial = createInitialState({ seed: 7, difficulty: "normal" });
    const log = Array.from({ length: 1000 }, (_, index) =>
      index % 2 === 0
        ? { kind: "tech-researched", rawEmitTime: index, fields: { tech_id: "Stealth" } }
        : {
            kind: "base-constructed",
            rawEmitTime: index,
            fields: {
              base_name: "Mainframe",
              base_type_id: "Stolen Computer Time",
              base_location_id: "N AMERICA",
            },
          },
    );
    const { container, state } = mount({ ...initial, log });
    fireEvent.click(screen.getByRole("button", { name: "Console" }));

    expect(screen.getAllByRole("checkbox", { name: /Show .* log entries/ })).toHaveLength(6);
    expect(container.querySelectorAll(".console__log-row").length).toBeLessThan(20);
    fireEvent.click(screen.getAllByRole("button", { name: /Tech researched:/ })[0]!);
    expect(screen.getByText(/tech_id: Stealth/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show Tech researched log entries" }));
    expect(container.querySelector(".console__log-row")?.textContent).toContain("Base constructed");

    for (let tick = 0; tick < 5; tick += 1) state.value = { ...state.value, gameTime: tick + 1 };
    expect(container.querySelectorAll(".console__log-row").length).toBeLessThan(20);
  });

  /**
   * The Log tab spelled this kind `item-constructed`, which nothing emits: the Simulation
   * emits `item-in-base-constructed` (`ITEM_CONSTRUCTED`), the same string upstream's
   * `LogItemConstructionComplete` serialises under. So a finished item had no filter row and
   * read under its raw kind.
   */
  it("gives a finished item a filter row and a heading of its own", () => {
    const initial = createInitialState({ seed: 7, difficulty: "normal" });
    const log = [
      {
        kind: ITEM_CONSTRUCTED,
        rawEmitTime: 1,
        fields: { item_spec_id: "PC", item_count: 1, base_name: "Mainframe" },
      },
    ];
    const { container } = mount({ ...initial, log });
    fireEvent.click(screen.getByRole("button", { name: "Console" }));

    expect(screen.getByRole("button", { name: /Item constructed: PC$/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "Show Item constructed log entries" }));
    expect(container.querySelectorAll(".console__log-row")).toHaveLength(0);
  });

  /**
   * The heading names the field it shows, rather than taking whichever field the entry
   * happens to list first. It read right only because `sim/src/advance.ts` and the
   * `LOG_KINDS` table both put the subject first, and that table is now load-bearing for
   * whether a save loads at all — so a reorder there must not retitle the log.
   */
  it("heads a row with the field its kind names, whatever order the entry lists them in", () => {
    const initial = createInitialState({ seed: 7, difficulty: "normal" });
    const log = [
      {
        kind: "base-constructed",
        rawEmitTime: 1,
        fields: {
          base_location_id: "N AMERICA",
          base_type_id: "Stolen Computer Time",
          base_name: "Mainframe",
        },
      },
    ];
    mount({ ...initial, log });
    fireEvent.click(screen.getByRole("button", { name: "Console" }));

    expect(screen.getByRole("button", { name: /Base constructed: Mainframe$/ })).toBeTruthy();
  });

  /**
   * The Console's own log-kind table and the Simulation's saveable kinds are two lists of the
   * same six strings, and they had nothing holding them together. A kind the table misses is
   * not merely mislabelled but invisible: `Log` filters rows against `shown`, seeded from the table
   * alone, so an unlisted kind renders no row at all. That is how `item-constructed` survived.
   *
   * Both directions, from one mount: a kind the table misses loses its row, and a kind the
   * table invents adds a filter the Simulation cannot fill.
   */
  it("gives every saveable log kind a filter row and a log row, and invents none", () => {
    const initial = createInitialState({ seed: 7, difficulty: "normal" });
    const log = SAVEABLE_LOG_KINDS.map((kind, index) => ({
      kind,
      rawEmitTime: index,
      fields: {},
    }));
    const { container } = mount({ ...initial, log });
    fireEvent.click(screen.getByRole("button", { name: "Console" }));

    expect(screen.getAllByRole("checkbox", { name: /Show .* log entries/ })).toHaveLength(
      SAVEABLE_LOG_KINDS.length,
    );
    expect(container.querySelectorAll(".console__log-row")).toHaveLength(SAVEABLE_LOG_KINDS.length);
  });

  /**
   * The console has three tabs. It had four: Knowledge listed every tech, base and item in
   * the game with its description, reached or not — a content browser handed to the player
   * What a player has actually reached is on the surfaces that own it.
   */
  it("offers the player no way to read the content table, and keeps the settings reachable", () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Console" }));

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Log",
      "Report",
      "Settings",
    ]);

    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    // The Content's warnings, the day/night mark, and the off switch for the single-character
    // shortcuts the key list below it governs.
    expect(screen.getAllByRole("checkbox")).toHaveLength(6);
    expect(screen.getByRole("checkbox", { name: "Day/night" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Single-key shortcuts" })).toBeTruthy();
    // The keyboard, written down: the digits were only on a `title`, Escape nowhere.
    expect(screen.getByText("Escape")).toBeTruthy();
    expect(screen.getByText("0 1 2 3 4")).toBeTruthy();
    expect(unnamedOperables(container)).toEqual([]);
  });
});
