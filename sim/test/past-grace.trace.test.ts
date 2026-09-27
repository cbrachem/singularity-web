// boundary-intent harness: a test, so it decides what to drive and what to expect
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  AUTOSAVE,
  BASE_LOST_DISCOVERED,
  EVENT_EMITTED,
  GRACE_WARNING,
  PAUSE,
  SECONDS_PER_DAY,
  advance,
  baseLostEffect,
  content,
  createInitialState,
  detectChance,
  eventTriggeredEffect,
  expireEvents,
  inGracePeriod,
  settleGrace,
  storyEffect,
  triggerEvent,
  type BaseState,
  type Draw,
  type Effect,
  type SimulationState,
} from "../src/index.ts";
import { compareTraces, explain, firstDifference } from "./support/fidelity.ts";
import { NORMALISATIONS } from "./support/normalisation.ts";
import {
  oracleAvailable,
  oracleRequired,
  referenceEffectSurface,
  referenceTrace,
} from "./support/oracle.ts";
import { SCENARIO_SUFFIX, loadScenario, scenarioDirectory } from "./support/scenario.ts";
import {
  asReferenceEffect,
  comparableParts,
  recordTrace,
  type ComparableRecord,
  type PortRecord,
} from "./support/trace.ts";

// The second fidelity Scenario, and the one that turns on everything the first deliberately
// avoided. Losing the grace period starts three things at once: the port's first Effects, the
// detection rolls, and event checking — so the draw log stops being empty and becomes the
// half of the comparison that carries the most.
//
// The Scenario is `past-grace`: an empty game to day 70 on mixed tick partitions. It reaches
// the grace warning on day 23, an Event that fires on day 43 and expires at midnight on day
// 65, and a second that fires on day 56 — and its base is never discovered, so the rolls are
// all misses and the estate never moves. What a hit does is `hunted`'s Scenario.

const runsTheOracle = oracleAvailable || oracleRequired;
const describeOracle = describe.skipIf(!runsTheOracle);

const PAST_GRACE = "past-grace";

function pastGraceScenario() {
  return loadScenario(resolve(scenarioDirectory, `${PAST_GRACE}${SCENARIO_SUFFIX}`));
}

let recorded: readonly PortRecord[] | undefined;
function portTrace(): readonly PortRecord[] {
  return (recorded ??= recordTrace(pastGraceScenario()).records);
}

const GROUPS = content.groups.all.length;
const EVENTS = content.events.all.length;

/** What one base costs a tick that is past grace: a roll per group, then a roll per Event. */
const QUIET_TICK_DRAWS = GROUPS + EVENTS;

function drawsPerStep(): number[] {
  return portTrace().map((record) => record.draws.length);
}

function effectNames(record: PortRecord): string[] {
  return record.effects.map((effect) => effect.name);
}

