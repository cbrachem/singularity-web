import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";

import { FOCUSABLE } from "./focus.ts";

/**
 * The focus half of modality: a surface that says `aria-modal="true"` takes focus
 * when it opens, keeps Tab inside itself, and gives focus back to whatever had it when it
 * closes. Without this a screen reader user is told a modal opened and is left outside it.
 *
 * # Giving it back is the shell's, not this panel's
 *
 * This hook took the focus and gave it back, and the second half was wrong in a browser. A
 * panel is inside the same `inert` grouping the shell marks, and the shell drops that marking
 * *after* the panel is gone rather than in the same breath: measured in Chromium, the panel's
 * unmount runs while the grouping still carries `inert`, and `focus()` on an element inside
 * an inert subtree is refused — so the player got `<body>`. Reading `activeElement` at mount
 * was wrong for a weaker reason that decides the same thing: it is a race. The same page,
 * twice, handed this Effect `<body>` once and the player's own button once.
 *
 * Both halves therefore belong to the shell, which is the thing that owns the marking and can
 * order the two (`App.tsx`). No test environment in the repository could have found
 * either: happy-dom implements no part of `inert`, so nothing is ever blurred, nothing is ever
 * refused, and doing it here looked right. It is measured in a browser instead
 * (`app/test/viewport.test.ts`).
 *
 * Focus lands on the panel rather than on its first control, because these panels are a
 * message first — the ending's story section, a notification's line — and the control is what
 * comes after it. The panel carries `tabindex="-1"` so it can hold focus without entering the
 * page's tab order.
 *
 * The ring the trap cycles is the panel and then everything focusable inside it, so a panel
 * whose whole content is a message still has somewhere for Tab to go. The listener is
 * attached to the element rather than written as `onKeyDown`, because a `<section>` is not an
 * operable element and the operable source rule rightly refuses a handler on one.
 *
 * A panel drawn behind another modal surface is inert and takes nothing, focus included —
 * the front surface is the one that owns the keyboard, and there is only ever one. Whether
 * this panel is that one is the shell's answer and is handed in, the way the inspector is
 * handed `obscured`: reading the DOM once at mount would leave a panel that mounted
 * behind another one behind forever — told a modal opened, and left outside it, which is the
 * defect this hook was written for. The one case that produced it is gone, because the ending
 * holds the notification queue rather than being drawn over it, and the answer is
 * still handed in rather than assumed: what is in front of a surface belongs to the stack.
 */
export function useModalSurface(obscured: boolean): RefObject<HTMLElement> {
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const element = panel.current;
    if (!element || obscured) return;

    element.focus();

    const trap = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return;
      event.preventDefault();
      const ring = [element, ...element.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const at = ring.indexOf(element.ownerDocument.activeElement as HTMLElement);
      const step = event.shiftKey ? -1 : 1;
      ring[(at + step + ring.length) % ring.length]?.focus();
    };
    element.addEventListener("keydown", trap);

    return () => element.removeEventListener("keydown", trap);
  }, [obscured]);

  return panel;
}
