// boundary-intent harness: the sweep itself, and it reads source text rather than running it
import { readFileSync, readdirSync } from "node:fs";
import { dirname, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ALLOWED_ESCAPING_IMPORTS,
  MUTABLE_CONSTRUCTORS,
  TEST_INTENTS,
  UNSUPPLIED_DEFAULT_RULE,
  findBrowserGlobals,
  findCallArgumentCounts,
  findCalls,
  findCallsAcross,
  findCrossSeamImports,
  findDefaultedParameters,
  findExemptions,
  findForbiddenImports,
  findImportSpecifiers,
  findIntents,
  findMutableModuleState,
  findRuntimeTranscendentals,
  findUnsuppliedDefaults,
  type IntentDeclaration,
  type Violation,
} from "./support/source-rules.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(packageRoot, "src");
const testRoot = resolve(packageRoot, "test");
const workspaceRoot = resolve(packageRoot, "..");

function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
    .map((entry) => resolve(root, entry))
    .sort();
}

function sourceFiles(): string[] {
  return filesUnder(sourceRoot);
}

function testFiles(): string[] {
  return filesUnder(testRoot);
}

/** Resolves a specifier the way the file's own imports resolve: relative to the package. */
function withinPackageFrom(file: string): (specifier: string) => string {
  return (specifier) =>
    posix.normalize(relative(packageRoot, resolve(dirname(file), specifier)).replaceAll("\\", "/"));
}

function intentOf(file: string): string | undefined {
  return findIntents(readFileSync(file, "utf8"))[0]?.intent;
}

function filesDeclaring(intent: string): string[] {
  return testFiles()
    .filter((file) => intentOf(file) === intent)
    .map((file) => relative(packageRoot, file).replaceAll("\\", "/"));
}

/**
 * Directories the search for call sites does not enter. Dot-directories (`.git`, and the
 * worktrees under `.worktrees/`) are skipped as a class; the rest are named because skipping
 * one is a decision. `singularity/` is the reference and is not the port's code.
 */
const NOT_CALL_SITES: readonly string[] = ["node_modules", "dist", "singularity"];

/** Every TypeScript file in the workspace that could call into `sim/`. */
function workspaceFiles(directory: string = workspaceRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || NOT_CALL_SITES.includes(entry.name)) return [];
      return workspaceFiles(path);
    }
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [path] : [];
  });
}

function report(file: string, violations: readonly Violation[]): string[] {
  const shown = relative(packageRoot, file);
  return violations.map((v) => `${shown}:${v.line} ${v.rule}: ${v.detail}`);
}

function scanEveryFile(scan: (source: string, file: string) => readonly Violation[]): string[] {
  return sourceFiles().flatMap((file) => report(file, scan(readFileSync(file, "utf8"), file)));
}

// The Simulation is the half of the seam that has to stay runnable headless, under whatever
// engine the trace is driven by. These are the rules
// the package boundary cannot enforce on its own.
describe("the sim/ boundary", () => {
  it("has sources to check", () => {
    expect(sourceFiles().length).toBeGreaterThan(0);
  });

  it("reaches no browser global", () => {
    expect(scanEveryFile(findBrowserGlobals)).toEqual([]);
  });

  it("takes no transcendental from the runtime", () => {
    expect(scanEveryFile(findRuntimeTranscendentals)).toEqual([]);
  });

  // A Tick is reproducible from its input alone, so there is nowhere for a rule to
  // keep state between calls. Upstream keeps most of its state exactly there. `const` is not
  // a defence: it freezes the binding and never the object, so a `new Map()` or a scratch
  // `DataView` at module scope is state under a name that says it is not.
  it("holds no module-level mutable state", () => {
    expect(scanEveryFile(findMutableModuleState)).toEqual([]);
  });

  // An exemption that only its author ever sees is the rule deleted a line at a time. Every
  // one of them is listed here, so a second is an edit to this test rather than a comment.
  it("carries exactly one written exemption from that rule", () => {
    const found = sourceFiles().flatMap((file) =>
      findExemptions(readFileSync(file, "utf8")).map((exemption) => ({
        where: relative(packageRoot, file),
        rule: exemption.rule,
        detail: exemption.detail,
        reason: exemption.reason,
      })),
    );

    expect(found.map(({ where, rule, detail }) => `${where} ${rule}: ${detail}`)).toEqual([
      "src/libm/exp.ts module-level-mutable-state: new DataView",
    ]);
    // The reason has to say why, and `exp.ts` carries the measurement behind it.
    expect(found[0]?.reason).toMatch(/carrying nothing from one call to the next/);
  });

  it("imports nothing from outside the package", () => {
    expect(
      scanEveryFile((source, file) => findForbiddenImports(source, withinPackageFrom(file))),
    ).toEqual([]);
  });
});

/**
 * `sim/test` was outside all of that, and a directory is the wrong thing to decide it by:
 * `support/trace.ts` drives the Simulation and its output *is* the port's half of every
 * comparison, so a `Math.exp` or a cached value there would move a Trace exactly as one in
 * `sim/src` would — and no rule reached it.
 *
 * So every file here declares what it is for, and the declaration is what the rules act on:
 *
 * - **simulation** — shared code that runs the Simulation and produces what a comparison
 *   binds. Held to the rules `sim/src` lives under, minus the package-import rule: a
 *   harness reads files and spawns processes, which a shipped module may not.
 * - **harness** — code that arranges, reads, spawns or asserts. A test file is this by
 *   role: it decides what to drive and what to expect, and nothing else runs its body.
 *
 * The transcendental rule is the one that does not read the declaration at all: what a harness
 * computes is an *expectation*, and an expectation taken from the runtime's libm is a
 * comparison against the thing under test.
 *
 * The declaration cannot simply be the comfortable one. The roster below is asserted whole,
 * so a file leaving it is an edit to a test; and shared code that imports a *value* out of
 * `src/` may not call itself a harness, which is the shape `trace.ts` has.
 */
