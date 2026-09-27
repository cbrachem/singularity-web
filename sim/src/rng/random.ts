/**
 * The Simulation's random number generator: MT19937 under a **frozen** surface of exactly
 * four drawing functions — `random`, `choice`, `shuffle`, `randint`.
 *
 * # The surface is frozen
 *
 * Those four are every function of Python's `random` the Reference simulation calls
 * (`chance.py:44,63`, `g.py:283`, `region.py:45`, `player.py:134,621`,
 * `screens/location.py:459-465`). The list is closed on purpose, twice over:
 *
 * - It bounds what has to be reimplemented bit for bit. Each function is a transcription
 *   of CPython's `random.py`, rejection loop and draw order included, and each one costs a
 *   fixture generated from the Reference.
 * - It makes a fifth call site a deliberate act. Reaching for `sample`, `uniform` or
 *   `gauss` would silently widen what the Trace has to match, and the widening would be
 *   invisible until a diff moved. Adding one means porting it against CPython, generating
 *   its vectors, and saying so here — not calling it.
 *
 * `sim/test/rng.trace.test.ts` holds the surface to those four members, so this paragraph
 * fails the build rather than merely aging.
 *
 * # It is a value, not a module singleton
 *
 * Upstream draws from the process-global `random` module, which makes a tick reproducible
 * only from the whole history that preceded it. Here the generator is constructed, seeded,
 * carried inside the State root and serialized with it, so a Tick is reproducible from its
 * input alone and a divergent step can be written out as a standalone fixture.
 *
 * Draws mutate it, and the copy is taken once per Tick rather than once per draw: 624
 * words per draw would be paid on every roll, and the Reference rolls per base, per group
 * and per event.
 */

import { Mt19937, type Mt19937State } from "./mt19937.ts";

export type RngState = Mt19937State;

/**
 * One draw, as the Trace records it: the function that was called and what it returned,
 * deliberately **without** the call site. Results are integers so that comparison
 * stays exact equality with no tolerance policy anywhere — `random` reports the exact
 * numerator over 2^53, `choice` the index it drew rather than the element, and `shuffle` the
 * permutation as the original index of each element after it.
 */
export type Draw = readonly [fn: string, result: number | readonly number[]];

/**
 * Where a generator reports its draws. The draw log is half of the fidelity mechanism — the
 * RNG stream is the sharpest divergence detector there is — so a generator can be asked to
 * keep one. It is injected rather than switched on globally, and a clone keeps it, because
 * `advance` copies the generator once per Tick.
 */
export type DrawObserver = (draw: Draw) => void;

export class Rng {
  private readonly core: Mt19937;
  private readonly observer: DrawObserver | undefined;

  private constructor(core: Mt19937, observer: DrawObserver | undefined) {
    this.core = core;
    this.observer = observer;
  }

  /** As `random.seed(n)` for an integer `n`. */
  static seeded(seed: number | bigint, observer?: DrawObserver): Rng {
    return new Rng(Mt19937.seeded(seed), observer);
  }

  static fromState(state: RngState, observer?: DrawObserver): Rng {
    return new Rng(Mt19937.fromState(state), observer);
  }

  toState(): RngState {
    return this.core.toState();
  }

  /** A generator that draws the same stream from here on, and moves independently. */
  clone(): Rng {
    return new Rng(this.core.clone(), this.observer);
  }

  /** `random.random()` — `genrand_res53`, two words per call. */
  random(): number {
    const value = this.core.nextDouble();
    // CPython's `random()` is `k / 2**53` for an integer `k`, so the numerator is exact.
    this.observer?.(["random", value * 2 ** 53]);
    return value;
  }

  /** `random.randint(a, b)` — inclusive at both ends, via `randrange(a, b + 1)`. */
  randint(low: number, high: number): number {
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)) {
      throw new RangeError(`randint takes whole numbers, got ${low}, ${high}`);
    }
    const width = high - low + 1;
    if (width <= 0) throw new RangeError(`empty range for randint(${low}, ${high})`);
    const value = low + this.#below(width);
    this.observer?.(["randint", value]);
    return value;
  }

  /** `random.choice(seq)` — one element, drawn by index. */
  choice<T>(sequence: readonly T[]): T {
    if (sequence.length === 0) throw new RangeError("cannot choose from an empty sequence");
    const index = this.#below(sequence.length);
    this.observer?.(["choice", index]);
    return sequence[index] as T;
  }

  /**
   * `random.shuffle(x)` — in place, Fisher–Yates walked **downwards** from the last index,
   * swapping `x[i]` with `x[randbelow(i + 1)]`. The direction and the draw count are both
   * observable: one `_randbelow` per index from `length - 1` down to 1, each of which may
   * consume more than one word through its rejection loop.
   */
  shuffle<T>(items: T[]): void {
    // The permutation is tracked beside the elements rather than recovered from them
    // afterwards: two equal elements are indistinguishable once moved, and the reference
    // records where each one came from.
    const from = this.observer ? items.map((_, index) => index) : undefined;
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = this.#below(i + 1);
      const held = items[i] as T;
      items[i] = items[j] as T;
      items[j] = held;
      if (from) {
        const camefrom = from[i] as number;
        from[i] = from[j] as number;
        from[j] = camefrom;
      }
    }
    if (from) this.observer?.(["shuffle", from]);
  }

  /**
   * `Random._randbelow_with_getrandbits`: draw `n.bit_length()` bits and redraw while the
   * result is out of range. The rejection loop is why a draw count is not a function of
   * the call count, and why it has to be matched rather than reasoned about.
   */
  #below(bound: number): number {
    if (!Number.isInteger(bound) || bound < 1 || bound > 0xffffffff) {
      throw new RangeError(`the ported _randbelow covers 1…2^32-1, got ${bound}`);
    }
    const bits = 32 - Math.clz32(bound); // Python's n.bit_length(), for n below 2^32
    let drawn = this.core.nextBits(bits);
    while (drawn >= bound) drawn = this.core.nextBits(bits);
    return drawn;
  }
}
