import { describe, expect, it } from "vitest";

import { formatGameTime } from "../src/ui/game-time.ts";
import { plainLabel, speedLabel, toMoney, toTime } from "../src/ui/readouts.ts";

// Text is Presentation, so every number the HUD shows arrives as a count and
// becomes a string here. These are pure functions with no DOM around them, which is the
// seam they belong at: the HUD's own test asserts that the string reached the screen.

describe("a quantity of cash or CPU", () => {
  // `g.to_money` (`code/g.py:177`), read off the reference: grouped below a million,
  // abbreviated above it, and the ".00" an exact amount would carry dropped.
  it("groups thousands and drops a whole amount's decimals", () => {
    expect(toMoney(0)).toBe("0");
    expect(toMoney(999)).toBe("999");
    expect(toMoney(1000)).toBe("1,000");
    expect(toMoney(999999)).toBe("999,999");
    expect(toMoney(-1500)).toBe("-1,500");
  });

  it("keeps the decimals an inexact amount does carry", () => {
    expect(toMoney(1000.5)).toBe("1,000.5");
    expect(toMoney(0.25)).toBe("0.25");
  });

  it("abbreviates a million and up, to two places", () => {
    expect(toMoney(1_000_000)).toBe("1mi");
    expect(toMoney(1_500_000)).toBe("1.5mi");
    expect(toMoney(1_234_567)).toBe("1.23mi");
    expect(toMoney(2_000_000_000)).toBe("2bi");
    expect(toMoney(3_000_000_000_000)).toBe("3tr");
    expect(toMoney(2_000_000_000_000_000)).toBe("2qu");
    expect(toMoney(-2_500_000)).toBe("-2.5mi");
  });

  // A preserved upstream joke rather than a defect: at `g.max_cash` — pi quadrillion —
  // the reference replaces every character of the amount with a pi (`code/g.py:201`).
  // Player-visible, so it is carried over rather than tidied away.
  it("breaks the bank at pi quadrillion", () => {
    expect(toMoney(3.14e15)).toBe("π".repeat(6));
    expect(toMoney(-3.14e15)).toBe(`-${"π".repeat(6)}`);
  });
});

/**
 * The widest string a money readout can produce, which the HUD bar is measured against at the
 * floor of the supported range (`viewport.test.ts`).
 *
 * That string is **not** in the abbreviated range and not the pi either — `-999.99qu` is nine
 * characters and `-ππππππ` is seven, while the grouped range just under a million spends a
 * sign, a group separator and two decimals on top of six digits. Sweeping both sides of every
 * decade corner is what says so.
 */
describe("the widest string a money readout can produce", () => {
  /** Both signs, either side of every decade corner from one to past the top of the scale. */
  function acrossTheScale(): readonly number[] {
    const corners = Array.from({ length: 19 }, (_, power) => 10 ** power);
    return corners
      .flatMap((corner) => [corner - 0.01, corner, corner + 0.01])
      .flatMap((amount) => [amount, -amount]);
  }

  it("is eleven characters, and it is a grouped amount short of a million", () => {
    const lengths = acrossTheScale().map((amount) => toMoney(amount).length);

    expect(Math.max(...lengths)).toBe(11);
    // The one that reaches it, spelled out: sign, six digits, a group separator, two decimals.
    expect(toMoney(-999_999.99)).toBe("-999,999.99");
    // And neither of the two shapes the abbreviation produces gets near it.
    expect(toMoney(-999.99e15)).toBe(`-${"π".repeat(6)}`);
    expect(toMoney(-999.99e12).length).toBeLessThan(11);
  });
});

describe("a name written with a hotkey in it", () => {
  // `g.strip_hotkey` (`code/g.py:417`): the Content keeps upstream's markers, because the
  // Converter transcribes rather than reads. Removing them is Presentation's.
  it("loses the marker and keeps the letter", () => {
    expect(plainLabel("&NORMAL")).toBe("NORMAL");
    expect(plainLabel("E&XIT")).toBe("EXIT");
    expect(plainLabel("&Multiple&Keys")).toBe("MultipleKeys");
  });

  it("keeps an ampersand that is not a marker", () => {
    expect(plainLabel("Romeo & &Juliet")).toBe("Romeo & Juliet");
    expect(plainLabel("Trailing&")).toBe("Trailing&");
    expect(plainLabel("M&&&M")).toBe("M&M");
  });
});

describe("the speed setting, as the HUD says it", () => {
  it("names the pause and gives every other setting its multiplier", () => {
    expect(speedLabel(0)).toBe("Paused");
    expect(speedLabel(1)).toBe("1x");
    expect(speedLabel(60)).toBe("60x");
    expect(speedLabel(432000)).toBe("432,000x");
  });
});

describe("a remaining time", () => {
  // `g.to_time` (`code/g.py:229`), read off the reference: floor division throughout, days
  // only past 48 hours, hours only past one hour — so 119 minutes is still minutes.
  it("buckets minutes into days, hours and minutes", () => {
    expect(toTime(0)).toBe("0 minutes");
    expect(toTime(1)).toBe("1 minute");
    expect(toTime(119)).toBe("119 minutes");
    expect(toTime(120)).toBe("2 hours");
    expect(toTime(2880)).toBe("48 hours");
    expect(toTime(2940)).toBe("2 days");
    expect(toTime(14400)).toBe("10 days");
  });
});

describe("the clock", () => {
  it("reads as the reference's own display, without the day's zero padding", () => {
    expect(formatGameTime(0)).toBe("Day 0 · 00:00:00");
    expect(formatGameTime(86400 * 400 + 3661)).toBe("Day 400 · 01:01:01");
  });
});
