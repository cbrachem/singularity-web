import type { JSX } from "preact";

import type { SessionOrigin } from "../host/session.ts";
import { developmentFeatures, developmentOnly } from "./only.ts";
import "./DevelopmentBar.css";

developmentOnly("development bar");

/**
 * What the development entry point says about itself, on the page rather than only in the
 * console: where this state came from, whether the clock is frozen, whether the game is
 * autosaving, and which development-only affordances are loaded.
 *
 * The autosave is worth a word because a Scenario boot turns it off — a re-derived state is
 * not a game the player is keeping, and writing it over their autosave slot would lose their
 * game (`boot.tsx`). Without the word, "my dev session stopped saving" is a bug
 * report rather than a flag.
 *
 * It carries the one control the frozen clock needs — a frozen game shows a transition only
 * if something moves it — and that control is a real `<button>` with text: a driver says
 * "click Advance one game day", never a coordinate.
 */
export interface DevelopmentBarProps {
  readonly origin: SessionOrigin;
  readonly frozen: boolean;
  readonly autosaving: boolean;
  readonly onAdvanceDay: () => void;
}

export function DevelopmentBar({
  origin,
  frozen,
  autosaving,
  onAdvanceDay,
}: DevelopmentBarProps): JSX.Element {
  return (
    <aside class="development" aria-label="Development">
      <span class="development__origin">{describe(origin)}</span>
      <span class="development__clock">clock {frozen ? "frozen" : "running"}</span>
      <span class="development__autosave">autosave {autosaving ? "on" : "off"}</span>
      <button type="button" class="development__step" onClick={onAdvanceDay}>
        Advance one game day
      </button>
      <span class="development__features">{developmentFeatures().join(" · ")}</span>
    </aside>
  );
}

function describe(origin: SessionOrigin): string {
  switch (origin.kind) {
    case "scenario":
      return `Scenario ${origin.id}, ${origin.steps} steps replayed`;
    case "save":
      return "Resumed from a save";
    case "new":
      return "New game";
  }
}
