import { render } from "preact";

import type { Autosave } from "./host/autosave.ts";
import { createSession, startHost, type Host, type Session } from "./host/session.ts";
import { browserFrames, type FrameSource } from "./host/time.ts";
import type { Speed } from "./host/tick-partition.ts";
import type { HiddenSource } from "./host/visibility.ts";
import { App } from "./ui/App.tsx";
import type { LicenceDocument } from "./ui/licences/document.ts";

/**
 * One game beginning: one Host over the browser's frames, and Presentation mounted on the
 * State root the Host publishes.
 *
 * It is a function taking its frame source rather than a script reaching for the browser's,
 * so the whole chain — frames, scheduler, Tick, published root, readout — is drivable by a
 * test at the app seam with the clock in the test's hands. `main.tsx` wraps this in the
 * arguments a test cannot be handed: the real page, the real frames, and the browser storage
 * the game is autosaved into.
 *
 * It renders into the same mount point the start screen was drawn in, which is what makes
 * the transition one tree replacing another rather than a page changing (`cold-start.tsx`).
 */
export const MOUNT_SELECTOR = "#app";

export interface BootOptions {
  /** The page to mount into. The real one in `main.tsx`, the test's document in a test. */
  readonly into: ParentNode;
  readonly frames?: FrameSource;
  /**
   * Upstream starts at speed 1 (`code/g.py:76`) — and stops the clock on a load, which is the
   * Host's call from the Session's origin rather than this option's (`startHost`).
   */
  readonly speed?: Speed;
  readonly session?: Session;
  /**
   * The autosave, when this page keeps one. Built outside because it is built *from* the
   * session and needs a store — which is the one thing `boot` cannot conjure for a test.
   */
  readonly autosave?: Autosave;
  readonly hidden?: HiddenSource;
  readonly intro?: boolean;
  /**
   * What happens when the player leaves a game that is over: the start screen, on a page that
   * came from one (`cold-start.tsx`). The Host is stopped on the way out, here rather than in
   * the caller, because this is what started it.
   *
   * Every way into a game on the page hands one in, the deep-linked Scenario replay included
   * (`development/boot.tsx`): the end-of-game panel is modal, so a lost game whose panel
   * offers no way out is a page with nothing on it to reach. It stays optional for
   * a test that boots the application with no page behind it.
   */
  readonly onLeave?: () => void;
  /**
   * What happens when a Tick refuses: the reason, for the page to say out loud. The Host has
   * already stopped itself by then, so this is the page deciding where the player goes rather
   * than the game being wound down twice (`host/session.ts`).
   *
   * Left out where there is nothing to say it on — a `?scenario=` boot — and the throw then
   * reaches the console the way it always did.
   */
  readonly onRefusal?: (reason: string) => void;
  /**
   * The licences document, for the surface the console is the second way into
   * (`ui/App.tsx`). It is the page's rather than the game's — generated at build time — so it
   * is handed in here, the way the way out is. Left out by a test that boots the application
   * with no page behind it, and the console then offers it not at all.
   */
  readonly licences?: LicenceDocument;
}

export interface Booted {
  readonly session: Session;
  readonly host: Host;
}

export function boot({
  into,
  frames = browserFrames(),
  speed = 1,
  session = createSession(),
  autosave,
  hidden,
  intro = false,
  onLeave,
  onRefusal,
  licences,
}: BootOptions): Booted {
  const mount = into.querySelector(MOUNT_SELECTOR);
  if (!(mount instanceof HTMLElement)) throw new Error(`missing ${MOUNT_SELECTOR} mount point`);

  const host = startHost({
    session,
    frames,
    speed,
    ...(autosave && { autosave }),
    ...(hidden && { hidden }),
    intro,
    ...(onRefusal && { onRefusal }),
  });
  // Leaving is the one thing Presentation asks for that is not about this game's state: the
  // frame subscription goes first, so nothing is still ticking behind the screen that replaces
  // it, and only then does the page do whatever it does with a game that is over.
  const leave =
    onLeave &&
    ((): void => {
      host.stop();
      onLeave();
    });

  // Whatever was in the mount point goes before this game is drawn into it. A game started
  // from inside another one renders one `App` over another (`cold-start.tsx`), and
  // a diff would keep the shell's own state across the two — the new game arriving under the
  // save list the player loaded it from, on a console the game before it had opened. A new
  // game is a new tree.
  render(null, mount);

  // The State root and the Speed, which are the only two things Presentation is handed: one
  // is the Simulation's and one is the Host's, and nothing else crosses.
  render(
    <App
      state={session.state}
      speed={host.speed}
      dismissedEnding={session.dismissedEnding}
      notification={host.notifications.current}
      onDismissNotification={host.notifications.dismiss}
      onCommand={(command) => session.apply(command)}
      {...(leave && { onLeave: leave })}
      {...(licences && { licences })}
    />,
    mount,
  );

  return { session, host };
}
