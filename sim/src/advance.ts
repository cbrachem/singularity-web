/**
 * `Player.give_time` (`player.py:255`): one Tick.
 *
 * The Simulation's single synchronous entry point. It advances game time by a
 * whole number of game-seconds, never calls out, and returns a new State root every time —
 * so Presentation can hold the previous one and use reference equality as its change check.
 *
 * # What is ported, and what refuses
 *
 * This slice covers a game either side of the grace period: the clock and its midnight
 * break, interest, income, the sub-day cash accumulator, both attempts at paying maintenance,
 * research and the CPU pool, base and item construction, the statistics counter, day rollover
 * and the autosave request — and then, once grace is lost, the warning and its pause request,
 * the detection and maintenance rolls, the removal of whatever they condemn, event checking,
 * and the expiry of a triggered event at midnight.
 *
 * The last slice closes the loop: a base's power state decides what its CPU is worth, jobs
 * are worked twice — from their own allocation before research and from whatever the pool has
 * left afterwards — apotheosis stops maintenance being owed at all, and the game can now be
 * won as well as lost. Nothing in the tick is a refusal any more.
 */

import { AUTOSAVE, PAUSE, storyEffect, type Effect } from "./effect.ts";
import { content } from "./content/index.ts";
import { allocatedCpuFor, recalcCpu, withoutAllocations } from "./cpu.ts";
import { checkDeadBases, removeBases } from "./detection.ts";
import { applyConsequence, checkEvents, expireEvents } from "./gameevent.ts";
import { decayRate } from "./group.ts";
import { finishedTechs } from "./availability.ts";
import { finishBase, finishItem } from "./base.ts";
import { finished, workOn } from "./buyable.ts";
import { locationModifiers } from "./location.ts";
import {
  MAX_CASH,
  SECONDS_PER_DAY,
  currentShare,
  rawDays,
  rawMinutes,
  timeOfDay,
} from "./clock.ts";
import { divMod, floorDiv, truncate } from "./pynum.ts";
import { CPU_POOL, JOBS, jobProfit } from "./task.ts";
import { withCash, withUsedCpu } from "./statistics.ts";
import {
  CASH,
  CPU,
  ITEM_SLOTS,
  appendLog,
  type BaseState,
  type ItemSlot,
  type ItemState,
  type LocationState,
  type LogEntry,
  type SimulationState,
  type TechState,
} from "./state.ts";

export interface AdvanceResult {
  readonly state: SimulationState;
  readonly effects: readonly Effect[];
}

const NO_EFFECTS: readonly Effect[] = Object.freeze([]);

/** The story section the tick that loses the grace period asks the Host to show. */
export const GRACE_WARNING = "Grace Warning";

export function advance(state: SimulationState, gameSeconds: number): AdvanceResult {
  if (!Number.isInteger(gameSeconds) || gameSeconds < 0) {
    throw new RangeError(
      `advance expects a whole, non-negative number of game-seconds, got ${gameSeconds}`,
    );
  }

  // The generator is copied once per Tick, not once per draw: the rules that follow mutate
  // it as they roll, and the State root the previous Tick handed out must not move
  // underneath whoever is still holding it.
  let next: SimulationState = { ...state, rng: state.rng.clone() };
  if (gameSeconds === 0) return { state: next, effects: NO_EFFECTS };

  // The midnight break is preserved, the remainder is not discarded — deviation 1 of the
  // register. Upstream truncates a day-crossing tick to 00:00:00 and drops what
  // is left; the port breaks at the boundary and keeps going, which also defines the
  // `days_passed > 1` branch upstream leaves unreachable.
  //
  // Each turn of the loop is one `give_time` call with what is left to consume, which is
  // also what fixes the seconds event checking rolls against: upstream rolls against the
  // seconds it was *asked* for rather than the ones the midnight break let it advance
  // (`player.py:441`), so a tick cut short at midnight still rolls the interval that was
  // requested of it. Only a Scenario reaches that; the scheduler never asks across a
  // boundary.
  const effects: Effect[] = [];
  let remaining = gameSeconds;
  while (remaining > 0) {
    const untilMidnight = SECONDS_PER_DAY - timeOfDay(next.gameTime);
    const span = Math.min(remaining, untilMidnight);
    const tick = runTick(next, span, remaining);
    next = tick.state;
    effects.push(...tick.effects);
    remaining -= span;
  }

  return { state: next, effects: effects.length === 0 ? NO_EFFECTS : effects };
}

