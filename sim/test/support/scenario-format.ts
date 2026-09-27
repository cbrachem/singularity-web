// boundary-intent harness: the Scenario format, and the parser that reads a file into it
import type {
  AllocateCpu,
  BuildBase,
  BuyItem,
  Command,
  DestroyBase,
  RenameBase,
  SwitchPower,
} from "../../src/index.ts";

/**
 * The Scenario file format, on the port's side of the harness — one definition, for both of
 * the port's readers.
 *
 * A Scenario is a seed, a difficulty and an ordered script of steps, each either a time
 * advance or a Command. It is a data file, authored or generated
 * offline; the same file drives the reference recorder in `tools/trace/`.
 *
 * The format itself is documented once, in `tools/trace/scenario.py`, which is its authority.
 * What lives here is the port's reading of it — and `reference-trace.test.ts` checks this
 * table against the recorder's own, so the two cannot drift apart in silence.
 *
 * # Why the format is a file of its own, reachable from `app/`
 *
 * A Scenario has two readers in the port, not one. The trace harness parses every file in
 * `scenarios/` and drives `advance` with it; the development entry point imports the same
 * files and replays them through the Host's Session (`app/src/development/scenarios.ts`).
 * Both need the shape of a step and the rules an advance obeys, and a second copy of either
 * is a copy that can drift from the authority while every gate stays green.
 *
 * So the shape and the rules are here, this file takes no `node:` import, and `sim`'s package
 * manifest exports it as `@singularity/sim/scenario-format`. Reading a Scenario *off disk*
 * stays in `scenario.ts` beside it, which is the harness's alone.
 *
 * Nothing production imports any of it. The development entry point is the only reader in
 * `app/`, and `import.meta.env.DEV` folds that module — and this one with it — out of the
 * shipped bundle whole (`app/scripts/check-development-only.ts`).
 */
export const SCENARIO_FORMAT_VERSION = 1;

export const ADVANCE_FIELD = "advanceBy";

/**
 * The shortest advance a Scenario may carry. One game-second, not zero.
 *
 * Zero is refused rather than allowed and ignored, because it is the one step whose meaning
 * differs between the two things that drive a Scenario. `advance(state, 0)` returns a fresh
 * State root; the Host's `Session.tick(0)` returns without making one, so that a frame worth
 * no game time does not hand Presentation a new root every frame
 * (`app/src/host/session.ts`). A Scenario is replayed through both — through `advance` by the
 * trace harness and through the Session by the development entry point — and a
 * zero-length advance is where the two would silently part company. A step that advances no
 * time also binds nothing in a Trace, so nothing is lost by forbidding it.
 *
 * `tools/trace/scenario.py` is the format's authority and says the same; the two are compared
 * in `reference-trace.test.ts`.
 */
export const ADVANCE_MINIMUM = 1;

const STRING = "string";
const INTEGER = "integer";

type FieldKind = typeof STRING | typeof INTEGER;

export interface CommandShape {
  readonly required: Readonly<Record<string, FieldKind>>;
  readonly optional: Readonly<Record<string, FieldKind>>;
}

/** The six Commands: the input half of the seam. */
export const COMMAND_SHAPES: Readonly<Record<string, CommandShape>> = {
  buildBase: {
    required: { location: STRING, baseType: STRING },
    optional: { name: STRING },
  },
  destroyBase: { required: { location: STRING, base: INTEGER }, optional: {} },
  // `count` is the CPU slot's alone, and this table cannot say so: the slot comes out of
  // Content and the format's authority knows none (`tools/trace/scenario.py`). Both sides
  // refuse it one step later, where the spec is resolved.
  buyItem: {
    required: { location: STRING, base: INTEGER, itemType: STRING },
    optional: { count: INTEGER },
  },
  allocateCpu: { required: { task: STRING, cpu: INTEGER }, optional: {} },
  switchPower: { required: { location: STRING, base: INTEGER }, optional: {} },
  renameBase: { required: { location: STRING, base: INTEGER, name: STRING }, optional: {} },
};

export const COMMAND_NAMES = Object.keys(COMMAND_SHAPES);

export interface AdvanceStep {
  readonly advanceBy: number;
}

/**
 * The Commands themselves are the Simulation's own type, not a second definition of the same
 * union: they are the input half of the seam, so a Scenario parses *into* the
 * vocabulary the Simulation accepts rather than into a parallel one that could drift.
 */
export type { AllocateCpu, BuildBase, BuyItem, Command, DestroyBase, RenameBase, SwitchPower };

