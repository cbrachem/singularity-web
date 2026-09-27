// boundary-intent harness: runs the boundary rules under a second runtime and compares
/**
 * The boundary rules, read under both runtimes that read them, asserted equal.
 *
 * The rules in `sim/test/support/source-rules.ts` are product code at the trace seam, and two
 * runtimes read them: Vitest, which transpiles with esbuild and runs
 * `sim/test/boundary.test.ts`, and bun, which is how every CLI under `tools/` is started
 * and so is what runs `runtime-readings.ts` beside this file.
 *
 * The two can disagree. Bun's transpiler reads `declare` at the head of a statement as the
 * ambient modifier and removes the statement, so a binder named `declare` vanishes under
 * `bun run` alone while `check:boundary` stays green. It is reached as
 * `bun run check:runtime-parity`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  differencesBetween,
  readUnderBun,
  readingsOfTheRules,
  scopeReadings,
} from "./runtime-readings.ts";
import { repoRoot, typeScriptSources } from "../typescript/projects.ts";

/** The scope corpus, as the rules answer it. Nine lines, and every one of them a decision. */
const SCOPE_ANSWERS: readonly string[] = [
  "scope:alias/transcendental | findRuntimeTranscendentals | 2 runtime-transcendental Math.exp",
  "scope:alias/chain | findRuntimeTranscendentals | 3 runtime-transcendental Math.log",
  "scope:alias/browser-global | findBrowserGlobals | 1 browser-global globalThis",
  "scope:alias/browser-global | findBrowserGlobals | 2 browser-global g (alias of globalThis)",
  "scope:alias/in-a-function | findRuntimeTranscendentals | 3 runtime-transcendental Math.exp",
  "scope:alias/rebound-in-a-block | findRuntimeTranscendentals | 4 runtime-transcendental Math.exp",
  "scope:alias/shadowing-a-global | findBrowserGlobals | 1 browser-global document",
  "scope:alias/shadowing-a-global | findBrowserGlobals | 2 browser-global document",
  "scope:alias/reassigned | findMutableModuleState | 1 module-level-mutable-state let",
];

/** The second reading starts a runtime, which a test that only thinks does not. */
const BOTH_RUNTIMES = 30_000;

describe("the boundary rules, read under both runtimes", () => {
  it("answers the scope corpus the same way both runtimes have to answer it", () => {
    // Two readings compared empty agree however wrong both of them are, so the shapes the
    // silent pass changed are stated positively as well as compared: an alias reported, a
    // chain followed, a block rebinding followed, a parameter taking the rule off the outer
    // binding, a reassigned binding not followed. `rule-corpus.test.ts` learned the same
    // lesson from the joined corpus.
    expect(scopeReadings()).toEqual(SCOPE_ANSWERS);
  });

  it(
    "gives the same reading under `bun run` as it does here",
    () => {
      const inProcess = readingsOfTheRules();

      expect(inProcess.length).toBeGreaterThan(SCOPE_ANSWERS.length);
      expect(differencesBetween(inProcess, readUnderBun("runtime-readings.ts"))).toEqual([]);
    },
    BOTH_RUNTIMES,
  );
});

/**
 * The word bun eats, wherever it is spelled as a name.
 *
 * The comparison above catches the shape by its effect: two readings of the rules disagree.
 * That is the strongest check available and it has one limit: a statement dropped in a
 * branch no input reaches changes no reading, so the gate stays green. The shape itself is
 * cheap to forbid and it is narrow, so it is forbidden here as well. Neither replaces the
 * other: this sees a shape, the comparison sees an effect.
 *
 * One word, not a list. Measured with bun 1.3.14:
 * of `declare`, `namespace`, `type`, `abstract`, `module`, `using`, `global`, `infer` and
 * `satisfies` bound to a helper and called at the head of a statement, only the `declare` call
 * is removed; the other eight survive. What re-measures that when bun moves is the comparison
 * above — a second word starting to vanish is a divergence in the readings, which is what that
 * gate is for, and only then is there anything to add here.
 *
 * It reads the whole repository rather than `sim/`, because the hazard is bun's transpiler and
 * bun runs every CLI under `tools/`. The rule is the identifier, not an enumeration of the
 * forms that bind it: a form left off such a list is a rule gone quiet. The ambient modifier
 * — `declare const`, `declare module` — is a keyword token rather than an identifier, so it is
 * untouched, and so is the word in prose.
 */
function spellsDeclare(source: string): number[] {
  const file = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX,
  );
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "declare") {
      lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return lines;
}

describe("the shape bun removes", () => {
  it("is spelled by no TypeScript file in the repository", () => {
    // Only a file that carries the word at all is parsed, which is what keeps a sweep of the
    // whole repository in the milliseconds this gate can afford.
    const sources = typeScriptSources();
    const parsed = sources
      .map((file) => ({ file, source: readFileSync(resolve(repoRoot, file), "utf8") }))
      .filter(({ source }) => source.includes("declare"));
    const found = parsed.flatMap(({ file, source }) =>
      spellsDeclare(source).map((line) => `${file}:${line}`),
    );

    // A sweep that finds nothing is parsed to nothing and reports nothing, so the gate passes
    // on having read no file at all. `check:runtime-parity` runs this file alone,
    // so its witness has to cover all three swept places itself — a sweep that quietly stopped
    // reaching sim/ and app/ would otherwise leave the claim about the whole repository
    // resting on tools/. Named files the repository has in any checkout; the one this file is
    // itself asked about carries the word in prose, so it also proves the parse ran.
    expect(sources).toContain("sim/src/index.ts");
    expect(sources).toContain("app/src/ui/App.tsx");
    expect(parsed.map(({ file }) => file)).toContain("tools/parity/runtime-parity.test.ts");
    expect(found).toEqual([]);
  });

  it("is what the rule reports, and the modifier is not", () => {
    expect(spellsDeclare('const declare = (name) => name;\nvoid declare("x");')).toEqual([1, 2]);
    expect(spellsDeclare("function declare(name) {\n  return name;\n}")).toEqual([1]);
    expect(spellsDeclare("const bound = { declare: 1 };")).toEqual([1]);

    // The modifier the word exists for, in each place this repository could write one.
    expect(spellsDeclare("declare const held: number;")).toEqual([]);
    expect(spellsDeclare("declare module 'x' {\n  const held: number;\n}")).toEqual([]);
    expect(spellsDeclare("declare global {\n  interface Window {}\n}")).toEqual([]);

    // And the word in prose, which this repository writes about the defect itself.
    expect(spellsDeclare("// the binder is not called declare\nconst bind = 1;")).toEqual([]);
    expect(spellsDeclare('const note = "declare";')).toEqual([]);
  });
});

describe("the comparison itself", () => {
  // A gate is worth what it can see. Both assertions above pass if `differencesBetween` is a
  // no-op that always answers empty, so it is asked once about two readings that do differ.
  it("names a difference rather than reporting agreement", () => {
    expect(differencesBetween(["alias", "shadow"], [])).toEqual([
      "only in this runtime: alias",
      "only in this runtime: shadow",
    ]);
    expect(differencesBetween([], ["alias"])).toEqual(["only under bun: alias"]);
  });
});
