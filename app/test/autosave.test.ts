import {
  AUTOSAVE,
  advance,
  lostGame,
  projectPersistent,
  type Effect,
  type SimulationState,
} from "@singularity/sim";
import { describe, expect, it } from "vitest";

import { SCENARIOS, replayScenario } from "../src/development/scenarios.ts";
import { AUTOSAVE_INTERVAL_SECONDS, createAutosave } from "../src/host/autosave.ts";
import { saveDocument, serialiseSave } from "../src/host/save.ts";
import {
  AUTOSAVE_KEY,
  SAVE_KEY_PREFIX,
  createSaveStore,
  type SaveStore,
  type WriteOutcome,
} from "../src/host/save-store.ts";
import { AUTOSAVE_REQUEST, createSession, startHost, type Session } from "../src/host/session.ts";
import type { HiddenSource } from "../src/host/visibility.ts";
import { fakeFrames } from "./support/frames.ts";
import { fakeStorage, type FakeStorage } from "./support/storage.ts";

/**
 * The host seam: the autosave throttle, the two things that force it, and the reload it
 * exists for. No DOM, and both clocks — wall and frame — in the test's hands.
 */

/** The wall clock the throttle measures against, in seconds. */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    advance(realSeconds: number) {
      now += realSeconds;
    },
  };
}

function fakeHidden(): HiddenSource & { hide(): void } {
  const listeners: (() => void)[] = [];
  return {
    onHidden(listener) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    hide() {
      for (const listener of listeners) listener();
    },
  };
}

/** The game time in the autosave slot, insisting that the slot reads. */
function savedGameTime(store: SaveStore): number {
  const read = store.read(AUTOSAVE_KEY);
  if (!read?.ok) throw new Error("the autosave should be readable");
  return read.meta.gameTime;
}

/**
 * A Session whose every Tick returns the Effects the test names, over a real State root. The
 * Effects may be a list or a function of the root the Tick produced, which is how a test says
 * "while the game is alive" without reaching into the Simulation for it.
 *
 * The Host acts on a Tick's Effects and never on what produced them, so this is how the
 * autosave request is driven with the Simulation's own `AUTOSAVE` — rather than with a record
 * spelled here from the Host's constant, which would make the two agree by construction and
 * check nothing.
 */
function sessionEmitting(
  effects: readonly Effect[] | ((current: SimulationState) => readonly Effect[]),
  inner: Session = createSession({ seed: 43, difficulty: "normal" }),
): Session {
  const drains: ((emitted: readonly Effect[]) => void)[] = [];
  const emitted = (): readonly Effect[] =>
    typeof effects === "function" ? effects(inner.current) : effects;
  return {
    state: inner.state,
    origin: inner.origin,
    dismissedEnding: inner.dismissedEnding,
    get current() {
      return inner.current;
    },
    get gameTime() {
      return inner.gameTime;
    },
    tick(gameSeconds) {
      inner.tick(gameSeconds);
      const tickEffects = emitted();
      for (const drain of drains) drain(tickEffects);
      return tickEffects;
    },
    apply: (command) => inner.apply(command),
    publish: () => inner.publish(),
    advanceBy: (gameSeconds) => inner.advanceBy(gameSeconds),
    onEffects(drain) {
      drains.push(drain);
      return () => {
        drains.splice(drains.indexOf(drain), 1);
      };
    },
  };
}

function idleGame(gameSeconds = 0) {
  const session = createSession({ seed: 43, difficulty: "normal" });
  if (gameSeconds > 0) session.advanceBy(gameSeconds);
  return session;
}

/**
 * An autosave slot holding a save from a later format — which is what a `SAVE_DOCUMENT_VERSION`
 * or `REFERENCE_REVISION` bump makes of every player's autosave at once. Returns the text, so a
 * test can insist it is still there afterwards.
 */
function anUnreadableAutosave(storage: FakeStorage): string {
  const session = createSession({ seed: 43, difficulty: "normal" });
  session.advanceBy(3 * 86400);
  const document = saveDocument(session.current, 1);
  const text = JSON.stringify({
    ...document,
    version: 99,
    meta: { ...document.meta, version: 99 },
  });
  storage.setItem(`${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`, text);
  return text;
}

