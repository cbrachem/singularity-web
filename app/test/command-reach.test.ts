import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { APP_SOURCE, sourceFiles } from "./support/source-files.ts";

/**
 * The source rule behind the app-seam criterion: every Command the Simulation accepts has a
 * place in `app/src` that sends it.
 *
 * A player capability can be true at the trace seam and still leave the player nothing to
 * press. This file compares `sim/src/command.ts`'s union against every command literal in
 * `app/src` — checked rather than remembered, like the accessible-name rule beside it.
 *
 * It says nothing about *how* a Command is reached. A surface that sends one is a surface a
 * `describe` at the app seam can drive; this rule only refuses the case where no surface
 * sends it at all.
 */

const SIM_COMMAND = resolve(APP_SOURCE, "..", "..", "sim", "src", "command.ts");

/**
 * Commands with no sender yet, pinned rather than exempted, so the rule goes red on a gap that
 * is gone as well as on one that appears. Empty: every Command is reachable.
 */
const KNOWN_GAPS: readonly string[] = [];

/** Every Command `sim/src/command.ts` declares, read from the discriminant each carries. */
function commandsDeclared(source: string): string[] {
  return [...source.matchAll(/readonly command: "(\w+)"/g)].flatMap((match) => match[1] ?? []);
}

/** Every Command an app source file constructs. */
function commandsIssued(source: string): string[] {
  return [...source.matchAll(/command:\s*"(\w+)"/g)].flatMap((match) => match[1] ?? []);
}

describe("reading the two halves as source", () => {
  it("takes a declared Command from its discriminant", () => {
    expect(
      commandsDeclared(
        [
          "export interface BuildBase {",
          '  readonly command: "buildBase";',
          "  readonly location: string;",
          "}",
        ].join("\n"),
      ),
    ).toEqual(["buildBase"]);
  });

  it("takes an issued Command however the literal is written", () => {
    expect(
      commandsIssued(
        [
          '  command: "buildBase" as const,',
          '  onCommand?.({ command: "switchPower", location, base });',
          "  const shape = { command: name };",
        ].join("\n"),
      ),
    ).toEqual(["buildBase", "switchPower"]);
  });
});

describe("app/src", () => {
  it("sends every Command the Simulation accepts", () => {
    const declared = commandsDeclared(readFileSync(SIM_COMMAND, "utf8"));
    const issued = new Set(
      sourceFiles(APP_SOURCE).flatMap((path) => commandsIssued(readFileSync(path, "utf8"))),
    );

    // The rule is worth nothing if the union stopped being read; buildBase is the Command
    // this port cannot lose.
    expect(declared).toContain("buildBase");
    expect(declared.filter((command) => !issued.has(command))).toEqual(KNOWN_GAPS);
  });
});
