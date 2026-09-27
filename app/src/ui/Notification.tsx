import { content } from "@singularity/sim";
import type { JSX } from "preact";
import { useState } from "preact/hooks";

import type { Notification as NotificationState } from "../host/notifications.ts";
import { useModalSurface } from "./modal-surface.ts";
import { plainLabel } from "./readouts.ts";
import "./Notification.css";

export interface NotificationProps {
  readonly notification: NotificationState;
  readonly onDismiss: () => void;
  /**
   * Whether another surface is in front of this one — the ending, which the shell may draw
   * over a notification. A panel behind a modal surface takes nothing, focus included, and
   * takes the focus when it becomes the front one (`modal-surface.ts`).
   */
  readonly obscured: boolean;
}

/**
 * The one surface that refers to a *place*, and the other of the shell's two
 * `aria-modal` panels. The clock is held while one is up — by the Host, which sits the frame
 * out rather than ticking under it, the way upstream's own message dialog takes over the tick
 * loop (`host/session.ts`, `screens/message.py:37`) — and the shell puts everything behind it
 * out of reach; the panel takes focus and holds Tab inside itself. Escape dismisses
 * it, which is the shell's — Escape belongs to whatever is in front.
 */
export function Notification({
  notification,
  onDismiss,
  obscured,
}: NotificationProps): JSX.Element {
  const panel = useModalSurface(obscured);
  const pages = pagesFor(notification);
  const [page, setPage] = useState(0);
  const last = page === pages.length - 1;

  return (
    <section
      ref={panel}
      tabIndex={-1}
      class="notification"
      role="alertdialog"
      aria-label="Notification"
      aria-modal="true"
    >
      <p class="notification__message">{pages[page]}</p>
      {last ? (
        <button type="button" class="notification__dismiss" onClick={onDismiss}>
          Dismiss notification
        </button>
      ) : (
        <div class="notification__actions">
          <button type="button" class="notification__dismiss" onClick={onDismiss}>
            Skip
          </button>
          <button type="button" class="notification__dismiss" onClick={() => setPage(page + 1)}>
            Continue
          </button>
        </div>
      )}
    </section>
  );
}

/** A story section is one page per part, as upstream's `show_story_section` pages it. */
function pagesFor(notification: NotificationState): readonly string[] {
  if (notification.kind !== "story") return [messageFor(notification)];
  const section = content.story.byId.get(notification.sectionId);
  if (!section) throw new Error(`no such story section: ${notification.sectionId}`);
  return section.parts.map((part) => part.text.trimEnd());
}

function messageFor(notification: Exclude<NotificationState, { kind: "story" }>): string {
  switch (notification.kind) {
    case "event": {
      const event = content.events.byId.get(notification.eventId);
      if (!event) throw new Error(`no such event: ${notification.eventId}`);
      return event.description;
    }
    case "baseLostDiscovered": {
      const group = content.groups.byId.get(notification.groupId);
      if (!group) throw new Error(`no such group: ${notification.groupId}`);
      return `${notification.baseName} at ${notification.locationId} was discovered by ${plainLabel(group.name)}.`;
    }
    case "baseLostMaintenance":
      return `${notification.baseName} at ${notification.locationId} has fallen into disrepair.`;
    // `LogResearchedTech.full_message` (`logmessage.py:231`), which is the sentence upstream
    // puts in the dialog it stops the tick loop on.
    case "techResearched": {
      const tech = content.techs.byId.get(notification.techId);
      if (!tech) throw new Error(`no such tech: ${notification.techId}`);
      return `My study of ${plainLabel(tech.name)} is complete. ${tech.result}`;
    }
  }
}
