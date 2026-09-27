/**
 * The two statistics that count a *rise* rather than a value.
 *
 * `stats.observe` (`stats.py:76`) wraps `cash` and `used_cpu` in a property that adds any
 * positive change to a counter. Assigning the field is therefore not the same as setting it,
 * and every place the rules move cash goes through here — a plain assignment would be a
 * silently wrong statistic rather than a compile error.
 */

import type { SimulationState } from "./state.ts";

export function withCash(state: SimulationState, cash: number): SimulationState {
  const change = cash - state.cash;
  return {
    ...state,
    cash,
    stats:
      change > 0 ? { ...state.stats, cashEarned: state.stats.cashEarned + change } : state.stats,
  };
}

export function withUsedCpu(state: SimulationState, usedCpu: number): SimulationState {
  const change = usedCpu - state.usedCpu;
  return {
    ...state,
    usedCpu,
    stats: change > 0 ? { ...state.stats, cpuUsed: state.stats.cpuUsed + change } : state.stats,
  };
}