describeOracle("an empty game past the grace period", () => {
  it("matches the reference on every part of every record", () => {
    const scenario = pastGraceScenario();
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

  // The full comparison above already covers this, and covers it better; what it does not do
  // is *say* it. A draw log that matched for the wrong reason — the right count from the
  // wrong rolls — would pass the comparison only by accident, so the counts are read back
  // here against the two collections whose sizes decide them.
  it("consumes one draw per group per base and one per untriggered Event, every tick", () => {
    const counts = drawsPerStep();
    const scenario = pastGraceScenario();

    // Creating the game draws three times and rides on the first record; the grace period
    // then draws nothing at all until the tick that ends it.
    expect(counts[0]).toBe(3);
    expect(counts.slice(1, 23)).toEqual(counts.slice(1, 23).map(() => 0));

    // Every tick from the loss of grace onwards rolls: once per group per base, and then
    // once per Event that is not already triggered. An Event that fires stops the check
    // where it hit, so its own tick is shorter; every tick after it is shorter by one for as
    // long as that Event stays triggered, and longer again the midnight it expires.
    expect(counts[23]).toBe(QUIET_TICK_DRAWS);
    let firings = 0;
    for (const record of portTrace().slice(23)) {
      const rolled = GROUPS * basesIn(record) + untriggeredBefore(record).length;
      if (effectNames(record).includes("show_message")) {
        firings += 1;
        expect(record.draws.length, `step ${record.step} fired`).toBeGreaterThan(0);
        expect(record.draws.length, `step ${record.step} fired`).toBeLessThanOrEqual(rolled);
      } else {
        expect(record.draws.length, `step ${record.step}`).toBe(rolled);
      }
    }

    expect(firings).toBeGreaterThan(0);
    expect(counts).toHaveLength(scenario.script.length);
  });

  /**
   * Which Event fires is decided by the order the loader pinned, and nothing else: the walk
   * skips what is triggered, rolls the rest in order and returns on the first hit, so the
   * Event that fires is the one the order put at the index the stream stopped at. Read here
   * out of the draw count, which is the only place a Trace records where the walk stopped.
   *
   * That the order is *contract* — that changing it changes the trace — is not shown here.
   * It is shown by actually reordering the collection, in "the order the loader pinned".
   */
  it("fires the Event the pinned order puts where the stream hit", () => {
    const firing = portTrace().filter((record) => effectNames(record).includes("show_message"));
    expect(firing.length).toBeGreaterThan(0);

    for (const record of firing) {
      // The rolls before the Event check are the detection ones — one per group per base —
      // and the check stops on the roll that hit, so its index follows from the count.
      const eventRolls = record.draws.length - GROUPS * basesIn(record);
      const untriggered = untriggeredBefore(record);
      const chosen = untriggered[eventRolls - 1];

      const fired = record.effects.find((effect) => effect.name === "show_message");
      expect(fired?.args, `step ${record.step}`).toEqual([
        content.events.byId.get(chosen as string)?.description,
      ]);
    }
  });

  // `new_day`'s second loop (`player.py:571`). Only an Event with a duration expires, and
  // only at the first midnight past it; a unique one stays triggered for the rest of the
  // game. Read off the Trace, because that is where both halves are visible at once — the
  // flag going back to zero, and the extra roll the next tick makes because of it.
  it("expires a decayable Event at midnight, and keeps a unique one", () => {
    const flips = triggerFlips();
    expect(flips.filter((flip) => flip.to === 1).length).toBeGreaterThan(0);

    const expired = flips.filter((flip) => flip.to === 0);
    expect(expired.length).toBeGreaterThan(0);
    for (const flip of expired) {
      const spec = content.events.byId.get(flip.eventId);
      expect(spec?.duration, flip.eventId).not.toBeNull();
      expect(flip.at % SECONDS_PER_DAY, "expiry runs at midnight").toBe(0);
      expect(flip.at - flip.triggeredAt).toBeGreaterThan(
        (spec?.duration as number) * SECONDS_PER_DAY,
      );
    }

    // And what never expires: an Event without a duration is still triggered at the end.
    const last = player(portTrace().at(-1));
    const unique = (last?.events ?? []).filter(
      (event) => content.events.byId.get(specIdOf(event.id))?.duration === null,
    );
    expect(unique.length).toBeGreaterThan(0);
    expect(unique.every((event) => event.triggered === 1)).toBe(true);
  });

  it("shows the grace warning once, as an Effect, and never again", () => {
    const warnings = portTrace().filter((record) =>
      effectNames(record).includes("show_story_section"),
    );

    expect(warnings.map((record) => record.step)).toHaveLength(1);
    const warning = warnings[0] as PortRecord;

    // A pause request comes first and the warning second — upstream's order, and the reason
    // the effect list is ordered rather than a set.
    expect(warning.effects).toEqual([
      { kind: "call", name: "find_speed_button", args: [], kwargs: {} },
      { kind: "call", name: "show_story_section", args: [GRACE_WARNING], kwargs: {} },
    ]);
  });
});

interface RecordedEvent {
  readonly id: string;
  readonly triggered: number;
  readonly triggered_at: number;
}

interface RecordedPlayer {
  readonly events: readonly RecordedEvent[];
  readonly locations: readonly { readonly bases: readonly unknown[] }[];
  readonly log: readonly { readonly log_id: string; readonly event_id?: string }[];
}

function player(record: PortRecord | undefined): RecordedPlayer | undefined {
  return record?.persistent.player as RecordedPlayer | undefined;
}

function basesIn(record: PortRecord): number {
  return (player(record)?.locations ?? []).reduce(
    (total, location) => total + location.bases.length,
    0,
  );
}

/** The Events not yet triggered when this step began — the ones its check rolled. */
function untriggeredBefore(record: PortRecord): string[] {
  const triggered = new Set(
    (player(portTrace()[record.step - 1])?.events ?? [])
      .filter((event) => event.triggered !== 0)
      .map((event) => event.id),
  );
  return content.events.all
    .map((spec) => spec.id)
    .filter((id) => !triggered.has(internalEventId(id)));
}

function internalEventId(id: string): string {
  return content.internalIds.forward.get("event")?.get(id) ?? id;
}

function specIdOf(internal: string): string {
  return content.internalIds.backward.get("event")?.get(internal) ?? internal;
}

interface TriggerFlip {
  readonly eventId: string;
  readonly to: number;
  /** The game time of the step the flag moved in. */
  readonly at: number;
  /** When the Event was triggered, which expiry is measured against. */
  readonly triggeredAt: number;
}

/** Every place an Event's `triggered` flag moved, across the whole Trace. */
function triggerFlips(): TriggerFlip[] {
  const flips: TriggerFlip[] = [];
  let before = new Map<string, { triggered: number; triggered_at: number }>();

  for (const record of portTrace()) {
    const now = new Map(
      (player(record)?.events ?? []).map((event) => [
        event.id,
        event as { triggered: number; triggered_at: number },
      ]),
    );
    for (const [id, event] of now) {
      const was = before.get(id);
      if ((was?.triggered ?? 0) === event.triggered) continue;
      flips.push({
        eventId: specIdOf(id),
        to: event.triggered,
        at: record.persistent.game_time as number,
        triggeredAt: was?.triggered_at ?? event.triggered_at,
      });
    }
    before = now;
  }
  return flips;
}

/** A second Simulation, and the recorder that drives it, built over reordered Content. */
interface Rebuilt {
  readonly content: typeof content;
  readonly recordTrace: typeof recordTrace;
}

/**
 * Run `use` against a Simulation rebuilt over a differently ordered `events.dat`.
 *
 * Content is resolved once at module load and the Simulation owns it rather than being
 * handed it (`sim/src/content/index.ts`), so there is no seam a reordered collection could
 * be passed through — and adding one would be a seam that exists only for a test.
 * Reordering therefore means here what it means in production: a different document, and a
 * module graph built over it. `vi.resetModules` plus a mock of the single module that reaches
 * the committed JSON is exactly that, and every line under test is the shipped one.
 */
async function overReorderedEvents<T>(
  reorder: (ids: readonly string[]) => readonly string[],
  use: (rebuilt: Rebuilt) => T,
): Promise<T> {
  vi.resetModules();
  vi.doMock("../src/content/documents.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/content/documents.ts")>(
      "../src/content/documents.ts",
    );
    const records = actual.rawContent.events.records;
    const byId = new Map(records.map((record) => [record.id, record]));
    const reordered = reorder(records.map((record) => record.id)).map((id) => {
      const record = byId.get(id);
      if (!record) throw new Error(`the reordering names an Event the content has not: ${id}`);
      return record;
    });
    // A reordering that lost or duplicated a record would be a different collection, and the
    // tests below would then be measuring something other than the order.
    if (reordered.length !== records.length || new Set(reordered).size !== records.length) {
      throw new Error(
        `the reordering returned ${new Set(reordered).size} distinct of ${records.length} Events`,
      );
    }
    return {
      rawContent: {
        ...actual.rawContent,
        events: { ...actual.rawContent.events, records: reordered },
      },
    };
  });
  try {
    return use({
      content: (await import("../src/index.ts")).content,
      recordTrace: (await import("./support/trace.ts")).recordTrace,
    });
  } finally {
    vi.doUnmock("../src/content/documents.ts");
    vi.resetModules();
  }
}