describe("the autosave throttle", () => {
  it("writes at most once per ten real seconds, however often the Simulation asks", () => {
    const clock = fakeClock();
    const written: WriteOutcome[] = [];
    const session = idleGame();
    const autosave = createAutosave({
      snapshot: () => session.current,
      store: createSaveStore(fakeStorage()),
      now: clock.now,
      report: (outcome) => written.push(outcome),
    });

    // The Simulation asks about 1.7 times a real second at top speed; nine and a half
    // seconds of that is one write.
    for (let ask = 0; ask < 16; ask += 1) {
      autosave.request();
      clock.advance(0.6);
    }

    expect(AUTOSAVE_INTERVAL_SECONDS).toBe(10);
    expect(written).toHaveLength(1);

    clock.advance(1);
    autosave.request();
    expect(written).toHaveLength(2);
  });

  it("keeps a dropped request owed, and a flush writes it", () => {
    const clock = fakeClock();
    const written: WriteOutcome[] = [];
    const session = idleGame();
    const autosave = createAutosave({
      snapshot: () => session.current,
      store: createSaveStore(fakeStorage()),
      now: clock.now,
      report: (outcome) => written.push(outcome),
    });

    autosave.request();
    clock.advance(1);
    autosave.request();

    expect(autosave.pending).toBe(true);
    autosave.flush();
    expect(written).toHaveLength(2);
    expect(autosave.pending).toBe(false);
  });

  it("writes nothing on a flush with nothing owed", () => {
    const clock = fakeClock();
    const written: WriteOutcome[] = [];
    const autosave = createAutosave({
      snapshot: () => idleGame().current,
      store: createSaveStore(fakeStorage()),
      now: clock.now,
      report: (outcome) => written.push(outcome),
    });

    autosave.flush();
    autosave.flush();

    expect(written).toEqual([]);
  });

  it("saves the newest root, not the one the dropped request arrived with", () => {
    const clock = fakeClock();
    const storage = fakeStorage();
    const store = createSaveStore(storage);
    const session = idleGame();
    const autosave = createAutosave({ snapshot: () => session.current, store, now: clock.now });

    autosave.request();
    clock.advance(1);
    session.advanceBy(86400);
    autosave.request();
    autosave.flush();

    const read = store.read(AUTOSAVE_KEY);
    if (!read?.ok) throw new Error("the autosave should be readable");
    expect(read.meta.gameTime).toBe(86400);
  });

  it("reports a save that does not fit and does not retry it on every request", () => {
    const clock = fakeClock();
    const storage = fakeStorage({ quota: 200 });
    const written: WriteOutcome[] = [];
    const session = idleGame();
    const autosave = createAutosave({
      snapshot: () => session.current,
      store: createSaveStore(storage),
      now: clock.now,
      report: (outcome) => written.push(outcome),
    });

    for (let ask = 0; ask < 5; ask += 1) {
      autosave.request();
      clock.advance(1);
    }

    expect(written).toHaveLength(1);
    expect(written[0]?.ok).toBe(false);
    expect(storage.keys()).toEqual([]);
  });
});

