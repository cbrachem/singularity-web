import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { effect } from "@preact/signals";
import { SECONDS_PER_DAY, TECH_RESEARCHED, WIN, lostGame, storyEffect } from "@singularity/sim";
import { describe, expect, it } from "vitest";

import { SCENARIOS, replayScenario, scenarioSession } from "../src/development/scenarios.ts";
import { createSession, startHost, type Session } from "../src/host/session.ts";
import { MAX_FRAME_SECONDS, createTickAccumulator, runFrameLoop } from "../src/host/time.ts";
import { fakeFrames } from "./support/frames.ts";

describe("the tick accumulator", () => {
  it("holds game seconds, and keeps what a grid step did not take", () => {
    const accumulator = createTickAccumulator();

    accumulator.add(0.05, 10);
    const tooSoon = accumulator.spend(1);
    accumulator.add(0.05, 10);

    expect(tooSoon).toBe(false);
    expect(accumulator.spend(1)).toBe(true);
    expect(accumulator.owed).toBe(0);
  });

  it("loses nothing to rounding over a long run", () => {
    const accumulator = createTickAccumulator();
    let spent = 0;
    for (let frame = 0; frame < 600; frame += 1) {
      accumulator.add(1 / 60, 60);
      while (accumulator.spend(2)) spent += 2;
    }

    expect(spent).toBe(600);
  });

  it("caps a frame at 100 ms", () => {
    expect(MAX_FRAME_SECONDS * 1000).toBe(100);
  });

  it("clamps a stall to the frame ceiling, and loses the rest of it", () => {
    // 100 ms at 600 game-seconds per real second is 60 game-seconds, and a 30 s
    // stall owes no more than that.
    const accumulator = createTickAccumulator();

    accumulator.add(30, 600);

    expect(accumulator.owed).toBe(60);
  });
});

describe("the frame loop", () => {
  it("reports the real seconds between frames until it is stopped", () => {
    const frames = fakeFrames();
    const elapsed: number[] = [];
    const loop = runFrameLoop(frames, (realSeconds) => elapsed.push(realSeconds));

    frames.advance(0.016);
    frames.advance(0.032);
    loop.stop();
    frames.advance(0.016);

    expect(elapsed).toEqual([0.016, 0.032]);
  });
});