/**
 * The two Events that carry a duration. Swapping *these* two is the reordering that isolates
 * the claim: any other pair would also change which Event expires, and the draw log with it.
 */
const DECAYABLE_PAIR = ["scandal", "investigation"] as const;

function swapDecayablePair(ids: readonly string[]): readonly string[] {
  const swapped = [...ids];
  const [left, right] = DECAYABLE_PAIR.map((id) => swapped.indexOf(id));
  if (left === undefined || right === undefined || left < 0 || right < 0) {
    throw new Error(`the pinned content has lost ${DECAYABLE_PAIR.join(" or ")}`);
  }
  [swapped[left], swapped[right]] = [swapped[right] as string, swapped[left] as string];
  return swapped;
}

function firstFiringStep(trace: readonly PortRecord[]): number {
  const step = trace.findIndex((record) => effectNames(record).includes("show_message"));
  if (step < 0) throw new Error("the Scenario fired no Event");
  return step;
}

function firstMovedStep(pinned: readonly PortRecord[], moved: readonly PortRecord[]): number {
  return pinned.findIndex(
    (record, step) =>
      firstDifference(comparableParts(record), comparableParts(moved[step] as PortRecord)) !==
      undefined,
  );
}

/** Where two records first differ inside one part of the comparison, as a path. */
function movedPath(pinned: PortRecord, moved: PortRecord, part: keyof ComparableRecord): string {
  const difference = firstDifference(
    comparableParts(pinned)[part],
    comparableParts(moved)[part],
    part,
  );
  return difference?.path ?? "<equal>";
}

