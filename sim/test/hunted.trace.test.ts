// boundary-intent harness: a test, so it decides what to drive and what to expect
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BASE_LOST_DISCOVERED,
  BASE_LOST_MAINTENANCE,
  SECONDS_PER_DAY,
  advance,
  content,
  createInitialState,
  newBase,
  type BaseState,
  type Draw,
  type SimulationState,
} from "../src/index.ts";
import { compareTraces, explain } from "./support/fidelity.ts";
import { oracleAvailable, oracleRequired, referenceTrace } from "./support/oracle.ts";
import { SCENARIO_SUFFIX, loadScenario, scenarioDirectory } from "./support/scenario.ts";
import { recordTrace, type PortRecord } from "./support/trace.ts";

// The fourth fidelity Scenario, and the one where the game takes bases back. `hunted` is an
// estate built up inside the grace period and then deliberately unbalanced: the servers that
// paid for everything are torn down, four Storage Units that earn nothing are left standing,
// and an unaffordable warehouse absorbs every coin made afterwards. From day 22 on,
// maintenance outruns income every single day.
//
// That is what turns on the two things `past-grace` could not reach. A shortfall is a *pool*
// drained base by base in iteration order, so where it runs dry decides who is exposed to the
// destruction roll at all; and a detection roll that comes true removes a base, names the
// group in the log, raises that group's suspicion, and reports itself as an Effect. Both are
// dense in draws, which is why the draw log is the half of this comparison that carries the
// most.

const runsTheOracle = oracleAvailable || oracleRequired;
const describeOracle = describe.skipIf(!runsTheOracle);

const HUNTED = "hunted";
const GROUPS = content.groups.all.length;
const EVENTS = content.events.all.length;

function huntedScenario() {
  return loadScenario(resolve(scenarioDirectory, `${HUNTED}${SCENARIO_SUFFIX}`));
}

let recorded: readonly PortRecord[] | undefined;
function portTrace(): readonly PortRecord[] {
  return (recorded ??= recordTrace(huntedScenario()).records);
}

interface RecordedBase {
  readonly name: string;
}

interface RecordedLogEntry {
  readonly log_id: string;
  readonly base_name?: string;
  readonly discovered_by_group_id?: string;
}

interface RecordedPlayer {
  readonly locations: readonly { readonly id: string; readonly bases: readonly RecordedBase[] }[];
  readonly log: readonly RecordedLogEntry[];
  readonly groups: readonly { readonly id: string; readonly suspicion: number }[];
  readonly last_discovery: string | null;
  readonly prev_discovery: string | null;
}

function player(record: PortRecord): RecordedPlayer {
  return record.persistent.player as unknown as RecordedPlayer;
}

function losses(record: PortRecord): RecordedLogEntry[] {
  return player(record).log.filter(
    (entry) => entry.log_id === BASE_LOST_MAINTENANCE || entry.log_id === BASE_LOST_DISCOVERED,
  );
}

/** The loss entries this step added — which is what its own removals wrote. */
function lossesAdded(record: PortRecord): RecordedLogEntry[] {
  const before = record.step === 0 ? [] : losses(portTrace()[record.step - 1] as PortRecord);
  return losses(record).slice(before.length);
}

function discoveriesAdded(record: PortRecord): RecordedLogEntry[] {
  return lossesAdded(record).filter((entry) => entry.log_id === BASE_LOST_DISCOVERED);
}

function effectsNamed(record: PortRecord, name: string) {
  return record.effects.filter((effect) => effect.name === name);
}

function drawsOf(record: PortRecord, fn: string): readonly Draw[] {
  return record.draws.filter((draw) => draw[0] === fn);
}

function groupSpecOf(internal: string) {
  const id = content.internalIds.backward.get("group")?.get(internal) ?? internal;
  return content.groups.byId.get(id);
}

