import type { JSX } from "preact";

import { SPEEDS, type Speed } from "../host/tick-partition.ts";
import { Hotkey } from "./Hotkey.tsx";
import { shortcutKey, shortcutsOn } from "./shortcuts.ts";
import { speedLabel } from "./readouts.ts";
import "./SpeedControl.css";

/**
 * The five Speed settings, offered to the player.
 *
 * Upstream puts them on the map screen as five buttons carrying a pause bar and one to four
 * play arrows, with the digits 0 to 4 as their hotkeys (`code/screens/map.py:507-533`), and
 * the row belongs with the map here for the same reason: the map is the application and the
 * clock is the thing the player is watching it against.
 *
 * # Why the marks are decoration and the name is a word
 *
 * A driver has to be able to say which setting it wants, and `▶▶▶` is not something to say.
 * So each button carries the glyphs `aria-hidden` and an `aria-label` naming the setting the
 * way the readout beside it does — `Pause`, `Speed 60x` — which is stable whatever the row
 * looks like.
 *
 * They are toggle buttons rather than a radio group: upstream's are `ToggleButton`s, one of
 * them is on at a time, and `aria-pressed` says which without claiming the row is a form
 * control the player submits.
 */
export interface SpeedControlProps {
  readonly speed: Speed;
  readonly onSpeed: (speed: Speed) => void;
}

/** Upstream's own glyphs: the pause bar, and one arrow per step up the scale. */
const MARKS: Readonly<Record<Speed, string>> = Object.freeze({
  0: "▮▮",
  1: "▶",
  60: "▶▶",
  7200: "▶▶▶",
  432000: "▶▶▶▶",
});

/**
 * The Speed a digit stands for: upstream's hotkeys, which are the settings' own indices
 * (`code/screens/map.py:518`). The row is operable by Tab and Enter because it is made of
 * real buttons; this is the shortcut a player who is watching the clock actually uses.
 */
export const SPEED_HOTKEYS: ReadonlyMap<string, Speed> = new Map(
  SPEEDS.map((speed, index) => [String(index), speed] as const),
);

/** What a driver, and a screen reader, calls one setting. */
export function speedName(speed: Speed): string {
  return speed === 0 ? "Pause" : `Speed ${speedLabel(speed)}`;
}

export function SpeedControl({ speed, onSpeed }: SpeedControlProps): JSX.Element {
  return (
    <div class="speeds" role="group" aria-label="Speed setting">
      {SPEEDS.map((setting, index) => (
        <button
          key={setting}
          type="button"
          class="speeds__button"
          aria-label={speedName(setting)}
          aria-pressed={setting === speed}
          {...shortcutKey(String(index))}
          title={shortcutsOn.value ? `${speedName(setting)} (${index})` : speedName(setting)}
          onClick={() => onSpeed(setting)}
        >
          <span aria-hidden="true">{MARKS[setting]}</span>
          {/*
            The digit under the mark, because a `title` is a tooltip: it needs a mouse, it
            needs a wait, and it does not exist at all on a touch screen. These five were the
            only shortcuts in the shell written anywhere near the control they operate, and
            even there only to whoever hovered long enough to find out.
          */}
          <Hotkey of={String(index)} />
        </button>
      ))}
    </div>
  );
}
