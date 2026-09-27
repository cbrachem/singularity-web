import { readFileSync } from "node:fs";
import { relative } from "node:path";

import { describe, expect, it } from "vitest";

import { selectDrivesIn } from "./support/select-drive-rule.ts";
import { APP_TEST, sourceFiles } from "./support/source-files.ts";

/**
 * The rule that keeps the select driver one. `choose.ts` refuses a value the select does not
 * offer; an inline `fireEvent.change` on a combobox is a silent no-op, and
 * nothing but this rule stops the next test from writing one again.
 */

/** The file allowed to drive a select: the shared driver. */
const THE_ONE = "support/choose.ts";

describe("the source rule against a second select driver", () => {
  it("finds a change fired on a combobox queried inline", () => {
    const source = 'fireEvent.change(screen.getByRole("combobox", { name: field }), {\n});';

    expect(selectDrivesIn(source)).toEqual([1]);
  });

  it("finds a change fired on a combobox held in a local", () => {
    const source = [
      'const select = screen.getByRole("combobox", { name: "Item" }) as HTMLSelectElement;',
      'fireEvent.change(select, { target: { value: "PC" } });',
    ].join("\n");

    expect(selectDrivesIn(source)).toEqual([2]);
  });

  it("leaves a combobox that is read rather than driven alone", () => {
    const source = 'expect(screen.getByRole("combobox", { name: "Item" }).value).toBe("PC");';

    expect(selectDrivesIn(source)).toEqual([]);
  });

  it("leaves a change on anything that is not a combobox alone", () => {
    const source = 'fireEvent.change(screen.getByRole("textbox", { name: "Base name" }), {});';

    expect(selectDrivesIn(source)).toEqual([]);
  });
});

// The rule applied, which is the point of writing it: five test files drove a select inline
// before they were folded onto the shared driver.
describe("app/test", () => {
  it("drives a select in one file, and takes it from there everywhere else", () => {
    const violations = sourceFiles(APP_TEST).flatMap((path) => {
      const where = relative(APP_TEST, path).split("\\").join("/");
      if (where === THE_ONE) return [];
      return selectDrivesIn(readFileSync(path, "utf8")).map((line) => `${where}:${line}`);
    });

    expect(violations).toEqual([]);
  });
});
