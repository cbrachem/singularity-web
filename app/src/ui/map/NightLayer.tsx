import type { JSX } from "preact";
import { useLayoutEffect, useMemo, useRef } from "preact/hooks";

import {
  MASK_HEIGHT,
  MASK_WIDTH,
  createTerminator,
  dayOfYear,
  nightOffsetFraction,
} from "./terminator.ts";

/**
 * The one layer of the map that moves.
 *
 * The mask is rebuilt when the day of the year changes and translated on every other render,
 * which is upstream's own arrangement — in equirectangular the terminator's shape depends on
 * the day and only its longitude on the hour (`./terminator.ts`). The translation
 * is a CSS transform, so the frames between two game days cost the compositor and nothing
 * else.
 *
 * The bitmap holds the mask **twice**, side by side, and the element is twice the layer's
 * width. That is what makes the scroll wrap: at any offset the layer shows the tail of one
 * copy and the head of the next, so the terminator leaves the right edge and arrives at the
 * left without a seam and without a second element.
 */
export interface NightLayerProps {
  readonly gameTime: number;
  /** The day of the year the game started on — drawn once, when the game was created. */
  readonly startDay: number;
}

export function NightLayer({ gameTime, startDay }: NightLayerProps): JSX.Element {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const terminator = useMemo(() => createTerminator(), []);
  const painted = useRef<Uint8ClampedArray | undefined>(undefined);

  const mask = terminator.maskFor(dayOfYear(gameTime, startDay));

  useLayoutEffect(() => {
    if (painted.current === mask) return;
    // No 2D context is a headless test, not a failure: the layer is decoration over a map
    // that is already complete, and the geometry it would have drawn is asserted directly
    // (`app/test/map-geometry.test.ts`).
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.putImageData(twice(mask), 0, 0);
    painted.current = mask;
  });

  return (
    <canvas
      ref={canvas}
      class="map__night"
      width={MASK_WIDTH * 2}
      height={MASK_HEIGHT}
      aria-hidden="true"
      style={{ transform: `translateX(${(nightOffsetFraction(gameTime) - 1) * 50}%)` }}
    />
  );
}

/** The mask as black pixels of rising opacity, laid down twice across the bitmap. */
function twice(mask: Uint8ClampedArray): ImageData {
  const width = MASK_WIDTH * 2;
  const image = new ImageData(width, MASK_HEIGHT);
  for (let row = 0; row < MASK_HEIGHT; row += 1) {
    for (let column = 0; column < MASK_WIDTH; column += 1) {
      const alpha = mask[row * MASK_WIDTH + column] as number;
      image.data[(row * width + column) * 4 + 3] = alpha;
      image.data[(row * width + column + MASK_WIDTH) * 4 + 3] = alpha;
    }
  }
  return image;
}
