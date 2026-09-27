// boundary-intent harness: the inputs the boundary rules are read over, and how they are read
/**
 * The inputs the boundary rules are read over: a corpus per rule.
 *
 * The rules in `sim/test/support/source-rules.ts` are read twice — by Vitest in
 * `sim/test/boundary.test.ts`, and by `bun run` in `tools/parity/runtime-parity.test.ts`,
 * which requires the two readings to be identical. This module is what both are
 * fed, so a case added here is covered by both.
 *
 * A corpus entry is fed to *every* rule, so a case written for one rule also checks that the
 * others stay silent on it. The corpus exists because a comparison of two empty readings
 * agrees however wrong both sides are: an enumeration that goes quiet has to change a
 * reading, and only a positive case makes it do that.
 */

import * as current from "../../sim/test/support/source-rules.ts";

type Rules = typeof current;

export interface Case {
  readonly label: string;
  readonly source: string;
  readonly resolveRelative: (specifier: string) => string;
}

/**
 * A corpus per rule: the shape each rule exists to catch, the shape it must leave alone, and
 * the readings that put the rules on a parse. Every entry is fed to every rule, so a case
 * written for one rule also tests that the others stay silent on it.
 */
const CORPUS: readonly { readonly label: string; readonly source: string }[] = [
  { label: "browser-global/plain", source: "const w = window.innerWidth;\nconst d = document;" },
  { label: "browser-global/ambient", source: "const g = globalThis;\nconst c = crypto;" },
  { label: "browser-global/member", source: "const p = place.document;\nconst o = { window: 1 };" },
  { label: "browser-global/shorthand", source: "const bag = { document };" },
  { label: "browser-global/in-a-string", source: 'const note = "window";\n// document here' },
  {
    label: "browser-global/domain-vocabulary",
    source: "const location = { id: 'N AMERICA' };\nconst screen = { name: 'map' };",
  },
  { label: "transcendental/member", source: "const v = Math.exp(x) + Math.log(y);" },
  { label: "transcendental/computed", source: 'const v = Math["exp"](x);' },
  { label: "transcendental/destructured", source: "const { exp, log: ln } = Math;" },
  { label: "transcendental/ported", source: "const v = exp(x);\nconst m = Math.floor(y);" },
  { label: "import/side-effect", source: 'import "./side-effect.ts";' },
  { label: "import/default-and-named", source: 'import def, { named } from "../app/src/x.ts";' },
  { label: "import/re-export", source: 'export { thing } from "./re-export.ts";' },
  { label: "import/star", source: 'export * from "../app/src/star.ts";' },
  { label: "import/dynamic", source: 'const later = await import("../app/src/dynamic.ts");' },
  { label: "import/equals", source: 'import legacy = require("../app/src/legacy.ts");' },
  { label: "import/require-call", source: 'const legacy = require("../app/src/legacy.ts");' },
  {
    label: "import/require-bound-here",
    source: 'function require(tech) {\n  return tech;\n}\nconst r = require("../app/src/x.ts");',
  },
  {
    label: "import/require-bound-elsewhere",
    source:
      'function prerequisites(require) {\n  return require.length;\n}\nconst r = require("../app/src/x.ts");',
  },
  { label: "import/type-only", source: 'import type { Speed } from "../app/src/speed.ts";' },
  { label: "import/type-position", source: 'type A = typeof import("../app/src/App.tsx");' },
  { label: "import/type-member", source: 'let x: import("../app/src/App.tsx").App;' },
  { label: "import/type-parameter", source: 'function f(a: import("../app/src/App.tsx").App) {}' },
  { label: "import/content-json", source: 'import data from "../content/events.json";' },
  { label: "import/bare", source: 'import { readFileSync } from "node:fs";' },
  { label: "import/commented-out", source: '// import "../app/src/x.ts";' },
  {
    label: "import/in-a-doc-comment",
    source: '/** @see import("../app/src/x.ts") */\nconst a = 1;',
  },
  { label: "import/in-a-string", source: "const s = 'import x from \"../app/src/x.ts\"';" },
  { label: "module-state/let", source: "let cache = 0;" },
  { label: "module-state/var", source: "var counter = 0;" },
  { label: "module-state/const-map", source: "const cache = new Map();" },
  { label: "module-state/const-frozen", source: "const table = Object.freeze({ a: 1 });" },
  { label: "module-state/inside-a-function", source: "function f() { let n = 0; return n; }" },
  { label: "module-state/class-static", source: "class Holder { static cache = new Map(); }" },
  { label: "module-state/namespace", source: "namespace N { export const cache = new Map(); }" },
  {
    label: "module-state/class-expression",
    source: "const Holder = class { static cache = new Map(); };",
  },
  {
    label: "module-state/class-expression-wrapped",
    source: "const Holder = wrap(class { static cache = new Map(); });",
  },
  {
    label: "module-state/class-expression-on-a-member",
    source: "Registry.Holder = class { static cache = new Map(); };",
  },
  {
    label: "module-state/class-expression-per-call",
    source: "function make() { return wrap(class { static cache = new Map(); }); }",
  },
  {
    label: "module-state/exempted",
    source: "// boundary-exemption module-level-mutable-state: a reason\nconst cache = new Map();",
  },
  {
    label: "module-state/exemption-exempting-nothing",
    source: "// boundary-exemption module-level-mutable-state: a reason\nconst table = { a: 1 };",
  },
  {
    label: "intent/simulation",
    source: "// boundary-intent simulation: a Scenario in, a Trace out",
  },
  { label: "intent/harness", source: " * boundary-intent harness: spawns the reference" },
  { label: "defaults/function", source: "function build(kind, count = 1) { return count; }" },
  { label: "defaults/arrow", source: "const build = (kind, count = 1) => count;" },
  { label: "defaults/method", source: "class C { build(kind, count = 1) { return count; } }" },
  {
    label: "defaults/property",
    source: "const api = { build(kind, count = 1) { return count; } };",
  },
  {
    label: "defaults/constructor",
    source: "class C { constructor(kind, count = 1) { this.count = count; } }",
  },
  {
    label: "defaults/named-class-expression",
    source: "const C = class Inner { constructor(kind, count = 1) { this.count = count; } };",
  },
  {
    label: "defaults/destructured-field",
    source: "function build({ count = 1 }) { return count; }",
  },
  {
    label: "defaults/type-parameter",
    source: "function build<T = string>(value: T) { return value; }",
  },
  {
    label: "defaults/generic-annotation",
    source: "function build(a: Map<string, number>, b = 1) {}",
  },
  {
    label: "defaults/object-property",
    source: "const api = { build: function (kind, count = 1) { return count; } };",
  },
  { label: "calls/plain", source: "build('a');\nbuild('a', 2);" },
  { label: "calls/member", source: "estate.build('a', 2);" },
  { label: "calls/spread", source: "build(...args);" },
  { label: "calls/declaration-head", source: "function build(kind, count) { return count; }" },
  {
    label: "calls/signature",
    source: "interface Api { build(kind: string, count: number): void }",
  },
  { label: "calls/new", source: "new Build('a', 2);" },
  {
    label: "misread/regex-with-a-quote",
    source: "const re = /[\\'`]/;\nconst w = window.innerWidth;",
  },
  { label: "misread/regex-after-a-paren", source: "if (a) /x/.test(b);\nconst v = Math.exp(1);" },
  { label: "misread/jsx-attribute-with-a-less-than", source: "const n = <div title={a < b} />;" },
  { label: "misread/comparison-in-an-argument-list", source: "call(a < b, c > d, e);" },
  {
    label: "misread/template-substitution",
    source: "const s = `${document.title} ${window.name}`;",
  },
  { label: "misread/unterminated-string", source: "const s = 'oops;\nconst w = window;" },
  { label: "misread/does-not-compile", source: "const x = ;\nconst w = window.innerWidth;" },
  {
    label: "jsdoc/tag-names-a-global",
    source: "/**\n * @param window the surface\n */\nconst a = 1;",
  },
  { label: "jsdoc/type-names-a-global", source: "/** @type {typeof document} */\nconst a = 1;" },
  { label: "jsdoc/link-names-a-transcendental", source: "/** {@link Math.exp} */\nconst a = 1;" },
];

