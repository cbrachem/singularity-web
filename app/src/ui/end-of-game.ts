import { WIN, lostGame, type SimulationState } from "@singularity/sim";

/**
 * How the game ended, read off the State root.
 *
 * # Why this is a state and not a moment
 *
 * Upstream asks the same question the same way: the map screen polls `g.pl.lost_game()` after
 * every tick and shows the matching story section (`code/screens/map.py:780`). The win is the
 * one that looks like a moment — the endgame tech pushes a story Effect on the tick that
 * finishes Apotheosis (`sim/src/gameevent.ts`) — and Presentation still reads it here, because
 * a moment is only visible to whoever was watching. A Save load and a Scenario boot both
 * arrive *after* the tick that won, with `apotheosis` set and the Effect long gone, and a
 * surface built on the Effect alone would show a won game that says nothing about it.
 *
 * The Effect keeps its job of asking for the Host's attention; what is on the screen is a pure
 * function of the published root, like everything else Presentation draws.
 *
 * The three sections are upstream's own strings, so the ends match the game they came from:
 * `"Win"` (`code/effect.py:65`) and `lost_story` (`code/screens/map.py:782`).
 */
export interface Ending {
  /** A won game goes on being played; a lost one is over. */
  readonly outcome: "won" | "lost";
  /** The story section in the Content, by upstream's id for it. */
  readonly sectionId: string;
}

/** `lost_story` (`code/screens/map.py:782`), indexed by what `lost_game` returns. */
const LOST_STORY = ["", "Lost No Bases", "Lost Suspicion"] as const;

export function endOfGame(state: SimulationState): Ending | null {
  if (state.apotheosis) return { outcome: "won", sectionId: WIN };
  const lost = lostGame(state);
  if (lost === 0) return null;
  const sectionId = LOST_STORY[lost];
  if (sectionId === undefined || sectionId === "") throw new Error(`unknown loss: ${lost}`);
  return { outcome: "lost", sectionId };
}
