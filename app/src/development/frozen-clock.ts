import type { FrameSource } from "../host/time.ts";
import { developmentOnly } from "./only.ts";

developmentOnly("frozen clock");

/**
 * The frozen clock: the Host's wall clock, stopped.
 *
 * Freezing happens at the one place the Host reads real time, so every frame reports zero
 * seconds elapsed, the accumulator takes in nothing, no Tick is affordable and no new State
 * root is published. A screenshot is then stable rather than containing a cash figure that
 * moved between two frames.
 *
 * Frames are still requested and still delivered — the page repaints, HMR still works, and a
 * development affordance that advances game time deliberately still does. Stopping the frame
 * loop instead would freeze the page rather than the clock, and would make the flag's effect
 * indistinguishable from a hang.
 *
 * Nothing in the Host or in Presentation knows about this: it is a `FrameSource` wrapping a
 * `FrameSource`, which is why the shipped bundle carries no `if (frozen)` for the build gate
 * to argue about.
 */
export function freezeClock(frames: FrameSource): FrameSource {
  const stopped = frames.now();
  return {
    now: () => stopped,
    request: (callback) => frames.request(callback),
    cancel: (handle) => frames.cancel(handle),
  };
}
