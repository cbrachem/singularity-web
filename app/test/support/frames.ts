import type { FrameSource } from "../../src/host/time.ts";

/**
 * The page's frame source with the test holding the clock: no `requestAnimationFrame`, and
 * a frame happens exactly when the test says so.
 */
export interface FakeFrames extends FrameSource {
  /** Moves the wall clock on and delivers the frame that was waiting for it. */
  advance(realSeconds: number): void;
  /** How many frames have been delivered. */
  readonly delivered: number;
}

export function fakeFrames(): FakeFrames {
  let now = 0;
  let delivered = 0;
  let pending: (() => void) | undefined;
  let nextHandle = 1;

  return {
    now: () => now,
    request(callback) {
      pending = callback;
      return nextHandle++;
    },
    cancel() {
      pending = undefined;
    },
    get delivered() {
      return delivered;
    },
    advance(realSeconds) {
      now += realSeconds * 1000;
      const due = pending;
      pending = undefined;
      delivered += 1;
      due?.();
    },
  };
}
