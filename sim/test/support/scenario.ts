// boundary-intent harness: finds the checkout and reads Scenario files off disk
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SCENARIO_FORMAT_VERSION,
  ScenarioError,
  parseScenario,
  type Scenario,
} from "./scenario-format.ts";

/**
 * Reading a Scenario off disk: the half of the format that is the harness's alone.
 *
 * The format itself — the shape of a step, the rules an advance obeys, and the parser that
 * reads one into them — is `scenario-format.ts` beside this file, because the development
 * entry point reads Scenarios too and cannot reach a `node:fs`. It is re-exported
 * here so a suite has one import for both halves.
 */
export {
  ADVANCE_FIELD,
  ADVANCE_MINIMUM,
  COMMAND_NAMES,
  COMMAND_SHAPES,
  SCENARIO_FORMAT_VERSION,
  ScenarioError,
  isAdvance,
  parseScenario,
  stepKind,
} from "./scenario-format.ts";

export type {
  AdvanceStep,
  AllocateCpu,
  BuildBase,
  BuyItem,
  Command,
  CommandShape,
  DestroyBase,
  RenameBase,
  Scenario,
  ScenarioStep,
  SwitchPower,
} from "./scenario-format.ts";

export const SCENARIO_SUFFIX = ".scenario.json";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const scenarioDirectory = resolve(repoRoot, "scenarios");

export function scenarioPaths(): string[] {
  return readdirSync(scenarioDirectory)
    .filter((name) => name.endsWith(SCENARIO_SUFFIX))
    .sort()
    .map((name) => resolve(scenarioDirectory, name));
}

export function loadScenario(path: string): Scenario {
  const source = path.slice(path.lastIndexOf("/") + 1);
  const scenario = parseScenario(JSON.parse(readFileSync(path, "utf8")), source);
  const expected = source.slice(0, -SCENARIO_SUFFIX.length);
  if (scenario.id !== expected) {
    throw new ScenarioError(`${source}: id is ${scenario.id}; the file name carries the id`);
  }
  return scenario;
}

/** A Scenario of nothing but time advances, for the tests that only need a clock. */
export function advances(...gameSeconds: readonly number[]): Scenario {
  return {
    formatVersion: SCENARIO_FORMAT_VERSION,
    id: "advances",
    description: "time only",
    seed: 0,
    difficulty: "normal",
    script: gameSeconds.map((advanceBy) => ({ advanceBy })),
  };
}
