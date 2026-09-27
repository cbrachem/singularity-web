import { signal } from "@preact/signals";

/** The preference's own key, beside the saves and never inside one — see `setShortcutsOn`. */
const PREFERENCE_KEY = "singularity.shortcuts";

/**
 * The stored choice, defaulting to on. A store that refuses to be read at all — a blocked
 * third-party frame, site data denied — must not take the shell down with it, so it reads as
 * "never touched".
 */
function storedPreference(): boolean {
  try {
    return localStorage.getItem(PREFERENCE_KEY) !== "off";
  } catch {
    return true;
  }
}

/**
 * Whether the shell's single-character shortcuts answer at all.
 *
 * WCAG 2.1.4 is about keys like these: a shortcut made of one letter, digit or punctuation
 * mark and no modifier fires under speech input and under a tremor, in a shell where two of
 * them destroy what the player owns. The criterion is met by a modifier, a remap or an off
 * switch, and the off switch is the one that costs the game nothing — upstream's keyboard is
 * `0`–`4` and single letters (`code/screens/map.py:518`), and a modifier would be a different
 * keyboard from the one the reference documents. It sits in the console's Settings
 * tab, beside the list of the keys it governs (`Console.tsx`).
 *
 * **Escape is not one of them.** The criterion covers letter, number, punctuation and symbol
 * characters; a named key is out of its scope, and Escape is the one way out of every surface
 * the shell draws. It keeps working with the shortcuts off.
 *
 * It is a module signal rather than shell state threaded down, because every reader of it is a
 * leaf: five estate controls, five speed buttons, two keyboard listeners and one checkbox, in
 * four components that otherwise share no prop. Threading a preference through `Hud` and three
 * inspector sub-components to reach them would be more plumbing than the preference is. It is
 * Presentation's own state and never Simulation state: nothing here is a Command, nothing here
 * reaches a State root, and no Trace can see it.
 */
export const shortcutsOn = signal(storedPreference());

/**
 * Turns the keys on or off **and writes the choice down**. A player who needs the
 * single-character keys off needs them off every session, and the switch was a module signal
 * nothing remembered.
 *
 * It lives in one key of its own beside the saves, never inside one. It is a per-viewer
 * convenience and never game state: a preference in the save document would ride the save's
 * version rule — a format change retires every player's autosave and would take
 * their accessibility setting with it — and it could only be written by writing the save,
 * which a Scenario boot must not do in either direction.
 */
export function setShortcutsOn(on: boolean): void {
  shortcutsOn.value = on;
  try {
    localStorage.setItem(PREFERENCE_KEY, on ? "on" : "off");
  } catch {
    // A full or blocked store forgets the preference; it does not refuse the click.
  }
}

/**
 * The `aria-keyshortcuts` a control carries — nothing at all while the keys are off, because
 * an attribute naming a key that does nothing tells a screen reader to press it.
 */
export function shortcutKey(key: string): { readonly "aria-keyshortcuts"?: string } {
  return shortcutsOn.value ? { "aria-keyshortcuts": key } : {};
}