describe("the host's autosave", () => {
  function runningGame(options: { speed?: 432000; session?: Session } = {}) {
    const storage = fakeStorage();
    const store = createSaveStore(storage);
    const clock = fakeClock();
    const frames = fakeFrames();
    const hidden = fakeHidden();
    const session = options.session ?? createSession({ seed: 43, difficulty: "normal" });
    const written: WriteOutcome[] = [];
    const autosave = createAutosave({
      snapshot: () => session.current,
      store,
      now: clock.now,
      report: (outcome) => written.push(outcome),
    });
    const host = startHost({
      session,
      frames,
      speed: options.speed ?? 432000,
      autosave,
      hidden,
    });
    const play = (frameCount: number): void => {
      for (let frame = 0; frame < frameCount; frame += 1) {
        clock.advance(0.1);
        frames.advance(0.1);
      }
    };
    return { storage, store, clock, frames, hidden, session, host, autosave, written, play };
  }

  // The Host holds the only copy of the autosave kind outside `sim/`, so this is where the two
  // spellings are made to meet. The type annotation on the constant is the other half: a rename
  // of `AutosaveEffect["kind"]` stops the declaration typechecking, and this says what the
  // declaration is for.
  it("acts on the kind the Simulation declares, not on a spelling of the Host's", () => {
    expect(AUTOSAVE_REQUEST).toBe(AUTOSAVE.kind);
  });

  /**
   * Every game below is written once as it starts, and that write takes the
   * throttle's window with it — so what a request during play does is counted from there:
   * the wall clock is moved past the window first, and the second write is the Simulation's.
   */
  it("requests a save on the Simulation's own autosave Effect, and on nothing else", () => {
    const asked = runningGame({ session: sessionEmitting([AUTOSAVE]) });
    asked.clock.advance(AUTOSAVE_INTERVAL_SECONDS);
    asked.play(1);
    asked.host.stop();

    // Three: the start, the Simulation's first request, and the stop's flush of the ones the
    // throttle dropped behind it — a frame at this Speed is many Ticks and this Session asks
    // on every one.
    expect(asked.written).toHaveLength(3);
    expect(asked.store.read(AUTOSAVE_KEY)?.ok).toBe(true);

    const silent = runningGame({ session: sessionEmitting([]) });
    silent.clock.advance(AUTOSAVE_INTERVAL_SECONDS);
    silent.play(1);
    silent.host.stop();

    // The start, and nothing since: no Effect, no request.
    expect(silent.written).toHaveLength(1);
    expect(silent.autosave.pending).toBe(false);
  });

  it("writes when the Simulation asks, through the effect the tick returned", () => {
    const game = runningGame();
    game.clock.advance(AUTOSAVE_INTERVAL_SECONDS);

    game.play(1);
    game.host.stop();

    // One frame at top speed is half a game-day: no request yet, so the start's write stands
    // alone.
    expect(game.written).toHaveLength(1);
    expect(game.autosave.pending).toBe(false);

    const later = runningGame();
    later.clock.advance(AUTOSAVE_INTERVAL_SECONDS);
    later.play(10);
    later.host.stop();

    expect(later.written).toHaveLength(2);
    expect(later.store.read(AUTOSAVE_KEY)?.ok).toBe(true);
  });

  it("flushes when the tab is hidden", () => {
    const game = runningGame();

    game.play(20);
    const beforeHiding = game.written.length;
    game.hidden.hide();

    // The hiding alone, with the Host still holding the game: letting go of it flushes as
    // well, and a stop here would write the same save whether the tab was hidden or not.
    expect(game.autosave.pending).toBe(false);
    expect(game.written.length).toBe(beforeHiding + 1);
    expect(savedGameTime(game.store)).toBe(game.session.current.gameTime);
  });

  it("flushes when the clock stops, whoever stopped it", () => {
    const game = runningGame();

    game.play(20);
    const beforePausing = game.written.length;
    game.host.speed.value = 0;
    game.host.stop();

    expect(game.written.length).toBe(beforePausing + 1);
    expect(savedGameTime(game.store)).toBe(game.session.current.gameTime);
  });

  // The other half of "whoever stopped it": losing the grace period asks the Host to pause
  // (`player.py:580`), the scheduler writes 0 into the Speed, and the flush follows from that
  // rather than from anything the autosave knows about the Simulation.
  it("flushes on the pause the Simulation asks for", () => {
    const game = runningGame();

    game.play(60);

    // Nothing is stopped here but the Simulation's own pause: letting go of the Host stops the
    // clock and flushes as well, so a stop before these three would answer all of
    // them itself and the pause would go unwatched.
    expect(game.host.speed.value).toBe(0);
    expect(savedGameTime(game.store)).toBe(game.session.current.gameTime);
    expect(game.autosave.pending).toBe(false);
  });

  /**
   * Letting go of the game is the last chance the throttle gets. `host.stop()` took
   * the frame subscription and the drains and left the Speed where it was, so a request the
   * Simulation had made and the throttle had dropped went with them — a save the game had
   * already earned, of a game that was still alive.
   *
   * A stop is now a stop of the clock first, which is the one flush every other pause already
   * goes through. The lost game is the case that must not follow it, and it does not: the loss
   * discards what is owed and stops the clock before this ever runs (the describe below).
   */
  it("flushes what is owed when the Host lets go of a game that is still alive", () => {
    const game = runningGame();

    game.play(20);
    expect(game.autosave.pending).toBe(true);
    const beforeStopping = game.written.length;
    game.host.stop();

    expect(game.written.length).toBe(beforeStopping + 1);
    expect(game.autosave.pending).toBe(false);
    expect(savedGameTime(game.store)).toBe(game.session.current.gameTime);
  });

  it("stops flushing once the host is stopped", () => {
    const game = runningGame();

    game.play(20);
    game.host.stop();
    // Owed again, by hand. The stop flushes what the game still owed, so a listener
    // that had not been taken off would find nothing to write and the count would read the same
    // either way — the request is what gives the tab going away something to drop.
    game.autosave.request();
    const afterStopping = game.written.length;
    game.hidden.hide();

    expect(game.autosave.pending).toBe(true);
    expect(game.written.length).toBe(afterStopping);
  });
});