describe("the session", () => {
  it("replaces the state root whole, so reference equality is the change check", () => {
    const session = createSession();
    const before = session.state.value;

    session.advanceBy(2);
    const after = session.state.value;

    expect(after).not.toBe(before);
    expect(after.gameTime).toBe(2);

    session.advanceBy(0);
    expect(session.state.value).toBe(after);
  });

  // Where a game's root came from is a question with observable consequences and exactly one
  // answer, and the two things that answer it are the two ways a game starts: a Save load
  // restores a state that was reached, a Scenario boot re-derives one.
  // Both are read off what the Session was given rather than named a second time beside it,
  // so nothing can claim an origin the state does not have.
  it("says where its state root came from", () => {
    const played = createSession({ seed: 7, difficulty: "normal" });
    played.advanceBy(86400);

    expect(played.origin).toEqual({ kind: "new" });
    expect(createSession({ restored: played.current }).origin).toEqual({ kind: "save" });
    expect(
      createSession({ seed: 7, origin: { kind: "scenario", id: "estate", steps: 4 } }).origin,
    ).toEqual({ kind: "scenario", id: "estate", steps: 4 });
  });

  it("refuses a restored root that also claims to have been replayed", () => {
    const played = createSession({ seed: 7, difficulty: "normal" });

    expect(() =>
      createSession({
        restored: played.current,
        origin: { kind: "scenario", id: "estate", steps: 4 },
      }),
    ).toThrow(/not replayed from a Scenario/);
  });

  it("drains the effects of every tick", () => {
    const drained: unknown[] = [];
    const session = createSession({ drainEffects: (effects) => drained.push(effects) });

    session.advanceBy(1);

    expect(drained).toEqual([[]]);
  });

  // The won game is drawn from the published root instead (`ui/end-of-game.ts`), so the Effect
  // that announces it is not also a notification: a Save load and a Scenario boot arrive after
  // it, and the tick that wins would otherwise say the same thing twice.
  it("does not queue the story section for a won game", () => {
    const session = createSession({ seed: 7 });
    const host = startHost({ session, frames: fakeFrames(), speed: 0 });

    host.notifications.drain([storyEffect(WIN)], session.current);

    expect(host.notifications.current.value).toBe(null);
    host.stop();
  });

  it("queues the simulation's notification effect, and dismissal does not write the speed", () => {
    const session = createSession({ seed: 7 });
    const host = startHost({ session, frames: fakeFrames(), speed: 60 });

    session.advanceBy(23 * SECONDS_PER_DAY);

    expect(host.notifications.current.value).toEqual({ kind: "story", sectionId: "Grace Warning" });
    host.notifications.dismiss();
    expect(host.notifications.current.value).toBe(null);
    expect(host.speed.value).toBe(60);
    host.stop();
  });

  /**
   * A finished tech leaves a log entry and nothing else — the reference's own recorded
   * surface has no call for it, so the Simulation returns no Effect and the Host reads what
   * the tick wrote (`host/notifications.ts`). Upstream then stops the tick loop on the
   * dialog that says so (`screens/map.py:761`), which is what the second half of this asks:
   * the clock does not move again until the player has answered.
   */
  it("announces a finished research, and holds the clock until it is dismissed", () => {
    const session = createSession({ seed: 7 });
    const frames = fakeFrames();
    const host = startHost({ session, frames, speed: 60 });

    host.notifications.drain([], {
      ...session.current,
      log: [
        ...session.current.log,
        { kind: TECH_RESEARCHED, rawEmitTime: 0, fields: { tech_id: "Sociology" } },
      ],
    });

    expect(host.notifications.current.value).toEqual({
      kind: "techResearched",
      techId: "Sociology",
    });

    const held = session.current.gameTime;
    for (let frame = 0; frame < 10; frame += 1) frames.advance(0.1);
    expect(session.current.gameTime).toBe(held);

    host.notifications.dismiss();
    for (let frame = 0; frame < 10; frame += 1) frames.advance(0.1);
    expect(session.current.gameTime).toBeGreaterThan(held);
    host.stop();
  });

  it("advances game time from the frame loop, in the fixed tick partition", () => {
    const frames = fakeFrames();
    const ticks: number[] = [];
    const session = createSession();
    const watched: Session = {
      state: session.state,
      get current() {
        return session.current;
      },
      origin: session.origin,
      dismissedEnding: session.dismissedEnding,
      get gameTime() {
        return session.gameTime;
      },
      tick(gameSeconds) {
        ticks.push(gameSeconds);
        return session.tick(gameSeconds);
      },
      apply: (command) => session.apply(command),
      publish: () => session.publish(),
      advanceBy: (gameSeconds) => session.advanceBy(gameSeconds),
      onEffects: (drain) => session.onEffects(drain),
    };
    const host = startHost({ session: watched, frames, speed: 60 });

    for (let frame = 0; frame < 10; frame += 1) frames.advance(0.1);
    host.stop();

    expect(session.state.value.gameTime).toBe(60);
    expect(ticks).toEqual(Array.from({ length: 30 }, () => 2));
  });

  it("publishes one State root per frame, however many ticks the frame ran", () => {
    const frames = fakeFrames();
    const session = createSession();
    const roots: number[] = [];
    const stopWatching = effect(() => {
      roots.push(session.state.value.gameTime);
    });
    const host = startHost({ session, frames, speed: 7200 });

    frames.advance(0.1);
    frames.advance(0.1);
    host.stop();
    stopWatching();

    // 720 game-seconds a frame at a 240-second quantum: three ticks, one root.
    expect(roots).toEqual([0, 720, 1440]);
  });

  it("does not tick at speed 0, and the frames it sat out are not owed later", () => {
    const frames = fakeFrames();
    const session = createSession();
    const host = startHost({ session, frames, speed: 7200 });

    frames.advance(0.1);
    host.speed.value = 0;
    for (let frame = 0; frame < 5; frame += 1) frames.advance(0.1);
    const whilePaused = session.state.value.gameTime;
    host.speed.value = 7200;
    frames.advance(0);
    host.stop();

    expect(whilePaused).toBe(720);
    expect(session.state.value.gameTime).toBe(720);
  });

  // Upstream never persists the Speed and forces `g.curr_speed = 0` on every load
  // (`code/savegame.py:414,509`), which leaves the player looking at the state they just
  // restored rather than at a game already running away from it. The Speed is the Host's and
  // never Simulation state, so the Host is where that is said — and it is said
  // about the Session's origin, the one thing that knows a Save load from a game that was
  // started, so no caller can forget it.
  it("starts a resumed game stopped, the way upstream forces the clock to a stop on load", () => {
    const played = createSession({ seed: 7, difficulty: "normal" });
    played.advanceBy(86400);
    const frames = fakeFrames();
    const resumed = createSession({ restored: played.current });
    const host = startHost({ session: resumed, frames, speed: 7200 });

    const startsAt = host.speed.value;
    for (let frame = 0; frame < 10; frame += 1) frames.advance(0.1);
    const beforeTheClockStarts = resumed.state.value.gameTime;

    // And the stop is a stop, not a lock: the Speed is a signal, and the player starting the
    // clock is the same write the scheduler and Presentation make.
    host.speed.value = 7200;
    frames.advance(0.1);
    host.stop();

    expect(startsAt).toBe(0);
    expect(beforeTheClockStarts).toBe(86400);
    expect(resumed.state.value.gameTime).toBe(86400 + 720);
  });

  it("starts a game that was not resumed at the Speed it was asked for", () => {
    const frames = fakeFrames();
    const scenario = createSession({
      seed: 7,
      origin: { kind: "scenario", id: "estate", steps: 0 },
    });
    const started = startHost({ session: createSession(), frames, speed: 60 });
    const replayed = startHost({ session: scenario, frames: fakeFrames(), speed: 60 });

    // Read while the two are running: a Host that has been let go of has stopped its clock,
    // so the Speed after a stop is 0 whatever the game was started at.
    const running = [started.speed.value, replayed.speed.value];
    started.stop();
    replayed.stop();

    expect(running).toEqual([60, 60]);
  });
});

