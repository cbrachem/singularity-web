// boundary-intent harness: a test, so it decides what to drive and what to expect
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { Mt19937, Rng, advance, createInitialState, exp, seedWords } from "../src/index.ts";
import { bitsToDouble, doubleToBits, formatBits, parseBits } from "./support/bits.ts";
import { keyAsHex, randomVectors, randomVectorsPath, staleFixture } from "./support/fixtures.ts";
import { oracleAvailable, oracleRequired, randomVectorsCheck } from "./support/oracle.ts";

// The trace seam. The port's random numbers have to be CPython's random numbers, bit for
// bit: the Reference rolls per base, per group, per tick and per event, so one differing
// word displaces every later draw and a Trace diff turns into noise.
//
// Every expectation below comes from sim/test/fixtures/cpython-random.json, generated from
// the pinned reference by tools/oracle/random_vectors.py. Nothing here reaches inside a
// module: the generator is driven through the surface the Simulation itself uses.

const secondsPerDay = randomVectors.secondsPerDay;

function drawnDoubles(rng: Rng, count: number): string[] {
  return Array.from({ length: count }, () => formatBits(doubleToBits(rng.random())));
}

function sequenceOfLength(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

describe("MT19937", () => {
  it("reaches CPython's seeded state, for seeds either side of a word boundary", () => {
    for (const vector of randomVectors.seeding) {
      const state = Mt19937.seeded(BigInt(vector.seed)).toState();

      expect(keyAsHex(state.key), `seed ${vector.seed}`).toBe(vector.key);
      expect(state.index, `seed ${vector.seed}`).toBe(vector.index);
    }
  });

  it("feeds init_by_array the seed's own words, least significant first", () => {
    expect(seedWords(0)).toEqual([0]);
    expect(seedWords(1)).toEqual([1]);
    expect(seedWords(0xffffffff)).toEqual([0xffffffff]);
    expect(seedWords(2n ** 32n)).toEqual([0, 1]);
    expect(seedWords(2n ** 64n + 12345n)).toEqual([12345, 0, 1]);
    // `random.seed` takes the absolute value, so a negative seed is not a distinct stream.
    expect(seedWords(-987654321)).toEqual(seedWords(987654321));
  });

  it("reproduces the raw 32-bit stream and genrand_res53 from a fixed seed", () => {
    for (const vector of randomVectors.streams) {
      const words = Mt19937.seeded(BigInt(vector.seed));
      expect(
        Array.from({ length: vector.words.length }, () => words.nextWord()),
        `seed ${vector.seed}`,
      ).toEqual(vector.words);

      const doubles = Rng.seeded(BigInt(vector.seed));
      expect(drawnDoubles(doubles, vector.random.length), `seed ${vector.seed}`).toEqual(
        vector.random,
      );
    }
  });
});

describe("the frozen four-function surface", () => {
  it("matches CPython's randint, rejection loop and draw count included", () => {
    for (const vector of randomVectors.randint) {
      const rng = Rng.seeded(BigInt(vector.seed));
      const drawn = vector.values.map(() => rng.randint(vector.low, vector.high));
      const label = `seed ${vector.seed}, randint(${vector.low}, ${vector.high})`;

      expect(drawn, label).toEqual(vector.values);
      expect(drawnDoubles(rng, vector.afterRandom.length), label).toEqual(vector.afterRandom);
    }
  });

  it("matches CPython's choice", () => {
    for (const vector of randomVectors.choice) {
      const rng = Rng.seeded(BigInt(vector.seed));
      const sequence = sequenceOfLength(vector.length);
      const drawn = vector.values.map(() => rng.choice(sequence));
      const label = `seed ${vector.seed}, choice over ${vector.length}`;

      expect(drawn, label).toEqual(vector.values);
      expect(drawnDoubles(rng, vector.afterRandom.length), label).toEqual(vector.afterRandom);
    }
  });

  it("matches CPython's shuffle, in its direction and in what it consumes", () => {
    for (const vector of randomVectors.shuffle) {
      const rng = Rng.seeded(BigInt(vector.seed));
      const items = sequenceOfLength(vector.length);
      rng.shuffle(items);
      const label = `seed ${vector.seed}, shuffle of ${vector.length}`;

      // The permutation pins the direction — walking upwards produces a different one.
      expect(items, label).toEqual(vector.order);
      // What follows pins the draw count, which the permutation alone cannot.
      expect(drawnDoubles(rng, vector.afterRandom.length), label).toEqual(vector.afterRandom);
    }
  });

  it("refuses what CPython refuses", () => {
    const rng = Rng.seeded(1);

    expect(() => rng.choice([])).toThrow(RangeError);
    expect(() => rng.randint(5, 4)).toThrow(RangeError);
    expect(() => rng.randint(0.5, 4)).toThrow(RangeError);
  });

  it("stays four functions wide", () => {
    // The surface is frozen (see sim/src/rng/random.ts). A fifth drawing function means a
    // new fixture generated from the Reference and a deliberate edit here — not a call.
    const members = Object.getOwnPropertyNames(Rng.prototype).sort();

    expect(members).toEqual([
      "choice",
      "clone",
      "constructor",
      "randint",
      "random",
      "shuffle",
      "toState",
    ]);
  });
});

describe("the Reference's own roll functions", () => {
  it("reproduces roll_interval, ported exp and all", () => {
    for (const vector of randomVectors.rollInterval) {
      const rng = Rng.seeded(BigInt(vector.seed));
      const chancePerDay = bitsToDouble(parseBits(vector.chancePerDay));
      const label = `seed ${vector.seed}, roll_interval(${chancePerDay}, ${vector.seconds})`;

      const drawn = vector.results.map(() => {
        // chance.py:40-44, operation for operation.
        const portionOfDay = vector.seconds / secondsPerDay;
        const intervalRate = chancePerDay * portionOfDay;
        const chance = 1 - exp(-intervalRate);
        return rng.random() < chance;
      });

      expect(drawn, label).toEqual(vector.results);
      expect(drawnDoubles(rng, vector.afterRandom.length), label).toEqual(vector.afterRandom);
    }
  });

  it("reproduces roll_one", () => {
    for (const vector of randomVectors.rollOne) {
      const rng = Rng.seeded(BigInt(vector.seed));
      const label = `seed ${vector.seed}, roll_one(${vector.rollAgainst})`;

      // chance.py:62-64.
      const drawn = vector.results.map(() => vector.rollAgainst >= rng.randint(1, 10000));

      expect(drawn, label).toEqual(vector.results);
      expect(drawnDoubles(rng, vector.afterRandom.length), label).toEqual(vector.afterRandom);
    }
  });
});

const runsTheOracle = oracleAvailable || oracleRequired;

// The other end of the chain `content.trace.test.ts` closes for Content: everything above
// compares the port against the committed fixture, and nothing there compares the fixture
// against the reference after the moment it was generated. Half of what it records — `roll_interval` and
// `roll_one` — lives in `singularity/singularity/code/chance.py`, which a bump can move while
// `content/` stays byte-identical and the Converter's dirty-tree check stays green.
describe.skipIf(!runsTheOracle)("the fixture against a fresh reference run", () => {
  it("still holds what CPython and the reference's own roll functions hold", () => {
    const result = randomVectorsCheck();

    expect(`${result.stdout}${result.stderr}`.trim()).toContain("matches the reference");
    expect(result.status).toBe(0);
  });

  it("goes red on a changed roll, naming the case it changed", () => {
    const stale = staleFixture(randomVectorsPath, (document) => {
      const rolls = document["rollOne"] as Record<string, unknown>[];
      const results = rolls[3]?.["results"];
      if (!Array.isArray(results)) throw new TypeError("rollOne[3].results is not an array");
      results[2] = false;
    });

    const result = randomVectorsCheck(stale);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('rollOne[3 "0"].results[2]: false -> true');
    expect(result.stderr).toContain("tools/oracle/random_vectors.py");
  });

  // The other half of the record: `rollOne` above is the reference's, this is CPython's own
  // stream, which a bump cannot move but an interpreter upgrade can.
  it("goes red on a changed word in the raw stream", () => {
    const stale = staleFixture(randomVectorsPath, (document) => {
      const streams = document["streams"] as Record<string, unknown>[];
      const words = streams[0]?.["words"];
      if (!Array.isArray(words)) throw new TypeError("streams[0].words is not an array");
      words[0] = 0;
    });

    const result = randomVectorsCheck(stale);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `streams[0 "0"].words[0]: 0 -> ${randomVectors.streams[0]?.words[0]}`,
    );
  });

  it("goes red on a case list that gained or lost an entry", () => {
    const stale = staleFixture(randomVectorsPath, (document) => {
      const intervals = document["rollInterval"] as unknown[];
      intervals.pop();
    });

    const result = randomVectorsCheck(stale);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rollInterval: 17 entries -> 18 entries");
  });

  // The recording interpreter is provenance, not specification: a CPython whose Mersenne
  // Twister differed would show up as a differing word rather than as a differing version
  // string. Tolerating it is what lets CI run the check on whatever interpreter it
  // provisioned.
  it("does not mistake the recording interpreter for a changed stream", () => {
    const elsewhere = staleFixture(randomVectorsPath, (document) => {
      document["python"] = "0.0.0";
    });

    const result = randomVectorsCheck(elsewhere);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0.0.0");
  });

  it("leaves the committed fixture alone while checking it", () => {
    const before = readFileSync(randomVectorsPath, "utf8");

    expect(randomVectorsCheck().status).toBe(0);

    expect(readFileSync(randomVectorsPath, "utf8")).toBe(before);
  });
});

