import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fireEvent, screen } from "@testing-library/preact";
import {
  advance,
  allBases,
  applyCommand,
  createInitialState,
  toPlain,
  type Command,
  type SimulationState,
} from "@singularity/sim";
import { SCENARIO_FORMAT_VERSION, parseScenario } from "@singularity/sim/scenario-format";
import licences from "virtual:licences";
import { afterEach, describe, expect, it } from "vitest";

import { MOUNT_SELECTOR, boot, type Booted } from "../src/boot.tsx";
import type { Begin } from "../src/cold-start.tsx";
import { developmentColdStart } from "../src/development/boot.tsx";
import { developmentFlags } from "../src/development/flags.ts";
import { replayScenario } from "../src/development/scenarios.ts";
import type { Autosave } from "../src/host/autosave.ts";
import {
  AUTOSAVE_KEY,
  SAVE_KEY_PREFIX,
  createSaveStore,
  type SaveStore,
} from "../src/host/save-store.ts";
import { saveDocument, serialiseSave } from "../src/host/save.ts";
import { createSession } from "../src/host/session.ts";
import {
  accessibleName,
  reachableOperables,
  unnamedOperables,
} from "./support/accessible-names.ts";
import { fakeFrames, type FakeFrames } from "./support/frames.ts";
import { fakeStorage } from "./support/storage.ts";

// The Scenario the development entry point replays when it is asked for one by name, read
// here from the file rather than from the module under test: the assertion below is that the
// application lands in the state this script reaches, so the script has to arrive
// independently of the code that replays it.
import estateDocument from "../../scenarios/estate.scenario.json";

const SCENARIO_SUFFIX = ".scenario.json";

const scenarioDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "scenarios");

/**
 * The Scenarios the repository committed, read off the directory rather than out of the
 * module under test. The entry point's import list is static by necessity — a bundler
 * resolves a static specifier and not a computed one — so nothing about adding a file to
 * `scenarios/` adds it to that list. This is the reader that notices.
 */
function committedScenarios(): string[] {
  return readdirSync(scenarioDirectory)
    .filter((name) => name.endsWith(SCENARIO_SUFFIX))
    .map((name) => name.slice(0, -SCENARIO_SUFFIX.length))
    .sort();
}

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  document.body.innerHTML = "";
});

function aPage(): Document {
  document.body.innerHTML = `<div id="${MOUNT_SELECTOR.slice(1)}"></div>`;
  return document;
}

const anAutosave = (): Autosave & { requests: number } => {
  const stub = {
    requests: 0,
    request: () => (stub.requests += 1),
    flush: () => {},
    discard: () => {},
    pending: false,
  };
  return stub;
};

interface DevelopmentPage {
  readonly booted: Booted | undefined;
  readonly frames: FakeFrames;
  readonly store: SaveStore;
  readonly autosave: Autosave & { requests: number };
}

/**
 * The page `main.tsx` builds, with the two globals replaced: the test's frames and a store
 * over the test's storage. `begin` is `main.tsx`'s own — one `boot()` per game the player
 * chooses — so what is under test here is the development entry point over the shipped
 * wiring rather than a second arrangement of it.
 */
function developmentPage(
  search: string,
  {
    speed = 1,
    frames = fakeFrames(),
    store = createSaveStore(fakeStorage()),
  }: { speed?: number; frames?: FakeFrames; store?: SaveStore } = {},
): DevelopmentPage {
  const into = aPage();
  const autosave = anAutosave();
  const begin: Begin = (session, options = {}) =>
    boot({
      into,
      speed: speed as 1,
      session,
      frames: options.frames ?? frames,
      ...(options.onLeave === undefined ? {} : { onLeave: options.onLeave }),
      ...(options.autosaves === false ? {} : { autosave }),
    });

  const booted = developmentColdStart({
    into,
    store,
    startDay: 0,
    licences,
    begin,
    frames,
    search,
  });
  if (booted !== undefined) stops.push(booted.host.stop);
  return { booted, frames, store, autosave };
}

/** The one the flags booted straight away, which these tests then drive. */
function replayed(search: string, options?: Parameters<typeof developmentPage>[1]): Booted {
  const { booted } = developmentPage(search, options);
  if (booted === undefined) throw new Error(`${search} opened the start screen`);
  return booted;
}

