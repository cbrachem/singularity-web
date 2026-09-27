// boundary-intent harness: the boundary rules, read off a parsed tree rather than off text
/**
 * The boundary rules for `sim/`, as pure functions over a parsed source file.
 *
 * `sim/` may not touch a browser API and may not use a transcendental from the runtime. The
 * package layout already stops `sim/` from importing `app/`; these rules cover what a package boundary cannot see — a global reached
 * through `globalThis`, a `Math.exp`, a relative path climbing out of the package, module
 * state between two Ticks, and a parameter transcribed from upstream that nothing calls for.
 *
 * # Why this parses instead of scanning
 *
 * A hand-written text scanner can lose its place, find nothing, and report success on exactly
 * what it exists to forbid. A rule that fails silent is worse than no rule, and for `Math.exp`
 * this is the only enforcement. So the rules stay at the test seam and read a tree instead of
 * characters, and `tools/parity/runtime-parity.test.ts` reads them under both runtimes and
 * requires the two readings to be the same.
 *
 * `ts.createSourceFile` is a **syntactic** parse. It recovers from errors and yields a tree
 * for a file that does not typecheck, or does not compile at all, so the rule still holds for
 * anything that reaches `sim/src`.
 *
 * A parse alone still reads the identifier at the site, which left a global reachable under a
 * name of its own — `const M = Math`. `aliasesOf` closes that: a binding initialised from a
 * forbidden name stands for it, and the use is reported. It resolves each use against the
 * scope chain at the use, so one function binding the same word to something else does not
 * take the rule off the real alias. What no source rule can see is
 * what is left after that: a member reached through a computed name, a value that arrives at
 * run time, and a binding that is reassigned after it is bound.
 */

import ts from "typescript";

export interface Violation {
  readonly rule: string;
  readonly line: number;
  readonly detail: string;
}

/**
 * Identifiers that only a browser provides, or that reach the ambient global object where
 * one could be smuggled in. Deliberately free of words the game itself uses — location,
 * event, screen, history — so the rule never argues with the domain vocabulary.
 */
export const BROWSER_GLOBALS: readonly string[] = [
  "alert",
  "cancelAnimationFrame",
  "confirm",
  "crypto",
  "customElements",
  "document",
  "DOMParser",
  "fetch",
  "getComputedStyle",
  "globalThis",
  "HTMLElement",
  "indexedDB",
  "IntersectionObserver",
  "localStorage",
  "matchMedia",
  "MutationObserver",
  "navigator",
  "performance",
  "requestAnimationFrame",
  "requestIdleCallback",
  "ResizeObserver",
  "sessionStorage",
  "window",
  "XMLHttpRequest",
];

/**
 * `Math` members whose result is the runtime's own libm. The port measured the divergence
 * and ported the one the Simulation needs; taking another from the runtime would put the
 * engine back into the fidelity argument.
 */
export const RUNTIME_TRANSCENDENTALS: readonly string[] = [
  "acos",
  "acosh",
  "asin",
  "asinh",
  "atan",
  "atan2",
  "atanh",
  "cbrt",
  "cos",
  "cosh",
  "exp",
  "expm1",
  "hypot",
  "log",
  "log10",
  "log1p",
  "log2",
  "pow",
  "sin",
  "sinh",
  "tan",
  "tanh",
];

/** Bare module specifiers `sim/src` may import. Widening this list is a decision. */
export const ALLOWED_BARE_IMPORTS: readonly string[] = [];

/**
 * Paths outside the package `sim/src` may reach, as POSIX paths relative to the package
 * root. Widening this list is a decision too.
 *
 * `content/` is the Converter's output and nothing else, and the loader that reads it lives
 * in `sim/` because resolution is rules rather than data. So the one thing that legitimately crosses this boundary is committed data,
 * in one direction, with no code in it — which is why the allowance names a suffix as well
 * as a prefix. Anything else outside the package, `app/` above all, stays forbidden.
 */
export const ALLOWED_ESCAPING_IMPORTS: readonly { prefix: string; suffix: string }[] = [
  { prefix: "../content/", suffix: ".json" },
];

/**
 * The tree each source was read into, so a source is parsed once however many rules read it.
 *
 * Every rule takes source text and parses it itself, which is the signature the runtime
 * comparison feeds by hand and is worth keeping. The sweep, though, asks ten
 * readings of the same file: `boundary.test.ts` runs rule by rule over `sim/src`, so one file
 * is read once per rule, and the workspace call-site join reads every TypeScript file in the
 * workspace on top of that. Measured in this repository by counting calls and misses in `parse`,
 * one run of `check:boundary` calls it **698** times over **385** distinct sources — the 181
 * workspace files plus the corpus strings the test feeds the rules by hand. Holding the tree
 * takes the run from 698 parses to 385: ~150 ms of parsing instead of ~290 ms, and the gate's
 * test time from a median 1.32 s to 1.17 s over five alternating pairs.
 *
 * What it costs is retained heap, not peak memory. After a forced GC at the end of the run the
 * worker holds 103 MB with the cache against 25 MB without, so the map is ~78 MB of trees held
 * for the life of the process. Peak resident set moves the other way — a median 353 MB with the
 * cache against 392 MB without, because 385 retained trees cost less than churning 698
 * short-lived ones. The retained half is what makes this a sweep-only trick: it is affordable
 * because the process is a test worker Vitest isolates per file, and nothing longer-lived should
 * hold an unbounded map of trees. A bound would not help — the sweep passes over every file once
 * per rule, so anything smaller than the whole workspace never gets a hit.
 *
 * Keying on the text is what makes it safe: the same text is the same tree, whichever file it
 * came from and whichever rule asks. No rule writes to a node, so one tree answers all of them.
 */
const parsed = new Map<string, ts.SourceFile>();