/**
 * The Simulation's first request is on game day 3 (`player.py:575`), which at
 * the Speed a new game starts at is 72 real hours. Until then nothing had ever written, so a
 * game the player had just started was in no slot at all and a reload offered no Continue.
 *
 * So the Host asks once when a game is started. It is a request rather than a path of its own:
 * the throttle, the fresh snapshot and the chain walk are the same ones every other write
 * takes.
 */
describe("a game that has just started", () => {
  it("is in the store before any game time has passed, and reloads into that game", () => {
    const storage = fakeStorage();
    const store = createSaveStore(storage);
    const session = createSession({ seed: 43, difficulty: "normal" });
    const autosave = createAutosave({ snapshot: () => session.current, store, now: () => 0 });
    const host = startHost({ session, frames: fakeFrames(), speed: 1, autosave });

    // Not a frame has been delivered, and not a game-second has passed.
    expect(session.current.gameTime).toBe(0);
    host.stop();

    // A fresh page: nothing survives but `localStorage`.
    const read = createSaveStore(storage).read(AUTOSAVE_KEY, 0);
    if (!read?.ok) throw new Error("a game that has just started should be readable");
    expect(read.meta.gameTime).toBe(0);
    expect(projectPersistent(createSession({ restored: read.state }).current)).toEqual(
      projectPersistent(session.current),
    );
  });

  // A Scenario replay is a re-derived state, not the player's game, and it leaves
  // the save store alone in both directions. The page keeps that rule by handing a Scenario
  // boot no autosave at all (`main.tsx`); the Host keeps it here as well, so the start write
  // cannot be the one thing that writes over a game the player is keeping.
  it("writes nothing for a Scenario replay", () => {
    const storage = fakeStorage();
    const store = createSaveStore(storage);
    const session = createSession({
      seed: 7,
      origin: { kind: "scenario", id: "estate", steps: 0 },
    });
    const written: WriteOutcome[] = [];
    const host = startHost({
      session,
      frames: fakeFrames(),
      speed: 1,
      autosave: createAutosave({
        snapshot: () => session.current,
        store,
        now: () => 0,
        report: (outcome) => written.push(outcome),
      }),
    });
    host.stop();

    expect(written).toEqual([]);
    expect(storage.keys()).toEqual([]);
  });
});

/**
 * Upstream never saves a game that is over: `Player.new_day` asks for an autosave only while
 * `lost_game` reads 0 (`player.py:575`), so what a lost game leaves in the slot is the last
 * state from before the loss — a game the player can still get back into.
 *
 * The port has one way round that rule which upstream does not have, and it is the throttle. A
 * request dropped before the loss stays owed; the clock the Host stops on the loss flushes it;
 * and the write takes a fresh snapshot, which is now the lost state. So the Host drops what is
 * owed when the game is lost, and takes no request after it — the two halves below.
 */
