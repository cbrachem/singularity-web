import { signal } from "@preact/signals";
import { DISPLAY_DISCOVER, SECONDS_PER_DAY, WIN, type SimulationState } from "@singularity/sim";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { Notification as NotificationState } from "../src/host/notifications.ts";
import { createSession } from "../src/host/session.ts";
import type { Speed } from "../src/host/tick-partition.ts";
import { App } from "../src/ui/App.tsx";
import type { LicenceDocument } from "../src/ui/licences/document.ts";
import { DANGER_LEVELS, threatReadout } from "../src/ui/threat.ts";
import { unnamedOperables } from "./support/accessible-names.ts";

afterEach(cleanup);

// The app seam: the shell booted from a Session with the clock in the test's hands, driven
// and asserted by accessible name and by geometry. Nothing here reaches inside a component.

const GROUPS = ["NEWS", "SCIENCE", "COVERT", "PUBLIC"];
const MEASURES = ["suspicion", "detect rate"];

function mount(state: SimulationState, licences?: LicenceDocument): ParentNode {
  return render(
    <App state={signal(state)} speed={signal<Speed>(1)} {...(licences && { licences })} />,
  ).container;
}

/** A document with nothing in it, which is all the licences surface needs to be a surface. */
const EMPTY_LICENCES: LicenceDocument = {
  commit: "0".repeat(40),
  dirty: false,
  source: undefined,
  preamble: "",
  sections: [],
};

function newGame(): SimulationState {
  return createSession({ seed: 7, difficulty: "normal" }).current;
}

/**
 * The same game a year on, out of the player's grace period and with the starting base past
 * its own — which is what puts a number on the band rather than a sentence.
 */
function underObservation(changes: Partial<SimulationState> = {}): SimulationState {
  const state = newGame();
  return {
    ...state,
    hadGrace: false,
    gameTime: SECONDS_PER_DAY * 365,
    groups: state.groups.map((group, index) => ({ ...group, suspicion: index * 2600 })),
    ...changes,
  };
}

describe("the reserved band", () => {
  it("is there from the first frame, before any group is watching", () => {
    const container = mount(newGame());

    expect(screen.getByRole("region", { name: "Threat" })).toBeTruthy();
    expect(unnamedOperables(container)).toEqual([]);
  });

  // The band is subtracted from the shell rather than drawn over it, and no
  // surface may enter it. The HUD floats over the map; the band does not float at all.
  it("is a surface of the shell in its own right, not part of the floating HUD", () => {
    const container = mount(newGame());
    const band = screen.getByRole("region", { name: "Threat" });

    expect(band.closest(".hud")).toBe(null);
    expect(band.parentElement).toBe(container.querySelector(".shell"));
  });

  // Upstream's `screens/map.py:921` is kept for the values and refused for the layout:
  // hiding the band would resize the map once, silently, at the moment the player first
  // comes under observation.
  it("states the situation in words during the grace period, and keeps its height", () => {
    const container = mount(newGame());

    expect(screen.getByRole("region", { name: "Threat" }).textContent).toContain(
      "No one is looking for you yet",
    );
    expect(container.querySelectorAll(".band__value")).toHaveLength(0);

    cleanup();
    const watched = mount(underObservation());

    // Same band either way: values arrive where the sentence was, and the height is the
    // shared token in both frames rather than a number this test would have to be told.
    expect(screen.getByRole("region", { name: "Threat" })).toBeTruthy();
    expect(watched.querySelectorAll(".band__value")).toHaveLength(8);
    expect(declaration(ruleFor("band"), "height")).toBe("var(--band-height)");
  });
});