/**
 * Every file is parsed as TSX, whatever it is named.
 *
 * The rules run over `sim/` and over every call site in the workspace, `app/`'s `.tsx`
 * included, and they are handed source text without a path. TSX is the reading that accepts
 * both: it costs the `<T>value` type assertion, which this workspace writes as `value as T`
 * throughout, and it keeps JSX from being parsed as a chain of comparisons, which would hide
 * a `<div onClick=…>` from the rule in `app/`.
 */
function parse(source: string): ts.SourceFile {
  const held = parsed.get(source);
  if (held !== undefined) return held;
  const file = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  parsed.set(source, file);
  return file;
}

function lineOf(file: ts.SourceFile, position: number): number {
  return file.getLineAndCharacterOfPosition(position).line + 1;
}

function lineOfNode(file: ts.SourceFile, node: ts.Node): number {
  return lineOf(file, node.getStart(file));
}

/**
 * Whether a node is JSDoc — the doc comment TypeScript hangs off the declaration below it.
 *
 * A doc comment is prose, so prose may name `window` or `document` freely. The parse hands
 * doc comments back as tree nodes, and an identifier in a parsed tag position — `@param
 * window`, a JSDoc type — then reads as a reference. This repository writes long doc comments everywhere and
 * `BROWSER_GLOBALS` holds ordinary words, so the walk steps over the whole JSDoc subtree.
 * Nothing there can reach a global, an import or a call at run time.
 *
 * The kind range rather than `ts.isJSDoc` because it also covers a tag or a JSDoc type
 * arriving on its own, without the enclosing comment node.
 */
function isJSDocNode(node: ts.Node): boolean {
  return node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
}

/** Every node in the tree, in source order, JSDoc apart. */
function* walk(node: ts.Node): Generator<ts.Node> {
  yield node;
  for (const child of node.getChildren()) {
    if (isJSDocNode(child)) continue;
    yield* walk(child);
  }
}

function byLine<T extends { readonly line: number }>(found: readonly T[]): T[] {
  return [...found].sort((a, b) => a.line - b.line);
}

/**
 * Whether an identifier *refers* to what it names, rather than naming a member, a key or an
 * imported binding. `place.document`, `{ document: 1 }` and `import { window } from "…"` all
 * spell a browser global without reaching for one; a shorthand property — `{ document }` —
 * does reach for it and is not excluded here.
 */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined) return true;
  if (ts.isPropertyAccessExpression(parent)) return parent.name !== node;
  if (ts.isQualifiedName(parent)) return parent.right !== node;
  if (
    ts.isPropertyAssignment(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent) ||
    ts.isEnumMember(parent)
  ) {
    return parent.name !== node;
  }
  if (ts.isBindingElement(parent)) return parent.propertyName !== node;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  if (ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isJsxAttribute(parent)) return parent.name !== node;
  if (ts.isLabeledStatement(parent)) return parent.label !== node;
  if (ts.isBreakOrContinueStatement(parent)) return parent.label !== node;
  return true;
}

/** Every name a binding pattern introduces, `{ a, b: [c] }` flattened to `a`, `c`. */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : [],
  );
}

/** One binding, and the name it was initialised from when it can stand for that name. */
interface Binding {
  readonly holds: ts.Identifier | undefined;
}

/** The names each scope of the file binds, by the node that opens the scope. */
type Scopes = Map<ts.Node, Map<string, Binding>>;

/**
 * Whether a node opens a scope — somewhere a name can be bound and shadow the same name
 * outside it.
 *
 * The list is the rule, the same way the enumeration in `findImportSpecifiers` is: a form left
 * out is a scope whose bindings are read as the enclosing scope's, which is the misreading
 * this pass exists to end. A callable holds its parameters, its body block holds the rest, and
 * both are walked through on the way out.
 *
 * The parameter-holding half of that list is `ts.isFunctionLike` rather than a list written out
 * here, because a list short by one shape is a wrong answer and not a missing one.
 * `isCallable` names only the five shapes a call site reaches by name, and so leaves out a
 * get/set accessor and every signature node. `scopesOf` records a parameter on its parent
 * whatever that parent is, so a parameter of a shape missing here would be recorded on a node
 * this walk never visits: `set held(M: Shim)` would not shadow, and `M.exp` inside the setter
 * would resolve outwards to a module-level `const M = Math` in a file that is legal. `ts.isFunctionLike` is the compiler's own answer to "does this node carry
 * parameters", so it cannot fall behind the grammar.
 */
function opensScope(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isClassLike(node) ||
    ts.isFunctionLike(node)
  );
}

/** The nearest scope around a node, `file` when the walk runs out of parents. */
function scopeAround(node: ts.Node, file: ts.SourceFile): ts.Node {
  let held = node.parent as ts.Node | undefined;
  while (held !== undefined && !opensScope(held)) held = held.parent as ts.Node | undefined;
  return held ?? file;
}

/**
 * The nearest scope a `var` reaches — the enclosing function-like node, a class static
 * initialisation block, or the file.
 *
 * This asks `ts.isFunctionLike` too, deliberately the same question `opensScope` asks and not a
 * second list beside it. An accessor is a `var` boundary as much as a method is — `get held() {
 * var M = 1; }` binds that `M` in the accessor, not at module scope — and the shapes
 * `ts.isFunctionLike` adds beyond that are type positions with no body, which no `var` can
 * stand inside, so naming them costs nothing here.
 *
 * A static block is the one `var` boundary that answer misses: the language makes it a `var`
 * scope, and `ts.isFunctionLike` says no to it because it carries no parameters. Left out,
 * `static { var M = 1; }` would bind `M` at module scope a second time, and a scope that binds
 * one name twice drops it back to holding nothing — so an alias the file really did declare
 * would become unreadable and the rule would go quiet on what it forbids. The stop returns the block's
 * body rather than the block itself, because that body is what `opensScope` already recognises
 * and so is where a lookup walking outwards will look; widening `opensScope` for the block as
 * well would add a second scope node behind a scope that is already there.
 *
 * `isCallable` is the enumeration that does *not* answer this. It answers a third question —
 * whether a call site can reach a declaration by name — for `findDefaultedParameters`, and
 * widening it to cover the shapes above would say those shapes are joined to call sites when
 * `callableName` has no name for any of them.
 */
