import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { content } from "@singularity/sim";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VIEWPORTS = [
  { width: 1024, height: 600, globeWidth: 624 },
  { width: 1440, height: 792, globeWidth: 1040 },
] as const;
let server: ViteDevServer;
let browser: Browser;
let page: Page;
let origin: string;

beforeAll(async () => {
  server = await createServer({
    root: resolve(REPOSITORY, "app"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address() as AddressInfo;

  // Playwright's own Chromium, not the machine's Chrome channel. Both are "a browser" for
  // what this file measures — layout at a given viewport — and the bundled one is the only
  // half of that pair the repository controls: it is pinned by `playwright-core`, it is
  // shared across worktrees in `~/.cache/ms-playwright`, and `bunx playwright-core install`
  // fetches it once per machine. The channel needs a Chrome to be installed
  // and, where it is, needs to be allowed to open its single-instance socket — which is
  // exactly what a confined session does not get: `channel: "chrome"` dies here on
  // `process_singleton_posix.cc:297 Check failed: socket() failed: Operation not permitted`,
  // and took the whole file's geometry with it.
  browser = await chromium.launch({ headless: true });
  origin = `http://127.0.0.1:${address.port}/`;
  page = await browser.newPage();
  await page.goto(`${origin}?scenario=past-grace&clock=frozen`);
  await page.getByRole("button", { name: "EUROPE" }).click();
  await page.getByRole("complementary", { name: "Inspector" }).waitFor();
}, 15_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/**
 * A page of its own, at the floor of the supported range, for a case the shared page cannot
 * serve: a second Scenario, or a clock that has to run.
 *
 * The shared page above is booted once and re-used because every case on it asks the same
 * question at a different viewport. These ask different questions of different states, and a
 * Scenario boot is the only way to reach one — so they pay for a page each and give it back.
 *
 * It waits for the faces as well as for the band, because every width below is a width *in a
 * face*: the self-hosted subsets are `font-display: swap`, so a page measured
 * before they arrive is a page measured in the fallback, and a cell declared in `ch` moves
 * with the face it is declared against.
 */
async function open(
  query: string,
  viewport: { width: number; height: number } = FLOOR,
): Promise<Page> {
  const opened = await browser.newPage({ viewport });
  await opened.goto(`${origin}${query}`);
  await opened.locator(".band").waitFor();
  await opened.evaluate(() => document.fonts.ready.then(() => undefined));
  return opened;
}

/** The supported range's lower edge, which is the viewport every measurement below is taken at. */
const FLOOR = { width: 1024, height: 600 } as const;

/**
 * The names Chromium's **own** accessibility tree offers — the third thing `inert` promises,
 * and the one nothing else in the repository can check.
 *
 * Playwright's role engine is not that tree. It resolves roles and names out of the DOM
 * itself and does not exclude an inert subtree: with the end-of-game panel up and the shell
 * marked, `page.getByRole('button', { name: 'EUROPE' })` still finds one. So does
 * `locator.ariaSnapshot()`, which is built by the same engine. `page.accessibility` would
 * have been the obvious instrument and is gone from playwright-core 1.62.
 *
 * What is left is the browser's own answer, over CDP: `Accessibility.getFullAXTree` is the
 * tree Chromium hands to assistive technology, and a node inside an inert subtree is not in
 * it at all — not present and ignored, absent. That is the same seam as the rest of this
 * file rather than a fourth one: the application, booted from a Scenario in a browser, asked
 * a question only a browser can answer.
 */
async function accessibleNames(page: Page): Promise<string[]> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Accessibility.enable");
    const tree = (await session.send("Accessibility.getFullAXTree")) as {
      nodes: readonly { ignored?: boolean; name?: { value?: unknown } }[];
    };
    return tree.nodes
      .filter((node) => node.ignored !== true)
      .map((node) => (typeof node.name?.value === "string" ? node.name.value.trim() : ""))
      .filter((name) => name !== "");
  } finally {
    await session.detach();
  }
}

/**
 * The widest string a money readout can produce, established at the host seam by sweeping
 * both sides of every decade corner (`readouts.test.ts`). It is repeated here because this is
 * where it is *rendered*: the cells that carry it are declared in `ch` of a monospaced face,
 * and whether eleven of those characters actually fit is a question only a browser answers.
 */
const WIDEST_MONEY = "-999,999.99";

/** The widest string a danger level can produce (`ui/threat.ts`). */
const WIDEST_LEVEL = "Critical";

/**
 * And the widest the clock panel's two settings can produce, both taken from the list they
 * come out of rather than guessed at (`readouts.test.ts`). Rendered here for the same reason
 * the money string is: `10ch` and `8ch` are a claim about a face, and a face is a browser.
 */
const WIDEST_SETTINGS = { difficulty: "ULTRA HARD", speed: "432,000x" } as const;

/**
 * Blink lays a box out on a grid of 1/64 of a CSS pixel and a canvas advance width is not on
 * that grid, so every comparison below between a laid-out box and a measured string is made
 * to within one of those units.
 *
 * With the faces loaded the two agree exactly at every cell this file reads — 66px of
 * declared flow cell against 66px of `-999,999.99`, 64px of value cell against 64px of
 * `Critical` — because both are monospaced subsets whose advance is a whole number at these
 * sizes. The unit is what keeps a face where that stops being true from failing on the
 * rounding alone. Measured against the *fallback* face the two disagree by 0.007px, which is
 * why `open` waits for `document.fonts.ready` rather than trusting the tolerance.
 */
const LAYOUT_UNIT = 1 / 64;

// The two halves of the supported range that a stylesheet states rather than a browser reports
// — the one frozen shell and the page left free to scroll — are read as source in
// `viewport-source.test.ts`, which needs no browser and so runs wherever the suite runs.
// What is left here is the geometry, which does need one.
describe("the supported viewport range", () => {
  it.each([
    { viewport: [960, 600], shortfall: [64, 0] },
    { viewport: [900, 560], shortfall: [124, 40] },
    { viewport: [800, 500], shortfall: [224, 100] },
    { viewport: [720, 480], shortfall: [304, 120] },
  ])("scrolls by exactly the shortfall at $viewport", async ({ viewport, shortfall }) => {
    const [width, height] = viewport as [number, number];
    await page.setViewportSize({ width, height });
    const geometry = await page.evaluate(() => {
      const shell = document.querySelector(".shell")!.getBoundingClientRect();
      const bar = document.querySelector(".development-bar")?.getBoundingClientRect().height ?? 0;
      return {
        viewport: [window.innerWidth, window.innerHeight],
        shell: [shell.width, shell.height],
        scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
        bar,
      };
    });

    expect(geometry.viewport).toEqual(viewport);
    expect(geometry.shell).toEqual([1024, 600]);
    // The strip the development bar takes off the top comes out of the height the shell has
    // to sit in, so the page scrolls by that much more than the shell's own shortfall. It is
    // measured rather than assumed, and it is discounted here rather than tolerated: the bar
    // is a strip of real page above the game and it never reaches a build
    // (`check:development-only`), so the promise the range makes is about the page without it.
    // Within a whole CSS pixel down the page, because the two figures are not measured on the
    // same grid: `scrollHeight` is an integer and the bar's own height is whatever its type
    // and padding come to. Across the page the bar costs nothing and the comparison is exact.
    const scrolled = geometry.scroll.map(
      (size, axis) => size - geometry.viewport[axis]! - (axis === 1 ? geometry.bar : 0),
    );
    expect(scrolled[0]).toBe(shortfall[0]);
    expect(Math.abs(scrolled[1]! - shortfall[1]!)).toBeLessThanOrEqual(1);
  });

  it("does not gate the player with a blocking message", async () => {
    await expect(page.getByRole("dialog").count()).resolves.toBe(0);
    await expect(page.locator("body").innerText()).resolves.not.toMatch(
      /unsupported (viewport|window|screen)/i,
    );
  });
});

describe("the supported viewport geometry", () => {
  it.each(VIEWPORTS)(
    "keeps available locations clear of the inspector and the readout inside $width x $height",
    async ({ width, height, globeWidth: expectedGlobeWidth }) => {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(250);
      const geometry = await page.evaluate(() => {
        const inspector = document.querySelector(".inspector")!.getBoundingClientRect();
        const globe = document.querySelector(".map__globe")!.getBoundingClientRect();
        const band = document.querySelector(".band")!;
        const availablePins = [...document.querySelectorAll<HTMLElement>(".map__pin")].filter(
          (pin) => pin.getAttribute("aria-disabled") !== "true",
        );
        const occluded = availablePins
          .filter((pin) => {
            const mark = pin.querySelector(".map__pin-mark")!.getBoundingClientRect();
            return (
              mark.left < inspector.right &&
              mark.right > inspector.left &&
              mark.top < inspector.bottom &&
              mark.bottom > inspector.top
            );
          })
          .map((pin) => pin.getAttribute("aria-label"));

        return {
          inspectorWidth: inspector.width,
          globeWidth: globe.width,
          availableLocations: availablePins.length,
          occluded,
          readoutCells: band.querySelectorAll(".band__cell").length,
          readoutWidth: [band.scrollWidth, band.clientWidth],
        };
      });

      expect(geometry.inspectorWidth).toBe(400);
      expect(geometry.globeWidth).toBe(expectedGlobeWidth);
      expect(geometry.availableLocations).toBeGreaterThan(0);
      expect(geometry.occluded).toEqual([]);
      expect(geometry.readoutCells).toBe(8);
      expect(geometry.readoutWidth[0]).toBeLessThanOrEqual(geometry.readoutWidth[1]!);
    },
  );

  // The range has no upper bound, and above 2:1 the globe stops growing sideways and takes
  // the whole stage height instead. That is where a chip row drawn over the stage lands on
  // the globe, so the wide case is the one this guards.
  //
  // The band is measured rather than a chip in it: this Scenario has finished no tech, so it
  // holds no chip at all. The reserved height is what the globe is sized
  // against, and is the half the globe can collide with.
  it.each([
    { width: 1024, height: 600 },
    { width: 1440, height: 792 },
    { width: 2560, height: 800 },
    { width: 3440, height: 900 },
  ])("keeps the off-world chips above the globe at $width x $height", async ({ width, height }) => {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(250);
    const geometry = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const chips = box(".map__offworld");
      const globe = box(".map__globe");
      const stage = box(".map__stage");

      return {
        chips: [chips.top, chips.bottom, chips.height],
        globe: [globe.top, globe.bottom, globe.width],
        stage: [stage.top, stage.bottom],
      };
    });
    const [chipsTop, chipsBottom, chipsHeight] = geometry.chips as [number, number, number];
    const [globeTop, globeBottom, globeWidth] = geometry.globe as [number, number, number];
    const [stageTop, stageBottom] = geometry.stage as [number, number];

    expect(chipsHeight).toBeGreaterThan(0);
    expect(globeWidth).toBeGreaterThan(0);
    expect(chipsTop).toBeGreaterThanOrEqual(stageTop);
    expect(chipsBottom).toBeLessThanOrEqual(globeTop);
    expect(globeBottom).toBeLessThanOrEqual(stageBottom + 0.5);
  });
});

