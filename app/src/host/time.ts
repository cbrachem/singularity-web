/**
 * The Host's half of the clock: wall-clock time in, game seconds owed out.
 *
 * The accumulator holds **game seconds**, not real ones, and the driver in `scheduler.ts`
 * spends them in whole grid steps. Holding game seconds is what makes its leftover
 * rate-independent, so it is never cleared — not on a pause, not on a stall — and grid
 * anchoring means the leftover can never influence a tick *size*.
 *
 * It does not follow that the leftover cannot influence a tick *count*: what is owed is spent
 * at whatever Speed is set when it is spent, so the bank is bounded as well as clamped. The
 * ceiling is the driver's, which is where the Speed lives.
 */

/** The frame source, injected so the driver runs headless in a test. */
export interface FrameSource {
  /** Monotonic real milliseconds. */
  now(): number;
  request(callback: () => void): number;
  cancel(handle: number): void;
}

/**
 * The frame clamp, in real seconds. It caps every stall alike — hidden tab, GC pause,
 * breakpoint, closed lid — and is the only degradation the Host applies. Game time is lost;
 * the tick partition is not touched, and neither is the frame rate.
 */
export const MAX_FRAME_SECONDS = 0.1;

export interface TickAccumulator {
  /** The game seconds taken in but not yet spent on a whole grid step. */
  readonly owed: number;
  /** Takes one frame in, clamped, at the given game-seconds-per-real-second. */
  add(realSeconds: number, gameSecondsPerRealSecond: number): void;
  /**
   * Drops anything above `gameSeconds`. The driver sets the ceiling from the current Speed,
   * because game seconds are only rate-independent while the rate does not change: seconds
   * banked at one Speed buy ticks at whatever Speed spends them, and a decrease would spend
   * them all in the frame after the change.
   */
  capTo(gameSeconds: number): void;
  /** Spends a grid step if it is owed, and says whether it was. */
  spend(gameSeconds: number): boolean;
}

export function createTickAccumulator(): TickAccumulator {
  let owed = 0;
  return {
    get owed() {
      return owed;
    },
    add(realSeconds, gameSecondsPerRealSecond) {
      const clamped = Math.min(Math.max(realSeconds, 0), MAX_FRAME_SECONDS);
      owed += clamped * gameSecondsPerRealSecond;
    },
    capTo(gameSeconds) {
      owed = Math.min(owed, gameSeconds);
    },
    spend(gameSeconds) {
      if (gameSeconds <= 0 || owed < gameSeconds) return false;
      owed -= gameSeconds;
      return true;
    },
  };
}

export interface FrameLoop {
  stop(): void;
}

/** Subscribes to frames and reports the real seconds between them. */
export function runFrameLoop(
  source: FrameSource,
  onFrame: (realSeconds: number) => void,
): FrameLoop {
  let last = source.now();
  let handle: number | undefined;
  let running = true;

  const step = (): void => {
    if (!running) return;
    const now = source.now();
    const elapsed = (now - last) / 1000;
    last = now;
    onFrame(elapsed);
    if (running) handle = source.request(step);
  };

  handle = source.request(step);

  return {
    stop() {
      running = false;
      if (handle !== undefined) source.cancel(handle);
    },
  };
}

/** The browser's frame source. The only place in the Host that names a browser API. */
export function browserFrames(): FrameSource {
  return {
    now: () => performance.now(),
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
  };
}
