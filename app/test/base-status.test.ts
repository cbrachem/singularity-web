import type { BaseState, BuyableState, ItemState } from "@singularity/sim";
import { describe, expect, it } from "vitest";

import { baseStatus, compactBaseStatus, percentComplete, showsCpu } from "../src/ui/estate.ts";

// The status column's vocabulary, upstream's exactly (`screens/location.py:240-266`): text is
// Presentation and fidelity binds to what the player reads. These are
// pure functions over the State root, tested the way `readouts.test.ts` tests its
// transcriptions; the table that shows the strings is asserted at the app seam
// (`estate-surface.test.tsx`).

const DONE: BuyableState = { totalCost: [200, 0, 600], costLeft: [0, 0, 0], count: 1, done: true };
const HALF_BUILT: BuyableState = {
  totalCost: [200, 0, 600],
  costLeft: [100, 0, 300],
  count: 1,
  done: false,
};

function item(buyable: BuyableState): ItemState {
  return { specId: "Server", buyable };
}

/** A base of a type without `forceCpu`, so every status branch is reachable. */
function base(overrides: Partial<BaseState>): BaseState {
  return {
    specId: "Storage Unit",
    name: "Depot",
    startedAtMin: 0,
    powerState: "active",
    graceOver: false,
    maintenance: [5, 0, 0],
    rawCpu: 0,
    cpu: 0,
    items: { cpu: null, reactor: null, network: null, security: null },
    buyable: DONE,
    ...overrides,
  };
}

describe("percent complete", () => {
  // `Buyable.percent_complete` (`buyable.py:167-175`): the least-complete component, and only
  // the components that cost anything have a say — the zero CPU cost is skipped, not divided.
  it("is the minimum over the non-zero cost components", () => {
    expect(percentComplete(HALF_BUILT)).toBe(0.5);
    expect(
      percentComplete({ totalCost: [200, 0, 600], costLeft: [200, 0, 150], count: 1, done: false }),
    ).toBe(0);
  });
});

describe("the status column", () => {
  it("reports a base under construction with percent and remaining labor time", () => {
    expect(baseStatus(base({ buyable: HALF_BUILT }))).toBe(
      "Building Base: 50%. Completion in 5 hours.",
    );
  });

  it("pads the percent to two characters, as upstream's format string does", () => {
    expect(
      baseStatus(
        base({
          buyable: { totalCost: [200, 0, 600], costLeft: [200, 0, 600], count: 1, done: false },
        }),
      ),
    ).toBe("Building Base:  0%. Completion in 10 hours.");
  });

  it("says a finished base with no items at all is Empty", () => {
    expect(baseStatus(base({}))).toBe("Empty");
  });

  it("says a finished base with items but no computer is Incomplete", () => {
    expect(
      baseStatus(
        base({ items: { cpu: null, reactor: item(DONE), network: null, security: null } }),
      ),
    ).toBe("Incomplete");
  });

  it("reports an unfinished computer with its own percent and time", () => {
    expect(
      baseStatus(
        base({ items: { cpu: item(HALF_BUILT), reactor: null, network: null, security: null } }),
      ),
    ).toBe("Building CPU: 50%. Completion in 5 hours.");
  });

  it("says Building Item while an extra is unfinished behind a finished computer", () => {
    expect(
      baseStatus(
        base({
          items: { cpu: item(DONE), reactor: item(HALF_BUILT), network: null, security: null },
        }),
      ),
    ).toBe("Building Item");
  });

  it("says Complete when the base and everything in it are done", () => {
    expect(
      baseStatus(
        base({ items: { cpu: item(DONE), reactor: item(DONE), network: null, security: null } }),
      ),
    ).toBe("Complete");
  });

  it("is blank for a finished force_cpu base", () => {
    expect(baseStatus(base({ specId: "Server Access" }))).toBe("");
  });
});

describe("the compact status", () => {
  // While something builds, the cell shows `50% · 5 hours` and carries upstream's full
  // sentence as its title — a conscious deviation from the verbatim rule. The finished-state
  // words pass through untouched, with no title.
  it("condenses a building base and keeps the full string as the title", () => {
    expect(compactBaseStatus(base({ buyable: HALF_BUILT }))).toEqual({
      text: "50% · 5 hours",
      title: "Building Base: 50%. Completion in 5 hours.",
    });
  });

  it("condenses a building computer the same way", () => {
    expect(
      compactBaseStatus(
        base({ items: { cpu: item(HALF_BUILT), reactor: null, network: null, security: null } }),
      ),
    ).toEqual({ text: "50% · 5 hours", title: "Building CPU: 50%. Completion in 5 hours." });
  });

  it("passes the finished-state words through untouched", () => {
    expect(compactBaseStatus(base({}))).toEqual({ text: "Empty", title: null });
    expect(
      compactBaseStatus(
        base({
          items: { cpu: item(DONE), reactor: item(HALF_BUILT), network: null, security: null },
        }),
      ),
    ).toEqual({ text: "Building Item", title: null });
    expect(compactBaseStatus(base({ specId: "Server Access" }))).toEqual({ text: "", title: null });
  });
});

describe("the CPU cell", () => {
  // `show_cpu` (`screens/location.py:240-269`): filled only when there is a finished computer
  // to count — a finished force_cpu base, or a finished computer in a finished base.
  it("is shown only when the base and its computers are done", () => {
    expect(showsCpu(base({ buyable: HALF_BUILT }))).toBe(false);
    expect(showsCpu(base({}))).toBe(false);
    expect(
      showsCpu(
        base({ items: { cpu: item(HALF_BUILT), reactor: null, network: null, security: null } }),
      ),
    ).toBe(false);
    expect(
      showsCpu(base({ items: { cpu: item(DONE), reactor: null, network: null, security: null } })),
    ).toBe(true);
    expect(showsCpu(base({ specId: "Server Access" }))).toBe(true);
    expect(showsCpu(base({ specId: "Server Access", buyable: HALF_BUILT }))).toBe(false);
  });
});