/**
 * The HUD's two floating panels, measured against each other at the floor.
 *
 * They are absolutely positioned against opposite edges of a stage the range only guarantees
 * is 1024 wide, so the one thing that can be wrong with them is that they meet. Every other
 * suite in the repository can only add up declarations; this is where the two boxes are read.
 *
 * The worst case is measured rather than booted, because no Scenario reaches it: the widest
 * string a money readout can produce is `-999,999.99` (`readouts.test.ts`), the cash a played
 * game holds is nowhere near it, and a Scenario is a seed and a script — it cannot be handed
 * a balance. So each cell is asked how wide that string would be *in its own rendered face*,
 * and the panel's growth is added to the measurement before the gap is judged.
 */
describe("the two HUD panels at the floor of the supported range", () => {
  it.each([
    // The difficulty name is the clock panel's leftmost cell and it is not fixed to the
    // cell's floor: `ULTRA HARD` is the widest name the Content holds (`difficulties.json`,
    // tied with `IMPOSSIBLE`), so the Scenario carrying it is the wider of the two panels.
    { scenario: "past-grace", difficulty: "NORMAL" },
    { scenario: "lost-to-suspicion", difficulty: "ULTRA HARD" },
  ])(
    "stay apart on $difficulty, with both pools at their widest",
    async ({ scenario, difficulty }) => {
      const opened = await open(`?scenario=${scenario}&clock=frozen`);
      try {
        const measured = await opened.evaluate(
          ({ widest, settings }) => {
            const box = (selector: string) =>
              document.querySelector(selector)!.getBoundingClientRect();
            const canvas = document.createElement("canvas").getContext("2d")!;
            /** The advance width of a string in an element's own rendered face. */
            const advance = (text: string, element: Element): number => {
              const style = getComputedStyle(element);
              canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
              return canvas.measureText(text).width;
            };
            const clock = box(".hud__clock");
            const resources = box(".hud__resources");
            const pools = [
              ...document.querySelectorAll<HTMLElement>(".hud__resources .hud__readout"),
            ];

            return {
              difficulty: document.querySelector(".hud__clock .hud__value")!.textContent,
              shell: box(".shell").width,
              clock: [clock.left, clock.right],
              resources: [resources.left, resources.right],
              gap: resources.left - clock.right,
              // What each pool's cell would grow by if its value printed the widest string a
              // money readout can produce. The cell is the wider of the pool and the flow row
              // under it, so a longer pool only costs what it adds beyond the row.
              growth: pools.map((pool) => {
                const value = pool.querySelector<HTMLElement>(".hud__value")!;
                const column = pool.getBoundingClientRect().width;
                return Math.max(0, advance(widest, value) - column);
              }),
              flows: [...document.querySelectorAll<HTMLElement>(".hud__flow-value")].map(
                (flow) => ({
                  width: flow.getBoundingClientRect().width,
                  declared: Number.parseFloat(getComputedStyle(flow).minWidth),
                  widest: advance(widest, flow),
                  spacing: getComputedStyle(flow).letterSpacing,
                }),
              ),
              // The clock panel's two settings, asked the same question as the pools: what the
              // cell measures, what it declares, and what the widest string it can ever hold
              // would ask of it.
              settings: Object.entries(settings).map(([name, longest]) => {
                const cell = document.querySelector<HTMLElement>(`.hud__value--${name}`)!;
                return {
                  name,
                  text: cell.textContent,
                  width: cell.getBoundingClientRect().width,
                  declared: Number.parseFloat(getComputedStyle(cell).minWidth),
                  widest: advance(longest, cell),
                };
              }),
            };
          },
          { widest: WIDEST_MONEY, settings: WIDEST_SETTINGS },
        );

        expect(measured.difficulty).toBe(difficulty);
        expect(measured.shell).toBe(FLOOR.width);

        // The flow cell is at its declared floor and the widest figure fits it exactly, so no
        // flow this panel can ever show widens it — the repair on `resource-flow-projection`
        // argued that from the declaration, and this is the rendering of it. The face is
        // monospaced and unspaced, which is what makes `11ch` that string's own width.
        for (const flow of measured.flows) {
          expect(flow.spacing).toBe("normal");
          expect(flow.width).toBeLessThanOrEqual(flow.declared + LAYOUT_UNIT);
          expect(flow.widest).toBeLessThanOrEqual(flow.width + LAYOUT_UNIT);
        }

        // The two settings, each at its own declared width and each holding the longest string
        // it can ever print. They shared the pools' old `7ch` floor and were both
        // over it, so the clock panel's right edge moved with the difficulty and — while the
        // player watched — with the Speed. Sized, neither cell grows: the gap below is the
        // same on either difficulty, which is what makes it a measurement rather than a
        // reading of whichever value happened to be on the screen.
        expect(measured.settings).toHaveLength(2);
        for (const setting of measured.settings) {
          expect(setting.width).toBeLessThanOrEqual(setting.declared + LAYOUT_UNIT);
          expect(setting.widest).toBeLessThanOrEqual(setting.width + LAYOUT_UNIT);
        }

        // The panels do not meet — with room to spare for the two pools growing to the widest
        // figure they could ever print, which is the case no Scenario can boot.
        const worstCase = measured.growth.reduce((total, extra) => total + extra, 0);
        expect(measured.gap).toBeGreaterThan(worstCase);

        // And it is the same gap on either difficulty, which is the number
        // `Hud.css` states. Pinned rather than merely bounded: every cell in both panels
        // now holds the longest string it can, so a gap that has moved is a width that has,
        // and the stylesheet saying it would otherwise go quietly stale.
        //
        // It was 6px until the resources panel's two doors moved under its readouts, which is
        // what a door named for what it opens cost — `Research/Tasks` is 40px wider than
        // `Research` and the gap had 6. Under, neither door is width in the panel
        // at all, and what is left is the readout row against the clock panel.
        expect(measured.gap).toBeCloseTo(195, 1);
      } finally {
        await opened.close();
      }
    },
  );
});

