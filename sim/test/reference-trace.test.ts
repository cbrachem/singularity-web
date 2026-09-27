// boundary-intent harness: spawns the reference recorder and asserts on its output
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  checkManifest,
  oracleAvailable,
  oracleRequired,
  referenceEffectSurface,
  referenceFormat,
  referenceTrace,
  runOracle,
  type Draw,
  type EffectSite,
  type EffectSurface,
  type ReferenceRecord,
} from "./support/oracle.ts";
import {
  ADVANCE_FIELD,
  ADVANCE_MINIMUM,
  COMMAND_NAMES,
  COMMAND_SHAPES,
  SCENARIO_FORMAT_VERSION,
  SCENARIO_SUFFIX,
  ScenarioError,
  loadScenario,
  parseScenario,
  repoRoot,
  scenarioDirectory,
  scenarioPaths,
  stepKind,
  type Scenario,
} from "./support/scenario.ts";
import { LEDGER_VARIABLE, comparedScenarios, writeComparison } from "./support/ledger.ts";

// The trace seam, on the Oracle's side: a Scenario goes in and the pinned reference emits a
// Trace. Nothing here reaches inside the reference — it is driven through the
// same script the port will be driven through, and only what comes out is asserted.

// Driving the Oracle needs the Python environment in `.venv`. A working copy without one skips these rather than
// failing on setup it does not have; CI sets SINGULARITY_ORACLE_REQUIRED, so there the
// absence is a failure and the tests cannot quietly stop running.
const runsTheOracle = oracleAvailable || oracleRequired;
const describeOracle = describe.skipIf(!runsTheOracle);
const itOracle = it.skipIf(!runsTheOracle);

/**
 * One check below runs the fidelity gate as a child process and reads the ledger it wrote.
 * The gate's filters do not reach this file, so the child never runs this check again — and
 * were that to change, the ledger variable in the environment says the run is already the
 * observed one, and the check stands down rather than recursing.
 */
const runsTheGate = runsTheOracle && process.env[LEDGER_VARIABLE] === undefined;
const itGate = it.skipIf(!runsTheGate);

/** The gate is a whole vitest run of its own; a working copy under load is slower than CI. */
const GATE_TIMEOUT = 300_000;

const scenarios: readonly Scenario[] = scenarioPaths().map(loadScenario);

const traces = new Map<string, ReturnType<typeof referenceTrace>>();

let surface: EffectSurface | undefined;
const effectSurface = () => (surface ??= referenceEffectSurface());

function scenarioPath(scenario: Scenario): string {
  return `scenarios/${scenario.id}${SCENARIO_SUFFIX}`;
}

function trace(scenario: Scenario) {
  const cached = traces.get(scenario.id);
  if (cached) return cached;
  const fresh = referenceTrace(scenarioPath(scenario));
  traces.set(scenario.id, fresh);
  return fresh;
}

const KNOWN_DRAW_FUNCTIONS = ["random", "randint", "choice", "shuffle"];

/** The committed Scenarios whose script uses every one of the six Commands. */
function completeScenarios(): readonly Scenario[] {
  return scenarios.filter((scenario) => {
    const used = new Set(scenario.script.map(stepKind));
    return COMMAND_NAMES.every((name) => used.has(name));
  });
}

/**
 * A directory a check writes a probe tree into, removed when this file is done with it.
 *
 * Several checks here read a real tree and pass when they find nothing in it. Each of those
 * has a second check beside it that puts the same reading to a tree written for the purpose,
 * so a walk that silently found nothing at all cannot look like a clean repository.
 */
const probes: string[] = [];

afterAll(() => {
  for (const directory of probes) rmSync(directory, { recursive: true, force: true });
});

function probeDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  probes.push(directory);
  return directory;
}