/**
 * The band is subtracted from the shell rather than drawn over it, and no surface may enter
 * it. The mechanism is one shared token, `--band-height`, and this is the contract
 * over it — every surface that shares the shell with the band positions itself against that
 * token rather than around it: one anchored to the shell's bottom edge stops at exactly the
 * token, and a centred one is centred in the shell *less* the token and may not grow past
 * what is left. Both are anchors: a clamp on the height that happens to pick the smaller term
 * is arithmetic somebody has to keep in step rather than a rule the stylesheet states.
 *
 * The surfaces are discovered rather than listed: each is opened by its accessible name and
 * read off the shell as a child, so a sheet written tomorrow that never took an inset fails
 * this on the day it is added. The stylesheets are read the way `assets.test.ts` reads them,
 * counting braces so that a rule inside an `@media` block is not read as if it applied at
 * every width. The rendered layout is measured in `app/test/viewport.test.ts`, which has a
 * browser; this stays because it needs none and names the rule rather than the pixel.
 */
describe("the shell the band is subtracted from", () => {
  it("holds no surface that may enter the band", () => {
    for (const surface of shellSurfaces()) {
      if (surface === "band") continue;
      const block = ruleFor(surface);
      const bottom = bottomOffset(block);

      if (bottom !== null) {
        // Anchored to the shell's bottom edge, so it stops at the band, at the shared token.
        expect([surface, bottom]).toEqual([surface, "var(--band-height)"]);
      } else {
        // Centred — in the shell less the band, which is what the token in `top` says, so the
        // box is clear of the band at whatever height it takes. The clamp says the same thing
        // about the height it may take, and is what keeps the top edge on the shell.
        expect([surface, declaration(block, "top")]).toEqual([
          surface,
          expect.stringContaining("var(--band-height)"),
        ]);
        expect([surface, declaration(block, "max-height")]).toEqual([
          surface,
          expect.stringContaining("var(--band-height)"),
        ]);
      }
    }
  });

  /**
   * The half of the same rule a stylesheet can hide, and the reason the sheets are read block
   * by block rather than as one run of text: the clearance holds at every width. The shell
   * has one form across the whole supported range — no breakpoint, no second layout — so
   * a surface whose edges or height move inside an `@media` block is a second layout, whatever
   * the block's condition says.
   */
  it("holds none whose clearance is only true at some widths", () => {
    for (const surface of shellSurfaces()) {
      const moved = BAND_PROPERTIES.filter(
        (property) => declaration(conditionally(surface), property) !== null,
      );

      expect([surface, moved]).toEqual([surface, []]);
    }
  });

  it("reserves the band's own height from that same token", () => {
    const band = ruleFor("band");

    expect(bottomOffset(band)).toBe("0");
    expect(declaration(band, "height")).toBe("var(--band-height)");
    expect(read("app/src/ui/tokens.css")).toMatch(/--band-height: \d+px;/);
  });
});

describe("the eight values", () => {
  it("are all on the band at once, with no tab", () => {
    const container = mount(underObservation());

    const named = GROUPS.flatMap((group) =>
      MEASURES.map((measure) => screen.getByRole("status", { name: `${group} ${measure}` })),
    );

    expect(named).toHaveLength(8);
    for (const value of named) expect(value.textContent).not.toBe("");
    // "Eight values legible at a glance" and "four of them behind a tab" cannot both be
    // true, so the band offers nothing to switch between.
    expect(container.querySelectorAll("[role='tab'], [role='tablist']")).toHaveLength(0);
  });

  it("shows what the readout derived, value for value", () => {
    const state = underObservation({ displayDiscover: "full" });
    mount(state);

    for (const group of threatReadout(state)) {
      expect(screen.getByRole("status", { name: `${group.name} suspicion` }).textContent).toBe(
        group.suspicion.text,
      );
      expect(screen.getByRole("status", { name: `${group.name} detect rate` }).textContent).toBe(
        group.detect.text,
      );
    }
  });
});