function runTick(
  before: SimulationState,
  seconds: number,
  requestedSeconds: number,
): AdvanceResult {
  const oldTime = before.gameTime;
  const gameTime = oldTime + seconds;
  const dayPassed = rawDays(gameTime) !== rawDays(oldTime);
  const secondsIntoDay = timeOfDay(gameTime);
  const minutesPassed = rawMinutes(gameTime) - rawMinutes(oldTime);

  let state: SimulationState = { ...before, gameTime, cpuPool: 0 };

  // Maintenance, collected before anything is spent, and **only from finished bases**: a base
  // under construction owes nothing and its items are not worked on at all, because upstream
  // sorts the estate into the two lists here and a base only reaches the second one once it
  // is done (`player.py:294-303`).
  let maintenanceCash = 0;
  let maintenanceCpu = 0;
  const itemsUnderConstruction: ItemSite[] = [];
  for (const [locationIndex, location] of state.locations.entries()) {
    for (const [baseIndex, base] of location.bases.entries()) {
      if (!base.buyable.done) continue;
      for (const slot of ITEM_SLOTS) {
        const item = base.items[slot];
        if (item && !item.buyable.done) {
          itemsUnderConstruction.push({ locationIndex, baseIndex, slot });
        }
      }
      maintenanceCash += base.maintenance[CASH];
      maintenanceCpu += base.maintenance[CPU];
    }
  }
  // Gods do not pay maintenance.
  if (state.apotheosis) {
    maintenanceCash = 0;
    maintenanceCpu = 0;
  }

  state = doInterest(state, seconds);
  state = doIncome(state, seconds);

  // CPU explicitly pointed at jobs earns before the pool does.
  state = doJobs(state, allocatedCpuFor(state, JOBS) * seconds);

  let unpaidCash = currentShare(truncate(maintenanceCash), secondsIntoDay, seconds);
  ({ state, unpaid: unpaidCash } = payMaintenance(state, unpaidCash));

  // Research and the CPU pool (`player.py:335-348`), in one loop and in allocation order.
  //
  // Three things about it are behaviour rather than arrangement. A tech's CPU is *added to
  // the pool and then spent from it*, so the accounting nets out while the tech itself stays
  // capped at its own allocation — it can never reach past that into what the rest of the
  // pool holds. The **full** cash balance is offered to every tech in turn and each deducts
  // what it spends immediately, so the allocation order decides who is paid when there is not
  // enough for everybody. And the CPU nobody asked for lands in the pool **last**, after
  // research has already run, so it is construction and jobs that get it and never a tech.
  const allocations = state.cpuUsage;
  const researched: string[] = [];
  // What a finishing tech had to tell the Host. Collected here because a consequence runs
  // where the rule that carries it runs — the win is announced from inside the research loop,
  // before anything later in the tick can speak (`./gameevent.ts`).
  const researchEffects: Effect[] = [];
  let cpuPool = 0;
  let defaultCpu = state.availableCpus[0] as number;
  for (const { taskId, cpu } of allocations) {
    if (cpu <= 0) continue;
    defaultCpu -= cpu;
    if (taskId === JOBS) continue;
    const realCpu = cpu * seconds;
    cpuPool += realCpu;
    if (taskId === CPU_POOL) continue;

    const work = researchTech(state, taskId, realCpu, minutesPassed);
    cpuPool -= work.spentCpu;
    state = work.state;
    researchEffects.push(...work.effects);
    if (work.complete) researched.push(taskId);
  }
  cpuPool += defaultCpu * seconds;

  let unpaidCpu = maintenanceCpu * seconds;
  if (unpaidCpu > cpuPool) {
    unpaidCpu -= cpuPool;
    cpuPool = 0;
  } else {
    cpuPool -= truncate(unpaidCpu);
    unpaidCpu = 0;
  }
  state = { ...state, cpuPool };

  // Construction, which is what is left of the pool spent on the estate. Bases first, then
  // the items inside the finished ones — the order is upstream's and it decides which of the
  // two gets the pool when there is not enough for both.
  const built = constructBases(state, minutesPassed);
  state = built.state;
  const installed = constructItems(state, itemsUnderConstruction, minutesPassed);
  state = installed.state;

  if (state.cpuPool > 0) state = doJobs(state, state.cpuPool);

  ({ state, unpaid: unpaidCash } = payMaintenance(state, unpaidCash));
  state = withCash(state, Math.min(state.cash, MAX_CASH));

  state = withUsedCpu(state, state.usedCpu + (state.availableCpus[0] as number) * seconds);

  // What finished this tick writes its log entry here rather than where it finished, and
  // asks for the recount that closes the tick (`player.py:386-412`). Techs first, then the
  // bases, then the items, which is upstream's order and therefore the log's. A researched
  // tech also loses its allocation here — in the completion phase, not where it finished, so
  // the rest of the tick's research ran against the allocations the tick began with.
  let needRecalcCpu =
    researched.length + built.constructed.length + installed.constructed.length > 0;
  if (needRecalcCpu) {
    const entries = [
      ...researched.map((techId) => techResearchedLog(state.gameTime, techId)),
      ...built.constructed.map((base) => baseConstructedLog(state.gameTime, base)),
      ...installed.constructed.map((item) => itemConstructedLog(state.gameTime, item)),
    ];
    state = {
      ...state,
      cpuUsage: withoutAllocations(state.cpuUsage, researched),
      log: appendLog(state.log, entries),
    };
  }

  const effects: Effect[] = [...researchEffects];

  // The tick that loses the grace period asks the Host to pause and shows the warning, once
  // and only once: `had_grace` is cleared here, so the branch cannot be re-entered. Both are
  // observable *only* as Effects, which is why a state-only Trace would never check them.
  const grace = inGracePeriod(state);
  if (state.hadGrace && !grace) {
    state = { ...state, hadGrace: false };
    effects.push(PAUSE, storyEffect(GRACE_WARNING));
  }

  // From the same tick on, every base is exposed: detection rolls per group per base, and a
  // shortfall in maintenance rolls for destruction. Both draw, and what either one condemns
  // is taken out of the game in the same phase — which is also the tick's fourth reason to
  // recount the player's CPU (`player.py:434`).
  const dying = checkDeadBases(state, { grace, unpaidCash, unpaidCpu, secondsIntoDay, seconds });
  state = dying.state;
  if (dying.condemned.length > 0) {
    const removed = removeBases(state, dying.condemned);
    state = removed.state;
    effects.push(...removed.effects);
    needRecalcCpu = true;
  }

  if (!grace) {
    const checked = checkEvents(state, requestedSeconds);
    state = checked.state;
    effects.push(...checked.effects);
  }

  if (dayPassed) {
    const day = newDay(state);
    state = day.state;
    // Upstream saves from inside `new_day`; the port asks the Host to, at the end of the
    // tick. Deviation 3 of the register, cancelled by a Normalisation.
    if (day.autosave) effects.push(AUTOSAVE);
  }

  // The recount that closes the tick, after everything that could have moved what it counts.
  // It is not the only one a completed base triggers — `Base.finish` re-checks the power
  // state and recounts there too (`base.py:286`), one tick position earlier, which is what
  // the `used_cpu` statistic above is measured against.
  if (needRecalcCpu) state = recalcCpu(state);

  return { state, effects };
}

