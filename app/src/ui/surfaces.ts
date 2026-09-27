/**
 * What is in front of the player, and what everything behind it may still do.
 *
 * The shell draws its surfaces over the map rather than beside it, and
 * more than one of them can be up at once — a research sheet over an open inspector, an
 * ending over both. Which one is *in front* is then a question every listener on the page
 * asks, and the whole reason this is a module is that it must be answered in one place: the
 * shell's speed hotkeys and the inspector's estate hotkeys guarding on two expressions is how
 * `b`, `a` and `d` stayed live behind a surface that showed neither.
 *
 * The order below is the drawing order the stylesheets already keep, top first. A surface
 * added to it is added here, to the stack, rather than to a condition somewhere.
 *
 * The licences surface is on it because the console is a second way into it: it is
 * opened *from* the console and drawn over it, so Escape closes it and leaves the console it
 * was opened from standing.
 *
 * A surface on the stack says which of two things it is, and it is one line here rather than
 * a condition in a listener: it claims modality, it is opaque, or it is neither. A surface
 * takes what it covers, either way.
 */
export const SURFACES = [
  "ending",
  "notification",
  "licences",
  "console",
  "research",
  "inspector",
  "map",
] as const;

export type Surface = (typeof SURFACES)[number];

/** Every surface except the map, which is the one thing always there to be drawn over. */
export type TransientSurface = Exclude<Surface, "map">;

/** Which of the transient surfaces the shell currently has up. */
export type OpenSurfaces = { readonly [K in TransientSurface]: boolean };

/**
 * The surfaces that claim modality — `role="alertdialog"` with `aria-modal="true"`, which
 * tells assistive technology that everything else on the page is unavailable. It is the
 * claim that carries the obligation: these take the focus as well, capturing it when they
 * open and holding Tab inside themselves (`modal-surface.ts`).
 */
const MODAL: readonly Surface[] = ["ending", "notification"];

/**
 * The surfaces that are opaque and full height to the reserved band: the console
 * and the one it opens over itself. Each of them is
 * `inset: 0 0 var(--band-height)` over `--colour-surface-solid`, so nothing behind one is
 * visible and the map under it is decor.
 *
 * They take what they cover and no more: the player cannot see it, so the player
 * cannot reach it — but they capture no focus, hold no Tab and draw no scrim, because a
 * surface that paints over the whole shell is its own scrim and is a place the player has
 * gone to rather than a message that interrupted them.
 *
 * The research sheet is not one. It is a bottom sheet whose `max-height` reserves a strip of
 * map above it, so that strip stays at every supported viewport
 * (`app/test/viewport.test.ts`).
 */
const OPAQUE: readonly Surface[] = ["licences", "console"];

/** The surface in front of the player: the topmost of the ones that are up. */
export function frontSurface(open: OpenSurfaces): Surface {
  for (const surface of SURFACES) {
    if (surface === "map") return surface;
    if (open[surface]) return surface;
  }
  return "map";
}

export function isModal(surface: Surface): boolean {
  return MODAL.includes(surface);
}

export function isOpaque(surface: Surface): boolean {
  return OPAQUE.includes(surface);
}

/**
 * Whether a surface takes the page from everything behind it — by claiming modality, or by
 * covering it. Either way what is behind it is `inert`, and the focus it displaces
 * is the shell's to give back.
 */
export function takesWhatIsBehind(surface: Surface): boolean {
  return isModal(surface) || isOpaque(surface);
}

/**
 * Whether a surface is out of the player's reach: it is behind one that claims modality or
 * covers it, so it takes no click, no key and no focus, and assistive technology is not
 * offered it either. Behind a surface that neither claims nor covers — the research sheet,
 * the inspector — everything stays as reachable as it looks.
 */
export function outOfReach(front: Surface, surface: Surface): boolean {
  return takesWhatIsBehind(front) && SURFACES.indexOf(surface) > SURFACES.indexOf(front);
}

/** How deep a surface sits in the stack; smaller is nearer the player. */
export function depth(surface: Surface): number {
  return SURFACES.indexOf(surface);
}
