import { effect, signal, type ReadonlySignal, type Signal } from "@preact/signals";
import {
  advance,
  applyCommand,
  createInitialState,
  lostGame,
  type AutosaveEffect,
  type Command,
  type Effect,
  type SimulationState,
} from "@singularity/sim";

import type { Autosave } from "./autosave.ts";
import { createNotifications, INTRO, type Notifications } from "./notifications.ts";
import { createScheduler } from "./scheduler.ts";
import type { Speed } from "./tick-partition.ts";
import { runFrameLoop, type FrameLoop, type FrameSource } from "./time.ts";
import type { HiddenSource } from "./visibility.ts";

/**
 * One game in progress: the State root, the Tick entry point, and the moment Presentation is
 * handed a new root. After each Tick a new root exists, and the one Presentation reads is
 * published once per frame — one render however many ticks ran. It drains the
 * Effects on the way through; the Simulation never learns which Host it has.
 */
export interface Session {
  /** The published State root. Reference equality against the previous one is the change check. */
  readonly state: ReadonlySignal<SimulationState>;
  /**
   * The newest root, current between publications — what a Save is taken from.
   *
   * The autosave request arrives at the end of the Tick that made it, and the Save has to hold
   * the state that Tick produced, which is this one and not the one
   * Presentation is still looking at.
   */
  readonly current: SimulationState;
  /** How this game's State root came to be. */
  readonly origin: SessionOrigin;
  /**
   * The end-of-game panel this game's player has dismissed, by its story section id, or
   * `null` while they have dismissed none.
   *
   * It is here rather than in the shell's own state because it has to survive a reload, and
   * the only thing that survives one is the save document — which is written from this game
   * (`save.ts`, `autosave.ts`). It is not Simulation state: the ending itself is derived from
   * the State root and a won game goes on saying `apotheosis` however often it is dismissed
   * (`ui/end-of-game.ts`). Presentation writes it, the way it writes the Speed.
   */
  readonly dismissedEnding: Signal<string | null>;
  /** Absolute game time, current between publications — the grid is measured against it. */
  readonly gameTime: number;
  /** One Tick: advance, drain, and keep the new root. Returns the Tick's Effects. */
  tick(gameSeconds: number): readonly Effect[];
  /** One player action. Data in, a new root out, and Presentation sees it at once. */
  apply(command: Command): void;
  /** Hands Presentation the current root. */
  publish(): void;
  /** A whole span at once, published when it is done. Scenarios and tests drive time this way. */
  advanceBy(gameSeconds: number): void;
  /**
   * Adds a drain, run after every Tick in the order the drains were added. Returns an
   * unsubscribe.
   *
   * A drain added afterwards rather than at construction, because the things that drain
   * Effects are built from the Session — the autosave saves the root it is holding — and one
   * of the two has to exist first.
   */
  onEffects(drain: (effects: readonly Effect[]) => void): () => void;
}

/**
 * Where a game's State root came from, which is a question with observable consequences and
 * exactly one answer per game.
 *
 * A **Scenario boot** re-derives the state by replaying a seed and a script; a **Save load**
 * restores a state that was reached. The two land in the same place and are not the same
 * thing — a Scenario boot is reproducible by name and drew every random number on the way,
 * which is what makes the same file a fidelity fixture. Anything
 * that has to tell them apart reads this rather than guessing from the state.
 *
 * Only the `scenario` member is asked for. `save` is not a request either: it *is* the
 * restored root arriving (`restored` below), so the two cannot be made to disagree, and
 * `new` is what is left. The `scenario` member is written only by the development entry
 * point, which does not reach the shipped bundle; the type is erased at build time and
 * carries nothing into it.
 */
export type SessionOrigin =
  | { readonly kind: "new" }
  | { readonly kind: "save" }
  | { readonly kind: "scenario"; readonly id: string; readonly steps: number };

export interface SessionOptions {
  readonly drainEffects?: (effects: readonly Effect[]) => void;
  /**
   * What this game was replayed from, for a Scenario boot. Left out otherwise: a game with a
   * `restored` root is a Save load and a game with neither is new, and both are read off what
   * is already there rather than named a second time.
   */
  readonly origin?: Extract<SessionOrigin, { kind: "scenario" }>;
  /**
   * The seed the game's generator starts from. Normal play leaves it out and gets a random
   * one, so player-visible behaviour is upstream's; a Scenario or a test names it and gets a
   * run it can reproduce. Choosing it is the Host's job — the
   * Simulation may not reach for a source of randomness of its own.
   */
  readonly seed?: number;
  readonly difficulty?: string;
  /**
   * A State root restored from a Save, for a game that is being resumed rather than started.
   * It brings its own generator, so naming a seed alongside it is a contradiction and refuses.
   */
  readonly restored?: SimulationState;
  /**
   * The end-of-game panel the restored game's player had already dismissed, out of the save it
   * came from (`save-store.ts`). A game that is being started has dismissed nothing.
   */
  readonly dismissedEnding?: string;
}