/** What one turn of the research loop took out of the pool, and whether it finished a tech. */
interface Research {
  readonly state: SimulationState;
  /** Taken back out of the pool the allocation was just added to (`buyable.py:203`). */
  readonly spentCpu: number;
  readonly complete: boolean;
  /** What the finished tech's consequence had to say — the win, and nothing else. */
  readonly effects: readonly Effect[];
}

/**
 * One tech worked on for one tick — `Tech.work_on` (`buyable.py:194`) and, when it finishes,
 * `Tech.finish` (`tech.py:81`).
 *
 * The CPU on offer is the tech's *own* allocation rather than the pool, which is what stops a
 * tech from drawing on what everything else put there; the cash on offer is the whole
 * balance, which is what makes the allocation order matter. What is spent comes out of both
 * immediately, so the tech after this one sees what is left.
 *
 * A tech that is already done is worked on by nobody — upstream's `work_on` returns at once
 * (`buyable.py:198`) — but its allocation still reaches the pool, so pointing CPU at a
 * finished tech is a roundabout way of pointing it at the pool. Reproduced, not tidied.
 *
 * Finishing triggers the tech's consequence *here*, in the middle of the loop, not in the
 * completion phase: a tech that moves the job bonus moves it for the jobs the same tick's
 * pool goes on to work.
 */
