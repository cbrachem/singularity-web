import { finishedTechs, type LocationState, type SimulationState } from "@singularity/sim";
import type { JSX } from "preact";

import { plainLabel } from "../readouts.ts";
import { NightLayer } from "./NightLayer.tsx";
import { OFF_WORLD_LOCATIONS, ON_GLOBE_LOCATIONS, gridPosition, isUnlocked } from "./geometry.ts";
import { LAND_PATH } from "./land.ts";
import "./WorldMap.css";

/**
 * The globe: land, graticule, terminator, and the twelve places the game happens in.
 *
 * DOM and inline SVG rather than canvas, decided by measurement in both
 * directions — canvas was slower, because the land never changes and only the terminator
 * moves, and it would mean rebuilding focus, hit-testing and accessible names for the pins by
 * hand. Here the pins are real `<button>` elements and all of that is the platform's.
 *
 * Everything is placed in one co-ordinate system: the 0-100 equirectangular grid the
 * Content's own positions are written in (`./geometry.ts`). The land path is in it, the pins
 * are in it, and the SVG is stretched to the globe's 2:1 box rather than fitted to it, so the
 * two can never drift apart.
 */
export interface WorldMapProps {
  readonly state: SimulationState;
  readonly onInspect: (locationId: string) => void;
  readonly nightVisible?: boolean;
  readonly notifiedLocationId?: string | null;
}

export function WorldMap({
  state,
  onInspect,
  nightVisible = true,
  notifiedLocationId = null,
}: WorldMapProps): JSX.Element {
  const finished = finishedTechs(state.techs);
  const basesAt = countBases(state.locations);

  return (
    <section class="map" aria-label="World map">
      <div class="map__stage">
        {/*
         * The three extraterrestrial locations sit off the globe, as a row of chips above
         * it. The row is a band of the stage rather than a
         * layer over it: on a viewport wider than 2:1 the globe fills the stage height, and
         * a floating row would sit on the globe it is meant to be above.
         *
         * A chip appears when its prerequisite tech lands and is not there before, which
         * reverses epic story 7: played, a locked chip reads as clutter rather than as a
         * goal. The band keeps its height while it is empty, so the globe is
         * not resized by the first chip.
         */}
        <ul class="map__offworld">
          {OFF_WORLD_LOCATIONS.filter((location) => isUnlocked(location, finished)).map(
            (location) => (
              <li key={location.id}>
                <button
                  type="button"
                  class="map__chip"
                  aria-label={plainLabel(location.name)}
                  onClick={() => onInspect(location.id)}
                >
                  {plainLabel(location.name)}
                </button>
              </li>
            ),
          )}
        </ul>

        <div class="map__globe-area">
          <div class="map__globe">
            <svg
              class="map__land"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden="true"
              focusable="false"
            >
              <path d={LAND_PATH} />
            </svg>
            <div class="map__graticule" aria-hidden="true" />
            {nightVisible && <NightLayer gameTime={state.gameTime} startDay={state.startDay} />}

            {/*
             * A location the player cannot reach yet is not on the globe at all, and appears
             * where its position puts it when its tech lands. Every pin is
             * placed absolutely by that position, so an arrival moves no pin already there.
             */}
            {ON_GLOBE_LOCATIONS.filter((location) => isUnlocked(location, finished)).map(
              (location) => {
                const { x, y } = gridPosition(location);
                const bases = basesAt.get(location.id) ?? 0;
                return (
                  <button
                    key={location.id}
                    type="button"
                    class="map__pin"
                    style={{ left: `${x}%`, top: `${y}%` }}
                    aria-label={plainLabel(location.name)}
                    data-bases={bases}
                    data-notification={location.id === notifiedLocationId ? "true" : undefined}
                    onClick={() => onInspect(location.id)}
                  >
                    <span class="map__pin-mark" aria-hidden="true">
                      {bases > 0 ? bases : ""}
                    </span>
                    <span class="map__pin-name" aria-hidden="true">
                      {plainLabel(location.name)}
                    </span>
                  </button>
                );
              },
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function countBases(locations: readonly LocationState[]): ReadonlyMap<string, number> {
  return new Map(locations.map((location) => [location.specId, location.bases.length]));
}