function callableAround(node: ts.Node, file: ts.SourceFile): ts.Node {
  let held = node.parent as ts.Node | undefined;
  while (held !== undefined && !ts.isSourceFile(held) && !ts.isFunctionLike(held)) {
    if (ts.isClassStaticBlockDeclaration(held)) return held.body;
    held = held.parent as ts.Node | undefined;
  }
  return held ?? file;
}

/** Whether a variable declaration is bound by the block around it rather than by a function. */
function isBlockScoped(declaration: ts.VariableDeclaration): boolean {
  const list = declaration.parent as ts.Node | undefined;
  // `catch (error)` binds in the clause; anything not in a declaration list is that shape.
  if (list === undefined || !ts.isVariableDeclarationList(list)) return true;
  return (list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) !== 0;
}

/** The name an initialiser is a plain copy of, past a parenthesis or an `as`. */
function copiedName(declaration: ts.VariableDeclaration): ts.Identifier | undefined {
  if (declaration.initializer === undefined || !ts.isIdentifier(declaration.name)) return undefined;
  const value = unwrap(declaration.initializer);
  return ts.isIdentifier(value) ? value : undefined;
}

/** Every name an assignment writes to, `[a, { b }] = …` flattened to `a`, `b`. */
function assignedNames(target: ts.Expression): ts.Identifier[] {
  const value = unwrap(target);
  if (ts.isIdentifier(value)) return [value];
  if (ts.isSpreadElement(value)) return assignedNames(value.expression);
  if (ts.isArrayLiteralExpression(value)) return value.elements.flatMap(assignedNames);
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) return [property.name];
      if (ts.isPropertyAssignment(property)) return assignedNames(property.initializer);
      if (ts.isSpreadAssignment(property)) return assignedNames(property.expression);
      return [];
    });
  }
  // A member of something else — `held.member = …` writes through the name, not over it.
  return [];
}

/** Whether a binary operator writes to its left side — `=` and every compounded form of it. */
function isAssignment(operator: ts.SyntaxKind): boolean {
  return operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;
}

/** Every identifier this node writes to, as an assignment, an increment or a `for … of` head. */
function writesTo(node: ts.Node): ts.Identifier[] {
  if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) {
    return assignedNames(node.left);
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return assignedNames(node.operand);
  }
  if (
    (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
    !ts.isVariableDeclarationList(node.initializer)
  ) {
    return assignedNames(node.initializer);
  }
  return [];
}

/**
 * Every scope of the file, with the names it binds and what each name was initialised from.
 *
 * A name is dropped back to holding nothing in two cases, both of them "the tree does not
 * say": a scope that binds one name twice — which a parse recovers from and neither reading is
 * safe to prefer — and a binding something assigns to after it is bound, whose value at the use
 * is a question about an execution rather than about a tree.
 *
 * `bind` is not called `declare`, and the name is load-bearing rather than a preference. Bun's
 * transpiler reads `declare` at the head of a statement as the ambient modifier and **removes
 * the statement**, so every one of these calls would disappear under `bun run` while Vitest,
 * which transpiles with esbuild, keeps them. The rules are read by
 * `tools/parity/runtime-readings.ts`, which is a `bun run` script, so this whole pass would
 * return an empty map there. `bun run check:runtime-parity` reads these rules under both
 * runtimes over the same inputs and requires the same answer. It is at the tooling seam,
 * because a reading under a second runtime is not one of the three product seams.
 */
function scopesOf(file: ts.SourceFile): Scopes {
  const scopes: Scopes = new Map();
  const written: ts.Identifier[] = [];

  const bind = (scope: ts.Node, name: string, holds: ts.Identifier | undefined): void => {
    const bound = scopes.get(scope) ?? new Map<string, Binding>();
    bound.set(name, { holds: bound.has(name) ? undefined : holds });
    scopes.set(scope, bound);
  };

  for (const node of walk(file)) {
    written.push(...writesTo(node));

    if (ts.isVariableDeclaration(node)) {
      const scope = isBlockScoped(node) ? scopeAround(node, file) : callableAround(node, file);
      const holds = copiedName(node);
      for (const name of bindingNames(node.name)) bind(scope, name, holds);
    } else if (ts.isParameter(node)) {
      for (const name of bindingNames(node.name)) bind(node.parent, name, undefined);
    } else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (node.name !== undefined) bind(scopeAround(node, file), node.name.text, undefined);
    } else if (ts.isFunctionExpression(node) || ts.isClassExpression(node)) {
      // A named function expression carries its name into its own body and nowhere else.
      if (node.name !== undefined) bind(node, node.name.text, undefined);
    } else if (
      ts.isImportClause(node) ||
      ts.isNamespaceImport(node) ||
      ts.isImportSpecifier(node) ||
      ts.isImportEqualsDeclaration(node)
    ) {
      if (node.name !== undefined) bind(file, node.name.text, undefined);
    }
  }

  for (const target of written) {
    const scope = scopeBinding(scopes, target, file);
    if (scope !== undefined) {
      (scopes.get(scope) as Map<string, Binding>).set(target.text, { holds: undefined });
    }
  }

  return scopes;
}

/** The scope that binds the name an identifier spells, seen from where the identifier stands. */
function scopeBinding(
  scopes: Scopes,
  node: ts.Identifier,
  file: ts.SourceFile,
): ts.Node | undefined {
  let scope: ts.Node = scopeAround(node, file);
  for (;;) {
    if (scopes.get(scope)?.has(node.text) === true) return scope;
    if (ts.isSourceFile(scope)) return undefined;
    scope = scopeAround(scope, file);
  }
}

/** The target an identifier stands for, or `undefined` when it stands for something else. */
type Alias = (node: ts.Identifier) => string | undefined;