/**
 * A second corpus, for the one reading that is not a pass over a single file.
 *
 * The workspace answers the joined `unsupplied-default` question with nothing from either
 * implementation, so comparing them over it compares empty against empty and would go on
 * agreeing however wrong one of them became. These two files are written to disagree, in
 * exactly the direction the register argues about: `sim/src` declares a default, and the
 * only place the name appears again is a method signature. The scan counts that signature
 * as a two-argument call and reads the default as supplied; the parse counts no call and
 * reports the violation.
 */
const JOINED_CORPUS: readonly { readonly label: string; readonly source: string }[] = [
  {
    label: "sim/src/joined-default.ts",
    source: "export function buildJoined(kind: string, count = 1): number {\n  return count;\n}\n",
  },
  {
    label: "sim/test/joined-signature.test.ts",
    source: "interface JoinedApi {\n  buildJoined(kind: string, count: number): number;\n}\n",
  },
];

const stayPut = (specifier: string): string => specifier.replace(/^\.\//, "");

export function joinedCorpusCases(): Case[] {
  return JOINED_CORPUS.map(({ label, source }) => ({ label, source, resolveRelative: stayPut }));
}

export function corpusCases(): Case[] {
  return CORPUS.map(({ label, source }) => ({
    label: `corpus:${label}`,
    source,
    resolveRelative: stayPut,
  }));
}

type Reading = (rules: Rules, one: Case) => string[];

export const readings: readonly { readonly rule: string; readonly read: Reading }[] = [
  {
    rule: "findBrowserGlobals",
    read: (rules, one) =>
      rules.findBrowserGlobals(one.source).map((v) => `${v.line} ${v.rule} ${v.detail}`),
  },
  {
    rule: "findRuntimeTranscendentals",
    read: (rules, one) =>
      rules.findRuntimeTranscendentals(one.source).map((v) => `${v.line} ${v.rule} ${v.detail}`),
  },
  {
    rule: "findImportSpecifiers",
    read: (rules, one) =>
      rules
        .findImportSpecifiers(one.source)
        .map((f) => `${f.line} ${f.specifier} typeOnly=${String(f.typeOnly)}`),
  },
  {
    rule: "findCrossSeamImports",
    read: (rules, one) =>
      rules
        .findCrossSeamImports(one.source, one.resolveRelative)
        .map((v) => `${v.line} ${v.rule} ${v.detail}`),
  },
  {
    rule: "findForbiddenImports",
    read: (rules, one) =>
      rules
        .findForbiddenImports(one.source, one.resolveRelative)
        .map((v) => `${v.line} ${v.rule} ${v.detail}`),
  },
  {
    rule: "findMutableModuleState",
    read: (rules, one) =>
      rules.findMutableModuleState(one.source).map((v) => `${v.line} ${v.rule} ${v.detail}`),
  },
  {
    rule: "findExemptions",
    read: (rules, one) =>
      rules.findExemptions(one.source).map((e) => `${e.line} ${e.rule} ${e.detail} ${e.reason}`),
  },
  {
    rule: "findIntents",
    read: (rules, one) =>
      rules.findIntents(one.source).map((i) => `${i.line} ${i.intent} ${i.reason}`),
  },
  {
    rule: "findDefaultedParameters",
    read: (rules, one) =>
      rules
        .findDefaultedParameters(one.source)
        .map((p) => `${p.line} ${p.name}(${p.parameter}) at ${p.position}`)
        .sort(),
  },
];

/** Every name a call count could be asked for, so both runtimes are asked the same question. */
export function calleeNames(rules: Rules, one: Case): string[] {
  const names = new Set<string>();
  for (const parameter of rules.findDefaultedParameters(one.source)) names.add(parameter.name);
  for (const name of ["build", "advance", "loadContent"]) names.add(name);
  return [...names].sort();
}

/**
 * The one rule that is not a pass over a single file: a defaulted parameter in `sim/src` is
 * a violation only if *no* call site anywhere in the workspace supplies it, so declarations
 * from one file are joined to counts from every file. `boundary.test.ts` reads it exactly
 * this way, and it is the reading a phantom call site would quietly satisfy — so the two
 * runtimes are compared on the joined answer, not only on the halves.
 */
export function joinedUnsuppliedDefaults(rules: Rules, cases: readonly Case[]): string[] {
  const sources = cases.map((one) => one.source);
  const counts = (name: string): number[] =>
    sources.flatMap((source) => rules.findCallArgumentCounts(source, name));
  return cases
    .filter((one) => one.label.startsWith("sim/src/"))
    .flatMap((one) =>
      rules
        .findUnsuppliedDefaults(rules.findDefaultedParameters(one.source), counts)
        .map((v) => `${one.label}:${v.line} ${v.rule} ${v.detail}`),
    )
    .sort();
}
