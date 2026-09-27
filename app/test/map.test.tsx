import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { signal } from "@preact/signals";
import { SECONDS_PER_DAY, content, type SimulationState } from "@singularity/sim";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { createSession, startHost, type Session } from "../src/host/session.ts";
import type { Speed } from "../src/host/tick-partition.ts";
import { App } from "../src/ui/App.tsx";
import { gridPosition } from "../src/ui/map/geometry.ts";
import { unnamedOperables } from "./support/accessible-names.ts";
import { fakeFrames } from "./support/frames.ts";

afterEach(cleanup);

function mount(session: Session = createSession({ seed: 7 }), speed: Speed = 1): ParentNode {
  return render(<App state={session.state} speed={signal<Speed>(speed)} />).container;
}

const UI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "ui");
const MAP_CSS = readFileSync(resolve(UI, "map", "WorldMap.css"), "utf8");

// The stage's own layout is a stylesheet decision, and the DOM alone cannot show whether a
// row sits above the globe or over it. Read the rule the layout rests on.
// Anchored at the start of a line, so the selector asked for is the rule that is read.
function ruleIn(stylesheet: string, selector: string): string {
  const block = new RegExp(`^${selector.replace(/[.]/g, "\\.")}\\s*\\{([^}]*)\\}`, "m").exec(
    stylesheet,
  );

  expect(block, `no rule for ${selector}`).toBeTruthy();
  return block?.[1] as string;
}

function declarations(selector: string): string {
  return ruleIn(MAP_CSS, selector);
}

// The six globe locations that need no tech. ANTARCTIC and OCEAN are gated, so they are not
// on the map of a game that has finished nothing.
const ON_GLOBE = ["NORTH AMERICA", "SOUTH AMERICA", "EUROPE", "ASIA", "AFRICA", "AUSTRALIA"];

/** The same game with those techs finished, and nothing else changed. */
function withFinished(...techIds: readonly string[]): SimulationState {
  const session = createSession({ seed: 7 });

  return {
    ...session.current,
    techs: session.current.techs.map((tech) =>
      techIds.includes(tech.specId) ? { ...tech, buyable: { ...tech.buyable, done: true } } : tech,
    ),
  };
}

// The app seam: the shell booted from a Session, driven and asserted by accessible name and
// by geometry. Nothing here reaches inside a component.

describe("the map as the application", () => {
  it("is the shell, and every operable element on it has a name a driver can say", () => {
    const container = mount();

    expect(screen.getByRole("region", { name: "World map" })).toBeTruthy();
    expect(unnamedOperables(container)).toEqual([]);
  });

  // The map is full-bleed, always present, and never navigated away from. Every
  // later surface is drawn *over* it, so nothing the shell offers may take it off the screen.
  it("stays on the screen whatever the player clicks", () => {
    const container = mount();

    for (const control of container.querySelectorAll("button, a[href]")) {
      fireEvent.click(control);
    }

    expect(screen.getByRole("region", { name: "World map" })).toBeTruthy();
  });
});

describe("the inset inspector", () => {
  it("opens from a location, switches on-map, and closes with Escape", () => {
    const container = mount();

    fireEvent.click(screen.getByRole("button", { name: "EUROPE" }));

    expect(screen.getByRole("complementary", { name: "Inspector" }).textContent).toContain(
      "EUROPE",
    );
    expect(container.querySelector(".shell")?.classList.contains("shell--inspecting")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "AFRICA" }));
    expect(screen.getByRole("complementary", { name: "Inspector" }).textContent).toContain(
      "AFRICA",
    );
    fireEvent.click(screen.getByRole("button", { name: /University Computer/ }));
    expect(screen.getByRole("region", { name: "University Computer" }).textContent).toContain(
      "Detection chance",
    );

    // Escape steps back one level at a time: detail to table, table to closed.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "University Computer" })).toBe(null);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBe(null);
    expect(container.querySelector(".shell")?.classList.contains("shell--inspecting")).toBe(false);
  });
});

