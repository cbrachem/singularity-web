/**
 * The licences document, as Presentation is handed it.
 *
 * It is **generated from `NOTICE` at build time and stamped with the commit**.
 * GPL-2.0 §3 asks for the source of what was *served*, and what answers that is the pair the
 * page prints: the address and the commit beside it. The generator is `app/scripts/licences.ts` and the delivery is the
 * `virtual:licences` module `app/scripts/licences-plugin.ts` provides — nothing under
 * `app/src` writes licence prose, and a page that did would fail the build rather than ship
 * (`app/scripts/check-licences.ts`).
 *
 * The type lives here rather than beside the generator so the direction of the dependency is
 * the one the repository layout wants: a build script may read Presentation's shape, and
 * Presentation never reaches into a build script.
 */

/** One `##` section of `NOTICE`, verbatim. */
export interface LicenceSection {
  readonly title: string;
  /** The section's text, exactly as `NOTICE` has it. */
  readonly body: string;
}

export interface LicenceDocument {
  /** The commit the bundle was built from. Always a full object name, never a branch. */
  readonly commit: string;
  /** Whether that commit describes the tree the build was made from, or only most of it. */
  readonly dirty: boolean;
  /**
   * Where the corresponding source is published, exactly as the build was told, or
   * `undefined` when this build was told nothing. Read beside `commit`: the two together are
   * what identifies the tree, because a public repository makes every commit reachable.
   */
  readonly source: string | undefined;
  /** Everything in `NOTICE` before its first section. */
  readonly preamble: string;
  readonly sections: readonly LicenceSection[];
}
