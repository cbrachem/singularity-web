import { readFileSync } from "node:fs";
import { relative } from "node:path";

import { describe, expect, it } from "vitest";

import { frameSourcesIn } from "./support/frame-source-rule.ts";
import { fakeFrames } from "./support/frames.ts";
import { APP_TEST, sourceFiles } from "./support/source-files.ts";

/**
 * The one fake frame source, and the rule that keeps it one. The helper itself is host-seam
 * furniture — no DOM, the wall clock in the test's hands — and the rule below is the same
 * shape as the operable one: written down, then applied, so the change that breaks it fails
 * rather than the reviewer that misses it.
 */

/** The file allowed to build a frame source: the shared one. */
const THE_ONE = "support/frames.ts";

describe("the fake frame source", () => {
  it("delivers the frame that was waiting, with the clock already moved on", () => {
    const frames = fakeFrames();
    const seen: number[] = [];

    frames.request(() => seen.push(frames.now()));
    frames.advance(0.5);

    expect(seen).toEqual([500]);
    expect(frames.now()).toBe(500);
  });

  it("counts delivered frames, which is what a paused clock is told apart by", () => {
    const frames = fakeFrames();

    expect(frames.delivered).toBe(0);
    frames.advance(1 / 60);
    frames.advance(1 / 60);

    expect(frames.delivered).toBe(2);
  });

  it("hands out a fresh handle per request, and forgets a cancelled frame", () => {
    const frames = fakeFrames();
    let ran = 0;

    expect(frames.request(() => ran++)).not.toBe(frames.request(() => ran++));
    frames.cancel(1);
    frames.advance(1);

    expect(ran).toBe(0);
  });
});

describe("the source rule against a second frame source", () => {
  it("finds an object literal carrying now, request and cancel", () => {
    const source = [
      "const frames = {",
      "  now: () => now,",
      "  request: (callback) => 1,",
      "  cancel: () => {},",
      "};",
    ].join("\n");

    expect(frameSourcesIn(source)).toEqual([1]);
  });

  it("reads the shape rather than the name, whatever the helper is called", () => {
    const source =
      "function clockFrames() {\n  return { cancel() {}, request() {}, now: () => 0 };\n}";

    expect(frameSourcesIn(source)).toEqual([2]);
  });

  it("leaves a clock, a storage and anything else short of the three members alone", () => {
    expect(frameSourcesIn("const clock = { now: () => now, advance(seconds) {} };")).toEqual([]);
    expect(frameSourcesIn("const source = { now: () => 0, request(callback) {} };")).toEqual([]);
  });

  it("reads a frame source built inside JSX, which a scanner over TS alone would miss", () => {
    const source = "const page = <App frames={{ now: () => 0, request: r, cancel: c }} />;";

    expect(frameSourcesIn(source)).toEqual([1]);
  });
});

// The rule applied, which is the point of writing it: five test files had grown their own
// copy of the frame source before they were folded onto the shared one.
describe("app/test", () => {
  it("builds the fake frame source in one file, and takes it from there everywhere else", () => {
    const violations = sourceFiles(APP_TEST).flatMap((path) => {
      const where = relative(APP_TEST, path).split("\\").join("/");
      if (where === THE_ONE) return [];
      return frameSourcesIn(readFileSync(path, "utf8")).map((line) => `${where}:${line}`);
    });

    expect(violations).toEqual([]);
  });
});
