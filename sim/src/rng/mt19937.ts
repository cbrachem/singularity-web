/**
 * MT19937, transcribed from CPython's `_randommodule.c` — the generator behind
 * `random.Random`, and therefore the one the Reference simulation draws from.
 *
 * This module is the C half of CPython's split: the integer core, `init_genrand` /
 * `init_by_array` seeding, `genrand_res53`, and `getrandbits`. The four functions the
 * Simulation is allowed to call live on top of it in `./random.ts`.
 *
 * Sameness here is not a nicety. The Reference rolls per base, per group, per tick and per
 * event, so a single differing word displaces every later draw and a Trace diff turns into
 * noise.
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

/**
 * A generator's whole state, in the shape CPython's `random.getstate()[1]` carries it:
 * 624 words plus the index of the next word to temper. Serializable as it stands, so a
 * Save or a Trace record can hold it and a fixture can be generated straight from the
 * Reference.
 */
export interface Mt19937State {
  readonly key: readonly number[];
  readonly index: number;
}

function multiply32(a: number, b: number): number {
  return Math.imul(a, b) >>> 0;
}

/**
 * The integer core. A value: constructed from a seed or from a serialized state, cloned
 * cheaply, and never reachable as a module singleton — a Tick has to be reproducible from
 * its input alone.
 *
 * Draws mutate it in place, which is why `advance` clones the incoming generator once per
 * Tick rather than once per draw: the State root the previous Tick handed out must not
 * move underneath whoever is still holding it.
 */
export class Mt19937 {
  private readonly key: Uint32Array;
  private index: number;

  private constructor(key: Uint32Array, index: number) {
    this.key = key;
    this.index = index;
  }

  /** CPython's `random.seed(n)` for an integer `n`: `init_by_array` over `abs(n)`. */
  static seeded(seed: number | bigint): Mt19937 {
    const generator = new Mt19937(new Uint32Array(N), N);
    generator.initByArray(seedWords(seed));
    return generator;
  }

  static fromState(state: Mt19937State): Mt19937 {
    if (state.key.length !== N) {
      throw new RangeError(`an MT19937 state has ${N} words, got ${state.key.length}`);
    }
    if (!Number.isInteger(state.index) || state.index < 0 || state.index > N) {
      throw new RangeError(`an MT19937 index is 0…${N}, got ${state.index}`);
    }
    return new Mt19937(Uint32Array.from(state.key), state.index);
  }

  toState(): Mt19937State {
    return { key: Array.from(this.key), index: this.index };
  }

  clone(): Mt19937 {
    return new Mt19937(this.key.slice(), this.index);
  }

  /** `genrand_uint32`: one tempered 32-bit word. */
  nextWord(): number {
    if (this.index >= N) this.twist();
    let y = this.key[this.index] as number;
    this.index += 1;
    y ^= y >>> 11;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    return (y ^ (y >>> 18)) >>> 0;
  }

  /** `genrand_res53`: 53 significant bits from two words — CPython's `random.random()`. */
  nextDouble(): number {
    const a = this.nextWord() >>> 5;
    const b = this.nextWord() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  /**
   * `getrandbits(k)` for `k` up to 32, which is every width the frozen surface in
   * `./random.ts` asks for. Wider draws would need CPython's multi-word path and would
   * mean a call site nobody has decided to allow.
   */
  nextBits(bits: number): number {
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
      throw new RangeError(`getrandbits is ported for 0…32 bits, got ${bits}`);
    }
    if (bits === 0) return 0;
    return this.nextWord() >>> (32 - bits);
  }

  private twist(): void {
    const key = this.key;
    for (let i = 0; i < N; i += 1) {
      const y =
        (((key[i] as number) & UPPER_MASK) | ((key[(i + 1) % N] as number) & LOWER_MASK)) >>> 0;
      key[i] = ((key[(i + M) % N] as number) ^ (y >>> 1) ^ ((y & 1) === 1 ? MATRIX_A : 0)) >>> 0;
    }
    this.index = 0;
  }

  private initGenrand(seed: number): void {
    const key = this.key;
    key[0] = seed >>> 0;
    for (let i = 1; i < N; i += 1) {
      const previous = key[i - 1] as number;
      key[i] = (multiply32(1812433253, previous ^ (previous >>> 30)) + i) >>> 0;
    }
    this.index = N;
  }

  private initByArray(words: readonly number[]): void {
    this.initGenrand(19650218);
    const key = this.key;
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, words.length); k > 0; k -= 1) {
      const previous = key[i - 1] as number;
      key[i] =
        (((key[i] as number) ^ multiply32(previous ^ (previous >>> 30), 1664525)) +
          (words[j] as number) +
          j) >>>
        0;
      i += 1;
      j += 1;
      if (i >= N) {
        key[0] = key[N - 1] as number;
        i = 1;
      }
      if (j >= words.length) j = 0;
    }
    for (let k = N - 1; k > 0; k -= 1) {
      const previous = key[i - 1] as number;
      key[i] =
        (((key[i] as number) ^ multiply32(previous ^ (previous >>> 30), 1566083941)) - i) >>> 0;
      i += 1;
      if (i >= N) {
        key[0] = key[N - 1] as number;
        i = 1;
      }
    }
    key[0] = 0x80000000; // MSB is 1, assuring a non-zero initial array
    this.index = N;
  }
}

/**
 * `abs(seed)` as 32-bit words, least significant first — CPython's `random_seed`, which
 * hands the integer's own bytes to `init_by_array`. Zero is one word, not none.
 */
export function seedWords(seed: number | bigint): number[] {
  if (typeof seed === "number" && !Number.isSafeInteger(seed)) {
    throw new RangeError(`a seed is a whole number, got ${seed}`);
  }
  let remaining = typeof seed === "bigint" ? seed : BigInt(seed);
  if (remaining < 0n) remaining = -remaining;
  if (remaining === 0n) return [0];

  const words: number[] = [];
  while (remaining > 0n) {
    words.push(Number(remaining & 0xffffffffn));
    remaining >>= 32n;
  }
  return words;
}