/** The state the estate Scenario reaches, derived here step by step from the file. */
function estateDerived(): SimulationState {
  let state = createInitialState({
    seed: estateDocument.seed,
    difficulty: estateDocument.difficulty,
  });
  for (const step of estateDocument.script) {
    state =
      "advanceBy" in step
        ? advance(state, step.advanceBy as number).state
        : applyCommand(state, step as unknown as Command);
  }
  return state;
}

/** The clock, addressed the way a driver addresses it: by role and accessible name. */
function clock(): HTMLElement {
  return screen.getByRole("status", { name: "Game time" });
}

function bar(): HTMLElement {
  return screen.getByRole("complementary", { name: "Development" });
}

describe("booting from a Scenario in development", () => {
  it("lands in the state the named Scenario reaches", () => {
    const { session } = replayed("?scenario=estate");

    // Five days of it, and an estate that is not the one a new game starts with — so a
    // replay that quietly ran nothing cannot pass.
    expect(clock().textContent).toBe("Day 5 · 00:00:00");
    expect([...allBases(session.state.value)].length).toBeGreaterThan(1);
    expect(toPlain(session.state.value)).toEqual(toPlain(estateDerived()));
  });

  // A Save restores a state that was reached; a Scenario boot re-derives it.
  // The two are told apart by the Session's origin, and the re-derivation is the equality
  // above: the state root is what the seed and the script produce, not what a document held.
  it("is distinguishable from a save load, and says how many steps it replayed", () => {
    const { session } = replayed("?scenario=estate");

    expect(session.origin).toEqual({
      kind: "scenario",
      id: "estate",
      steps: estateDocument.script.length,
    });
    expect(bar().textContent).toContain("estate");
  });

  it("replays the same Scenario to the same state, so a screenshot is reproducible by name", () => {
    const first = replayed("?scenario=estate");
    const second = replayed("?scenario=estate");

    expect(toPlain(second.session.state.value)).toEqual(toPlain(first.session.state.value));
  });

  it("names the Scenarios it has when asked for one it has not", () => {
    expect(() => developmentPage("?scenario=nowhere")).toThrow(/nowhere.*estate/s);
  });
});