/**
 * The speed row's five cells, and the marks inside them.
 *
 * `SpeedControl.css` said the mono family was what kept the five cells one width whatever the
 * arrows did. It is not — `--speed-cell` is a plain `width` — and the family never draws a mark
 * at all: both marks are outside the `unicode-range` either subset declares, which
 * `assets.test.ts` reads off the declaration. What is left for a browser is the half a
 * declaration cannot answer: the cells really are one width, and a fixed cell is one its
 * content can overflow, so the widest mark is measured inside the box rather than assumed to
 * fit it.
 */
describe("the speed row", () => {
  it("is five cells of one width, each holding its mark", async () => {
    const opened = await open("?scenario=grace-full&clock=frozen");
    try {
      await opened.locator(".speeds__button").first().waitFor();
      const cells = await opened.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".speeds__button")].map((button) => {
          const mark = button.querySelector<HTMLElement>("[aria-hidden]")!;
          return {
            text: mark.textContent,
            width: button.getBoundingClientRect().width,
            // What the button has inside its own border, and what the mark asks of it.
            inside: button.clientWidth,
            mark: mark.getBoundingClientRect().width,
          };
        }),
      );

      expect(cells).toHaveLength(5);
      expect(cells.map((cell) => cell.text)).toEqual(["▮▮", "▶", "▶▶", "▶▶▶", "▶▶▶▶"]);
      expect(new Set(cells.map((cell) => cell.width)).size).toBe(1);
      for (const cell of cells) {
        expect(cell.mark).toBeLessThanOrEqual(cell.inside);
      }
    } finally {
      await opened.close();
    }
  }, 40_000);
});

/**
 * The threat readout, measured rather than added up.
 *
 * `threat-band.test.tsx` discharges the floor by summing the band's four declared widths
 * against 1024. That catches the change that matters — a ninth value, a wider cell, a bigger
 * gap — and it is kept as the cheap early warning, because it needs no browser. What it
 * cannot see is a string: the sum says the *cells* fit, and says nothing about whether
 * `Critical` fits the cell or `SCIENCE` fits the name. Both are sized from the faces' own
 * advance widths, and only a rendering can confirm them.
 *
 * The Scenario is the ultra-hard loss because it is the one that puts `Critical` on the band.
 */
/**
 * The one measurement the accessibility batch left behind.
 *
 * The base table's tick box was 16×16 CSS pixels — under WCAG 2.5.8's 24 — and it was the one
 * focusable in the panel with no author focus ring, because the rule beside it names buttons.
 * Neither is a question a stylesheet can be read for: a target is a rendered box, and a ring
 * belongs to `:focus-visible`, which only a browser resolves. So it is asked here, where the
 * rest of the shell's geometry is asked.
 *
 * The row is built rather than booted, because no Scenario is needed for one: a location with
 * an order in it has a row, and the clock is frozen so the order stays where it was put.
 */