describe("the sim/test boundary", () => {
  it("has tests to check", () => {
    expect(testFiles().length).toBeGreaterThan(0);
  });

  it("has every file say what it is for, once, in words a rule can act on", () => {
    const undeclared: string[] = [];
    for (const file of testFiles()) {
      const declared = findIntents(readFileSync(file, "utf8"));
      const shown = relative(packageRoot, file);
      if (declared.length !== 1) {
        undeclared.push(`${shown}: ${declared.length} intent declarations, expected 1`);
        continue;
      }
      const [only] = declared as [IntentDeclaration];
      if (!TEST_INTENTS.includes(only.intent)) {
        undeclared.push(`${shown}: unknown intent "${only.intent}"`);
      }
    }

    expect(undeclared).toEqual([]);
  });

  it("names the files that drive the Simulation", () => {
    expect(filesDeclaring("simulation")).toEqual([
      "test/support/exp-grid.ts",
      "test/support/fidelity.ts",
      "test/support/trace.ts",
    ]);
  });

  it("holds those to the rules sim/src lives under", () => {
    const scan = (source: string, file: string): Violation[] => [
      ...findBrowserGlobals(source),
      ...findRuntimeTranscendentals(source),
      ...findMutableModuleState(source),
      ...findCrossSeamImports(source, withinPackageFrom(file)),
    ];

    expect(
      testFiles()
        .filter((file) => intentOf(file) === "simulation")
        .flatMap((file) => report(file, scan(readFileSync(file, "utf8"), file))),
    ).toEqual([]);
  });

  /**
   * The one rule that holds whatever a file says it is for.
   *
   * The other two do not survive contact with a harness, and are right not to: `window` and
   * `document` are ordinary local names in a test that binds them (`grace.trace.test.ts`,
   * `rng.trace.test.ts`, `content.trace.test.ts`), and a trace memoised for the life of a file
   * that runs once is not state carried between Ticks (`past-grace.trace.test.ts`,
   * `reference-trace.test.ts`). A transcendental is different in kind. A test file computes
   * what it *expects*, so a `Math.exp` in `exp.trace.test.ts` would compare the port's `exp`
   * against the runtime's rather than against the committed vector — the comparison would
   * defeat itself and pass in silence, and for `Math.exp` the source rule is the only
   * enforcement. So this one reaches every file here, expectations included.
   */
  it("takes no transcendental from the runtime, whatever a file is for", () => {
    expect(
      testFiles().flatMap((file) =>
        report(file, findRuntimeTranscendentals(readFileSync(file, "utf8"))),
      ),
    ).toEqual([]);
  });

  // The one way the declaration could be quietly wrong, closed: shared code that imports a
  // value out of `src/` runs the Simulation on every test's behalf, whatever it says it is
  // for. A test file is the assertion end and is excluded by role, not by where it lives.
  it("refuses a harness declaration on shared code that runs the Simulation", () => {
    const mislabelled = testFiles()
      .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
      .filter((file) =>
        findImportSpecifiers(readFileSync(file, "utf8")).some(
          ({ specifier, typeOnly }) =>
            !typeOnly && withinPackageFrom(file)(specifier).startsWith("src/"),
        ),
      )
      .filter((file) => intentOf(file) !== "simulation")
      .map((file) => relative(packageRoot, file));

    expect(mislabelled).toEqual([]);
  });

  // Nothing in `sim/` reaches `app/`, tests included — the package boundary stops the
  // sources and says nothing about a test, which resolves through the same tsconfig.
  it("lets nothing here reach across the seam", () => {
    expect(
      testFiles().flatMap((file) =>
        report(file, findCrossSeamImports(readFileSync(file, "utf8"), withinPackageFrom(file))),
      ),
    ).toEqual([]);
  });

  // The enumeration is what stops the sweep below from passing on an empty hand. A text
  // scanner that stops recognising a declaration reports no violations *and* no defaults,
  // and this list is the only thing that would notice.
  it("declares exactly the defaulted parameters it means to", () => {
    expect(
      sourceFiles().flatMap((file) =>
        findDefaultedParameters(readFileSync(file, "utf8")).map(
          ({ name, parameter }) => `${relative(packageRoot, file)} ${name}(${parameter})`,
        ),
      ),
    ).toEqual([
      "src/base.ts newBase(built)",
      "src/buyable.ts newBuyable(count)",
      // The hypothetical a Projection is asked about. The HUD asks with nothing
      // being considered and the build dial asks with its own order, so both readings are
      // supplied by a real caller and the default is the commoner of the two.
      "src/flow.ts resourceFlow(considered)",
      // Upstream's `loading_savegame` (`effect.py:38`). Restoring a Save is the one caller
      // that passes it; every rule that applies a consequence in play leaves it out, which is
      // the reading the default exists to keep.
      "src/gameevent.ts applyConsequence(loadingSave)",
      "src/item.ts newItem(count)",
    ]);
  });

  // A default nobody passes is not a choice the port is offering; it is upstream's signature
  // transcribed one field too far, with the decision it defers already taken. Call sites are looked for across the whole workspace, not just `sim/`, so a
  // parameter `app/` supplies is not reported here.
  it("carries no defaulted parameter that no call site supplies", () => {
    const calls = findCallsAcross(workspaceFiles().map((file) => readFileSync(file, "utf8")));
    const argumentCounts = (name: string): readonly number[] => calls.get(name) ?? [];

    expect(
      sourceFiles().flatMap((file) => {
        const declared = findDefaultedParameters(readFileSync(file, "utf8"));
        return report(file, findUnsuppliedDefaults(declared, argumentCounts));
      }),
    ).toEqual([]);
  });
});