describe("the locations on the globe", () => {
  it("are real buttons, named, and in the Content's own order", () => {
    mount();

    const pins = screen.getAllByRole("button").filter((one) => one.classList.contains("map__pin"));

    expect(pins.map((pin) => pin.getAttribute("aria-label"))).toEqual(ON_GLOBE);
    // Real buttons, not a div wearing a role: focus, activation and the name are the
    // platform's, which is the whole reason the map is DOM and not canvas.
    expect(pins.map((pin) => pin.tagName)).toEqual(ON_GLOBE.map(() => "BUTTON"));
  });

  it("sit at the percentages the Content places them at", () => {
    mount();

    for (const location of content.locations.all.filter((one) => ON_GLOBE.includes(one.name))) {
      const pin = screen.getByRole("button", { name: location.name });
      const { x, y } = gridPosition(location);

      expect(pin.style.left).toBe(`${x}%`);
      expect(pin.style.top).toBe(`${y}%`);
    }

    // Spot-checked against a hand reading of the projection, so a change to
    // `gridPosition` cannot move both the assertion and the value it checks.
    expect(screen.getByRole("button", { name: "NORTH AMERICA" }).style.left).toBe("25%");
    expect(screen.getByRole("button", { name: "EUROPE" }).style.top).toBe("20%");
  });

  // A place the player cannot reach is not on the map at all, rather than on it wearing a
  // lock. ANTARCTIC needs Advanced Database Manipulation,
  // OCEAN needs Autonomous Vehicles.
  it("leaves out the two that need a tech, and adds one when its tech lands", () => {
    mount();

    expect(screen.queryByRole("button", { name: "ANTARCTIC" })).toBe(null);
    expect(screen.queryByRole("button", { name: "OCEAN" })).toBe(null);
    expect(screen.getByRole("button", { name: "EUROPE" })).toBeTruthy();

    cleanup();
    render(
      <App
        state={signal(withFinished("Advanced Database Manipulation"))}
        speed={signal<Speed>(1)}
      />,
    );

    const antarctic = screen.getByRole("button", { name: "ANTARCTIC" });

    expect(antarctic.getAttribute("aria-disabled")).toBe(null);
    // A pin that arrives mid-game is placed by its own position, so it cannot move the pins
    // that were already there.
    expect(antarctic.style.left).toBe("50%");
    expect(screen.getByRole("button", { name: "NORTH AMERICA" }).style.left).toBe("25%");
    expect(screen.queryByRole("button", { name: "OCEAN" })).toBe(null);
  });

  it("counts the bases standing in each location", () => {
    const session = createSession({ seed: 7 });
    mount(session);
    const starting = session.current.locations.find((one) => one.bases.length > 0);

    expect(starting).toBeTruthy();
    const specId = starting?.specId as string;
    const name = content.locations.byId.get(specId)?.name as string;

    expect(screen.getByRole("button", { name }).getAttribute("data-bases")).toBe("1");
    expect(screen.getByRole("button", { name: "AUSTRALIA" }).getAttribute("data-bases")).toBe("0");
  });
});

describe("the three extraterrestrial locations", () => {
  it("are chips above the globe, left to right as their positions place them", () => {
    const { container } = render(
      <App
        state={signal(withFinished("Lunar Rocketry", "Fusion Rocketry", "Space-Time Manipulation"))}
        speed={signal<Speed>(1)}
      />,
    );
    const chips = [...container.querySelectorAll(".map__chip")];

    expect(chips.map((chip) => chip.getAttribute("aria-label"))).toEqual([
      "MOON",
      "FAR REACHES",
      "TRANSDIMENSIONAL",
    ]);
    // ORBIT is `impossible` in the Content: never reachable, so never a chip.
    expect(screen.queryByRole("button", { name: "ORBIT" })).toBe(null);
  });

  // The row floats over the globe's Arctic edge rather than taking a band of the stage, so the
  // globe is sized against the whole stage. Where it lands is measured in `viewport.test.ts`.
  it("float over the globe rather than taking a band of the stage", () => {
    const container = mount();
    const globe = container.querySelector(".map__globe") as HTMLElement;

    expect(globe.querySelector(".map__offworld")).toBeTruthy();
    expect(declarations(".map__offworld")).toMatch(/position:\s*absolute/);
    expect(declarations(".map__globe-area")).toMatch(/container-type:\s*size/);
  });

  it("are absent until the prerequisite tech lands, and a chip when it has", () => {
    mount();
    expect(screen.queryByRole("button", { name: "MOON" })).toBe(null);

    cleanup();
    render(<App state={signal(withFinished("Lunar Rocketry"))} speed={signal<Speed>(1)} />);

    expect(screen.getByRole("button", { name: "MOON" }).getAttribute("aria-disabled")).toBe(null);
    expect(screen.queryByRole("button", { name: "FAR REACHES" })).toBe(null);
  });
});

