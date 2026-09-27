# Instructions for AI agents

Read `README.md` for the build, test and layout overview.

- `sim/` touches no browser API and takes no transcendental function from the runtime.
  `bun run check:boundary` enforces this.
- `app/` depends on `sim/`; never the other way. The seam is
  `advance(state, gameSeconds) -> { state, effects }`.
- The simulation has exactly four RNG functions: `random`, `choice`, `shuffle`, `randint`.
  Do not add a fifth.
- `singularity/` is the vendored original game. Never edit it.
- `content/` is converter output only. Change `tools/convert/`, then re-run it.
- Every operable element is a real `<button>` or `<a>` with an accessible name.
  `app/test/support/accessible-names.ts` checks it.
- Browser tests use Playwright's own Chromium, not the machine's Chrome.
- Development-only code lives in `app/src/development/` and calls `developmentOnly("…")`.
  `bun run check:development-only` fails if any of it reaches a build.
- Before you hand off, run `bun run typecheck`, `bun run lint`, `bun run format:check` and
  `bun run test`.
- Code, comments and documentation are in English.
