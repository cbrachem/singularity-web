/**
 * `Player.recalc_cpu` (`player.py:482`): how much CPU there is, per danger level, and what
 * happens to the allocations when there is not enough.
 *
 * Traced as derived state rather than persisted, because upstream rebuilds it at load — which
 * is exactly why it is worth tracing: a fault here shows up one tick before it reaches
 * anything saved.
 */

import { content } from "./content/index.ts";
import { hasPower } from "./base.ts";
import { truncate } from "./pynum.ts";
import { dangerFor } from "./task.ts";
import type { CpuAllocation, SimulationState } from "./state.ts";

export const DANGER_LEVELS = 5;

function locationSafety(locationId: string): number {
  const location = content.locations.byId.get(locationId);
  if (!location) throw new Error(`no such location: ${locationId}`);
  return location.safety;
}

/**
 * Recompute the CPU tables and, when a danger level is oversubscribed, scale every allocation
 * at that level down proportionately.
 *
 * The scaling reads the *original* demand and writes each task once, so two levels never
 * compound their reductions on the same task — upstream's `needed_cpus` is computed before
 * the loop for that reason.
 */
export function recalcCpu(state: SimulationState): SimulationState {
  const available = Array.from({ length: DANGER_LEVELS }, () => 0);
  let sleeping = 0;

  for (const location of state.locations) {
    const safety = locationSafety(location.specId);
    for (const base of location.bases) {
      if (!base.buyable.done) continue;
      if (hasPower(base)) {
        for (let danger = 0; danger <= safety; danger += 1) {
          available[danger] = (available[danger] as number) + base.cpu;
        }
      } else if (base.powerState === "sleep") {
        sleeping += base.cpu;
      }
    }
  }

  const needed = Array.from({ length: DANGER_LEVELS }, () => 0);
  for (const { taskId, cpu } of state.cpuUsage) {
    if (cpu <= 0) continue;
    for (let danger = 0; danger <= dangerFor(taskId); danger += 1) {
      needed[danger] = (needed[danger] as number) + cpu;
    }
  }

  let cpuUsage: readonly CpuAllocation[] = state.cpuUsage;
  for (let danger = 0; danger < DANGER_LEVELS; danger += 1) {
    const availableCpu = available[danger] as number;
    const neededCpu = needed[danger] as number;
    if (neededCpu <= availableCpu) continue;
    const left = availableCpu / neededCpu;
    cpuUsage = cpuUsage.map((allocation) =>
      allocation.cpu > 0 && dangerFor(allocation.taskId) === danger
        ? { ...allocation, cpu: truncate(allocation.cpu * left) }
        : allocation,
    );
  }

  return { ...state, availableCpus: available, sleepingCpus: sleeping, cpuUsage };
}

/**
 * `ResearchScreen.calc_cpu_left` (`screens/research.py:199`): the CPU still unallocated, per
 * danger level. Upstream computes it in the screen because the screen is where its only use
 * was — the slider maximum; the port keeps it beside the tables it reads, because the cap is
 * a Command's rule here (deviation 5).
 *
 * The smoothing loop stops at level 3 as upstream's `range(1, 4)` does, leaving the last
 * level as it fell. Copied as written.
 */
export function cpuLeft(state: SimulationState): readonly number[] {
  const left = state.availableCpus.slice();
  for (const { taskId, cpu } of state.cpuUsage) {
    if (cpu <= 0) continue;
    for (let danger = 0; danger <= dangerFor(taskId); danger += 1) {
      left[danger] = (left[danger] as number) - cpu;
    }
  }
  for (let danger = 1; danger < 4; danger += 1) {
    left[danger] = Math.min(left[danger - 1] as number, left[danger] as number);
  }
  return left;
}

/**
 * `Player.get_allocated_cpu_for` (`player.py:241`).
 *
 * Upstream's `default_value` is not here. It defaults to `None`, and both callers pass `0`
 * instead — `Player.give_time` for the jobs allocation (`player.py:315`) and the research
 * screen's readout (`screens/research.py:145`). An unallocated task has no CPU, in the rules
 * and in the readout alike, so the port makes that the answer rather than a parameter.
 */
export function allocatedCpuFor(state: SimulationState, taskId: string): number {
  return state.cpuUsage.find((allocation) => allocation.taskId === taskId)?.cpu ?? 0;
}

/**
 * The assignment half of `Player.set_allocated_cpu_for` (`player.py:243`) — the rules it
 * checks first are the Command's (`./command.ts`), because upstream's are a screen's.
 *
 * `cpu_usage` is a plain Python dict, so an assignment to a task already in it keeps that
 * task where it was and a new one goes to the end. The port's list has to move the same way:
 * the order is what decides which tech is offered the cash first when there is not enough for
 * everybody (`./advance.ts`), so re-allocating a task must not quietly promote it.
 */
export function setAllocatedCpuFor(
  allocations: readonly CpuAllocation[],
  taskId: string,
  cpu: number,
): readonly CpuAllocation[] {
  if (!allocations.some((allocation) => allocation.taskId === taskId)) {
    return [...allocations, { taskId, cpu }];
  }
  return allocations.map((allocation) =>
    allocation.taskId === taskId ? { taskId, cpu } : allocation,
  );
}

/** `del self.cpu_usage[tech.id]` (`player.py:387`), for every Tech that finished this Tick. */
export function withoutAllocations(
  allocations: readonly CpuAllocation[],
  taskIds: readonly string[],
): readonly CpuAllocation[] {
  if (taskIds.length === 0) return allocations;
  const removed = new Set(taskIds);
  return allocations.filter((allocation) => !removed.has(allocation.taskId));
}
