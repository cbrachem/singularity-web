/**
 * `bun test` is bun's own test runner, and it is not this repository's suite.
 *
 * The suite is Vitest, reached as `bun run test`. The short form is one word
 * away and collects the same files without any of what they are written against — no
 * Vitest globals, no `happy-dom`, no Vite resolution — so it dies inside `app/test` on a
 * module nothing here imports. That failure names a JSX runtime, which is a symptom of the
 * command and not a fault in the tree, and a CI job or a new terminal that reaches for the
 * short form has no way to read that out of it.
 *
 * `bunfig.toml` preloads this file for `bun test`, so it runs before a single test file is
 * collected: the wrong command answers with the right one and stops.
 */
export const BUN_TEST_COMPLAINT =
  "`bun test` is bun's own runner and does not run this suite — run `bun run test` (Vitest)";

console.error(BUN_TEST_COMPLAINT);
process.exit(1);