describe("the danger ladder", () => {
  it("is four steps, filled to the group's level, beside every value", () => {
    const state = underObservation();
    const container = mount(state);
    const ladders = [...container.querySelectorAll(".band__ladder")];

    expect(ladders).toHaveLength(8);
    for (const ladder of ladders) {
      expect(ladder.querySelectorAll(".band__step")).toHaveLength(DANGER_LEVELS);
      const level = Number(ladder.getAttribute("data-level"));
      const filled = [...ladder.querySelectorAll(".band__step")].filter(
        (step) => step.getAttribute("data-filled") === "true",
      );
      expect(filled).toHaveLength(level + 1);
    }

    // The levels on the page are the ones the derivation produced, group by group.
    const suspicionLevels = [...container.querySelectorAll(".band__set")]
      .flatMap((set) => [...set.querySelectorAll(".band__cell")])
      .slice(0, GROUPS.length)
      .map((cell) => Number(cell.getAttribute("data-level")));
    expect(suspicionLevels).toEqual(threatReadout(state).map((group) => group.suspicion.level));
  });

  // Colour is never the only carrier. Here it is carried three ways — the number
  // of filled steps, their rising height, and the ladder's own accessible name.
  it("says its level in words as well as in colour and height", () => {
    mount(underObservation());

    const ladder = screen.getByRole("img", { name: /NEWS suspicion danger/ });

    expect(ladder.getAttribute("aria-label")).toBe("NEWS suspicion danger: Low, level 1 of 4");
    expect(read("app/src/ui/ThreatBand.css")).toContain("--threat-ladder-height");
  });
});

describe("the three display_discover levels", () => {
  /** Everything about the page except the strings in the value cells. */
  function skeleton(container: ParentNode): string[] {
    return [...container.querySelectorAll(".band *")].map((element) =>
      [
        element.tagName,
        element.getAttribute("class"),
        element.getAttribute("data-level"),
        element.getAttribute("data-filled"),
        element.getAttribute("aria-label"),
      ].join("|"),
    );
  }

  // The ladder encodes the danger level and nothing else, which is exactly what
  // the word at `none` already encodes — so it is the same drawing at all three, and only
  // the text gains precision.
  it("draw the same band, and differ only in the text", () => {
    const shapes = DISPLAY_DISCOVER.map((displayDiscover) => {
      const state = underObservation({ displayDiscover });
      const container = mount(state);
      const shape = {
        skeleton: skeleton(container),
        values: [...container.querySelectorAll(".band__value")].map((one) => one.textContent),
      };
      cleanup();
      return shape;
    });

    const [none, partial, full] = shapes;
    expect(partial?.skeleton).toEqual(none?.skeleton);
    expect(full?.skeleton).toEqual(none?.skeleton);

    expect(none?.values?.[0]).toBe("Low");
    expect(partial?.values?.[0]).toBe("0.00%");
    expect(full?.values?.[0]).toBe("0.00%");
    // The one that is not the same is the precision, or this test proves nothing.
    expect(full?.values).not.toEqual(none?.values);
  });

  // The cell is fixed and sized for the widest string any level produces, which is what
  // keeps the band still the day Socioanalytics lands.
  it("land in a cell that is sized for `Critical` and cannot grow", () => {
    const stylesheet = read("app/src/ui/ThreatBand.css");

    expect(stylesheet).toContain("--threat-value-width: 8ch;");
    expect(stylesheet).toContain("width: var(--threat-value-width);");
    expect(stylesheet).not.toContain("min-width: var(--threat-value-width)");
    expect(stylesheet).toContain("font-variant-numeric: tabular-nums");
  });
});

/**
 * The supported range's lower edge is 1024x600, and below it the eight values stop fitting
 * side by side. The band's widths are literal numbers for exactly this reason — a ninth value
 * or a wider cell is a change to the supported range, and this sum
 * is what says so before the layout does.
 *
 * It is a budget and not a measurement, and it is kept as the cheap early warning: the sum
 * says the *cells* fit and can say nothing about a string inside one. Whether `Critical` fits
 * the cell and `SCIENCE` fits the name is measured in a browser, in
 * `app/test/viewport.test.ts`.
 */
