/**
 * The four Python numeric operations the rules lean on, spelled out.
 *
 * The Reference's arithmetic is mostly integer, but not entirely: a location's modifiers are
 * floats and they reach `int(x)` and `x // y` in the cost and CPU kernels. JavaScript has
 * neither operator, and the obvious substitutes are wrong in exactly the places that matter —
 * `Math.round` is half-up where numpy is half-to-even, and `Math.floor` is not `int()` for a
 * negative value.
 *
 * So each one is written out once, here, where the difference from the reference is a line
 * that can be pointed at rather than an assumption inside a formula.
 */

/** Python's `int(x)` on a float: truncate towards zero, never away from it. */
export function truncate(value: number): number {
  return Math.trunc(value);
}

/**
 * `numpy.round(x)` for a whole-number rounding: **half to even**, not half up.
 *
 * The construction kernel is the only caller and it rounds once per Tick, so the two differ
 * by one unit on every `.5` boundary and the difference accumulates into what a base has
 * paid (`buyable.py:186`). It is an upstream *behaviour* rather than a defect to correct:
 * `Math.round` would round 62.5 to 63 where the Reference pays 62, so it is a preserved
 * defect and this function exists to stop anyone reaching for the shorter spelling.
 *
 * Exact for every finite double: the halfway case is the only one where `value - floor` can
 * equal exactly 0.5, and there the even neighbour wins.
 */
export function roundHalfToEven(value: number): number {
  const below = Math.floor(value);
  const above = value - below;
  if (above > 0.5) return below + 1;
  if (above < 0.5) return below;
  return below % 2 === 0 ? below : below + 1;
}

/**
 * Python's `//`, for the mixed int/float operands the rules produce.
 *
 * CPython computes it as `floor((a - fmod(a, b)) / b)` rather than as `floor(a / b)`, so that
 * the quotient is exact whenever `fmod` is — and `fmod` always is. JavaScript's `%` *is* C's
 * `fmod` (truncated, signed by the dividend), so the transcription is direct.
 */
export function floorDiv(a: number, b: number): number {
  return divMod(a, b)[0];
}

/** Python's `divmod(a, b)` — the quotient and the remainder that go with it. */
export function divMod(a: number, b: number): readonly [quotient: number, remainder: number] {
  if (b === 0) throw new RangeError("integer division or modulo by zero");
  let mod = a % b;
  let div = (a - mod) / b;
  if (mod !== 0 && b < 0 !== mod < 0) {
    mod += b;
    div -= 1;
  }
  if (div === 0) return [0, mod];
  const floor = Math.floor(div);
  // CPython's own correction: the subtraction above can leave `div` just under the integer
  // it should be, and a floor would then lose a whole unit rather than a rounding error.
  return [div - floor > 0.5 ? floor + 1 : floor, mod];
}
