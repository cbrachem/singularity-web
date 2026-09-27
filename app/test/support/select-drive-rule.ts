import ts from "typescript";

/**
 * The source rule behind the one select driver: **a test does not drive a select itself**.
 *
 * `choose.ts` picks an option by accessible name and throws when the select offers no such
 * option. An inline `fireEvent.change(screen.getByRole("combobox", …), { target: { value } })`
 * has no such refusal: a value no option carries changes nothing at all, and the test reads on
 * as if it had chosen. `base-power.test.tsx` asked for a "Warehouse" base type for several
 * changes and drove a "Server Access" one instead, so this rule keeps the driver the
 * only one, the way `frame-source-rule.ts` keeps the fake frame source one.
 *
 * Reading a combobox is not driving it — a test may hold a select and assert its value. What
 * the rule forbids is the change event, on a combobox named inline or held in a local.
 *
 * It parses for the reason `operable-source.ts` parses: a text rule that misreads
 * its input reports success. `ts.createSourceFile` recovers from errors, so the rule still
 * holds for a file that does not typecheck.
 */

const COMBOBOX = "combobox";

function mentionsCombobox(node: ts.Node): boolean {
  if (ts.isStringLiteralLike(node) && node.text === COMBOBOX) return true;
  return ts.forEachChild(node, mentionsCombobox) ?? false;
}

function isFireEventChange(node: ts.CallExpression): boolean {
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "change" &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "fireEvent"
  );
}

/** Locals initialised from a combobox query, so `fireEvent.change(select, …)` is seen too. */
function comboboxLocals(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      mentionsCombobox(node.initializer)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

/** The 1-based lines of every `fireEvent.change` on a combobox in `source`. */
export function selectDrivesIn(source: string): number[] {
  const file = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const locals = comboboxLocals(file);
  const lines: number[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isFireEventChange(node)) {
      const target = node.arguments[0];
      const drivesSelect =
        target !== undefined &&
        (mentionsCombobox(target) || (ts.isIdentifier(target) && locals.has(target.text)));
      if (drivesSelect) {
        lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return lines;
}
