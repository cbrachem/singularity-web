import {
  CASH,
  CPU,
  CPU_POOL,
  JOBS,
  allocatedCpuFor,
  content,
  cpuLeft,
  currentTask,
  dangerFor,
  finishedTechs,
  isAvailable,
  jobProfit,
  type Command,
  type Cost,
  type FinishedTechs,
  type SimulationState,
} from "@singularity/sim";
import type { JSX } from "preact";

import { toCpu, toMoney } from "./readouts.ts";
import "./ResearchSheet.css";

export interface ResearchSheetProps {
  readonly state: SimulationState;
  readonly onClose: () => void;
  readonly onCommand?: (command: Command) => void;
}

interface ResearchTech {
  readonly tech: (typeof content.techs.all)[number];
  readonly index: number;
}

/**
 * Every CPU the player has is allocated here — the pool and the job as well as the research
 * (`screens/research.py:227`) — so the surface carries the reference's own name for it,
 * `RESEARCH/TASKS` (`screens/map.py:502`), rather than the name of one of its three sinks.
 */
export function ResearchSheet({ state, onClose, onCommand }: ResearchSheetProps): JSX.Element {
  const techs = researchTechs(state);
  const finished = finishedTechs(state.techs);
  const total = state.availableCpus[0] ?? 0;
  const left = cpuLeft(state)[0] ?? 0;

  return (
    <section class="research-sheet" aria-label="Research/Tasks" data-bottom="reserved-band">
      <header class="research-sheet__header">
        <div>
          <h1>Research/Tasks</h1>
          <output aria-label="CPU left" aria-live="off">
            {toMoney(left)} of {toMoney(total)} CPU left
          </output>
        </div>
        <button
          type="button"
          class="research-sheet__close"
          aria-label="Close research/tasks"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div class="research-sheet__sinks" aria-label="Other CPU tasks">
        {sinkRows(state, finished).map(({ taskId, name, description, note }) => (
          <AllocationRow
            key={taskId}
            rowClass="research-sheet__sink"
            state={state}
            taskId={taskId}
            name={name}
            description={description}
            {...(note && { note })}
            {...(onCommand && { onCommand })}
          />
        ))}
      </div>
      <div class="research-sheet__list" aria-label="Available research">
        {techs.map(({ tech, index }) => (
          <AllocationRow
            key={`${tech.id}-${index}`}
            rowClass="research-sheet__row"
            state={state}
            taskId={tech.id}
            name={tech.name}
            description={tech.description}
            note={priceOf(state, index)}
            {...(onCommand && { onCommand })}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * The two tasks that are not research, in the order upstream's own screen lists them
 * (`screens/research.py:227`): the pool first, then the job — named by whichever job is
 * currently available rather than by the task id the Command carries.
 */
function sinkRows(state: SimulationState, finished: FinishedTechs) {
  const pool = currentTask(CPU_POOL, finished);
  const job = currentTask(JOBS, finished);
  const profit = jobProfit(finished, state.jobBonus);

  return [
    pool && { taskId: CPU_POOL, name: pool.name, description: pool.description },
    job && {
      taskId: JOBS,
      name: job.name,
      description: job.description,
      note: `${toMoney(profit)} money per CPU per day`,
    },
  ].filter((row) => row !== undefined);
}

/**
 * What the tech still costs, in the two currencies the player spends: the cash it will draw
 * and the CPU-days it will take.
 *
 * What is **left**, not what it started at — a tech half paid for is a different offer from
 * one nothing has been put on, and the sheet is where the player chooses between them. The
 * numbers come off the buyable the state carries, so they already have the difficulty's
 * labor bonus in them (`sim/src/buyable.ts`).
 */
function priceOf(state: SimulationState, index: number): string {
  const tech = state.techs[index];
  if (!tech) throw new Error(`no research at index ${index}`);
  const left: Cost = tech.buyable.costLeft;
  return `${toMoney(left[CASH])} cash · ${toCpu(left[CPU])} CPU-days left`;
}

/**
 * Alphabetical by name, as upstream's screen lists them (`screens/research.py:226`). The
 * order depends on nothing an allocation changes, so a row stays put when CPU lands on it.
 */
function researchTechs(state: SimulationState): ResearchTech[] {
  const finished = finishedTechs(state.techs);
  const available = state.techs.flatMap((techState, index) => {
    const tech = content.techs.byId.get(techState.specId);
    return tech && !techState.buyable.done && isAvailable(tech.prerequisites, finished)
      ? [{ tech, index }]
      : [];
  });

  return available.sort(({ tech: left }, { tech: right }) => left.name.localeCompare(right.name));
}

function AllocationRow({
  state,
  taskId,
  name,
  description,
  note,
  rowClass,
  onCommand,
}: {
  readonly state: SimulationState;
  readonly taskId: string;
  readonly name: string;
  readonly description: string;
  readonly note?: string;
  readonly rowClass: string;
  readonly onCommand?: (command: Command) => void;
}): JSX.Element {
  const cpu = allocatedCpuFor(state, taskId);
  const most = Math.max(cpu + (cpuLeft(state)[dangerFor(taskId)] ?? 0), 0);
  /*
   * The budget gates here as upstream's slider max does (`screens/research.py:183`), and the
   * Simulation clamps the same way — this bound keeps the field from
   * showing a figure the Command would cut down.
   */
  const send = (next: number): void => {
    onCommand?.({ command: "allocateCpu", task: taskId, cpu: next });
  };

  return (
    <article class={rowClass} data-task={taskId} data-allocated={cpu > 0 ? "true" : undefined}>
      <div class="research-sheet__text">
        <div class="research-sheet__title">
          <h2>{name}</h2>
          {note && <span class="research-sheet__note">{note}</span>}
        </div>
        <p>{description}</p>
      </div>
      {/*
        The reference's own control (`screens/research.py:124`): a slider whose maximum is the
        CPU this row can reach, so the whole budget is one drag. It carries the same name as
        the field — one value, two hands on it — and the role tells a driver which is which.
      */}
      <input
        type="range"
        class="research-sheet__share"
        min="0"
        max={most}
        step="1"
        value={cpu}
        style={`--share: ${most > 0 ? (Math.max(cpu, 0) / most) * 100 : 0}%`}
        aria-label={`CPU for ${name}`}
        onInput={(event) => send(Number(event.currentTarget.value))}
      />
      {/*
        The dial the inspector's build order uses, for the same kind of decision: minus, the
        figure, plus. The column heading is the sheet's, once, rather than repeated on every
        row — each control keeps its own accessible name, which is what a driver reads.
      */}
      <div class="research-sheet__allocation">
        <button
          type="button"
          aria-label={`Less CPU for ${name}`}
          aria-disabled={cpu <= 0 ? "true" : undefined}
          onClick={() => send(Math.max(cpu - 1, 0))}
        >
          −
        </button>
        <input
          type="number"
          min="0"
          max={most}
          step="1"
          value={cpu}
          aria-label={`CPU for ${name}`}
          onInput={(event) => {
            const next = Number(event.currentTarget.value);
            if (!Number.isInteger(next) || next < 0) return;
            const clamped = Math.min(next, most);
            if (clamped !== next) event.currentTarget.value = String(clamped);
            send(clamped);
          }}
        />
        <button
          type="button"
          aria-label={`More CPU for ${name}`}
          aria-disabled={cpu >= most ? "true" : undefined}
          onClick={() => send(Math.min(cpu + 1, most))}
        >
          +
        </button>
      </div>
    </article>
  );
}
