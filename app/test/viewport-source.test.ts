import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * What the stylesheets have to say for the supported range to hold, read as source.
 *
 * The range has one shell: 1024x600 CSS pixels and up, the shell frozen at that
 * size below it, and the page scrolling by the shortfall. Two halves of that decision are
 * statements a stylesheet makes rather than geometry a browser reports — the shell has one
 * form and no second one to switch to, and the page is allowed to scroll — so they are
 * checked here, beside the other source rules, and not from a browser.
 *
 * They are not in `viewport.test.ts`, whose `beforeAll` launches Chrome. Where Chrome cannot
 * launch, that file skips whole and these rules would guard nothing. The geometry the
 * range is really about still needs the browser and stays there.
 */

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const read = (path: string): string => readFileSync(resolve(REPOSITORY, path), "utf8");

describe("the supported viewport range, as the stylesheets state it", () => {
  it("freezes the one shell at 1024x600 below the supported range", () => {
    const shell = read("app/src/ui/App.css");

    expect(shell).toMatch(/\.shell\s*{[^}]*min-width:\s*1024px;/s);
    expect(shell).toMatch(/\.shell\s*{[^}]*min-height:\s*600px;/s);
    expect(shell).not.toContain("@media");
  });

  it("leaves the page free to scroll by the shortfall", () => {
    expect(read("app/src/ui/tokens.css")).not.toMatch(/body\s*{[^}]*overflow:\s*hidden;/s);
  });
});
