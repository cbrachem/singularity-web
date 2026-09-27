// boundary-intent harness: a test, so it decides what to drive and what to expect
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { exp } from "../src/index.ts";
import { bitsToDouble, digest, parseBits } from "./support/bits.ts";
import { POINTS, STEPS, expArgument, portExpBits } from "./support/exp-grid.ts";
import { numpyExpVectors } from "./support/fixtures.ts";

// The trace seam, for the one transcendental the Simulation reaches. Neither JavaScript engine
// matches numpy, and the engines do not match each other, so
// `sim/` ships its own `exp` rather than leaving the fidelity argument to depend on which
// runtime the Trace was recorded under.

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gridScript = resolve(packageRoot, "test/support/exp-grid.ts");

/**
 * The port's `exp` over the whole grid, as one value. Committed here rather than in a
 * fixture because it is the port's own output, not the Reference's: it changes only when
 * this file's subject changes, and then deliberately.
 */
const PORT_DIGEST = "712e3e420ace2fa7";

function digestFrom(runtime: string): string {
  return execFileSync(runtime, [gridScript, "digest"], { encoding: "utf8" }).trim();
}

describe("the ported fdlibm exp", () => {
  it("behaves like exp at the edges of its definition", () => {
    expect(exp(0)).toBe(1);
    expect(exp(-0)).toBe(1);
    expect(exp(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(exp(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(exp(Number.NaN)).toBeNaN();
    expect(exp(710)).toBe(Number.POSITIVE_INFINITY); // above fdlibm's overflow threshold
    expect(exp(-746)).toBe(0); // below its underflow threshold
    expect(exp(1e-30)).toBe(1); // |x| < 2^-28, where exp(x) rounds to 1 + x
  });

  it("is bit-identical under both runtimes over the reference's real domain", () => {
    // interval_rate is in [0, 1] (chance.py:40-42), so the argument is in [-1, 0].
    expect(expArgument(0)).toBe(-0);
    expect(expArgument(STEPS)).toBe(-1);

    const here = digest(portExpBits());

    expect(here).toBe(PORT_DIGEST);
    expect(digestFrom("node"), "under node").toBe(here);
    expect(digestFrom("bun"), "under bun").toBe(here);
  });

  // The eight-byte buffer the word accessors write through is the one exemption from the
  // module-state rule (`boundary.test.ts`), and the exemption's claim is that it is scratch:
  // every read of it is preceded by a write in the same call. That claim is checkable, so it
  // is checked rather than asserted — a buffer that carried something would show up as a
  // result that depends on what was called before it.
  it("keeps nothing in its scratch buffer from one call to the next", () => {
    // One argument per branch, so a value left behind by any of them would be seen.
    const domain = [
      -1,
      -0.5,
      -0.25,
      -1e-30,
      0,
      1,
      0.5,
      2,
      700,
      710,
      -746,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    const straight = domain.map((x) => exp(x));

    const interleaved = domain.map((x) => {
      for (const other of domain) exp(other);
      return exp(x);
    });
    const backwards = [...domain]
      .reverse()
      .map((x) => exp(x))
      .reverse();

    expect(interleaved.map(String)).toEqual(straight.map(String));
    expect(backwards.map(String)).toEqual(straight.map(String));
  });
});

describe("the accepted difference against numpy", () => {
  // The risk is accepted and bounded: the Reference compares a draw
  // against `1 - np.exp(-interval_rate)`, so a differently rounded `exp` can flip the
  // comparison. The port does not chase numpy — it keeps the difference measured.
  const vectors = numpyExpVectors;

  it("is measured over the same grid the port is checked on", () => {
    expect(vectors.steps).toBe(STEPS);
  });

  it("reconstructs numpy's run from the port's, and it still hashes to numpy's", () => {
    // Every point the fixture does not list is a point where the two agree, so the port
    // plus the listed offsets *is* numpy's run — and a regression in the port cannot pass
    // by quietly agreeing with a stale fixture.
    const reconstructed = portExpBits();
    for (const [index, offset] of vectors.ulpOffsets) {
      const current = reconstructed[index] as bigint;
      reconstructed[index] = current + BigInt(offset);
      expect(offset, `point ${index}`).not.toBe(0);
    }

    expect(reconstructed).toHaveLength(POINTS);
    expect(digest(reconstructed)).toBe(vectors.digest);
  });

  it("records how far apart they are, and that it is at most one unit in the last place", () => {
    const largest = bitsToDouble(parseBits(vectors.largestAbsoluteDifference));
    const port = portExpBits();

    let measured = 0;
    for (const [index, offset] of vectors.ulpOffsets) {
      expect(Math.abs(offset), `point ${index}`).toBe(1);
      const ours = bitsToDouble(port[index] as bigint);
      const theirs = bitsToDouble((port[index] as bigint) + BigInt(offset));
      measured = Math.max(measured, Math.abs(theirs - ours));
    }

    expect(vectors.differing).toBe(vectors.ulpOffsets.length);
    expect(measured).toBe(largest);
    // The figure that bounds the flip. The differing *fraction* is a property of
    // the grid, not of the port: 11.1% over the whole of [-1, 0], where the original measurement
    // found 1.48% over the domain it sampled. The bound is what the argument rests on.
    expect(largest).toBe(1.1102230246251565e-16);
    expect(vectors.differingFraction).toBeCloseTo(vectors.differing / POINTS, 6);
  });
});