describe("the base table's tick box", () => {
  it("is a 24px target and wears the shell's own focus ring", async () => {
    const opened = await open("?scenario=grace-full&clock=frozen");
    try {
      await opened.getByRole("button", { name: "EUROPE" }).click();
      await opened.getByRole("button", { name: "Build bases" }).click();
      const box = opened.locator(".inspector__bases input").first();
      await box.waitFor();

      const size = (await box.boundingBox()) ?? { width: 0, height: 0 };
      expect(size.width).toBeGreaterThanOrEqual(24);
      expect(size.height).toBeGreaterThanOrEqual(24);

      // Focused from the keyboard, which is what `:focus-visible` answers to: the name button
      // beside it is taken first, then Shift+Tab steps back onto the box.
      await opened.locator(".inspector__name button").first().focus();
      await opened.keyboard.press("Shift+Tab");
      const ring = await box.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          focused: document.activeElement === element,
          style: style.outlineStyle,
          width: style.outlineWidth,
        };
      });

      // `solid`, not the platform's `auto`: the ring is the shell's accent, drawn by a rule of
      // its own.
      expect(ring.focused).toBe(true);
      expect(ring.style).toBe("solid");
      expect(ring.width).toBe("2px");
    } finally {
      await opened.close();
    }
  });
});

/**
 * And the other checkboxes the batch left behind — the switch it added itself, and the eleven
 * beside it.
 *
 * The focus ring rule is about *every* focusable, and a ring written per component is what
 * leaves a new control wearing the platform's grey: the shortcut switch in the console's
 * Settings tab was that control the day it was written, beside four warning filters that had
 * never had a ring either. The rule is one rule in `tokens.css` now, and this is the half of it
 * no stylesheet can be read for.
 *
 * The size is the same shape of question: a target is a rendered box, and the platform's own
 * checkbox is 13×13 whatever the stylesheet says until the stylesheet says otherwise. What the
 * sizing costs is measured here too, because it is a layout decision rather than a number —
 * twelve boxes gaining 11px each is what could push a row onto a second line, and both rows of
 * filters are one line at the floor of the supported range.
 *
 * The tops are what says so, not the overflow: both rows wrap, and a wrapping row answers a
 * line it cannot fit by taking a second one rather than by overflowing the body. Asked of the
 * overflow alone, this case stayed green while the fourth warning filter sat on a line of its
 * own.
 */
describe("the console's checkboxes", () => {
  it("are 24px targets on both tabs, without wrapping either row", async () => {
    const opened = await open("?scenario=grace-full&clock=frozen");
    try {
      await opened.getByRole("button", { name: "Console" }).click();
      await opened.getByRole("region", { name: "Console" }).waitFor();

      /** Every checkbox on the open tab, and whether the row holding them is still one line. */
      const measure = (page: Page, row: string) =>
        page.evaluate((selector) => {
          const boxes = [...document.querySelectorAll<HTMLElement>(`${selector} input`)];
          const labels = [...document.querySelectorAll<HTMLElement>(`${selector} label`)];
          const body = document.querySelector<HTMLElement>(".console__body")!;
          return {
            sizes: boxes.map((box) => {
              const rect = box.getBoundingClientRect();
              return [rect.width, rect.height];
            }),
            // One line: every label of a row shares a top edge with the rest of that row.
            tops: labels.map((label) => Math.round(label.getBoundingClientRect().top)),
            overflow: [body.scrollWidth, body.clientWidth],
          };
        }, row);

      const filters = await measure(opened, ".console__filters");
      await opened.getByRole("tab", { name: "Settings" }).click();
      await opened.getByRole("checkbox", { name: "Single-key shortcuts" }).waitFor();
      const settings = await measure(opened, ".console__settings");

      expect(filters.sizes).toHaveLength(6);
      expect(settings.sizes).toHaveLength(6);
      for (const { sizes, overflow } of [filters, settings]) {
        for (const [width, height] of sizes) {
          expect(width).toBeGreaterThanOrEqual(24);
          expect(height).toBeGreaterThanOrEqual(24);
        }
        expect(overflow[0]).toBeLessThanOrEqual(overflow[1]!);
      }
      // The log filters are one row of six. The Settings tab holds more than its warnings —
      // the keyboard list and the two switches follow them — so the row asked about there is
      // the warning filters, which are the labels before the `Keyboard` heading.
      expect(new Set(filters.tops).size).toBe(1);
      expect(new Set(settings.tops.slice(0, content.warnings.all.length)).size).toBe(1);
    } finally {
      await opened.close();
    }
  }, 40_000);

  it("wear the shell's own focus ring", async () => {
    const opened = await open("?scenario=grace-full&clock=frozen");
    try {
      await opened.getByRole("button", { name: "Console" }).click();
      await opened.getByRole("tab", { name: "Settings" }).click();
      const box = opened.getByRole("checkbox", { name: "Single-key shortcuts" });
      await box.waitFor();

      // Tabbed onto rather than focused, because `:focus-visible` answers to the keyboard: the
      // Settings tab keeps the focus after the click, and the switch is the tab stop after the
      // warning filters between them.
      for (let step = 0; step < 12; step += 1) {
        if (await box.evaluate((element) => document.activeElement === element)) break;
        await opened.keyboard.press("Tab");
      }
      const ring = await box.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          focused: document.activeElement === element,
          style: style.outlineStyle,
          width: style.outlineWidth,
        };
      });

      expect(ring.focused).toBe(true);
      expect(ring.style).toBe("solid");
      expect(ring.width).toBe("2px");
    } finally {
      await opened.close();
    }
  });
});

