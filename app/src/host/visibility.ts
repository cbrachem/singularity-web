/**
 * The moment the player clicks away, as something the Host can subscribe to.
 *
 * Injected rather than reached for, like the frame source next door: it is the second browser
 * API the Host names, and keeping it behind an interface is what lets the autosave flush be
 * tested without a tab to hide.
 */

export interface HiddenSource {
  /** Calls back every time the page becomes hidden. Returns an unsubscribe. */
  onHidden(listener: () => void): () => void;
}

export function browserVisibility(target: Document): HiddenSource {
  return {
    onHidden(listener) {
      const handler = (): void => {
        if (target.visibilityState === "hidden") listener();
      };
      target.addEventListener("visibilitychange", handler);
      return () => target.removeEventListener("visibilitychange", handler);
    },
  };
}
