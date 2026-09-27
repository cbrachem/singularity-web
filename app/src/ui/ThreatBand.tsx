import type { SimulationState } from "@singularity/sim";
import type { JSX } from "preact";

import { DANGER_LEVELS, LEVEL_WORDS, threatReadout, type DangerLevel } from "./threat.ts";
import "./ThreatBand.css";

/**
 * The reserved band: the player's exposure, always on the screen.
 *
 * The shell spends a full-width strip along the bottom edge on this and forbids every other
 * surface from entering it — the inspector's bottom edge and every bottom sheet's stop at
 * it. It is the shell's one permanent cost, roughly 60px of map height whether or not
 * anything is open, and the trade is a readout that is never a click away. Upstream hides it
 * behind whichever screen the player happens to have open, which is worst at the moment it
 * matters most.
 *
 * # All eight, and no tab
 *
 * Four groups times two measures, side by side. "Eight values legible at a glance" and "four
 * of them behind a tab" cannot both be true, so there is no tab — and the band is what pays
 * for that, because a sheet cannot be raised on its left half only and the reservation is
 * therefore full-width whether or not it is used.
 *
 * # A ladder, not a bar
 *
 * Four steps of rising height, one per danger level, filled to the group's. Equal cells are
 * the vocabulary of a fill level, so they get read as a proportion — and that proportion
 * contradicts the number printed beside it: a group at 79% suspicion is already at the top
 * level, so the bar would read full against a label saying 80%. Rising steps read as "level 3
 * of 4" and do not offer themselves for that misreading.
 *
 * The geometry is identical at all three `display_discover` levels, because the ladder
 * encodes the level and nothing else — which is exactly what the word shown at `none`
 * already encodes. Only the text gains precision, and the cells it lands in are fixed-width,
 * sized for `Critical` rather than for `34.72%`, so nothing moves when Socioanalytics lands.
 *
 * Colour is never the only carrier: the level is in the ladder's height, in the
 * ladder's own accessible name, and — at `display_discover: none` — in the printed word.
 */
export interface ThreatBandProps {
  readonly state: SimulationState;
}

const MEASURES = { suspicion: "suspicion", detect: "detect rate" } as const;

export function ThreatBand({ state }: ThreatBandProps): JSX.Element {
  return (
    <section class="band" aria-label="Threat">
      {state.hadGrace ? <Grace /> : <Values state={state} />}
    </section>
  );
}

/**
 * The grace period, which is the one place this departs from upstream's answer rather than
 * from its layout.
 *
 * Upstream hides both bars entirely while `had_grace` is set (`screens/map.py:921`), and it
 * is right about the values: no group is watching, so there is nothing to report. It is
 * wrong about the band, because a band that arrives when the values do would resize the map
 * once, silently, at the moment the player first comes under observation. The band stays and
 * says so in words.
 *
 * The words are the player's, not the code's. An earlier version said "the eight values arrive
 * here when the grace period ends", which names two things only this repository knows — the
 * count of readouts in `threat.ts` and `hadGrace`. What a player is owed is what the space is
 * for, in the terms of the game they are playing.
 */
function Grace(): JSX.Element {
  return (
    <p class="band__grace">
      <span class="band__caps">Threat</span>
      <span class="band__sentence">
        No one is looking for you yet. When that changes, you will see who — and how close they are
        — here.
      </span>
    </p>
  );
}

function Values({ state }: { readonly state: SimulationState }): JSX.Element {
  const readout = threatReadout(state);

  return (
    <>
      <div class="band__set">
        <h2 class="band__caps">Suspicion</h2>
        {readout.map((group) => (
          <Cell
            key={group.id}
            name={group.name}
            measure={MEASURES.suspicion}
            level={group.suspicion.level}
            text={group.suspicion.text}
          />
        ))}
      </div>

      <div class="band__set">
        <h2 class="band__caps">Detect rate / day</h2>
        {readout.map((group) => (
          <Cell
            key={group.id}
            name={group.name}
            measure={MEASURES.detect}
            level={group.detect.level}
            text={group.detect.text}
          />
        ))}
      </div>
    </>
  );
}

/**
 * One group's one measure: its name, the value, and the ladder.
 *
 * `<output>` because that is what an element holding a computed value is, with the live
 * region it implies switched off — as in the HUD, and for the same reason: eight values that
 * move every tick would be read aloud continuously.
 */
function Cell({
  name,
  measure,
  level,
  text,
}: {
  readonly name: string;
  readonly measure: string;
  readonly level: DangerLevel;
  readonly text: string;
}): JSX.Element {
  return (
    <div class="band__cell" data-level={level}>
      <span class="band__name">{name}</span>
      <output class="band__value" aria-label={`${name} ${measure}`} aria-live="off">
        {text}
      </output>
      <Ladder level={level} label={`${name} ${measure} danger`} />
    </div>
  );
}

const STEPS = Array.from({ length: DANGER_LEVELS }, (_, step) => step);

function Ladder({
  level,
  label,
}: {
  readonly level: DangerLevel;
  readonly label: string;
}): JSX.Element {
  return (
    <span
      class="band__ladder"
      role="img"
      data-level={level}
      aria-label={`${label}: ${LEVEL_WORDS[level]}, level ${level + 1} of ${DANGER_LEVELS}`}
    >
      {STEPS.map((step) => (
        <span key={step} class="band__step" data-filled={String(step <= level)} />
      ))}
    </span>
  );
}
