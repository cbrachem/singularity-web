// boundary-intent simulation: records, compares and replays a diverging step through advance
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  advance,
  fromPlain,
  projectDerived,
  projectPersistent,
  type PlainState,
} from "../../src/index.ts";
import { recordComparison } from "./ledger.ts";
import type { ReferenceRecord, ReferenceTrace } from "./oracle.ts";
import { normalise, type NormalisationContext, type RecordPair } from "./normalisation.ts";
import { repoRoot, type Scenario, type ScenarioStep } from "./scenario.ts";
import {
  asReferenceEffect,
  comparableParts,
  type ComparableRecord,
  type PortRecord,
  type PortTrace,
} from "./trace.ts";

/**
 * The differ, and what a divergence leaves behind.
 *
 * Two rules shape all of it. **Comparison is exact equality on integers,
 * strings and booleans, with no tolerance anywhere** — the serialized state has no
 * floating-point value in it at all, so a non-integral number is not a near miss, it is a
 * difference in its own right and is reported as one. And **the run stops at the first
 * differing step and reports the first differing path within the record**, because
 * everything after a divergence is noise: one displaced draw carries the whole later stream
 * with it.
 */

export interface Difference {
  /** Where inside the record, e.g. `persistent.player.locations[3].bases[0].name`. */
  readonly path: string;
  readonly port: unknown;
  readonly reference: unknown;
  readonly why: string;
}

function describe(value: unknown): string {
  return typeof value === "object" && value !== null
    ? Array.isArray(value)
      ? `an array of ${value.length}`
      : `an object with ${Object.keys(value).length} field(s)`
    : JSON.stringify(value);
}

/**
 * The first place two records differ, walking them in a fixed order: array elements in
 * order, object fields by sorted name. `undefined` means they are equal.
 */
