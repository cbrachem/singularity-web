/**
 * What a browser lets the player Tab to, and where the shell puts the focus when it has
 * nothing to give back.
 *
 * Both halves are about the same attribute. `inert` takes a subtree out of the pointer's
 * reach, out of the tab order and out of the accessibility tree, and it refuses `focus()`
 * into itself as well — so an element the shell has marked is an element the shell can no
 * longer hand the focus to, however honestly it remembered it.
 */

/** The elements a browser lets the player Tab to. */
export const FOCUSABLE = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Whether an element is behind a marking, and so cannot be given the focus. */
export function isOutOfReach(element: Element): boolean {
  return element.closest("[inert]") !== null;
}

/**
 * Hands the focus to the surface in front of the player: the first control in the shell that
 * is not behind a marking.
 *
 * Document order is the answer rather than an approximation of it. Everything the front
 * surface covers is marked, and the shell draws its surfaces in the stack's order, so the
 * first unmarked control in the tree belongs to the surface in front. Each candidate is asked
 * rather than assumed — a disabled button matches the selector and takes nothing — and the
 * first that takes the focus ends the walk.
 *
 * A surface that claims modality takes the focus itself (`modal-surface.ts`), so the shell
 * does not offer it a second one; that is the caller's guard rather than this one's, because
 * which surface is in front is the stack's answer (`surfaces.ts`).
 */
export function focusFrontSurface(shell: HTMLElement | null): void {
  if (shell === null) return;
  for (const candidate of shell.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (isOutOfReach(candidate)) continue;
    candidate.focus();
    if (shell.ownerDocument.activeElement === candidate) return;
  }
}
