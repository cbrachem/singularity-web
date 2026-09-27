import { applyCommand } from "@singularity/sim";
import { describe, expect, it } from "vitest";

import { createSession } from "../src/host/session.ts";
import { locationMarks } from "../src/ui/map/marks.ts";

// What a location's mark says is read from the state and nothing else: a game with one base
// has all its CPU in one place, and an order for a new base shows as a ring at 0%.
describe("a location's mark", () => {
  it("holds all the CPU where the only base is, and says so", () => {
    const state = createSession({ seed: 7 }).current;
    const marks = locationMarks(state);
    const home = state.locations.find((location) => location.bases.length > 0)!;

    expect(marks.get(home.specId)).toMatchObject({ share: 1, building: null, risk: 0 });
    expect(marks.get(home.specId)?.description).toBe("100% of your CPU · detection Low");
    expect(marks.get("EUROPE")).toMatchObject({ share: 0, building: null, risk: null });
    expect(marks.get("EUROPE")?.description).toBe("No bases");
  });

  it("rings a location while a base there is under construction", () => {
    const state = applyCommand(createSession({ seed: 7 }).current, {
      command: "buildBase",
      location: "EUROPE",
      baseType: "Server Access",
    });
    const europe = locationMarks(state).get("EUROPE");

    expect(europe).toMatchObject({ share: 0, building: 0 });
    expect(europe?.description).toMatch(/^0% of your CPU · detection \w+ · a base 0% built$/);
  });
});