export function createSession(options: SessionOptions = {}): Session {
  if (options.restored && (options.seed !== undefined || options.difficulty !== undefined)) {
    throw new Error("a restored game carries its own seed and difficulty");
  }
  if (options.restored && options.origin) {
    throw new Error("a restored game was not replayed from a Scenario");
  }

  const origin: SessionOrigin = options.restored ? A_SAVE : (options.origin ?? NEW_GAME);

  let current =
    options.restored ??
    createInitialState({
      seed: options.seed ?? Math.floor(Math.random() * 2 ** 32),
      difficulty: options.difficulty ?? "normal",
    });
  const published = signal<SimulationState>(current);
  const dismissedEnding = signal<string | null>(options.dismissedEnding ?? null);
  const drains: ((effects: readonly Effect[]) => void)[] = [];
  if (options.drainEffects) drains.push(options.drainEffects);

  const tick = (gameSeconds: number): readonly Effect[] => {
    if (gameSeconds <= 0) return NO_EFFECTS;
    const result = advance(current, gameSeconds);
    current = result.state;
    for (const drain of drains) drain(result.effects);
    return result.effects;
  };
  const publish = (): void => {
    published.value = current;
  };

  return {
    state: published,
    get current() {
      return current;
    },
    origin,
    dismissedEnding,
    get gameTime() {
      return current.gameTime;
    },
    tick,
    apply(command) {
      current = applyCommand(current, command);
      publish();
    },
    publish,
    advanceBy(gameSeconds) {
      tick(gameSeconds);
      publish();
    },
    onEffects(drain) {
      drains.push(drain);
      return () => {
        const at = drains.indexOf(drain);
        if (at !== -1) drains.splice(at, 1);
      };
    },
  };
}

const NO_EFFECTS: readonly Effect[] = Object.freeze([]);

/**
 * The Effect kind that asks the Host to save — `Player.new_day` (`player.py:576`) minus the
 * write, which the Host does afterwards because browser storage is asynchronous and the
 * Simulation may not call out.
 *
 * The spelling is the Simulation's, and the annotation is what says so: `AutosaveEffect`
 * declares the kind, so renaming it there stops this declaration typechecking instead of
 * leaving the Host watching for a kind nobody emits any more. The type is erased, so nothing
 * of the Simulation reaches the bundle here — the Host still knows the one kind it acts on and
 * none of the rest of the union.
 */
export const AUTOSAVE_REQUEST: AutosaveEffect["kind"] = "autosave";

const NEW_GAME: SessionOrigin = Object.freeze({ kind: "new" });

const A_SAVE: SessionOrigin = Object.freeze({ kind: "save" });

export interface HostOptions {
  readonly session: Session;
  readonly frames: FrameSource;
  /**
   * The Speed the game starts at. Upstream's own (`code/g.py:76`) unless the game is a Save
   * load, which starts stopped whatever is asked for — see `startHost`.
   */
  readonly speed?: Speed;
  /**
   * The autosave, if this Host keeps one. Wired to five things and nothing else: a new game
   * starting, the Simulation's request, the clock stopping, the page being hidden, and the
   * player dismissing the end of the game.
   */
  readonly autosave?: Autosave;
  readonly hidden?: HiddenSource;
  /** Whether the game opens with the intro story, as a new game from the start screen does. */
  readonly intro?: boolean;
  /**
   * Where a Tick that throws goes.
   *
   * A rule can refuse during a Tick, and the load path cannot see it coming: `readSave`
   * restores the State root and stops there, because taking a Tick to find out would consume
   * draws and move the state it was checking (`host/save.ts`). So a save can be called good,
   * be resumed, and refuse on the first frame — which needs a foreign or hand-edited save,
   * since a state this build can play is a state it can tick.
   *
   * No such save has been found: the restore rebuilds from the Content every collection a
   * Tick looks into, or refuses at the door (`app/test/save.test.ts`). This is
   * therefore belt-and-braces rather than a live path — and it stays, because that is a walk
   * over today's rules rather than a rule the Simulation keeps.
   *
   * Given this, the Host abandons the game instead of dying inside a frame: the clock stops,
   * the frame subscription and the drains go, and the reason arrives here for the page to say
   * out loud. Left out, the throw is rethrown rather than swallowed — a caller with nowhere
   * to put a refusal must not be handed a silence instead.
   */
  readonly onRefusal?: (reason: string) => void;
}

