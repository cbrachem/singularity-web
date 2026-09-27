import { resourceFlow, type SimulationState } from "@singularity/sim";
import type { JSX } from "preact";

import type { Speed } from "../host/tick-partition.ts";
import { gameClock } from "./game-time.ts";
import { toMoney } from "./readouts.ts";
import { SpeedControl } from "./SpeedControl.tsx";
import "./Hud.css";

/**
 * The always-on readout, as one bar across the top of the shell: the clock and the speed
 * setting on the left, the two pools and the two doors on the right.
 *
 * The difficulty is not here. It is set once, when the game is created, and a readout the
 * player never needs to glance at again is width the pools need at the 1280 floor. The
 * console's report carries it (`Console.tsx`).
 *
 * Every value is an `<output>` with its live region switched off: these change every tick,
 * and a HUD that reads five numbers aloud every second is worse than one that reads none.
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
  // Asked with an empty hypothetical: the HUD says where the day the player *has* is going,
  // and the build dial is what asks the same question with an order in it (`estate.ts`).
  const flow = resourceFlow(state);
  const { day, time } = gameClock(state.gameTime);

  return (
    <div class="hud">
      <output class="hud__clock" aria-label="Game time" aria-live="off">
        <span class="hud__label">Day</span> {day} · {time}
      </output>
      <SpeedControl speed={speed} onSpeed={onSpeed} />
      <div class="hud__spacer" />
      <Pool
        label="Cash"
        value={toMoney(state.cash)}
        flow={{
          label: "Cash flow",
          value: signed(flow.cash.difference),
          unit: "/day",
          sign: Math.sign(flow.cash.difference),
        }}
      />
      {/*
        `total_cpu` as the reference's own map screen computes it (`screens/map.py:829`), and
        beside it what the pool has *left* once maintenance, construction and every allocation
        have been served. A stock, not a rate, so it says `spare` and not `/day`.
      */}
      <Pool
        label="CPU"
        value={toMoney((state.availableCpus[0] ?? 0) + state.sleepingCpus)}
        flow={{ label: "CPU spare", value: toMoney(flow.cpu.difference), unit: " spare", sign: 0 }}
      />
      {/* The first name is the reference's own (`screens/map.py:502`, `&RESEARCH/TASKS`). */}
      <button type="button" class="hud__door" onClick={onOpenResearch}>
        Research/Tasks
      </button>
      <button type="button" class="hud__door" onClick={onOpenConsole}>
        Console
      </button>
    </div>
  );
}

function signed(amount: number): string {
  return amount > 0 ? `+${toMoney(amount)}` : toMoney(amount);
}

function Pool({
  label,
  value,
  flow,
}: {
  readonly label: string;
  readonly value: string;
  readonly flow: {
    readonly label: string;
    readonly value: string;
    readonly unit: string;
    readonly sign: number;
  };
}): JSX.Element {
  return (
    <div class="hud__pool">
      <span class="hud__label">{label}</span>
      <div class="hud__figures">
        <output class="hud__value" aria-label={label} aria-live="off">
          {value}
        </output>
        <span class="hud__flow" data-sign={flow.sign}>
          <output aria-label={flow.label} aria-live="off">
            {flow.value}
          </output>
          {flow.unit}
        </span>
      </div>
    </div>
  );
}