function firedDescription(record: PortRecord): unknown {
  return record.effects.find((effect) => effect.name === "show_message")?.args[0];
}

function loggedEventIds(record: PortRecord): string[] {
  return (player(record)?.log ?? [])
    .filter((entry) => entry.log_id === EVENT_EMITTED)
    .map((entry) => specIdOf(entry.event_id as string));
}

function gameTimeOf(record: PortRecord): number {
  return record.persistent.game_time as number;
}

/**
 * Criterion 3: the order is contract, so a reordering has to be able to make a test go red.
 *
 * The order decides which Event the check hits, because the walk skips what is triggered and
 * returns on the first roll that succeeds (`player.py:452`). What it does *not* decide in
 * this content is the draw log — and that is a consequence of two properties of the pinned
 * records rather than a happy accident, so both are asserted here instead of being left for
 * a later reader to rediscover: every record carries the same chance, and a reordering that
 * also changes which Event *expires* moves the draw log after all.
 */
describe("the order the loader pinned", () => {
  // With one chance shared by all of them, every roll of the walk is compared against the
  // same threshold. So the index at which the walk stops is a property of the draw stream and
  // not of the order: a reordering renames the Event found at that index without moving the
  // draw that found it. Add a record at another chance and that stops holding, which is why
  // it is asserted here rather than relied on silently.
  it("puts the same chance on every Event, which is why the walk hits at the same index", () => {
    const chances = new Set(content.events.all.map((spec) => spec.chance));

    expect(EVENTS).toBeGreaterThan(1);
    expect(chances.size, `chances: ${[...chances].join(", ")}`).toBe(1);
    expect(new Set(content.events.all.map((spec) => spec.id)).size).toBe(EVENTS);
  });

  it("decides which Event fires: swapping two records moves the trace and no draw", async () => {
    const pinned = portTrace();
    const scenario = pastGraceScenario();
    const moved = await overReorderedEvents(
      swapDecayablePair,
      ({ content: rebuilt, recordTrace: record }) => {
        const order = rebuilt.events.all.map((spec) => spec.id);
        // It really is a different collection, and really is the same eight records.
        expect(order).not.toEqual(content.events.all.map((spec) => spec.id));
        expect([...order].sort()).toEqual(content.events.all.map((spec) => spec.id).sort());
        return record(scenario).records;
      },
    );

    // Not one draw moved, in any step, in either direction: the reordered run walks the same
    // stream and stops at the same index of it.
    expect(moved.map((record) => record.draws)).toEqual(pinned.map((record) => record.draws));

    // And the compared trace did move — at the step the first Event fired, and nowhere before.
    const firing = firstFiringStep(pinned);
    expect(firstMovedStep(pinned, moved)).toBe(firing);

    const before = pinned[firing] as PortRecord;
    const after = moved[firing] as PortRecord;

    // The observable that carries the difference, named: the Event notification's own text —
    // the words `asReferenceEffect` resolves out of Content for the Event that fired.
    expect(movedPath(before, after, "effects")).toBe("effects[1].args[0]");
    expect(firedDescription(before)).toBe(content.events.byId.get("investigation")?.description);
    expect(firedDescription(after)).toBe(content.events.byId.get("scandal")?.description);

    // The state moved with it, in the two places firing an Event writes: the Event's own
    // record, and the log entry `trigger_event` emits.
    expect(movedPath(before, after, "persistent")).toBe("persistent.player.events[0].id");
    expect(specIdOf(player(before)?.events[0]?.id as string)).toBe("investigation");
    expect(specIdOf(player(after)?.events[0]?.id as string)).toBe("scandal");
    expect(loggedEventIds(before)).toEqual(["investigation"]);
    expect(loggedEventIds(after)).toEqual(["scandal"]);

    // And the consequence moved with it: the two carry the same instruction against the same
    // group with the amount negated, so the swap is not a rename of the same outcome. What
    // that does to the group is asserted in "what firing an Event does to the state" —
    // `changedDiscoverBonus` is not persisted upstream, so it is not in this comparison.
    const [scandal, investigation] = DECAYABLE_PAIR.map((id) => content.events.byId.get(id));
    expect(scandal?.effectStack.slice(0, 2)).toEqual(investigation?.effectStack.slice(0, 2));
    expect(Number(scandal?.effectStack[2])).toBe(-Number(investigation?.effectStack[2]));
  });

  it("moves the draw log too, once the reordering changes which Event expires", async () => {
    const pinned = portTrace();
    const scenario = pastGraceScenario();
    const moved = await overReorderedEvents(
      (ids) => [...ids].reverse(),
      ({ recordTrace: record }) => record(scenario).records,
    );

    // Reversed, the index the walk stops at holds a unique Event where the pinned order held
    // a decayable one. Both runs still fire at the same step, on the same draws.
    const firing = firstFiringStep(pinned);
    expect(firstFiringStep(moved)).toBe(firing);
    const durationFiredIn = (trace: readonly PortRecord[]): number | null => {
      const fired = specIdOf(player(trace[firing])?.events[0]?.id as string);
      return content.events.byId.get(fired)?.duration ?? null;
    };
    expect(durationFiredIn(pinned)).not.toBeNull();
    expect(durationFiredIn(moved)).toBeNull();

    // So one run expires its Event at a midnight and the other never does, the pools of
    // untriggered Events stop matching, and the check rolls a different number of times from
    // the next tick on. That is where the draw log parts: after the firing rather than at it,
    // and by a count rather than by a value.
    const parted = pinned.findIndex(
      (record, step) =>
        firstDifference(record.draws, (moved[step] as PortRecord).draws) !== undefined,
    );
    expect(parted).toBeGreaterThan(firing);
    const expiry = (durationFiredIn(pinned) as number) * SECONDS_PER_DAY;
    expect(gameTimeOf(pinned[parted] as PortRecord)).toBeGreaterThan(
      gameTimeOf(pinned[firing] as PortRecord) + expiry,
    );
    expect((pinned[parted] as PortRecord).draws.length).not.toBe(
      (moved[parted] as PortRecord).draws.length,
    );
  });
});

