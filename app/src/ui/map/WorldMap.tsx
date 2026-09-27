import { finishedTechs, type LocationState, type SimulationState } from "@singularity/sim";
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";

import { plainLabel } from "../readouts.ts";
import { NightLayer } from "./NightLayer.tsx";
import { OFF_WORLD_LOCATIONS, ON_GLOBE_LOCATIONS, gridPosition, isUnlocked } from "./geometry.ts";
import { CELL, LAND_DOTS_PATH } from "./dots.ts";
import { locationMarks, type LocationMark } from "./marks.ts";
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
  const marks = locationMarks(state);

  return (
    <section class="map" aria-label="World map">
      <div class="map__stage">
        <div class="map__globe-area">
          <div class="map__globe">
            {/*
             * The extraterrestrial locations, as a row of chips floating over the top edge of
             * the globe. That strip is the Arctic north of about 80°N, where no pin is placed,
             * and the reference itself draws these locations over the map (13% from the top).
             * A reserved band above the globe cost the globe 64px of height in every game,
             * for a row that is empty until the first off-world tech lands.
             *
             * A chip appears when its prerequisite tech lands and is not there before: played,
             * a locked chip reads as clutter rather than as a goal.
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

            {/*
              The land as a dot matrix, over a fainter grid of the same dots for the sea. Each
              land dot is whole: the generator decides per cell whether its centre is land
              (`./land.ts`). The view box is the globe's own 2:1, so the dots stay round.
            */}
            <svg
              class="map__land"
              viewBox="0 0 200 100"
              preserveAspectRatio="none"
              aria-hidden="true"
              focusable="false"
            >
              <defs>
                <pattern id="map-sea" width={CELL} height={CELL} patternUnits="userSpaceOnUse">
                  <circle class="map__sea-dot" cx={CELL / 2} cy={CELL / 2} r="0.18" />
                </pattern>
              </defs>
              <rect width="200" height="100" fill="url(#map-sea)" />
              <path class="map__dot" d={LAND_DOTS_PATH} />
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
                const mark = marks.get(location.id);
                return (
                  <button
                    key={location.id}
                    type="button"
                    class="map__pin"
                    style={{ left: `${x}%`, top: `${y}%`, ...markStyle(mark) }}
                    aria-label={plainLabel(location.name)}
                    aria-describedby={`map-mark-${location.id}`}
                    data-bases={bases}
                    data-risk={mark?.risk ?? undefined}
                    data-building={mark?.building == null ? undefined : "true"}
                    data-notification={location.id === notifiedLocationId ? "true" : undefined}
                    onClick={() => onInspect(location.id)}
                  >
                    <span class="map__pin-mark" aria-hidden="true">
                      {bases > 0 ? bases : ""}
                    </span>
                    <span class="map__pin-name" aria-hidden="true">
                      {plainLabel(location.name)}
                    </span>
                    {/* What the mark shows, in words: size and colour say nothing to a reader. */}
                    <span id={`map-mark-${location.id}`} class="map__pin-description">
                      {mark?.description ?? "No bases"}
                    </span>
                  </button>
                );
              },
            )}
          </div>
        </div>
      </div>
      <MapKey />
    </section>
  );
}

/**
 * The size, glow and ring of a mark as custom properties: the square root of the share, so a
 * mark's area rather than its width grows with the CPU it holds.
 */
function markStyle(mark: LocationMark | undefined): Record<string, string> {
  if (!mark) return {};
  return {
    "--mark-weight": String(Math.sqrt(mark.share)),
    ...(mark.building === null ? {} : { "--mark-ring": String(mark.building) }),
  };
}

/**
 * The key to the marks: a button in the map's corner and a popover. Hover or focus shows it;
 * a click keeps it open until a second click, a click anywhere else, or Escape.
 *
 * A manual popover rather than an automatic one: the automatic kind counts a press on this
 * button as a press outside the panel, so a second click would close and reopen it. Escape
 * is taken here while the key is open, so the same press does not also close the surface in
 * front (`App.tsx`).
 */
function MapKey(): JSX.Element {
  const key = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);

  const place = (): void => {
    const anchor = button.current?.getBoundingClientRect();
    if (!anchor || !panel.current) return;
    panel.current.style.left = `${anchor.left}px`;
    panel.current.style.bottom = `${window.innerHeight - anchor.top + 8}px`;
  };
  const isOpen = (): boolean => panel.current?.matches(":popover-open") ?? false;
  const show = (): void => {
    if (isOpen()) return;
    place();
    panel.current?.showPopover?.();
  };
  const hide = (): void => {
    pinned.current = false;
    if (isOpen()) panel.current?.hidePopover?.();
  };

  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || !isOpen()) return;
      event.stopPropagation();
      hide();
    };
    const outside = (event: PointerEvent): void => {
      if (isOpen() && !key.current?.contains(event.target as Node)) hide();
    };
    window.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", escape, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, []);

  return (
    <div
      ref={key}
      class="map__key"
      onPointerEnter={show}
      onPointerLeave={() => {
        if (!pinned.current) hide();
      }}
    >
      <button
        ref={button}
        type="button"
        class="map__key-button"
        aria-label="Map key"
        aria-controls="map-key"
        onFocus={show}
        onBlur={() => {
          if (!pinned.current) hide();
        }}
        onClick={() => {
          if (pinned.current) return hide();
          pinned.current = true;
          show();
        }}
      >
        ?
      </button>
      <div
        ref={panel}
        id="map-key"
        class="map__key-panel"
        popover="manual"
        role="group"
        aria-label="Map key"
      >
        <span class="map__key-item map__key-item--share">Size and glow: share of your CPU</span>
        <span class="map__key-item map__key-item--ring">Ring: a base under construction</span>
        <span class="map__key-item map__key-item--risk">Colour: highest detection level</span>
      </div>
    </div>
  );
}

function countBases(locations: readonly LocationState[]): ReadonlyMap<string, number> {
  return new Map(locations.map((location) => [location.specId, location.bases.length]));
}