export function firstDifference(
  port: unknown,
  reference: unknown,
  path = "",
): Difference | undefined {
  const at = (why: string): Difference => ({ path: path || "<record>", port, reference, why });

  if (typeof port === "number" || typeof reference === "number") {
    if (typeof port !== "number" || typeof reference !== "number") return at("one is a number");
    // No tolerance policy anywhere, and none is needed: measured against the reference, the
    // compared surface holds no floating-point value at all.
    if (!Number.isInteger(port)) return at("the port's value is not a whole number");
    if (!Number.isInteger(reference)) return at("the reference's value is not a whole number");
    return port === reference ? undefined : at("they differ");
  }

  if (port === null || reference === null) {
    return port === reference ? undefined : at("one is null");
  }

  if (Array.isArray(port) || Array.isArray(reference)) {
    if (!Array.isArray(port) || !Array.isArray(reference)) return at("one is a list");
    if (port.length !== reference.length) {
      return at(`the port has ${port.length} entries, the reference ${reference.length}`);
    }
    for (const [index, entry] of port.entries()) {
      const difference = firstDifference(entry, reference[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return undefined;
  }

  if (typeof port === "object" || typeof reference === "object") {
    if (typeof port !== "object" || typeof reference !== "object") return at("one is an object");
    const portKeys = Object.keys(port).sort();
    const referenceKeys = Object.keys(reference).sort();
    const onlyPort = portKeys.filter((key) => !referenceKeys.includes(key));
    const onlyReference = referenceKeys.filter((key) => !portKeys.includes(key));
    if (onlyPort.length > 0) {
      return at(`the port has field(s) the reference does not: ${onlyPort.join(", ")}`);
    }
    if (onlyReference.length > 0) {
      return at(`the reference has field(s) the port does not: ${onlyReference.join(", ")}`);
    }
    for (const key of portKeys) {
      const difference = firstDifference(
        (port as Record<string, unknown>)[key],
        (reference as Record<string, unknown>)[key],
        path === "" ? key : `${path}.${key}`,
      );
      if (difference) return difference;
    }
    return undefined;
  }

  return port === reference ? undefined : at("they differ");
}

export function explain(difference: Difference): string {
  return (
    `${difference.path}: ${difference.why}\n` +
    `  port      ${describe(difference.port)}\n` +
    `  reference ${describe(difference.reference)}`
  );
}

export interface Divergence {
  readonly scenarioId: string;
  readonly step: number;
  readonly kind: string;
  readonly difference: Difference;
  /** Where the standalone fixture was written. */
  readonly fixture: string;
}

export const FIXTURE_DIRECTORY = "sim/test/fixtures/divergences";
export const FIXTURE_SUFFIX = ".fixture.json";
export const FIXTURE_FORMAT_VERSION = 1;

/**
 * A divergent step, complete enough to replay on its own.
 *
 * The input state carries the generator, so the step needs neither Python nor a
 * replay from the beginning of the Scenario — which is what makes it a regression test
 * rather than a note about one.
 */
export interface DivergenceFixture {
  readonly formatVersion: number;
  readonly scenario: string;
  readonly step: number;
  readonly kind: string;
  /** The path that differed when the fixture was written. Prose, not a comparison. */
  readonly path: string;
  readonly applied: ScenarioStep;
  readonly input: PlainState;
  /** The reference's record for this step, after every Normalisation. */
  readonly expected: ComparableRecord;
  readonly context: NormalisationContext;
}

export function writeFixture(fixture: DivergenceFixture): string {
  const directory = resolve(repoRoot, FIXTURE_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `${fixture.scenario}-step-${fixture.step}${FIXTURE_SUFFIX}`);
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  return path;
}

export function fixturePaths(): string[] {
  const directory = resolve(repoRoot, FIXTURE_DIRECTORY);
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(FIXTURE_SUFFIX))
      .sort()
      .map((name) => resolve(directory, name));
  } catch {
    return [];
  }
}

/** One step of a Scenario, replayed from a fixture. Nothing Python, nothing before it. */
export function replayFixture(fixture: DivergenceFixture): Difference | undefined {
  const step = fixture.applied;
  if (!("advanceBy" in step)) {
    throw new Error(`${fixture.scenario} step ${fixture.step}: only advances replay so far`);
  }
  const result = advance(fromPlain(fixture.input), step.advanceBy);
  const port: PortRecord = {
    step: fixture.step,
    kind: fixture.kind,
    persistent: projectPersistent(result.state),
    derived: projectDerived(result.state),
    effects: result.effects.map(asReferenceEffect),
    draws: [],
    input: fixture.input,
    applied: step,
  };
  const reference = {
    step: fixture.step,
    kind: fixture.kind,
    ...fixture.expected,
  } as unknown as ReferenceRecord;

  const normalised = normalise({ port, reference }, fixture.context);
  return firstDifference(comparableParts(normalised.port), comparableParts(normalised.reference));
}

export interface Comparison {
  readonly scenario: Scenario;
  readonly port: PortTrace;
  readonly reference: ReferenceTrace;
}

/**
 * Refuse a comparison whose label is not what the two runs say they ran.
 *
 * The seeds have separate provenance and hold the two streams to one value (deviation 2), but
 * a seed does not name a game: several committed Scenarios carry the same one. So a caller
 * that records both Traces from Scenario a and labels the comparison b compares two matching
 * Traces, and b — whose file never ran — is what the ledger, the fixture and the Divergence
 * all carry. Each Trace says which Scenario it ran instead, and the label is held to both
 * before the loop, where it is a harness error rather than a divergence.
 */
function demandLabel(scenario: Scenario, side: string, ran: string): void {
  if (ran === scenario.id) return;
  throw new Error(
    `the ${side}'s Trace says it ran ${ran}, and it is being compared as ${scenario.id}. The ` +
      `label is what the ledger and any fixture carry, so a comparison of one game under ` +
      `another game's name would record a Scenario whose file never ran.`,
  );
}

/**
 * Compare a Scenario's two traces step by step and stop at the first difference, writing the
 * failing step out as a fixture. `undefined` means every part of every record matched.
 *
 * The comparison names the Scenario the **port's run** says it drove in the ledger before it
 * starts, so a check after the run can say which Scenarios the gate really compared rather
 * than which ones its suites look like they compare (`ledger.ts`). It is what the run
 * produced rather than the argument it was labelled with, and it is written first because a
 * comparison that throws still happened, and the run is red either way.
 */
export function compareTraces({ scenario, port, reference }: Comparison): Divergence | undefined {
  recordComparison({ scenario: port.scenario });

  demandLabel(scenario, "port", port.scenario);
  demandLabel(scenario, "reference", reference.scenario);

  if (port.records.length !== reference.records.length) {
    throw new Error(
      `${scenario.id}: the port produced ${port.records.length} record(s) and the reference ` +
        `${reference.records.length}`,
    );
  }

  let previousGameTime = 0;
  for (const [index, portRecord] of port.records.entries()) {
    const referenceRecord = reference.records[index] as ReferenceRecord;
    // Neither seed is read off the Scenario argument, and that is the whole of what makes
    // deviation 2's check evidence: `portSeed` is what `recordTrace` reported it created the
    // State root with, `referenceSeed` what the recorder reported it installed. Taking
    // either from the Scenario would compare that argument to itself, and a Trace of one
    // game handed to a comparison of another would pass.
    const context: NormalisationContext = {
      scenarioId: scenario.id,
      portSeed: port.seed,
      referenceSeed: reference.seed,
      previousGameTime,
    };
    const pair: RecordPair = { port: portRecord, reference: referenceRecord };
    const normalised = normalise(pair, context);

    const difference = firstDifference(
      comparableParts(normalised.port),
      comparableParts(normalised.reference),
    );
    if (difference) {
      const fixture = writeFixture({
        formatVersion: FIXTURE_FORMAT_VERSION,
        scenario: scenario.id,
        step: index,
        kind: portRecord.kind,
        path: difference.path,
        applied: portRecord.applied,
        input: portRecord.input,
        expected: comparableParts(normalised.reference),
        context,
      });
      return { scenarioId: scenario.id, step: index, kind: portRecord.kind, difference, fixture };
    }

    previousGameTime = referenceRecord.persistent.game_time as number;
  }
  return undefined;
}