/**
 * The Host, running: a Speed setting, a scheduler over it, and the frame subscription. The
 * Speed is a signal so Presentation can show and change it; the scheduler writes 0 into it
 * when the Simulation asks for a pause, and nothing else ever writes it from in here.
 */
export interface Host extends FrameLoop {
  readonly speed: Signal<Speed>;
  readonly notifications: Notifications;
}

/** The Speed a stopped clock sits at, so the rule below reads as what it is. */
const STOPPED: Speed = 0;

/**
 * Starts the Host over a Session — and decides the Speed it starts at, which is upstream's
 * `code/g.py:76` for a game that is being started and a **stop** for one that is being
 * resumed: upstream never persists the Speed and forces `g.curr_speed = 0` on every load
 * (`code/savegame.py:414,509`), so the player gets to look at the state their save holds
 * before it moves.
 *
 * The rule lives here rather than at the page because the Speed is the Host's and never
 * Simulation state, and because the Host is handed the one thing that tells a Save
 * load from a game that was started — the Session's origin. A requested Speed is therefore
 * the Speed a *new* game starts at; a resumed one starts stopped whatever was asked for, the
 * way the load overwrites `g.curr_speed` upstream. Nothing is locked: the Speed is a signal,
 * and the write Presentation makes to start the clock is the write the scheduler already
 * makes to stop it.
 *
 * # A lost game stops, and stays stopped
 *
 * Upstream leaves the map screen for the main menu the moment `lost_game` reads anything but 0
 * (`code/screens/map.py:785`), so nothing of a lost game goes on running. The port's map *is*
 * the application and cannot be left, so the Host says the same thing about the only part that
 * would otherwise keep moving: the clock. Without it a lost game ticks on behind its own
 * end-of-game panel, raising suspicion and queueing notifications the player can never act on.
 *
 * It is a stop rather than a lock, like the one above — the Speed stays a signal anybody may
 * write — and it holds anyway, because it is checked in both places a Tick can be reached
 * from: before every frame, and after every Tick, which is where the loss first exists. So a
 * Speed written after the loss buys no ticks, and the frame the loss happened in runs none of
 * its remaining ones either (`scheduler.ts` breaks on the stopped clock).
 *
 * **A won game is not an end.** Upstream plays on after Apotheosis (`code/effect.py:59`
 * returns to the map) and `lostGame` reads 0 for it, so only the lost ends stop.
 *
 * # A lost game is not saved
 *
 * Upstream never autosaves a game that is over: `Player.new_day` asks only while `lost_game`
 * reads 0 (`player.py:575`), so the slot a lost game leaves behind holds the last state from
 * before the loss — a game the player can still get back into. The port's throttle is the one
 * way round that rule. A request dropped before the loss stays *owed*, the stop above flushes
 * whatever is owed, and the write takes a fresh snapshot — which is the lost state. The
 * player would then be offered Continue and land straight back on the end-of-game panel, with
 * the game they could have gone on playing written over.
 *
 * So the loss is where the autosave stops, in both directions: what is owed is discarded
 * before the clock stops, and no request is taken afterwards. This is the rule that an
 * autosave must not destroy a save arrived at from the other side — the save being destroyed
 * is the player's last playable one, and the thing destroying it is a game that is over.
 *
 * # A Tick that refuses ends the game rather than the frame loop
 *
 * The other way a game can stop moving is a rule that throws mid-Tick, which the load path
 * cannot rule out (`onRefusal` above, and `host/save.ts`). Unguarded it is the worst of the
 * three: the frame subscription dies where it stood, so the page keeps the last root on
 * screen and looks like a game that is merely paused. The Host therefore treats it as the end
 * of that game — clock stopped, subscription and drains gone, reason handed to `onRefusal` —
 * which is what turns a crash into the refusal the load path would have given.
 *
 * The stop is written before the Host lets go, so an autosave still owed is flushed the way
 * any other stopping clock flushes it: what it holds is the last Tick that finished, never the
 * one that refused.
 *
 * # A game that is let go of is a game that has stopped
 *
 * `stop` is that same order for every caller, and not only for the refusal: the Speed goes to
 * 0, and only then do the frame subscription and the drains go. Without it a Host let go of
 * mid-game dropped whatever the throttle was holding — a save the Simulation had asked for, of
 * a game that was still alive, taken away by the one caller that ends a game the player was
 * still playing (`cold-start.tsx` stops the running Host before it starts the next one).
 *
 * Flushing rather than discarding, because the throttle's licence to drop a request is that
 * the last one before the player looks away is always honoured (`autosave.ts`), and letting go
 * of the game *is* the player looking away. The argument for discarding — the next game will
 * write over the slot anyway — does not hold here: a Save load starts stopped, so a game the
 * player never starts never asks, and a tab closed before it does would leave the slot older
 * than either game.
 *
 * A game that is over takes no part in this. The loss discards what is owed and stops the
 * clock where it happens, so by the time the page lets go there is nothing owed and the Speed
 * is already 0 — the flush has nothing to write and is not asked to.
 */
