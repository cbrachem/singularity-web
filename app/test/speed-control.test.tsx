import { signal } from "@preact/signals";
import { PAUSE } from "@singularity/sim";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { createSession, startHost, type Session } from "../src/host/session.ts";
import { SPEEDS, type Speed } from "../src/host/tick-partition.ts";
import { App } from "../src/ui/App.tsx";
import { unnamedOperables } from "./support/accessible-names.ts";
import { fakeFrames } from "./support/frames.ts";

afterEach(cleanup);

/**
 * A game whose every Tick asks the Host to stop the clock, which is what the Simulation does
 * on a lost base, a triggered event and the end of the grace period (`sim/src/advance.ts`).
 * The Session is otherwise the real one: the frames, the scheduler and the Speed signal below
 * are the page's own.
 */
function pausingSession(): Session {
  const session = createSession({ seed: 7 });
  return {
    ...session,
    get current() {
      return session.current;
    },
    get gameTime() {
      return session.gameTime;
    },
    tick(gameSeconds) {
      session.tick(gameSeconds);
      return [PAUSE];
    },
  };
}

/** The name a driver says, per Speed setting. */
const NAMES: Readonly<Record<Speed, string>> = {
  0: "Pause",
  1: "Speed 1x",
  60: "Speed 60x",
  7200: "Speed 7,200x",
  432000: "Speed 432,000x",
};

// The app seam: the shell rendered over the Host's own Speed signal, driven and asserted by
// accessible name. Nothing here reaches inside a component.
describe("the speed control", () => {
  it("offers the five Speed settings by pointer, each with a name a driver can say", () => {
    const speed = signal<Speed>(1);
    const container = render(<App state={createSession().state} speed={speed} />).container;

    for (const setting of SPEEDS) {
      fireEvent.click(screen.getByRole("button", { name: NAMES[setting] }));
      expect(speed.value).toBe(setting);
    }
    expect(unnamedOperables(container)).toEqual([]);
  });

  it("answers upstream's 0-4 hotkeys, so the clock can be started without a pointer", () => {
    const speed = signal<Speed>(1);
    render(<App state={createSession().state} speed={speed} />);

    for (const [index, setting] of SPEEDS.entries()) {
      fireEvent.keyDown(document, { key: String(index) });
      expect(speed.value).toBe(setting);
    }
  });

  it("shows the chosen Speed, and marks the chosen button as the pressed one", async () => {
    const speed = signal<Speed>(1);
    render(<App state={createSession().state} speed={speed} />);
    const readout = screen.getByRole("status", { name: "Speed" });

    expect(readout.textContent).toBe("1x");
    expect(screen.getByRole("button", { name: "Speed 1x" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Speed 7,200x" }));

    await expect.poll(() => readout.textContent).toBe("7,200x");
    expect(screen.getByRole("button", { name: "Speed 7,200x" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Speed 1x" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  // The Speed the control writes is the Host's own signal and not a copy of it, so a pause the
  // Simulation asked for — which reaches that signal through the scheduler — is shown as the
  // pause without Presentation being told twice.
  it("shows a pause the Simulation asked for as the pause", async () => {
    const frames = fakeFrames();
    const session = pausingSession();
    const host = startHost({ session, frames, speed: 60 });
    render(<App state={session.state} speed={host.speed} />);

    frames.advance(0.1);
    host.stop();

    await expect
      .poll(() => screen.getByRole("status", { name: "Speed" }).textContent)
      .toBe("Paused");
    expect(screen.getByRole("button", { name: "Pause" }).getAttribute("aria-pressed")).toBe("true");
    expect(host.speed.value).toBe(0);
  });

  // Upstream's map screen stops seeing keys when a dialog is over it (`dialog.py`). Here the
  // surfaces drawn over the map own the keyboard the same way — one of them holds a text
  // field, and a digit typed into it is a digit and not a Speed.
  it("leaves the hotkeys to a surface drawn over the map", async () => {
    const speed = signal<Speed>(1);
    render(<App state={createSession({ seed: 7 }).state} speed={speed} />);

    fireEvent.click(screen.getByRole("button", { name: "Research/Tasks" }));
    await expect
      .poll(() => screen.queryByRole("region", { name: "Research/Tasks" }))
      .not.toBe(null);

    fireEvent.keyDown(document, { key: "0" });
    expect(speed.value).toBe(1);

    fireEvent.keyDown(document, { key: "Escape" });
    await expect.poll(() => screen.queryByRole("region", { name: "Research/Tasks" })).toBe(null);

    fireEvent.keyDown(document, { key: "0" });
    expect(speed.value).toBe(0);
  });
});