describe("the generator as a value", () => {
  it("round-trips through a serialized state, mid-stream", () => {
    const rng = Rng.seeded(42);
    for (let draw = 0; draw < 700; draw += 1) rng.random(); // past one twist of the state

    const carried = JSON.parse(JSON.stringify(rng.toState())) as ReturnType<Rng["toState"]>;
    const restored = Rng.fromState(carried);

    expect(drawnDoubles(restored, 8)).toEqual(drawnDoubles(rng, 8));
  });

  it("clones into a generator that draws the same stream and then moves alone", () => {
    const rng = Rng.seeded(7);
    const copy = rng.clone();

    expect(drawnDoubles(copy, 4)).toEqual(drawnDoubles(rng, 4));

    copy.random();
    expect(copy.toState()).not.toEqual(rng.toState());
  });

  it("refuses a state that is not one", () => {
    expect(() => Rng.fromState({ key: [1, 2, 3], index: 0 })).toThrow(RangeError);
    expect(() => Rng.fromState({ key: Array.from({ length: 624 }, () => 0), index: 625 })).toThrow(
      RangeError,
    );
  });

  it("rides in the State root, so a Tick is reproducible from its input alone", () => {
    const newGame = { seed: 2026, difficulty: "normal" } as const;
    const before = createInitialState(newGame);
    const drawnFromInput = before.rng.clone().random();

    const first = advance(before, 60);
    const second = advance(first.state, 60);

    expect(first.state.rng).not.toBe(before.rng);
    expect(second.state.rng).not.toBe(first.state.rng);
    // The root a Tick handed out does not move underneath whoever is still holding it.
    expect(before.rng.toState()).toEqual(createInitialState(newGame).rng.toState());
    expect(before.rng.clone().random()).toBe(drawnFromInput);
    // Replaying the same input state reaches the same generator.
    expect(advance(createInitialState(newGame), 60).state.rng.toState()).toEqual(
      first.state.rng.toState(),
    );
  });
});
