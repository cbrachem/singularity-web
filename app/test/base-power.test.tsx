import { signal } from "@preact/signals";
import {
  applyCommand,
  createInitialState,
  type BaseState,
  type Command,
  type SimulationState,
} from "@singularity/sim";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { Speed } from "../src/host/tick-partition.ts";
import { App } from "../src/ui/App.tsx";
import { unnamedOperables } from "./support/accessible-names.ts";
import { choose } from "./support/choose.ts";

afterEach(cleanup);

// The app seam: the shell booted from a State root, driven by accessible name. The power
// switch is asserted as the Command that left the surface and the State root the Host
// published back — never by reaching inside a component.

/** Seed 7 starts the player in AFRICA, with a finished base and a finished computer in it. */
const START = "AFRICA";

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

function basesAt(state: SimulationState, locationId: string): readonly BaseState[] {
  const location = state.locations.find((candidate) => candidate.specId === locationId);
  if (!location) throw new Error(`no such location: ${locationId}`);
  return location.bases;
}

/** The starting base, inspected the way a player reaches it: a location, then a base in it. */
function inspectStartingBase() {
  const mounted = mount();
  click(START);
  const name = basesAt(mounted.published.value, START)[0]?.name ?? "";
  click(new RegExp(`^${name}`));
  return mounted;
}

/**
 * A base ordered a moment ago: unfinished, computerless, and therefore offline for good.
 *
 * Server Access is the only type a new game offers — every other one in `content/bases.json`
 * sits behind a tech. It carries a forced Server, but not before the base is finished, which
 * is what makes it computerless here.
 */
function inspectFreshBase() {
  const mounted = mount();
  click("EUROPE");
  choose("Base type", "Server Access");
  click("Build bases");
  const name = basesAt(mounted.published.value, "EUROPE")[0]?.name ?? "";
  click(new RegExp(`^${name}`));
  return mounted;
}

function powerState(published: { value: SimulationState }, locationId: string): string {
  return basesAt(published.value, locationId)[0]?.powerState ?? "";
}

const SWITCH = "Switch power state";

describe("switching a base's power state", () => {
  it("moves the base between the states it can hold, one command per press", () => {
    const { commands, published } = inspectStartingBase();
    expect(powerState(published, START)).toBe("active");

    click(SWITCH);
    expect(commands).toEqual([{ command: "switchPower", location: START, base: 0 }]);
    expect(powerState(published, START)).toBe("sleep");

    click(SWITCH);
    expect(commands).toHaveLength(2);
    expect(powerState(published, START)).toBe("active");
  });

  /*
   * The button used to be named after the state the press moved into — `Switch to sleep`,
   * then `Switch to active` — so a driver had to know the base's state before it could
   * address the control at all, which is what the stable-accessible-name rule is against.
   * One name across every press; the state is a readout beside it.
   */
  it("keeps one name across every press, whichever state the base is in", () => {
    const { published } = inspectStartingBase();
    const button = screen.getByRole("button", { name: SWITCH });

    click(SWITCH);
    expect(powerState(published, START)).toBe("sleep");
    expect(screen.getByRole("button", { name: SWITCH })).toBe(button);

    click(SWITCH);
    expect(powerState(published, START)).toBe("active");
    expect(screen.getByRole("button", { name: SWITCH })).toBe(button);
  });

  it("says which state the base is in, in a region that answers the press", () => {
    const { published } = inspectStartingBase();
    const base = basesAt(published.value, START)[0] as BaseState;
    const state = screen.getByRole("status", { name: "Power state" });
    expect(state.getAttribute("aria-live")).toBe("polite");
    expect(state.textContent).toBe("Active");

    click(SWITCH);

    expect(state.textContent).toBe("Sleep");
    expect(screen.getByRole("region", { name: base.name }).textContent).toContain("Sleep");
  });

  /*
   * The absence is driven rather than named. A query for one accessible name
   * answers null both when nothing is offered and when the control is offered under some
   * other name, so it carried this case only as long as some *other* assertion was red — for
   * a while, only the refusal's was. Every control the detail does offer is pressed instead,
   * and the rule is what came back out: no press on this base can switch a state it cannot
   * hold. Every operable is a real button (`operable.test.tsx`), so the region's buttons are
   * the whole of what a player can press here.
   */
  it("offers no state a base without a finished computer cannot hold", () => {
    const { commands, published } = inspectFreshBase();
    expect(powerState(published, "EUROPE")).toBe("offline");

    const base = basesAt(published.value, "EUROPE")[0] as BaseState;
    const detail = within(screen.getByRole("region", { name: base.name }));
    for (const control of detail.getAllByRole("button")) fireEvent.click(control);

    expect(commands.filter((command) => command.command === "switchPower")).toEqual([]);
    expect(powerState(published, "EUROPE")).toBe("offline");
    expect(detail.queryByRole("button", { name: SWITCH })).toBeNull();
    expect(screen.getByRole("status", { name: "Power state" }).textContent).toBe("Offline");
    expect(screen.getByRole("status", { name: "Power refusal" }).textContent).toContain("offline");
  });
});

/*
 * The fixture above once asked for a "Warehouse" base type and drove a Server Access one
 * instead: no option carries that value, so the change event never reached the surface and the
 * select kept what it had. The fixture's name said one thing and the command that left the
 * surface said another, and nothing was red. A driver that silently does nothing is a test
 * that can pass while steering nothing.
 */
describe("driving a select by accessible name", () => {
  it("refuses a base type the game does not offer, rather than keeping its own", () => {
    mount();
    click("EUROPE");

    expect(() => choose("Base type", "Warehouse")).toThrow(/Warehouse/);
    const select = screen.getByRole("combobox", { name: "Base type" }) as HTMLSelectElement;
    expect(select.value).toBe("Server Access");
  });
});

describe("the power affordance", () => {
  it("is a named button, reachable with the mouse alone", () => {
    const { container } = inspectStartingBase();

    expect(unnamedOperables(container)).toEqual([]);
    expect(screen.getByRole("button", { name: SWITCH }).tagName).toBe("BUTTON");
  });
});
