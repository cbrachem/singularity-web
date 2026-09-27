import { content, resourceFlow, type SimulationState } from "@singularity/sim";
import type { JSX } from "preact";

import type { Speed } from "../host/tick-partition.ts";
import { formatGameTime } from "./game-time.ts";
import { plainLabel, speedLabel, toMoney } from "./readouts.ts";
import { SpeedControl } from "./SpeedControl.tsx";
import "./Hud.css";

/**
 * The always-on readout: difficulty, clock, speed, the two resource pools and where the next
 * day takes each of them.
 *
 * It floats over the map rather than taking a row from it, because the map is the application
 * and a band across the top would cost globe height on every frame for four values that fit in
 * a corner. The one thing that *does* take a row is the threat readout, and it is reserved
 * along the bottom edge instead (`--band-height`).
 *
 * # Why every value is a fixed-width cell
 *
 * These numbers change every tick, and a HUD whose columns move as the cash figure gains a
 * digit is unreadable at a glance. The measure is the same one the shell spends on the threat
 * readout: tabular figures in a self-hosted mono subset, and a cell sized for the widest
 * string the value can produce rather than for the one on the screen now.
 *
 * # Why a pool is shown with a flow
 *
 * A balance says where the player is; a balance alone does not say whether it is about to
 * fall over. Upstream puts the day's flow in the same cell as each pool, in parentheses
 * (`screens/map.py:824`), and it comes from `compute_future_resource_flow` — a Projection
 * over the State root, called here with nothing being considered (`sim/src/flow.ts`).
 * The port puts it on its own line under the pool instead of in parentheses
 * beside it: these cells are fixed-width so that the panel does not move as the figures do,
 * and a second figure sharing a cell is what that width exists to prevent.
 *
 * The Speed is the one value here that is also a control: the readout says what the setting
 * is, and the row of buttons **under** it changes the setting — the Host's own signal,
 * reached through the callback the shell binds (`SpeedControl.tsx`). The readout
 * stays because it is the one place the setting is written in words, and because the
 * Simulation can pause the game without the player touching the row.
 *
 * # Under, in this panel too
 *
 * The row was beside the readouts until the two panels were measured against each other at
 * 1024, which is the floor of the supported range: they wanted 1068px between them and were drawn
 * 44px into one another, so the resources panel covered the Speed readout and half the speed
 * control. The argument the flow's own arrangement rests on turned out to apply to the panel
 * making it (`Hud.css`, `app/test/viewport.test.ts`).
 */
export interface HudProps {
  readonly state: SimulationState;
  readonly speed: Speed;
  readonly onSpeed: (speed: Speed) => void;
  readonly onOpenResearch: () => void;
  readonly onOpenConsole: () => void;
}