describe("the Scenario format", () => {
  it("has scenarios to drive", () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  it("carries a seed, a difficulty and an ordered script", () => {
    for (const scenario of scenarios) {
      expect(scenario.formatVersion).toBe(SCENARIO_FORMAT_VERSION);
      expect(Number.isInteger(scenario.seed)).toBe(true);
      expect(scenario.difficulty).toMatch(/\S/);
      expect(scenario.script.length).toBeGreaterThan(0);
    }
  });

  // Every Command, in *one* Scenario. The union over all of them was what this held before,
  // and the two are not the same claim: six Scenarios reaching one Command each say nothing
  // about a run that uses the vocabulary together, and today only one Scenario does
  // (`estate` is the other holder of `renameBase`, so the union stays green without it).
  it("represents all six Commands, and one Scenario uses every one of them", () => {
    expect(COMMAND_NAMES).toHaveLength(6);

    expect(
      completeScenarios().map((scenario) => scenario.id),
      `no committed Scenario uses all six of ${COMMAND_NAMES.join(", ")}`,
    ).not.toEqual([]);
  });

  // And that Scenario is compared against the reference rather than merely parsed. A script
  // reaching every Command proves nothing on its own; what the spec asks for is a run that
  // uses the whole vocabulary *and matches*.
  //
  // So the gate is run, and what it compared is read back off the ledger every `compareTraces`
  // writes into. The suites' source is a proxy with holes on both sides: a suite that keeps
  // an id at module scope and compares a different Scenario would count, and one that builds
  // the id from parts would count for nothing.
  // Here the run is the witness, and the run is the gate itself, so "in a suite the gate
  // reaches" needs no separate check — a Scenario in this ledger was compared by the gate.
  itGate(
    "compares that Scenario against the reference, in a run of the fidelity gate",
    () => {
      const ledger = probeDirectory("comparison-ledger-");
      // The gate itself, on one worker: `bun run test` runs this file beside the rest of the
      // suite, and a child that takes the machine starves the parent. No timeout is generous
      // enough to make that a good idea. The worker count is the only thing added — the suites
      // are the gate's own, out of `package.json`, and what they compare is what this reads
      // back.
      //
      // The Oracle goes in as *required* whatever this checkout does, so the gate cannot skip
      // its comparisons and hand back an empty ledger that reads like a gate comparing nothing.
      const gate = spawnSync("bun", ["run", FIDELITY_SCRIPT, "--maxWorkers=1"], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, [LEDGER_VARIABLE]: ledger, SINGULARITY_ORACLE_REQUIRED: "1" },
      });
      expect(gate.status, `${gate.stdout ?? ""}\n${gate.stderr ?? ""}`).toBe(0);

      const compared = comparedScenarios(ledger);
      expect(compared, `${FIDELITY_SCRIPT} compared no Scenario at all`).not.toEqual([]);

      const complete = completeScenarios().map((scenario) => scenario.id);
      expect(
        compared.filter((id) => complete.includes(id)),
        `${FIDELITY_SCRIPT} compared ${compared.join(", ")}; none of them uses every Command`,
      ).not.toEqual([]);
    },
    GATE_TIMEOUT,
  );

  // The reading has to be able to say no, or the check above proves nothing: a run that wrote
  // no ledger at all and a run that compared everything look alike to a reader that cannot
  // tell them apart. So the same reading is put to ledgers written here — one that is not
  // there, an empty one, and one naming Scenarios twice over.
  it("reads back what a run compared, and says nothing of a run that compared nothing", () => {
    const empty = probeDirectory("comparison-ledger-empty-");
    expect(comparedScenarios(join(empty, "never-written"))).toEqual([]);
    expect(comparedScenarios(empty)).toEqual([]);

    const written = probeDirectory("comparison-ledger-written-");
    writeComparison(written, { scenario: "grace-quiet" });
    writeComparison(written, { scenario: "estate" });
    writeComparison(written, { scenario: "grace-quiet" });
    expect(comparedScenarios(written)).toEqual(["estate", "grace-quiet"]);
  });

  itOracle("is one format: the port parses what the recorder applies", () => {
    expect(referenceFormat()).toEqual({
      formatVersion: SCENARIO_FORMAT_VERSION,
      advanceField: ADVANCE_FIELD,
      advanceMinimum: ADVANCE_MINIMUM,
      commands: COMMAND_SHAPES,
    });
  });

  it("rejects a step that is neither an advance nor one of the six", () => {
    const withStep = (step: unknown) => ({
      formatVersion: SCENARIO_FORMAT_VERSION,
      id: "x",
      description: "x",
      seed: 0,
      difficulty: "normal",
      script: [step],
    });

    expect(() => parseScenario(withStep({ command: "moveBase", location: "N AMERICA" }))).toThrow(
      ScenarioError,
    );
    expect(() => parseScenario(withStep({ command: "renameBase", location: "N AMERICA" }))).toThrow(
      /missing "base"/,
    );
    expect(() => parseScenario(withStep({ advanceBy: 60, command: "switchPower" }))).toThrow(
      /not both/,
    );
    expect(() => parseScenario(withStep({ advanceBy: 1.5 }))).toThrow(/must be an integer/);
  });

  // A step that advances no time is the one step the two ends of the port read differently:
  // `advance(state, 0)` returns a fresh root and `Session.tick(0)` returns without making
  // one, so a Scenario carrying one would boot into a state the trace harness did not derive
  // (app/src/development/scenarios.ts). The format refuses it instead, on both sides.
  it("refuses an advance of no time at all", () => {
    const withStep = (step: unknown) => ({
      formatVersion: SCENARIO_FORMAT_VERSION,
      id: "x",
      description: "x",
      seed: 0,
      difficulty: "normal",
      script: [step],
    });

    expect(() => parseScenario(withStep({ advanceBy: 0 }))).toThrow(ScenarioError);
    expect(() => parseScenario(withStep({ advanceBy: 0 }))).toThrow(/at least 1/);
    expect(() => parseScenario(withStep({ advanceBy: -1 }))).toThrow(/at least 1/);
    expect(parseScenario(withStep({ advanceBy: 1 })).script).toEqual([{ advanceBy: 1 }]);
  });
});

