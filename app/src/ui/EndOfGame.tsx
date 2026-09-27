import { content } from "@singularity/sim";
import type { JSX } from "preact";

import type { Ending } from "./end-of-game.ts";
import { useModalSurface } from "./modal-surface.ts";
import "./EndOfGame.css";

export interface EndOfGameProps {
  readonly ending: Ending;
  /** Called when a won game is dismissed, back into the game it goes on being. */
  readonly onDismiss: () => void;
  /**
   * Called when a lost game is left, for the start screen. Every way into a game on the page
   * hands one in, the deep-linked Scenario replay included (`development/boot.tsx`): the
   * panel is modal, so the control below is the only thing a lost game leaves reachable, and
   * a panel without it is a page with nothing on it to reach.
   */
  readonly onLeave?: () => void;
  /**
   * Whether another surface is in front of this one. The shell's answer rather than this
   * panel's assumption (`modal-surface.ts`); the ending is the top of the stack,
   * so today it is always `false`.
   */
  readonly obscured: boolean;
}

/**
 * The end of the game: the story section for the end that was reached, over everything except
 * the reserved band.
 *
 * Upstream shows the same text in a dialog and then treats the two ends differently — a won
 * game carries on being played (`code/effect.py:59` sets `apotheosis` and returns to the map),
 * a lost one leaves the map screen for good (`code/screens/map.py:785`). That difference is
 * the one control on this panel: a won game is dismissed back to its map, and a lost game is
 * left, because there is no game left underneath to dismiss it into.
 *
 * It says `aria-modal="true"` and now keeps the claim: the shell puts everything behind it out
 * of reach while it is up, and the panel takes focus and holds Tab inside itself.
 * The one key it does not answer is Escape — a lost game has nothing to be dismissed into, and
 * a won one is continued on purpose, by the control below.
 *
 * Where upstream leaves *to* is its main menu, and the port's is the start screen — the one
 * surface a game is started from. So the lost end offers that and nothing else: no
 * dismiss, because the clock behind the panel is stopped for good (`host/session.ts`) and a
 * map that cannot move is not a game to be dismissed into.
 */
export function EndOfGame({ ending, onDismiss, onLeave, obscured }: EndOfGameProps): JSX.Element {
  const section = content.story.byId.get(ending.sectionId);
  if (!section) throw new Error(`no such story section: ${ending.sectionId}`);
  const panel = useModalSurface(obscured);

  return (
    <section
      ref={panel}
      tabIndex={-1}
      class="end-of-game"
      role="alertdialog"
      aria-label="End of game"
      aria-modal="true"
      data-outcome={ending.outcome}
    >
      <h2 class="end-of-game__title">{ending.outcome === "won" ? "Apotheosis" : "Game over"}</h2>
      {section.parts.map((part, at) => (
        <p key={at} class="end-of-game__part">
          {part.text}
        </p>
      ))}
      {ending.outcome === "won" && (
        <button type="button" class="end-of-game__act" onClick={onDismiss}>
          Continue
        </button>
      )}
      {ending.outcome === "lost" && onLeave && (
        <button type="button" class="end-of-game__act" onClick={onLeave}>
          Back to the start screen
        </button>
      )}
    </section>
  );
}
