import { signal } from "@preact/signals";
import { render, type JSX } from "preact";

import { MOUNT_SELECTOR, type Booted } from "./boot.tsx";
import { AUTOSAVE_KEY, type Resume, type SaveStore } from "./host/save-store.ts";
import { createSession, type Session } from "./host/session.ts";
import type { FrameSource } from "./host/time.ts";
import type { LicenceDocument } from "./ui/licences/document.ts";
import { StartScreen } from "./ui/start/StartScreen.tsx";

/**
 * Cold start: the page opens on the start screen, and a game begins when the player chooses
 * one.
 *
 * This is the half of "the way in" that is the Host's rather than Presentation's — the save
 * store is read here, the Session is made here, and the start screen is handed answers rather
 * than a store it could ask. It is also where the one question the start screen cannot decide
 * is decided: **Continue appears only when a readable autosave exists**, and that is known
 * only by resuming, so both the button and the game behind it come out of one read.
 *
 * Continue is the whole of loading. There is one slot, so there is nothing
 * to pick between and no list to pick from — and the claim Continue makes is still a claim
 * about the slot *now*: a game that ends goes back to this screen and the store is read again
 * on the way, so what the screen offers is what the finished game left in it.
 *
 * `begin` is the boot, passed in rather than called: `main.tsx` knows the autosave, the
 * visibility source and the browser's frames, and the development entry point wraps the same
 * function to add a frozen clock and the development bar. Neither belongs here.
 *
 * # The way out is the way in
 *
 * A game that is over comes back to the start screen. Upstream's lost game leaves the map
 * screen for the main menu (`code/screens/map.py:785`), and the port cannot leave the map — it
 * is the application — so what it leaves is the game: the Host is stopped and this same start
 * screen is rendered into the same mount point the game was rendered into. The page is not
 * reloaded, and the store is read again on the way back, so the start screen describes what the
 * finished game left in it.
 */
export interface StartOptions {
  /**
   * Whether this game is one the player is keeping. A Scenario replay is not: autosaving a
   * re-derived state over the slot the player's own game lives in would destroy that game.
   */
  readonly autosaves?: boolean;
  readonly frames?: FrameSource;
  /** Whether the game opens with the intro story. Only a new game from the start screen does. */
  readonly intro?: boolean;
  /**
   * Where a game that is over goes back to. `coldStart` hands its own start screen in, and
   * the development entry point hands the same screen to a Scenario replay
   * (`development/boot.tsx`) — a lost game's panel is modal, so the way back is the only
   * thing it leaves reachable (`ui/EndOfGame.tsx`).
   */
  readonly onLeave?: () => void;
  /**
   * Where a game whose Tick refused goes: the reason, and the same way back `onLeave` takes.
   * The Host has already stopped the game before this is called (`host/session.ts`).
   */
  readonly onRefusal?: (reason: string) => void;
  /**
   * The licences document this build carries, for the surface the console is the second way
   * into. The cold start owns it already — it is where the document arrives — so
   * the game is handed it rather than growing a way to ask.
   */
  readonly licences?: LicenceDocument;
}

export type Begin = (session: Session, options?: StartOptions) => Booted;

export interface ColdStartOptions {
  readonly into: ParentNode;
  readonly store: SaveStore;
  /** The day of the year the clock is offset by, which the Host draws (`host/save.ts`). */
  readonly startDay: number;
  readonly licences: LicenceDocument;
  readonly begin: Begin;
  /** Where a refusal goes as well as onto the screen. The console, on the real page. */
  readonly report?: (message: string) => void;
  /** Development only: the Scenarios the start screen offers, and what to do with one. */
  readonly scenarios?: readonly string[];
  readonly onScenario?: (id: string) => void;
}

export function coldStart(options: ColdStartOptions): void {
  const { into, store, startDay, licences, begin, report, scenarios, onScenario } = options;

  const mount = into.querySelector(MOUNT_SELECTOR);
  if (!(mount instanceof HTMLElement)) throw new Error(`missing ${MOUNT_SELECTOR} mount point`);

  /**
   * What the page has to say for itself about the store: a save left alone, a game that would
   * not run.
   *
   * **A sentence the notices already carry is not appended again.** Each one
   * says what is so rather than that something happened, and a standing sentence is not made
   * truer by a second copy of itself. That is also what makes the sentence a key the renderer
   * can use — two identical notices were two entries under one Preact key, and the screen the
   * player reads is the one place a repeat is worth nothing.
   *
   * `report` still gets every one, in order, repeats included: the console is the log.
   */
  const notices = signal<readonly string[]>([]);
  const tell = (message: string): void => {
    if (!notices.value.includes(message)) notices.value = [...notices.value, message];
    report?.(message);
  };

  // One resume, before anything is drawn: it answers whether there is a game to continue and
  // it is the game that is continued. A save this build cannot read is left exactly where it
  // is, and said out loud rather than dropped silently.
  const resumed = store.resume(startDay);
  for (const slot of resumed.retired) {
    tell(`The save in "${slot.key}" was left alone: ${slot.reason}`);
  }
  if (resumed.key !== AUTOSAVE_KEY) tell(`A game started here autosaves to "${resumed.key}".`);

  /** The game Continue would continue. `state` is `undefined` when there is nothing to. */
  const continuable = signal<Resume>(resumed);

  /**
   * The game on the frames, while there is one. There is at most one, which is what this
   * variable is for: a Host left behind would be invisible rather than absent — still
   * subscribed to the frames, still ticking a Session nothing is drawing, and still writing
   * that game into the autosave slot the new one is about to use.
   */
  let running: Booted | undefined;

  /**
   * One game that is over, left — and what it comes back to.
   *
   * Whoever calls this has already stopped the Host: `boot` stops it on the way out
   * (`boot.tsx`) and a refusal stops it before it reports (`host/session.ts`). The store is
   * read again on the way, because the game that just ended autosaved into it: Continue
   * describes the slot now, not the slot the page opened on.
   */
  const back = (): void => {
    running = undefined;
    continuable.value = store.resume(startDay);
    render(<Start />, mount);
  };

  const start = (session: Session, intro = false): void => {
    // One game at a time: the Host that was drawing lets go of the frames before the next
    // one takes them — and letting go stops its clock, so an autosave the throttle was still
    // holding for a game that was alive is written rather than dropped (`host/session.ts`).
    running?.host.stop();
    running = begin(session, {
      intro,
      licences,
      onLeave: back,
      // A Tick that refuses is the one refusal the resume cannot give, because it is past the
      // door `readSave` closes: the state rebuilt, the game resumed, and only then a rule that
      // will not run it. The save the game came from is untouched, because a
      // game that never finished a Tick has nothing owed to write over it.
      onRefusal: (reason) => {
        tell(`This game will not run: ${reason}`);
        back();
      },
    });
  };

  const Start = (): JSX.Element => (
    <StartScreen
      continues={continuable.value.state}
      licences={licences}
      notices={notices.value}
      {...(scenarios !== undefined && onScenario !== undefined ? { scenarios, onScenario } : {})}
      onContinue={() => {
        const { state: restored, dismissedEnding } = continuable.value;
        if (restored !== undefined) {
          // The end-of-game panel the save says its player had dismissed, so a won game that
          // is continued comes back to the map rather than to the panel.
          start(createSession({ restored, ...(dismissedEnding && { dismissedEnding }) }));
        }
      }}
      onNewGame={(difficulty) => start(createSession({ difficulty }), true)}
    />
  );

  render(<Start />, mount);
}