describe("the threat readout at the floor of the supported range", () => {
  it("fits every value, name and set label inside 1024", async () => {
    const opened = await open("?scenario=lost-to-suspicion&clock=frozen");
    try {
      const measured = await opened.evaluate((widest) => {
        const canvas = document.createElement("canvas").getContext("2d")!;
        const advance = (text: string, element: Element): number => {
          const style = getComputedStyle(element);
          canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          return canvas.measureText(text).width;
        };
        const band = document.querySelector<HTMLElement>(".band")!;
        const fits = (element: HTMLElement) => [element.scrollWidth, element.clientWidth];
        const sets = [...document.querySelectorAll(".band__set")].map((set) => {
          const rect = set.getBoundingClientRect();
          return [rect.left, rect.right];
        });

        return {
          band: [band.scrollWidth, band.clientWidth, band.getBoundingClientRect().height],
          sets,
          values: [...document.querySelectorAll<HTMLElement>(".band__value")].map((value) => ({
            text: value.textContent,
            fits: fits(value),
            spacing: getComputedStyle(value).letterSpacing,
            widest: advance(widest, value),
            width: value.getBoundingClientRect().width,
          })),
          names: [...document.querySelectorAll<HTMLElement>(".band__name")].map((name) => ({
            text: name.textContent,
            fits: fits(name),
            cell: name.parentElement!.getBoundingClientRect().width,
          })),
          caps: [...document.querySelectorAll<HTMLElement>(".band__caps")].map((cap) => ({
            text: cap.textContent,
            fits: fits(cap),
            height: cap.getBoundingClientRect().height,
          })),
        };
      }, WIDEST_LEVEL);

      // The band itself does not overflow, and the two sets have slack between them rather
      // than sharing a pixel: the two measures go to the two ends.
      expect(measured.band[0]).toBeLessThanOrEqual(measured.band[1]!);
      expect(measured.sets).toHaveLength(2);
      expect(measured.sets[1]![0]).toBeGreaterThan(measured.sets[0]![1]!);

      // Eight values, none of them clipped, and each cell wide enough for the widest word a
      // danger level can produce — which is the claim `8ch` makes.
      expect(measured.values).toHaveLength(8);
      expect(measured.values.map((value) => value.text)).toContain(WIDEST_LEVEL);
      for (const value of measured.values) {
        expect(value.spacing).toBe("normal");
        expect(value.fits[0]).toBeLessThanOrEqual(value.fits[1]!);
        expect(value.widest).toBeLessThanOrEqual(value.width + LAYOUT_UNIT);
      }

      // `SCIENCE` is the widest group name and it is rendered here, so the 72px cell is
      // measured against it rather than against an advance width somebody worked out.
      expect(measured.names.map((name) => name.text)).toContain("SCIENCE");
      for (const name of measured.names) {
        expect(name.fits[0]).toBeLessThanOrEqual(name.fits[1]!);
        expect(name.fits[0]).toBeLessThanOrEqual(name.cell);
      }

      // The set labels, one of which wraps to two lines inside a band of a fixed height.
      expect(measured.caps).toHaveLength(2);
      for (const cap of measured.caps) {
        expect(cap.fits[0]).toBeLessThanOrEqual(cap.fits[1]!);
        expect(cap.height).toBeLessThan(measured.band[2]!);
      }
    } finally {
      await opened.close();
    }
  });
});

/**
 * The end of the game, against the band it may not enter.
 *
 * `threat-band.test.tsx` reads the rule off the stylesheet — the panel is centred in the shell
 * *less* the band, and clamped so it cannot grow past what is left. Whether those two work out
 * is a rendered box, and the floor is where they are tightest. Centred in the whole shell, as
 * the panel was, the clamp alone stopped it **11px inside the band** here: an ending long
 * enough to fill the panel would have been drawn over the readout, at a viewport inside the
 * supported range. The anchor is what closes that, and this is the measurement that says so.
 *
 * Both boxes are measured: the one this ending draws, and the tallest one the clamp allows.
 * The second is the assertion that stays true as the ending's text changes, and it is grown
 * into rather than read — `max-height` here is a `min()` over a percentage, which Chromium
 * reports back unresolved, so the panel is given the height and the layout engine is asked
 * where the clamp put it.
 */
describe("the end-of-game panel at the floor of the supported range", () => {
  it("clears the reserved band, at its own height and at the tallest it may take", async () => {
    const opened = await open("?scenario=lost-to-suspicion&clock=frozen");
    try {
      await opened.getByRole("alertdialog", { name: "End of game" }).waitFor();

      const measured = await opened.evaluate(() => {
        const panel = document.querySelector<HTMLElement>(".end-of-game")!;
        const bandTop = document.querySelector(".band")!.getBoundingClientRect().top;
        const drawn = panel.getBoundingClientRect().bottom;
        panel.style.height = "100%";
        const tallest = panel.getBoundingClientRect().bottom;
        panel.style.height = "";
        return { drawn, tallest, bandTop };
      });

      expect(measured.drawn).toBeLessThanOrEqual(measured.bandTop + LAYOUT_UNIT);
      expect(measured.tallest).toBeLessThanOrEqual(measured.bandTop + LAYOUT_UNIT);
    } finally {
      await opened.close();
    }
  }, 40_000);
});

/**
 * What a modal surface owns, in a browser that enforces it.
 *
 * A surface claiming `aria-modal="true"` owns the pointer, the focus and the
 * accessibility tree, and the mechanism is `inert` on the shell's grouping of everything
 * behind it. happy-dom implements no part of `inert` — it dispatches clicks into an inert
 * subtree and focuses inside it — so the app seam asserts the structure and this is where the
 * browser's own half is asserted: a real click at a covered surface, a real Tab, and the
 * focus a real browser actually gives back.
 */
