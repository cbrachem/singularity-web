/**
 * The sweep behind "every operable element has a stable accessible name".
 *
 * A driver that cannot say "click EUROPE" clicks coordinates, and coordinates break at the
 * next layout change. So the rule is not advice: every presentation surface is rendered and
 * run through this, and an element a driver could operate but could not address is a red
 * test rather than a later discovery.
 *
 * What is computed here is the *addressable* name — `aria-label`, `aria-labelledby`, a
 * `<label>`, an `alt`, a button's `value`, otherwise the text content — and not the whole
 * accessible-name algorithm, which resolves `title`, CSS-generated content and node
 * traversal order. The difference is deliberate: `title` alone is not an accessible name a
 * keyboard user gets, and a name a driver has to reconstruct from CSS is not stable.
 */

/** Elements a pointer or a keyboard can operate, as selectors. */
const OPERABLE: readonly string[] = [
  "a[href]",
  "area[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='option']",
  "[tabindex]:not([tabindex='-1'])",
];

/** Input types whose `value` is the label the user reads. */
const VALUE_LABELLED: readonly string[] = ["button", "submit", "reset"];

export interface UnnamedOperable {
  /** The tag, lowercase, so a failure reads as "button" rather than as a DOM node. */
  readonly tag: string;
  /** Enough of the element to find it in the source. */
  readonly html: string;
}

export function operableElements(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll(OPERABLE.join(","))].filter(
    (element): element is HTMLElement => element instanceof HTMLElement,
  );
}

/**
 * The operable elements a player can actually reach: everything the browser has not made
 * `inert`. A modal surface takes the rest of the page out of reach that way, so
 * this is what "nothing behind it takes a click" is asserted over — inert removes an element
 * from the pointer, from the tab order and from the accessibility tree at once.
 */
export function reachableOperables(root: ParentNode): HTMLElement[] {
  return operableElements(root).filter((element) => element.closest("[inert]") === null);
}

/**
 * The name a driver would address the element by, or the empty string if there is none.
 */
export function accessibleName(element: HTMLElement): string {
  const label = element.getAttribute("aria-label");
  if (label !== null && label.trim() !== "") return label.trim();

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (text !== "") return text;
  }

  if (element instanceof HTMLInputElement) {
    if (VALUE_LABELLED.includes(element.type)) return element.value.trim();
    if (element.type === "image") return (element.getAttribute("alt") ?? "").trim();
  }

  const labels = element.ownerDocument.querySelectorAll(`label[for='${element.id}']`);
  if (element.id !== "" && labels.length > 0) {
    const text = [...labels]
      .map((one) => one.textContent ?? "")
      .join(" ")
      .trim();
    if (text !== "") return text;
  }

  const closest = element.closest("label");
  if (closest !== null && (closest.textContent ?? "").trim() !== "") {
    return (closest.textContent as string).trim();
  }

  const own = (element.textContent ?? "").trim();
  if (own !== "") return own;

  return (element.getAttribute("alt") ?? "").trim();
}

/** Every operable element under `root` that a driver could not address by name. */
export function unnamedOperables(root: ParentNode): UnnamedOperable[] {
  return operableElements(root)
    .filter((element) => accessibleName(element) === "")
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      html: element.outerHTML.slice(0, 200),
    }));
}
