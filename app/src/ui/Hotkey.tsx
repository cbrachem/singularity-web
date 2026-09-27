import type { JSX } from "preact";

import { shortcutsOn } from "./shortcuts.ts";
import "./Hotkey.css";

/**
 * The key a control answers to, printed on the control.
 *
 * The shell had seven shortcuts and told the player about two of them. `0`–`4` and Escape were
 * written in the console's Settings tab — three clicks away from the map they operate — and the
 * five the estate answers to (`ESTATE_HOTKEYS`) were written nowhere at all: no label, no
 * tooltip, no attribute. A shortcut nobody can find is not a shortcut, and two of those five
 * change what the player owns.
 *
 * So the key is on the control, where it is needed, and the control carries `aria-keyshortcuts`
 * as well — the mark is for whoever is looking at the button, the attribute is for whoever is
 * being told about it. Both sides name the same constant at the call site, so they cannot
 * disagree about which key it is, and `app/test/hotkeys.test.tsx` holds every shortcut the
 * shell has to a control that prints it.
 *
 * The mark is decoration for assistive technology and is hidden from it: every control that
 * carries one already has an `aria-label` naming the action, and `aria-keyshortcuts` says the
 * key in the form a screen reader is built to announce.
 */
export interface HotkeyProps {
  /** The key itself, as `ESTATE_HOTKEYS` and `SPEED_HOTKEYS` spell it. */
  readonly of: string;
}

export function Hotkey({ of }: HotkeyProps): JSX.Element | null {
  // Nothing is printed while the keys are off (`shortcuts.ts`): a mark on a control that no
  // longer answers to it is the shell telling the player something untrue.
  if (!shortcutsOn.value) return null;
  return (
    <kbd class="hotkey" aria-hidden="true">
      {hotkeyMark(of)}
    </kbd>
  );
}

/**
 * How a key is printed. A letter is shown as a capital because that is how a keyboard is
 * labelled, and `Escape` as `Esc` because the cell it sits in is the width of a word.
 */
export function hotkeyMark(key: string): string {
  if (key === "Escape") return "Esc";
  return key.length === 1 ? key.toUpperCase() : key;
}