/**
 * Resolves each use to the declaration in scope at that use, and reports the target the chain
 * of declarations ends on.
 *
 * This is the hole a parse alone leaves open. Both rules read the identifier at the site, and
 * an identifier says nothing about what it was bound to, so `const M = Math` would hand the
 * port every transcendental under a word no rule looked for — and for a transcendental this is
 * the only enforcement, which makes "says nothing" the answer that costs the most.
 *
 * Which binding a use means is a question only scope answers, and a false positive is what
 * gets a rule switched off. Counting declarations over the whole file would leave the rule
 * quiet on the real alias as soon as one function bound the same word to something else. A
 * scope chain answers the question instead: a use resolves to the nearest scope that binds its name, a chain link
 * resolves from where the link is written, and a name nothing binds is free — which is the only
 * place a target can be reached.
 *
 * Which keyword bound a name does not decide anything here. What decides it is whether
 * something writes to the binding afterwards (`scopesOf`), so a `let` nothing reassigns is
 * followed and a reassigned `const` in source that does not compile is not.
 *
 * The chain is followed from the use outwards rather than as the walk meets each declaration,
 * because the rule reads a tree rather than an execution and so has no business caring which
 * line came first. Following a chain from either end can follow it round, so each
 * walk stops on an identifier it has already passed.
 */
function aliasesOf(file: ts.SourceFile, targets: readonly string[]): Alias {
  const scopes = scopesOf(file);

  return (node: ts.Identifier): string | undefined => {
    const passed = new Set<ts.Identifier>();
    let held: ts.Identifier | undefined = node;
    while (held !== undefined && !passed.has(held)) {
      passed.add(held);
      const scope = scopeBinding(scopes, held, file);
      if (scope === undefined) return targets.includes(held.text) ? held.text : undefined;
      held = (scopes.get(scope) as Map<string, Binding>).get(held.text)?.holds;
    }
    return undefined;
  };
}

/** Whether an identifier is the name a declaration binds, rather than a use of it. */
function isDeclaredName(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node | undefined;
  return parent !== undefined && ts.isVariableDeclaration(parent) && parent.name === node;
}

export function findBrowserGlobals(source: string): Violation[] {
  const file = parse(source);
  const aliases = aliasesOf(file, BROWSER_GLOBALS);
  const found: Violation[] = [];

  for (const node of walk(file)) {
    if (!ts.isIdentifier(node)) continue;
    if (!isReference(node)) continue;
    if (BROWSER_GLOBALS.includes(node.text)) {
      found.push({ rule: "browser-global", line: lineOfNode(file, node), detail: node.text });
      continue;
    }
    const aliased = aliases(node);
    // The declaration is reported by its own initialiser, so only a use is added here.
    if (aliased === undefined || isDeclaredName(node)) continue;
    found.push({
      rule: "browser-global",
      line: lineOfNode(file, node),
      detail: `${node.text} (alias of ${aliased})`,
    });
  }

  return byLine(found);
}

const TRANSCENDENTAL_RULE = "runtime-transcendental";
const COMPUTED_MATH = "Math[…] (computed access hides which member is used)";

/**
 * Whether an expression names `Math` — spelled bare, reached through an object, or held by a
 * binding that was initialised from it.
 *
 * The bare word is taken whatever the file binds it to. A file that shadows `Math` is a file
 * that has renamed the thing the only enforcement looks for, and loud there costs a
 * spelling nobody in this workspace uses.
 */
function namesMath(expression: ts.Expression, aliases: Alias): boolean {
  if (ts.isIdentifier(expression))
    return expression.text === "Math" || aliases(expression) === "Math";
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === "Math";
  return false;
}

export function findRuntimeTranscendentals(source: string): Violation[] {
  const file = parse(source);
  const aliases = aliasesOf(file, ["Math"]);
  const found: Violation[] = [];

  const take = (node: ts.Node, name: string): void => {
    if (!RUNTIME_TRANSCENDENTALS.includes(name)) return;
    found.push({ rule: TRANSCENDENTAL_RULE, line: lineOfNode(file, node), detail: `Math.${name}` });
  };

  for (const node of walk(file)) {
    if (ts.isPropertyAccessExpression(node) && namesMath(node.expression, aliases)) {
      take(node, node.name.text);
      continue;
    }
    if (ts.isElementAccessExpression(node) && namesMath(node.expression, aliases)) {
      found.push({
        rule: TRANSCENDENTAL_RULE,
        line: lineOfNode(file, node),
        detail: COMPUTED_MATH,
      });
      continue;
    }
    // `const { exp } = Math` reaches the same function under a name of its own, which the
    // text rule could not see at all — a member access is not the only way to take one.
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      namesMath(node.initializer, aliases) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      for (const element of node.name.elements) {
        const property = element.propertyName ?? element.name;
        if (ts.isIdentifier(property)) take(element, property.text);
        else if (ts.isComputedPropertyName(property)) {
          found.push({
            rule: TRANSCENDENTAL_RULE,
            line: lineOfNode(file, element),
            detail: COMPUTED_MATH,
          });
        }
      }
    }
  }

  return byLine(found);
}

export interface FoundImport {
  readonly specifier: string;
  readonly line: number;
  /** True for `import type`/`export type`, which erase and can drive nothing. */
  readonly typeOnly: boolean;
}

/**
 * Every specifier the file names, in every form the language spells one.
 *
 * The forms are enumerated rather than pattern-matched, and the enumeration is the thing to
 * keep whole: a form left out is a rule that goes quiet on it. That includes `import("…")` in
 * **type position** — `typeof import("…")`, `let x: import("…").T`. `boundary.test.ts` pins
 * the roster.
 *
 * A bare `require("…")` is in the roster too. The workspace is ESM, so nothing
 * here can run one — but the enumeration is the rule, and a form left out because nothing
 * reaches it reads the same as a form somebody forgot. It is taken only where the callee is
 * free: the word is domain vocabulary as much as loader vocabulary — a prerequisite is
 * something a technology *requires* — and a rule that argues with the vocabulary is a rule
 * people switch off.
 *
 * Free is asked of the scope chain at the call site, not of the file, for the same reason as in
 * the alias pass: counting declarations over the whole file would let one parameter or one
 * local named `require`, anywhere in the file, take both import rules off every real loader
 * call in it.
 */