function researchTech(
  state: SimulationState,
  techId: string,
  cpuAvailable: number,
  minutesPassed: number,
): Research {
  const index = state.techs.findIndex((tech) => tech.specId === techId);
  const tech = state.techs[index];
  if (!tech) throw new Error(`no such tech: ${techId}`);
  if (tech.buyable.done) return { state, spentCpu: 0, complete: false, effects: NO_EFFECTS };

  const work = workOn(tech.buyable, [state.cash, cpuAvailable, minutesPassed]);
  const paid = withCash(
    withTech(state, index, { ...tech, buyable: work.buyable }),
    state.cash - work.spent[CASH],
  );
  if (!work.complete) {
    return { state: paid, spentCpu: work.spent[CPU], complete: false, effects: NO_EFFECTS };
  }

  const spec = content.techs.byId.get(techId);
  if (!spec) throw new Error(`no such tech: ${techId}`);
  let next = withTech(paid, index, { ...tech, buyable: finished(work.buyable) });
  next = { ...next, stats: { ...next.stats, techCreated: next.stats.techCreated + 1 } };
  const applied = applyConsequence(next, spec.effectStack, 1);
  return {
    state: applied.state,
    spentCpu: work.spent[CPU],
    complete: true,
    effects: applied.effects,
  };
}

function withTech(state: SimulationState, index: number, tech: TechState): SimulationState {
  return { ...state, techs: state.techs.map((was, at) => (at === index ? tech : was)) };
}

/** `LogResearchedTech` (`logmessage.py:207`), in the port's structured shape. */
export const TECH_RESEARCHED = "tech-researched";

function techResearchedLog(rawEmitTime: number, techId: string): LogEntry {
  return { kind: TECH_RESEARCHED, rawEmitTime, fields: { tech_id: techId } };
}

/** One base that finished this tick, named for the log entry that says so. */
interface Constructed {
  readonly name: string;
  readonly specId: string;
  readonly locationId: string;
}

/**
 * `Player.give_time`'s base construction loop (`player.py:355`): every base still being
 * built is worked on in turn, in `g.all_bases()` order — location order, then the order the
 * bases were added.
 *
 * The order is contract twice over. Each base is offered what is *left* of the cash and the
 * CPU pool, so an earlier base takes what a later one then cannot have; and a base that
 * finishes recounts the player's CPU where it finished, which the `used_cpu` statistic later
 * in the tick is measured against.
 */
function constructBases(
  state: SimulationState,
  minutesPassed: number,
): { readonly state: SimulationState; readonly constructed: readonly Constructed[] } {
  const constructed: Constructed[] = [];
  let next = state;

  for (const [locationIndex, location] of state.locations.entries()) {
    for (const [baseIndex, original] of location.bases.entries()) {
      if (original.buyable.done) continue;

      const work = workOn(original.buyable, [next.cash, next.cpuPool, minutesPassed]);
      next = withCash(
        { ...next, cpuPool: next.cpuPool - work.spent[CPU] },
        next.cash - work.spent[CASH],
      );

      const paid: BaseState = { ...original, buyable: work.buyable };
      if (!work.complete) {
        next = replaceBase(next, locationIndex, baseIndex, paid);
        continue;
      }

      const modifiers = locationModifiers(next.regions, location.specId);
      next = replaceBase(next, locationIndex, baseIndex, finishBase(paid, modifiers));
      next = { ...next, stats: { ...next.stats, baseCreated: next.stats.baseCreated + 1 } };
      // `Base.finish` → `check_power` → `Player.recalc_cpu` (`base.py:286`): a base that has
      // just been switched on by finishing is counted before the tick goes any further.
      next = recalcCpu(next);
      constructed.push({
        name: paid.name,
        specId: paid.specId,
        locationId: location.specId,
      });
    }
  }

  return { state: next, constructed };
}