describeOracle("an estate the game takes back", () => {
  it("matches the reference on every part of every record", () => {
    const scenario = huntedScenario();
    const divergence = compareTraces({
      scenario,
      port: recordTrace(scenario),
      reference: referenceTrace(`scenarios/${scenario.id}${SCENARIO_SUFFIX}`),
    });

    expect(
      divergence === undefined
        ? undefined
        : `step ${divergence.step} (${divergence.kind})\n${explain(divergence.difference)}\n` +
            `fixture: ${divergence.fixture}`,
    ).toBeUndefined();
  });

  // The comparison above covers everything below it, and covers it better. What it does not
  // do is *say* what the Scenario reaches: a Scenario that quietly stopped losing bases would
  // still match the reference, and would then be checking nothing.
  it("loses bases both ways: to unpaid maintenance and to a group that found them", () => {
    const final = losses(portTrace().at(-1) as PortRecord);

    expect(final.filter((entry) => entry.log_id === BASE_LOST_MAINTENANCE).length).toBeGreaterThan(
      0,
    );
    expect(final.filter((entry) => entry.log_id === BASE_LOST_DISCOVERED).length).toBeGreaterThan(
      0,
    );
    for (const entry of final) expect(entry.base_name).toMatch(/\S/);
  });

  it("names the base and the group, in the log and in the notification alike", () => {
    const steps = portTrace().filter((record) => lossesAdded(record).length > 0);
    expect(steps.length).toBeGreaterThan(0);

    for (const record of steps) {
      const added = lossesAdded(record);
      const messages = effectsNamed(record, "show_message");
      expect(messages, `step ${record.step}`).toHaveLength(added.length);

      for (const [index, entry] of added.entries()) {
        const message = messages[index]?.args[0] as string;
        expect(message, `step ${record.step}`).toContain(entry.base_name as string);
        expect(messages[index]?.kwargs, `step ${record.step}`).toEqual({ color: "red" });

        if (entry.log_id === BASE_LOST_DISCOVERED) {
          const group = groupSpecOf(entry.discovered_by_group_id as string);
          expect(group, `step ${record.step}`).toBeDefined();
          expect(message, `step ${record.step}`).toContain(group?.discoverDesc as string);
        } else {
          expect(entry.discovered_by_group_id, `step ${record.step}`).toBeUndefined();
          expect(message, `step ${record.step}`).toContain("disrepair");
        }
      }
    }
  });

  it("asks the Host to pause once per base lost, each pause before its notification", () => {
    const steps = portTrace().filter((record) => lossesAdded(record).length > 0);
    expect(steps.length).toBeGreaterThan(0);

    for (const record of steps) {
      const lost = lossesAdded(record).length;
      expect(
        effectsNamed(record, "find_speed_button").length,
        `step ${record.step}`,
      ).toBeGreaterThanOrEqual(lost);

      // `pause_game()` then `show_message(...)`, per base, in that order (`player.py:604`).
      const pairs = record.effects
        .map((effect) => effect.name)
        .filter((name) => name === "find_speed_button" || name === "show_message");
      for (const [index, name] of pairs.entries()) {
        if (name !== "show_message") continue;
        expect(pairs[index - 1], `step ${record.step}`).toBe("find_speed_button");
      }
    }
  });

  it("takes the base out of the estate it stood in", () => {
    for (const record of portTrace()) {
      const gone = lossesAdded(record).map((entry) => entry.base_name);
      if (gone.length === 0) continue;
      const standing = player(record).locations.flatMap((location) =>
        location.bases.map((base) => base.name),
      );
      for (const name of gone) expect(standing, `step ${record.step}`).not.toContain(name);
    }
  });

  it("raises the suspicion of the group that found it, and of no other", () => {
    let before = new Map<string, number>();
    let checked = 0;

    for (const record of portTrace()) {
      const now = new Map(player(record).groups.map((group) => [group.id, group.suspicion]));
      const found = discoveriesAdded(record).map((entry) => entry.discovered_by_group_id as string);

      if (found.length > 0) {
        checked += 1;
        for (const [id, suspicion] of now) {
          const was = before.get(id) ?? 0;
          // Every advance in this Scenario ends on midnight, so the daily decay has already
          // run: a group that found nothing can only have gone down.
          const where = `step ${record.step} ${id}`;
          if (found.includes(id)) expect(suspicion, where).toBeGreaterThan(was);
          else expect(suspicion, where).toBeLessThanOrEqual(was);
        }
      }
      before = now;
    }

    expect(checked).toBeGreaterThan(0);
  });

  it("shuffles the discovery locations only when more than one base fell at once", () => {
    const trace = portTrace();
    const shuffling = trace.filter((record) => drawsOf(record, "shuffle").length > 0);

    // The one on the first record is the region assignment a new game makes; every other one
    // is a tick that lost more than one base to a group.
    expect(shuffling[0]?.step).toBe(0);
    const inPlay = shuffling.slice(1);
    expect(inPlay.length).toBeGreaterThan(0);

    for (const record of inPlay) {
      const found = discoveriesAdded(record);
      expect(found.length, `step ${record.step}`).toBeGreaterThan(1);
      const permutation = drawsOf(record, "shuffle")[0]?.[1] as readonly number[];
      expect(permutation, `step ${record.step}`).toHaveLength(found.length);
    }

    // And a tick that lost exactly one picks it without drawing at all.
    const single = trace.filter((record) => discoveriesAdded(record).length === 1);
    expect(single.length).toBeGreaterThan(0);
    for (const record of single) {
      expect(drawsOf(record, "shuffle"), `step ${record.step}`).toHaveLength(0);
    }
  });

  it("carries the last and the previous discovery forward", () => {
    let before = { last: null as string | null, prev: null as string | null };
    let moved = 0;

    for (const record of portTrace()) {
      const now = {
        last: player(record).last_discovery,
        prev: player(record).prev_discovery,
      };
      const found = discoveriesAdded(record);

      if (found.length === 0) {
        expect(now, `step ${record.step}`).toEqual(before);
      } else {
        moved += 1;
        expect(now.last, `step ${record.step}`).not.toBeNull();
        // One discovery pushes the standing one back into the previous slot; more than one
        // fills both slots out of the same tick, which is what the shuffle is for.
        if (found.length === 1) expect(now.prev, `step ${record.step}`).toBe(before.last);
        else expect(now.prev, `step ${record.step}`).not.toBeNull();
      }
      before = now;
    }

    expect(moved).toBeGreaterThan(0);
  });
});