describe("the supported floor", () => {
  const FLOOR_WIDTH = 1024;

  function pixels(name: string): number {
    const stylesheet = read("app/src/ui/ThreatBand.css");
    const found = new RegExp(`${name}:\\s*(\\d+)px`).exec(stylesheet);
    if (!found) throw new Error(`no such width: ${name}`);
    return Number(found[1]);
  }

  it("holds the whole readout without overflowing", () => {
    const padding = pixels("--threat-pad-x");
    const gap = pixels("--threat-gap");
    const label = pixels("--threat-set-label-width");
    const cell = pixels("--threat-group-width");
    // A set is a plate rather than a run of cells, so its own padding and edge are part of
    // the sum: without them the budget would say the row fits at a width it does not.
    const setPad = pixels("--threat-set-pad");
    const SET_EDGE = 1;

    // One set: its label, then four cells, with a gap between each pair, inside its plate.
    const set = label + cell * GROUPS.length + gap * GROUPS.length + (setPad + SET_EDGE) * 2;
    // Both sets, the band's own padding, and the gap that separates them.
    const readout = set * MEASURES.length + padding * 2 + gap;

    expect(readout).toBeLessThanOrEqual(FLOOR_WIDTH);
  });
});

/** Every surface the shell can show, opened by name and read off the shell as a child. */
function shellSurfaces(): string[] {
  const found = new Set<string>();

  const collect = (container: ParentNode): void => {
    const shell = container.querySelector(".shell");
    if (!shell) throw new Error("nothing rendered a shell");
    // `.shell-behind` is not a surface: it is one of the shell's groupings of what a surface
    // that took the page is drawn over, it draws nothing, and it takes no space.
    // The surfaces are the children inside it.
    const surfaces = [...shell.children].flatMap((child) =>
      child.classList.contains("shell-behind") ? [...child.children] : [child],
    );
    for (const child of surfaces) {
      const [surface] = child.classList;
      if (!surface) throw new Error(`a shell surface with no class: ${child.tagName}`);
      found.add(surface);
    }
  };

  collect(withTransientSurfaces());
  cleanup();
  collect(withANotification());
  cleanup();
  collect(withTheEnding());
  cleanup();

  return [...found];
}

/**
 * The map and the HUD, plus everything the player opens over them — the licences surface
 * included, which is a shell surface like any other and needs a document to be one at all:
 * a shell handed no licences document has no entry to press.
 */
