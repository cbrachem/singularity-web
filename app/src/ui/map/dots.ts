import { LAND_DOTS, LAND_DOT_COLUMNS, LAND_DOT_ROWS } from "./land.ts";

/** One cell of the dot matrix, in the 200 by 100 view box. */
export const CELL = 200 / LAND_DOT_COLUMNS;

/** Every land dot as one path: a circle per set bit of `LAND_DOTS`, built once. */
export const LAND_DOTS_PATH = LAND_DOTS.flatMap((row, y) =>
  [...BigInt(`0x${row}`).toString(2).padStart(LAND_DOT_COLUMNS, "0")].flatMap((bit, x) =>
    bit === "1" ? [dot((x + 0.5) * CELL, (y + 0.5) * (100 / LAND_DOT_ROWS))] : [],
  ),
).join("");

function dot(cx: number, cy: number): string {
  const r = 0.3;
  return `M${(cx - r).toFixed(3)} ${cy.toFixed(3)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
}