/**
 * A day's tick over `count` identical Storage Units and nothing else, past grace, with `cash`
 * in hand and no CPU anywhere — so the only income is nothing, the whole day's maintenance
 * falls due, and the draw log holds exactly three kinds of roll.
 *
 * A Storage Unit forces no CPU, so it is offline and earns nothing: the tick's shortfall is
 * `4 * count - cash` and cannot be paid off mid-tick by a job. That is what makes the count of
 * draws readable, and the count is the only place the Trace records where the pool ran out.
 *
 * The difficulty is `very-easy` for its long base grace, which these bases are pushed past by
 * hand anyway, and for the discover multiplier that keeps a whole day's detection walk from
 * hitting. A new game on `very-easy` also starts with the difficulty's two free techs finished
 * and `display_discover` at `full`, which the `head-start` Scenario compares against the
 * reference. It is a word on a screen and no roll moves for it, so these counts are unaffected.
 */
function starvingEstate(
  seed: number,
  count: number,
  cash: number,
): { readonly state: SimulationState; readonly draws: Draw[] } {
  const draws: Draw[] = [];
  const fresh = createInitialState({
    seed,
    difficulty: "very-easy",
    observeDraws: (draw) => draws.push(draw),
  });

  const spec = content.bases.byId.get("Storage Unit");
  if (!spec) throw new Error("the pinned content has lost the Storage Unit");
  const bases: BaseState[] = Array.from({ length: count }, (_, index) => ({
    ...newBase(spec, `Vault ${index + 1}`, 0, fresh.laborBonus, true),
    graceOver: true,
  }));

  const state: SimulationState = {
    ...fresh,
    gameTime: 30 * SECONDS_PER_DAY,
    // Grace is over and its warning has already been shown, so the tick emits nothing for it.
    hadGrace: false,
    cash,
    partialCash: 0,
    availableCpus: [0, 0, 0, 0, 0],
    sleepingCpus: 0,
    locations: fresh.locations.map((location, index) =>
      index === 0 ? { ...location, bases } : { ...location, bases: [] },
    ),
  };

  draws.length = 0;
  return { state, draws };
}

/** The daily maintenance one Storage Unit owes, unmodified by any location. */
const VAULT_MAINTENANCE = 50;

