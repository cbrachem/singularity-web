import { screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { MOUNT_SELECTOR, boot } from "../src/boot.tsx";
import { createSession } from "../src/host/session.ts";
import { browserFrames } from "../src/host/time.ts";
import { fakeFrames } from "./support/frames.ts";

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  document.body.innerHTML = "";
});

function aPageWithAMountPoint(): Document {
  document.body.innerHTML = `<div id="${MOUNT_SELECTOR.slice(1)}"></div>`;
  return document;
}

// The app seam, entered where the page enters it. `main.tsx` is this call and its argument,
// so everything the page does on load is under test here except the word `document`.
describe("booting the page", () => {
  it("mounts the application and shows the state root's game time", () => {
    const { host } = boot({ into: aPageWithAMountPoint(), frames: fakeFrames() });
    stops.push(host.stop);

    expect(screen.getByRole("status", { name: "Game time" }).textContent).toBe(
      "DAY 0000, 00:00:00",
    );
  });

  it("wires the frames to the simulation, so game time advances as frames pass", async () => {
    const frames = fakeFrames();
    const { host } = boot({ into: aPageWithAMountPoint(), frames, speed: 60 });
    stops.push(host.stop);
    const clock = screen.getByRole("status", { name: "Game time" });

    for (let frame = 0; frame < 10; frame += 1) frames.advance(0.1);

    await expect.poll(() => clock.textContent).toBe("DAY 0000, 00:01:00");
  });

  // Upstream starts at speed 1 (`code/g.py:76`), and the page is where that is decided:
  // the Speed belongs to the Host, so nothing below it can say so.
  it("starts at the speed upstream starts at", () => {
    const { host } = boot({ into: aPageWithAMountPoint(), frames: fakeFrames() });
    stops.push(host.stop);

    expect(host.speed.value).toBe(1);
  });

  // The other half of the same decision, and upstream's own: a load forces the clock to a
  // stop (`code/savegame.py:414,509`), so the page a player comes back to shows the state
  // their save holds and waits there instead of running on from it.
  it("shows a resumed game where it was saved, and leaves it there", async () => {
    const played = createSession({ seed: 7, difficulty: "normal" });
    played.advanceBy(86400);
    const frames = fakeFrames();
    const { host } = boot({
      into: aPageWithAMountPoint(),
      frames,
      session: createSession({ restored: played.current }),
    });
    stops.push(host.stop);
    const clock = screen.getByRole("status", { name: "Game time" });

    for (let frame = 0; frame < 10; frame += 1) frames.advance(0.1);

    expect(host.speed.value).toBe(0);
    await expect.poll(() => clock.textContent).toBe("DAY 0001, 00:00:00");
  });

  it("refuses a page with no mount point, naming the one it looked for", () => {
    document.body.innerHTML = '<div id="somewhere-else"></div>';

    expect(() => boot({ into: document, frames: fakeFrames() })).toThrow(MOUNT_SELECTOR);
  });
});

// The one place in the Host that names a browser API, and the only part of the frame loop a
// fake frame source cannot stand in for. Everything above runs on the fake; this runs on the
// real pair, so a `performance.now()` in milliseconds or a handle the browser will not take
// back is a red test rather than a page that quietly stops advancing.
describe("the browser's frame source", () => {
  it("reports monotonic milliseconds and delivers a frame", async () => {
    const frames = browserFrames();
    const before = frames.now();

    await new Promise<void>((resolve) => frames.request(() => resolve()));

    expect(typeof before).toBe("number");
    expect(frames.now()).toBeGreaterThanOrEqual(before);
  });

  it("takes back a frame it handed out", async () => {
    const frames = browserFrames();
    let cancelled = true;

    frames.cancel(frames.request(() => (cancelled = false)));
    // Two frames later: if the cancellation had not taken, the callback would have run in
    // the first of them.
    await new Promise<void>((resolve) => frames.request(() => frames.request(() => resolve())));

    expect(cancelled).toBe(true);
  });
});