describe("a modal surface in a browser that enforces inert", () => {
  it("takes no click and no key at anything behind it", async () => {
    // The ultra-hard loss ends with the end-of-game panel up over a live shell.
    //
    // Above the floor, which is the one viewport this case cannot be asked at. The
    // panel is 42rem wide and centred, and at 1024x600 it settles at x 176-848 over a globe
    // that runs 38-986: every available location's mark then lies *inside* the panel's own
    // rect, the nearest of them by 4px. The case only ever found a point there while the entry
    // animation was still running — `scale(0.985)` pulls the panel's right edge in to 843,
    // which put AUSTRALIA's mark one pixel outside it — so a machine slow enough for this read
    // to arrive after that 500ms animation had settled found nothing to aim at. A point clear
    // of the centred panel is a thing a wider viewport has and the floor does not: at 1440x792
    // the furthest available location is 108px clear of the settled panel, which no animation
    // frame and no reading moment can take away.
    const opened = await open("?scenario=lost-to-suspicion&clock=frozen", {
      width: 1440,
      height: 792,
    });
    try {
      await opened.getByRole("alertdialog", { name: "End of game" }).waitFor();

      // A point on an available location's own mark, chosen outside the panel so that the
      // only thing between the pointer and the pin is what the shell put there. The location
      // furthest outside it, rather than the first one that clears it, so which point this is
      // does not depend on how much of the entry animation is left.
      const target = await opened.evaluate(() => {
        const panel = document.querySelector(".end-of-game")!.getBoundingClientRect();
        const aimed = [...document.querySelectorAll<HTMLElement>(".map__pin")]
          .filter((pin) => pin.getAttribute("aria-disabled") !== "true")
          .map((pin) => {
            const mark = pin.querySelector(".map__pin-mark")!.getBoundingClientRect();
            const at = { x: mark.left + mark.width / 2, y: mark.top + mark.height / 2 };
            return {
              at,
              name: pin.getAttribute("aria-label"),
              // How far outside the panel's rect the point lies. Negative means under it.
              margin: Math.max(
                panel.left - at.x,
                at.x - panel.right,
                panel.top - at.y,
                at.y - panel.bottom,
              ),
            };
          })
          .sort((one, other) => other.margin - one.margin)[0];
        if (aimed === undefined) throw new Error("no available location on the map");
        return {
          ...aimed,
          inert: document.querySelector(".shell-behind")!.hasAttribute("inert"),
          // Whichever element the browser says is at that point is not the pin: the
          // shell drew something over it, which is half of what modality promises.
          hit: document.elementFromPoint(aimed.at.x, aimed.at.y)?.className ?? null,
        };
      });

      // The premise of the click below, stated as a measurement: there is a location the panel
      // does not cover. A layout change that takes it away fails here with the number it lost,
      // rather than leaving the case to find a point on some runs and not others.
      expect(target.margin).toBeGreaterThan(0);
      expect(target.inert).toBe(true);
      expect(target.hit).not.toContain("map__pin");

      await opened.mouse.click(target.at.x, target.at.y);
      await opened.waitForTimeout(100);
      await expect(opened.getByRole("complementary", { name: "Inspector" }).count()).resolves.toBe(
        0,
      );

      // And the focus, which is the half the scrim cannot carry and the one only `inert`
      // answers: the browser refuses to move focus into the marked subtree at all. Every
      // button behind the panel is asked for it, one at a time, and none of them takes it.
      const offered = await opened.evaluate(() => {
        const behind = [
          ...document.querySelectorAll<HTMLElement>(".map__pin"),
          ...document.querySelectorAll<HTMLElement>(".hud__research"),
        ];
        const taken = behind.filter((element) => {
          element.focus();
          return document.activeElement === element;
        });
        return {
          asked: behind.length,
          taken: taken.map((element) => element.getAttribute("aria-label") ?? element.className),
        };
      });
      expect(offered.asked).toBeGreaterThan(0);
      expect(offered.taken).toEqual([]);

      // Tab, six presses — twice round the panel's own ring of the panel and its one control.
      for (let press = 0; press < 6; press += 1) {
        await opened.keyboard.press("Tab");
        await expect(
          opened.evaluate(() => document.activeElement?.closest(".end-of-game") !== null),
        ).resolves.toBe(true);
      }

      // And the third promise: assistive technology is not offered what is behind the
      // panel. Playwright's role
      // engine still finds both of these, which is why the browser's own tree is asked.
      await expect(opened.getByRole("button", { name: "EUROPE" }).count()).resolves.toBe(1);
      const offeredNames = await accessibleNames(opened);
      expect(offeredNames).toContain("Back to the start screen");
      expect(offeredNames).not.toContain("EUROPE");
      expect(offeredNames).not.toContain("Research/Tasks");
      expect(offeredNames).not.toContain("Console");
    } finally {
      await opened.close();
    }
  });

  /**
   * The browser fact both halves of the lend rest on, measured rather than argued.
   *
   * Marking a subtree blurs whatever inside it had focus, but a read immediately after the
   * marking still finds the element focused. Both readings are here: the blur is real and it
   * is **late** — not in the task that sets the attribute, and done by the time anything else
   * asks. A microtask and one animation
   * frame both still read the element as focused when this was written, which is why neither
   * is the assertion: the two ends are the claim, the middle is a timing detail.
   *
   * It decides the arrangement in `App.tsx`. The shell reads what to lend *during the render*
   * because that is before the commit that marks, and gives it back *after* the marking comes
   * off; and where a second surface arrives later, over an opaque one, what it finds behind
   * that surface has already been blurred to `<body>` — so the shell hands the focus to the
   * surface in front instead.
   */
  it("blurs what a marking covers, but not in the task that marks it", async () => {
    const opened = await open("?scenario=grace-full&clock=frozen");
    try {
      const marked = await opened.evaluate(() => {
        const group = document.createElement("div");
        const button = document.createElement("button");
        button.id = "probe";
        button.textContent = "probe";
        group.append(button);
        document.body.append(group);
        button.focus();
        const before = document.activeElement === button;
        group.setAttribute("inert", "");
        return { before, sync: document.activeElement === button };
      });
      expect(marked).toEqual({ before: true, sync: true });

      await expect
        .poll(() => opened.evaluate(() => document.activeElement?.id === "probe"))
        .toBe(false);
    } finally {
      await opened.close();
    }
  }, 40_000);

  /**
   * The other half, and the one the app seam cannot even approximate: which element the focus
   * goes back to, and when. The shell marks the grouping in the same commit that mounts the
   * panel, so a panel reading `document.activeElement` in its own mount Effect is racing the
   * blur above, and a panel giving the focus back as it unmounts is refused outright —
   * `focus()` into a marked subtree is refused, and the shell drops the marking only after
   * the panel is gone. Both halves are therefore the shell's (`App.tsx`). happy-dom
   * implements no part of `inert`: nothing is blurred and nothing is refused there, so the
   * app seam's assertion passes whichever of the two does it.
   *
   * The clock runs here, because that is the only way a notification arrives at a moment the
   * test chose: the speed is set with the map's own hotkey rather than with the row of
   * buttons, so nothing this test does moves the focus it is about to check.
   */
  it("gives focus back to the element the shell had taken it from", async () => {
    const opened = await open("?scenario=grace-full");
    try {
      await opened.getByRole("button", { name: "EUROPE" }).waitFor();

      // Somewhere inside the grouping the shell marks inert, reached the way a player
      // reaches it: the research sheet is opened and closed again, and its button keeps the
      // focus the click gave it.
      await opened.getByRole("button", { name: "Research/Tasks" }).click();
      await opened.keyboard.press("Escape");
      const research = () =>
        opened.evaluate(() => {
          const active = document.activeElement;
          return {
            research: active?.classList.contains("hud__research") ?? false,
            behind: active?.closest(".shell-behind") !== null,
            inert: document.querySelector(".shell-behind")?.hasAttribute("inert") ?? null,
          };
        });
      expect(await research()).toEqual({ research: true, behind: true, inert: false });

      // What the browser's own accessibility tree offers with nothing over the map, which is
      // what makes the same reading under the panel below a measurement rather than a name
      // this page never had.
      const beforehand = await accessibleNames(opened);
      expect(beforehand).toContain("EUROPE");
      expect(beforehand).toContain("Research/Tasks");

      // The map's own speed hotkey: a key, so the focus above is still where it was.
      await opened.keyboard.press("4");
      await opened.getByRole("alertdialog", { name: "Notification" }).waitFor({ timeout: 20_000 });

      // The panel has it, the shell behind is inert, and the browser refuses to hand the
      // focus back into that subtree while it is — which is the whole mechanism.
      //
      // Polled, for the same reason as the give-back at the end of this test and the console's
      // further down this file: taking the focus is an Effect, and Preact defers an Effect past
      // the paint — one `requestAnimationFrame`, then one task (`afterNextFrame`, preact/hooks).
      // The `waitFor` above returns at the *commit* that mounts the panel, which is before all
      // of that: measured at the commit itself, this page reports `{ panel: false, inert: true }`
      // every time, because the marking is an attribute of that commit and the focus is not.
      // Read once, the assertion was a race between two clocks nothing orders — the focus lands
      // 8 to 15 ms after the commit, the read arrives over CDP 60 to 90 ms after it — and a
      // saturated machine is exactly what takes that margin away.
      const held = () =>
        opened.evaluate(() => {
          const behind = document.querySelector<HTMLElement>(".hud__research")!;
          behind.focus();
          return {
            panel: document.activeElement?.classList.contains("notification") ?? false,
            inert: document.querySelector(".shell-behind")!.hasAttribute("inert"),
            tookIt: document.activeElement === behind,
          };
        });
      await expect.poll(held).toEqual({ panel: true, inert: true, tookIt: false });

      // The same two names, gone from the tree the browser hands assistive technology, on the
      // same page that had them a moment ago.
      const underThePanel = await accessibleNames(opened);
      expect(underThePanel).toContain("Dismiss notification");
      expect(underThePanel).not.toContain("EUROPE");
      expect(underThePanel).not.toContain("Research/Tasks");

      // Tab cycles the panel and its one control, and never leaves.
      await opened.keyboard.press("Tab");
      await expect(opened.evaluate(() => document.activeElement?.className ?? null)).resolves.toBe(
        "notification__dismiss",
      );
      await opened.keyboard.press("Tab");
      await expect(opened.evaluate(() => document.activeElement?.className ?? null)).resolves.toBe(
        "notification",
      );

      await opened.keyboard.press("Escape");
      await expect(opened.getByRole("alertdialog", { name: "Notification" }).count()).resolves.toBe(
        0,
      );

      // And the focus is back where the player left it, inside a grouping that is no longer
      // inert. It is polled rather than read once because giving it back is an Effect: the
      // marking has to be gone first, and an Effect after the paint is the first moment it is
      // (`App.tsx`).
      await expect.poll(research).toEqual({ research: true, behind: true, inert: false });
    } finally {
      await opened.close();
    }
  }, 40_000);
});