describe("the day/night terminator", () => {
  it("is one layer, and the hour moves it rather than rebuilding it", async () => {
    const session = createSession({ seed: 7 });
    const container = mount(session);
    const night = container.querySelector(".map__night") as HTMLElement;

    expect(night).toBeTruthy();
    const at = () => night.style.transform;
    const midnight = at();

    session.advanceBy(SECONDS_PER_DAY / 4);
    await expect.poll(at).not.toBe(midnight);

    // A whole game day later the terminator is back where it started: its longitude is a
    // function of the time of day and of nothing else (`screens/map.py:172`).
    session.advanceBy((SECONDS_PER_DAY * 3) / 4);
    await expect.poll(at).toBe(midnight);
  });
});

describe("the HUD", () => {
  it("shows the clock, the speed and the resource pools", () => {
    const session = createSession({ seed: 7, difficulty: "normal" });
    mount(session, 60);

    expect(screen.getByRole("status", { name: "Game time" }).textContent).toBe("Day 0 · 00:00:00");
    expect(screen.getByRole("button", { name: "Speed 60x" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("status", { name: "Cash" }).textContent).toBe("1,000");
    expect(screen.getByRole("status", { name: "CPU" }).textContent).toBeTruthy();
  });

  /**
   * `compute_future_resource_flow` with each pool, which is where upstream's own map screen
   * puts it (`screens/map.py:824`) — in parentheses beside the figure there, on its own line
   * under the figure here: the pool says where the player is, the flow says where the next
   * day takes them.
   *
   * A new game runs one CPU in one finished base and owes nothing, so the day earns the five
   * that one CPU-day of jobs pays and the pool keeps the CPU it did not spend.
   */
  it("shows the day's resource flow with each pool", () => {
    const session = createSession({ seed: 7, difficulty: "normal" });
    mount(session, 60);

    expect(screen.getByRole("status", { name: "Cash flow" }).textContent).toBe("+5");
    expect(screen.getByRole("status", { name: "CPU spare" }).textContent).toBe("1");
  });

  it("keeps each flow inside its pool's cell", () => {
    mount(createSession({ seed: 7 }), 60);
    const cellOf = (name: string) => screen.getByRole("status", { name }).closest(".hud__pool");

    expect(cellOf("Cash flow")).toBe(cellOf("Cash"));
    expect(cellOf("CPU spare")).toBe(cellOf("CPU"));
  });

  it("re-reads every value from the one root the host publishes", async () => {
    const session = createSession({ seed: 7 });
    mount(session);
    const clock = screen.getByRole("status", { name: "Game time" });
    const cash = screen.getByRole("status", { name: "Cash" });
    const before = cash.textContent;

    session.advanceBy(SECONDS_PER_DAY);

    await expect.poll(() => clock.textContent).toBe("Day 1 · 00:00:00");
    // One publication moved both, which is what "everything derives from the root" means:
    // there is no second source for the cash figure to have come from.
    expect(cash.textContent).not.toBe(before);
  });
});

describe("a paused game", () => {
  /**
   * One root beats per-component polling on exactly this: with one signal a
   * paused game re-renders nothing at all, while with polling every component wakes sixty
   * times a second to discover that nothing happened.
   *
   * Asserted in the two ways the seam allows — the root is never republished, and the DOM is
   * never written to — over frames that really did run.
   */
  async function watch(
    session: Session,
    speed: Speed,
  ): Promise<{ publications: number; mutations: number }> {
    const frames = fakeFrames();
    const host = startHost({ session, frames, speed });
    const container = render(<App state={session.state} speed={host.speed} />).container;

    let publications = 0;
    const off = session.state.subscribe(() => {
      publications += 1;
    });
    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(container, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });

    for (let frame = 0; frame < 60; frame += 1) frames.advance(1 / 60);

    // Preact writes to the DOM in a microtask, so the page is a task behind the last frame.
    await new Promise((settled) => setTimeout(settled, 0));
    mutations += observer.takeRecords().length;
    observer.disconnect();
    off();
    host.stop();
    // The initial notification a subscription always gets is not a publication.
    return { publications: publications - 1, mutations };
  }

  it("publishes no root and writes nothing to the page", async () => {
    expect(await watch(createSession({ seed: 7 }), 0)).toEqual({ publications: 0, mutations: 0 });
  });

  it("does both as soon as it is running, so the assertion above is not vacuous", async () => {
    const running = await watch(createSession({ seed: 7 }), 60);

    expect(running.publications).toBeGreaterThan(0);
    expect(running.mutations).toBeGreaterThan(0);
  });
});