export function findImportSpecifiers(source: string): FoundImport[] {
  const file = parse(source);
  const found: FoundImport[] = [];
  const required: { callee: ts.Identifier; argument: ts.Expression }[] = [];

  const take = (literal: ts.Expression | undefined, typeOnly: boolean): void => {
    if (literal === undefined || !ts.isStringLiteralLike(literal)) return;
    found.push({ specifier: literal.text, line: lineOfNode(file, literal), typeOnly });
  };

  for (const node of walk(file)) {
    if (ts.isImportDeclaration(node)) {
      take(node.moduleSpecifier, node.importClause?.isTypeOnly === true);
    } else if (ts.isExportDeclaration(node)) {
      take(node.moduleSpecifier, node.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        take(node.moduleReference.expression, node.isTypeOnly);
      }
    } else if (ts.isImportTypeNode(node)) {
      // `import("…")` in type position. Its argument is a literal type, so the string sits
      // one node further down than everywhere else. It is type-only whatever it names:
      // the whole node erases, so it can drive nothing — which is what `typeOnly` means to
      // the one rule that reads it, and is why the escaping and cross-seam rules, which
      // ignore `typeOnly`, still hold for it.
      if (ts.isLiteralTypeNode(node.argument)) take(node.argument.literal, true);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      take(node.arguments[0], false);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      // `import x = require("…")` is not one of these: it parses as an external module
      // reference, and the branch above it takes that form.
      const argument = node.arguments[0];
      if (argument !== undefined) required.push({ callee: node.expression, argument });
    }
  }

  if (required.length > 0) {
    const scopes = scopesOf(file);
    for (const { callee, argument } of required) {
      if (scopeBinding(scopes, callee, file) === undefined) take(argument, false);
    }
  }

  return byLine(found);
}

/** The package on the other side of the seam, however an import spells it. */
const APP_PACKAGE = "@singularity/app";

/**
 * The seam itself, as the one rule that holds for everything in `sim/` — a test as much as a
 * source. `findForbiddenImports` is stricter and is right to be, for a module that ships:
 * nothing outside the package at all. A harness legitimately reaches for the platform, the
 * runner and its fixtures, and the one thing it still may not reach for is `app/`.
 */
export function findCrossSeamImports(
  source: string,
  resolveRelative: (specifier: string) => string,
): Violation[] {
  return findImportSpecifiers(source).flatMap(({ specifier, line }) => {
    const reached = specifier.startsWith(".") ? resolveRelative(specifier) : specifier;
    const crosses =
      reached === APP_PACKAGE ||
      reached.startsWith(`${APP_PACKAGE}/`) ||
      reached === "../app" ||
      reached.startsWith("../app/");
    return crosses ? [{ rule: "cross-seam-import", line, detail: specifier }] : [];
  });
}

/**
 * What a file under `sim/test` is for, written where the rule reads it:
 *
 *     // boundary-intent simulation: <reason>
 *
 * `simulation` is shared code that runs the Simulation and produces what a comparison binds;
 * `harness` arranges, reads, spawns or asserts. The rules act on the declaration, so a file
 * without one is a violation rather than a quiet exclusion — which is what deciding by
 * directory was. Like an exemption, it carries a reason and it is enumerable: `boundary.test.ts`
 * asserts the whole roster of `simulation` files.
 *
 * `findRuntimeTranscendentals` is the one rule `boundary.test.ts` runs over both intents. A
 * harness legitimately binds `window` as a local and legitimately memoises a trace for a file
 * that runs once, so those two rules read the declaration; a transcendental in a harness is an
 * expectation taken from the runtime's libm, which compares the thing under test against
 * itself.
 */
export const TEST_INTENTS: readonly string[] = ["simulation", "harness"];

export const INTENT_MARKER = /^\s*(?:\/\/|\*|\/\*\*?)\s*boundary-intent\s+([a-z-]+):\s*(\S.*?)\s*$/;

export interface IntentDeclaration {
  readonly intent: string;
  readonly line: number;
  readonly reason: string;
}

/**
 * A marker is a comment, and a comment is text — so this and `EXEMPTION_MARKER` still read
 * lines. The failure the parser was brought in for is a rule that loses its place *in code*;
 * a marker cannot be misattributed, because a line either opens with a comment or does not.
 */
export function findIntents(source: string): IntentDeclaration[] {
  return source.split("\n").flatMap((text, index) => {
    const match = INTENT_MARKER.exec(text);
    if (!match) return [];
    return [{ intent: match[1] as string, line: index + 1, reason: match[2] as string }];
  });
}

/**
 * `resolveRelative` turns a relative specifier into a POSIX path relative to the package
 * root, so the caller can see whether it climbed out. Passed in rather than imported so
 * this module stays a pure pass over what it is handed.
 */
export function findForbiddenImports(
  source: string,
  resolveRelative: (specifier: string) => string,
): Violation[] {
  return findImportSpecifiers(source).flatMap(({ specifier, line }) => {
    if (specifier.startsWith(".")) {
      const resolved = resolveRelative(specifier);
      if (resolved.startsWith("../") || resolved === "..") {
        // The caller normalises, so `../content/../app/x.ts` arrives as `../app/x.ts` and
        // cannot pass by spelling itself through the allowed directory.
        const allowed = ALLOWED_ESCAPING_IMPORTS.some(
          ({ prefix, suffix }) => resolved.startsWith(prefix) && resolved.endsWith(suffix),
        );
        if (allowed) return [];
        return [{ rule: "escaping-import", line, detail: specifier }];
      }
      return [];
    }
    if (ALLOWED_BARE_IMPORTS.includes(specifier)) return [];
    return [{ rule: "foreign-import", line, detail: specifier }];
  });
}

