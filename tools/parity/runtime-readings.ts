// boundary-intent harness: reads the boundary rules once, so a second runtime can be asked the same
/**
 * The boundary rules, read into a flat list of lines, and the comparison of two such lists.
 *
 * The rules in `sim/test/support/source-rules.ts` are read by two runtimes. Vitest runs
 * `sim/test/boundary.test.ts` and transpiles with esbuild; bun runs
 * `tools/parity/runtime-readings.ts`, and `bun run` is how every CLI under `tools/` is
 * started.
 *
 * The two can disagree: Bun's transpiler reads `declare` at the head of a statement as the
 * ambient modifier and removes the statement, so a binder named `declare` vanishes under
 * `bun run` only, while `check:boundary` stays green because Vitest keeps the calls.
 *
 * This module is one half of the comparison: the rules, read over the
 * same inputs the parity script feeds them, flattened to lines that can be compared for
 * equality. `runtime-parity.test.ts` reads it in process, runs it again under `bun run`, and
 * requires the two lists to be the same. Run as a command it prints its own reading:
 *
 *     bun run tools/parity/runtime-readings.ts
 *
 * The inputs are the shared corpus in `rule-corpus.ts`, imported rather than copied so that a
 * case added there is covered here too, plus a corpus of the scope shapes below. Those are the
 * answers a dropped binder changes, and the corpus states them positively: an enumeration that goes
 * empty is as loud as a violation that appears, which a comparison of two empty lists is not.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Case,
  calleeNames,
  corpusCases,
  joinedCorpusCases,
  joinedUnsuppliedDefaults,
  readings,
} from "./rule-corpus.ts";
import * as rules from "../../sim/test/support/source-rules.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** A corpus entry answers about itself, so a relative specifier keeps the shape it is written in. */
const stayPut = (specifier: string): string => specifier.replace(/^\.\//, "");

/**
 * The shapes only the scope pass answers: a target reached under a name of its own, and the
 * scopes that decide which binding a use means.
 *
 * The first five entries are written so that the pass going quiet changes the reading. A
 * binding the pass cannot follow reads as free, and a free name is where a target is reached
 * by its own word — so an alias stops being reported, which is the direction that matters.
 * The last three are the answers that must not move either: a bare `document` is reported
 * whatever the file binds it to (`findBrowserGlobals` says so on purpose), a parameter takes
 * the rule off the outer alias, and a binding something writes to afterwards is not followed.
 */
const SCOPE_CORPUS: readonly { readonly label: string; readonly source: string }[] = [
  { label: "alias/transcendental", source: "const M = Math;\nconst v = M.exp(1);" },
  { label: "alias/chain", source: "const A = Math;\nconst B = A;\nconst v = B.log(2);" },
  { label: "alias/browser-global", source: "const g = globalThis;\nconst s = g.localStorage;" },
  {
    label: "alias/in-a-function",
    source: "function scale(x) {\n  const M = Math;\n  return M.exp(x);\n}",
  },
  {
    label: "alias/rebound-in-a-block",
    source: "const M = shim;\n{\n  const M = Math;\n  const v = M.exp(1);\n}",
  },
  {
    label: "alias/shadowed-by-a-parameter",
    source: "const M = Math;\nfunction scale(M) {\n  return M.exp(1);\n}",
  },
  { label: "alias/shadowing-a-global", source: "function draw(document) {\n  return document;\n}" },
  { label: "alias/reassigned", source: "let M = Math;\nM = shim;\nconst v = M.exp(1);" },
];

function scopeCases(): Case[] {
  return SCOPE_CORPUS.map(({ label, source }) => ({
    label: `scope:${label}`,
    source,
    resolveRelative: stayPut,
  }));
}

/** The scope corpus alone, which is the half whose answers a reader can hold in their head. */
export function scopeReadings(): string[] {
  return linesFor(scopeCases());
}

function linesFor(cases: readonly Case[]): string[] {
  const lines: string[] = [];
  for (const one of cases) {
    for (const { rule, read } of readings) {
      for (const entry of read(rules, one)) lines.push(`${one.label} | ${rule} | ${entry}`);
    }
    for (const name of calleeNames(rules, one)) {
      const counts = rules.findCallArgumentCounts(one.source, name).map(String).sort();
      for (const count of counts) {
        lines.push(`${one.label} | findCallArgumentCounts(${name}) | ${count}`);
      }
    }
  }
  return lines;
}

/**
 * Every reading of the rules this runtime gives: the scope corpus, the shared corpus, and the
 * joined `unsupplied-default` answer, which is the one reading that is a question about a set
 * of files rather than about a file.
 *
 * The workspace itself is deliberately not swept here. A divergence is in what a runtime makes
 * of `source-rules.ts`, not of the file being read, so it shows on any input that reaches the
 * rule — and the workspace reaches no rule the corpus does not. It also answers nothing: the
 * product source is clean, which `check:boundary` is what says. Sweeping 175 real files under
 * both runtimes cost 96% of this gate's wall clock and contributed no line to compare.
 */
export function readingsOfTheRules(): string[] {
  return [
    ...linesFor([...scopeCases(), ...corpusCases()]),
    ...joinedUnsuppliedDefaults(rules, joinedCorpusCases()).map((v) => `joined:corpus | ${v}`),
  ];
}

/** How many times each line appears, because a reading repeated twice is not the same as once. */
function tally(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/**
 * Every line the two runtimes do not agree on, each said from the side that has it.
 *
 * This is what the gate asserts empty. It is deliberately a multiset comparison rather than a
 * set one: a rule that reports a finding twice where the other reports it once has diverged,
 * and a set comparison would call that agreement.
 */
export function differencesBetween(inProcess: readonly string[], underBun: readonly string[]) {
  const mine = tally(inProcess);
  const theirs = tally(underBun);
  const differences: string[] = [];
  for (const line of new Set([...mine.keys(), ...theirs.keys()].sort())) {
    const surplus = (mine.get(line) ?? 0) - (theirs.get(line) ?? 0);
    for (let n = 0; n < surplus; n += 1) differences.push(`only in this runtime: ${line}`);
    for (let n = 0; n < -surplus; n += 1) differences.push(`only under bun: ${line}`);
  }
  return differences;
}

/**
 * The same reading, taken from a `bun run` of the module that prints it.
 *
 * A subprocess is the whole point: the divergence is in what the runtime makes of the source
 * before it runs it, so nothing short of a second transpile of the same file can see it.
 */
export function readUnderBun(module: string): string[] {
  const done = spawnSync("bun", ["run", resolve(here, module)], {
    cwd: resolve(here, "../.."),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  if (done.error) throw done.error;
  if (done.status !== 0) {
    throw new Error(`bun run ${module} exited ${String(done.status)}: ${done.stderr.trim()}`);
  }
  return JSON.parse(done.stdout) as string[];
}

// As a command it prints this runtime's reading; as an import it hands the reading and the
// comparison over to the test beside it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(readingsOfTheRules()));
}