/**
 * What an opaque surface owns, in the same browser.
 *
 * The console is opaque and full height to the reserved band and claims no modality. Behind
 * it nothing looks reachable at all.
 *
 * So it takes what it covers — the same `inert` a modal surface uses — and nothing else: no
 * focus capture, no Tab trap and no scrim. The app seam asserts the structure; these are the
 * three the browser has to be asked for, plus the focus the shell lends and gives back.
 */
describe("an opaque surface in a browser that enforces inert", () => {
  it("takes the pointer, the tab order and the accessibility tree of what it covers", async () => {
    const opened = await open("?scenario=grace-full&clock=frozen");
    try {
      await opened.getByRole("button", { name: "EUROPE" }).click();
      await opened.getByRole("complementary", { name: "Inspector" }).waitFor();
      await opened.getByRole("button", { name: "Console" }).click();
      await opened.getByRole("region", { name: "Console" }).waitFor();

      // The centre of an available location's mark. The console covers the whole shell above
      // the band, so there is no point to choose that is clear of it — at any viewport, which
      // is the difference from the centred panel above: that one clears the map's edges once
      // the viewport is wide enough, and this one never does.
      const target = await opened.evaluate(() => {
        for (const pin of document.querySelectorAll<HTMLElement>(".map__pin")) {
          if (pin.getAttribute("aria-disabled") === "true") continue;
          const mark = pin.querySelector(".map__pin-mark")!.getBoundingClientRect();
          const at = { x: mark.left + mark.width / 2, y: mark.top + mark.height / 2 };
          return { at, hit: document.elementFromPoint(at.x, at.y)?.className ?? null };
        }
        throw new Error("no available location to aim at");
      });
      expect(target.hit).not.toContain("map__pin");

      await opened.mouse.click(target.at.x, target.at.y);
      await opened.waitForTimeout(100);
      await expect(opened.getByRole("region", { name: "Console" }).count()).resolves.toBe(1);

      // Nothing the console covers takes the focus when it is asked for it directly, and the
      // console's own controls still do.
      const offered = await opened.evaluate(() => {
        const took = (selector: string): string[] =>
          [...document.querySelectorAll<HTMLElement>(selector)]
            .filter((element) => {
              element.focus();
              return document.activeElement === element;
            })
            .map((element) => element.getAttribute("aria-label") ?? element.className);
        return {
          behind: took(".map__pin, .hud__research, .inspector button"),
          own: took(".console button").length,
        };
      });
      expect(offered.behind).toEqual([]);
      expect(offered.own).toBeGreaterThan(0);

      // And the accessibility tree, which is the reading the scrim could never have carried.
      const offeredNames = await accessibleNames(opened);
      expect(offeredNames).toContain("Close console");
      expect(offeredNames).not.toContain("EUROPE");
      expect(offeredNames).not.toContain("Research/Tasks");

      // No scrim: an opaque surface is one.
      await expect(opened.locator(".shell-scrim").count()).resolves.toBe(0);
    } finally {
      await opened.close();
    }
  }, 40_000);

  /**
   * The boundary of the rule, which only a browser can draw: the research sheet is **not**
   * opaque, and that is a claim about a rendered box rather than about a stylesheet. Its
   * `max-height` is `min(720px, calc(100% - var(--band-height) - var(--research-sheet-strip)))`,
   * which at the floor is 490px, so whether a strip of map stays above it is guaranteed by the
   * reservation and this is where a regression in that calc would be noticed.
   *
   * If a longer research list ever fills it, the sheet becomes a fourth opaque surface and
   * `surfaces.ts` has to say so. This is where that would be noticed.
   */
  it("leaves a strip of the map above the research sheet, which is why it is not one", async () => {
    for (const viewport of [FLOOR, { width: 1440, height: 792 }]) {
      const opened = await open("?scenario=grace-full&clock=frozen", viewport);
      try {
        await opened.getByRole("button", { name: "Research/Tasks" }).click();
        await opened.getByRole("region", { name: "Research/Tasks" }).waitFor();

        const measured = await opened.evaluate(() => {
          const sheet = document.querySelector(".research-sheet")!.getBoundingClientRect();
          const shell = document.querySelector(".shell")!.getBoundingClientRect();
          const band = document.querySelector(".band")!.getBoundingClientRect();
          return { top: sheet.top, shellTop: shell.top, bottom: sheet.bottom, bandTop: band.top };
        });

        expect(measured.top).toBeGreaterThan(measured.shellTop);
        expect(measured.bottom).toBeLessThanOrEqual(measured.bandTop + LAYOUT_UNIT);
      } finally {
        await opened.close();
      }
    }
  }, 40_000);

  /**
   * The tab order, walked backwards, which is the direction that tells the two arrangements
   * apart. Forwards from the console's first control the player would reach the rest of the
   * console either way, because the console is drawn after the HUD; backwards is where an
   * unmarked page hands them the HUD's own buttons, one behind an opaque surface.
   *
   * Then the focus the shell lends: it is taken before the marking goes on and given back
   * after it comes off (`App.tsx`), so where the player lands when the console closes is the
   * shell's answer rather than whatever the browser happened to leave behind.
   */
  it("keeps the tab order inside itself and gives the focus back when it closes", async () => {
    const opened = await open("?scenario=grace-full&clock=frozen");
    try {
      await opened.getByRole("button", { name: "Console" }).click();
      await opened.getByRole("region", { name: "Console" }).waitFor();

      // From the console's own first control, backwards. Nothing before it on the page is
      // reachable, so the player leaves the document rather than landing on the HUD.
      await opened.evaluate(() => {
        document.querySelector<HTMLElement>(".console button")!.focus();
      });
      await opened.keyboard.press("Shift+Tab");
      await expect(
        opened.evaluate(() => {
          const active = document.activeElement;
          return {
            behind: active?.closest(".hud, .map") !== null,
            marked: active?.closest("[inert]") !== null,
          };
        }),
      ).resolves.toEqual({ behind: false, marked: false });

      await opened.keyboard.press("Escape");
      await expect(opened.getByRole("region", { name: "Console" }).count()).resolves.toBe(0);

      // Back on the button that opened it. Polled, because giving it back is an Effect: the
      // marking has to be gone first (`App.tsx`).
      await expect
        .poll(() => opened.evaluate(() => document.activeElement?.textContent?.trim() ?? null))
        .toBe("Console");
    } finally {
      await opened.close();
    }
  }, 40_000);

  /**
   * The other direction of the same lend, and the one only this seam can see: a
   * surface arriving **over** an opaque one borrows from behind that opaque surface, where
   * there is nothing left to borrow. The console leaves the focus on the HUD button that
   * opened it — it captures none itself — the browser then blurs that button because the
   * console's marking covers it, and a notification arriving a moment later finds `<body>`.
   * Arrive early enough to find the button instead and it is marked, and `focus()` into a
   * marked subtree is refused. Either way the shell had nothing to give back and left the
   * player on `<body>`: nothing was unreachable, Tab walks into the console from there, but
   * the landing place was not the one the shell chose, which is what the lend is for.
   *
   * The clock runs, because a notification arriving over an open console is the route to it.
   * The speed is set with the map's own hotkey before the console is opened: the digits are
   * the map's alone, and a key does not move the focus this case turns on.
   */
  it("hands the focus to the surface in front when what it lent cannot take it", async () => {
    const opened = await open("?scenario=grace-full");
    try {
      await opened.getByRole("button", { name: "EUROPE" }).waitFor();
      await opened.keyboard.press("4");
      await opened.getByRole("button", { name: "Console" }).click();
      await opened.getByRole("region", { name: "Console" }).waitFor();

      const active = () =>
        opened.evaluate(() => {
          const element = document.activeElement;
          return {
            console: element?.closest(".console") !== null,
            lendable:
              element !== null && element !== document.body && element.closest("[inert]") === null,
          };
        });

      // There is nothing behind the console for the next surface to borrow. What it lent from
      // is the HUD's own Console button, and both of the HUD's buttons are inside the marking
      // the console causes; a moment later the browser has blurred that one to `<body>` as
      // well. Neither shape is somewhere a player can be put back, and which of the two a
      // surface arriving over the console finds is a matter of when it arrives — so what is
      // read here is the half that does not depend on that.
      const behind = await opened.evaluate(() => {
        const hud = [...document.querySelectorAll<HTMLElement>(".hud__research")];
        return {
          buttons: hud.length,
          marked: hud.filter((button) => button.closest("[inert]") !== null).length,
          inConsole: document.activeElement?.closest(".console") !== null,
        };
      });
      expect(behind).toEqual({ buttons: 2, marked: 2, inConsole: false });

      await opened.getByRole("alertdialog", { name: "Notification" }).waitFor({ timeout: 20_000 });
      await opened.getByRole("button", { name: "Dismiss notification" }).click();
      await expect(opened.getByRole("alertdialog", { name: "Notification" }).count()).resolves.toBe(
        0,
      );

      // The console is still the surface in front, and the player is in it: with nothing to
      // give back, the shell hands the focus to the surface in front (`App.tsx`). Polled,
      // because giving it is an Effect.
      await expect(opened.getByRole("region", { name: "Console" }).count()).resolves.toBe(1);
      await expect.poll(active).toEqual({ console: true, lendable: true });
    } finally {
      await opened.close();
    }
  }, 60_000);
});