/**
 * Upstream leaves the map screen for the main menu the moment `lost_game` reads anything but 0
 * (`code/screens/map.py:785`), so nothing of a lost game keeps running. The port's map is the
 * application and cannot be left, so the Host says the same thing about the one thing that
 * would otherwise go on: the clock. A won game is not an end — upstream plays on after
 * Apotheosis — so only the lost ends stop.
 */
describe("a lost game", () => {
  it("starts stopped, whatever Speed the page asked for", () => {
    const lost = scenarioSession("lost-to-suspicion");
    const frames = fakeFrames();
    const host = startHost({ session: lost, frames, speed: 60 });

    const startsAt = host.speed.value;
    const before = lost.current.gameTime;
    for (let frame = 0; frame < 10; frame += 1) frames.advance(0.1);
    host.stop();

    expect(lostGame(lost.current)).not.toBe(0);
    expect(startsAt).toBe(0);
    expect(lost.current.gameTime).toBe(before);
  });

  // Played into, rather than arrived in: the Scenario one advance short of its loss, run
  // frame by frame until the discovery that takes COVERT past 10,000 happens. Every pause the
  // Simulation asks for on the way is started again, the way the player dismissing a
  // notification does — which is also what makes the last one different: the clock the Host
  // stops for a lost game does not start again.
  it("stops the clock for good once it is lost, whoever starts it", () => {
    const scenario = SCENARIOS.get("lost-to-suspicion");
    if (scenario === undefined) throw new Error("no lost-to-suspicion Scenario");
    const doomed = replayScenario({ ...scenario, script: scenario.script.slice(0, -1) });
    const frames = fakeFrames();
    const host = startHost({ session: doomed, frames, speed: 7200 });

    expect(lostGame(doomed.current)).toBe(0);
    let frame = 0;
    while (frame < 2000 && lostGame(doomed.current) === 0) {
      if (host.speed.value === 0) host.speed.value = 7200;
      // And every notification is dismissed, because a notification holds the clock the way
      // upstream's message dialog holds the tick loop (`session.ts`). A driver that
      // never answers one is a player who walked away.
      if (host.notifications.current.value !== null) host.notifications.dismiss();
      frames.advance(0.1);
      frame += 1;
    }
    const stoppedAt = doomed.current.gameTime;
    host.speed.value = 7200;
    for (let more = 0; more < 10; more += 1) frames.advance(0.1);
    // Before the stop, which stops the clock itself: what is asserted is the Host's own stop
    // holding against a Speed written after the loss, not the teardown's.
    const afterTheLoss = host.speed.value;
    host.stop();

    expect(lostGame(doomed.current)).toBe(2);
    expect(afterTheLoss).toBe(0);
    expect(doomed.current.gameTime).toBe(stoppedAt);
  });

  it("does not stop a won game, which upstream goes on playing", () => {
    const won = scenarioSession("apotheosis");
    const frames = fakeFrames();
    const host = startHost({ session: won, frames, speed: 60 });

    const before = won.current.gameTime;
    for (let frame = 0; frame < 10; frame += 1) frames.advance(0.1);
    const stillRunning = host.speed.value;
    host.stop();

    expect(stillRunning).toBe(60);
    expect(won.current.gameTime).toBeGreaterThan(before);
  });
});

