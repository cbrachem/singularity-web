// boundary-intent harness: transforms records that are already recorded, and drives nothing
import type { SavedObject } from "../../src/index.ts";
import { DEVIATION_REGISTER, deviation, type Deviation } from "./deviations.ts";
import type { ReferenceEffect, ReferenceRecord } from "./oracle.ts";
import type { PortRecord } from "./trace.ts";

/**
 * Normalisations: the transformations that cancel a Deviation before two records are
 * compared.
 *
 * One rule is the whole point of this file. **Each entry in the deviation
 * register gets exactly one, and a Normalisation without a register entry is refused.** The
 * failure mode it exists to prevent is a per-field allowlist, which would be convenient and
 * would grow quietly until the comparison checked nothing — so the registry below is built
 * through `deviation()`, which throws on an id the register does not have, and the suite
 * checks the pairing is 1:1 in both directions.
 *
 * A Normalisation may also **refuse**. Two of the five register entries are deliberately
 * outside the compared surface — the generator is seeded before the run and stored beside the
 * state, not in it — a third is only observable when a Scenario partitions time in a way
 * the port's own scheduler never does, and a fourth only when a Scenario allocates past the
 * cap the port enforces. For those, cancelling means *establishing that the
 * difference stayed outside*, and refusing when it did not. That can hide nothing: a
 * refusal stops the run with an explanation, where a rewrite could quietly widen it.
 */

export interface RecordPair {
  readonly port: PortRecord;
  readonly reference: ReferenceRecord;
}

export interface NormalisationContext {
  readonly scenarioId: string;
  /**
   * The seed each side's generator was started from. Deviation 2 is why they exist, and
   * neither is read off the Scenario the comparison is labelled with — each is what its own
   * run reported: `portSeed` is what `recordTrace` created the State root with
   * (`PortTrace.seed`), `referenceSeed` what the recorder said it installed
   * (`ReferenceTrace.seed`). A comparison whose two Traces are runs of different games is
   * what they catch, from either side.
   */
  readonly portSeed: number;
  readonly referenceSeed: number;
  /** The reference's `game_time` before this step, so a discarded remainder is visible. */
  readonly previousGameTime: number;
}

export interface Normalisation {
  readonly deviation: Deviation;
  readonly name: string;
  /** What this transformation does, in one sentence, for the message a refusal carries. */
  readonly what: string;
  apply(pair: RecordPair, context: NormalisationContext): RecordPair;
}

export class NormalisationRefused extends Error {
  readonly normalisation: string;

  constructor(normalisation: string, why: string) {
    super(`${normalisation}: ${why}`);
    this.name = "NormalisationRefused";
    this.normalisation = normalisation;
  }
}

function define(
  id: number,
  name: string,
  what: string,
  apply: Normalisation["apply"],
): Normalisation {
  return { deviation: deviation(id), name, what, apply };
}

const AUTOSAVE = "auto_save";

/** Move the autosave to the end of the list, keeping everything else in order. */
function autosaveLast(effects: readonly ReferenceEffect[]): readonly ReferenceEffect[] {
  const saves = effects.filter((effect) => effect.name === AUTOSAVE);
  if (saves.length === 0) return effects;
  return [...effects.filter((effect) => effect.name !== AUTOSAVE), ...saves];
}

const GENERATOR_FIELDS = ["rng", "random_state", "generator", "seed"];

function generatorFieldIn(persistent: SavedObject): string | undefined {
  const player = persistent.player;
  const inPlayer =
    player && typeof player === "object" && !Array.isArray(player) ? (player as SavedObject) : {};
  return GENERATOR_FIELDS.find((field) => field in persistent || field in inPlayer);
}

