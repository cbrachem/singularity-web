import { signal, type ReadonlySignal, type Signal } from "@preact/signals";
import type { Command, SimulationState } from "@singularity/sim";
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { Speed } from "../host/tick-partition.ts";
import type { Notification as NotificationState } from "../host/notifications.ts";
import { SPEED_HOTKEYS } from "./SpeedControl.tsx";
import { Hud } from "./Hud.tsx";
import { Console } from "./Console.tsx";
import { EndOfGame } from "./EndOfGame.tsx";
import { endOfGame } from "./end-of-game.ts";
import { Inspector } from "./Inspector.tsx";
import { ResearchSheet } from "./ResearchSheet.tsx";
import { ThreatBand } from "./ThreatBand.tsx";
import { WorldMap } from "./map/WorldMap.tsx";
import { Notification } from "./Notification.tsx";
import { focusFrontSurface, isOutOfReach } from "./focus.ts";
import { shortcutsOn } from "./shortcuts.ts";
import { Licences } from "./licences/Licences.tsx";
import type { LicenceDocument } from "./licences/document.ts";
import {
  depth,
  frontSurface,
  isModal,
  isOpaque,
  outOfReach,
  takesWhatIsBehind,
  type Surface,
} from "./surfaces.ts";
import "./tokens.css";
import "./App.css";

/**
 * The shell: the world map, full-bleed and always present, with the HUD over it and the
 * threat band reserved along its bottom edge.
 *
 * The map is the application rather than a screen inside it — the world is what
 * the player is playing against, suspicion is geographic and base placement is geographic,
 * so a shell that lets the map leave the screen makes the player reason about a list where
 * the game is reasoning about a globe. Every later surface is drawn *over* this: the
 * inspector insets it, the console overlays it, and neither replaces
 * it. The band is the one exception, and the reason it is a sibling here rather than part of
 * the HUD: it is not drawn over the map, it is subtracted from it, and no surface may enter
 * it.
 *
 * # One root, read once
 *
 * `state.value` is read here and nowhere below. Everything on the screen is a pure function
 * of that one value, so change detection is reference equality against the previous root and
 * a paused game — which publishes no new root — re-renders nothing at all. Per
 * component polling was the alternative and was rejected on exactly that: every component
 * waking sixty times a second to find that nothing happened, and no answer to "which state
 * is on screen", which is the question the frozen clock and every screenshot comparison both
 * ask.
 *
 * It is handed the State root and not the Session, which is the difference between a rule and
 * a habit: the Session also carries the *live* clock, current between publications, and a
 * component reading that would render a number no published root ever held. Presentation
 * cannot read what it was never given.
 *
 * The Speed and the bound Command callback arrive separately: neither is Simulation state,
 * and Presentation cannot reach the Session behind either of them. Speed belongs to the Host;
 * the HUD shows it, and the research sheet uses the callback to issue a Command.
 *
 * The Speed signal is the one thing here that is written as well as read, and it is the
 * Host's own cell rather than a copy of it (`host/session.ts`): the player's choice and the
 * scheduler's pause arrive in the same place, so the two can never disagree about what the
 * setting is. It is still not Simulation state and it never becomes a Command.
 */
export interface AppProps {
  readonly state: ReadonlySignal<SimulationState>;
  readonly speed: Signal<Speed>;
  readonly onCommand?: (command: Command) => void;
  /**
   * Where the dismissal of the end-of-game panel is kept: the game's own cell, which the save
   * document carries (`host/session.ts`). The ending itself is derived from the
   * State root and stays derived — a won game goes on saying `apotheosis` — so this is the one
   * part of it Presentation writes rather than reads, the way it writes the Speed.
   *
   * A shell handed none keeps the dismissal to itself, which is what a test rendering the
   * application with no game behind it gets, and what the surface did before it survived a
   * reload.
   */
  readonly dismissedEnding?: Signal<string | null>;
  readonly notification?: ReadonlySignal<NotificationState | null>;
  readonly onDismissNotification?: () => void;
  /**
   * Leaves a game that is over, for the start screen it was started from (`boot.tsx`). The one
   * thing on this surface that ends the application's game rather than changing it, and the
   * reason it is handed in rather than done here: Presentation draws a State root and does not
   * own the page.
   */
  readonly onLeave?: () => void;
  /**
   * The licences document, when this page has one to show. The console is the
   * second way to it, because whoever receives the bundle must be able to find it without
   * ending a game — and the document is generated at build time, so it arrives from the page
   * rather than from the State root (`licences/document.ts`).
   */
  readonly licences?: LicenceDocument;
}

