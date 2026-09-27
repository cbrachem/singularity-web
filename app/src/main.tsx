import licences from "virtual:licences";

import { boot } from "./boot.tsx";
import { coldStart, type Begin } from "./cold-start.tsx";
import { createAutosave, type Autosave } from "./host/autosave.ts";
import { createSaveStore } from "./host/save-store.ts";
import type { Session } from "./host/session.ts";
import { browserVisibility } from "./host/visibility.ts";

/**
 * The page's entry point, and deliberately nothing more than the arguments the cold start
 * cannot be handed by a test: the real document, the browser storage a game is resumed from
 * and autosaved into, and — in development — the real query string.
 *
 * A module that runs on import cannot be entered by a test without being run, and running it
 * subscribes the real `requestAnimationFrame` for the rest of the process. So everything that
 * can be driven lives in `coldStart()`, `boot()` and the Host modules below, covered at the
 * app and host seams (`app/test/start-screen.test.tsx`, `app/test/boot.test.tsx`,
 * `app/test/autosave.test.ts`). What is left here is the two globals and the wiring between
 * them, and that is the deliberate exclusion.
 *
 * The page opens on the **start screen** rather than in a game. Nothing is resumed
 * before the player asks for it — Continue is offered only when the autosave slot reads, and
 * the read that answers that is the read the game comes out of.
 */
const store = createSaveStore(localStorage);

/**
 * Upstream draws the day of the year the clock is offset by at every load and persists none
 * (`player.py:134`), so choosing it is the Host's — as choosing the seed of a new game is.
 */
const startDay = Math.floor(Math.random() * 366);

/** Where a refusal goes as well as onto the start screen. */
const tell = (message: string): void => {
  console.warn(`[singularity] ${message}`);
};

const autosaveFor = (session: Session): Autosave =>
  createAutosave({
    snapshot: () => session.current,
    dismissedEnding: () => session.dismissedEnding.value,
    store,
    now: () => Date.now() / 1000,
    report: (outcome) => {
      if (!outcome.ok) tell(`the autosave was not written: ${outcome.reason}`);
    },
  });

/**
 * One game, started.
 *
 * The Speed the page starts at is not named here: it is upstream's `code/g.py:76` for a new
 * game and a stop for a resumed one (`savegame.py:414,509`), and the Host decides between
 * them from the Session's origin, which is the only place that knows which of the two this
 * is. Speed is the Host's and never Simulation state.
 */
const begin: Begin = (session, options = {}) =>
  boot({
    into: document,
    session,
    hidden: browserVisibility(document),
    ...(options.frames === undefined ? {} : { frames: options.frames }),
    ...(options.intro === undefined ? {} : { intro: options.intro }),
    ...(options.onLeave === undefined ? {} : { onLeave: options.onLeave }),
    ...(options.onRefusal === undefined ? {} : { onRefusal: options.onRefusal }),
    ...(options.licences === undefined ? {} : { licences: options.licences }),
    ...(options.autosaves === false ? {} : { autosave: autosaveFor(session) }),
  });

/**
 * In development the start screen offers the Scenarios as well, and a flag boots one straight
 * away with a clock that may be frozen. The development entry point wraps this one
 * rather than replacing it, so `bun run dev` is the shipped arrangement plus the affordances.
 *
 * That branch — and everything it reaches — must not be in the shipped bundle, which is what
 * the shape below buys: `import.meta.env.DEV` is folded to `false` at build time, so the
 * block is eliminated whole and the dynamic import inside it never becomes a chunk.
 * `bun run check:development-only` is the assertion that it did not, and CI runs it after the
 * build.
 */
if (import.meta.env.DEV) {
  const { developmentColdStart } = await import("./development/boot.tsx");
  developmentColdStart({
    into: document,
    store,
    startDay,
    licences,
    begin,
    report: tell,
    search: window.location.search,
  });
} else {
  coldStart({ into: document, store, startDay, licences, begin, report: tell });
}
