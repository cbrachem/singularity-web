import type { JSX } from "preact";

import type { LicenceDocument } from "./document.ts";
import "./Licences.css";

/**
 * Licences and source: what the bundle carries, who it belongs to, and where the source of
 * *this* bundle is.
 *
 * It is its own surface, reachable from the start screen, because whoever receives the bundle
 * must be able to find it without ending a game. Nothing on it is written here:
 * every word is `NOTICE`, generated into `virtual:licences` while the bundle is built and
 * stamped with the commit that build was made from (`app/scripts/licences.ts`). A page that
 * drifts from what it describes is worse than none, so there is nothing to drift — and a
 * licence line written into this directory by hand fails the build.
 *
 * The sections are reproduced verbatim, in a monospaced block, because that is what a notice
 * is: a text whose exact words are the point. The one thing rendered rather than reproduced
 * is a link, and the one link that matters is the source link — GPL-2.0 §3 asks for the
 * source of what was *served*, so it resolves to a commit and never to a branch.
 */
export interface LicencesProps {
  readonly licences: LicenceDocument;
  readonly onClose: () => void;
}

export function Licences({ licences, onClose }: LicencesProps): JSX.Element {
  return (
    <section
      class="licences"
      aria-label="Licences and source"
      data-bottom="reserved-band"
      data-opaque="true"
    >
      <header class="licences__head">
        <h2 class="licences__title">Licences &amp; source</h2>
        <button type="button" class="licences__back" onClick={onClose}>
          Back
        </button>
      </header>

      <dl class="licences__stamp">
        <dt>Built from commit</dt>
        <dd>
          <code>{licences.commit}</code>
          {licences.dirty ? " with uncommitted changes" : ""}
        </dd>
        <dt>Corresponding source</dt>
        <dd>
          {licences.source === undefined ? (
            "Not published. The corresponding source is this repository at the commit above."
          ) : (
            <a href={licences.source} rel="noreferrer">
              {licences.source}
            </a>
          )}
        </dd>
      </dl>

      <div class="licences__body">
        <p class="licences__preamble">{licences.preamble}</p>
        {licences.sections.map((section) => (
          <section key={section.title} class="licences__section">
            <h3 class="licences__heading">{section.title}</h3>
            <pre class="licences__text">{linked(section.body)}</pre>
          </section>
        ))}
      </div>
    </section>
  );
}

const A_URL = /https?:\/\/[^\s<>()"']*[^\s<>()"'.,;:]/g;

/** The text, with every bare URL in it made a link and nothing else touched. */
function linked(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  let at = 0;
  for (const match of text.matchAll(A_URL)) {
    const url = match[0];
    if (match.index > at) parts.push(text.slice(at, match.index));
    parts.push(
      <a key={`${match.index}`} href={url} rel="noreferrer">
        {url}
      </a>,
    );
    at = match.index + url.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}
