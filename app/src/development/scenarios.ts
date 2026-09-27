import { isAdvance, parseScenario, type Scenario } from "@singularity/sim/scenario-format";

import { createSession, type Session } from "../host/session.ts";
import { developmentOnly } from "./only.ts";

import apotheosis from "../../../scenarios/apotheosis.scenario.json";
import commandVocabulary from "../../../scenarios/command-vocabulary.scenario.json";
import cpuStacking from "../../../scenarios/cpu-stacking.scenario.json";
import estate from "../../../scenarios/estate.scenario.json";
import graceFull from "../../../scenarios/grace-full.scenario.json";
import graceQuiet from "../../../scenarios/grace-quiet.scenario.json";
import growingStack from "../../../scenarios/growing-stack.scenario.json";
import headStart from "../../../scenarios/head-start.scenario.json";
import hunted from "../../../scenarios/hunted.scenario.json";
import items from "../../../scenarios/items.scenario.json";
import longPlay from "../../../scenarios/long-play.scenario.json";
import lostEveryBase from "../../../scenarios/lost-every-base.scenario.json";
import lostToSuspicion from "../../../scenarios/lost-to-suspicion.scenario.json";
import midnightSplit from "../../../scenarios/midnight-split.scenario.json";
import pastGrace from "../../../scenarios/past-grace.scenario.json";
import research from "../../../scenarios/research.scenario.json";

developmentOnly("scenario boot");

/**
 * Scenario boot: the application starts by replaying a Scenario instead of an empty game, so
 * a session lands directly in the state under test rather than clicking its way there
 * A Scenario is thereby three things — a fidelity fixture, a save-format
 * exercise, and this.
 *
 * # Why it is a replay and not a load
 *
 * A Save restores a state that was reached; a Scenario boot **re-derives** it, from the seed
 * and the script, drawing every random number on the way. That is what makes a
 * screenshot reproducible by naming its Scenario, and what makes the same file usable by the
 * fidelity harness — a restored state would prove nothing about the run that produced it.
 *
 * The replay drives the Simulation exactly as `sim/test/support/trace.ts` drives it: one
 * `advance` per advance step, one `applyCommand` per Command, in file order. Anything else
 * would change the Tick partition, which is observable, and the state this lands
 * in would stop being the state the fidelity run compares.
 *
 * # Why the parser is the harness's parser
 *
 * A Scenario had two readers in the port and they were two readings: the harness parsed the
 * file, this module cast it to a shape of its own and let `advance` refuse what it could.
 * A step the format forbids and the Simulation accepts — an advance beside a Command, a
 * misspelt field — replayed here without a word, and the page landed in a state no Trace
 * ever bound. So there is one reading now: `@singularity/sim/scenario-format` holds the
 * shape and the parser, and this module calls it.
 *
 * It is a validator, and it does not ship. Nothing outside `app/src/development/` imports
 * it, and `import.meta.env.DEV` folds this module — and the format with it — out of the
 * build whole (`app/scripts/check-development-only.ts`).
 *
 * # Every committed Scenario, one import per file
 *
 * One import per file, spelled out, as `sim/src/content/documents.ts` does it: a bundler
 * resolves a static specifier and not a computed one. The cost of that is that nothing about
 * committing a Scenario adds it to this list, and five of the fifteen there were then had
 * drifted off it —
 * each one committed by a change that needed it at the trace seam and had no reason to open
 * this file. A Scenario the harness can drive and a developer cannot open is half a fixture:
 * the state it reaches has no screenshot and no way to be looked at.
 *
 * So the list is every Scenario in `scenarios/`, with no exception, and
 * `app/test/development-boot.test.tsx` reads the directory and fails when the start screen
 * offers a different set. `long-play` is the largest by a distance and it is here too — it
 * is the only way to open a late game without playing one, and this module does not reach a
 * build, so its size is a development-server concern and not a transfer-budget one.
 */
const DOCUMENTS: readonly unknown[] = [
  apotheosis,
  commandVocabulary,
  cpuStacking,
  estate,
  graceFull,
  graceQuiet,
  growingStack,
  headStart,
  hunted,
  items,
  longPlay,
  lostEveryBase,
  lostToSuspicion,
  midnightSplit,
  pastGrace,
  research,
];

export const SCENARIOS: ReadonlyMap<string, Scenario> = new Map(
  DOCUMENTS.map((document) => parseScenario(document)).map((scenario) => [scenario.id, scenario]),
);

export function scenarioNames(): readonly string[] {
  return [...SCENARIOS.keys()].sort();
}

/** A Session holding the state the named Scenario reaches, with the replay already run. */
export function scenarioSession(id: string): Session {
  const scenario = SCENARIOS.get(id);
  if (scenario === undefined) {
    throw new Error(`no Scenario named ${id}; ${scenarioNames().join(", ")}`);
  }
  return replayScenario(scenario);
}

/** The replay itself, over a Scenario document rather than a name. */
export function replayScenario(document: unknown): Session {
  const scenario = parseScenario(document);
  const session = createSession({
    seed: scenario.seed,
    difficulty: scenario.difficulty,
    origin: { kind: "scenario", id: scenario.id, steps: scenario.script.length },
  });

  scenario.script.forEach((step, index) => {
    const what = isAdvance(step) ? `advance ${step.advanceBy}` : step.command;
    try {
      if (isAdvance(step)) session.tick(step.advanceBy);
      else session.apply(step);
    } catch (cause) {
      throw new Error(`${scenario.id}: step ${index} (${what}) failed`, { cause });
    }
  });
  session.publish();

  return session;
}
