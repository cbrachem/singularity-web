/**
 * `Player.compute_future_resource_flow` (`player.py:770`): where cash and the CPU pool go
 * over the next day, given everything under construction, every allocation, jobs, income and
 * interest.
 *
 * It is a **Projection**: a pure computation over the State root that answers a
 * hypothetical and changes nothing. Presentation calls it — the HUD for the flow it shows
 * with each pool (`screens/map.py:824`), the build dial for what an order would do to it.
 *
 * # Why the hypothetical is a parameter
 *
 * Upstream writes what a dialog is offering onto `Player._considered_buyables` and the
 * routine reads the field back out (`player.py:841`) — the build dialog writes fake bases
 * (`screens/location.py:415`), the item dialogs write a plain buyable for the item they are
 * showing (`screens/base.py:103`, `:182`, `:446`).
 * The port has no such write: what the player is considering arrives as an argument,
 * so the answer depends on nothing a dialog left behind, and the Projection is testable
 * against the reference at the trace seam rather than only by opening a screen.
 *
 * # Why it lives in `sim/`
 *
 * The rules it reads are the Simulation's — the construction kernel, the job rate, interest,
 * what a base owes in maintenance — and upstream keeps it on `Player` rather than in a
 * screen. That is the same test `app/src/ui/estate.ts` applies in the other direction: the
 * build affordance's availability and last-active-base rules are Presentation's *because*
 * upstream keeps them in a screen. Nothing here is a Command and nothing here is text.
 *
 * # What it is not
 *
 * It is not a Tick and it is not compared as one. The numbers are an average over the window
 * and go wrong when the rates move inside it, which is upstream's own caveat and is carried
 * rather than corrected: the routine is what upstream's own screens read, so what a player
 * sees is bound to it. Interest is included here even though the docstring calls
 * it a known omission — the code adds it, and the code is the specification.
 */

import { finishedTechs } from "./availability.ts";
import { interest } from "./advance.ts";
import { newBuyable, specCost, workOn } from "./buyable.ts";
import { SECONDS_PER_DAY, SECONDS_PER_MINUTE } from "./clock.ts";
import { locationModifiers, modifyCost } from "./location.ts";
import { divMod, floorDiv } from "./pynum.ts";
import { CPU_POOL, JOBS, jobProfit } from "./task.ts";
import type { BaseType, Item } from "./content/types.ts";
import { CASH, CPU, allBases, allItems, type BuyableState, type SimulationState } from "./state.ts";

/** The cash half of the dry run — every term that moves the balance, and their sum. */
export interface CashFlow {
  readonly interest: number;
  readonly income: number;
  readonly jobs: number;
  readonly tech: number;
  readonly maintenanceNeeded: number;
  readonly constructionNeeded: number;
  /** What the balance moves by over the window: the one figure the HUD shows. */
  readonly difference: number;
}

/**
 * The CPU half, in **CPU**, not in CPU-seconds — a day of one CPU is one, whichever side of
 * the sum it comes from. That is why the two figures that accumulate CPU-seconds are divided
 * by a day on the way out and the ones that count CPU are not.
 */
export interface CpuFlow {
  /** CPU in bases that are asleep: present, and worth nothing until they are woken. */
  readonly sleeping: number;
  /** Everything the estate runs, asleep included — the figure the HUD shows as the pool. */
  readonly total: number;
  /** CPU the player pointed at jobs deliberately, as opposed to what the pool spills into them. */
  readonly explicitJobs: number;
  readonly tech: number;
  readonly effectivePool: number;
  /** CPU-days: what everything under construction would take if it could have it. */
  readonly constructionNeeded: number;
  readonly maintenanceNeeded: number;
  /** CPU-days: what the pool is left with, and the one figure the HUD shows. */
  readonly difference: number;
}

export interface ResourceFlow {
  readonly cash: CashFlow;
  readonly cpu: CpuFlow;
}

/** Nothing is being considered — the HUD's own call, and the default. */
const NOTHING_CONSIDERED: readonly BuyableState[] = Object.freeze([]);

