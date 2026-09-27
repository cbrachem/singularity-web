// boundary-intent harness: spawns the reference and reads its output
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { repoRoot } from "./scenario.ts";

/**
 * The Oracle in its recording role: the pinned reference under `singularity/`, driven
 * through a Scenario by `tools/trace/`. Everything here shells out — the
 * reference is Python, and the port never links against it.
 */

/**
 * The shared Python environment lives at the main checkout's `.venv/` and is not per
 * checkout, so a worktree finds it a level or two up. Only the interpreter is
 * shared; the code is always this checkout's, because `python -m` puts the working
 * directory first on the path.
 */
function findInterpreter(): string | undefined {
  const fromEnvironment = process.env.SINGULARITY_PYTHON;
  if (fromEnvironment) return existsSync(fromEnvironment) ? fromEnvironment : undefined;

  let directory = repoRoot;
  for (let level = 0; level < 4; level += 1) {
    const candidate = resolve(directory, ".venv/bin/python");
    if (existsSync(candidate) && existsSync(resolve(directory, "tools/requirements.txt"))) {
      return candidate;
    }
    const parent = resolve(directory, "..");
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

const interpreter = findInterpreter();

/** Whether this checkout can drive the Oracle at all. */
export const oracleAvailable = interpreter !== undefined;

/**
 * Where the Oracle is *required*, its absence is a failure rather than a reason to skip.
 * CI sets this, so the oracle-backed tests can never quietly stop running there; a working
 * copy without a reference environment skips them instead of failing on setup it does not
 * have.
 */
export const oracleRequired = process.env.SINGULARITY_ORACLE_REQUIRED === "1";

export function requireOracle(): string {
  if (!interpreter) {
    throw new Error(
      "the reference environment is missing. Create it with:\n" +
        "  python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt",
    );
  }
  return interpreter;
}

export interface OracleResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `spawnSync` rather than `execFileSync`, because a run that *succeeds* also says things:
 * the recorder reports on stderr what it seeded the reference with, and `execFileSync`
 * hands back only stdout unless the child fails.
 */
export function runOracle(args: readonly string[]): OracleResult {
  const result = spawnSync(requireOracle(), [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    // Captured rather than inherited: a test that drives the Oracle to a *deliberate*
    // failure asserts on what it said, and the parent's stderr is not where that belongs.
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status === null) {
    throw new Error(`${args.join(" ")} was killed by ${result.signal}`);
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function demandRun(args: readonly string[]): OracleResult {
  const result = runOracle(args);
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} failed with status ${result.status}\n${result.stderr}`);
  }
  return result;
}

function demand(args: readonly string[]): string {
  return demandRun(args).stdout;
}

/** One draw: the function that was called and what it returned. No call site, by design. */
export type Draw = readonly [fn: string, result: unknown];

export interface ReferenceEffect {
  readonly kind: "call" | "set";
  readonly name: string;
  readonly args: readonly unknown[];
  readonly kwargs: Readonly<Record<string, unknown>>;
}

export interface ReferenceRecord {
  readonly step: number;
  readonly kind: string;
  readonly persistent: Readonly<Record<string, unknown>>;
  readonly derived: Readonly<Record<string, unknown>>;
  readonly effects: readonly ReferenceEffect[];
  readonly draws: readonly Draw[];
}

export interface ReferenceTrace {
  /** The canonical lines, which is what "byte-identical" is measured on. */
  readonly lines: readonly string[];
  readonly records: readonly ReferenceRecord[];
  /**
   * Which Scenario the recorder loaded and drove, as the run itself reported it.
   *
   * The seed below cannot stand in for it: several committed Scenarios carry the same seed,
   * so two Traces of different games can satisfy deviation 2's Normalisation and match at
   * every record. This is what a comparison holds its label to, so a Scenario the fidelity
   * gate reads back as compared is one whose file ran.
   */
  readonly scenario: string;
  /**
   * What the recorder seeded the reference's generator with, as the run itself reported it.
   *
   * Deviation 2's Normalisation is what this exists for. Upstream never seeds, so the
   * reference is reproducible only because the harness seeds it from the Scenario — and a
   * comparison can only hold the two sides to one seed if the reference *says* what it ran
   * with, rather than the harness reading the Scenario twice and comparing it to itself.
   */
  readonly seed: number;
  /**
   * Which `EFFECT_SURFACE` entries this run's effects came from, as the recorder observed
   * them rather than as the register declares them.
   *
   * The register's `reached` flag is a claim about the reference, and comparing the register
   * against a scan of the source only checks it outwards: a site declared reached that
   * nothing can actually drive passes. This is the other direction. It holds only sites
   * whose effect survived the filter, so it says exactly what the Trace shows.
   */
  readonly reachedSites: readonly EffectSite[];
  /**
   * How many fake bases upstream's build dialog built during this run, counted by the
   * recorder.
   *
   * Zero unless the run was given an order to consider. A Trace recorded with the dialog
   * open has to equal one recorded without it, and that comparison is worth nothing if the dialog was never opened
   * — so the count is read off the run rather than assumed from the argument.
   */
  readonly consideredBases: number;
  /**
   * How many plain buyables upstream's item dialogs built during this run, counted the same
   * way and there for the same reason.
   *
   * The item half of the write needs no undo — a plain `Buyable` has no `Item.finish` and no
   * base to check the power of, so it reaches nothing — and this is what turns that sentence
   * into a measurement instead of an argument.
   */
  readonly consideredItems: number;
}

/** `recorded-scenario <id>` on the recorder's stderr — `tools/trace/record.py`. */
const SCENARIO_REPORT = /^recorded-scenario (\S+)$/m;

/** `seeded-from <n>` on the same stream. */
const SEED_REPORT = /^seeded-from (-?\d+)$/m;

/** `reached-site <where> <attribute> <kind>` on the same stream, one per site. */
const SITE_REPORT = /^reached-site (\S+) (\S+) (call|set)$/gm;

/** `considered-bases <n>` on the same stream, once per run. */
const CONSIDERED_REPORT = /^considered-bases (\d+)$/m;

/** `considered-items <n>`, beside it. */
const CONSIDERED_ITEMS_REPORT = /^considered-items (\d+)$/m;

/**
 * The reference's Trace for a Scenario, optionally recorded with upstream's build dialog
 * open on `considered`.
 *
 * Opening it is not decoration: upstream's dialog builds fake bases, and finishing their
 * items reaches `g.pl.recalc_cpu`, which throws CPU allocations away at an oversubscribed
 * danger level. The recorder undoes that, and this is how the undo is checked — the two
 * Traces have to be identical, line for line.
 */
export function referenceTrace(
  scenarioPath: string,
  considered: readonly ConsideredOrder[] = [],
): ReferenceTrace {
  const args = ["-m", "tools.trace.record", scenarioPath, ...consideredArguments(considered)];
  const result = demandRun(args);
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);

  const reported = SEED_REPORT.exec(result.stderr);
  if (!reported) {
    throw new Error(
      `${args.join(" ")} recorded a trace without reporting the seed it ran with. The ` +
        `comparison holds both sides to one seed (deviation 2), which it can only do if ` +
        `the recorder says what it seeded from.\n${result.stderr}`,
    );
  }

  const recorded = SCENARIO_REPORT.exec(result.stderr);
  if (!recorded) {
    throw new Error(
      `${args.join(" ")} recorded a trace without reporting which Scenario it ran. A ` +
        `comparison holds its label to what both Traces say they ran, which it can only do ` +
        `if the recorder says which Scenario it loaded.\n${result.stderr}`,
    );
  }

  return {
    scenario: recorded[1] as string,
    lines,
    records: lines.map((line) => JSON.parse(line) as ReferenceRecord),
    seed: Number(reported[1]),
    reachedSites: [...result.stderr.matchAll(SITE_REPORT)].map((reportedSite) => ({
      where: reportedSite[1] ?? "",
      attribute: reportedSite[2] ?? "",
      kind: reportedSite[3] === "set" ? "set" : "call",
    })),
    consideredBases: Number(CONSIDERED_REPORT.exec(result.stderr)?.[1] ?? 0),
    consideredItems: Number(CONSIDERED_ITEMS_REPORT.exec(result.stderr)?.[1] ?? 0),
  };
}

/**
 * The reference's own `cpu_usage` key order, one entry per Scenario step.
 *
 * Recorded beside the Trace rather than inside it. `cpu_usage` is a dict and its key order
 * is behaviour — the allocation made first is offered the cash first when there is not
 * enough for every tech — but the recorder's canonical line sorts every object's keys,
 * because that line is what the digest manifest is measured on. So a Trace record arrives
 * alphabetical, and the order is compared through this instead.
 */
export function referenceAllocationOrder(scenarioPath: string): readonly (readonly string[])[] {
  const stdout = demand(["-m", "tools.trace.record", scenarioPath, "--allocation-order"]);
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

/**
 * One half of what `Player.compute_future_resource_flow` returns, in upstream's own field
 * names. Two objects per step, in the order `tools/trace/reference.py` names them.
 */
export type ReferenceFlow = Readonly<Record<string, number>>;

export interface ReferenceResourceFlow {
  readonly cash: ReferenceFlow;
  readonly cpu: ReferenceFlow;
}

/**
 * The reference's own resource flow after each Scenario step.
 *
 * Recorded beside the Trace rather than inside it, like the allocation order above: a
 * Projection is not state, so putting it in a record would move every digest in the manifest
 * without the reference having changed. What it lets a suite do is hold the port's
 * pure Projection against the reference's routine, step for step, over a whole play.
 */
/**
 * An order of bases the player is looking at but has not placed, as the recorder's command
 * line takes it — `LOCATION/TYPE/COUNT` (`tools/trace/reference.py`, `ConsideredBases`).
 */
export interface ConsideredBaseOrder {
  readonly location: string;
  readonly baseType: string;
  readonly count: number;
}

/**
 * An item the player is looking at inside a base — `ITEM/COUNT`
 * (`tools/trace/reference.py`, `ConsideredItems`). The other place upstream writes
 * `considered_buyables` from, and the one that writes a plain buyable rather than a base.
 */
export interface ConsideredItemOrder {
  readonly item: string;
  readonly count: number;
}

/** Either hypothetical, which the recorder takes on one list. */
export type ConsideredOrder = ConsideredBaseOrder | ConsideredItemOrder;

/** The orders as the recorder's command line takes them, one flag per kind. */
function consideredArguments(considered: readonly ConsideredOrder[]): string[] {
  return considered.flatMap((order) =>
    "item" in order
      ? ["--considered-item", `${order.item}/${order.count}`]
      : ["--considered", `${order.location}/${order.baseType}/${order.count}`],
  );
}

export function referenceResourceFlow(
  scenarioPath: string,
  considered: readonly ConsideredOrder[] = [],
): readonly ReferenceResourceFlow[] {
  const orders = consideredArguments(considered);
  const stdout = demand(["-m", "tools.trace.record", scenarioPath, "--resource-flow", ...orders]);
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ReferenceResourceFlow);
}

export function referenceFormat(): unknown {
  return JSON.parse(demand(["-m", "tools.trace.scenario"]));
}

/** One place the reference reaches into Presentation through `g.map_screen`. */
export interface EffectSite {
  /** The enclosing function, as `module.Class.function`. */
  readonly where: string;
  readonly attribute: string;
  readonly kind: "call" | "set";
}

/**
 * A site plus the two flags the register carries: whether the recorder can be driven to it,
 * and whether what it finds there is part of the compared surface at all. They fail in
 * opposite directions — `reached` is about the recorder, `compared` about the port.
 */
export interface DeclaredEffectSite extends EffectSite {
  readonly reached: boolean;
  readonly reason?: string;
  readonly compared: boolean;
  readonly whyNotCompared?: string;
}

/**
 * What the recorder standing in for the map screen does and does not see. `declared` is the
 * register kept by hand in `tools/trace/reference.py`; `found` is scanned out of the
 * vendored reference at the time of the call, so a reference bump that adds a call into
 * Presentation cannot widen the effect list unnoticed. `attributeWrite`, `call` and
 * `filtered` are live probes of the recorder, not claims about it.
 */
export interface EffectSurface {
  readonly recorder: {
    readonly attributeWrite: {
      readonly before: unknown;
      readonly recorded: readonly ReferenceEffect[];
      readonly after: unknown;
    };
    readonly call: {
      readonly recorded: readonly ReferenceEffect[];
    };
    /** `[attribute, kind]` pairs the recorder drops instead of recording. */
    readonly filtered: readonly (readonly [string, string])[];
    /**
     * The draw recorder shuffling a list that holds one object twice, which is what
     * `Player.remove_bases` hands it when two bases at one location are lost in one tick.
     * `generator` is the permutation the bare generator produces from the same seed, and
     * `byIdentity` the one a recovery from the elements after the fact would produce —
     * indistinguishable elements make those two differ, which is what lets the case say
     * which of the two the recorder wrote down.
     */
    readonly shuffle: {
      readonly seed: number;
      /** Element labels, in the order the probe built them. */
      readonly before: readonly string[];
      /** Element labels, as the caller's own list holds them after the shuffle. */
      readonly after: readonly string[];
      /** The positions in `before` that are one and the same object. */
      readonly repeated: readonly number[];
      readonly recorded: readonly Draw[];
      readonly generator: readonly number[];
      readonly byIdentity: readonly number[];
    };
  };
  readonly declared: readonly DeclaredEffectSite[];
  readonly found: readonly EffectSite[];
}

export function referenceEffectSurface(): EffectSurface {
  return JSON.parse(demand(["-m", "tools.trace.reference"])) as EffectSurface;
}

export function checkManifest(): OracleResult {
  return runOracle(["-m", "tools.trace.manifest"]);
}

/**
 * The Oracle checking a committed fixture against a reference run made *now*: the script
 * rebuilds its record, writes nothing, and names what moved. A reference bump that changes a
 * loader or a roll function without changing a `.dat` file leaves `content/` identical, so
 * these are the only things that see it.
 */
function vectorsCheck(script: string, fixture?: string): OracleResult {
  const path = fixture === undefined ? [] : [fixture];
  return runOracle([script, "--check", ...path]);
}

/** What upstream's own loaders hold after `data.reload_all()`. */
export function contentVectorsCheck(fixture?: string): OracleResult {
  return vectorsCheck("tools/oracle/content_vectors.py", fixture);
}

/** CPython's Mersenne Twister, and the reference's own `chance.py` roll functions. */
export function randomVectorsCheck(fixture?: string): OracleResult {
  return vectorsCheck("tools/oracle/random_vectors.py", fixture);
}

/** The bound on `Player.log`, and what the reference drops on either side of a Save. */
export function logRingVectorsCheck(fixture?: string): OracleResult {
  return vectorsCheck("tools/oracle/log_ring.py", fixture);
}