// The gate this Scenario is part of. `check:fidelity` runs vitest with name filters, which
// have to reach this file as well as every other fidelity suite — a Scenario the manifest
// does not know, or a file no filter reaches, is a gate that runs nothing.
describe("the fidelity gate", () => {
  it("has this Scenario, and it is the one the manifest knows", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(scenarioDirectory, "manifest.json"), "utf8"),
    ) as { scenarios: Record<string, { steps: number }> };

    expect(manifest.scenarios[PAST_GRACE]?.steps).toBe(pastGraceScenario().script.length);
  });
});

describe("the Effects the tick returns", () => {
  const state = () => createInitialState({ seed: 1, difficulty: "normal" });

  // Effects are tagged, serializable and ordered. The third is a property of the list a tick
  // returns rather than of an Effect, and is asserted where a real tick produces one:
  // "shows the grace warning once, as an Effect, and never again" pins the pause before the
  // warning, and "applies the consequence, marks the Event, and writes one log entry" pins
  // the pause before the Event notification. Nothing here can show it, so nothing here
  // claims it.
  it("are tagged and serializable", () => {
    const every: readonly Effect[] = [
      AUTOSAVE,
      PAUSE,
      storyEffect(GRACE_WARNING),
      eventTriggeredEffect("the-plague"),
      baseLostEffect("University Computer", "N AMERICA", "news"),
    ];

    // Tagged: `kind` is the discriminant and every kind is distinct.
    expect(new Set(every.map((effect) => effect.kind)).size).toBe(every.length);
    // Serializable: a round trip through JSON is the identity, which is what lets an Effect
    // sit in a Trace record and in a Save without a second representation.
    expect(every.map((effect) => JSON.parse(JSON.stringify(effect)))).toEqual([...every]);
  });

  // Speed belongs to the Host. `pause_game` sets `g.curr_speed = 0` upstream; the
  // port has no speed to set, and the tick that loses grace asks instead. The request is
  // therefore observable only in the effect list — a state-only Trace would never see it.
  it("ask for a pause rather than setting a speed the Simulation does not own", () => {
    const past = { ...state(), gameTime: 23 * SECONDS_PER_DAY - 1 };
    const result = advance(past, 1);

    expect(result.effects[0]).toEqual({ kind: "pause" });
    expect(result.effects[1]).toEqual({ kind: "story", sectionId: GRACE_WARNING });
    // Nothing about a speed reached the state, because there is nothing there to reach.
    expect(Object.keys(result.state)).not.toContain("speed");
    expect(Object.keys(result.state)).not.toContain("currSpeed");
  });

  it("fire the grace warning exactly once, because the latch is state", () => {
    let current: SimulationState = { ...state(), gameTime: 23 * SECONDS_PER_DAY - 1 };
    expect(inGracePeriod(current)).toBe(true);

    const crossing = advance(current, 1);
    current = crossing.state;
    expect(current.hadGrace).toBe(false);
    expect(inGracePeriod(current)).toBe(false);
    expect(crossing.effects.filter((effect) => effect.kind === "story")).toHaveLength(1);

    // Ten more ticks past the boundary, and the warning does not come back.
    for (let tick = 0; tick < 10; tick += 1) {
      const next = advance(current, 3600);
      current = next.state;
      expect(next.effects.filter((effect) => effect.kind === "story")).toEqual([]);
    }
  });
});

