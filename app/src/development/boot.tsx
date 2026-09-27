import { SECONDS_PER_DAY } from "@singularity/sim";
import { render } from "preact";

import { MOUNT_SELECTOR, type Booted } from "../boot.tsx";
import { coldStart, type Begin, type ColdStartOptions, type StartOptions } from "../cold-start.tsx";
import type { Session } from "../host/session.ts";
import { browserFrames, type FrameSource } from "../host/time.ts";
import { DevelopmentBar } from "./DevelopmentBar.tsx";
import { developmentFlags } from "./flags.ts";
import { freezeClock } from "./frozen-clock.ts";
import { developmentOnly } from "./only.ts";
import { scenarioNames, scenarioSession } from "./scenarios.ts";

developmentOnly("development boot");

/**
 * Everything the page does on load **in development**: the flags out of the query string, the
 * Scenarios offered on the start screen, a clock that may be frozen, and the ordinary cold
 * start over all of it.
 *
 * It wraps `coldStart()` and `begin()` rather than growing options inside them. The shipped
 * entry point then has no branch for a build gate to argue about — no `if (frozen)`, no
 * Scenario table, no reachable path at all — and `main.tsx` reaches this only from inside
 * `if (import.meta.env.DEV)`, which the production build folds to `false` and eliminates
 * whole. `app/scripts/check-development-only.ts` is the assertion that it did.
 *
 * # Scenario boot enters from the start screen
 *
 * It enters there rather than beside it: with no `?scenario` flag the
 * page opens on the start screen with the Scenario list on it, so a replay is one of the ways
 * in rather than a second way in. `?scenario=<id>` is the deep link past it, which is what a
 * screenshot wants — a Scenario boot is reproducible by name, and reproducible by name means
 * by URL.
 *
 * A Scenario boot leaves the save store alone, in both directions: it does not continue the
 * game in the autosave slot — it re-derives one — and it does not write over it either.
 * Autosaving a replay into the slot the player's own game lives in would lose that game.
 *
 * The bar is mounted beside the application's own mount point rather than inside it, so
 * Presentation renders into exactly the tree it renders into in production. It appears with
 * the game: on the start screen there is no origin to describe and no day to advance.
 *
 * # The bar is outside the shell's stack, on purpose
 *
 * Nothing the shell marks reaches it. While a modal or an opaque surface
 * has taken the page, 'Advance one game day' still takes a real click, still takes the focus
 * and is still in the accessibility tree — because it is beside the mount point rather than
 * inside the groupings `App.tsx` marks `inert`.
 *
 * That is the decision rather than the defect: the bar is a debugger, not a control on the
 * page, and it never ships (`check:development-only`). What it costs is a rule for whoever
 * writes a browser test — a test that reaches the bar while a surface has taken the page is
 * reaching something the shipped page does not have, and a session driving a covered surface
 * from the bar is driving it from outside the stack. It is pinned in
 * `app/test/viewport.test.ts`, where it would be noticed if the bar moved.
 */
export interface DevelopmentColdStartOptions extends Omit<
  ColdStartOptions,
  "scenarios" | "onScenario"
> {
  /** The page's query string. `window.location.search` on the real page. */
  readonly search?: string;
  /** The page's frames, which the frozen clock wraps. The browser's, on the real page. */
  readonly frames?: FrameSource;
}

/** The game the flags booted straight away, or nothing when the start screen is up. */
export function developmentColdStart(options: DevelopmentColdStartOptions): Booted | undefined {
  const { search = "", frames = browserFrames(), begin, ...rest } = options;
  const flags = developmentFlags(search);
  const clock = flags.frozen ? freezeClock(frames) : frames;

  /**
   * The bar of the game that is on the frames, while there is one, and the way to take it
   * away. It is one variable for the whole page life rather than one per `begin` because
   * there is one bar at a time — the same reason `cold-start.tsx` keeps one `running`.
   *
   * A game is left in three ways: the way out
   * and a Tick that refused, both of which end with a start screen. The console's save list
   * is the third — a second `begin` while the first game is still up — and it takes neither
   * of the other two paths. The bar mounts *beside* the mount point, so `boot`'s clearing of
   * the mount point does not reach it, and a bar not taken away here is a bar that stays.
   */
  let removeBar: (() => void) | undefined;
  const dropBar = (): void => {
    removeBar?.();
    removeBar = undefined;
  };

  const withBar: Begin = (session, start = {}) => {
    // The bar belongs to the game it describes, so a game left — or replaced — takes it with
    // it: a start screen under a bar saying which Scenario is running would be describing
    // nothing, and a loaded game under the bar of the game it replaced describes a game that
    // is gone.
    dropBar();
    const leave = start.onLeave;
    const refused = start.onRefusal;
    const booted = begin(session, {
      ...start,
      frames: start.frames ?? clock,
      ...(leave && {
        onLeave: () => {
          dropBar();
          leave();
        },
      }),
      // A Tick that refuses leaves the game as surely as the way out does, so the bar goes
      // with it (`host/session.ts`).
      ...(refused && {
        onRefusal: (reason: string) => {
          dropBar();
          refused(reason);
        },
      }),
    });
    removeBar = mountBar(rest.into, session, flags.frozen, start.autosaves !== false);
    return booted;
  };

  /**
   * The start screen, opened: on load with no Scenario named, and again when a replay that is
   * over is left. It reads the save store on the way, as every arrival at the start screen
   * does (`cold-start.tsx`).
   */
  const openStartScreen = (): void => {
    coldStart({
      ...rest,
      begin: withBar,
      scenarios: scenarioNames(),
      onScenario: (id) => {
        replay(id);
      },
    });
  };

  // A replay is left the way every other game is left: for the start screen. `?scenario=` is
  // the deep link *past* that screen rather than a page without one, so a Scenario
  // that ends in a loss has the same way back — and without it the ending panel is a modal
  // surface with no control on it, behind which the shell has put the whole page out of reach.
  const replay = (id: string): Booted =>
    withBar(scenarioSession(id), { ...REPLAYED, onLeave: openStartScreen });

  if (flags.scenario !== undefined) return replay(flags.scenario);

  openStartScreen();
  return undefined;
}

/** A re-derived state is not a game the player is keeping. */
const REPLAYED: StartOptions = { autosaves: false };

/** Mounts the bar beside the application, and returns the way to take it away again. */
function mountBar(
  into: ParentNode,
  session: Session,
  frozen: boolean,
  autosaving: boolean,
): () => void {
  const mount = into.querySelector(MOUNT_SELECTOR);
  if (mount === null) return () => {};
  const bar = mount.ownerDocument.createElement("div");
  // Named, because the strip it takes is claimed from the mount point beside it and the rule
  // that does so has to be able to say which sibling it is (`DevelopmentBar.css`).
  bar.className = "development-bar";
  mount.before(bar);
  render(
    <DevelopmentBar
      origin={session.origin}
      frozen={frozen}
      autosaving={autosaving}
      onAdvanceDay={() => session.advanceBy(SECONDS_PER_DAY)}
    />,
    bar,
  );
  return () => {
    render(null, bar);
    bar.remove();
  };
}