export const NORMALISATIONS: readonly Normalisation[] = [
  define(
    1,
    "midnight-break",
    "refuses a step in which the reference discarded a day-crossing remainder",
    (pair, context) => {
      const now = pair.reference.persistent.game_time as number;
      const expected = context.previousGameTime + advanceOf(pair);
      if (now === expected) return pair;
      const discarded = expected - now;
      throw new NormalisationRefused(
        "midnight-break",
        `step ${pair.port.step} of ${context.scenarioId} crossed midnight: the reference ` +
          `stopped at ${now} and dropped ${discarded} game-second(s), while the port carried ` +
          `them forward. The deviation is a difference in the clock itself, so no ` +
          `transformation of the two records can cancel it — partition the step at the day ` +
          `boundary, which is what the scheduler does in play.`,
      );
    },
  ),
  define(
    2,
    "seeded-stream",
    "holds the two seeds the two runs reported to one value",
    (pair, context) => {
      if (context.portSeed === context.referenceSeed) return pair;
      throw new NormalisationRefused(
        "seeded-stream",
        `the port was seeded from ${context.portSeed} and the reference reported running ` +
          `with ${context.referenceSeed}. Upstream never seeds at all, so the reference is ` +
          `reproducible only because the harness seeds it from the Scenario — two different ` +
          `seeds are two different games, not a divergence.`,
      );
    },
  ),
  define(
    3,
    "autosave-at-end-of-tick",
    "moves the autosave to the end of the step's effect list on both sides",
    (pair) => ({
      port: { ...pair.port, effects: autosaveLast(pair.port.effects) },
      reference: { ...pair.reference, effects: autosaveLast(pair.reference.effects) },
    }),
  ),
  define(
    4,
    "generator-outside-the-save",
    "holds the generator out of the persistent half, where the save keeps it beside",
    (pair, context) => {
      for (const [side, record] of [
        ["port", pair.port],
        ["reference", pair.reference],
      ] as const) {
        const field = generatorFieldIn(record.persistent as SavedObject);
        if (field !== undefined) {
          throw new NormalisationRefused(
            "generator-outside-the-save",
            `the ${side} record of step ${record.step} of ${context.scenarioId} carries ` +
              `${field} in its persistent half. The port's Save keeps the generator beside ` +
              `the state so the state stays byte-identical to a Trace record; a generator ` +
              `inside it is a schema change, not a deviation.`,
          );
        }
      }
      return pair;
    },
  ),
  define(
    5,
    "allocation-under-the-cap",
    "refuses a step in which the reference stored an allocation the port clamped",
    (pair, context) => {
      const step = pair.port.applied;
      if (!("command" in step) || step.command !== "allocateCpu") return pair;
      const port = usageIn(pair.port.persistent as SavedObject);
      const reference = usageIn(pair.reference.persistent as SavedObject);
      const clamped = Object.keys(reference).filter(
        (task) => (reference[task] ?? 0) > (port[task] ?? 0),
      );
      if (clamped.length === 0) return pair;
      throw new NormalisationRefused(
        "allocation-under-the-cap",
        `step ${pair.port.step} of ${context.scenarioId} allocated past the CPU the estate ` +
          `carries: the reference stored ${clamped
            .map((task) => `${task}=${reference[task]}`)
            .join(", ")} where the port clamped to ${clamped
            .map((task) => `${port[task] ?? 0}`)
            .join(", ")}. The cap is the port's own rule (deviation 5), so no ` +
          `transformation of the two records can cancel it — keep the Scenario under ` +
          `calc_cpu_left, as upstream's own screen does.`,
      );
    },
  ),
];

function usageIn(persistent: SavedObject): Record<string, number> {
  const player = persistent.player;
  const inPlayer =
    player && typeof player === "object" && !Array.isArray(player) ? (player as SavedObject) : {};
  const usage = inPlayer.cpu_usage;
  return usage && typeof usage === "object" && !Array.isArray(usage)
    ? (usage as Record<string, number>)
    : {};
}

function advanceOf(pair: RecordPair): number {
  const step = pair.port.applied;
  return "advanceBy" in step ? step.advanceBy : 0;
}

/** Apply every Normalisation, in register order, to one step's pair of records. */
export function normalise(pair: RecordPair, context: NormalisationContext): RecordPair {
  return NORMALISATIONS.reduce(
    (current, normalisation) => normalisation.apply(current, context),
    pair,
  );
}

/**
 * The binding, checked rather than trusted: one Normalisation per register entry, no entry
 * without one, and no Normalisation naming an entry that is not there. `deviation()` already
 * refuses the last of those at construction; this reports all three together.
 */
export function bindingProblems(): string[] {
  const problems: string[] = [];
  for (const entry of DEVIATION_REGISTER) {
    const matching = NORMALISATIONS.filter(
      (normalisation) => normalisation.deviation.id === entry.id,
    );
    if (matching.length === 0) problems.push(`deviation ${entry.id} has no Normalisation`);
    if (matching.length > 1) {
      problems.push(
        `deviation ${entry.id} has ${matching.length} Normalisations: ` +
          matching.map((normalisation) => normalisation.name).join(", "),
      );
    }
  }
  for (const normalisation of NORMALISATIONS) {
    if (!DEVIATION_REGISTER.some((entry) => entry.id === normalisation.deviation.id)) {
      problems.push(`${normalisation.name} names deviation ${normalisation.deviation.id}`);
    }
  }
  return problems;
}