describe("the maintenance shortfall pool", () => {
  // Upstream reassigns the shortfall as it walks (`player.py:914,925`), so a base reached
  // after it has emptied is passed over **without a draw**. The draw log is the only place a
  // Trace records that, which is why this is read off a count rather than off the state.
  it("drains base by base and stops rolling once it is empty", () => {
    const full = starvingEstate(1, 3, 0);
    const dry = starvingEstate(1, 3, VAULT_MAINTENANCE + 10);

    // Nothing standing dies in either run, so the two differ only in how far the pool reached.
    const whole = advance(full.state, SECONDS_PER_DAY);
    const partial = advance(dry.state, SECONDS_PER_DAY);
    expect(whole.state.log).toEqual([]);
    expect(partial.state.log).toEqual([]);

    // A shortfall covering all three: one maintenance roll each, then a detection roll per
    // group per base, then the Event check.
    expect(full.draws).toHaveLength(3 + GROUPS * 3 + EVENTS);
    // Sixty in hand pays the first base's share and part of the second's, so the pool is empty
    // by the time the walk reaches the third — which is therefore never rolled for.
    expect(dry.draws).toHaveLength(2 + GROUPS * 3 + EVENTS);
  });

  it("passes over a base that owes nothing in the resource that fell short", () => {
    // Every base here owes cash, so the count above is the one to compare against: a base
    // whose cash maintenance is zero is skipped before the pool is touched at all.
    const { state, draws } = starvingEstate(1, 2, 0);
    const free = state.locations.map((location, index) =>
      index === 0
        ? {
            ...location,
            bases: location.bases.map((base, at) =>
              at === 0 ? { ...base, maintenance: [0, 0, 0] as const } : base,
            ),
          }
        : location,
    );

    advance({ ...state, locations: free }, SECONDS_PER_DAY);
    expect(draws).toHaveLength(1 + GROUPS * 2 + EVENTS);
  });
});

describe("a base condemned for maintenance", () => {
  // Upstream's condition is `not (grace or dead or base.has_grace())`, so a base the
  // shortfall killed is never offered to the detection walk — and its own grace latch is not
  // settled either, because `has_grace()` is what settles it.
  const KILLING_SEED = 9;

  it("is not also rolled for detection in the same tick", () => {
    const { state, draws } = starvingEstate(KILLING_SEED, 2, 0);
    const result = advance(state, SECONDS_PER_DAY);

    expect(result.state.log.map((entry) => entry.kind)).toEqual([BASE_LOST_MAINTENANCE]);
    // Both bases are rolled for maintenance; only the survivor is rolled for detection.
    expect(draws).toHaveLength(2 + GROUPS * 1 + EVENTS);

    // The same estate at a seed whose rolls all miss costs a detection walk for both.
    const quiet = starvingEstate(1, 2, 0);
    advance(quiet.state, SECONDS_PER_DAY);
    expect(quiet.draws).toHaveLength(2 + GROUPS * 2 + EVENTS);
  });

  it("asks for a pause and reports itself, naming no group", () => {
    const { state } = starvingEstate(KILLING_SEED, 2, 0);
    const result = advance(state, SECONDS_PER_DAY);

    expect(result.effects).toEqual([
      { kind: "pause" },
      {
        kind: "baseLost",
        baseName: "Vault 1",
        // The Effect names where the base stood, so the Host never has to pair it back up
        // with a log entry it has already lost sight of.
        locationId: state.locations[0]?.specId,
        discoveredBy: null,
      },
    ]);
    const entry = result.state.log[0];
    expect(entry?.fields.base_name).toBe("Vault 1");
    expect(entry?.fields.discovered_by_group_id).toBeUndefined();
    expect(entry?.rawEmitTime).toBe(31 * SECONDS_PER_DAY);
  });
});

// The Scenario this suite compares, as the manifest knows it: a Scenario the manifest does
// not know is a comparison against nothing.
describe("the fidelity gate", () => {
  it("has this Scenario, and it is the one the manifest knows", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(scenarioDirectory, "manifest.json"), "utf8"),
    ) as { scenarios: Record<string, { steps: number }> };

    expect(manifest.scenarios[HUNTED]?.steps).toBe(huntedScenario().script.length);
  });
});