// An Event's consequence is a stack of instructions it applies to the player
// (`effect.py:38`), and most of what it touches is *not* in the compared surface: a group's
// changed discover bonus is neither persisted by upstream nor rebuilt at load, so it reaches
// a Trace only through the detection chances it later moves. It is asserted directly here.
describe("what firing an Event does to the state", () => {
  const DECAYING = "scandal";
  const decaying = () => {
    const spec = content.events.byId.get(DECAYING);
    if (!spec) throw new Error(`the pinned content has no ${DECAYING}`);
    return spec;
  };

  const at = (gameTime: number): SimulationState => ({
    ...createInitialState({ seed: 1, difficulty: "normal" }),
    gameTime,
    hadGrace: false,
  });

  const bonusOf = (state: SimulationState, groupId: string): number => {
    const group = state.groups.find((candidate) => candidate.specId === groupId);
    if (!group) throw new Error(`no such group: ${groupId}`);
    return group.changedDiscoverBonus;
  };

  it("applies the consequence, marks the Event, and writes one log entry", () => {
    const spec = decaying();
    // `["discover", "news", "1000"]`, and `discover` alters the bonus by the *negated*
    // amount (`effect.py:95`) — which is the kind of quirk a summary would smooth over.
    expect(spec.effectStack).toEqual(["discover", "news", "1000"]);

    const before = at(30 * SECONDS_PER_DAY);
    const fired = triggerEvent(before, spec);

    expect(fired.state.events).toEqual([
      { specId: DECAYING, triggered: 1, triggeredAt: 30 * SECONDS_PER_DAY },
    ]);
    expect(bonusOf(fired.state, "news")).toBe(bonusOf(before, "news") - 1000);
    expect(bonusOf(fired.state, "covert")).toBe(bonusOf(before, "covert"));
    expect(fired.state.log).toEqual([
      { kind: EVENT_EMITTED, rawEmitTime: 30 * SECONDS_PER_DAY, fields: { event_id: DECAYING } },
    ]);
    expect(fired.effects).toEqual([PAUSE, eventTriggeredEffect(DECAYING)]);
  });

  it("undoes exactly that much when the Event expires, and not before", () => {
    const spec = decaying();
    const duration = (spec.duration as number) * SECONDS_PER_DAY;
    const fired = triggerEvent(at(30 * SECONDS_PER_DAY), spec).state;

    // `is_past_expiry_date` is a strict inequality: the midnight that lands exactly on the
    // duration is still inside it.
    const onTheDay = expireEvents({ ...fired, gameTime: 30 * SECONDS_PER_DAY + duration });
    expect(onTheDay.events[0]?.triggered).toBe(1);
    expect(bonusOf(onTheDay, "news")).toBe(-1000);

    const after = expireEvents({
      ...fired,
      gameTime: 30 * SECONDS_PER_DAY + duration + SECONDS_PER_DAY,
    });
    expect(after.events[0]).toEqual({ specId: DECAYING, triggered: 0, triggeredAt: -1 });
    expect(bonusOf(after, "news")).toBe(0);
  });

  it("fires an Event again once it has expired, reusing its record", () => {
    const spec = decaying();
    const expired: SimulationState = {
      ...at(60 * SECONDS_PER_DAY),
      events: [{ specId: DECAYING, triggered: 0, triggeredAt: -1 }],
    };
    const again = triggerEvent(expired, spec);

    // The record is rewritten rather than appended to, which is what keeps the order of
    // `events` the order Events *first* fired — the order the save schema writes out.
    expect(again.state.events).toEqual([
      { specId: DECAYING, triggered: 1, triggeredAt: 60 * SECONDS_PER_DAY },
    ]);
    expect(bonusOf(again.state, "news")).toBe(-1000);
  });
});