/** Where one unfinished item sits, fixed at the top of the tick. */
interface ItemSite {
  readonly locationIndex: number;
  readonly baseIndex: number;
  readonly slot: ItemSlot;
}

/** One item that finished this tick, named for the log entry that says so. */
interface ConstructedItem {
  readonly specId: string;
  readonly count: number;
  readonly baseName: string;
  readonly baseSpecId: string;
  readonly locationId: string;
}

/**
 * `Player.give_time`'s item construction loop (`player.py:363`), which runs **after** the
 * bases have already drawn from the pools and is offered whatever they left.
 *
 * Two orderings are contract. The sites were collected at the top of the tick from the bases
 * that were *finished* then, so a base that finishes during this very tick has its items
 * left alone until the next one — an item is worked on only once its base is done. And the
 * sites are in `(base, slot)` order, which decides who is paid when there is not enough for
 * everybody, exactly as the base loop's order does.
 *
 * A finished item recounts the player's CPU where it finished rather than at the end of the
 * tick, which the `used_cpu` statistic later in the tick is measured against.
 */
function constructItems(
  state: SimulationState,
  sites: readonly ItemSite[],
  minutesPassed: number,
): { readonly state: SimulationState; readonly constructed: readonly ConstructedItem[] } {
  const constructed: ConstructedItem[] = [];
  let next = state;

  for (const { locationIndex, baseIndex, slot } of sites) {
    const location = next.locations[locationIndex] as LocationState;
    const base = location.bases[baseIndex] as BaseState;
    const item = base.items[slot] as ItemState;

    const work = workOn(item.buyable, [next.cash, next.cpuPool, minutesPassed]);
    next = withCash(
      { ...next, cpuPool: next.cpuPool - work.spent[CPU] },
      next.cash - work.spent[CASH],
    );

    const paid: BaseState = {
      ...base,
      items: { ...base.items, [slot]: { ...item, buyable: work.buyable } },
    };
    if (!work.complete) {
      next = replaceBase(next, locationIndex, baseIndex, paid);
      continue;
    }

    const modifiers = locationModifiers(next.regions, location.specId);
    next = replaceBase(next, locationIndex, baseIndex, finishItem(paid, slot, modifiers));
    next = { ...next, stats: { ...next.stats, itemCreated: next.stats.itemCreated + 1 } };
    // `Item.finish` → `Base.check_power` → `Player.recalc_cpu` (`item.py:243`, `base.py:286`).
    next = recalcCpu(next);
    constructed.push({
      specId: item.specId,
      count: item.buyable.count,
      baseName: base.name,
      baseSpecId: base.specId,
      locationId: location.specId,
    });
  }

  return { state: next, constructed };
}

function replaceBase(
  state: SimulationState,
  locationIndex: number,
  baseIndex: number,
  base: BaseState,
): SimulationState {
  return {
    ...state,
    locations: state.locations.map((location, at) =>
      at === locationIndex
        ? {
            ...location,
            bases: location.bases.map((was, index) => (index === baseIndex ? base : was)),
          }
        : location,
    ),
  };
}

/** `LogBaseConstructed` (`logmessage.py:274`), in the port's structured shape. */
export const BASE_CONSTRUCTED = "base-constructed";

function baseConstructedLog(rawEmitTime: number, base: Constructed): LogEntry {
  return {
    kind: BASE_CONSTRUCTED,
    rawEmitTime,
    fields: {
      base_name: base.name,
      base_type_id: base.specId,
      base_location_id: base.locationId,
    },
  };
}

/** `LogItemConstructionComplete` (`logmessage.py:414`), in the port's structured shape. */
export const ITEM_CONSTRUCTED = "item-in-base-constructed";

