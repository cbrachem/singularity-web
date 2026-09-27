import ts from "typescript";

/**
 * The half of the rule a rendered DOM cannot see: **never a `<div>` with a click handler**.
 *
 * `accessible-names.ts` sweeps what is on the page, and a `<div onClick=…>` is invisible to
 * it — the div is not an operable element, so it is never asked for a name, and the driver
 * that has to click it has nothing to say. Preact attaches the handler with
 * `addEventListener`, so no attribute survives into the DOM either. The only place the shape
 * is visible is the source.
 *
 * # Why this one parses instead of scanning
 *
 * The rule's whole question is *which element is this handler written on*, and that is a
 * question about a construct rather than about the characters near it. A scanner has to
 * guess: walking back to the nearest `<` reads `<div title={y < a} onClick={f}>` as a
 * handler on an `<a>`, which is operable, so the rule falls silent on exactly the shape it
 * exists to forbid. `sim/`'s boundary rules learned the same lesson the same
 * way and now parse too (`sim/test/support/source-rules.ts`) — a text rule that
 * misreads its input reports success.
 *
 * Parsing is not a type-aware pass. `ts.createSourceFile` recovers from errors and yields a
 * tree for a file that does not typecheck, or does not compile at all, so the rule still
 * holds for anything that reaches `app/src`. What it cannot see is a handler arriving inside
 * a spread — `<div {...handlers}>` — which no rule over source can see, and which the
 * rendered-DOM sweep is the other half of.
 */

export interface HandlerViolation {
  readonly tag: string;
  readonly handler: string;
  readonly line: number;
}

/**
 * Intrinsic elements that are operable on their own — focusable, activated by Enter or
 * Space, and given a role and an accessible name by the browser. A handler on anything else
 * is a control the platform does not know is a control.
 */
export const OPERABLE_ELEMENTS: readonly string[] = [
  "a",
  "area",
  "button",
  "details",
  "input",
  "label",
  "option",
  "select",
  "summary",
  "textarea",
];

/**
 * The handlers that make an element operable, matched however they are spelled — Preact takes
 * `onClick` and `onclick` alike. Deliberately the activation ones only: a `<div onScroll>` or
 * an `<li onMouseEnter>` for a hover affordance is not a control, and a rule that argued with
 * those would be turned off rather than obeyed.
 */
const ACTIVATION_HANDLERS: readonly string[] = [
  "onclick",
  "ondblclick",
  "ondoubleclick",
  "onkeydown",
  "onkeyup",
  "onkeypress",
  "onpointerdown",
  "onpointerup",
  "onmousedown",
  "onmouseup",
  "ontouchstart",
  "ontouchend",
];

/**
 * Whether a tag names an intrinsic element rather than a component. JSX's own rule: a plain
 * identifier starting with a lowercase letter is an element, anything else — `Pin`, `Map.Pin`
 * — is a component, and a handler on one of those is that component's business, found when
 * its own file is scanned.
 */
function intrinsicTag(tagName: ts.JsxTagNameExpression): string | undefined {
  if (!ts.isIdentifier(tagName)) return undefined;
  const text = tagName.text;
  return /^[a-z]/.test(text) ? text : undefined;
}

/**
 * Every activation handler in `source` that sits on an intrinsic element which is not
 * operable on its own.
 */
export function handlersOnNonOperableElements(source: string): HandlerViolation[] {
  const parsed = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: HandlerViolation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = intrinsicTag(node.tagName);
      if (tag !== undefined && !OPERABLE_ELEMENTS.includes(tag)) {
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute)) continue;
          const handler = attribute.name.getText(parsed);
          if (!ACTIVATION_HANDLERS.includes(handler.toLowerCase())) continue;
          found.push({
            tag,
            handler,
            line: parsed.getLineAndCharacterOfPosition(attribute.getStart(parsed)).line + 1,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(parsed);
  return found;
}
