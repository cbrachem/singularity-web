import { developmentOnly } from "./only.ts";

developmentOnly("development flags");

/**
 * The development entry point's two flags, read out of the page's query string.
 *
 * - `?scenario=<id>` — the Scenario to replay. Absent, or `none`, asks for no replay: the
 *   page opens on the start screen, which is where Scenario boot enters from.
 *   Naming one is the deep link past it, which is what a screenshot wants — a Scenario boot
 *   is reproducible by name, and reproducible by name means by URL.
 * - `?clock=frozen` — stops game time, so a screenshot is stable. Absent means running.
 *
 * An unknown value throws instead of being ignored: a flag that silently did nothing is how
 * a screenshot ends up taken against the wrong state, and this code exists only where a
 * developer is reading the console anyway.
 */

/** The `scenario` value that asks for no replay, which is also the absent one. */
export const NO_SCENARIO = "none";

const FROZEN = "frozen";
const RUNNING = "running";

export interface DevelopmentFlags {
  /** The Scenario to replay, or `undefined` for a new game. */
  readonly scenario: string | undefined;
  readonly frozen: boolean;
}

export function developmentFlags(search: string): DevelopmentFlags {
  const query = new URLSearchParams(search);

  const scenario = query.get("scenario") ?? NO_SCENARIO;
  const clock = query.get("clock") ?? RUNNING;
  if (clock !== FROZEN && clock !== RUNNING) {
    throw new Error(`?clock=${clock}: the clock is either ${FROZEN} or ${RUNNING}`);
  }

  return {
    scenario: scenario === NO_SCENARIO ? undefined : scenario,
    frozen: clock === FROZEN,
  };
}