/**
 * Constructors whose result is a mutable object. A `const` bound to one of these at module
 * scope is module state: the binding cannot be swapped out, but what it names can be written
 * to, so it carries information from one call into the next exactly as a `let` would.
 *
 * The list is of constructors, not of every mutable thing: a value returned by a *call* —
 * the Content graph, built once by `loadContent` and read by every rule — is out
 * of reach of a syntactic rule and is the deliberate case the rule is not aimed at. What the
 * rule catches is the scratch buffer and the cache, which is the shape the failure takes.
 */
export const MUTABLE_CONSTRUCTORS: readonly string[] = [
  "Array",
  "ArrayBuffer",
  "BigInt64Array",
  "BigUint64Array",
  "DataView",
  "Float32Array",
  "Float64Array",
  "Int16Array",
  "Int32Array",
  "Int8Array",
  "Map",
  "Set",
  "SharedArrayBuffer",
  "Uint16Array",
  "Uint32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "WeakMap",
  "WeakSet",
];

export const MODULE_STATE_RULE = "module-level-mutable-state";

/**
 * An exemption, written where the rule can see it:
 *
 *     // boundary-exemption module-level-mutable-state: <reason>
 *
 * on one of the comment lines directly above the declaration. It is not a way of turning the
 * rule off: the site stays *enumerable* — `findExemptions` returns every one of them with its
 * reason, and `boundary.test.ts` asserts the whole list, so a second exemption is an edit to
 * a test rather than a comment nobody reads. A marker that exempts nothing is itself a
 * violation, so they cannot survive the code they were written for.
 */
export const EXEMPTION_MARKER =
  /^\s*(?:\/\/|\*|\/\*\*?)\s*boundary-exemption\s+([a-z-]+):\s*(\S.*?)\s*$/;

export interface Exemption {
  readonly rule: string;
  /** The line the declaration is on, not the line the marker is on. */
  readonly line: number;
  readonly detail: string;
  readonly reason: string;
}

interface Marker {
  readonly rule: string;
  readonly reason: string;
  readonly line: number;
}

/** The comment lines directly above `line` (1-based), nearest first. */
function commentLinesAbove(lines: readonly string[], line: number): number[] {
  const above: number[] = [];
  for (let index = line - 2; index >= 0; index -= 1) {
    const text = (lines[index] as string).trim();
    if (text === "") break;
    if (!text.startsWith("//") && !text.startsWith("*") && !text.startsWith("/*")) break;
    above.push(index);
  }
  return above;
}

function markersIn(lines: readonly string[]): Marker[] {
  return lines.flatMap((text, index) => {
    const match = EXEMPTION_MARKER.exec(text);
    return match ? [{ rule: match[1] as string, reason: match[2] as string, line: index + 1 }] : [];
  });
}

/** A parenthesis, an `as`, a `satisfies` or a `!` — a node written around a value. */
function isWrapper(
  node: ts.Node,
): node is
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.SatisfiesExpression
  | ts.NonNullExpression
  | ts.TypeAssertion {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  );
}

/** Past a parenthesis, an `as`, a `satisfies` or a `!` to the expression underneath. */
function unwrap(expression: ts.Expression): ts.Expression {
  return isWrapper(expression) ? unwrap(expression.expression) : expression;
}

/** The mutable constructor an initialiser is bound to directly, if it is bound to one. */
function mutableConstruction(initializer: ts.Expression | undefined): ts.NewExpression | undefined {
  if (initializer === undefined) return undefined;
  const value = unwrap(initializer);
  if (!ts.isNewExpression(value)) return undefined;
  const callee = unwrap(value.expression);
  if (!ts.isIdentifier(callee) || !MUTABLE_CONSTRUCTORS.includes(callee.text)) return undefined;
  return value;
}

function constructorName(construction: ts.NewExpression): string {
  return `new ${(unwrap(construction.expression) as ts.Identifier).text}`;
}

/**
 * Every class expression under this node that is evaluated when the module is loaded.
 *
 * A binding is only the shape a class expression is easiest to spot in. The same body can be
 * held by anything — `wrap(class {…})`, `Registry.Cache = class {…}`, a `static` field of
 * another class. The body runs once whatever holds it, so a `static` field on it is the same
 * one object for the lifetime of the module, which is module state between two Ticks.
 *
 * The walk stops at anything function-like, which is the other half of the rule and the half
 * that keeps it usable: a class made inside a callable is one class per call, the same shape
 * as an instance field, and is left alone for the same reason. A method body is a callable
 * too, so the same stop answers for a class made in one.
 */
function classesEvaluatedAtLoad(node: ts.Node): ts.ClassExpression[] {
  const found: ts.ClassExpression[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isFunctionLike(current)) return;
    if (ts.isClassExpression(current)) found.push(current);
    current.forEachChild(visit);
  };
  visit(node);
  return found;
}

interface Candidate {
  readonly line: number;
  readonly detail: string;
}

/**
 * Module state, and the exemptions written against it, from one pass over the parsed file.
 *
 * This is the rule that keeps the seam's promise: a Tick is reproducible from its input
 * alone, and isolating a test means constructing a value rather than resetting globals.
 * Upstream is built the other way round — `g.pl`, `g.map_screen`, `random`'s process
 * generator and `task.current_task_cache` are all module state the rules write to — so the
 * failure mode is not hypothetical, it is the thing being ported away from.
 *
 * Three shapes are forbidden at module scope. A **reassignable binding**, `let` or `var`,
 * which is the obvious one. A **`const` bound to a mutable constructor** — `new DataView(…)`,
 * `new Map()` — which is the one that reads as a constant and is not: `const` freezes the
 * binding, never the object, so a scratch buffer or a cache declared this way is module state
 * under a name that says it is not. And a **`static` field** bound to one of those, which is
 * the same object with a class in front of it, in a class body or a namespace body. A class
 * **expression** bound to a name carries that field just as a declaration does.
 *
 * What stays allowed is a `const` whose value cannot be written to usefully: a literal, a
 * frozen one, a primitive. The port's own types are `readonly` throughout, and the Content
 * graph is the deliberate case, fixed when the build is made and read by every rule.
 */