export function Hud({
  state,
  speed,
  onSpeed,
  onOpenResearch,
  onOpenConsole,
}: HudProps): JSX.Element {
  const difficulty = content.difficulties.byId.get(state.difficulty);
  // Asked with an empty hypothetical: the HUD says where the day the player *has* is going,
  // and the build dial is what asks the same question with an order in it (`estate.ts`).
  const flow = resourceFlow(state);

  return (
    <div class="hud">
      <div class="hud__panel hud__clock">
        <div class="hud__row">
          <Readout
            setting
            cell="difficulty"
            label="Difficulty"
            value={plainLabel(difficulty?.name ?? state.difficulty)}
          />
          <Readout label="Game time" value={formatGameTime(state.gameTime)} cell="clock" display />
          <Readout setting cell="speed" label="Speed" value={speedLabel(speed)} />
        </div>
        <SpeedControl speed={speed} onSpeed={onSpeed} />
      </div>

      <div class="hud__panel hud__resources">
        <div class="hud__row">
          <Readout
            display
            label="Cash"
            value={toMoney(state.cash)}
            flow={{ label: "Cash flow", value: toMoney(flow.cash.difference), unit: "/ day" }}
          />
          {/*
            `total_cpu` as the reference's own map screen computes it (`screens/map.py:829`),
            and under it the figure upstream prints in the same parentheses the cash flow uses.

            It is not a rate, which is why it does not say `/ day`. The cash figure is one —
            the balance moves by it every day. The CPU figure is what the pool has **left**
            once maintenance, construction and every allocation have been served: a stock, not
            a flow, and one that reads the same as the pool itself until the player spends any
            of it. Calling that "1 / day" beside a pool of 1 says the number twice.
          */}
          <Readout
            display
            label="CPU"
            value={toMoney((state.availableCpus[0] ?? 0) + state.sleepingCpus)}
            flow={{ label: "CPU spare", value: toMoney(flow.cpu.difference), unit: "spare" }}
          />
        </div>
        {/*
          The two doors, **under** the readouts rather than beside them — the move the clock
          panel already makes with its speed control, for the same reason and settled the same
          way (`Hud.css`, `app/test/viewport.test.ts`). Beside, a door is width in the panel
          that grows leftward towards the clock at 1024, and the first door whose name says
          what it opens took more of that width than the gap had.

          The first name is the reference's own (`screens/map.py:502`, `&RESEARCH/TASKS`), and
          it says what the sheet holds: the pool and the job are allocated on it beside the
          research (`screens/research.py:227`). "Research" named a third of it.
        */}
        <div class="hud__row">
          <button type="button" class="hud__research" onClick={onOpenResearch}>
            Research/Tasks
          </button>
          <button type="button" class="hud__research" onClick={onOpenConsole}>
            Console
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One labelled value, and — where the value is a pool — the daily flow **under** it rather
 * than beside it.
 *
 * Under, because the panel is absolutely positioned against the right edge and the clock
 * panel against the left: two more cells across would push the two panels into each other at
 * the bottom of the supported range (1024 wide), and a HUD that overlaps itself at
 * the smallest supported size is worse than one that is a line taller everywhere. It also
 * reads correctly — a flow is not a peer of its pool, it is a fact about it.
 *
 * `<output>` because that is what an element holding a computed value is, and it is where the
 * accessible name comes from for free. The live region it implies is switched off
 * deliberately: these change every tick, and a HUD that reads five numbers aloud every second
 * is worse than one that reads none. The clock is the same — a screen reader user asks for
 * the time, they do not want it announced.
 */
function Readout({
  label,
  value,
  cell,
  display,
  setting,
  flow,
}: {
  readonly label: string;
  readonly value: string;
  /**
   * Which cell this is, where the cell carries a width of its own: the three in the clock
   * panel are each sized for the widest string *their* value can produce, and no two of those
   * strings are the same length (`Hud.css`). The two pools take the money width instead, which
   * is one width for both and is declared against the panel rather than the readout.
   */
  readonly cell?: "clock" | "difficulty" | "speed";
  /** The display grade: the clock and the two pools, and nothing else (`Hud.css`). */
  readonly display?: boolean;
  /** A setting rather than a live value: read once, so a grade down (`Hud.css`). */
  readonly setting?: boolean;
  readonly flow?: { readonly label: string; readonly value: string; readonly unit: string };
}): JSX.Element {
  const classes = ["hud__value"];
  if (cell) classes.push(`hud__value--${cell}`);
  if (display) classes.push("hud__value--display");
  if (setting) classes.push("hud__value--setting");
  return (
    <div class="hud__readout">
      <span class="hud__label">{label}</span>
      <output class={classes.join(" ")} aria-label={label} aria-live="off">
        {value}
      </output>
      {flow && (
        <div class="hud__flow">
          <output class="hud__flow-value" aria-label={flow.label} aria-live="off">
            {flow.value}
          </output>
          <span class="hud__flow-unit">{flow.unit}</span>
        </div>
      )}
    </div>
  );
}