describe("a lost game", () => {
  /** The lost-to-suspicion Scenario one advance short of its loss: a game about to lose. */
  function aboutToLose(): Session {
    const scenario = SCENARIOS.get("lost-to-suspicion");
    if (scenario === undefined) throw new Error("no lost-to-suspicion Scenario");
    return replayScenario({ ...scenario, script: scenario.script.slice(0, -1) });
  }

  /**
   * A Host over a game about to lose, on a wall clock that never moves — so the first request
   * is written and every one after it is dropped and stays owed, which is the state the loss
   * arrives in at any Speed worth playing at.
   */
  function playingIntoTheLoss(session: Session) {
    const store = createSaveStore(fakeStorage());
    const frames = fakeFrames();
    const hidden = fakeHidden();
    const written: WriteOutcome[] = [];
    const autosave = createAutosave({
      snapshot: () => session.current,
      store,
      now: () => 0,
      report: (outcome) => written.push(outcome),
    });
    const host = startHost({ session, frames, speed: 7200, autosave, hidden });
    const lose = (): void => {
      let frame = 0;
      while (frame < 2000 && lostGame(session.current) === 0) {
        // Every pause the Simulation asks for on the way is started again, and every
        // notification is dismissed — a notification holds the clock the way upstream's
        // message dialog holds the tick loop (`session.ts`). The last stop is the
        // Host's, and it stays.
        if (host.speed.value === 0) host.speed.value = 7200;
        if (host.notifications.current.value !== null) host.notifications.dismiss();
        frames.advance(0.1);
        frame += 1;
      }
    };
    return { store, hidden, host, autosave, written, session, lose };
  }

  /** The State root in the autosave slot, insisting that the slot reads. */
  function savedState(store: SaveStore) {
    const read = store.read(AUTOSAVE_KEY);
    if (!read?.ok) throw new Error("the autosave should be readable");
    return read.state;
  }

  /** The Simulation's own rule, at a Tick's resolution: it asks while the game is alive. */
  const whileAlive = (current: SimulationState): readonly Effect[] =>
    lostGame(current) === 0 ? [AUTOSAVE] : [];

  it("does not flush a request owed from before the loss", () => {
    const game = playingIntoTheLoss(sessionEmitting(whileAlive, aboutToLose()));

    expect(lostGame(game.session.current)).toBe(0);
    game.lose();

    expect(lostGame(game.session.current)).toBe(2);
    const lostAt = game.session.current.gameTime;
    const writes = game.written.length;

    // The tab going away is the other forced flush, and a lost game has nothing for it either.
    game.hidden.hide();
    game.host.stop();

    expect(lostGame(savedState(game.store))).toBe(0);
    expect(savedState(game.store).gameTime).toBeLessThan(lostAt);
    expect(game.written.length).toBe(writes);
    expect(game.autosave.pending).toBe(false);
  });

  /**
   * The loss and the request can also arrive in the same Tick: `new_day` reads `lost_game`
   * before the Tick's closing CPU recount, so a game that loses its last base at midnight asks
   * for a save and is over by the end of the same Tick (`advance.ts`). The Host must not take
   * that request either — the Simulation would not have made it had it recounted first, and
   * the next forced flush would write the lost state with it.
   */
  it("takes no request that arrived with the loss", () => {
    const game = playingIntoTheLoss(sessionEmitting([AUTOSAVE], aboutToLose()));

    game.lose();
    const writes = game.written.length;
    game.hidden.hide();
    game.host.stop();

    expect(lostGame(game.session.current)).toBe(2);
    expect(lostGame(savedState(game.store))).toBe(0);
    expect(game.written.length).toBe(writes);
  });

  // And the whole thing over the Simulation itself, asking for what it asks for and pausing
  // where it pauses: whatever the slot ends up holding, it is a game that can still be played.
  it("leaves the slot holding a game the player can go back to", () => {
    const game = playingIntoTheLoss(aboutToLose());

    game.lose();
    game.hidden.hide();
    game.host.stop();

    expect(lostGame(game.session.current)).toBe(2);
    expect(lostGame(savedState(game.store))).toBe(0);
  });
});