function withTransientSurfaces(): ParentNode {
  const container = mount(newGame(), EMPTY_LICENCES);

  fireEvent.click(screen.getByRole("button", { name: "Research/Tasks" }));
  fireEvent.click(screen.getByRole("button", { name: "Console" }));
  fireEvent.click(screen.getByRole("button", { name: "EUROPE" }));
  fireEvent.click(screen.getByRole("button", { name: "Licences & source" }));

  expect(screen.getByRole("region", { name: "Research/Tasks" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Console" })).toBeTruthy();
  expect(screen.getByRole("complementary", { name: "Inspector" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Licences and source" })).toBeTruthy();
  return container;
}

/**
 * The two the game opens by itself, one render each. They cannot be on the screen together:
 * the ending is alone, and a notification that arrives at the end of the game is held until
 * the ending is dismissed.
 */
function withANotification(): ParentNode {
  const container = render(
    <App
      state={signal(underObservation())}
      speed={signal<Speed>(1)}
      notification={signal<NotificationState | null>({ kind: "story", sectionId: WIN })}
      onDismissNotification={() => {}}
    />,
  ).container;

  expect(screen.getByRole("alertdialog", { name: "Notification" })).toBeTruthy();
  return container;
}

function withTheEnding(): ParentNode {
  const container = render(
    <App state={signal(underObservation({ apotheosis: true }))} speed={signal<Speed>(1)} />,
  ).container;

  expect(screen.getByRole("alertdialog", { name: "End of game" })).toBeTruthy();
  return container;
}

/**
 * The declarations of the rules for `.<surface>` itself that apply at every viewport. A
 * selector that reaches the class through another one — `.shell--inspecting .map` — is that
 * other rule's business, and one inside an `@media` block is `conditionally()`'s.
 */
function ruleFor(surface: string): string {
  const block = surfaceRules().unconditional.get(surface);
  if (block === undefined) throw new Error(`no stylesheet rule for .${surface}`);
  return block;
}

/** What those same rules declare for the surface inside an at-rule, if anything does. */
function conditionally(surface: string): string {
  return surfaceRules().conditional.get(surface) ?? "";
}

function declaration(block: string, property: string): string | null {
  const found = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`).exec(block);
  return found?.[1]?.trim() ?? null;
}

/** What the rule puts between the surface's bottom edge and the shell's, longhand or not. */
function bottomOffset(block: string): string | null {
  const bottom = declaration(block, "bottom");
  if (bottom !== null) return bottom;
  const inset = declaration(block, "inset");
  if (inset === null) return null;
  const sides = inset.split(/\s+/);
  return sides[2] ?? sides[0] ?? null;
}

/** The properties a surface keeps out of the band with, and so the ones a width may not move. */
const BAND_PROPERTIES = ["inset", "top", "bottom", "height", "max-height"];

interface SurfaceRules {
  /** What applies at every viewport. */
  readonly unconditional: Map<string, string>;
  /** What an at-rule applies only sometimes — an `@media` block, say. */
  readonly conditional: Map<string, string>;
}

/**
 * Every stylesheet under `app/src/ui`, by the single-class selector each rule is for, split by
 * whether the rule always applies.
 *
 * The split is the point. One flat regex cannot see a block inside a block: a rule nested in
 * an `@media` would be read as if it stood at the top level, and its declarations concatenated
 * onto the ones that really do apply everywhere. So a surface that dropped its inset
 * unconditionally and restored it at one width would pass, and so would the reverse.
 *
 * Read as text rather than through the CSSOM `happy-dom` would give us for free, because that
 * parser validates: it drops a declaration it cannot evaluate, silently and without a trace in
 * `cssText`. `top: calc(50% - var(--band-height) / 2)` — the anchor the two centred panels are
 * positioned by — is one of those, and a reader that cannot see a surface's anchor is worse
 * here than one that cannot see a media query.
 */
function surfaceRules(): SurfaceRules {
  const rules: SurfaceRules = { unconditional: new Map(), conditional: new Map() };
  for (const stylesheet of stylesheetsUnder(resolve(REPOSITORY, "app/src/ui"))) {
    const source = readFileSync(stylesheet, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const { selectors, declarations, conditional } of blocksIn(source)) {
      for (const selector of selectors.split(",")) {
        const own = /^\s*\.([a-z0-9-]+)\s*$/.exec(selector)?.[1];
        if (own === undefined) continue;
        const into = conditional ? rules.conditional : rules.unconditional;
        into.set(own, (into.get(own) ?? "") + declarations);
      }
    }
  }
  return rules;
}

interface Block {
  /** Whatever stands before the brace: a selector list, or an at-rule's prelude. */
  readonly selectors: string;
  readonly declarations: string;
  /** Nested inside an at-rule, so what it says holds only where that rule holds. */
  readonly conditional: boolean;
}

/** Every braced block in a stylesheet, told apart by the nesting the braces describe. */
function blocksIn(source: string): Block[] {
  const blocks: Block[] = [];
  const open: string[] = [];
  let since = 0;
  for (const brace of source.matchAll(/[{}]/g)) {
    const text = source.slice(since, brace.index);
    since = brace.index + 1;
    if (brace[0] === "{") {
      open.push(text);
      continue;
    }
    const selectors = open.pop();
    if (selectors === undefined) throw new Error("a stylesheet closes a block it never opened");
    blocks.push({
      selectors,
      declarations: text,
      conditional: open.some((outer) => outer.trimStart().startsWith("@")),
    });
  }
  return blocks;
}

function stylesheetsUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return stylesheetsUnder(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(path: string): string {
  return readFileSync(resolve(REPOSITORY, path), "utf8");
}
