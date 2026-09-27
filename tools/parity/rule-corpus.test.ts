// boundary-intent harness: reads the shared rule corpus, which is repository tooling
/**
 * The corpus the boundary rules are read over, asked whether it says anything at all.
 *
 * What is under test is that the corpus is not compared *empty*. Two runtimes reading the
 * same rules agree perfectly when both readings are empty, however broken the rules are. A
 * corpus that reports a violation is what makes a pass going quiet change the comparison.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { joinedCorpusCases, joinedUnsuppliedDefaults } from "./rule-corpus.ts";
import * as rules from "../../sim/test/support/source-rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

describe("the rule corpus as repository tooling", () => {
  it("sits beside its test under tools/, not at the repository root", () => {
    expect(existsSync(join(here, "rule-corpus.ts"))).toBe(true);
    expect(existsSync(join(repoRoot, "rule-corpus.ts"))).toBe(false);
  });
});

describe("the joined unsupplied-default corpus", () => {
  it("reports a violation, so the reading is not compared empty", () => {
    expect(joinedUnsuppliedDefaults(rules, joinedCorpusCases())).toEqual([
      "sim/src/joined-default.ts:1 unsupplied-default buildJoined(count)",
    ]);
  });

  it("goes quiet the moment a two-argument call site is counted, phantom or real", () => {
    const declared = joinedCorpusCases().flatMap((one) =>
      rules.findDefaultedParameters(one.source),
    );

    expect(rules.findUnsuppliedDefaults(declared, () => [])).toHaveLength(1);
    expect(rules.findUnsuppliedDefaults(declared, () => [2])).toHaveLength(0);
  });
});