/**
 * What an order of `quantity` bases of this type at this location would be, as buyables the
 * Projection can be handed: upstream's `Base("<Undecided>", spec)` put through
 * `Location.modify_base` (`screens/location.py:411`, `location.py:199`).
 *
 * **One buyable per base ordered, never one carrying a count.** The Projection walks the
 * queue and takes CPU out of the same pool for each entry in turn, so five of them is not
 * one of them multiplied by five — and `newBuyable`'s own count divides labor back out,
 * which is right for five computers in one base and wrong for five separate bases.
 */
export function consideredBases(
  state: SimulationState,
  locationId: string,
  spec: BaseType,
  quantity: number,
): readonly BuyableState[] {
  const modifiers = locationModifiers(state.regions, locationId);
  const cost = modifyCost(specCost(spec.cost, state.laborBonus), modifiers);
  return Array.from({ length: quantity }, () => newBuyable(cost));
}

/**
 * What an order of `quantity` of this item would be, as the buyable the Projection can be
 * handed: upstream's `buyable.Buyable(item_spec, count=quantity)` (`screens/base.py:103`,
 * `:182`, `:446`).
 *
 * **One buyable carrying the count, where an order of bases is one buyable per base.** That
 * is upstream's own shape and it is the right one: `newBuyable` divides the labor
 * multiplication back out, so five computers bought into one slot cost five times the cash
 * and take as long to install as one — where five separate bases each take their own time,
 * and each takes CPU out of the pool in turn.
 *
 * The location's modifiers do not reach it, which is the other half of the difference.
 * `Location.modify_base` touches the base's own cost and nothing inside it
 * (`location.py:199`), so an item costs the same wherever it is installed and the item
 * dialogs write the spec's cost unmodified.
 */
export function consideredItems(
  state: SimulationState,
  spec: Item,
  quantity: number,
): readonly BuyableState[] {
  return [newBuyable(specCost(spec.cost, state.laborBonus), quantity)];
}

/**
 * The dry run, over the next day.
 *
 * `considered` is the hypothetical: buyables the player is looking at but has not ordered.
 * They join the construction queue **after** everything already under construction, which is
 * where upstream appends them and therefore what CPU is left for them by the time the queue
 * reaches them.
 *
 * **The window is a day and is not a parameter.** Upstream's is, and its one caller passes
 * `g.seconds_per_day` (`screens/map.py:824`), which is also its default — so the parameter
 * defers a decision nobody has ever taken differently, and carrying it here would be the
 * signature transcribed one field too far. What the parameter bought is
 * the `time_fraction` the routine multiplies most of its output by; at a whole day that
 * factor is exactly 1, and it is folded away rather than written out as a multiplication by
 * one. A caller that wants a second window puts both back, together.
 */