// `count` is `buyItem`'s optional field, and the CPU slot is the only slot that has one.
// Upstream's own caller passes one for every other slot (`screens/base.py:583`), so a
// reactor, network or security item is built exactly once whatever the dialog asked.
//
// The tables above cannot refuse it. What a `count` means depends on the item's slot, the
// slot comes out of Content, and both parsers are deliberately Content-free — `scenario.py`
// is the format's authority and importing the reference into it would turn the dependency
// the recorder already has around. So the refusal sits one step later, on each side, in the
// place that has already resolved the spec: `_cmd_buyItem` here and `buyItem` in
// `sim/src/command.ts`. The port's half of it is in `items.trace.test.ts`.
describeOracle("a count on a slot that has no count", () => {
  const REACTOR = "Diesel Generator";
  const written: string[] = [];

  afterAll(() => {
    for (const directory of written) rmSync(directory, { recursive: true, force: true });
  });

  function scenarioFile(id: string, buy: Record<string, unknown>): string {
    const directory = mkdtempSync(join(tmpdir(), "scenario-count-"));
    written.push(directory);
    const path = join(directory, `${id}${SCENARIO_SUFFIX}`);
    writeFileSync(
      path,
      JSON.stringify({
        formatVersion: SCENARIO_FORMAT_VERSION,
        id,
        description: "a probe, written for this test and never committed",
        seed: 1,
        difficulty: "normal",
        script: [
          { command: "buildBase", location: "N AMERICA", baseType: "Server Access", name: "Probe" },
          { command: "buyItem", location: "N AMERICA", base: 0, itemType: REACTOR, ...buy },
        ],
      }),
      "utf8",
    );
    return path;
  }

  function record(path: string) {
    return runOracle(["-m", "tools.trace.record", path]);
  }

  function lines(stdout: string): string[] {
    return stdout.split("\n").filter((line) => line.length > 0);
  }

  it("parses, which is why the recorder is where it has to be caught", () => {
    // The trap the refusal closes: a Scenario carrying a count for a reactor is a
    // well-formed Scenario, so nothing before the run has anything to say about it.
    const path = scenarioFile("counted-reactor-parses", { count: 3 });
    expect(loadScenario(path).script).toHaveLength(2);
  });

  it("is refused by the recorder rather than read as one", () => {
    const refused = record(scenarioFile("counted-reactor", { count: 3 }));

    expect(refused.status, refused.stderr).not.toBe(0);
    expect(refused.stderr).toMatch(/only for the cpu slot/);
    // The recorder writes a line per step as it goes, so the build before it is on stdout
    // and the refused step is not: what a Scenario cannot do records nothing.
    expect(lines(refused.stdout)).toHaveLength(1);
  });

  it("refuses a count of one too, which is the value that means what absence means", () => {
    const refused = record(scenarioFile("counted-reactor-one", { count: 1 }));

    expect(refused.status, refused.stderr).not.toBe(0);
    expect(refused.stderr).toMatch(/only for the cpu slot/);
  });

  it("records the same step without one, so it is the count that is refused", () => {
    const accepted = record(scenarioFile("uncounted-reactor", {}));

    expect(accepted.status, accepted.stderr).toBe(0);
    expect(lines(accepted.stdout)).toHaveLength(2);
  });
});