// The rules themselves: each one has to be red on the thing it forbids, or the sweep above
// is a test that can only pass.
describe("the boundary rules", () => {
  it("catches a browser global, and leaves a comment or a string alone", () => {
    expect(findBrowserGlobals("const w = window.innerWidth;")).toEqual([
      { rule: "browser-global", line: 1, detail: "window" },
    ]);
    expect(findBrowserGlobals("const g = globalThis;")).toEqual([
      { rule: "browser-global", line: 1, detail: "globalThis" },
    ]);
    expect(findBrowserGlobals("// window is not available here\nconst x = 1;")).toEqual([]);
    expect(findBrowserGlobals('const note = "window";')).toEqual([]);
    expect(findBrowserGlobals("const x = `${document.title}`;")).toEqual([
      { rule: "browser-global", line: 1, detail: "document" },
    ]);
  });

  // TypeScript hangs the doc comment off the declaration below it, so a walk into it would
  // read `@param window` as a reference. A doc comment can reach nothing at run time, so the walk steps over it — and
  // an import written in one is prose too, which is why the roster test above excludes it.
  it("leaves a doc comment alone, tag positions included", () => {
    const documented = [
      "/**",
      " * @param window the surface the caller draws on",
      " * @returns {Promise<Response>} what fetch would have returned",
      " * @see {@link Math.exp} for the ported one",
      " * @throws if document, navigator or performance is asked for",
      " */",
      "export const describeIt = 1;",
    ].join("\n");

    expect(findBrowserGlobals(documented)).toEqual([]);
    expect(findRuntimeTranscendentals(documented)).toEqual([]);

    // The declaration under the comment is still read.
    expect(findBrowserGlobals(`${documented}\nconst w = window.innerWidth;`)).toEqual([
      { rule: "browser-global", line: 8, detail: "window" },
    ]);
    // And a JSDoc type annotation, which the parse turns into type nodes of its own.
    expect(findBrowserGlobals("/** @type {typeof window} */\nexport const a = 1;")).toEqual([]);
  });

  it("does not mistake the game's own vocabulary for a browser global", () => {
    const domain = `
      interface GameEvent { readonly id: string }
      const location = { id: "N AMERICA" };
      const screen = { name: "map" };
      const history: GameEvent[] = [];
      const document_ = 1;
      const nested = { windows: 2 }.windows;
    `;
    expect(findBrowserGlobals(domain)).toEqual([]);
  });

  it("catches every transcendental the port must not take from the runtime", () => {
    for (const name of ["exp", "log", "pow", "sin"]) {
      expect(findRuntimeTranscendentals(`const v = Math.${name}(x);`)).toEqual([
        { rule: "runtime-transcendental", line: 1, detail: `Math.${name}` },
      ]);
    }
    expect(findRuntimeTranscendentals('const v = Math["exp"](x);')).toEqual([
      {
        rule: "runtime-transcendental",
        line: 1,
        detail: "Math[…] (computed access hides which member is used)",
      },
    ]);
    expect(findRuntimeTranscendentals("const v = Math.floor(x) + Math.max(a, b);")).toEqual([]);
  });

  it("catches a module-scope let or var, and leaves one inside a function alone", () => {
    expect(findMutableModuleState("let current = 0;")).toEqual([
      { rule: "module-level-mutable-state", line: 1, detail: "let" },
    ]);
    expect(findMutableModuleState("var tasks = {};")).toEqual([
      { rule: "module-level-mutable-state", line: 1, detail: "var" },
    ]);

    // A local is the whole point of the rule's edge: the rules mutate freely inside a call.
    const local = [
      "export function tick(state) {",
      "  let cpuPool = 0;",
      "  for (var index = 0; index < 3; index += 1) cpuPool += index;",
      "  return cpuPool;",
      "}",
      "const NO_EFFECTS = [];",
      "export const table = { a: 1 };",
    ].join("\n");
    expect(findMutableModuleState(local)).toEqual([]);

    // A comment or a string that says "let" is not one.
    expect(findMutableModuleState('// let the caller decide\nconst x = "let y = 1";')).toEqual([]);
    expect(findMutableModuleState("const letters = 1; const varied = 2;")).toEqual([]);
  });

  // The half that reads as a constant and is not. `const` freezes the binding, never the
  // object, so a scratch buffer or a cache declared this way carries information from one
  // call into the next exactly as a `let` would.
  it("catches a module-scope const bound to a mutable constructor", () => {
    for (const constructor of MUTABLE_CONSTRUCTORS) {
      expect(findMutableModuleState(`const scratch = new ${constructor}(8);`)).toEqual([
        { rule: "module-level-mutable-state", line: 1, detail: `new ${constructor}` },
      ]);
    }

    // The shape that is actually in the package: the outer constructor is the one named.
    expect(findMutableModuleState("const bits = new DataView(new ArrayBuffer(8));")).toEqual([
      { rule: "module-level-mutable-state", line: 1, detail: "new DataView" },
    ]);
    // An annotation carrying a comma is not a second declarator.
    expect(findMutableModuleState("export const seen: Map<string, number> = new Map();")).toEqual([
      { rule: "module-level-mutable-state", line: 1, detail: "new Map" },
    ]);
    expect(findMutableModuleState("export let cache = new Map();")).toEqual([
      { rule: "module-level-mutable-state", line: 1, detail: "let" },
    ]);
    expect(findMutableModuleState("const a = 1,\n  b = new Set();")).toEqual([
      { rule: "module-level-mutable-state", line: 2, detail: "new Set" },
    ]);
  });

  // The edges the rule must not catch, or every module in `sim/` becomes an argument about
  // the rule rather than about the code.
  it("leaves a frozen constant, a plain literal and a local construction alone", () => {
    expect(findMutableModuleState("const NO_EFFECTS = Object.freeze([]);")).toEqual([]);
    expect(findMutableModuleState('const ACTIVE_STATES = ["active", "sleep"];')).toEqual([]);
    expect(findMutableModuleState("const table = { a: 1 };")).toEqual([]);
    expect(findMutableModuleState("const size = 8;")).toEqual([]);
    expect(findMutableModuleState("const started = new Date();")).toEqual([]);

    // Built per call rather than once: a factory and a local are both fresh every time.
    expect(findMutableModuleState("const build = () => new Map();")).toEqual([]);
    expect(
      findMutableModuleState("function make() {\n  const seen = new Set();\n  return seen;\n}"),
    ).toEqual([]);

    // A comment or a string that says it is not one.
    expect(findMutableModuleState('const note = "new Map()";')).toEqual([]);
    expect(findMutableModuleState("// const cache = new Map();\nconst size = 8;")).toEqual([]);
  });

  // The exemption is the pressure valve, and a valve nobody can see is a hole. It has to be
  // written where the rule reads it, it has to carry a reason, and it has to stop being an
  // exemption the moment the code under it stops being a violation.
  it("takes a written exemption, and reports one that exempts nothing", () => {
    const exempt = [
      "// boundary-exemption module-level-mutable-state: a scratch, written before every read",
      "const bits = new DataView(new ArrayBuffer(8));",
    ].join("\n");
    expect(findMutableModuleState(exempt)).toEqual([]);
    expect(findExemptions(exempt)).toEqual([
      {
        rule: "module-level-mutable-state",
        line: 2,
        detail: "new DataView",
        reason: "a scratch, written before every read",
      },
    ]);

    // A marker outlives the code it was written for unless something notices.
    const dangling = [
      "// boundary-exemption module-level-mutable-state: nothing here any more",
      "const size = 8;",
    ].join("\n");
    expect(findMutableModuleState(dangling)).toEqual([
      {
        rule: "unused-exemption",
        line: 1,
        detail: "module-level-mutable-state: nothing on the declaration below it is a violation",
      },
    ]);
    expect(findExemptions(dangling)).toEqual([]);

    // It reaches the declaration below it and nothing else.
    const oneOfTwo = [
      "// boundary-exemption module-level-mutable-state: the first one only",
      "const first = new Map();",
      "const second = new Set();",
    ].join("\n");
    expect(findMutableModuleState(oneOfTwo)).toEqual([
      { rule: "module-level-mutable-state", line: 3, detail: "new Set" },
    ]);

    // No reason is no exemption: the point of the marker is the sentence after the colon.
    const silent = [
      "// boundary-exemption module-level-mutable-state:",
      "const cache = new Map();",
    ].join("\n");
    expect(findMutableModuleState(silent)).toEqual([
      { rule: "module-level-mutable-state", line: 2, detail: "new Map" },
    ]);
  });

  it("catches an import of app/, however it is spelled", () => {
    const stay = (specifier: string): string =>
      specifier.replace(/^\.\//, "").replace(/^\.\.\//, "");

    expect(findForbiddenImports('import { App } from "@singularity/app";', stay)).toEqual([
      { rule: "foreign-import", line: 1, detail: "@singularity/app" },
    ]);
    expect(
      findForbiddenImports(
        'import { App } from "../../app/src/ui/App.tsx";',
        () => "../app/src/ui/App.tsx",
      ),
    ).toEqual([{ rule: "escaping-import", line: 1, detail: "../../app/src/ui/App.tsx" }]);
    expect(findForbiddenImports('import { readFileSync } from "node:fs";', stay)).toEqual([
      { rule: "foreign-import", line: 1, detail: "node:fs" },
    ]);
    expect(findForbiddenImports('import { advance } from "./advance.ts";', stay)).toEqual([]);
  });

  // The one allowance the rule carries: committed Converter output, reached by
  // `sim/src/content/documents.ts` and by nothing else. An allowance nobody can see the
  // edges of is a rule quietly deleted, so the edges get their own test.
  it("lets the Converter's output through, and only that", () => {
    expect(ALLOWED_ESCAPING_IMPORTS).toEqual([{ prefix: "../content/", suffix: ".json" }]);

    expect(
      findForbiddenImports(
        'import bases from "../../../content/bases.json";',
        () => "../content/bases.json",
      ),
    ).toEqual([]);

    // Code in content/, a directory that only looks like it, and a path spelled through
    // content/ to somewhere else — the caller normalises, so the last one arrives as app/.
    const refused: readonly (readonly [string, string])[] = [
      ["../../../content/loader.ts", "../content/loader.ts"],
      ["../../../content-extra/bases.json", "../content-extra/bases.json"],
      ["../../../content/../app/src/ui/App.tsx", "../app/src/ui/App.tsx"],
      ["../../../scenarios/manifest.json", "../scenarios/manifest.json"],
    ];
    for (const [specifier, resolved] of refused) {
      expect(findForbiddenImports(`import x from "${specifier}";`, () => resolved)).toEqual([
        { rule: "escaping-import", line: 1, detail: specifier },
      ]);
    }
  });

  it("catches an import that reaches across the seam, and lets a harness import through", () => {
    const stay = (specifier: string): string => specifier.replace(/^(?:\.\/|\.\.\/)+/, "");

    expect(findCrossSeamImports('import { App } from "@singularity/app";', stay)).toEqual([
      { rule: "cross-seam-import", line: 1, detail: "@singularity/app" },
    ]);
    expect(
      findCrossSeamImports(
        'import { App } from "../../app/src/ui/App.tsx";',
        () => "../app/src/ui/App.tsx",
      ),
    ).toEqual([{ rule: "cross-seam-import", line: 1, detail: "../../app/src/ui/App.tsx" }]);

    // What a test may reach for and `sim/src` may not: the platform, the runner, a fixture
    // beside it, the package's own sources.
    for (const specifier of ["node:fs", "vitest", "./support/trace.ts", "../src/index.ts"]) {
      expect(findCrossSeamImports(`import x from "${specifier}";`, stay)).toEqual([]);
    }
    // A directory that only starts the same way is not the package.
    expect(
      findCrossSeamImports('import x from "../../application/x.ts";', () => "../application/x.ts"),
    ).toEqual([]);
  });

  it("tells a type-only import from one that runs code", () => {
    const source = [
      'import type { Speed } from "./speed.ts";',
      'import { advance } from "./advance.ts";',
      'export type { Speed } from "./speed.ts";',
      'import { type Draw, toPlain } from "./index.ts";',
    ].join("\n");

    expect(
      findImportSpecifiers(source).map(({ specifier, typeOnly }) => [specifier, typeOnly]),
    ).toEqual([
      ["./speed.ts", true],
      ["./advance.ts", false],
      ["./speed.ts", true],
      ["./index.ts", false],
    ]);
  });

  // The intent marker, in the same shape as the exemption marker and for the same reason: a
  // decision a rule acts on has to be written where the rule reads it.
  it("reads an intent declaration, with its reason", () => {
    expect(findIntents("// boundary-intent simulation: a Scenario in, a Trace out")).toEqual([
      { intent: "simulation", line: 1, reason: "a Scenario in, a Trace out" },
    ]);
    expect(
      findIntents(" * boundary-intent harness: spawns the reference and reads its output"),
    ).toEqual([
      { intent: "harness", line: 1, reason: "spawns the reference and reads its output" },
    ]);

    // No reason is no declaration — the sentence after the colon is the point of it.
    expect(findIntents("// boundary-intent simulation:")).toEqual([]);
    // And a mention in prose is not one.
    expect(findIntents('const note = "boundary-intent simulation: not here";')).toEqual([]);
    expect(findIntents("import { boundaryIntent } from './x.ts';")).toEqual([]);
  });

  // The roster is the rule: a form missing here is a rule that says nothing about it, and
  // the import rules are the ones with no second line of defence for a file that does not
  // compile.
  it("finds specifiers in every form an import takes", () => {
    const source = [
      'import "./side-effect.ts";',
      'import def from "./default.ts";',
      'export { thing } from "./re-export.ts";',
      'export * from "./star.ts";',
      'const later = await import("./dynamic.ts");',
      'import equals = require("./import-equals.ts");',
      'const called = require("./call-require.ts");',
      'type OfModule = typeof import("./type-position.ts");',
      'let member: import("./type-member.ts").Thing;',
      '// import "./commented-out.ts";',
      '/** @see import("./in-a-doc-comment.ts") */',
      "export const marker = 1;",
    ].join("\n");

    expect(findImportSpecifiers(source).map((found) => found.specifier)).toEqual([
      "./side-effect.ts",
      "./default.ts",
      "./re-export.ts",
      "./star.ts",
      "./dynamic.ts",
      "./import-equals.ts",
      "./call-require.ts",
      "./type-position.ts",
      "./type-member.ts",
    ]);
  });

  // `import("…")` in type position is easy to drop from a parse-based roster. The shape is live in this package — `typeof import("../src/content/documents.ts")` in
  // past-grace.trace.test.ts — and neither rule exempts a type-only import: a specifier
  // that names a path is a dependency the file declares, whether or not it survives emit.
  it("sees an import in type position, in both import rules", () => {
    const stay = (specifier: string): string => specifier.replace(/^(?:\.\/|\.\.\/)+/, "");
    const outward = (): string => "../app/src/ui/App.tsx";

    for (const source of [
      'type Module = typeof import("../../app/src/ui/App.tsx");',
      'let member: import("../../app/src/ui/App.tsx").App;',
      'function take(named: import("../../app/src/ui/App.tsx").App): void {}',
    ]) {
      expect(findCrossSeamImports(source, outward)).toEqual([
        { rule: "cross-seam-import", line: 1, detail: "../../app/src/ui/App.tsx" },
      ]);
      expect(findForbiddenImports(source, outward)).toEqual([
        { rule: "escaping-import", line: 1, detail: "../../app/src/ui/App.tsx" },
      ]);
    }

    // A bare specifier in the same position is foreign, and one that stays inside is fine.
    expect(findForbiddenImports('let x: import("node:fs").Stats;', stay)).toEqual([
      { rule: "foreign-import", line: 1, detail: "node:fs" },
    ]);
    expect(findForbiddenImports('let x: typeof import("./sibling.ts");', stay)).toEqual([]);

    // It erases, so it drives nothing — which is all `typeOnly` claims about a specifier.
    expect(findImportSpecifiers('let x: typeof import("./sibling.ts");')).toEqual([
      { specifier: "./sibling.ts", line: 1, typeOnly: true },
    ]);
    expect(findImportSpecifiers('import equals = require("./sibling.ts");')).toEqual([
      { specifier: "./sibling.ts", line: 1, typeOnly: false },
    ]);
  });

  // A scanner that loses its place does not fail: it reports nothing, for every rule, for
  // the rest of the file. For Math.exp there is no second line of defence, so each way of
  // losing the place gets a test that would otherwise be silently green.
  it("keeps scanning after a regex literal that carries a quote", () => {
    const source = [
      "const apostrophe = /[\\'`]/;",
      "const w = window.innerWidth;",
      "const v = Math.exp(2);",
    ].join("\n");

    expect(findBrowserGlobals(source)).toEqual([
      { rule: "browser-global", line: 2, detail: "window" },
    ]);
    expect(findRuntimeTranscendentals(source)).toEqual([
      { rule: "runtime-transcendental", line: 3, detail: "Math.exp" },
    ]);
  });

  it("tells a regex literal from a division by the token before the slash", () => {
    const divisions: readonly (readonly [string, string])[] = [
      ["const half = total / 2; const w = window / 3;", "window"],
      ["const mid = (a + b) / 2; const d = document.title / 3;", "document"],
      ["const first = values[0] / total; const n = navigator.language / 3;", "navigator"],
      ["const ratio = `${a}` / 2; const w = window / 3;", "window"],
    ];
    for (const [source, detail] of divisions) {
      expect(findBrowserGlobals(source)).toEqual([{ rule: "browser-global", line: 1, detail }]);
    }

    const literals: readonly (readonly [string, string])[] = [
      ["function q(s) { return /['\"]/.test(s); }\nconst w = window;", "window"],
      ["const hit = match(/['\"]/);\nconst d = document;", "document"],
      ["const hit = typeof s === 'string' && /['\"]/.test(s);\nconst n = navigator;", "navigator"],
    ];
    for (const [source, detail] of literals) {
      expect(findBrowserGlobals(source)).toEqual([{ rule: "browser-global", line: 2, detail }]);
    }
  });

  // A `)` is the one token that cannot be read on its own: it ends `(a + b)` and it ends
  // `if (ready)`, and only the word in front of the matching `(` says which. Reading it as
  // an expression costs the rest of the line, and for Math.exp the source rule is the only
  // enforcement there is.
  it("tells a regex after a statement head from a division after an expression", () => {
    const heads: readonly string[] = [
      "if (ready) /['\"]/.test(name); const v = Math.exp(2);",
      "while (more) /['\"]/.test(s); const v = Math.exp(2);",
      "for (const s of list) /['\"]/.test(s); const v = Math.exp(2);",
      "if (check(a) && ready) /['\"]/.test(s); const v = Math.exp(2);",
      "} else if (ready) /['\"]/.test(s); const v = Math.exp(2);",
    ];
    for (const source of heads) {
      expect(findRuntimeTranscendentals(source)).toEqual([
        { rule: "runtime-transcendental", line: 1, detail: "Math.exp" },
      ]);
    }

    const divisions: readonly string[] = [
      "const mid = (a + b) / 2; const v = Math.exp(2);",
      "const scaled = factor(a) / 2; const v = Math.exp(2);",
      "const odd = (a + b) / 2 + (c + d) / 3; const v = Math.exp(2);",
      'const inString = f("(if x)") / 2; const v = Math.exp(2);',
    ];
    for (const source of divisions) {
      expect(findRuntimeTranscendentals(source)).toEqual([
        { rule: "runtime-transcendental", line: 1, detail: "Math.exp" },
      ]);
      expect(findBrowserGlobals(`${source}\nconst w = window;`)).toEqual([
        { rule: "browser-global", line: 2, detail: "window" },
      ]);
    }
  });

  it("reads no code, comment or import out of a regex body", () => {
    expect(findBrowserGlobals("const re = /window|document/;\nconst x = 1;")).toEqual([]);
    expect(findRuntimeTranscendentals("const re = /Math\\.exp/;\nconst y = 2;")).toEqual([]);
    expect(findBrowserGlobals("const re = /[/*]/; const w = window;")).toEqual([
      { rule: "browser-global", line: 1, detail: "window" },
    ]);

    const phantom = [
      'const looksLikeImport = /(import "\\.\\.\\/app\\/src\\/App.tsx")/;',
      'import { advance } from "./advance.ts";',
    ].join("\n");
    expect(findImportSpecifiers(phantom).map((found) => found.specifier)).toEqual(["./advance.ts"]);
  });

  it("scans every template substitution as code, however many there are", () => {
    expect(findBrowserGlobals("const label = `${x} ${document.title} ${y}`;")).toEqual([
      { rule: "browser-global", line: 1, detail: "document" },
    ]);
    expect(findBrowserGlobals("const label = `${a}${b}`;\nconst w = window.innerWidth;")).toEqual([
      { rule: "browser-global", line: 2, detail: "window" },
    ]);
    expect(findBrowserGlobals("const ok = `${/['\"]/.test(s)}`;\nconst w = window;")).toEqual([
      { rule: "browser-global", line: 2, detail: "window" },
    ]);

    const nested = "const label = `${ `${navigator.language}` }`;\nconst v = Math.exp(2);";
    expect(findBrowserGlobals(nested)).toEqual([
      { rule: "browser-global", line: 1, detail: "navigator" },
    ]);
    expect(findRuntimeTranscendentals(nested)).toEqual([
      { rule: "runtime-transcendental", line: 2, detail: "Math.exp" },
    ]);
  });

  // The preceding-token rule is a heuristic, so it will misread something eventually. What
  // it must never do is misread it into blindness for the rest of the file.
  it("recovers at the end of the line from a quote that never closes", () => {
    const strayQuote = ['const broken = "oops;', "const v = Math.exp(2);"].join("\n");
    expect(findRuntimeTranscendentals(strayQuote)).toEqual([
      { rule: "runtime-transcendental", line: 2, detail: "Math.exp" },
    ]);

    const regexAfterCondition = ["if (ready) /['\"]/.test(name);", "const w = window;"].join("\n");
    expect(findBrowserGlobals(regexAfterCondition)).toEqual([
      { rule: "browser-global", line: 2, detail: "window" },
    ]);

    const unterminatedRegex = ["const re = /never closed;", "const d = document;"].join("\n");
    expect(findBrowserGlobals(unterminatedRegex)).toEqual([
      { rule: "browser-global", line: 2, detail: "document" },
    ]);
  });

  it("still lets a template literal span lines", () => {
    const spanning = ["const text = `first", "second ${document.title}", "third`;"].join("\n");
    expect(findBrowserGlobals(spanning)).toEqual([
      { rule: "browser-global", line: 2, detail: "document" },
    ]);
    expect(findBrowserGlobals(`${spanning}\nconst w = window;`)).toEqual([
      { rule: "browser-global", line: 2, detail: "document" },
      { rule: "browser-global", line: 4, detail: "window" },
    ]);
  });

  it("finds a defaulted parameter in each shape a function is bound to a name", () => {
    expect(findDefaultedParameters("export function seconds(days: number, hours = 0) {}")).toEqual([
      { name: "seconds", parameter: "hours", position: 1, line: 1 },
    ]);
    expect(findDefaultedParameters("const seconds = (days, hours = 0) => days;")).toEqual([
      { name: "seconds", parameter: "hours", position: 1, line: 1 },
    ]);
    expect(findDefaultedParameters("const seconds = async function (hours = 0) {};")).toEqual([
      { name: "seconds", parameter: "hours", position: 0, line: 1 },
    ]);
    expect(findDefaultedParameters("class Clock {\n  tick(step = 1): void {}\n}")).toEqual([
      { name: "tick", parameter: "step", position: 0, line: 2 },
    ]);
  });

  // The position is what a call has to reach past, so a comma the scanner reads wrongly is
  // a wrong answer rather than a missing one.
  it("counts the position past a generic annotation and a default of its own", () => {
    expect(
      findDefaultedParameters("function tally<T = string>(seen: Map<T, number>, total = 0) {}"),
    ).toEqual([{ name: "tally", parameter: "total", position: 1, line: 1 }]);
    expect(
      findDefaultedParameters("function build(spec: Spec, cost = { labor: 0 }, count = 1) {}"),
    ).toEqual([
      { name: "build", parameter: "cost", position: 1, line: 1 },
      { name: "build", parameter: "count", position: 2, line: 1 },
    ]);
  });

  // The parameter is what a call supplies. A field inside a destructured one is not: the
  // parameter itself is required, and no argument reaches the field on its own.
  it("leaves an optional parameter and a destructured field alone", () => {
    expect(findDefaultedParameters("function seeded(seed: number, observer?: Draw) {}")).toEqual(
      [],
    );
    expect(findDefaultedParameters("function start({ session, speed = 1 }: Options) {}")).toEqual(
      [],
    );
  });

  // The rule guesses at what a name in front of a parameter list is, so the shapes that only
  // look like one have to come back empty — a `for` head above all, which carries an `=` at
  // the exact depth a defaulted parameter does.
  it("reads no declaration out of a statement head or a call", () => {
    const loop = "for (let index = 0; index < 3; index += 1) run(index);";
    expect(findDefaultedParameters(loop)).toEqual([]);
    expect(findDefaultedParameters("if (ready = check()) {\n  return;\n}")).toEqual([]);
    expect(findDefaultedParameters("  recalcCpu(state = next);")).toEqual([]);
    expect(findDefaultedParameters("// function seconds(hours = 0) {}\nconst x = 1;")).toEqual([]);
  });

  it("counts the arguments at a call, and does not count the declaration as one", () => {
    const source = [
      "function seconds(days, hours = 0) {",
      "  return days;",
      "}",
      "const a = seconds(1);",
      "const b = seconds(1, 2);",
      "const c = clock.seconds(1, 2, 3);",
      "const d = seconds<number>(1, 2);",
      "const e = maybe?.seconds(1);",
    ].join("\n");

    expect(findCallArgumentCounts(source, "seconds")).toEqual([1, 2, 3, 2, 1]);
    expect(findCallArgumentCounts("const none = seconds();", "seconds")).toEqual([0]);
    expect(findCallArgumentCounts('const s = "seconds(1, 2)";', "seconds")).toEqual([]);
    expect(findCallArgumentCounts("import { seconds } from './clock.ts';", "seconds")).toEqual([]);
  });

  // A comma inside an argument is not a second argument, whichever bracket carries it.
  it("counts one argument that carries commas of its own", () => {
    expect(findCallArgumentCounts("build(spec, { labor: 0, size: 2 });", "build")).toEqual([2]);
    expect(findCallArgumentCounts("build(items.map((a, b) => a + b));", "build")).toEqual([1]);
    expect(findCallArgumentCounts("build(\n  spec,\n  cost,\n);", "build")).toEqual([2]);
    expect(findCallArgumentCounts("build(...parts);", "build")).toEqual([Number.POSITIVE_INFINITY]);
  });

  // The pass `findCallArgumentCounts` asks by name is the one the sweep reads whole: one
  // parse of a file answers for every name at once.
  it("reads every call in a source once, keyed by the name it is reached by", () => {
    const source = [
      "const a = seconds(1);",
      "const b = build(spec, cost);",
      "const c = clock.seconds(1, 2, 3);",
      "const d = new Clock();",
      "const e = table['seconds'](1, 2);",
    ].join("\n");

    expect(findCalls(source)).toEqual(
      new Map([
        ["seconds", [1, 3, 2]],
        ["build", [2]],
        ["Clock", [0]],
      ]),
    );
  });

  // The whole point of the pass: the sweep joins ~110 workspace files against every defaulted
  // parameter in `sim/src`, and asking file by file *per name* parsed the workspace once per
  // name. The number of names is free to grow; the number of parses is not.
  it("walks the call sites once for the whole sweep, whatever names it is asked about", () => {
    let walks = 0;
    const sources: Iterable<string> = {
      *[Symbol.iterator]() {
        walks += 1;
        yield "const a = seconds(1);\nconst b = build(spec, cost);";
        yield "const c = seconds(1, 2);";
      },
    };

    const calls = findCallsAcross(sources);

    expect(walks).toBe(1);
    expect(calls.get("seconds")).toEqual([1, 2]);
    expect(calls.get("build")).toEqual([2]);
    expect(calls.get("newItem")).toBeUndefined();
  });

  it("reports a default no call reaches, and stays quiet about one a call does", () => {
    const declared = [
      { name: "seconds", parameter: "hours", position: 1, line: 7 },
      { name: "build", parameter: "count", position: 1, line: 9 },
    ];
    const counts = (name: string): number[] => (name === "build" ? [1, 2] : [1, 1]);

    expect(findUnsuppliedDefaults(declared, counts)).toEqual([
      { rule: UNSUPPLIED_DEFAULT_RULE, line: 7, detail: "seconds(hours)" },
    ]);
    expect(findUnsuppliedDefaults(declared, () => [Number.POSITIVE_INFINITY])).toEqual([]);
    expect(findUnsuppliedDefaults(declared, () => [])).toEqual([
      { rule: UNSUPPLIED_DEFAULT_RULE, line: 7, detail: "seconds(hours)" },
      { rule: UNSUPPLIED_DEFAULT_RULE, line: 9, detail: "build(count)" },
    ]);
  });
});

// Shapes a text scan answers "nothing here" for, which is the one answer a boundary rule must
// never give wrongly. A `<` read as a bracket is the first: in `app/` it would make
// `<div title={y < a} onClick={f}>` report a handler on an `<a>`; that half is pinned in
// `app/test/operable.test.tsx`. Here the same `<` takes the shape below.
describe("what a parse sees that a text scan did not", () => {
  it("reads a comparison in an argument list as a comparison", () => {
    // The scanner counted `<` and `>` as nesting, so the comma between them was not a
    // top-level one and a two-argument call came back as one argument.
    expect(findCallArgumentCounts("build(a < b, c > d);", "build")).toEqual([2]);
    expect(findCallArgumentCounts("build(map as Map<string, number>, 2);", "build")).toEqual([2]);
    expect(findCallArgumentCounts("build<Spec>(spec, cost);", "build")).toEqual([2]);
  });

  // For a transcendental this rule is the whole of the enforcement. A member access is not
  // the only way to take one.
  it("catches a transcendental taken out of Math by destructuring", () => {
    expect(findRuntimeTranscendentals("const { exp, log } = Math;")).toEqual([
      { rule: "runtime-transcendental", line: 1, detail: "Math.exp" },
      { rule: "runtime-transcendental", line: 1, detail: "Math.log" },
    ]);
    expect(findRuntimeTranscendentals("const { floor, max } = Math;")).toEqual([]);
    expect(findRuntimeTranscendentals("const { exp } = ranges;")).toEqual([]);
  });

  // Counting brackets would read a class body and a namespace body as "inside something".
  // Both carry module state with a keyword in front of it.
  it("catches module state that a bracket count read as nested", () => {
    expect(findMutableModuleState("export class Cache {\n  static seen = new Map();\n}")).toEqual([
      { rule: "module-level-mutable-state", line: 2, detail: "new Map" },
    ]);
    expect(
      findMutableModuleState("export namespace tasks {\n  export let current = 0;\n}"),
    ).toEqual([{ rule: "module-level-mutable-state", line: 2, detail: "let" }]);

    // An instance field is one per object, and a fresh object per call is the shape the rule
    // exists to leave alone.
    expect(findMutableModuleState("export class Rng {\n  seen = new Map();\n}")).toEqual([]);
  });

  // A class bound to a name is the same class body with an `=` in front of it, and its
  // `static` field is the same one object for the lifetime of the module.
  it("catches module state on a class expression bound at module scope", () => {
    expect(findMutableModuleState("const Cache = class {\n  static seen = new Map();\n};")).toEqual(
      [{ rule: "module-level-mutable-state", line: 2, detail: "new Map" }],
    );
    expect(
      findMutableModuleState(
        "export namespace tasks {\n  const C = class {\n    static seen = new Set();\n  };\n}",
      ),
    ).toEqual([{ rule: "module-level-mutable-state", line: 3, detail: "new Set" }]);

    // A class made inside a function is one class per call, which is the same shape as an
    // instance field and is left alone for the same reason.
    const made = [
      "function make() {",
      "  return class {",
      "    static seen = new Map();",
      "  };",
      "}",
    ].join("\n");
    expect(findMutableModuleState(made)).toEqual([]);
  });

  // A binding is only the shape the class expression is easiest to spot in. The body runs
  // once whatever holds it, so its `static` field is the same one object for the lifetime of
  // the module however the expression got there.
  it("catches module state on a class expression no binding holds directly", () => {
    const wrapped = ["const Cache = wrap(class {", "  static seen = new Map();", "});"].join("\n");
    expect(findMutableModuleState(wrapped)).toEqual([
      { rule: "module-level-mutable-state", line: 2, detail: "new Map" },
    ]);

    const member = ["Registry.Cache = class {", "  static seen = new Map();", "};"].join("\n");
    expect(findMutableModuleState(member)).toEqual([
      { rule: "module-level-mutable-state", line: 2, detail: "new Map" },
    ]);

    // A class body inside another class body is evaluated when the outer class is made,
    // which at module scope is once.
    const nested = [
      "export class Registry {",
      "  static Cache = class {",
      "    static seen = new Map();",
      "  };",
      "}",
    ].join("\n");
    expect(findMutableModuleState(nested)).toEqual([
      { rule: "module-level-mutable-state", line: 3, detail: "new Map" },
    ]);

    // The other direction, which is what keeps the rule usable: a class made inside a
    // callable is still one class per call however deeply the expression sits, and neither
    // an argument nor a member assignment changes that.
    const perCall = [
      "function make() {",
      "  return wrap(class {",
      "    static seen = new Map();",
      "  });",
      "}",
      "const later = () => {",
      "  Registry.Cache = class {",
      "    static seen = new Set();",
      "  };",
      "};",
    ].join("\n");
    expect(findMutableModuleState(perCall)).toEqual([]);

    // A method body is a callable too, so a class made in one is per call as well.
    const inAMethod = [
      "export class Registry {",
      "  make() {",
      "    return class {",
      "      static seen = new Map();",
      "    };",
      "  }",
      "}",
    ].join("\n");
    expect(findMutableModuleState(inAMethod)).toEqual([]);
  });

  // The enumeration above is only as good as what reaches it: a shape the scanner did not
  // recognise left no violation *and* no entry, so the list that is meant to notice a rule
  // going quiet could not notice this.
  it("finds a defaulted parameter on a function bound to a property", () => {
    const source = [
      "export const clock = {",
      "  seconds: (days: number, hours = 0) => days,",
      "};",
    ].join("\n");

    expect(findDefaultedParameters(source)).toEqual([
      { name: "seconds", parameter: "hours", position: 1, line: 2 },
    ]);
  });

  // A constructor is a callable with a parameter list a call site supplies, and `new C(…)` is
  // the call, so a default on it is a violation or an entry like any other.
  it("finds a defaulted parameter on a constructor", () => {
    expect(
      findDefaultedParameters("export class Clock {\n  constructor(start: number, step = 1) {}\n}"),
    ).toEqual([{ name: "Clock", parameter: "step", position: 1, line: 2 }]);

    // The binding is the name `new` reaches the class by, the same way it is for a function
    // expression bound to one.
    expect(
      findDefaultedParameters("const Clock = class {\n  constructor(step = 1) {}\n};"),
    ).toEqual([{ name: "Clock", parameter: "step", position: 0, line: 2 }]);

    // No name, no call site to join it to: the rule reports nothing rather than a default it
    // cannot check.
    expect(
      findDefaultedParameters("export default class {\n  constructor(step = 1) {}\n}"),
    ).toEqual([]);
  });

  // A class expression may carry a name of its own, and that name reaches no further than its
  // own body: every call site outside writes the binding.
  it("names a class expression by the binding a call site reaches, not by its own name", () => {
    const named = "const Clock = class Timer {\n  constructor(step = 1) {}\n};";

    expect(findDefaultedParameters(named)).toEqual([
      { name: "Clock", parameter: "step", position: 0, line: 2 },
    ]);
    expect(
      findUnsuppliedDefaults(findDefaultedParameters(named), (name) =>
        findCallArgumentCounts("new Clock(5);", name),
      ),
    ).toEqual([]);

    // A class declaration is reached by its own name, which is the name it binds.
    expect(findDefaultedParameters("class Timer {\n  constructor(step = 1) {}\n}")).toEqual([
      { name: "Timer", parameter: "step", position: 0, line: 2 },
    ]);
  });

  // The property the text scan was chosen for, and the one the move had to keep: the rule
  // holds for anything that reaches `sim/src`, including a file that does not compile. The
  // parse is syntactic and recovers from an error rather than refusing the file.
  it("still reads a file that does not parse cleanly", () => {
    const broken = [
      "export function half(total: number): number {",
      "  return total * ;",
      "}",
      "const v = Math.exp(2);",
      "const w = window;",
    ].join("\n");

    expect(findRuntimeTranscendentals(broken)).toEqual([
      { rule: "runtime-transcendental", line: 4, detail: "Math.exp" },
    ]);
    expect(findBrowserGlobals(broken)).toEqual([
      { rule: "browser-global", line: 5, detail: "window" },
    ]);
  });
});

// A parse alone still reads the identifier at the site, so a global given a name of its own
// would go past both rules: `const M = Math; M.exp(2)` reaches the runtime's libm under a
// word no rule looks for, and for a transcendental that rule is the whole enforcement. The
// binding is followed back to what it was initialised from.
describe("a global reached under a name of its own", () => {
  it("follows an alias of Math to the transcendental taken through it", () => {
    expect(findRuntimeTranscendentals("const M = Math;\nconst value = M.exp(2);")).toEqual([
      { rule: "runtime-transcendental", line: 2, detail: "Math.exp" },
    ]);
    // Every way of taking a member holds through the alias, the same as through `Math`.
    expect(findRuntimeTranscendentals('const M = Math;\nconst value = M["exp"](2);')).toEqual([
      {
        rule: "runtime-transcendental",
        line: 2,
        detail: "Math[…] (computed access hides which member is used)",
      },
    ]);
    expect(findRuntimeTranscendentals("const M = Math;\nconst { log } = M;")).toEqual([
      { rule: "runtime-transcendental", line: 2, detail: "Math.log" },
    ]);
    // An alias of an alias is one more name for the same object.
    expect(
      findRuntimeTranscendentals("const M = Math;\nconst N = M;\nconst v = N.pow(a, b);"),
    ).toEqual([{ rule: "runtime-transcendental", line: 3, detail: "Math.pow" }]);
    // A local alias is reported too: the code that wrote it holds the object either way.
    expect(
      findRuntimeTranscendentals(
        "function decay(x: number) {\n  const M = Math;\n  return M.exp(x);\n}",
      ),
    ).toEqual([{ rule: "runtime-transcendental", line: 3, detail: "Math.exp" }]);
    // The ported members stay allowed under the alias, as they are under the name.
    expect(
      findRuntimeTranscendentals("const M = Math;\nconst v = M.floor(x) + M.max(a, b);"),
    ).toEqual([]);
  });

  it("follows an alias of a browser global to the use through it", () => {
    expect(findBrowserGlobals('const g = globalThis;\ng.document.title = "port";')).toEqual([
      { rule: "browser-global", line: 1, detail: "globalThis" },
      { rule: "browser-global", line: 2, detail: "g (alias of globalThis)" },
    ]);
    expect(findBrowserGlobals("const w = window;\nconst width = w.innerWidth;")).toEqual([
      { rule: "browser-global", line: 1, detail: "window" },
      { rule: "browser-global", line: 2, detail: "w (alias of window)" },
    ]);
  });

  // The rule reads a tree, not an execution, so which line came first is not
  // information it has any business using. A chain written the other way up is the same chain.
  it("follows a chain of aliases whichever order the declarations are written in", () => {
    const forwards = ["const M = Math;", "const N = M;", "const v = N.exp(1);"].join("\n");
    const backwards = ["const N = M;", "const M = Math;", "const v = N.exp(1);"].join("\n");

    expect(findRuntimeTranscendentals(forwards)).toEqual([
      { rule: "runtime-transcendental", line: 3, detail: "Math.exp" },
    ]);
    expect(findRuntimeTranscendentals(backwards)).toEqual([
      { rule: "runtime-transcendental", line: 3, detail: "Math.exp" },
    ]);

    expect(
      findBrowserGlobals(
        ["const w = g;", "const g = globalThis;", "w.document.title = 'p';"].join("\n"),
      ),
    ).toEqual([
      { rule: "browser-global", line: 1, detail: "g (alias of globalThis)" },
      { rule: "browser-global", line: 2, detail: "globalThis" },
      { rule: "browser-global", line: 3, detail: "w (alias of globalThis)" },
    ]);
  });

  // Following a chain in either direction is following it round, and a parse yields a tree for
  // source that could never run. The walk has to end on one anyway.
  it("terminates on a cycle of names rather than following it round", () => {
    expect(
      findRuntimeTranscendentals(
        ["const a = b;", "const b = a;", "const v = a.exp(1);"].join("\n"),
      ),
    ).toEqual([]);
    expect(findRuntimeTranscendentals("const M = M;\nconst v = M.exp(1);")).toEqual([]);
  });

  it("stays quiet on a name that holds something else", () => {
    expect(findRuntimeTranscendentals("const M = ranges;\nconst v = M.exp(2);")).toEqual([]);
    expect(findBrowserGlobals("const g = { document: 1 };\nconst title = g.title;")).toEqual([]);

    // A local binding of the same name holds something else, and the use inside the function
    // is a use of that one. Loud here would be the false positive that gets a rule switched
    // off; the next describe holds the other half, where the outer binding is the real alias
    // and a use of it is reported.
    const twice = [
      "const M = Math;",
      "export function safe(ranges: Ranges): number {",
      "  const M = ranges;",
      "  return M.exp(2);",
      "}",
    ].join("\n");
    expect(findRuntimeTranscendentals(twice)).toEqual([]);

    const shadowingParameter = [
      "const g = globalThis;",
      "export function render(g: Surface): void {",
      "  g.document.title = 'port';",
      "}",
    ].join("\n");
    expect(findBrowserGlobals(shadowingParameter)).toEqual([
      { rule: "browser-global", line: 1, detail: "globalThis" },
    ]);
  });
});

// Counting declarations over the whole file would drop a name bound twice rather than resolve
// it — the real alias with it. One `const M = ranges` inside one function would make every `M`
// in the file unreadable to the rule. A use is resolved against the scope chain at the use
// instead: the binding in scope answers for it, and a binding somewhere
// else does not.
describe("a name the file binds more than once", () => {
  it("resolves a use to the binding in scope at that use", () => {
    const twiceBound = [
      "const M = Math;",
      "export const decay = M.exp(1);",
      "export function safe(ranges: Ranges): number {",
      "  const M = ranges;",
      "  return M.exp(2);",
      "}",
    ].join("\n");

    expect(findRuntimeTranscendentals(twiceBound)).toEqual([
      { rule: "runtime-transcendental", line: 2, detail: "Math.exp" },
    ]);

    const shadowingParameter = [
      "const g = globalThis;",
      "export function render(g: Surface): void {",
      "  g.title = 'port';",
      "}",
      "export const held = g.opener;",
    ].join("\n");

    expect(findBrowserGlobals(shadowingParameter)).toEqual([
      { rule: "browser-global", line: 1, detail: "globalThis" },
      { rule: "browser-global", line: 5, detail: "g (alias of globalThis)" },
    ]);
  });

  it("resolves a use to the block it stands in, not to the function around it", () => {
    const nested = [
      "export function run(ranges: Ranges): void {",
      "  const M = Math;",
      "  {",
      "    const M = ranges;",
      "    M.exp(1);",
      "  }",
      "  M.exp(2);",
      "}",
    ].join("\n");

    expect(findRuntimeTranscendentals(nested)).toEqual([
      { rule: "runtime-transcendental", line: 7, detail: "Math.exp" },
    ]);
  });

  it("follows a chain from the scope each link was written in", () => {
    const reachingOut = [
      "const M = Math;",
      "export function decay(x: number): number {",
      "  const N = M;",
      "  return N.exp(x);",
      "}",
    ].join("\n");
    expect(findRuntimeTranscendentals(reachingOut)).toEqual([
      { rule: "runtime-transcendental", line: 4, detail: "Math.exp" },
    ]);

    // The same chain, with the link resolving to a local binding of the same name instead.
    const shadowedLink = [
      "const M = Math;",
      "export function safe(ranges: Ranges): number {",
      "  const M = ranges;",
      "  const N = M;",
      "  return N.exp(2);",
      "}",
    ].join("\n");
    expect(findRuntimeTranscendentals(shadowedLink)).toEqual([]);
  });
});

// A `let` can be rebound. At module scope `findMutableModuleState` forbids the `let` anyway, so
// what matters here is the local one. A binding assigned nowhere but its
// own initialiser holds what it was initialised from, whatever keyword bound it.
describe("a binding that could be rebound", () => {
  it("follows a local let that is assigned nowhere else", () => {
    expect(
      findRuntimeTranscendentals(
        [
          "export function decay(x: number): number {",
          "  let M = Math;",
          "  return M.exp(x);",
          "}",
        ].join("\n"),
      ),
    ).toEqual([{ rule: "runtime-transcendental", line: 3, detail: "Math.exp" }]);

    expect(
      findBrowserGlobals(
        [
          "export function width(): number {",
          "  let w = window;",
          "  return w.innerWidth;",
          "}",
        ].join("\n"),
      ),
    ).toEqual([
      { rule: "browser-global", line: 2, detail: "window" },
      { rule: "browser-global", line: 3, detail: "w (alias of window)" },
    ]);
  });

  it("stays quiet on a binding that is assigned somewhere else", () => {
    // What such a name holds at the use is a question about an execution, and the rule reads a
    // tree. A binding that is reassigned after it is bound is outside what a source rule can
    // see.
    expect(
      findRuntimeTranscendentals(
        [
          "export function decay(x: number, shim: Shim): number {",
          "  let M = Math;",
          "  M = shim;",
          "  return M.exp(x);",
          "}",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

// The scope pass records a parameter on whatever node holds it, so every shape that holds one
// has to be a scope the walk visits. The first pass at it asked `isCallable`, which answers a
// narrower question — the shapes a call site reaches by name — and so left the accessor and the
// signature positions out: their parameters were recorded on nodes nothing looked at, did not
// shadow, and a use of one resolved outwards to whatever the file bound under that word. That
// is the false positive the rule cannot afford, because it makes a legal file fail the gate.
describe("a parameter of a shape that is not a plain function", () => {
  it("shadows inside a setter, the way it does inside a method", () => {
    // `Math.floor` is allowed and the setter's `M` is its own parameter, so the file is legal.
    const shadowingSetter = [
      "const M = Math;",
      "export const ok = M.floor(1);",
      "export class C { set held(M: Shim) { this.v = M.exp(1); } }",
    ].join("\n");
    expect(findRuntimeTranscendentals(shadowingSetter)).toEqual([]);

    const shadowingMethod = [
      "const M = Math;",
      "export const ok = M.floor(1);",
      "export class C { held(M: Shim): void { this.v = M.exp(1); } }",
    ].join("\n");
    expect(findRuntimeTranscendentals(shadowingMethod)).toEqual([]);
  });

  it("shadows in a signature position, which has no body to report from", () => {
    // Each of these binds `w` in the signature and nowhere else. Line 1 is the real alias and
    // stays reported; a second line would be the signature's own parameter read as that alias.
    const alias = { rule: "browser-global", line: 1, detail: "window" };
    for (const signature of [
      "export interface S { held(w: number): void }",
      "export interface S { [w: string]: number }",
      "export interface S { new (w: number): S }",
      "type S = new (w: number) => void;",
      "type F = (w: number) => void;",
    ]) {
      expect(findBrowserGlobals(`const w = window;\n${signature}`)).toEqual([alias]);
    }
  });

  it("holds a var of its own, so an accessor is a var boundary too", () => {
    // `var` reaches the nearest function-like node. An accessor is one, so this `M` is the
    // accessor's and the module-level alias is still the alias — the reason `callableAround`
    // asks the same question `opensScope` asks rather than carrying a list of its own.
    const varInAccessor = [
      "const M = Math;",
      "export class C { get held(): number { var M = 1; return M + 1; } }",
      "export const decay = M.exp(1);",
    ].join("\n");
    expect(findRuntimeTranscendentals(varInAccessor)).toEqual([
      { rule: "runtime-transcendental", line: 3, detail: "Math.exp" },
    ]);
  });

  it("holds a var of its own inside a class static block", () => {
    // A static initialisation block is a `var` scope in the language. Its body is a `ts.Block`,
    // so a `let` shadows there anyway, but a `var` could reach past it to module scope and bind
    // `M` a second time. A scope that binds one name twice drops it back to holding nothing, so
    // the module-level alias would go unreadable and the rule would fall silent.
    const varInStaticBlock = [
      "const M = Math;",
      "export class C { static { var M = 1; void M; } }",
      "export const decay = M.exp(1);",
    ].join("\n");
    expect(findRuntimeTranscendentals(varInStaticBlock)).toEqual([
      { rule: "runtime-transcendental", line: 3, detail: "Math.exp" },
    ]);

    // The block is the boundary, so the alias outside it is untouched and the `M` inside it is
    // the block's own — reaching for `Math.exp` through that one is legal.
    const shadowedInStaticBlock = [
      "const M = Math;",
      "export const ok = M.floor(1);",
      "export class C { static { var M = Shim; M.exp(1); } }",
    ].join("\n");
    expect(findRuntimeTranscendentals(shadowedInStaticBlock)).toEqual([]);
  });
});

// `require("…")` is part of the enumeration in `findImportSpecifiers`, so both import rules
// see a file that reaches for `app/` through it. The workspace is ESM, so CommonJS cannot run here — but the enumeration *is* the rule, and a form left out
// of it because nothing can reach it reads exactly like a form somebody forgot. The parse
// answers for a file that does not compile, which is where the distinction stops being
// academic. These are the edges of the form.
describe("an import written as a bare require call", () => {
  const outward = (): string => "../app/src/legacy.ts";
  const stay = (specifier: string): string => specifier.replace(/^(?:\.\/|\.\.\/)+/, "");

  it("reaches both import rules, as a value import", () => {
    const source = 'const legacy = require("../../app/src/legacy.ts");';

    expect(findImportSpecifiers(source)).toEqual([
      { specifier: "../../app/src/legacy.ts", line: 1, typeOnly: false },
    ]);
    expect(findCrossSeamImports(source, outward)).toEqual([
      { rule: "cross-seam-import", line: 1, detail: "../../app/src/legacy.ts" },
    ]);
    expect(findForbiddenImports(source, outward)).toEqual([
      { rule: "escaping-import", line: 1, detail: "../../app/src/legacy.ts" },
    ]);

    // The call is the import wherever it stands, not only as a `const` initialiser.
    expect(
      findImportSpecifiers('require("./side-effect.ts");').map((one) => one.specifier),
    ).toEqual(["./side-effect.ts"]);
    expect(findForbiddenImports('const fs = require("node:fs");', stay)).toEqual([
      { rule: "foreign-import", line: 1, detail: "node:fs" },
    ]);
  });

  it("stays quiet on a call that is not the module loader", () => {
    // A member of something else spells the word without being it.
    expect(findImportSpecifiers('const x = loader.require("./x.ts");')).toEqual([]);

    // Only a literal names a path, the same as for `import("…")`.
    expect(findImportSpecifiers("const x = require(chosen);")).toEqual([]);

    // And a name the file binds itself is that binding. The domain has words of its own —
    // a prerequisite is something a technology *requires* — and a rule that argues with the
    // vocabulary is a rule people turn off.
    const own = [
      "function require(tech: string): boolean {",
      "  return held.includes(tech);",
      "}",
      'const ready = require("Impossibility Theorem");',
    ].join("\n");
    expect(findImportSpecifiers(own)).toEqual([]);
    expect(findForbiddenImports(own, stay)).toEqual([]);
  });

  // The vocabulary is answered per call site, not per file, for the same reason as in the
  // alias pass: one parameter named `require`, anywhere, would otherwise take both import
  // rules off every real loader call beside it.
  it("takes a call in a scope the binding of the word does not reach", () => {
    const elsewhere = [
      "function prerequisites(require: readonly string[]): number {",
      "  return require.length;",
      "}",
      'const legacy = require("../../app/src/legacy.ts");',
    ].join("\n");

    expect(findImportSpecifiers(elsewhere)).toEqual([
      { specifier: "../../app/src/legacy.ts", line: 4, typeOnly: false },
    ]);
    expect(findCrossSeamImports(elsewhere, outward)).toEqual([
      { rule: "cross-seam-import", line: 4, detail: "../../app/src/legacy.ts" },
    ]);

    // And the other direction, which is the half the whole-file count got right: inside that
    // scope the callee resolves to the binding, so the call is the domain's word and not a
    // loader call.
    const inside = [
      "function prerequisites(require: (tech: string) => boolean): boolean {",
      '  return require("../../app/src/legacy.ts");',
      "}",
    ].join("\n");

    expect(findImportSpecifiers(inside)).toEqual([]);
    expect(findCrossSeamImports(inside, outward)).toEqual([]);

    // A block binding shadows for the block it is in and no further, the same way.
    const block = [
      "{",
      "  const require = (tech: string): boolean => held.includes(tech);",
      '  void require("Impossibility Theorem");',
      "}",
      'const legacy = require("../../app/src/legacy.ts");',
    ].join("\n");

    expect(findImportSpecifiers(block).map((one) => one.line)).toEqual([5]);
  });
});