export function scanModuleState(source: string): {
  violations: Violation[];
  exemptions: Exemption[];
} {
  const file = parse(source);
  const lines = source.split("\n");
  const markers = markersIn(lines);
  const used = new Set<number>();
  const violations: Violation[] = [];
  const exemptions: Exemption[] = [];

  const exemptionFor = (line: number): number | undefined => {
    for (const index of commentLinesAbove(lines, line)) {
      const at = markers.findIndex((marker) => marker.line === index + 1);
      if (at !== -1 && (markers[at] as Marker).rule === MODULE_STATE_RULE) return at;
    }
    return undefined;
  };

  const record = ({ line, detail }: Candidate): void => {
    const exemptedBy = exemptionFor(line);
    if (exemptedBy === undefined) {
      violations.push({ rule: MODULE_STATE_RULE, line, detail });
      return;
    }
    used.add(exemptedBy);
    exemptions.push({
      rule: MODULE_STATE_RULE,
      line,
      detail,
      reason: (markers[exemptedBy] as Marker).reason,
    });
  };

  const recordStaticState = (declaration: ts.ClassLikeDeclaration): void => {
    for (const member of declaration.members) {
      if (!ts.isPropertyDeclaration(member)) continue;
      const isStatic = member.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
      );
      if (isStatic !== true) continue;
      const construction = mutableConstruction(member.initializer);
      if (construction === undefined) continue;
      record({
        line: lineOfNode(file, construction),
        detail: constructorName(construction),
      });
    }
  };

  // A class body at module scope with an `=` in front of it, wherever the expression sits.
  // What the walk stops at is what keeps this off a class made
  // per call; `classesEvaluatedAtLoad` carries that half.
  const recordClassesAtLoad = (node: ts.Node | undefined): void => {
    if (node === undefined) return;
    for (const made of classesEvaluatedAtLoad(node)) recordStaticState(made);
  };

  const visitStatements = (statements: readonly ts.Statement[]): void => {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        const list = statement.declarationList;
        if ((list.flags & ts.NodeFlags.Const) === 0) {
          const keyword = (list.flags & ts.NodeFlags.Let) === 0 ? "var" : "let";
          record({ line: lineOfNode(file, list), detail: keyword });
          continue;
        }
        for (const declaration of list.declarations) {
          recordClassesAtLoad(declaration.initializer);
          const construction = mutableConstruction(declaration.initializer);
          if (construction === undefined) continue;
          record({
            line: lineOfNode(file, construction),
            detail: constructorName(construction),
          });
        }
        continue;
      }
      if (ts.isClassDeclaration(statement)) {
        recordStaticState(statement);
        recordClassesAtLoad(statement);
        continue;
      }
      if (ts.isModuleDeclaration(statement) && statement.body !== undefined) {
        const body = statement.body;
        if (ts.isModuleBlock(body)) visitStatements(body.statements);
        continue;
      }
      // Anything else a module runs: `Registry.Cache = class {…}` is a class body at module
      // scope that no binding holds, and an expression statement is where it stands.
      recordClassesAtLoad(statement);
    }
  };

  visitStatements(file.statements);

  for (const [index, marker] of markers.entries()) {
    if (marker.rule !== MODULE_STATE_RULE || used.has(index)) continue;
    violations.push({
      rule: "unused-exemption",
      line: marker.line,
      detail: `${marker.rule}: nothing on the declaration below it is a violation`,
    });
  }

  return { violations: byLine(violations), exemptions: byLine(exemptions) };
}

/** Every module-state violation, exempt sites removed and dangling exemptions added. */
export function findMutableModuleState(source: string): Violation[] {
  return scanModuleState(source).violations;
}

/** Every exempt site, with the reason written beside it. */
export function findExemptions(source: string): Exemption[] {
  return scanModuleState(source).exemptions;
}

export const UNSUPPLIED_DEFAULT_RULE = "unsupplied-default";

/** A parameter with a default value, and where it sits in its function's parameter list. */
export interface DefaultedParameter {
  /** The function's name, which is how a call site is recognised. */
  readonly name: string;
  readonly parameter: string;
  /** 0-based: a call supplies this parameter by passing more than `position` arguments. */
  readonly position: number;
  readonly line: number;
}

/**
 * The name a call site would use to reach this function, or `undefined` for one that has no
 * such name — an anonymous callback, a function assigned to a member expression. A parameter
 * of one of those cannot be joined to a call site by name, so the rule leaves it alone rather
 * than reporting a default it cannot check.
 */
function callableName(node: ts.SignatureDeclaration): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    const name = node.name;
    return name !== undefined && ts.isIdentifier(name) ? name.text : undefined;
  }
  // A constructor is reached by `new C(…)`, so the class's name is the call site's name.
  // `findCallArgumentCounts` counts a `new` as a call for exactly this.
  if (ts.isConstructorDeclaration(node)) return classCallName(node.parent);
  if (!ts.isFunctionExpression(node) && !ts.isArrowFunction(node)) return undefined;
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined) return undefined;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) {
    return ts.isIdentifier(parent.name) ? parent.name.text : undefined;
  }
  if (ts.isPropertyAssignment(parent)) {
    return ts.isIdentifier(parent.name) ? parent.name.text : undefined;
  }
  // A named function expression carries its own name, which its body can call.
  if (ts.isFunctionExpression(node) && node.name !== undefined) return node.name.text;
  return undefined;
}

/**
 * The name `new` would reach a class by: the binding a class expression is assigned to, or
 * the class's own. An anonymous class no name holds — `export default class {…}` — has none,
 * and a default on its constructor is left alone for the same reason an anonymous callback's
 * is.
 *
 * The binding comes first, and only a class *expression* has one. A class expression may
 * carry a name of its own, and the language gives that name to its own body and to nowhere
 * else: `const Clock = class Timer {…}` is reached by `new Clock(…)` everywhere a call site
 * can stand. Preferring the inner name would join the declaration to a call site that cannot
 * exist, so `new Clock(5)` would match nothing and a parameter the workspace does supply
 * would be reported as unsupplied. A class *declaration* binds its own name, so for one
 * of those the two answers are the same name.
 */
