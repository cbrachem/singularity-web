# Divergence fixtures

When a trace comparison finds a difference it stops at that step and writes it out here as
`<scenario>-step-<n>.fixture.json`. The file holds the failing step's **input state** — which
is complete on its own, because the generator lives in the State root — the step
that was applied, and the reference's record for it after every Normalisation.

That makes it a standalone regression test: `sim/test/grace.trace.test.ts` replays every
fixture in this directory through one call to `advance`, with **no Python and no replay from
the beginning of the Scenario**.

A fixture written by a failing run is a working-copy artifact. Two things can happen to it:

- **Delete it** once the fault is fixed, if the Scenario itself already covers the case.
- **Commit it**, if the case is worth keeping after the Scenario moves on — a reference bump
  or a longer script would otherwise take the evidence with it.

A committed fixture that no longer fails is not noise: it is the assertion that the fault has
not come back, and it costs one `advance`.
