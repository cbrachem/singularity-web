/**
 * Tasks: what CPU can be pointed at, and what the current job pays.
 *
 * Upstream memoises the current task per type in a module dictionary that a tech completion
 * clears (`task.py:26`). The port derives it instead — module-level mutable state is what the
 * seam was drawn to be free of — and the scan is over five tasks.
 */

import { content } from "./content/index.ts";
import { isAvailable, type FinishedTechs } from "./availability.ts";
import { floorDiv } from "./pynum.ts";

export const JOBS = "jobs";
export const CPU_POOL = "cpu_pool";

/**
 * `task.get_current` (`task.py:47`): the last available task of a type, which is the best one
 * because the data file lists them in ascending order.
 */
export function currentTask(type: string, finished: FinishedTechs) {
  const ofType = content.tasks.all.filter((task) => task.type === type);
  for (let index = ofType.length - 1; index >= 0; index -= 1) {
    const task = ofType[index];
    if (task && isAvailable(task.prerequisites, finished)) return task;
  }
  return undefined;
}

/** `Task.get_profit` (`task.py:66`): cash per CPU-second, through the job bonus. */
export function jobProfit(finished: FinishedTechs, jobBonus: number): number {
  const task = currentTask(JOBS, finished);
  if (!task || task.type !== JOBS) return 0;
  return floorDiv(task.value * jobBonus, 10000);
}

/**
 * `task.danger_for` (`task.py:41`): the danger level a task's CPU has to be safe against.
 * The two pseudo-tasks are safe everywhere.
 */
export function dangerFor(taskId: string): number {
  if (taskId === JOBS || taskId === CPU_POOL) return 0;
  const tech = content.techs.byId.get(taskId);
  if (!tech) throw new Error(`unknown task ${taskId}`);
  return tech.danger;
}