describeOracle("the reference recorder", () => {
  it("emits one record per Scenario step, in order", () => {
    for (const scenario of scenarios) {
      const { records } = trace(scenario);
      expect(records.map((record) => record.step)).toEqual(scenario.script.map((_, i) => i));
      expect(records.map((record) => record.kind)).toEqual(scenario.script.map(stepKind));
    }
  });

  it("carries persistent state, derived state, the effect list and the draw log", () => {
    for (const scenario of scenarios) {
      for (const record of trace(scenario).records) {
        expect(Object.keys(record).sort()).toEqual([
          "derived",
          "draws",
          "effects",
          "kind",
          "persistent",
          "step",
        ]);
        expect(record.persistent).toMatchObject({
          difficulty: scenario.difficulty,
          game_time: expect.any(Number),
        });
        expect(record.persistent.player).toBeTypeOf("object");
        expect(record.persistent.stats).toBeTypeOf("object");
        expect(Object.keys(record.derived).sort()).toEqual([
          "apotheosis",
          "available_cpus",
          "cpu_pool",
          "display_discover",
          "income",
          "interest_rate",
          "job_bonus",
          "labor_bonus",
          "sleeping_cpus",
        ]);
        expect(Array.isArray(record.effects)).toBe(true);
        expect(Array.isArray(record.draws)).toBe(true);
      }
    }
  });

  it("records the draw log as (function, result) in order, and no call sites", () => {
    const drawn = scenarios.flatMap((scenario) => trace(scenario).records.flatMap((r) => r.draws));
    expect(drawn.length).toBeGreaterThan(0);
    for (const draw of drawn) {
      expect(Array.isArray(draw)).toBe(true);
      // Two elements exactly: a third would be where a call site went.
      expect(draw).toHaveLength(2);
      expect(KNOWN_DRAW_FUNCTIONS).toContain(draw[0]);
      expect(draw[1]).not.toBeNull();
    }

    // Base-name generation draws `random` first and then picks from lists, so the sequence
    // is what a reordering of those picks would break.
    const generating = commandVocabulary().records.find(
      (record) => record.kind === "buildBase" && record.draws.length > 0,
    );
    expect(generating?.draws.map((draw: Draw) => draw[0])).toEqual([
      "random",
      "choice",
      "choice",
      "choice",
    ]);

    // Creating the game draws too, and those draws ride on the first record rather than
    // being dropped: their order moves the whole stream after them. They come first, ahead of
    // whatever the Scenario's own first step drew — a build Command names its base and draws
    // four more, which is why this reads the head of the list rather than the whole of it.
    for (const scenario of scenarios) {
      const first = trace(scenario).records[0]?.draws.map((draw: Draw) => draw[0]);
      expect(first?.slice(0, 3)).toEqual(["shuffle", "randint", "choice"]);
    }
  });

  // A shuffle's permutation is read off positions, not off the elements. `Player.remove_bases`
  // shuffles a list of Locations and puts the same Location in it twice when two bases at one
  // location are lost in one tick (`player.py:611`); a permutation recovered from the elements
  // afterwards cannot see two entries that are the same object move past each other, so it
  // reports an order the generator did not draw and a real divergence goes unreported. Two
  // committed Scenarios reach that case and no digest moves without them, so the rule is held
  // here directly rather than by their continuing to reach it.
  it("records the permutation the generator drew, for a list holding one object twice", () => {
    const { shuffle } = effectSurface().recorder;

    expect(shuffle.repeated, "the probe's list holds one object twice").toEqual([0, 1]);
    expect(
      shuffle.byIdentity,
      `seed ${shuffle.seed} draws a permutation that leaves the repeated positions in the ` +
        `order a recovery from the elements would guess, so this case cannot tell the two ` +
        `apart — give SHUFFLE_PROBE_SEED another value`,
    ).not.toEqual(shuffle.generator);

    expect(shuffle.recorded).toEqual([["shuffle", shuffle.generator]]);
    // And the caller's list is left holding its own elements in the order the generator put
    // them: the markers the recorder shuffles in their place never escape it.
    expect(shuffle.after).toEqual(shuffle.generator.map((index) => shuffle.before[index]));
  });

  it("captures effects through the recorder standing in for the map screen", () => {
    const records = commandVocabulary().records;
    const warning = records.find((record) =>
      record.effects.some((effect) => effect.args[0] === "Grace Warning"),
    );
    expect(warning, "the scenario runs past day 23, so the grace period ends").toBeDefined();
    // Two, not three: `pause_game` also sets `needs_rebuild`, and the recorder drops render
    // invalidation before it reaches a Trace — see "the effect list's edge" below.
    expect(warning?.effects).toEqual([
      { kind: "call", name: "find_speed_button", args: [], kwargs: {} },
      { kind: "call", name: "show_story_section", args: ["Grace Warning"], kwargs: {} },
    ]);

    // The autosave upstream performs mid-tick is an effect at the position upstream calls
    // it — the Deviation its Normalisation later moves.
    const autosaves = records.flatMap((record) =>
      record.effects.filter((effect) => effect.name === "auto_save"),
    );
    expect(autosaves.length).toBeGreaterThan(0);
  });

  // Upstream's `Base.space_left_for` already deducts the CPUs a base holds of the spec
  // being bought, and upstream's own caller uses that return value unmodified. A recorder
  // that deducts them a second time refuses a buy the reference allows, and that would be
  // a rule in the specification the port is written against but nowhere in the reference.
  it("stacks CPUs of the same spec, up to the base's own size", () => {
    const records = byId("cpu-stacking").records;
    const installed = records
      .filter((record) => record.kind === "buyItem")
      .map((record) => cpuCount(baseNamed(record, "Depot")));

    // Storage Unit is size 8: four, then four more, fills it exactly.
    expect(installed).toEqual([4, 8]);
  });

  it("compares as integers, strings and booleans, with no float anywhere", () => {
    for (const scenario of scenarios) {
      for (const record of trace(scenario).records) {
        // Every part of the record, not only the two state halves: an effect argument or a
        // draw result carrying a float would be just as uncomparable.
        const offenders = nonIntegralNumbers({
          persistent: record.persistent,
          derived: record.derived,
          effects: record.effects,
          draws: record.draws,
        });
        expect(offenders, `${scenario.id} step ${record.step}`).toEqual([]);
      }
    }
  });

  // Two full runs of every committed Scenario, and one of them is `long-play` — a thousand
  // steps the reference walks twice here. So it names a timeout of its own above the thirty
  // seconds `vitest.config.ts` gives the rest: 5809 ms in a run of this file alone and
  // 13199 ms with the machine saturated. It is one of the three most
  // expensive tests in the project rather than the most expensive; the Scenario-format gate
  // in this file and the quadratic-tick tripwire in `performance.test.ts` both cost more,
  // and both name their own timeout for the same reason. What this test is for is determinism, and letting a slow machine call
  // that a failure would say nothing about it.
  it("produces byte-identical traces on two runs of every scenario", () => {
    for (const scenario of scenarios) {
      const first = referenceTrace(scenarioPath(scenario));
      const second = referenceTrace(scenarioPath(scenario));
      expect(second.lines.join("\n"), scenario.id).toBe(first.lines.join("\n"));
    }
  }, 60_000);

  // Deviation 2: upstream never seeds, so the reference is reproducible only because the
  // recorder seeds it from the Scenario. The comparison holds both streams to one seed, and
  // it can only do that against something the run itself says — a seed the harness read out
  // of the Scenario a second time would be the Scenario compared to itself.
  it("reports beside the trace what it seeded the reference with", () => {
    for (const scenario of scenarios) {
      expect(trace(scenario).seed, scenario.id).toBe(scenario.seed);
    }
  });

  // And which Scenario it loaded, for the same reason and one more: the seed does not name a
  // game, because several committed Scenarios carry the same one. This is what ties a
  // comparison's label to the file the reference actually ran, so a run recorded from one
  // Scenario and compared under another's name refuses instead of matching.
  it("reports beside the trace which Scenario it recorded", () => {
    for (const scenario of scenarios) {
      expect(trace(scenario).scenario, scenario.id).toBe(scenario.id);
    }
  });
});