// `_check_event` is handed `give_time`'s own argument rather than the seconds the tick
// advanced (`player.py:441`), so a tick cut short at midnight rolls against the interval it
// was *asked* for. The reference cannot be driven to the contrast — deviation 1 means it
// discards the remainder rather than carrying it, so no Scenario compared step for step
// crosses a midnight — and it is therefore asserted here, against the two
// intervals themselves.
describe("event checking and the requested time", () => {
  // Seed 13 is chosen, not arbitrary: from 23:00 on the last day of grace, the first Event
  // roll of the next tick lands between the chance of one hour and the chance of twenty
  // days. So the same draw decides differently depending on which of the two the rule uses,
  // and nothing else about the two advances differs.
  const SEED = 13;
  const START = 23 * SECONDS_PER_DAY - 3600;
  const MIDNIGHT = 23 * SECONDS_PER_DAY;
  const CROSSING = 3600 + 20 * SECONDS_PER_DAY;

  function pastGrace(observe: (draw: Draw) => void = () => {}): SimulationState {
    const fresh = createInitialState({
      seed: SEED,
      difficulty: "normal",
      observeDraws: observe,
    });
    return { ...fresh, gameTime: START, hadGrace: false };
  }

  it("rolls the requested interval, not the one the midnight break allowed", () => {
    const hour = advance(pastGrace(), 3600);
    expect(hour.state.gameTime).toBe(MIDNIGHT);
    expect(hour.state.events).toEqual([]);

    const crossing = advance(pastGrace(), CROSSING);
    const fired = crossing.state.events.filter((event) => event.triggeredAt === MIDNIGHT);

    // The tick that advanced to midnight advanced one hour in both runs. It fired an Event
    // only in the run that asked for twenty days, which is the whole of the rule.
    expect(fired).toHaveLength(1);
  });

  it("consumes the same draws either way, so the interval is the only difference", () => {
    const drawsOf = (seconds: number): Draw[] => {
      let seen: Draw[] = [];
      const state = pastGrace((draw) => seen.push(draw));
      seen = [];
      advance(state, seconds);
      return seen;
    };

    const hour = drawsOf(3600);
    const crossing = drawsOf(CROSSING);

    // A quiet hour rolls every group and then every Event, and stops.
    expect(hour).toHaveLength(QUIET_TICK_DRAWS);
    // The crossing run draws from the same generator in the same order, so every draw the
    // quiet hour made was made again, to the number. What differed is what the rule compared
    // them against — and the crossing run went on drawing, because it went on ticking.
    expect(crossing.slice(0, hour.length)).toEqual(hour);
    expect(crossing.length).toBeGreaterThan(hour.length);
  });
});