/**
 * The development bar is outside the shell's stack on purpose.
 *
 * `development/boot.tsx` mounts it beside the application's mount point rather than inside
 * it, so Presentation renders into exactly the tree it renders into in production. The cost
 * is that nothing the shell marks reaches the bar: while a modal or an opaque surface is up,
 * 'Advance one game day' still takes a real click, still takes the focus and is still in the
 * accessibility tree.
 *
 * That is the decision rather than the defect. The bar is a debugger, not a control on the
 * page, and it never ships (`check:development-only`). What it costs is a rule for whoever
 * writes a browser test: a test that reaches the bar while a surface has taken the page is
 * reaching something the shipped page does not have, and a session driving a covered surface
 * from the bar is driving it from outside the stack. This is that decision, pinned where it
 * would be noticed if the bar moved.
 */
describe("the development bar beside the application", () => {
  it("stays outside everything the shell marks, while a surface has taken the page", async () => {
    const opened = await open("?scenario=lost-to-suspicion&clock=frozen");
    try {
      await opened.getByRole("alertdialog", { name: "End of game" }).waitFor();

      const bar = await opened.evaluate(() => {
        const advance = document.querySelector<HTMLElement>(".development__step");
        if (advance === null) throw new Error("no development bar on the page");
        advance.focus();
        return {
          inShell: advance.closest(".shell") !== null,
          marked: advance.closest("[inert]") !== null,
          takesFocus: document.activeElement === advance,
        };
      });

      expect(bar).toEqual({ inShell: false, marked: false, takesFocus: true });
      expect(await accessibleNames(opened)).toContain("Advance one game day");
    } finally {
      await opened.close();
    }
  }, 40_000);
});