function classCallName(declaration: ts.ClassLikeDeclaration): string | undefined {
  if (ts.isClassExpression(declaration)) {
    const bound = boundName(declaration);
    if (bound !== undefined) return bound;
  }
  return declaration.name?.text;
}

/** The name a value expression is bound to, past a parenthesis or an `as` written around it. */
function boundName(expression: ts.Expression): string | undefined {
  let held = expression.parent as ts.Node | undefined;
  while (held !== undefined && isWrapper(held)) held = held.parent as ts.Node | undefined;
  if (held === undefined || !ts.isVariableDeclaration(held) || !ts.isIdentifier(held.name)) {
    return undefined;
  }
  return held.name.text;
}

/**
 * The five shapes a call site can reach by a name, which is what `findDefaultedParameters`
 * needs and all it needs. It is narrower than `ts.isFunctionLike` on purpose: an accessor and
 * every signature-position node carry parameters, so the scope pass counts them
 * (`opensScope`), but `callableName` has no name for any of them and a call does not supply
 * their parameters. Keeping the two questions apart is what stops the scope fix from silently
 * enrolling those shapes in the defaulted-parameter rule.
 */
function isCallable(node: ts.Node): node is ts.SignatureDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

/**
 * Every parameter in `source` that carries a default value, with the name a call site would
 * reach its function by.
 *
 * A destructured parameter whose *fields* have defaults — `{ speed = 1 }` — is not one: the
 * parameter itself is required, and the call cannot supply the field separately. Neither is
 * a type parameter's default, `<T = string>`, which a call does not supply either and which
 * the text rule had to be taught to walk over by hand.
 *
 * `isCallable` above is the enumeration this rests on, and a shape left out of it leaves no
 * violation *and* no entry — which is the failure the enumeration exists to make visible. A
 * constructor is one such shape: `new C(…)` supplies its parameters, so the class's name is
 * the name a call site is recognised by.
 */
export function findDefaultedParameters(source: string): DefaultedParameter[] {
  const file = parse(source);
  const found: DefaultedParameter[] = [];

  for (const node of walk(file)) {
    if (!isCallable(node)) continue;
    const name = callableName(node);
    if (name === undefined) continue;
    node.parameters.forEach((parameter, position) => {
      if (parameter.initializer === undefined) return;
      found.push({
        name,
        parameter: parameter.name.getText(file),
        position,
        line: lineOfNode(file, parameter),
      });
    });
  }

  return found;
}

/**
 * The name a call site reaches its callee by, or `undefined` for one no name reaches — a
 * call of a call, an expression computed at run time. It is the same name
 * `findDefaultedParameters` records for the declaration, which is what joins the two.
 */
function calleeName(callee: ts.Expression): string | undefined {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return callee.argumentExpression.text;
  }
  return undefined;
}

/**
 * Every call in `source`, by the name it is reached by, each carrying how many arguments it
 * passes — one parse, all names.
 *
 * A member call counts: `estate.quality(a, b)` is a call of `quality`, and the rule would
 * rather credit a same-named method on another object than report a parameter that is in
 * fact supplied. A spread argument counts as supplying everything after it, for the same
 * reason — the rule is here to catch a parameter nothing ever passes, not to be clever.
 *
 * Reading the whole file at once is what keeps the sweep affordable. The join
 * it feeds is workspace-wide, so asking a file for one name at a time parsed every file
 * again for every declared parameter, and the number of declared parameters is free to grow.
 */
export function findCalls(source: string): ReadonlyMap<string, number[]> {
  const file = parse(source);
  const calls = new Map<string, number[]>();

  for (const node of walk(file)) {
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) continue;
    const name = calleeName(unwrap(node.expression));
    if (name === undefined) continue;

    const args = node.arguments ?? [];
    const count = args.some((argument) => ts.isSpreadElement(argument))
      ? Number.POSITIVE_INFINITY
      : args.length;
    const found = calls.get(name);
    if (found === undefined) calls.set(name, [count]);
    else found.push(count);
  }

  return calls;
}

/**
 * The same reading over many sources, merged: every call in any of them, by name.
 *
 * `sources` is walked exactly once, whatever the caller goes on to ask about, which is the
 * whole difference between this and a lookup that re-reads its inputs per name.
 */
export function findCallsAcross(sources: Iterable<string>): ReadonlyMap<string, number[]> {
  const calls = new Map<string, number[]>();

  for (const source of sources) {
    for (const [name, counts] of findCalls(source)) {
      const found = calls.get(name);
      if (found === undefined) calls.set(name, [...counts]);
      else found.push(...counts);
    }
  }

  return calls;
}

/** How many arguments each call of `name` in `source` passes. One name out of `findCalls`. */
export function findCallArgumentCounts(source: string, name: string): number[] {
  return [...(findCalls(source).get(name) ?? [])];
}

/**
 * The defaulted parameters no call site supplies.
 *
 * A default that nothing passes is not a choice the port has offered anyone — it is the
 * signature of the function upstream, transcribed one field too far. The port has already
 * made the decision the parameter exists to defer, and the parameter is what is left over.
 * Written as a rule rather than caught at review because that is when it is cheap: the next
 * one arrives with the next module carried across.
 */
export function findUnsuppliedDefaults(
  declared: readonly DefaultedParameter[],
  argumentCounts: (name: string) => readonly number[],
): Violation[] {
  return declared
    .filter((parameter) => !argumentCounts(parameter.name).some((n) => n > parameter.position))
    .map((parameter) => ({
      rule: UNSUPPLIED_DEFAULT_RULE,
      line: parameter.line,
      detail: `${parameter.name}(${parameter.parameter})`,
    }));
}
