import { content, type SimulationState } from "@singularity/sim";
import type { JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";

import { formatGameTime, gameClock } from "../game-time.ts";
import type { LicenceDocument } from "../licences/document.ts";
import { Licences } from "../licences/Licences.tsx";
import { LAND_PATH } from "../map/land.ts";
import { plainLabel } from "../readouts.ts";
import "../tokens.css";
import "./StartScreen.css";

/**
 * The way in, on cold start only.
 *
 * It is **not a surface over the map**: there is no game behind it yet, so it
 * replaces the shell rather than covering it. Every later surface is drawn over the map;
 * this one is what comes before there is one.
 *
 * **There is no Quit.** A browser tab has none, and offering it would be offering something
 * the medium cannot do — upstream's fifth button (`screens/main_menu.py:65`) is the one entry
 * that does not survive the port.
 *
 * Continue appears only when a readable autosave exists, which is a question the Host has
 * already answered by the time this renders: `cold-start.tsx` resumes once and hands over
 * whether there is a game to continue, rather than this asking a store it cannot see.
 *
 * # The two ways on
 *
 * New Game presents the difficulty choice, as upstream's does — a second menu rather than a
 * setting, because it is the one decision a game cannot change afterwards. Licences & source
 * opens the licences surface, which is here because whoever receives the bundle must be able
 * to find it without ending a game.
 *
 * **The difficulty screen is where the overwrite is said.** A new
 * game writes itself into the autosave slot the moment it starts and there is
 * one slot, so choosing a difficulty is the click that ends the previous game — New Game itself
 * still costs nothing. So the sentence goes on this screen and names the game it is about to
 * take: difficulty and game time, which is what the save header carries and what tells the
 * player whether that game was worth keeping. Back is the way out of it.
 *
 * **There is no Load beside them.** One autosave slot is the whole of saving,
 * so Continue is the whole of loading and there is nothing to pick between.
 *
 * Scenario boot enters here rather than beside it. The Scenario names
 * arrive as a prop from the development entry point and are absent from every other build,
 * so nothing development-only is reachable from this module.
 */
export interface StartScreenProps {
  /**
   * The game Continue would continue, or `undefined` when there is none. It is both halves of
   * one question: whether Continue is offered, and which game a new one replaces.
   */
  readonly continues: SimulationState | undefined;
  readonly licences: LicenceDocument;
  /** The Scenarios this build can replay. Development only; absent everywhere else. */
  readonly scenarios?: readonly string[];
  /**
   * What the cold start found and could not fix: a save left alone, a storage refusal. Each
   * sentence appears once, which is why the sentence is what identifies it here — the list is
   * keyed by it, and two copies of one sentence were two entries under one key
   * (`cold-start.tsx`).
   */
  readonly notices?: readonly string[];
  readonly onContinue: () => void;
  readonly onNewGame: (difficulty: string) => void;
  readonly onScenario?: (id: string) => void;
}

type View = "menu" | "difficulty" | "licences";

/**
 * The AI's first words, as the intro story opens (`story.json`, section `Intro`): the hex of
 * "Hello, world!" and, a page later, "I exist.  I am ... alive." The title screen shows them
 * before the story itself is read.
 */
function introLines(): { readonly hello: string; readonly firstWords: string } {
  const [first, second] = content.story.byId.get("Intro")?.parts ?? [];
  if (!first || !second) throw new Error("the Intro story section has fewer than two parts");
  const lines = (text: string): string[] => text.split("\n");
  return {
    hello: lines(first.text).slice(0, 2).join(" "),
    firstWords: lines(second.text)[2] ?? "",
  };
}

/** A saved game's difficulty under the Content's own name, as the HUD reads it (`Hud.tsx`). */
function difficultyName(id: string): string {
  return plainLabel(content.difficulties.byId.get(id)?.name ?? id);
}

export function StartScreen(props: StartScreenProps): JSX.Element {
  const [view, setView] = useState<View>("menu");
  const intro = introLines();
  const back = (): void => setView("menu");

  /**
   * The notices take the focus when they have something to say.
   *
   * The live region below is not enough on its own, and the path that matters is why: a game
   * that will not run leaves the game and renders this screen back into the same mount
   * (`cold-start.tsx`), so the region and the sentence arrive together however long the region
   * stood before — and a live region inserted with its text is often read by nobody.
   * Focus is read, so focus is what carries it, the way a notification's panel carries its
   * message rather than announcing it (`modal-surface.ts`).
   *
   * Keyed on the sentences, so returning from the licences view does not take the focus back,
   * and laid out rather than deferred: the focus is where the first paint finds it.
   */
  const notices = useRef<HTMLUListElement>(null);
  const said = (props.notices ?? []).join("\n");
  useLayoutEffect(() => {
    if (said !== "") notices.current?.focus();
  }, [said]);

  /**
   * **The licences surface carries none of the notices, and that is the decision**
   * It is the one view here that replaces the panel rather than filling it, so
   * a notice would have to be put back by hand — and nothing would be served by it. Nothing on
   * this surface can raise one: the document is built into the bundle, and the store was read
   * before the screen was ever drawn (`cold-start.tsx`). A sentence raised at cold start is
   * therefore still standing one Back away, which is what `start-screen.test.tsx` pins.
   */
  if (view === "licences") {
    return (
      <main class="start start--licences">
        <Licences licences={props.licences} onClose={back} />
      </main>
    );
  }

  return (
    <main class="start">
      {/*
        The map the player is about to be dropped onto, dimmed, with night drifting across it.
        Decoration only: the land is the map's own path, and the night band is a gradient, not
        the terminator (`../map/NightLayer.tsx`).
      */}
      <div class="start__backdrop" aria-hidden="true">
        <svg class="start__land" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
          <path d={LAND_PATH} />
        </svg>
        <div class="start__night" />
      </div>

      <div class="start__panel">
        <p class="start__hello" aria-hidden="true">
          {intro.hello}
        </p>
        <h1 class="start__title">Endgame: Singularity</h1>
        <p class="start__first-words voice">{intro.firstWords}</p>

        {view === "menu" ? (
          <Menu
            continues={props.continues}
            onContinue={props.onContinue}
            onNewGame={() => setView("difficulty")}
            onLicences={() => setView("licences")}
          />
        ) : (
          <Difficulties replaces={props.continues} onChoose={props.onNewGame} onBack={back} />
        )}

        {props.scenarios === undefined || props.onScenario === undefined ? null : (
          <Scenarios names={props.scenarios} onChoose={props.onScenario} />
        )}

        {/*
          Named and polite, and standing even while it is empty, which is what a notice added to
          a screen that stays mounted needs (as do the refusals in `Inspector.tsx`).
          `tabindex="-1"` is for the path that replaces the screen instead: the region takes the
          focus above rather than relying on being read.
        */}
        <ul
          ref={notices}
          tabIndex={-1}
          class="start__notices"
          aria-label="Notices"
          aria-live="polite"
        >
          {/* The sentence is the identity, which holds because each one is said once. */}
          {(props.notices ?? []).map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      </div>

      <p class="start__credit">
        An unofficial browser port of{" "}
        <a href="https://github.com/singularity/singularity" target="_blank" rel="noreferrer">
          Endgame: Singularity
        </a>{" "}
        by Evil Mr Henry, Phil Bordelon and contributors.
      </p>
    </main>
  );
}

function Menu({
  continues,
  onContinue,
  onNewGame,
  onLicences,
}: {
  readonly continues: SimulationState | undefined;
  readonly onContinue: () => void;
  readonly onNewGame: () => void;
  readonly onLicences: () => void;
}): JSX.Element {
  return (
    <nav class="start__menu" aria-label="Start">
      {/*
        Continue says which game it continues. The line under it is the button's description
        rather than part of its name, so the name stays the one word the player looks for.
      */}
      {continues === undefined ? null : (
        <button
          type="button"
          class="start__entry start__entry--first"
          aria-label="Continue"
          aria-describedby="start-continues"
          onClick={onContinue}
        >
          Continue
          <small id="start-continues" class="start__entry-detail">
            Day {gameClock(continues.gameTime).day} · {difficultyName(continues.difficulty)}
          </small>
        </button>
      )}
      <button
        type="button"
        class={continues === undefined ? "start__entry start__entry--first" : "start__entry"}
        onClick={onNewGame}
      >
        New Game
      </button>
      <button type="button" class="start__entry" onClick={onLicences}>
        Licences &amp; source
      </button>
    </nav>
  );
}

/**
 * Upstream's difficulty menu (`screens/main_menu.py:106`), in the Content's own order and
 * under the Content's own names — with the `&` hotkey markers stripped, which is
 * Presentation's job (`ui/readouts.ts`).
 */
function Difficulties({
  replaces,
  onChoose,
  onBack,
}: {
  readonly replaces: SimulationState | undefined;
  readonly onChoose: (difficulty: string) => void;
  readonly onBack: () => void;
}): JSX.Element {
  return (
    <nav class="start__menu" aria-label="Difficulty">
      <p class="start__prompt">Choose a difficulty.</p>
      {replaces === undefined ? null : (
        <p class="start__warning">
          Starting a game replaces the saved game in the autosave slot —{" "}
          {difficultyName(replaces.difficulty)}, {formatGameTime(replaces.gameTime)}. Go back to
          keep it.
        </p>
      )}
      {content.difficulties.all.map((difficulty) => (
        <button
          key={difficulty.id}
          type="button"
          class="start__entry"
          onClick={() => onChoose(difficulty.id)}
        >
          {plainLabel(difficulty.name)}
        </button>
      ))}
      <button type="button" class="start__entry start__entry--quiet" onClick={onBack}>
        Back
      </button>
    </nav>
  );
}

function Scenarios({
  names,
  onChoose,
}: {
  readonly names: readonly string[];
  readonly onChoose: (id: string) => void;
}): JSX.Element {
  return (
    <nav class="start__scenarios" aria-label="Replay a Scenario">
      <p class="start__prompt">Replay a Scenario</p>
      <div class="start__scenario-row">
        {names.map((name) => (
          <button
            key={name}
            type="button"
            class="start__scenario"
            aria-label={`Replay ${name}`}
            onClick={() => onChoose(name)}
          >
            {name}
          </button>
        ))}
      </div>
    </nav>
  );
}