// Where the effect list stops. The recorder drives the model, so it reaches the calls the
// Simulation makes into Presentation and none of the ones Presentation makes to itself — a
// shorter list than "every GUI call a real play makes", and the port is written against it.
describeOracle("the effect list's edge", () => {
  it("declares every place the reference reaches g.map_screen, and no other", () => {
    const { declared, found } = effectSurface();
    expect(found.length).toBeGreaterThan(0);
    expect(declared.map(({ where, attribute, kind }) => ({ where, attribute, kind }))).toEqual(
      found,
    );
  });

  it("says why, for every one it does not reach", () => {
    const unreached = effectSurface().declared.filter((site) => !site.reached);
    expect(unreached.length).toBeGreaterThan(0);
    for (const site of unreached) {
      expect(site.reason, `${site.where}.${site.attribute}`).toMatch(/\S/);
    }
  });

  it("does not reach the build dialog's considered_buyables set", () => {
    const site = effectSurface().declared.find(
      (candidate) => candidate.where === "player.Player.considered_buyables",
    );
    expect(site).toMatchObject({ attribute: "needs_rebuild", kind: "set", reached: false });
    expect(site?.reason).toMatch(/screen flow/i);
  });

  /**
   * The other half of that absence, and the sharper one: upstream's dialog does not only
   * *say* the display moved, it moves the Simulation.
   *
   * `NewBaseDialog._update_desc_pane` builds one fake Base (`screens/location.py:411`); the
   * dialog knows no quantity, and one per unit ordered is this recorder's own generalisation
   * of it. A base type with a forced CPU finishes its item, and `Item.finish` calls
   * `self.base.recalc_cpu()` outright and then `self.base.check_power()`, which calls it
   * again (`item.py:242,243`, `base.py:286`) — and `recalc_cpu` scales every allocation at an
   * oversubscribed danger level down. Merely looking at a base type can therefore throw CPU allocations
   * away, and `base.py:375` carries upstream's own warning about it.
   *
   * The port cannot: the hypothetical is an argument to a pure Projection, so nothing is
   * written. That is not a Deviation and gets no register entry, and the reason it needs none
   * is that the recorder puts back what the question moved. This is that claim, measured: the same
   * Scenario recorded with the dialog open before every step, line for line against the
   * same Scenario recorded with it shut.
   */
  it("records the same Trace with the build dialog open as with it shut", () => {
    const order = { location: "N AMERICA", baseType: "Datacenter", count: 3 };
    const scenario = scenarios.find((candidate) => candidate.id === "research");
    if (!scenario) throw new Error("the research Scenario is what allocates CPU to look at");

    const shut = trace(scenario);
    const open = referenceTrace(scenarioPath(scenario), [order]);

    // Read off the run, so a Trace that is unchanged because no dialog was ever opened
    // cannot pass for one that is unchanged because the question moved nothing.
    expect(shut.consideredBases).toBe(0);
    expect(open.consideredBases).toBe(order.count * scenario.script.length);
    expect(open.lines).toEqual(shut.lines);
  });

  /**
   * The other write, and the reason it takes no repair at all.
   *
   * The item dialogs write `buyable.Buyable(item_spec, count=n)` — a **plain** buyable, not
   * the `Item` a base would hold (`screens/base.py:103,182,446`). A plain `Buyable` has no
   * `Item.finish` and no base to call `Base.check_power` on, so nothing about it reaches
   * `g.pl.recalc_cpu`: the recorder stands in for these dialogs without taking anything
   * before or putting anything back.
   *
   * That is an argument, and this is the measurement of it. The undo above is scoped to the
   * fake bases, so nothing here cancels a perturbation the item write might make — the Trace
   * is unchanged because there is none.
   */
  it("records the same Trace with an item dialog open, and repairs nothing to do it", () => {
    const order = { item: "Server", count: 5 };
    const scenario = scenarios.find((candidate) => candidate.id === "items");
    if (!scenario) throw new Error("the items Scenario is what fills bases to look inside");

    const shut = trace(scenario);
    const open = referenceTrace(scenarioPath(scenario), [order]);

    expect(shut.consideredItems).toBe(0);
    // One buyable per question, carrying the count, and one question per step.
    expect(open.consideredItems).toBe(scenario.script.length);
    expect(open.consideredBases).toBe(0);
    expect(open.lines).toEqual(shut.lines);
  });

  it("shows the shorter list in the Trace: a build Command records no effect", () => {
    const builds = commandVocabulary().records.filter((record) => record.kind === "buildBase");
    expect(builds.length).toBeGreaterThan(0);
    // Upstream's build dialog sets `considered_buyables`, whose setter sets `needs_rebuild`.
    // The recorder builds through the model, so none of that is here — the register above is
    // where that absence is written down.
    expect(builds.map((record) => record.effects)).toEqual(builds.map(() => []));
  });

  // The second flag the register carries, and the one that fails in the other direction:
  // `reached` is about the recorder, `compared` about the port. Render invalidation is the
  // whole of it — the Simulation does make it and the recorder does capture it, and the port
  // has no counterpart because a reactive Presentation has no such concept.
  it("drops render invalidation, which the port has no counterpart for", () => {
    const { declared, recorder } = effectSurface();
    const dropped = declared.filter((site) => !site.compared);

    expect(dropped.length).toBeGreaterThan(0);
    expect(new Set(dropped.map((site) => site.attribute))).toEqual(new Set(["needs_rebuild"]));
    for (const site of dropped) {
      expect(site.whyNotCompared, `${site.where}.${site.attribute}`).toMatch(/\S/);
    }

    // Derived from the register rather than written beside it, so the two cannot drift.
    expect(recorder.filtered).toEqual([["needs_rebuild", "set"]]);
    // And no Trace holds one, which is what the drop is for.
    const dropping = scenarios.flatMap((scenario) =>
      trace(scenario).records.flatMap((record) =>
        record.effects.filter((effect) => effect.name === "needs_rebuild"),
      ),
    );
    expect(dropping).toEqual([]);
  });

  it("records nothing a Command or an advance cannot reach", () => {
    const reachable = new Set(
      effectSurface()
        .declared.filter((site) => site.reached && site.compared)
        .map((site) => site.attribute),
    );
    // `auto_save` is not a map screen call at all: it is the interception the recorder
    // installs in its place (deviation 3).
    reachable.add("auto_save");

    const observed = new Set(
      scenarios.flatMap((scenario) =>
        trace(scenario).records.flatMap((record) => record.effects.map((effect) => effect.name)),
      ),
    );
    expect(observed.size).toBeGreaterThan(0);
    expect([...observed].filter((name) => !reachable.has(name))).toEqual([]);
  });

  // The register checked inwards, which is the direction the two tests above cannot check.
  // They hold the declaration against a scan of the reference's syntax tree, and a site
  // declared `reached` that nothing can actually drive the recorder to satisfies both: the
  // call is there in the source, and the claim about reaching it is never exercised. So every
  // entry the port compares has to turn up in some committed Scenario's Trace, observed by
  // the recorder rather than restated by the register.
  it("reaches every entry it declares reached, in some committed Scenario", () => {
    const reaching = scenarioReach();
    const declared = effectSurface().declared.filter((site) => site.reached && site.compared);

    expect(declared.length).toBeGreaterThan(0);
    for (const site of declared) {
      expect(
        reaching.get(siteKey(site)) ?? [],
        `${siteKey(site)} is declared reached and compared, but no committed Scenario's ` +
          `Trace holds it. Either the declaration is wrong, or the Scenario that would drive ` +
          `the recorder there is missing — the ones that ran are ` +
          `${scenarios.map((scenario) => scenario.id).join(", ")}`,
      ).not.toEqual([]);
    }
  });

  // And the two flags stay apart. A dropped site is reached by the Simulation and captured by
  // the recorder, so a report taken before the filter would make `compared: false` look like
  // coverage and the gate above would pass on entries no Trace holds.
  it("reports no site for the entries it drops, so a drop cannot read as coverage", () => {
    const reaching = scenarioReach();
    const dropped = effectSurface().declared.filter((site) => !site.compared);

    expect(dropped.length).toBeGreaterThan(0);
    for (const site of dropped) {
      expect(reaching.get(siteKey(site)), siteKey(site)).toBeUndefined();
    }
  });

  // Recording and performing are separate: a set the recorder drops is still *made*, so
  // nothing in the reference ever reads back a default it was written out of. Nothing does
  // today; performing only what is recorded would make the day one does a silent wrong
  // answer instead of a divergence.
  it("performs the attribute writes it drops, so a read never observes a stale default", () => {
    const { attributeWrite, call } = effectSurface().recorder;

    expect(attributeWrite.before).toBe(false);
    expect(attributeWrite.recorded).toEqual([]);
    expect(attributeWrite.after).toBe(true);
    // A recorder that recorded nothing at all would satisfy the line above; this one does not.
    expect(call.recorded).toEqual([
      { kind: "call", name: "find_speed_button", args: [], kwargs: {} },
    ]);
  });
});