// Scenario boot is entered from the start screen rather than beside it. The flag is the deep
// link past it — a Scenario boot is reproducible by name, and reproducible by name means by
// URL — and with no flag the page opens where every other way into a game is.
describe("Scenario boot entered from the start screen", () => {
  it("opens the start screen when no Scenario is named", () => {
    const { booted } = developmentPage("");

    expect(booted).toBeUndefined();
    expect(screen.getByRole("button", { name: "New Game" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Development" })).toBeNull();
  });

  it("offers every Scenario this build carries, and replays the one that is chosen", () => {
    developmentPage("?scenario=none");

    expect(screen.getByRole("button", { name: "Replay estate" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replay estate" }));

    expect(clock().textContent).toBe("Day 5 · 00:00:00");
    expect(bar().textContent).toContain("estate");
  });

  /**
   * One button per Scenario in `scenarios/`, and this is the assertion that keeps it true.
   * The entry point names its Scenarios one import at a time, so a Scenario committed for
   * the trace seam and not added to that list has no button and cannot be named in
   * `?scenario=` either — it is reachable by the harness and unreachable by a developer.
   */
  it("offers one button per Scenario in scenarios/, so none is committed unreachable", () => {
    developmentPage("");

    const list = screen.getByRole("navigation", { name: "Replay a Scenario" });
    const offered = reachableOperables(list)
      .map(accessibleName)
      .map((name) => name.replace(/^Replay /, ""))
      .sort();

    expect(offered).toEqual(committedScenarios());
  });

  /**
   * A lost game leaves for the start screen, and the panel that says so is modal: the shell
   * puts the map, the HUD and the console out of reach behind it. So a replay with
   * no way back is not merely awkward — the deep link lands the developer on a page with
   * nothing on it to reach at all. The Scenario is entered by URL, but the screen it is a
   * deep link past is right there to go back to.
   */
  it("gives a Scenario that ends in a loss the same way back every lost game has", () => {
    developmentPage("?scenario=lost-to-suspicion");
    const mount = document.querySelector(MOUNT_SELECTOR);
    if (mount === null) throw new Error("the application is not mounted");

    expect(reachableOperables(mount).map(accessibleName)).toEqual(["Back to the start screen"]);

    fireEvent.click(screen.getByRole("button", { name: "Back to the start screen" }));

    // The start screen the flag deep-linked past, with the Scenario list on it — and the bar
    // gone with the game it described.
    expect(screen.getByRole("button", { name: "New Game" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replay lost-to-suspicion" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Development" })).toBeNull();
  });

  it("gives one chosen on the start screen the same way back", () => {
    developmentPage("");
    fireEvent.click(screen.getByRole("button", { name: "Replay lost-every-base" }));

    fireEvent.click(screen.getByRole("button", { name: "Back to the start screen" }));

    expect(screen.getByRole("button", { name: "New Game" })).toBeTruthy();
  });

  it("starts an empty game from the start screen's own way in", () => {
    developmentPage("");

    fireEvent.click(screen.getByRole("button", { name: "New Game" }));
    fireEvent.click(screen.getByRole("button", { name: "NORMAL" }));

    expect(clock().textContent).toBe("Day 0 · 00:00:00");
    expect(bar().textContent).toContain("New game");
  });
});

// What the development entry point may change about the page `main.tsx` built, and what it
// may not. `bun run dev` is the shipped arrangement plus the affordances rather than a second
// arrangement that could drift from it — so a game the player chose, and its autosave, reach
// development untouched unless a Scenario replaces them.
describe("the development entry point over the shipped wiring", () => {
  it("keeps the autosave for a game the player started", () => {
    developmentPage("");

    fireEvent.click(screen.getByRole("button", { name: "New Game" }));
    fireEvent.click(screen.getByRole("button", { name: "NORMAL" }));

    expect(bar().textContent).toContain("autosave on");
  });

  // A re-derived state is not a game the player is keeping. Autosaving it would write a
  // replay over the slot their own game lives in, which is the loss the save store refuses.
  it("replaces the game and leaves the save store alone when a Scenario is asked for", () => {
    const { booted, store } = developmentPage("?scenario=estate");

    expect(booted?.session.origin).toEqual({
      kind: "scenario",
      id: "estate",
      steps: estateDocument.script.length,
    });
    expect(bar().textContent).toContain("autosave off");
    expect(store.resume(0).state).toBeUndefined();
  });

  // The Session and the bar agree on what a resumed save is called, which is what lets the
  // bar say it rather than call every game that was not replayed a new one.
  it("says a resumed save is a resumed save", () => {
    const storage = fakeStorage();
    const played = createSession({ seed: 7, difficulty: "normal" });
    played.advanceBy(86400);
    storage.setItem(
      `${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`,
      serialiseSave(saveDocument(played.current, 1_700_000_000)),
    );

    developmentPage("", { store: createSaveStore(storage) });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(bar().textContent).toContain("Resumed from a save");
  });
});

// Scenario boot matters only if the booted state is the state the fidelity run compares, and
// the replay drives the Simulation through the Session while the trace harness drives it
// through `advance` directly. Those two agree on every step a Scenario can carry — and a
// zero-length advance is not one, because it is exactly where they would not: `advance` makes
// a fresh root for it, `Session.tick` returns without making one. The Scenario format refuses
// it (`@singularity/sim/scenario-format`, `tools/trace/scenario.py`); the replay refuses it
// again rather than trusting that, because nothing parses the file on its way into the browser.
describe("a Scenario the replay may not be handed", () => {
  const withScript = (script: readonly unknown[]) => ({
    formatVersion: SCENARIO_FORMAT_VERSION,
    id: "fabricated",
    description: "a Scenario built in a test",
    seed: 1,
    difficulty: "normal",
    script,
  });

  it("refuses an advance of no time at all, naming the step", () => {
    expect(() => replayScenario(withScript([{ advanceBy: 60 }, { advanceBy: 0 }]))).toThrow(
      /step 1/,
    );
    expect(() => replayScenario(withScript([{ advanceBy: 0 }]))).toThrow(/at least 1/);
  });

  it("replays the same script when every advance is one the two drivers agree on", () => {
    const session = replayScenario(withScript([{ advanceBy: 60 }, { advanceBy: 60 }]));

    expect(session.state.value.gameTime).toBe(120);
  });
});

// The port reads a Scenario twice — the trace harness parses the file, the development entry
// point imports it and replays it through the Session — and the two readings have to be one
// reading, or the page boots into a state no Trace ever bound.
//
// Where that is observable is a step the format forbids and the Simulation is happy to be
// handed anyway. An advance written beside a Command is the plain case: the format refuses
// the step outright, and a replay that only asks "is there an `advanceBy`" advances the clock
// and drops the Command without a word. So the two readings are compared step by step, and
// the comparison is over what each of them *refuses*, not over what either says.
describe("the format the replay reads a Scenario by", () => {
  const CPU = { command: "allocateCpu", task: "jobs", cpu: 1 };

  const document = (step: unknown) => ({
    formatVersion: SCENARIO_FORMAT_VERSION,
    id: "fabricated",
    description: "a Scenario built in a test",
    seed: 1,
    difficulty: "normal",
    script: [{ advanceBy: 60 }, step],
  });

  const refuses = (read: () => unknown): boolean => {
    try {
      read();
      return false;
    } catch {
      return true;
    }
  };

  it("refuses in the browser exactly the steps the format refuses", () => {
    const steps: readonly unknown[] = [
      { advanceBy: 3600 },
      CPU,
      { advanceBy: 0 },
      { advanceBy: 1.5 },
      // Neither an advance nor a Command, and read as both a step at a time: the format
      // refuses it, `advanceBy` alone replays it as an advance.
      { ...CPU, advanceBy: 60 },
      // A misspelt field is the same fault worn differently — the step is not the step the
      // recorder would have applied, and every field it does carry is still understood.
      { ...CPU, speed: 2 },
      { advanceBy: 60, until: "day 2" },
    ];

    const byParser = steps.map((step) => refuses(() => parseScenario(document(step))));
    const byReplay = steps.map((step) => refuses(() => replayScenario(document(step))));

    // Named, so the agreement below cannot be an agreement to refuse nothing.
    expect(steps.filter((_, index) => byParser[index])).toEqual(steps.slice(2));
    expect(byReplay).toEqual(byParser);
  });
});

describe("the frozen clock", () => {
  // A screenshot is stable rather than containing a figure that moved between two frames.
  // The clock is frozen where the Host reads it, so every frame is worth no
  // game time at all — the frame loop still runs and the page still repaints.
  it("stops the rendered state changing however many frames pass", async () => {
    const frames = fakeFrames();
    replayed("?scenario=estate&clock=frozen", { frames, speed: 60 });

    for (let frame = 0; frame < 10; frame += 1) frames.advance(0.1);

    // The frames were delivered — the page is repainting, it is game time that stopped.
    expect(frames.delivered).toBe(10);
    await expect.poll(() => clock().textContent).toBe("Day 5 · 00:00:00");
  });

  it("is a flag: the same frames advance the game when the clock is running", async () => {
    const frames = fakeFrames();
    replayed("?scenario=estate&clock=running", { frames, speed: 60 });

    for (let frame = 0; frame < 10; frame += 1) frames.advance(0.1);

    await expect.poll(() => clock().textContent).toBe("Day 5 · 00:01:00");
  });
});

// A driver says "click Advance one game day", never a coordinate.
describe("driving the application by accessible name", () => {
  it("advances the game by exactly a day when the named button is pressed", async () => {
    replayed("?scenario=estate&clock=frozen");

    fireEvent.click(screen.getByRole("button", { name: "Advance one game day" }));

    await expect.poll(() => clock().textContent).toBe("Day 6 · 00:00:00");
  });

  it("leaves no operable element without an accessible name", () => {
    replayed("?scenario=estate&clock=frozen");

    expect(unnamedOperables(document.body)).toEqual([]);
  });

  it("leaves none on the start screen either, Scenario list and all", () => {
    developmentPage("");

    expect(unnamedOperables(document.body)).toEqual([]);
  });
});

describe("the development flags", () => {
  // With nothing asked for, the page opens where every way into a game is. Naming
  // a Scenario is the deep link past the start screen, not the arrangement.
  it("names no Scenario, and runs the clock, when nothing is asked for", () => {
    expect(developmentFlags("")).toEqual({ scenario: undefined, frozen: false });
    expect(developmentFlags("?")).toEqual({ scenario: undefined, frozen: false });
    expect(developmentFlags("?scenario=none")).toEqual({ scenario: undefined, frozen: false });
  });

  it("reads the Scenario and the clock out of the query", () => {
    expect(developmentFlags("?scenario=grace-full&clock=frozen")).toEqual({
      scenario: "grace-full",
      frozen: true,
    });
  });

  // Development-only, so a typo is loud rather than quietly ignored: a flag that silently
  // did nothing is how a screenshot ends up taken against the wrong state.
  it("refuses a clock setting it does not know, naming the ones it does", () => {
    expect(() => developmentFlags("?clock=stopped")).toThrow(/stopped.*frozen.*running/s);
  });
});