function itemConstructedLog(rawEmitTime: number, item: ConstructedItem): LogEntry {
  return {
    kind: ITEM_CONSTRUCTED,
    rawEmitTime,
    fields: {
      item_spec_id: item.specId,
      item_count: item.count,
      base_name: item.baseName,
      base_type_id: item.baseSpecId,
      base_location_id: item.locationId,
    },
  };
}

/** `Player.do_interest` (`player.py:194`). */
function doInterest(state: SimulationState, seconds: number): SimulationState {
  return accrue(state, interest(state) * seconds);
}

/** `Player.do_income` (`player.py:205`). */
function doIncome(state: SimulationState, seconds: number): SimulationState {
  return accrue(state, state.income * seconds);
}

/** `Player.do_jobs` (`player.py:216`), through `get_job_info`. */
function doJobs(state: SimulationState, cpuTime: number): SimulationState {
  const cashPerCpu = jobProfit(finishedTechs(state.techs), state.jobBonus);
  return accrue(state, cashPerCpu * cpuTime);
}

/**
 * The sub-day cash accumulator: everything that earns adds cash-seconds, and only whole days
 * of them become cash. Carrying the remainder is what keeps a day's earnings the same
 * however the day was partitioned into ticks.
 */
function accrue(state: SimulationState, cashSeconds: number): SimulationState {
  const raw = state.partialCash + cashSeconds;
  const [earned, partialCash] = divMod(raw, SECONDS_PER_DAY);
  return withCash({ ...state, partialCash }, state.cash + earned);
}

/**
 * `Player.get_interest` (`player.py:564`).
 *
 * Exported because the resource-flow Projection asks the same question of a state it is not
 * advancing (`./flow.ts`), and one spelling of a rule is the whole point of having a rule.
 */
export function interest(state: SimulationState): number {
  return truncate(floorDiv(state.interestRate * state.cash, 10000));
}

/**
 * One of the two attempts at paying the tick's cash maintenance. Both run: the first before
 * anything is earned from the CPU pool, the second after — which is what lets a base survive
 * on money the same tick made.
 */
function payMaintenance(
  state: SimulationState,
  unpaid: number,
): { readonly state: SimulationState; readonly unpaid: number } {
  if (unpaid > state.cash) return { state: withCash(state, 0), unpaid: unpaid - state.cash };
  return { state: withCash(state, state.cash - unpaid), unpaid: 0 };
}

/** `Player.in_grace_period` (`player.py:530`). */
export function inGracePeriod(state: SimulationState): boolean {
  if (state.apotheosis) return true;
  if (!state.hadGrace) return false;
  if (rawDays(state.gameTime) >= 23) return false;

  const gracePeriodCpu = difficulty(state).gracePeriodCpu;
  if (gracePeriodCpu < 0) return true;
  return gracePeriodCpu * SECONDS_PER_DAY >= state.usedCpu;
}

/** `Player.lost_game` (`player.py:751`) — 0 is still alive. */
export function lostGame(state: SimulationState): number {
  if (state.apotheosis) return 0;
  if (state.groups.some((group) => group.suspicion > 10000)) return 2;
  if ((state.availableCpus[0] as number) + state.sleepingCpus === 0) return 1;
  return 0;
}

/** `Player.new_day` (`player.py:568`), run at midnight. */
function newDay(state: SimulationState): {
  readonly state: SimulationState;
  readonly autosave: boolean;
} {
  const groups = state.groups.map((group) => ({
    ...group,
    suspicion: Math.max(group.suspicion - decayRate(group), 0),
  }));

  // Groups first, then the Events that have outlived their duration — which undoes what they
  // did to the groups the line above just decayed, in upstream's order (`player.py:568-573`).
  let next: SimulationState = expireEvents({ ...state, groups });
  const day = rawDays(next.gameTime);
  const autosave = next.lastAutosaveDay + AUTO_SAVE_EVERY_X_DAYS < day + 1 && lostGame(next) === 0;
  if (autosave) next = { ...next, lastAutosaveDay: day };
  return { state: next, autosave };
}

const AUTO_SAVE_EVERY_X_DAYS = 3;

function difficulty(state: SimulationState) {
  const spec = content.difficulties.byId.get(state.difficulty);
  if (!spec) throw new Error(`no such difficulty: ${state.difficulty}`);
  return spec;
}
