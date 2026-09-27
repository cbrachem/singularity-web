// boundary-intent harness: reads the committed vectors off disk
/**
 * The committed vectors, and the shapes they arrive in.
 *
 * Every file here is generated from the pinned reference by a script under `tools/oracle/`,
 * is committed, and is regenerated only deliberately — a changed fixture is a changed
 * specification.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ReferenceContent } from "./content-shape.ts";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function read<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixtures, name), "utf8")) as T;
}

/** One case of a call made 32 times from a fresh seed, then three `random()` calls. */
interface DrawCase {
  readonly seed: string;
  /** What `random()` returns next. Three of them, so a differing draw count cannot hide. */
  readonly afterRandom: readonly string[];
}

export interface SeedingCase {
  readonly seed: string;
  /** The 624 state words as one hex string, 8 characters each. */
  readonly key: string;
  readonly index: number;
}

export interface StreamCase {
  readonly seed: string;
  readonly words: readonly number[];
  readonly random: readonly string[];
}

export interface RandintCase extends DrawCase {
  readonly low: number;
  readonly high: number;
  readonly values: readonly number[];
}

export interface ChoiceCase extends DrawCase {
  readonly length: number;
  readonly values: readonly number[];
}

export interface ShuffleCase extends DrawCase {
  readonly length: number;
  readonly order: readonly number[];
}

export interface RollIntervalCase extends DrawCase {
  readonly chancePerDay: string;
  readonly seconds: number;
  readonly results: readonly boolean[];
}

export interface RollOneCase extends DrawCase {
  readonly rollAgainst: number;
  readonly results: readonly boolean[];
}

export interface RandomVectors {
  readonly python: string;
  readonly secondsPerDay: number;
  readonly seeding: readonly SeedingCase[];
  readonly streams: readonly StreamCase[];
  readonly randint: readonly RandintCase[];
  readonly choice: readonly ChoiceCase[];
  readonly shuffle: readonly ShuffleCase[];
  readonly rollInterval: readonly RollIntervalCase[];
  readonly rollOne: readonly RollOneCase[];
}

export interface NumpyExpVectors {
  readonly numpy: string;
  readonly steps: number;
  /** FNV-1a over numpy's whole run, in the same walk as `digest` in `./exp-grid.ts`. */
  readonly digest: string;
  readonly differing: number;
  readonly differingFraction: number;
  /** The largest |numpy − port| over the domain, as a bit pattern so it survives exactly. */
  readonly largestAbsoluteDifference: string;
  /** `[index, numpyBits − portBits]` at every point where the two runs differ. */
  readonly ulpOffsets: readonly (readonly [number, number])[];
}

/** What a run of log entries covers: how many survived, and the ends they span. */
export interface LogRingSpan {
  readonly entries: number;
  readonly oldestRawEmitTime: number | null;
  readonly newestRawEmitTime: number | null;
}

/** A span the reference was driven to, beside the number of entries it was offered. */
export interface LogRingOffered extends LogRingSpan {
  readonly offered: number;
}

export interface LogRingVectors {
  readonly python: string;
  /** `collections.deque(maxlen=…)` in `Player.__init__` (`player.py:112`). */
  readonly maxEntries: number;
  /** The Content id the recorded entries name, so both sides log the same thing. */
  readonly eventId: string;
  readonly appendedPastTheCap: LogRingOffered;
  readonly serialised: LogRingSpan;
  readonly restoredPastTheCap: LogRingOffered;
}

export const randomVectors: RandomVectors = read<RandomVectors>("cpython-random.json");
export const numpyExpVectors: NumpyExpVectors = read<NumpyExpVectors>("numpy-exp.json");

/** The same file on disk, for the check that it still matches a fresh run of the reference. */
export const randomVectorsPath = resolve(fixtures, "cpython-random.json");

/** What the reference's bounded player log does when it is driven past its cap. */
export const logRingVectors: LogRingVectors = read<LogRingVectors>("reference-log-ring.json");

/** The same file on disk, for the check that it still matches a fresh run of the reference. */
export const logRingVectorsPath = resolve(fixtures, "reference-log-ring.json");

/** What upstream's own loaders end up holding, read off the reference after `reload_all()`. */
export const referenceContent: ReferenceContent = read<ReferenceContent>("reference-content.json");

/** The same file on disk, for the check that it still matches a fresh run of the reference. */
export const referenceContentPath = resolve(fixtures, "reference-content.json");

/**
 * A copy of the committed fixture at `path` with one value changed, written to a temp file a
 * `--check` run can be pointed at. This is how the checks in `./oracle.ts` are shown to go red:
 * the committed file itself is read and never written, so a check driven to a deliberate
 * failure cannot damage the specification it is checking.
 */
export function staleFixture(
  path: string,
  mutate: (document: Record<string, unknown>) => void,
): string {
  const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(document);
  const directory = mkdtempSync(resolve(tmpdir(), `${basename(path, ".json")}-`));
  const written = resolve(directory, "fixture.json");
  writeFileSync(written, `${JSON.stringify(document)}\n`);
  return written;
}

/** The 624 state words of a `Mt19937State`, in the fixture's hex form. */
export function keyAsHex(key: readonly number[]): string {
  return key.map((word) => word.toString(16).padStart(8, "0")).join("");
}