export function resourceFlow(
  state: SimulationState,
  considered: readonly BuyableState[] = NOTHING_CONSIDERED,
): ResourceFlow {
  const construction: BuyableState[] = [];
  let maintenanceCash = 0;
  let maintenanceCpu = 0;

  // The estate splits in two, exactly as the Tick splits it: a base that is not finished is
  // itself the thing being built and owes no maintenance; a finished one owes, and what is
  // being built inside it is its unfinished items (`player.py:294`).
  for (const base of allBases(state)) {
    if (!base.buyable.done) {
      construction.push(base.buyable);
      continue;
    }
    for (const item of allItems(base)) {
      if (!item.buyable.done) construction.push(item.buyable);
    }
    maintenanceCash += base.maintenance[CASH];
    maintenanceCpu += base.maintenance[CPU];
  }
  if (state.apotheosis) {
    maintenanceCash = 0;
    maintenanceCpu = 0;
  }

  // `mins_forwarded`: the labor a day offers construction, which is what caps a buyable with
  // a labor cost however much cash and CPU are lying around (`buyable.ts`, `workOn`).
  const minutesForwarded = floorDiv(SECONDS_PER_DAY, SECONDS_PER_MINUTE);

  // The CPU half of maintenance is charged after the pool is known, so only cash starts the
  // sum here.
  let cpuFlow = 0;
  let cashFlow = -maintenanceCash;

  let jobCpu = 0;
  let cpuLeft = state.availableCpus[0] ?? 0;
  let techCash = 0;
  let techCpuAssigned = 0;
  let explicitJobCpu = 0;

  for (const { taskId, cpu } of state.cpuUsage) {
    // `Player.get_cpu_allocations` (`player.py:235`) yields only what is actually allocated.
    if (cpu <= 0) continue;
    cpuLeft -= cpu;
    const realCpu = cpu * SECONDS_PER_DAY;

    if (taskId === CPU_POOL) {
      cpuFlow += realCpu;
    } else if (taskId === JOBS) {
      explicitJobCpu += cpu;
      jobCpu += realCpu;
    } else {
      const tech = state.techs.find((candidate) => candidate.specId === taskId);
      if (!tech) throw new Error(`no such tech: ${taskId}`);
      const left = tech.buyable.costLeft;
      techCash += workOn(tech.buyable, [left[CASH], realCpu, minutesForwarded]).spent[CASH];
      techCpuAssigned += cpu;
    }
  }

  cashFlow -= techCash;
  cpuFlow += cpuLeft * SECONDS_PER_DAY;
  let availableCpuPool = cpuFlow;
  const effectiveCpuPool = availableCpuPool / SECONDS_PER_DAY;
  cpuFlow -= maintenanceCpu * SECONDS_PER_DAY;

  let constructionCash = 0;
  let constructionCpuDesired = 0;
  for (const buyable of [...construction, ...considered]) {
    const left = buyable.costLeft;
    // Twice, deliberately, and upstream says why: once for the CPU the thing *wants*, and
    // once for the cash it would actually draw out of the pool that is really there. In
    // optimal conditions the two agree; short of CPU they do not, and the estimate is
    // supposed to show that.
    const wanted = workOn(buyable, [left[CASH], left[CPU], minutesForwarded]).spent;
    constructionCpuDesired += wanted[CPU];

    const afforded = workOn(buyable, [left[CASH], availableCpuPool, minutesForwarded]).spent;
    constructionCash += afforded[CASH];
    availableCpuPool -= afforded[CPU];
  }

  cpuFlow -= constructionCpuDesired;
  cashFlow -= constructionCash;

  // Whatever the pool has left over works jobs, which is the Tick's own second pass at them.
  if (cpuFlow > 0) jobCpu += cpuFlow;

  const jobEarnings = jobInfo(state, jobCpu);
  cashFlow += jobEarnings;
  cashFlow += state.income;
  const interestEarned = interest(state);
  cashFlow += interestEarned;
  cpuFlow /= SECONDS_PER_DAY;

  return {
    cash: {
      interest: interestEarned,
      income: state.income,
      jobs: jobEarnings,
      tech: techCash,
      maintenanceNeeded: maintenanceCash,
      constructionNeeded: constructionCash,
      difference: cashFlow,
    },
    cpu: {
      sleeping: state.sleepingCpus,
      total: (state.availableCpus[0] ?? 0) + state.sleepingCpus,
      explicitJobs: explicitJobCpu,
      tech: techCpuAssigned,
      effectivePool: effectiveCpuPool,
      constructionNeeded: constructionCpuDesired / SECONDS_PER_DAY,
      maintenanceNeeded: maintenanceCpu,
      difference: cpuFlow,
    },
  };
}

/**
 * `Player.get_job_info` (`player.py:221`) with `partial_cash=0`, and the fraction of a day's
 * earnings put back on — the projection wants the rate, not the whole units the Tick banks.
 */
function jobInfo(state: SimulationState, cpuTime: number): number {
  const cashPerCpu = jobProfit(finishedTechs(state.techs), state.jobBonus);
  const [earned, partial] = divMod(cashPerCpu * cpuTime, SECONDS_PER_DAY);
  return earned + partial / SECONDS_PER_DAY;
}
