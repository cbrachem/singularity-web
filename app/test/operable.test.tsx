import { readFileSync } from "node:fs";
import { relative } from "node:path";

import { describe, expect, it } from "vitest";

import { accessibleName, unnamedOperables } from "./support/accessible-names.ts";
import { OPERABLE_ELEMENTS, handlersOnNonOperableElements } from "./support/operable-source.ts";
import { APP_SOURCE, sourceFiles } from "./support/source-files.ts";

function markup(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

function only(html: string): HTMLElement {
  return markup(html).firstElementChild as HTMLElement;
}

describe("the accessible name a driver addresses an element by", () => {
  it("is the label, the text, or what a <label> says", () => {
    expect(accessibleName(only('<button aria-label="Freeze the clock"></button>'))).toBe(
      "Freeze the clock",
    );
    expect(accessibleName(only("<button> Advance one game day </button>"))).toBe(
      "Advance one game day",
    );
    expect(accessibleName(only('<input type="submit" value="Build" />'))).toBe("Build");
    expect(
      accessibleName(
        only('<label>Seed <input type="text" /></label>').querySelector("input") as HTMLElement,
      ),
    ).toBe("Seed");
  });

  it("resolves aria-labelledby through the document the element is in", () => {
    document.body.innerHTML = '<h2 id="where">Europe</h2><button aria-labelledby="where"></button>';

    expect(accessibleName(document.body.querySelector("button") as HTMLElement)).toBe("Europe");

    document.body.innerHTML = "";
  });
});

describe("the sweep for operable elements without a name", () => {
  it("finds a nameless button, link, and anything wearing an operable role", () => {
    const found = unnamedOperables(
      markup(
        [
          "<button></button>",
          '<a href="/somewhere"><svg></svg></a>',
          '<div role="button" tabindex="0"></div>',
          '<div tabindex="0"></div>',
        ].join(""),
      ),
    );

    expect(found.map((one) => one.tag)).toEqual(["button", "a", "div", "div"]);
  });

  it("passes anything a driver can address, and ignores what is not operable", () => {
    expect(
      unnamedOperables(
        markup(
          [
            "<button>EUROPE</button>",
            '<a href="/licences">Licences</a>',
            '<div role="button" tabindex="0" aria-label="Console"></div>',
            "<div>DAY 0005, 00:00:00</div>",
            '<span tabindex="-1"></span>',
            '<input type="hidden" name="seed" />',
          ].join(""),
        ),
      ),
    ).toEqual([]);
  });
});

describe("the source rule against a control the platform does not know is a control", () => {
  it("finds an activation handler on an element that is not operable", () => {
    const found = handlersOnNonOperableElements(
      '<div class="pin" onClick={() => select(place)}>{place.id}</div>',
    );

    expect(found).toEqual([{ tag: "div", handler: "onClick", line: 1 }]);
  });

  it("says nothing about the elements the platform already makes operable", () => {
    for (const tag of OPERABLE_ELEMENTS) {
      expect(handlersOnNonOperableElements(`<${tag} onClick={pick}>x</${tag}>`)).toEqual([]);
    }
  });

  it("leaves a component's own props to the component's own file", () => {
    expect(handlersOnNonOperableElements("<LocationPin onClick={pick} />")).toEqual([]);
  });

  it("reads a handler in a comment as prose, and reports the line of a real one", () => {
    const source = [
      "// never a <div onClick={…}>",
      "/* nor a <span onKeyDown={…}> */",
      "const shell = <section onClick={pick} />;",
    ].join("\n");

    expect(handlersOnNonOperableElements(source)).toEqual([
      { tag: "section", handler: "onClick", line: 3 },
    ]);
  });

  // The failure a text scanner makes and a parser cannot: a `<` inside an earlier attribute
  // expression looks exactly like the start of a tag. Guessing the owning tag by scanning
  // back to the nearest `<` finds `a` here — which is operable — and the rule then says
  // nothing about a div with a click handler, which is the one thing it exists to forbid.
  //
  // This is the third of three misreads that made the rules parse; the other two are pinned in
  // `sim/test/boundary.test.ts`, which now reads a tree for the same reason.
  it("attributes a handler to the element it is written on, not to the nearest `<`", () => {
    expect(handlersOnNonOperableElements("<div title={y < a} onClick={f}>x</div>")).toEqual([
      { tag: "div", handler: "onClick", line: 1 },
    ]);
    expect(handlersOnNonOperableElements('<div data-note="<button" onClick={f} />')).toEqual([
      { tag: "div", handler: "onClick", line: 1 },
    ]);
  });

  it("reads a handler on an element nested inside an attribute expression", () => {
    const source =
      '<section label={<span onClick={f} />}>\n  <a href="/x" onClick={g}>x</a>\n</section>';

    expect(handlersOnNonOperableElements(source)).toEqual([
      { tag: "span", handler: "onClick", line: 1 },
    ]);
  });

  it("reads a handler however it is spelled, and leaves the ones that are not activations", () => {
    expect(handlersOnNonOperableElements("<div onclick={f} />")).toEqual([
      { tag: "div", handler: "onclick", line: 1 },
    ]);
    expect(handlersOnNonOperableElements("<div onScroll={f} onMouseEnter={g} />")).toEqual([]);
  });

  it("is not confused by a comparison or a generic outside JSX", () => {
    const source = [
      "const smaller = <T,>(a: T, b: T) => a < b;",
      "const bar = <div onClick={f} />;",
    ].join("\n");

    expect(handlersOnNonOperableElements(source)).toEqual([
      { tag: "div", handler: "onClick", line: 2 },
    ]);
  });
});

// The rule applied, which is the point of writing it: the discipline holds for the shell as
// it stands and fails the change that first breaks it, rather than being a note in a document.
describe("app/src", () => {
  it("puts every activation handler on an element the platform makes operable", () => {
    const violations = sourceFiles(APP_SOURCE).flatMap((path) =>
      handlersOnNonOperableElements(readFileSync(path, "utf8")).map(
        (violation) =>
          `${relative(APP_SOURCE, path)}:${violation.line}: <${violation.tag} ${violation.handler}>`,
      ),
    );

    expect(violations).toEqual([]);
  });
});