/**
 * The stop for a lost game is a drain, and the driver ends the frame on the stopped clock
 * rather than on the loss (`scheduler.ts`). The rule is therefore about the
 * Host's Speed signal, and this is that wiring taken on its own: any drain that stops the
 * clock ends the frame it stopped, exactly the way the loss's drain does.
 */
describe("a drain that stops the clock", () => {
  it("ends the frame it stopped, wherever the stop came from", () => {
    const frames = fakeFrames();
    const session = createSession();
    const host = startHost({ session, frames, speed: 7200 });
    const seen: string[] = [];
    let ticks = 0;
    session.onEffects((effects) => {
      for (const emitted of effects) seen.push(emitted.kind);
      ticks += 1;
      if (ticks === 1) host.speed.value = 0;
    });

    frames.advance(MAX_FRAME_SECONDS);
    host.stop();

    // A whole frame at this Speed is 720 game-seconds, three ticks of the 240-second quantum
    // (the test above). The clock stopped on the first of them, and the two after it did not
    // run — and no pause request was in the way, so the stopped clock is what ended the frame.
    expect(seen).not.toContain("pause");
    expect(session.current.gameTime).toBe(240);
  });
});

/**
 * `readSave` says a save is good once the State root is rebuilt, and a rule that
 * refuses on the *first Tick* is past that door — reachable from a foreign or hand-edited save,
 * which is why the Host has to answer for it rather than the load path.
 *
 * Unguarded the refusal kills the frame subscription where it stands and leaves the last root
 * on screen, so the game looks paused rather than gone. Guarded it is the end of that game,
 * with the reason handed out for the page to say.
 */
describe("a tick that refuses", () => {
  /** A resumed game whose Tick throws — what a save this build cannot play carries. */
  function refusingSession(reason: string): Session {
    const played = createSession({ seed: 7, difficulty: "normal" });
    played.advanceBy(86_400);
    return {
      ...createSession({ restored: played.current }),
      tick() {
        throw new Error(reason);
      },
    };
  }

  it("ends the game and states the reason, instead of dying inside the frame", () => {
    const session = refusingSession("no such tech: not-a-tech");
    const frames = fakeFrames();
    const refusals: string[] = [];
    const host = startHost({
      session,
      frames,
      onRefusal: (reason) => refusals.push(reason),
    });

    // A resumed game starts stopped, so the refusal arrives on the first Tick the player buys.
    host.speed.value = 60;
    frames.advance(0.1);
    const stoppedAt = host.speed.value;
    // A Speed written afterwards buys no Tick: the subscription went with the game, so these
    // two frames reach nothing — and would refuse a second time if they did.
    host.speed.value = 60;
    frames.advance(0.1);
    frames.advance(0.1);

    expect(refusals).toEqual(["no such tech: not-a-tech"]);
    expect(stoppedAt).toBe(0);
    expect(session.state.value.gameTime).toBe(86_400);
  });

  it("says it once, however long the page goes on delivering frames", () => {
    const frames = fakeFrames();
    const refusals: string[] = [];
    const host = startHost({
      session: refusingSession("no such group: not-a-group"),
      frames,
      onRefusal: (reason) => refusals.push(reason),
    });

    host.speed.value = 60;
    for (let frame = 0; frame < 10; frame += 1) frames.advance(0.1);
    host.stop();

    expect(refusals).toHaveLength(1);
  });

  // The guard is a place to put a refusal, not a place to lose one. A Host nobody gave a
  // surface to — a Scenario boot — throws the way it always did.
  it("rethrows where the page offered nowhere to say it", () => {
    const frames = fakeFrames();
    const host = startHost({ session: refusingSession("no such difficulty: gentle"), frames });

    host.speed.value = 60;

    expect(() => frames.advance(0.1)).toThrow(/no such difficulty: gentle/);
    host.stop();
  });
});

// A worker costs a structured clone per frame, synchronous projections and
// `localStorage`, and buys nothing at well under a millisecond of simulation per frame.
describe("the simulation", () => {
  it("runs on the main thread", () => {
    const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const offMainThread = /\bnew\s+(Shared)?Worker\b|\bimportScripts\b|\bworker_threads\b/;

    const offenders = readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
      .filter((entry) => offMainThread.test(readFileSync(resolve(sourceRoot, entry), "utf8")));

    expect(offenders).toEqual([]);
  });
});
