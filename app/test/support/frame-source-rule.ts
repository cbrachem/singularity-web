import ts from "typescript";

/**
 * The source rule behind the one fake frame source: **a test does not build its own**.
 *
 * `frames.ts` is the page's frame source with the test holding the clock. Six test files had
 * grown their own copy of it, each twenty lines, and they had already drifted — one counted
 * delivered frames, the rest did not, and only one handed out a fresh handle per request. A
 * copy costs nothing to write and everything to change: the file that keeps the old shape is
 * the one that stops proving what its name says.
 *
 * The rule reads the shape rather than the name. A helper called `frames()` or `clockFrames()`
 * is the same duplicate as one called `fakeFrames()`, so what it looks for is an object
 * literal carrying the three members of `FrameSource` — `now`, `request` and `cancel`.
 *
 * It parses for the reason `operable-source.ts` parses: a text rule that misreads
 * its input reports success. `ts.createSourceFile` recovers from errors, so the rule still
 * holds for a file that does not typecheck.
 */

/** The members that make an object literal a frame source. */
const FRAME_SOURCE_MEMBERS: readonly string[] = ["now", "request", "cancel"];

function memberNames(literal: ts.ObjectLiteralExpression): string[] {
  return literal.properties.flatMap((property) =>
    property.name && ts.isIdentifier(property.name) ? [property.name.text] : [],
  );
}

/** The 1-based lines of every object literal in `source` that is a frame source. */
export function frameSourcesIn(source: string): number[] {
  const file = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const lines: number[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const names = memberNames(node);
      if (FRAME_SOURCE_MEMBERS.every((member) => names.includes(member))) {
        lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return lines;
}
