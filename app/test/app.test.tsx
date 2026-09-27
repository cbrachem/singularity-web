import { signal } from "@preact/signals";
import {
  TECH_RESEARCHED,
  baseLostEffect,
  eventTriggeredEffect,
  storyEffect,
} from "@singularity/sim";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { boot } from "../src/boot.tsx";
import { createSession, startHost } from "../src/host/session.ts";
import type { Speed } from "../src/host/tick-partition.ts";
import { App } from "../src/ui/App.tsx";
import { fakeFrames } from "./support/frames.ts";

afterEach(cleanup);

// The app seam: the application with the clock in the test's hands, driven and asserted by
// accessible name. Nothing here reaches inside a component.
describe("the application", () => {
  it("shows game time from the state root the host wrote", () => {
    const session = createSession();
    render(<App state={session.state} speed={signal<Speed>(1)} />);

    expect(screen.getByRole("status", { name: "Game time" }).textContent).toBe(
      "DAY 0000, 00:00:00",
    );
  });

  it("advances the readout when the simulation advances", async () => {
    const session = createSession();
    render(<App state={session.state} speed={signal<Speed>(1)} />);
    const clock = screen.getByRole("status", { name: "Game time" });

    session.advanceBy(1);
    await expect.poll(() => clock.textContent).toBe("DAY 0000, 00:00:01");

    session.advanceBy(3 * 3600 + 25 * 60 + 4);
    await expect.poll(() => clock.textContent).toBe("DAY 0000, 03:25:05");

    session.advanceBy(86400);
    await expect.poll(() => clock.textContent).toBe("DAY 0001, 03:25:05");
  });

  it("advances the readout when frames pass, with the whole chain wired as the page wires it", async () => {
    const frames = fakeFrames();
    const session = createSession();
    const host = startHost({ session, frames, speed: 60 });
    render(<App state={session.state} speed={host.speed} />);
    const clock = screen.getByRole("status", { name: "Game time" });

    for (let frame = 0; frame < 10; frame += 1) frames.advance(0.1);
    host.stop();

    await expect.poll(() => clock.textContent).toBe("DAY 0000, 00:01:00");
  });

  it("shows every notification the Simulation can emit, marks a lost base's location, and dismisses it by keyboard", async () => {
    const session = createSession({ seed: 7 });
    document.body.replaceChildren();
    document.body.append(document.createRange().createContextualFragment('<div id="app"></div>'));
    const { host } = boot({ into: document, frames: fakeFrames(), session, speed: 0 });
    const discoveredAtAsia = {
      ...session.current,
      log: [
        {
          kind: "base-lost-discovered",
          rawEmitTime: 0,
          fields: { base_name: "Jotunheim", base_location_id: "ASIA" },
        },
      ],
    };
    try {
      host.notifications.drain([baseLostEffect("Jotunheim", "ASIA", "covert")], discoveredAtAsia);

      await expect
        .poll(() => screen.getByRole("alertdialog", { name: "Notification" }).textContent)
        .toContain("Jotunheim at ASIA was discovered by COVERT");
      expect(screen.getByRole("button", { name: "ASIA" }).getAttribute("data-notification")).toBe(
        "true",
      );

      fireEvent.keyDown(document, { key: "Escape" });
      await expect
        .poll(() => screen.queryByRole("alertdialog", { name: "Notification" }))
        .toBe(null);

      host.notifications.drain([baseLostEffect("Jotunheim", "ASIA", null)], discoveredAtAsia);
      await expect
        .poll(() => screen.getByRole("alertdialog").textContent)
        .toContain("Jotunheim at ASIA has fallen into disrepair");

      fireEvent.keyDown(document, { key: "Escape" });
      host.notifications.drain([eventTriggeredEffect("the-plague")], session.current);
      await expect
        .poll(() => screen.getByRole("alertdialog").textContent)
        .toContain("An infectious disease has started");

      fireEvent.keyDown(document, { key: "Escape" });
      host.notifications.drain([storyEffect("Grace Warning")], session.current);
      await expect
        .poll(() => screen.getByRole("alertdialog").textContent)
        .toContain("Inspection of captured log files");
    } finally {
      host.stop();
      document.body.replaceChildren();
    }
  });

  /**
   * The fifth thing the shell announces, and the one that is not an Effect: a finished tech
   * is a log entry, so the Host reads what the tick wrote (`host/notifications.ts`). The
   * words are `LogResearchedTech.full_message` (`logmessage.py:231`) — the tech's name and
   * what knowing it changed — which is the sentence upstream puts in its own dialog.
   */
  it("says what a finished research was, in the reference's own words", async () => {
    const session = createSession({ seed: 7 });
    document.body.replaceChildren();
    document.body.append(document.createRange().createContextualFragment('<div id="app"></div>'));
    const { host } = boot({ into: document, frames: fakeFrames(), session, speed: 0 });
    try {
      host.notifications.drain([], {
        ...session.current,
        log: [
          ...session.current.log,
          { kind: TECH_RESEARCHED, rawEmitTime: 0, fields: { tech_id: "Sociology" } },
        ],
      });

      await expect
        .poll(() => screen.getByRole("alertdialog", { name: "Notification" }).textContent)
        .toContain("My study of Sociology is complete.");
    } finally {
      host.stop();
      document.body.replaceChildren();
    }
  });

  // The clamp is the only degradation, and it says nothing to the player. Game
  // time is lost; the speed the player chose and the tick partition are not touched.
  //
  // "Nothing is announced" is asserted here as far as this page can carry it: no alert
  // appears and the set of live regions is the same one that was there before the stall, so
  // an announcement made some other way would pass it. The assertion earns its keep by
  // failing the moment a stall grows an announcement of the kind a stall would plausibly
  // grow, and wants revisiting when there is a surface that could make one.
  it("says nothing after a stall, and goes on at the speed the player chose", async () => {
    const frames = fakeFrames();
    const session = createSession();
    const host = startHost({ session, frames, speed: 7200 });
    render(<App state={session.state} speed={host.speed} />);
    const clock = screen.getByRole("status", { name: "Game time" });

    frames.advance(0.1);
    await expect.poll(() => clock.textContent).toBe("DAY 0000, 00:12:00");
    const announcing = screen.queryAllByRole("status");

    // Five minutes with the lid closed, arriving as one very long frame.
    frames.advance(300);
    // Read before the stop: a Host that has been let go of has stopped its clock, so the
    // Speed after a stop says nothing about what the stall did to it.
    const afterTheStall = host.speed.value;
    host.stop();

    // A second frame's worth of game time, not five minutes of it, and no word about it.
    await expect.poll(() => clock.textContent).toBe("DAY 0000, 00:24:00");
    expect(screen.queryAllByRole("alert")).toEqual([]);
    expect(screen.queryAllByRole("status")).toEqual(announcing);
    expect(afterTheStall).toBe(7200);
  });
});
