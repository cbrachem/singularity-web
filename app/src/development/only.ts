/**
 * The declaration every module under `app/src/development/` carries, and the string the
 * build gate looks for.
 *
 * Scenario boot and the frozen clock are development affordances and **must not reach the
 * shipped bundle** — a build assertion, not a convention. The assertion needs
 * something to look for that survives minification, and a comment does not: minifiers drop
 * comments, and a dead branch takes its strings with it, so the only reliable witness is a
 * string a live statement uses.
 *
 * `developmentOnly` is that statement. Every development-only module calls it at the top
 * level with the affordance it provides, which
 *
 * - puts `DEVELOPMENT_ONLY` in the bundle if the module is in the bundle — a top-level call
 *   into another module is a side effect a bundler may not drop;
 * - says in the browser console that development-only code is running, in case a build ever
 *   ships with it;
 * - and lists the live affordances for the development bar to show.
 *
 * The entry point reaches all of this from inside `if (import.meta.env.DEV)`, which the
 * production build folds to `false` and eliminates whole. `app/scripts/check-development-only.ts`
 * is what checks that it did.
 */

export const DEVELOPMENT_ONLY = "singularity:development-only";

const registered: string[] = [];

export function developmentOnly(affordance: string): void {
  if (registered.includes(affordance)) return;
  registered.push(affordance);
  console.info(`${DEVELOPMENT_ONLY}: ${affordance}`);
}

/** The development-only affordances loaded so far, in the order they registered. */
export function developmentFeatures(): readonly string[] {
  return [...registered];
}
