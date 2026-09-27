/**
 * `exp`, transcribed from fdlibm's `__ieee754_exp` (`e_exp.c`).
 *
 * The Simulation reaches exactly one transcendental: `chance = 1 - np.exp(-interval_rate)`
 * at `singularity/singularity/code/chance.py:42`, feeding `random.random() < chance`. It
 * is not taken from the runtime. Measured, neither JavaScript engine agrees
 * with numpy, and the engines do not agree with each other — bun forwards to the
 * platform's libm — so leaving `exp` to the runtime would put the engine inside the
 * fidelity argument. A ported fdlibm is bit-identical wherever it runs, which takes it
 * back out. What remains against numpy is an accepted risk, bounded at 1.11e-16
 * and kept visible by `sim/test/exp.trace.test.ts`.
 *
 * The transcription is deliberately literal: same branch structure, same constants, same
 * order of operations. Every rearrangement here is a floating-point difference.
 *
 * fdlibm is Sun Microsystems' freely distributable libm; the notice is in `NOTICE`.
 */

/** 0x40862E42 — |x| at or above 709.78…, where over/underflow has to be considered. */
const OVERFLOW_HIGH_WORD = 0x40862e42;
/** 0x3FD62E42 — |x| above 0.5·ln2, where argument reduction starts. */
const HALF_LN2_HIGH_WORD = 0x3fd62e42;
/** 0x3FF0A2B2 — |x| below 1.5·ln2, where reduction is a single subtraction. */
const ONE_AND_A_HALF_LN2_HIGH_WORD = 0x3ff0a2b2;
/** 0x3E300000 — |x| below 2^-28, where exp(x) rounds to 1 + x. */
const TINY_HIGH_WORD = 0x3e300000;

const HUGE = 1.0e300;
const TWOM1000 = 9.3326361850321887899e-302;
const OVERFLOW_THRESHOLD = 7.09782712893383973096e2;
const UNDERFLOW_THRESHOLD = -7.4513321910194110842e2;
const LN2_HI = 6.9314718036912381649e-1;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.442695040888963387;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.6533902205465251539e-6;
const P5 = 4.13813679705723846039e-8;

/**
 * The eight bytes the three word accessors below write through.
 *
 * It is a scratch pad and not state — every read of it is preceded by a write in the same
 * call, so nothing survives from one `exp` to the next — but `const` does not say that, and
 * the boundary rule is right to stop here. So the exemption is written where the
 * rule can see it, and `boundary.test.ts` asserts that this is the only one in `sim/`.
 *
 * Why not allocate it per call, which would need no exemption. Measured under bun 1.3.14,
 * 5,000,000 calls over the reference's own domain (`interval_rate` is in [0, 1], so the
 * argument is in [-1, 0]), three rounds after warm-up:
 *
 * | scratch                          | per call |
 * | -------------------------------- | -------- |
 * | shared, as written here          | ~14 ns   |
 * | `new DataView(new ArrayBuffer(8))` per call | ~186 ns |
 *
 * The results are bit-identical either way; the allocation is the whole of the difference.
 * The supported worst case is 1000 bases, and `_check_base_detection` rolls once per
 * base per group on every tick (`player.py:952`) — order 4000 `exp` calls. Per-call
 * allocation would add ~0.7 ms to a tick predicted at 0.75 ms, taking the Simulation
 * from 27% of a throttled frame to more than half of it. That is the measurement the trade
 * is made on, not an assertion about allocation being expensive.
 *
 * The other way out — threading a buffer through `exp`'s callers — puts a scratch allocation
 * into the signature of a function that is meant to read as arithmetic, and spreads the same
 * problem over `chance.ts` and everything that calls it.
 */
// boundary-exemption module-level-mutable-state: an eight-byte scratch, written before every read and carrying nothing from one call to the next; allocating it per call is measured at 13x the cost (see above)
const bits = new DataView(new ArrayBuffer(8));

/** The upper 32 bits of `x`'s IEEE-754 representation. */
function highWord(x: number): number {
  bits.setFloat64(0, x);
  return bits.getUint32(0);
}

/** The lower 32 bits of `x`'s IEEE-754 representation. */
function lowWord(x: number): number {
  bits.setFloat64(0, x);
  return bits.getUint32(4);
}

/** `x` with its upper 32 bits replaced — fdlibm's `SET_HIGH_WORD`. */
function withHighWord(x: number, word: number): number {
  bits.setFloat64(0, x);
  bits.setUint32(0, word >>> 0);
  return bits.getFloat64(0);
}

export function exp(x: number): number {
  const high = highWord(x);
  const signBit = (high >>> 31) & 1;
  const magnitude = high & 0x7fffffff;

  if (magnitude >= OVERFLOW_HIGH_WORD) {
    if (magnitude >= 0x7ff00000) {
      if (((magnitude & 0xfffff) | lowWord(x)) !== 0) return x + x; // NaN
      return signBit === 0 ? x : 0; // exp(±∞) = {∞, 0}
    }
    if (x > OVERFLOW_THRESHOLD) return HUGE * HUGE;
    if (x < UNDERFLOW_THRESHOLD) return TWOM1000 * TWOM1000;
  }

  // Argument reduction: x = k·ln2 + r, with |r| ≤ 0.5·ln2.
  let k = 0;
  let hi = 0;
  let lo = 0;
  let r = x;
  if (magnitude > HALF_LN2_HIGH_WORD) {
    if (magnitude < ONE_AND_A_HALF_LN2_HIGH_WORD) {
      hi = signBit === 0 ? x - LN2_HI : x + LN2_HI;
      lo = signBit === 0 ? LN2_LO : -LN2_LO;
      k = 1 - signBit - signBit;
    } else {
      k = Math.trunc(INV_LN2 * x + (signBit === 0 ? 0.5 : -0.5));
      hi = x - k * LN2_HI; // k·LN2_HI is exact here
      lo = k * LN2_LO;
    }
    r = hi - lo;
  } else if (magnitude < TINY_HIGH_WORD) {
    if (HUGE + x > 1) return 1 + x; // inexact, and exp(x) rounds to 1 + x
  }

  const squared = r * r;
  const c = r - squared * (P1 + squared * (P2 + squared * (P3 + squared * (P4 + squared * P5))));
  if (k === 0) return 1 - ((r * c) / (c - 2.0) - r);

  const y = 1 - (lo - (r * c) / (2.0 - c) - hi);
  if (k >= -1021) return withHighWord(y, highWord(y) + (k << 20));
  return withHighWord(y, highWord(y) + ((k + 1000) << 20)) * TWOM1000;
}