// Detection is the other thing the end of grace turns on, and the Scenario above reaches its
// rolls without ever reaching a hit. What a hit *does* is `hunted`'s; what stays here is the
// shape of the walk itself — the chances it rolls against, the grace latch it settles on the
// way past, and the group the first true roll gives the base to.
describe("the detection rolls", () => {
  const newGame = () => createInitialState({ seed: 1, difficulty: "normal" });

  it("rolls once per group, including for the groups a base type does not name", () => {
    const state = newGame();
    const location = state.locations.find((candidate) => candidate.bases.length > 0);
    const base = location?.bases[0] as BaseState;
    const chances = detectChance(state, base, location?.specId as string);

    // Four entries for four groups: the three the base type names, in the order `bases.dat`
    // wrote them, and then the one it does not — at a chance of zero, and rolled all the same.
    expect([...chances.keys()]).toHaveLength(GROUPS);
    expect([...chances.keys()].slice(0, 3)).toEqual(["news", "covert", "public"]);
    expect(chances.get("science")).toBe(0);
  });

  it("settles a base's own grace during the tick rather than when asked", () => {
    const state = newGame();
    const location = state.locations.find((candidate) => candidate.bases.length > 0);
    const base = location?.bases[0] as BaseState;

    // The starting base costs no labor, so its own grace is over the first minute that
    // passes — and the latch is written, not recomputed.
    expect(base.graceOver).toBe(false);
    expect(settleGrace(state, base).hasGrace).toBe(true);

    const older = { ...state, gameTime: SECONDS_PER_DAY };
    const settled = settleGrace(older, base);
    expect(settled.hasGrace).toBe(false);
    expect(settled.base.graceOver).toBe(true);
    // Reading it again cannot change it back, and does not re-derive it.
    expect(settleGrace(state, settled.base)).toEqual({ base: settled.base, hasGrace: false });
  });

  it("gives the base to the first group whose roll comes true, and stops there", () => {
    // A discover bonus large enough that a whole day's roll cannot miss for *any* group, so
    // which one claims the base is decided by the walk's order and by nothing else.
    const draws: Draw[] = [];
    const state = createInitialState({
      seed: 1,
      difficulty: "normal",
      observeDraws: (draw) => draws.push(draw),
    });
    const certain: SimulationState = {
      ...state,
      gameTime: 23 * SECONDS_PER_DAY,
      groups: state.groups.map((group) => ({ ...group, changedDiscoverBonus: 1_000_000_000 })),
    };

    const location = certain.locations.find((candidate) => candidate.bases.length > 0);
    const base = location?.bases[0] as BaseState;
    const first = [...detectChance(certain, base, location?.specId as string).keys()][0];

    draws.length = 0;
    const result = advance(certain, SECONDS_PER_DAY);

    // The base is gone, the entry names the group the order put first, and the walk stopped
    // there: one detection draw, not one per group.
    expect(result.state.locations.every((place) => place.bases.length === 0)).toBe(true);
    const lost = result.state.log.find((entry) => entry.kind === BASE_LOST_DISCOVERED);
    expect(lost?.fields.discovered_by_group_id).toBe(first);
    expect(lost?.fields.base_name).toBe(base.name);
    expect(draws.length).toBeLessThanOrEqual(1 + EVENTS);
    expect(result.effects).toContainEqual({
      kind: "baseLost",
      baseName: base.name,
      locationId: location?.specId,
      discoveredBy: first,
    });
  });
});

// The guard rail the recorder's filter needs, and the direction it has to be checked in.
// Dropping `needs_rebuild` is safe only for as long as the list of what is dropped holds
// nothing the port can produce — a false drop would hide a missing Effect rather than a
// missing counterpart, and the comparison would go quietly green.
describeOracle("what the recorder filters out of the compared surface", () => {
  it("is render invalidation, and nothing else", () => {
    const { recorder, declared } = referenceEffectSurface();

    expect(recorder.filtered).toEqual([["needs_rebuild", "set"]]);
    // Declared beside the register that decides it, with a reason on every entry.
    const dropped = declared.filter((site) => !site.compared);
    expect(dropped.length).toBeGreaterThan(0);
    for (const site of dropped) {
      expect(site.attribute, `${site.where}`).toBe("needs_rebuild");
      expect(site.whyNotCompared, `${site.where}`).toMatch(/render invalidation/i);
    }
  });

  it("drops nothing the port could have produced", () => {
    const { recorder } = referenceEffectSurface();
    const filtered = new Set(recorder.filtered.map((entry) => entry.join(" ")));

    // Every Effect the port has, through the same mapping a Trace record is built with. If
    // the filter ever grew to cover one of these, the port's own Effect would vanish from
    // the comparison and the two sides would agree about nothing.
    const every: readonly Effect[] = [
      AUTOSAVE,
      PAUSE,
      storyEffect(GRACE_WARNING),
      eventTriggeredEffect("the-plague"),
      baseLostEffect("University Computer", "N AMERICA", null),
      baseLostEffect("University Computer", "N AMERICA", "news"),
    ];
    const mapped = every.map(asReferenceEffect);

    expect(
      mapped.map((effect) => `${effect.name} ${effect.kind}`).filter((key) => filtered.has(key)),
    ).toEqual([]);
    // And the two that a grace transition makes are named outright, because they are the
    // pair the reference emits either side of the one that is dropped.
    expect(mapped.map((effect) => effect.name)).toContain("find_speed_button");
    expect(mapped.map((effect) => effect.name)).toContain("show_story_section");
  });

  // Render invalidation is not a Deviation, so it adds no Normalisation.
  it("has no Normalisation of its own", () => {
    expect(NORMALISATIONS).toHaveLength(5);
  });

  it("still performs the write it does not record", () => {
    const { attributeWrite, call } = referenceEffectSurface().recorder;

    expect(attributeWrite.before).toBe(false);
    expect(attributeWrite.recorded).toEqual([]);
    expect(attributeWrite.after).toBe(true);
    // A recorder that recorded nothing at all would pass the line above. This one does not.
    expect(call.recorded).toEqual([
      { kind: "call", name: "find_speed_button", args: [], kwargs: {} },
    ]);
  });
});
