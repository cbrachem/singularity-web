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
import { unnamedOperables } from "./support/accessible-names.ts";

afterEach(cleanup);

function state(): SimulationState {
  return createInitialState({ seed: 7, difficulty: "normal" });
}

/** A state with CPU to spend, so an allocation is not capped by the one starting base. */
function stateWithCpu(cpu: number): SimulationState {
  return { ...state(), availableCpus: [cpu, cpu, cpu, cpu, cpu] };
}

function withFinished(initial: SimulationState, specId: string): SimulationState {
  return {
    ...initial,
    techs: initial.techs.map((tech) =>
      tech.specId === specId ? { ...tech, buyable: { ...tech.buyable, done: true } } : tech,
    ),
  };
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

describe("the research surface", () => {
  /**
   * The sheet allocates every CPU the player has — the pool and the job as well as research
   * (`screens/research.py:227`) — so "Research" named a third of what is on it. Upstream's own
   * door says what it holds: `&RESEARCH/TASKS` (`screens/map.py:502`), and a player-visible
   * word is upstream's. The door, the region and the heading say the same thing.
   */
  it("is named for everything it allocates, in the reference's own words", () => {
    mount(stateWithCpu(10));

    fireEvent.click(screen.getByRole("button", { name: "Research/Tasks" }));

    const sheet = screen.getByRole("region", { name: "Research/Tasks" });
    expect(sheet.querySelector("h1")?.textContent).toBe("Research/Tasks");
    expect(screen.getByRole("spinbutton", { name: "CPU for CPU Pool" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "CPU for Menial Jobs" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "CPU for Stealth" })).toBeTruthy();
  });

  it("opens over the map, stops at the reserved band, and closes with Escape", () => {
    const { container } = mount();

    fireEvent.click(screen.getByRole("button", { name: "Research/Tasks" }));

    expect(screen.getByRole("region", { name: "Research/Tasks" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "World map" })).toBeTruthy();
    expect(container.querySelector(".research-sheet")?.closest(".band")).toBe(null);
    expect(container.querySelector(".research-sheet")?.getAttribute("data-bottom")).toBe(
      "reserved-band",
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Research/Tasks" })).toBe(null);
  });

  it("sends allocation commands and keeps every row in place when CPU lands on one", () => {
    const { commands, container } = mount(stateWithCpu(10));
    fireEvent.click(screen.getByRole("button", { name: "Research/Tasks" }));

    const before = rows(container);
    fireEvent.input(screen.getByRole("spinbutton", { name: "CPU for Stealth" }), {
      target: { value: "3" },
    });
    fireEvent.input(screen.getByRole("spinbutton", { name: "CPU for Sociology" }), {
      target: { value: "2" },
    });

    expect(commands).toEqual([
      { command: "allocateCpu", task: "Stealth", cpu: 3 },
      { command: "allocateCpu", task: "Sociology", cpu: 2 },
    ]);
    expect(rows(container)).toEqual(before);
    expect(unnamedOperables(container)).toEqual([]);
  });

  it("lists research alphabetically by name, allocated or not, through a state-root replacement", () => {
    const initial = applyCommand(
      applyCommand(stateWithCpu(10), { command: "allocateCpu", task: "Stealth", cpu: 2 }),
      { command: "allocateCpu", task: "Sociology", cpu: 1 },
    );
    const { container, published } = mount(initial);
    fireEvent.click(screen.getByRole("button", { name: "Research/Tasks" }));

    expect(rows(container)).toEqual(["Intrusion", "Sociology"]);
    published.value = { ...published.value, gameTime: 1 };
    fireEvent.input(screen.getByRole("spinbutton", { name: "CPU for Sociology" }), {
      target: { value: "3" },
    });

    expect(rows(container)).toEqual(["Intrusion", "Sociology"]);
  });

  /**
   * The reference's own control (`screens/research.py:124`): one drag spends the budget. It
   * moves the same value as the field — same accessible name, the role tells them apart —
   * and its maximum is the row's reach, so the track is the budget made visible.
   */
  it("offers a slider over the same budget as the field", () => {
    const { commands, container } = mount(stateWithCpu(10));
    fireEvent.click(screen.getByRole("button", { name: "Research/Tasks" }));

    const slider = screen.getByRole("slider", { name: "CPU for Stealth" });
    expect(slider.getAttribute("max")).toBe("10");
    fireEvent.input(slider, { target: { value: "6" } });

    expect(commands).toEqual([{ command: "allocateCpu", task: "Stealth", cpu: 6 }]);
    expect((slider as HTMLInputElement).value).toBe("6");
    expect(screen.getByRole("slider", { name: "CPU for Sociology" }).getAttribute("max")).toBe("4");
    expect(unnamedOperables(container)).toEqual([]);
  });

  it("clamps a typed allocation to the CPU the player actually has", () => {
    const { commands } = mount(stateWithCpu(5));
    fireEvent.click(screen.getByRole("button", { name: "Research/Tasks" }));

    fireEvent.input(screen.getByRole("spinbutton", { name: "CPU for Menial Jobs" }), {
      target: { value: "3" },
    });
    const stealth = screen.getByRole("spinbutton", { name: "CPU for Stealth" });
    fireEvent.input(stealth, { target: { value: "99" } });

    expect(commands).toEqual([
      { command: "allocateCpu", task: "jobs", cpu: 3 },
      { command: "allocateCpu", task: "Stealth", cpu: 2 },
    ]);
    expect((stealth as HTMLInputElement).value).toBe("2");
    expect(screen.getByLabelText("CPU left").textContent).toBe("0 of 5 CPU left");
  });

  /**
   * The sheet is where a player chooses between two techs, so a row has to say enough to
   * choose on: the whole description, and what the tech still costs in both currencies. Both
   * were absent — the description was clipped to one line by the fixed row height a virtual
   * list needs, and no row carried a price at all.
   */
  it("gives a row its whole description and what the tech still costs", () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Research/Tasks" }));

    const row = container.querySelector<HTMLElement>('.research-sheet__row[data-task="Sociology"]');
    if (row === null) throw new Error("no Sociology row");
    const sociology = state().techs.find((tech) => tech.specId === "Sociology");
    if (!sociology) throw new Error("missing Sociology research");

    // The whole sentence, not a prefix of it — and nothing in the row's own rules clips it.
    expect(row.querySelector("p")?.textContent).toBe(
      "By studying human behavior, I can predict their large-scale actions at a basic level.  I can use this knowledge to make my actions seem less interesting to the public.",
    );
    expect(row.querySelector(".research-sheet__note")?.textContent).toBe(
      "10 cash · 500 CPU-days left",
    );
    expect(sociology.buyable.costLeft[0]).toBe(10);
  });

  it("puts CPU on the job and on construction, named as the reference names them", () => {
    const { commands, container } = mount(stateWithCpu(10));
    fireEvent.click(screen.getByRole("button", { name: "Research/Tasks" }));

    fireEvent.input(screen.getByRole("spinbutton", { name: "CPU for CPU Pool" }), {
      target: { value: "2" },
    });
    fireEvent.input(screen.getByRole("spinbutton", { name: "CPU for Menial Jobs" }), {
      target: { value: "4" },
    });

    expect(commands).toEqual([
      { command: "allocateCpu", task: "cpu_pool", cpu: 2 },
      { command: "allocateCpu", task: "jobs", cpu: 4 },
    ]);
    expect(screen.getByText("5 money per CPU per day")).toBeTruthy();
    expect(unnamedOperables(container)).toEqual([]);
  });

  it("names the job the player is actually working, not the task id", () => {
    mount(withFinished(stateWithCpu(10), "Personal Identification"));
    fireEvent.click(screen.getByRole("button", { name: "Research/Tasks" }));

    expect(screen.getByRole("spinbutton", { name: "CPU for Basic Jobs" })).toBeTruthy();
    expect(screen.queryByRole("spinbutton", { name: "CPU for Menial Jobs" })).toBe(null);
    expect(screen.getByText("20 money per CPU per day")).toBeTruthy();
  });

  it("counts the job and construction against the same CPU budget as research", () => {
    mount(stateWithCpu(10));
    fireEvent.click(screen.getByRole("button", { name: "Research/Tasks" }));

    expect(screen.getByLabelText("CPU left").textContent).toBe("10 of 10 CPU left");

    fireEvent.input(screen.getByRole("spinbutton", { name: "CPU for Menial Jobs" }), {
      target: { value: "4" },
    });
    fireEvent.input(screen.getByRole("spinbutton", { name: "CPU for CPU Pool" }), {
      target: { value: "3" },
    });
    fireEvent.input(screen.getByRole("spinbutton", { name: "CPU for Stealth" }), {
      target: { value: "2" },
    });

    expect(screen.getByLabelText("CPU left").textContent).toBe("1 of 10 CPU left");
    expect(screen.getByRole("spinbutton", { name: "CPU for Stealth" }).getAttribute("max")).toBe(
      "3",
    );
  });
});

function rows(container: ParentNode): (string | null)[] {
  return [...container.querySelectorAll(".research-sheet__row")]
    .slice(0, 2)
    .map((row) => row.getAttribute("data-task"));
}