describe("a reload", () => {
  it("continues the game the autosave held, identically", () => {
    const game = (() => {
      const storage = fakeStorage();
      const store = createSaveStore(storage);
      const clock = fakeClock();
      const frames = fakeFrames();
      const hidden = fakeHidden();
      const session = createSession({ seed: 43, difficulty: "normal" });
      const autosave = createAutosave({
        snapshot: () => session.current,
        store,
        now: clock.now,
      });
      const host = startHost({ session, frames, speed: 432000, autosave, hidden });
      for (let frame = 0; frame < 60; frame += 1) {
        clock.advance(0.1);
        frames.advance(0.1);
      }
      hidden.hide();
      host.stop();
      return { storage, session };
    })();

    const saved = game.session.current;

    // A fresh page: nothing survives but `localStorage`.
    const reloaded = createSaveStore(game.storage);
    const read = reloaded.read(AUTOSAVE_KEY, 0);
    if (!read?.ok) throw new Error("the autosave should be readable after a reload");
    const resumed = createSession({ restored: read.state });

    expect(projectPersistent(resumed.current)).toEqual(projectPersistent(saved));
    expect(resumed.current.rng.toState()).toEqual(saved.rng.toState());

    // And it goes on exactly as the game that was never reloaded would have.
    resumed.advanceBy(3 * 86400);
    expect(projectPersistent(resumed.current)).toEqual(
      projectPersistent(advance(saved, 3 * 86400).state),
    );
  });

  it("does not resume from a save it could not read, and does not overwrite it either", () => {
    const storage = fakeStorage();
    const fromTheFuture = anUnreadableAutosave(storage);

    const store = createSaveStore(storage);
    const read = store.read(AUTOSAVE_KEY);
    expect(read?.ok).toBe(false);

    // The player starts a new game, and three game-days later the autosave fires.
    const fresh = createSession({ seed: 7, difficulty: "normal" });
    fresh.advanceBy(3 * 86400);
    const autosave = createAutosave({
      snapshot: () => fresh.current,
      store,
      now: () => 0,
    });
    autosave.request();

    expect(storage.getItem(`${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`)).toBe(fromTheFuture);
    expect(storage.keys()).toEqual([
      `${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`,
      `${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}-2`,
    ]);
  });
  /**
   * The fresh key is the rule's escape hatch, not a per-load allocation.
   *
   * A save this build cannot read is not a one-off: a `SAVE_DOCUMENT_VERSION` or
   * `REFERENCE_REVISION` bump makes one out of every player's autosave at once, and every
   * reload after that bump meets it again. Taking the next *free* name each time would grow the
   * store by one key per page load and resume none of them — an unbounded pile of games nobody
   * could get back to, which is the loss the single slot exists to stop, arrived at from the
   * other side.
   *
   * So the slot is a chain, and one walk of it answers both questions: the first slot that is
   * empty or readable is the slot the autosave writes *and* the slot the next load resumes. The
   * unreadable ones ahead of it are left exactly where they are.
   */
  it("takes one fresh key over an unreadable autosave, however often the page is loaded", () => {
    const storage = fakeStorage();
    const stale = anUnreadableAutosave(storage);

    // Five page loads, each doing what `app/src/main.tsx` does: resume the autosave slot, play,
    // and let the autosave fire.
    const played: number[] = [];
    for (let load = 0; load < 5; load += 1) {
      const store = createSaveStore(storage);
      const resumed = store.resume(0);
      const session = createSession(
        resumed.state ? { restored: resumed.state } : { seed: 7, difficulty: "normal" },
      );
      session.advanceBy(3 * 86400);
      createAutosave({ snapshot: () => session.current, store, now: () => 0 }).request();
      played.push(session.current.gameTime);
    }

    expect(storage.keys()).toEqual([
      `${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`,
      `${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}-2`,
    ]);
    // And every load after the first continued the game the one before it left.
    expect(played).toEqual([3, 6, 9, 12, 15].map((days) => days * 86400));
    expect(storage.getItem(`${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`)).toBe(stale);
  });

  // The other half of not losing it silently: the load knows which slots it stepped over and
  // why, and the start screen says so (`app/src/cold-start.tsx`).
  it("names the slot it could not read, and the reason", () => {
    const storage = fakeStorage();
    anUnreadableAutosave(storage);

    const resumed = createSaveStore(storage).resume(0);

    expect(resumed.key).toBe(`${AUTOSAVE_KEY}-2`);
    expect(resumed.state).toBeUndefined();
    expect(resumed.retired.map((slot) => slot.key)).toEqual([AUTOSAVE_KEY]);
    expect(resumed.retired[0]?.reason).toContain("save format 99");
  });

  // A readable autosave is resumed from the same walk, and nothing is retired.
  it("resumes the plain autosave slot when this build can read it", () => {
    const storage = fakeStorage();
    const session = createSession({ seed: 43, difficulty: "normal" });
    session.advanceBy(3 * 86400);
    storage.setItem(
      `${SAVE_KEY_PREFIX}${AUTOSAVE_KEY}`,
      serialiseSave(saveDocument(session.current, 1)),
    );

    const resumed = createSaveStore(storage).resume(0);

    expect(resumed.key).toBe(AUTOSAVE_KEY);
    expect(resumed.state?.gameTime).toBe(3 * 86400);
    expect(resumed.retired).toEqual([]);
  });
});