export function startHost({
  session,
  frames,
  speed = 1,
  autosave,
  hidden,
  intro = false,
  onRefusal,
}: HostOptions): Host {
  const over = (): boolean => lostGame(session.current) !== 0;
  const setting = signal<Speed>(session.origin.kind === "save" || over() ? STOPPED : speed);
  const stopIfOver = (): void => {
    if (!over()) return;
    // Before the clock stops, because stopping it is what would otherwise flush the request
    // — and the flush takes a fresh snapshot, which is now the lost state.
    autosave?.discard();
    setting.value = STOPPED;
  };
  const notifications = createNotifications(
    session.current,
    intro ? { kind: "story", sectionId: INTRO } : null,
  );
  const scheduler = createScheduler({
    target: session,
    speed: setting,
    render: () => session.publish(),
  });
  const detach: (() => void)[] = [];
  const stop = (): void => {
    // The clock first, because stopping it is what flushes an autosave the throttle is still
    // holding — see "A game that is let go of is a game that has stopped" above.
    setting.value = STOPPED;
    loop.stop();
    for (const off of detach) off();
  };

  // A lost game does not run, whoever asks it to. The Host holds that in the two places a
  // Tick can be reached from: before the frame, so a Speed written after the loss buys
  // nothing, and after the Tick that lost it, so the rest of that frame is not run either
  // (the driver breaks on the stopped clock).
  const loop = runFrameLoop(frames, (realSeconds) => {
    try {
      stopIfOver();
      // A notification holds the clock, which is what upstream's own message dialog does:
      // `dialog.call_dialog` takes over the loop, so nothing is given time until the player
      // has answered it (`screens/map.py:761`, `screens/message.py:37`). Without this a
      // notice arriving at speed 4 is a panel the game runs on behind, and what it announces
      // has already been overtaken by the time it is read.
      if (notifications.current.value !== null) return;
      scheduler.frame(realSeconds);
    } catch (error) {
      setting.value = STOPPED;
      stop();
      if (!onRefusal) throw error;
      onRefusal(error instanceof Error ? error.message : String(error));
    }
  });

  detach.push(session.onEffects(stopIfOver));
  detach.push(session.onEffects((effects) => notifications.drain(effects, session.current)));
  if (autosave) {
    detach.push(
      session.onEffects((effects) => {
        // A request that arrived with the loss is not taken either: `new_day` reads
        // `lost_game` before the Tick's closing CPU recount (`advance.ts`), so the last base
        // dying at midnight asks for a save the Simulation would not have asked for had it
        // recounted first. `stopIfOver` runs before this drain, so `over()` already reads the
        // Tick that has just ended the game.
        if (over()) return;
        if (effects.some((emitted) => emitted.kind === AUTOSAVE_REQUEST)) autosave.request();
      }),
    );
    // Every pause, whoever asked for it: the Simulation's request reaches the Speed through
    // the scheduler, and the player's reaches it directly.
    detach.push(
      effect(() => {
        if (setting.value === 0) autosave.flush();
      }),
    );
    if (hidden) detach.push(hidden.onHidden(() => autosave.flush()));
    // The player dismissing the end of the game, which is the one thing they can change that
    // the Simulation never asks to save. A won game is played on for as long as
    // the player likes at whatever Speed they like, and the Simulation's next request is three
    // game-days away — three real days at Speed 1 — so waiting for it is waiting for nothing.
    // The first run of the Effect is the value the game was resumed with, which is already in
    // the save it was resumed from.
    let dismissed = session.dismissedEnding.peek();
    detach.push(
      effect(() => {
        const now = session.dismissedEnding.value;
        if (now === dismissed) return;
        dismissed = now;
        if (!over()) autosave.request();
      }),
    );
    // A game that has just been started is in no slot at all until something writes it, and
    // the Simulation's first request is three game-days away — 72 real hours at the Speed a
    // new game starts at. So the Host asks once, here, and the game is
    // recoverable from the moment it exists. A resumed game is already in the store, and a
    // Scenario replay is a re-derived state rather than the player's game.
    if (session.origin.kind === "new" && !over()) autosave.request();
  }

  return { speed: setting, notifications, stop };
}