export type ScenarioStep = AdvanceStep | Command;

export interface Scenario {
  readonly formatVersion: number;
  readonly id: string;
  readonly description: string;
  readonly seed: number;
  readonly difficulty: string;
  readonly script: readonly ScenarioStep[];
}

export class ScenarioError extends Error {}

export function isAdvance(step: ScenarioStep): step is AdvanceStep {
  return ADVANCE_FIELD in step;
}

export function stepKind(step: ScenarioStep): string {
  return isAdvance(step) ? "advance" : step.command;
}

/**
 * What is wrong with an advance of this length, or `undefined` if nothing is. The rule the
 * development entry point used to restate for itself, in the one place both readers reach.
 */
function advanceFault(seconds: unknown): string | undefined {
  if (!Number.isInteger(seconds)) return `${ADVANCE_FIELD} must be an integer`;
  if ((seconds as number) < ADVANCE_MINIMUM) {
    return `${ADVANCE_FIELD} must be at least ${ADVANCE_MINIMUM} game-second`;
  }
  return undefined;
}

export function parseScenario(raw: unknown, source = "<scenario>"): Scenario {
  const object = asObject(raw, source, "a scenario is an object");

  if (object.formatVersion !== SCENARIO_FORMAT_VERSION) {
    throw new ScenarioError(
      `${source}: formatVersion must be ${SCENARIO_FORMAT_VERSION}, got ${JSON.stringify(object.formatVersion)}`,
    );
  }

  const id = field(object, "id", STRING, source);
  const description = field(object, "description", STRING, source);
  const seed = field(object, "seed", INTEGER, source);
  const difficulty = field(object, "difficulty", STRING, source);

  const script = object.script;
  if (!Array.isArray(script) || script.length === 0) {
    throw new ScenarioError(`${source}: script must be a non-empty array`);
  }

  return {
    formatVersion: SCENARIO_FORMAT_VERSION,
    id: id as string,
    description: description as string,
    seed: seed as number,
    difficulty: difficulty as string,
    script: script.map((step, index) => parseStep(step, `${source}: step ${index}`)),
  };
}

function parseStep(raw: unknown, source: string): ScenarioStep {
  const step = asObject(raw, source, "a step is an object");

  if (ADVANCE_FIELD in step) {
    if ("command" in step) {
      throw new ScenarioError(`${source}: a step is either an advance or a command, not both`);
    }
    const fault = advanceFault(step[ADVANCE_FIELD]);
    if (fault !== undefined) throw new ScenarioError(`${source}: ${fault}`);
    rejectExtras(step, [ADVANCE_FIELD], source);
    return { advanceBy: step[ADVANCE_FIELD] as number };
  }

  const command = step.command;
  if (typeof command !== "string" || !(command in COMMAND_SHAPES)) {
    throw new ScenarioError(
      `${source}: unknown command ${JSON.stringify(command)}; expected one of ${COMMAND_NAMES.join(", ")}`,
    );
  }

  const shape = COMMAND_SHAPES[command]!;
  for (const [name, kind] of Object.entries(shape.required)) field(step, name, kind, source);
  for (const [name, kind] of Object.entries(shape.optional)) {
    if (name in step) field(step, name, kind, source);
  }
  rejectExtras(
    step,
    ["command", ...Object.keys(shape.required), ...Object.keys(shape.optional)],
    source,
  );
  return step as unknown as Command;
}

function asObject(raw: unknown, source: string, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ScenarioError(`${source}: ${what}, got ${raw === null ? "null" : typeof raw}`);
  }
  return raw as Record<string, unknown>;
}

function field(
  object: Record<string, unknown>,
  name: string,
  kind: FieldKind,
  source: string,
): unknown {
  if (!(name in object)) throw new ScenarioError(`${source}: missing ${JSON.stringify(name)}`);
  const value = object[name];
  if (kind === STRING && typeof value !== "string") {
    throw new ScenarioError(`${source}: ${JSON.stringify(name)} must be a string`);
  }
  if (kind === INTEGER && !Number.isInteger(value)) {
    throw new ScenarioError(`${source}: ${JSON.stringify(name)} must be an integer`);
  }
  return value;
}

function rejectExtras(
  step: Record<string, unknown>,
  allowed: readonly string[],
  source: string,
): void {
  const extras = Object.keys(step)
    .filter((key) => !allowed.includes(key))
    .sort();
  if (extras.length > 0) {
    throw new ScenarioError(`${source}: unexpected field(s) ${extras.join(", ")}`);
  }
}