describeOracle("the digest manifest", () => {
  it("matches the reference's current output", () => {
    const result = checkManifest();
    expect(result.stderr + result.stdout).toContain("match the manifest");
    expect(result.status).toBe(0);
  });
});

// The tripwire on the specification only covers what it names. A Scenario the manifest has
// no entry for runs in every comparison and still lets the reference's own output move
// under it without a commit saying so, and the run above cannot say that: it needs the
// Oracle, and where the Oracle is absent it skips. So the coverage is checked here, off the
// two committed files alone.
describe("what the digest manifest covers", () => {
  const manifest = () =>
    JSON.parse(readFileSync(resolve(scenarioDirectory, "manifest.json"), "utf8")) as {
      scenarios: Record<string, { digest: string; steps: number }>;
    };

  it("is every committed Scenario, and nothing that is not one", () => {
    expect(Object.keys(manifest().scenarios).sort()).toEqual(
      scenarios.map((scenario) => scenario.id).sort(),
    );
  });

  it("says how long each of them is, and how it hashed", () => {
    for (const scenario of scenarios) {
      const entry = manifest().scenarios[scenario.id];
      expect(entry?.steps, scenario.id).toBe(scenario.script.length);
      expect(entry?.digest, scenario.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });
});

describe("what is committed", () => {
  it("is the manifest and the scenarios, and no trace", () => {
    const stray = readdirSync(scenarioDirectory).filter(
      (name) => !name.endsWith(SCENARIO_SUFFIX) && name !== "manifest.json",
    );
    expect(stray).toEqual([]);

    // A trace committed outside scenarios/ would be just as wrong, so the check is over
    // everything git tracks. `record.py --out` only writes this suffix.
    const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .filter((path) => path.endsWith(TRACE_SUFFIX));
    expect(tracked).toEqual([]);
  });
});

/**
 * A Scenario is data, and the generator that wrote one runs offline, by hand, exactly once.
 *
 * This is the rule the whole comparison rests on. Were a script generated while the harness
 * ran, each implementation would be driven by a script from its own generator, and a
 * divergence between the two would say nothing about either of them — the harness would be
 * testing itself (`tools/trace/scenario.py`). The scripts are therefore committed
 * files, and the generator is somewhere neither end of the comparison can reach.
 *
 * "Cannot reach" is checked as *is never named*, over the whole verification path — the
 * Oracle's recorder, the Simulation and its harness, and the application. An import is not
 * enough on its own: the way a test would really run a generator is by spawning the
 * interpreter on its module name, which is a string and not an import. The names themselves
 * are read off `tools/oracle/`, so a second generator is covered on the day it is written
 * rather than on the day somebody remembers to add it here.
 */
describe("the offline scenario generator", () => {
  // Named off the directory, so what the discovery finds has to be a tool rather than any
  // file whose name happens to start that way: a module run as `python -m` with an `--out`
  // to write the Scenario to. A helper that shared the prefix would be taken for a generator
  // by every check below, and the one that matters is a check on *names*.
  it("is where an offline tool goes, and there is one", () => {
    const modules = generatorModules();
    expect(modules.length).toBeGreaterThan(0);

    for (const module of modules) {
      const source = readFileSync(resolve(repoRoot, GENERATOR_DIRECTORY, `${module}.py`), "utf8");
      expect(source, `${module} is not runnable as a module`).toContain(
        'if __name__ == "__main__"',
      );
      expect(source, `${module} takes no --out to write a Scenario to`).toContain('"--out"');
      expect(source, `${module} writes no Scenario`).toContain(SCENARIO_FORMAT_MODULE);
    }
  });

  it("is named nowhere on the verification path", () => {
    expect(
      generatorsNamedUnder(),
      "a generator run at verification time would hand each side of the comparison a " +
        "script from its own generator; the scripts are committed data instead",
    ).toEqual([]);
  });

  // The check has to be able to say no, or the one above proves nothing: it reads a real
  // tree, and a tree it failed to walk would pass it in silence. So the same rule — the same
  // walk, the same reads, the same match — is put to a tree written here that does name a
  // generator, in a source spelled the way a caller would spell it. Asserting on the matcher
  // alone left the walk untested, and a walk is what the check above is.
  it("would say so, for a source on that path that named one", () => {
    const module = generatorModules()[0] as string;
    const root = probeDirectory("verification-path-");
    const nested = join(root, "trace");
    mkdirSync(nested);

    writeFileSync(
      join(nested, "spawn.py"),
      `runOracle(["-m", "tools.oracle.${module}", "--out", "x${SCENARIO_SUFFIX}"])\n`,
      "utf8",
    );
    // Beside it, the two things the walk is meant to pass over: a file that is not a source,
    // and a directory that holds no source of its own.
    writeFileSync(join(nested, "notes.md"), `tools.oracle.${module}\n`, "utf8");
    mkdirSync(join(root, "__pycache__"));
    writeFileSync(join(root, "__pycache__", "cached.py"), `tools.oracle.${module}\n`, "utf8");

    expect(generatorsNamedUnder([root], root)).toEqual([`trace/spawn.py names ${module}`]);
  });

  // The rule above is one half of the arrangement and this is the other. A Scenario nobody
  // can write again is safe from the rule and unreproducible with it: `apotheosis` was
  // committed as a script of a won game with the planner that produced it left out, so a
  // reference bump or a Content change meant re-deriving a winning run by hand rather than
  // re-running something. A tool is matched to the Scenario by the file it
  // writes, which is a line in the tool rather than a claim in the Scenario — so a Scenario
  // does not have to move to say where it came from, and its digest does not either.
  it("wrote the Scenario that plays the game to a win", () => {
    const won = scenarioNamed(WON_SCENARIO);

    expect(
      generatorsWriting(won),
      `${WON_SCENARIO} is ${won.script.length} steps of a game played to a win, and no tool ` +
        `under ${GENERATOR_DIRECTORY} writes it`,
    ).not.toEqual([]);
  });

  // The same read put to a Scenario a person wrote by hand: a match that said yes to
  // everything would say nothing about the one above.
  it("wrote none of the Scenarios a person wrote", () => {
    expect(generatorsWriting(scenarioNamed(HAND_WRITTEN_SCENARIO))).toEqual([]);
  });

  it("walks a verification path that holds the recorder, the Simulation and the app", () => {
    const walked = verificationSources().map((path) => relative(repoRoot, path));

    expect(walked).toContain("tools/trace/record.py");
    expect(walked).toContain("sim/src/advance.ts");
    expect(walked).toContain(`sim/test/${basename(fileURLToPath(import.meta.url))}`);
    expect(walked.some((path) => path.startsWith("app/src/"))).toBe(true);
  });
});

/** Where a tool that writes a Scenario lives, and what its name starts with. */
const GENERATOR_DIRECTORY = "tools/oracle";
const GENERATOR_PREFIX = "generate_";

/** The module a Scenario's format lives in, which a tool that writes one has to reach. */
const SCENARIO_FORMAT_MODULE = "tools.trace.scenario";

/** The Scenario that plays the game to a win, and one short enough to have been written. */
const WON_SCENARIO = "apotheosis";
const HAND_WRITTEN_SCENARIO = "grace-quiet";

/** The generators that write one Scenario, found by the file each one names writing. */
function generatorsWriting(scenario: Scenario): readonly string[] {
  const written = scenarioPath(scenario);
  return generatorModules().filter((module) =>
    readFileSync(resolve(repoRoot, GENERATOR_DIRECTORY, `${module}.py`), "utf8").includes(written),
  );
}

/** One committed Scenario by id, for a check that is about that Scenario in particular. */
function scenarioNamed(scenarioId: string): Scenario {
  const found = scenarios.find((candidate) => candidate.id === scenarioId);
  if (!found) throw new Error(`scenarios/ holds no ${scenarioId}${SCENARIO_SUFFIX}`);
  return found;
}

/** The generators, by module name, read off the directory rather than listed here. */
function generatorModules(): readonly string[] {
  return readdirSync(resolve(repoRoot, GENERATOR_DIRECTORY))
    .filter((name) => name.startsWith(GENERATOR_PREFIX) && name.endsWith(".py"))
    .map((name) => name.slice(0, -".py".length))
    .sort();
}

/** Every source a verification run can reach: the Oracle's recorder, `sim/`, `app/src`. */
const VERIFICATION_PATH = ["tools/trace", "sim/src", "sim/test", "app/src"];

const SOURCE_SUFFIXES = [".py", ".ts", ".tsx"];

function verificationSources(
  roots: readonly string[] = VERIFICATION_PATH.map((directory) => resolve(repoRoot, directory)),
): readonly string[] {
  return roots.flatMap((root) => sourcesUnder(root));
}

/**
 * Every place a source under those roots names a generator, as `<path> names <module>`.
 *
 * The roots are a parameter, and so is what the paths are reported relative to: the check
 * over the real verification path and the check that the walk can say no run this same
 * function, one on the repository and one on a tree written for the occasion.
 */
function generatorsNamedUnder(roots?: readonly string[], base = repoRoot): string[] {
  return verificationSources(roots).flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return generatorModules()
      .filter((module) => source.includes(module))
      .map((module) => `${relative(base, path)} names ${module}`);
  });
}

function sourcesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return name === "__pycache__" ? [] : sourcesUnder(path);
    }
    return SOURCE_SUFFIXES.some((suffix) => name.endsWith(suffix)) ? [path] : [];
  });
}

/** The local filter over the suite that runs every comparison against the reference. */
const FIDELITY_SCRIPT = "check:fidelity";

const TRACE_SUFFIX = ".trace.jsonl";

function siteKey(site: EffectSite): string {
  return `${site.where}.${site.attribute} (${site.kind})`;
}

/** Which Scenarios reach each effect site, as their runs reported it. */
function scenarioReach(): Map<string, string[]> {
  const reaching = new Map<string, string[]>();
  for (const scenario of scenarios) {
    for (const site of trace(scenario).reachedSites) {
      reaching.set(siteKey(site), [...(reaching.get(siteKey(site)) ?? []), scenario.id]);
    }
  }
  expect(reaching.size, "no Scenario reports reaching any effect site at all").toBeGreaterThan(0);
  return reaching;
}

function byId(id: string) {
  const scenario = scenarios.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`the ${id} scenario is missing`);
  return trace(scenario);
}

function commandVocabulary() {
  return byId("command-vocabulary");
}

interface RecordedItem {
  readonly count?: number;
}

interface RecordedBase {
  readonly name: string;
  readonly items: readonly RecordedItem[];
}

function baseNamed(record: ReferenceRecord, name: string): RecordedBase {
  const player = record.persistent.player as {
    readonly locations: readonly { readonly bases: readonly RecordedBase[] }[];
  };
  const found = player.locations
    .flatMap((location) => location.bases)
    .find((base) => base.name === name);
  if (!found) throw new Error(`no base named ${name} in the record`);
  return found;
}

/** Upstream leaves a count of one out of the save, so an absent count is one. */
function cpuCount(base: RecordedBase): number {
  expect(base.items).toHaveLength(1);
  return base.items[0]?.count ?? 1;
}

function nonIntegralNumbers(value: unknown, path = ""): string[] {
  if (typeof value === "number") {
    return Number.isInteger(value) ? [] : [`${path} = ${value}`];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => nonIntegralNumbers(entry, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      nonIntegralNumbers(entry, `${path}.${key}`),
    );
  }
  return [];
}