/** The surface the console opens over itself, and which it does not contain. */
type Secondary = "licences";

/**
 * What one surface that took the page borrowed the focus from, to give back when it goes.
 *
 * `element` is null where there was nothing to borrow: the player had reached nothing, or the
 * browser had already blurred what they had reached, which is what it does to a focused
 * element a marking has just covered. `<body>` is how that arrives and is not somewhere to
 * put a player back (`focus.ts`).
 */
interface Lender {
  readonly surface: Surface;
  readonly element: HTMLElement | null;
}

export function App({
  state,
  speed,
  dismissedEnding,
  onCommand,
  notification,
  onDismissNotification,
  onLeave,
  licences,
}: AppProps): JSX.Element {
  const [inspectedLocationId, setInspectedLocationId] = useState<string | null>(null);
  const [researchOpen, setResearchOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [secondary, setSecondary] = useState<Secondary | null>(null);
  const [nightVisible, setNightVisible] = useState(true);
  const ownDismissal = useMemo(() => signal<string | null>(null), []);
  const dismissal = dismissedEnding ?? ownDismissal;

  /**
   * The surface the console opens, counted the way the notification is: only where there is
   * something to draw. A shell handed no licences document has no entry to press, so it
   * cannot be up — and the stack and the markup say the same thing.
   */
  const licencesUp = secondary === "licences" && licences !== undefined;
  const closeSecondary = (): void => setSecondary(null);

  /**
   * How this game ended, if it has. It is read from the published root rather than caught as
   * an Effect, so a game that was won before this page opened — a Save load, a Scenario boot
   * — still says so (`end-of-game.ts`).
   *
   * The dismissal is the one half of that which is not in the root, because a won game is
   * played on and goes on saying `apotheosis`. It is the game's rather than this component's,
   * so it survives the reload the ending itself already survives.
   */
  const ending = endOfGame(state.value);
  const endingUp = ending !== null && dismissal.value !== ending.sectionId;

  /**
   * The notification the shell has up. It counts as one only where there is a way to dismiss
   * it, because the stack and the markup must agree: a surface the shell puts in front of the
   * player while drawing no panel is an inert page with nothing left on it to reach.
   * A caller that hands in no way out of a notification has none up.
   *
   * **The ending is alone.** A notification that arrives at, or
   * survives, the end of the game was drawn behind the ending: two centred alertdialogs at
   * once, the one behind unreachable until the one in front was gone, and never dismissed
   * while it sat there — so a won game that was continued walked straight back into it. The
   * shell holds the queue instead. Nothing is dismissed here, so the notification is still
   * there when a won game is continued, which is the game going on; a lost game never
   * dismisses the ending, so a notification queued at the end of one is never shown.
   */
  const activeNotification =
    onDismissNotification && !endingUp ? (notification?.value ?? null) : null;

  /**
   * The one thing every listener on this page asks: which surface is in front of the player.
   * The shell's keyboard below, the inspector's own (`Inspector.tsx`) and what a modal
   * surface takes out of reach are three readings of this single answer rather than three
   * conditions that can drift apart (`surfaces.ts`).
   */
  const front = frontSurface({
    ending: endingUp,
    notification: activeNotification !== null,
    licences: licencesUp,
    console: consoleOpen,
    research: researchOpen,
    inspector: inspectedLocationId !== null,
  });

  /**
   * The same answer, where a listener can read it *now*. An Effect re-registers after the
   * paint, so a handler that closed over the answer would spend one frame guarding on the
   * surface that was in front before this render — and a notification arrives on a Tick
   * rather than on a click, so that frame is the one the player is keying into. The
   * inspector's listener reads its own prop the same way, for the same reason.
   */
  const current = useRef(front);
  current.current = front;

  /**
   * The focus a surface borrows when it takes the page, taken on the way in and given back on
   * the way out. Both halves are the shell's, because the shell is what
   * marks the groupings below `inert` and only it can order the two against that marking.
   *
   * **Taken during the render**, which is the last moment it can be read for certain: a modal
   * panel takes the focus in its own mount Effect, and what `activeElement` says between that
   * commit and this Effect is a race — the same page, twice, said `<body>` once and the
   * player's own button once.
   *
   * **Given back in an Effect**, which is the first moment it can be given: the marking is
   * dropped *after* the panel is unmounted, not in the same breath, and `focus()` on an
   * element inside an inert subtree is refused. A panel restoring it as it unmounts is
   * therefore refused as well.
   *
   * Both were wrong in a browser and right in happy-dom, which implements no part of `inert`:
   * nothing is ever refused there, so the panel's own version passed the app seam in both
   * directions. They are measured in a browser instead (`app/test/viewport.test.ts`).
   *
   * **One lender per surface that took the page**, because they nest: the console takes it
   * from the HUD's own Console button, a notification arriving over the console takes it from
   * whatever the player had reached inside the console, and giving one back is not giving the
   * other back. A single remembered element would hand the player `<body>` for every level but
   * the outermost. The stack is popped as far as the front surface has receded, and the focus
   * restored is the one the outermost of the surfaces that just went had borrowed — closing
   * the console closes the save list over it, and what the player had before both is what
   * they get back.
   *
   * **What it cannot give back, it hands to the surface in front.** A
   * surface arriving *over* an opaque one borrows from behind that opaque surface, and there
   * is nothing there to borrow: the console leaves the focus on the HUD button that opened it,
   * the browser blurs that button because the console's own marking now covers it, and a
   * notification arriving a moment later finds `<body>`. Where the element is still there it
   * is still marked, and `focus()` into a marked subtree is refused. Either way the shell has
   * nothing to give back and would leave the player on `<body>`, in front of a console it is
   * supposed to have chosen a landing place for.
   *
   * So the borrowed element is offered the focus and *asked whether it took it*, rather than
   * assumed to have taken it, and where it did not the focus goes to the first control the
   * surface now in front still offers (`focus.ts`). Only an opaque one is handed it: a modal
   * surface takes its own focus (`modal-surface.ts`), and with the map in front there is
   * nothing covering the player and nowhere they have to be put.
   */
  const shell = useRef<HTMLElement>(null);
  const modal = isModal(front);
  const lenders = useRef<Lender[]>([]);
  const previousFront = useRef<Surface>(front);
  const returning = useRef<Lender | null>(null);
  const came = depth(front) - depth(previousFront.current);

  if (came < 0 && takesWhatIsBehind(front)) {
    const active = shell.current?.ownerDocument.activeElement ?? null;
    const lent =
      active instanceof HTMLElement && active !== active.ownerDocument.body ? active : null;
    lenders.current.push({ surface: front, element: lent });
  } else if (came > 0) {
    while (depth(lenders.current.at(-1)?.surface ?? "map") < depth(front)) {
      returning.current = lenders.current.pop() ?? null;
    }
  }
  previousFront.current = front;

  useEffect(() => {
    const returned = returning.current;
    returning.current = null;
    if (returned === null) return;
    const borrowed = returned.element;
    if (borrowed !== null && borrowed.isConnected && !isOutOfReach(borrowed)) {
      borrowed.focus();
      if (borrowed.ownerDocument.activeElement === borrowed) return;
    }
    if (isOpaque(front)) focusFrontSurface(shell.current);
  });

  /**
   * The shell's keyboard: Escape is the front surface's, and the digits 0 to 4 are upstream's
   * speed hotkeys (`code/screens/map.py:518`).
   *
   * The digits reach the Speed only while the map is the surface in front of the player. A
   * surface drawn over it owns the keyboard the way upstream's dialogs do — two of them hold
   * a text field, and a digit typed into one is a digit.
   *
   * Escape closes the front surface and nothing behind it, which is what a player pressing it
   * twice means. The ending is the one surface it does not close: a lost game has nothing to
   * be dismissed into, and a won game is continued on purpose (`EndOfGame.tsx`).
   */
  useEffect(() => {
    const pressed = (event: KeyboardEvent) => {
      const front = current.current;
      if (event.key === "Escape") {
        if (front === "notification") onDismissNotification?.();
        // Back to the console they were opened from, which is what "closes back to it" means
        // for a surface that was drawn over another one.
        if (front === "licences") setSecondary(null);
        if (front === "console") setConsoleOpen(false);
        if (front === "research") setResearchOpen(false);
        if (front === "inspector") setInspectedLocationId(null);
        return;
      }
      if (front !== "map") return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      // The digits are single characters and the player may turn them off (WCAG 2.1.4,
      // `shortcuts.ts`). Escape is above this line because it is not one of them.
      if (!shortcutsOn.value) return;
      const chosen = SPEED_HOTKEYS.get(event.key);
      if (chosen !== undefined) speed.value = chosen;
    };
    window.addEventListener("keydown", pressed);
    return () => window.removeEventListener("keydown", pressed);
  }, [onDismissNotification, speed]);

  return (
    <main ref={shell} class={inspectedLocationId ? "shell shell--inspecting" : "shell"}>
      {/*
       * The map and the two surfaces that leave it visible — the inspector insets it, the
       * research sheet is a bottom sheet over it — as one group, because what happens to them
       * happens to all of them at once: `inert` takes them out of the pointer's reach, out of
       * the tab order and out of the accessibility tree in one attribute. The group
       * is `display: contents`, so it is a grouping and not a box.
       *
       * The console and the two surfaces it opens are groups of their own below, rather than
       * members of this one, because they are opaque and full height: each takes what it
       * covers, so what is marked while one of them is in front is everything *under* it and
       * not itself. The group is named by its own topmost member.
       */}
      <div class="shell-behind" inert={outOfReach(front, "research")}>
        <WorldMap
          state={state.value}
          onInspect={setInspectedLocationId}
          nightVisible={nightVisible}
          notifiedLocationId={
            activeNotification?.kind === "baseLostDiscovered" ||
            activeNotification?.kind === "baseLostMaintenance"
              ? activeNotification.locationId
              : null
          }
        />
        <Hud
          state={state.value}
          speed={speed.value}
          onSpeed={(chosen) => {
            speed.value = chosen;
          }}
          onOpenResearch={() => setResearchOpen(true)}
          onOpenConsole={() => setConsoleOpen(true)}
        />
        {inspectedLocationId && (
          <Inspector
            state={state.value}
            locationId={inspectedLocationId}
            onClose={() => setInspectedLocationId(null)}
            obscured={front !== "inspector"}
            {...(onCommand && { onCommand })}
          />
        )}
        {researchOpen && (
          <ResearchSheet
            state={state.value}
            onClose={() => setResearchOpen(false)}
            {...(onCommand && { onCommand })}
          />
        )}
      </div>
      {consoleOpen && (
        <div class="shell-behind" inert={outOfReach(front, "console")}>
          <Console
            state={state.value}
            onClose={() => {
              setConsoleOpen(false);
              // A surface opened from the console does not outlive it. The player cannot
              // reach Close from behind one any more — the console is out of reach under an
              // opaque surface — but the shell must still never be able to leave a
              // Back button with nothing behind it to go back to.
              setSecondary(null);
            }}
            nightVisible={nightVisible}
            onNightVisible={setNightVisible}
            {...(licences && { onLicences: () => setSecondary("licences") })}
          />
        </div>
      )}
      {/*
       * The one the console opens over itself. It is the same component the start screen
       * mounts — one licences document, two ways in — and it is drawn after the
       * console so it covers it whole. Being opaque, covering it whole is what puts it out of
       * reach.
       */}
      {licencesUp && licences && (
        <div class="shell-behind" inert={outOfReach(front, "licences")}>
          <Licences licences={licences} onClose={closeSecondary} />
        </div>
      )}
      {modal && <div class="shell-scrim" />}
      {/*
       * The notification is the topmost surface the shell can now have up, because the ending
       * holds the queue rather than being drawn over it. Its grouping and its
       * `obscured` are still read from the stack rather than written as `false`: what is in
       * front of a surface is the stack's answer, and the next surface added to it gets the
       * right one without touching this.
       */}
      {activeNotification && onDismissNotification && (
        <div class="shell-behind" inert={outOfReach(front, "notification")}>
          <Notification
            key={activeNotification}
            notification={activeNotification}
            onDismiss={onDismissNotification}
            obscured={front !== "notification"}
          />
        </div>
      )}
      {endingUp && ending && (
        <EndOfGame
          ending={ending}
          onDismiss={() => {
            dismissal.value = ending.sectionId;
          }}
          obscured={front !== "ending"}
          {...(onLeave && { onLeave })}
        />
      )}
      {/*
       * The band is outside all of that on purpose: it is subtracted from the shell rather
       * than drawn over, so no surface is ever in front of it and it is never
       * behind one. It is a readout with nothing to operate, so there is nothing there for a
       * modal surface to take.
       */}
      <ThreatBand state={state.value} />
    </main>
  );
}
