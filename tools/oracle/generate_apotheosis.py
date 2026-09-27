"""Write the winning Scenario by playing the reference to a win, once, offline.

    .venv/bin/python -m tools.oracle.generate_apotheosis --out scenarios/apotheosis.scenario.json

**This is not a verification tool and must never run at verification time.** A Scenario is
data: the same committed script drives the port and drives the reference, and that is the
whole of what makes a Trace comparison mean anything (`tools/trace/scenario.py`).
So this runs by hand, its output is committed, and nothing under `tools/trace/`, `sim/` or
`app/` names it — a rule the trace-seam suite holds rather than this docstring.

`generate_long_play.py` is this tool's sibling and its opposite: that policy is greedy and
loses, this plan is competent and wins. Both were run once; only their output is a fixture.

## The plan

Six moves, and nearly every number under them read from the reference rather than written
here:

1. **Bootstrap.** Day 0 puts `BOOTSTRAP_BASES` of the cheapest base up at the home location,
   inside the grace period where nothing looks for them, and researches the techs that raise
   the wage — the prerequisites of the next `jobs` task, which is where the money to build
   anything else comes from (`task.py`, `Task.get_profit`).
2. **The warehouse.** The estate saves until it can pay for a warehouse *and* the best
   computer in the game, and then builds one. Neither is available yet: a Scenario may reach
   past availability, and buying the best computer early is what keeps a winning script short
   enough to compare.
3. **The teardown.** The morning that computer runs, the whole bootstrap comes down. It has
   done what it was for, its maintenance is a drain, and detection has started looking.
4. **The chain.** From there the plan researches the Apotheosis prerequisite chain in order,
   giving each tech everything still unallocated at its danger level.
5. **The escalation.** A tech the estate cannot pay for — no CPU at all at its danger level —
   is not researched but *built for*: one warehouse a day at the safest location that carries
   that level, until the level has CPU. OCEAN, then MOON, then FAR REACHES, then
   TRANSDIMENSIONAL open one after another as the chain lands, so every danger level is paid
   for by a base in a location safe enough to hold it.
6. **The tail.** The last tech ends the game, and `DAYS_PAST_THE_WIN` days run on the other
   side of it, where maintenance is no longer owed and nothing looks for a base any more.

Two moves are the comparison's rather than the play's, and both say so below: one warehouse
sleeps for two days and wakes again, so the recount's sleeping total moves, and a tenth of the
pool goes to jobs, so a tick earns from an allocation before research as well as from the pool
left after it.

## What a bump changes

Nothing here names a tech. The chain is read — the prerequisite closure of `WINNING_TECH`,
less what the wage ladder and the difficulty already finished, each tech after its
prerequisites — so a Content change that moves the tree moves the plan with it instead of
stopping the tool, and a regeneration writes a script that still wins (`_research_plan`).
What a bump has to be read for is the script: regenerate, and read the one
manifest entry that moved.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Iterable, Mapping

from tools.trace.reference import ReferenceRun
from tools.trace.scenario import ADVANCE_FIELD, FORMAT_VERSION, Scenario

SECONDS_PER_DAY = 86400

#: The tech that ends the game, and the root of the chain the plan researches.
WINNING_TECH = "Apotheosis"

#: The base the bootstrap is made of, and the one the estate is made of afterwards. Both are
#: named rather than derived: the cheapest base by cash is `Stolen Computer Time`, which costs
#: no cash and 172,800 CPU-seconds — two days of everything an empty game has — and the
#: largest is a Lunar Facility at forty million cash against a warehouse's forty thousand.
#: These two are the plan.
BOOTSTRAP_BASE = "Server Access"
WAREHOUSE = "Large Warehouse"

#: How many bootstrap bases go up on day 0. The starting cash buys fifty of them outright, and
#: thirty-five is the committed run's number rather than the best one: fifty wins too, in 84
#: game-days against this run's 96, and twenty loses the game on day 222 for want of a base
#: (`lost_game() == 1`). Changing it rewrites the whole script from the first step.
BOOTSTRAP_BASES = 35

#: How many warehouses the home location holds. The estate is rebuilt to this whenever the
#: game takes one, and everything the plan spends comes out of what these earn.
HOME_ESTATE = 5

#: How many warehouses the home location holds when one of them is put to sleep. Coverage
#: rather than play: the recount's sleeping total is a Trace field, and a Scenario that never
#: sleeps a base leaves it at zero for a whole run. It wakes again the day the estate stands.
SLEEPING_ESTATE = 3

#: The share of the pool that goes to jobs, once, the first time the plan starts a tech with
#: the estate standing. Coverage of the same kind: a tick earns from an explicit jobs
#: allocation before research and from whatever the pool has left afterwards (`player.py`,
#: `do_jobs`), and only a Scenario that allocates jobs exercises the first half.
JOBS_SHARE = 10

#: How many days run after the game is won. Nothing is owed and nothing looks for a base on
#: the other side of apotheosis, and a Trace that stopped at the win would compare none of it.
DAYS_PAST_THE_WIN = 4

#: The most Commands the plan may issue in one game-day. Every Command changes the state that
#: produced it, so a day terminates on its own; the cap turns a plan bug into a short scenario
#: instead of a hang. Day 0 is the long one, at `BOOTSTRAP_BASES` builds and an allocation.
COMMANDS_PER_DAY = 60

#: The most game-days a run may take before the plan is declared not to win.
DAY_LIMIT = 400

#: What a base is named: the bootstrap's prefix, the estate's, and one serial across both, so
#: a Trace names the bases in the order the run built them.
BOOTSTRAP_PREFIX = "N"
WAREHOUSE_PREFIX = "W"

ITEM_SLOT_CPU = "cpu"

#: The slots a warehouse is filled in, in the order the plan buys them. The network slot is
#: not one of them: it multiplies CPU the plan already has more of than it can spend, where
#: the other two lower the chance of the base being found at all.
ITEM_SLOTS = ("cpu", "security", "reactor")


class PlanError(RuntimeError):
    """The plan and Content disagree, so the plan would not write a winning script."""


def _reference():
    from singularity.code import g

    return g


# -- what the plan reads out of Content ------------------------------------------------


def _closure(pl, root: str) -> set[str]:
    """Every tech `root` needs, transitively, including `root` itself."""
    needed: set[str] = set()
    pending = [root]
    while pending:
        tech_id = pending.pop()
        if tech_id in needed:
            continue
        needed.add(tech_id)
        pending.extend(pl.techs[tech_id].prerequisites)
    return needed


def _in_dependency_order(pl, wanted: Iterable[str]) -> list[str]:
    """The wanted techs, each after its prerequisites, ties broken by Content order."""
    remaining = set(wanted)
    ordered: list[str] = []
    while remaining:
        ready = [
            tech_id
            for tech_id in _reference().techs
            if tech_id in remaining and not (set(pl.techs[tech_id].prerequisites) & remaining)
        ]
        if not ready:
            raise PlanError("a prerequisite cycle reaches %s" % sorted(remaining))
        ordered.extend(ready)
        remaining.difference_update(ready)
    return ordered


def _wage_techs(pl) -> list[str]:
    """What the estate researches first: the techs that raise what a CPU-second earns.

    The `jobs` tasks are a ladder and the game works the highest available one
    (`task.get_current`), so the next rung's prerequisites are the whole of what a bootstrap
    with no other income wants. Nothing here names a tech: a Content change that moves the
    ladder moves this with it."""
    for task in _reference().tasks_by_type["jobs"]:
        if task.available():
            continue
        wanted: set[str] = set()
        for prerequisite in task.prerequisites:
            wanted |= _closure(pl, prerequisite)
        return _in_dependency_order(pl, (tech for tech in wanted if not pl.techs[tech].done))
    return []


def _research_plan(pl, wage: Iterable[str]) -> list[str]:
    """The Apotheosis chain, in the order the plan researches it: everything `WINNING_TECH`
    needs that the wage ladder and the difficulty have not already finished, each tech after
    its prerequisites, ties broken by Content order.

    Read rather than written down. It was a list once, checked against Content
    on every run so a moved tech tree stopped the tool instead of writing a script that no
    longer wins — which left the tool unable to repair itself for the one change it was
    watching for. The order that list held is not derivable: no rule tried reproduces it, and
    it reads like the hand-written plan it was, Telepresence before Exploit Discovery/Repair
    and Leech Satellite after Advanced Fuel Oxidation. So the goal is the wrong one. The plan
    does not need *that* order, it needs one that wins, and any order the tree allows is one:
    the chain is researched to the end either way, the danger levels open in the order the
    escalation opens them, and what a tech costs does not depend on when it is reached."""
    done = {tech_id for tech_id, tech in pl.techs.items() if tech.done}
    return _in_dependency_order(pl, _closure(pl, WINNING_TECH) - set(wage) - done)


def _best_item(slot: str):
    """The best item of a slot, by the one quality it carries, ties to Content order.

    Availability is deliberately not consulted. The plan buys the best computer in the game
    the day it can pay for one, long before any chain unlocks it — this one never does — and
    that is what keeps a winning script short enough to compare step for step."""
    candidates = [spec for spec in _reference().items.values() if spec.item_type.id == slot]
    return max(candidates, key=lambda spec: max(spec.item_qual.values()))


def _cash_cost(location, spec) -> int:
    """What a base of this spec costs in cash *here* — the location's thrift is part of it."""
    cost = list(spec.cost)
    location.modify_cost(cost)
    return int(cost[0])


def _home(pl):
    """Where the estate goes: an empty location out of danger, best CPU first.

    The game starts the player somewhere; the estate goes where nothing is yet, at the best
    CPU modifier the map rolled."""
    empty = [
        location
        for location in pl.locations.values()
        if location.available() and location.safety == 0 and not location.bases
    ]
    return max(empty, key=lambda location: location.modifiers.get("cpu", 1))


def _refuge(pl, danger: int):
    """The safest place that is only just safe enough for a tech of this danger."""
    reachable = [
        location
        for location in pl.locations.values()
        if location.available() and location.safety >= danger
    ]
    return min(reachable, key=lambda location: location.safety) if reachable else None


# -- the plan --------------------------------------------------------------------------


class Plan:
    """One run of the plan against one reference. Neither is reusable."""

    def __init__(self, run: ReferenceRun) -> None:
        self.run = run
        self.pl = _reference().pl

        self.home = _home(self.pl)
        self.warehouse_spec = _reference().base_type[WAREHOUSE]
        self.items = {slot: _best_item(slot) for slot in ITEM_SLOTS}
        #: Read once. The ladder's next rung moves the moment this rung's techs land, and the
        #: bootstrap chases one rung rather than climbing for ever.
        self.wage_plan = _wage_techs(self.pl)
        #: Read once, for the same reason: the chain is fixed the moment the game starts.
        self.research_plan = _research_plan(self.pl, self.wage_plan)

        self.serial = 0
        self.bootstrap_built = False
        self.bootstrap_standing = False
        self.asleep = False
        self.awake = False
        self.jobs_allocated = False
        self.built_today: set[str] = set()
        self.moved_today = False
        self.script: list[Mapping[str, Any]] = []

    # -- the shape of a day ------------------------------------------------------------

    def day(self) -> None:
        """One game-day: what the plan does, and then the day itself."""
        self.built_today = set()
        self.moved_today = False
        issued = 0
        while issued < COMMANDS_PER_DAY:
            commands = self._next_commands()
            if not commands:
                break
            for command in commands:
                self._issue(command)
                issued += 1
        self._issue({ADVANCE_FIELD: SECONDS_PER_DAY})

    def _next_commands(self) -> list[Mapping[str, Any]]:
        """The next thing the plan wants, one round of it.

        One round only: every Command changes the state the next round reads, so the caller
        applies what comes back and asks again. The order is the order of the moves — the
        estate before the power state before the research, because each reads what the one
        before it left."""
        estate = self._bootstrap() or self._teardown() or self._building() or self._power()
        if estate:
            self.moved_today = True
            return estate
        return self._research()

    def _issue(self, step: Mapping[str, Any]) -> None:
        self.run.apply(step)
        self.script.append(step)

    # -- the six moves -----------------------------------------------------------------

    def _bootstrap(self) -> list[Mapping[str, Any]]:
        """Day 0: the cheapest bases the starting cash carries, where nothing is looking."""
        if self.bootstrap_built:
            return []
        self.bootstrap_built = True
        self.bootstrap_standing = True
        return [
            self._build(self.home, BOOTSTRAP_BASE, BOOTSTRAP_PREFIX) for _ in range(BOOTSTRAP_BASES)
        ]

    def _teardown(self) -> list[Mapping[str, Any]]:
        """The bootstrap comes down the morning the estate's first computer runs.

        Everything it was for has happened by then: the wage is up, the warehouse is paid for,
        and its one computer carries more CPU than the whole bootstrap does. What is left of
        it is maintenance, and a great many bases for the game to find.

        One base a round, so the index is read off the estate each time rather than reasoned
        about across a destroy that renumbers everything behind it."""
        if not self.bootstrap_standing or not self._estate_computing():
            return []
        for index, base in enumerate(self.home.bases):
            if base.spec.id == BOOTSTRAP_BASE:
                return [{"command": "destroyBase", "location": self.home.id, "base": index}]
        self.bootstrap_standing = False
        return []

    def _building(self) -> list[Mapping[str, Any]]:
        """A warehouse at the estate, or one where the chain cannot be paid for yet.

        One a location a day, and one location a round: a warehouse is bought for out of the
        same cash the last one is still being built with, and a plan that put five up in a
        morning would finish none of them."""
        if self._wanted(self.home) and self._affordable(self.home):
            return self._warehouse(self.home)

        refuge = self._unpaid_refuge()
        if refuge is not None and self._wanted(refuge) and self._affordable(refuge):
            return self._warehouse(refuge)
        return []

    def _power(self) -> list[Mapping[str, Any]]:
        """The estate's first warehouse sleeps while the estate is going up, and wakes the day
        it stands. Coverage rather than play — see `SLEEPING_ESTATE`."""
        standing = self._warehouses(self.home)
        if not self.asleep and standing >= SLEEPING_ESTATE:
            self.asleep = True
        elif self.asleep and not self.awake and standing >= HOME_ESTATE:
            self.awake = True
        else:
            return []
        return [{"command": "switchPower", "location": self.home.id, "base": 0}]

    def _research(self) -> list[Mapping[str, Any]]:
        """Everything still unallocated at the current tech's danger level, on the current tech.

        Unallocated, not the level's whole pool: an allocation past what the estate carries
        is a figure the port's Command clamps (deviation 5), so a Scenario has to
        stay under the cap or its script has nothing to be compared against. The bound is
        the research screen's own, `calc_cpu_left` (`screens/research.py:199`).

        A tech is started at what it can reach and topped up when it can reach more than
        twice that. A level whose CPU has merely doubled is still spending what it was
        given, and a Command that moved nothing a player could see would be a step in the
        script with nothing to compare.

        A top-up waits for a morning the plan has not moved the estate on. A level that grew
        because a base went up or woke this morning is not settled yet — the base is still
        being paid for — and the plan reads it again tomorrow instead."""
        tech = self._current_tech()
        if tech is None:
            return []

        if int(self.pl.available_cpus[tech.danger]) == 0:
            return []

        allocated = dict(self.pl.get_cpu_allocations()).get(tech.id, 0)
        if allocated:
            reachable = allocated + self._cpu_left(tech.danger)
            if self.moved_today or allocated * 2 >= reachable:
                return []
            return [{"command": "allocateCpu", "task": tech.id, "cpu": reachable}]

        commands: list[Mapping[str, Any]] = []
        pending: list[tuple[str, int]] = []
        if not self.jobs_allocated and self._warehouses(self.home) >= HOME_ESTATE:
            self.jobs_allocated = True
            share = int(self.pl.available_cpus[0]) // JOBS_SHARE
            commands.append({"command": "allocateCpu", "task": "jobs", "cpu": share})
            pending.append(("jobs", share))
        commands.append(
            {"command": "allocateCpu", "task": tech.id, "cpu": self._cpu_left(tech.danger, pending)}
        )
        return commands

    def _cpu_left(self, danger: int, pending: Iterable[tuple[str, int]] = ()) -> int:
        """`ResearchScreen.calc_cpu_left` (`screens/research.py:199`), with room for the
        allocations this round has decided on but not yet issued."""
        from singularity.code import task

        left = [int(cpu) for cpu in self.pl.available_cpus]
        for task_id, cpu in list(self.pl.get_cpu_allocations()) + list(pending):
            for level in range(task.danger_for(task_id) + 1):
                left[level] -= cpu
        for level in range(1, 4):
            left[level] = min(left[level - 1], left[level])
        return left[danger]

    # -- what the moves ask the reference ----------------------------------------------

    def _current_tech(self):
        """The tech the plan is on: the wage ladder while the bootstrap stands, the chain
        after it comes down. Nothing is researched in between — the estate is saving for a
        warehouse, and CPU with no allocation earns instead of researching."""
        plan = self.wage_plan if self.bootstrap_standing else self.research_plan
        for tech_id in plan:
            tech = self.pl.techs[tech_id]
            if not tech.done:
                return tech
        return None

    def _unpaid_refuge(self):
        """Where to build, when the chain has reached a danger level the estate cannot pay.

        `available_cpus[danger]` is what the estate may spend on a tech of that danger, so a
        zero there is not a slow tech but an impossible one: no base the plan holds is safe
        enough to run it."""
        if self.bootstrap_standing:
            return None
        tech = self._current_tech()
        if tech is None or tech.danger == 0:
            return None
        if int(self.pl.available_cpus[tech.danger]) > 0:
            return None
        return _refuge(self.pl, tech.danger)

    def _estate_computing(self) -> bool:
        return any(
            base.spec.id == WAREHOUSE and base.cpus is not None and base.cpus.done
            for base in self.home.bases
        )

    def _warehouses(self, location) -> int:
        return sum(1 for base in location.bases if base.spec.id == WAREHOUSE)

    def _wanted(self, location) -> bool:
        """The estate is held at `HOME_ESTATE`; a refuge takes whatever it takes."""
        if location.id in self.built_today:
            return False
        return location is not self.home or self._warehouses(location) < HOME_ESTATE

    def _affordable(self, location) -> bool:
        """A warehouse is worth starting when the estate can pay for the base and the computer
        that makes it worth having. Both are paid down day by day out of the same cash
        (`buyable.py`, `give_time`), so this is the plan's own reckoning rather than a rule the
        reference enforces — nothing stops a Command the cash cannot carry."""
        return self.pl.cash >= self._warehouse_cash(location)

    def _warehouse_cash(self, location) -> int:
        return _cash_cost(location, self.warehouse_spec) + self.items[ITEM_SLOT_CPU].cost[0]

    def _build(self, location, base_type: str, prefix: str) -> Mapping[str, Any]:
        self.serial += 1
        return {
            "command": "buildBase",
            "location": location.id,
            "baseType": base_type,
            "name": prefix + str(self.serial),
        }

    def _warehouse(self, location) -> list[Mapping[str, Any]]:
        """A warehouse, the computers the cash left over pays for, and — when the cash also
        covers them — the reactor and the field that keep the game from finding it."""
        self.built_today.add(location.id)
        index = len(location.bases)
        computer = self.items[ITEM_SLOT_CPU]
        spare = self.pl.cash - _cash_cost(location, self.warehouse_spec)
        count = min(self.warehouse_spec.size, spare // computer.cost[0])

        commands = [
            self._build(location, WAREHOUSE, WAREHOUSE_PREFIX),
            {
                "command": "buyItem",
                "location": location.id,
                "base": index,
                "itemType": computer.id,
                "count": int(count),
            },
        ]

        protection = [self.items[slot] for slot in ITEM_SLOTS if slot != ITEM_SLOT_CPU]
        covered = self._warehouse_cash(location) + sum(spec.cost[0] for spec in protection)
        if self.pl.cash >= covered:
            commands += [
                {
                    "command": "buyItem",
                    "location": location.id,
                    "base": index,
                    "itemType": spec.id,
                }
                for spec in protection
            ]
        return commands


# -- the run ---------------------------------------------------------------------------


def generate(seed: int, difficulty: str, scenario_id: str, description: str) -> dict[str, Any]:
    run = ReferenceRun(
        Scenario(
            id=scenario_id,
            description="generated",
            seed=seed,
            difficulty=difficulty,
            script=(),
        )
    )
    run.begin()
    plan = Plan(run)
    pl = plan.pl

    days = 0
    past_the_win = 0
    while days < DAY_LIMIT:
        lost = pl.lost_game()
        if lost:
            raise PlanError("the plan lost the game on day %d: lost_game() == %d" % (days, lost))
        plan.day()
        days += 1
        if pl.apotheosis:
            past_the_win += 1
            if past_the_win > DAYS_PAST_THE_WIN:
                break

    if not pl.apotheosis:
        raise PlanError("the plan did not win inside %d game-days" % DAY_LIMIT)

    print(
        "days=%d steps=%d bases=%d techs=%d cash=%d"
        % (
            days,
            len(plan.script),
            sum(len(location.bases) for location in pl.locations.values()),
            sum(1 for tech in pl.techs.values() if tech.done),
            pl.cash,
        ),
        file=sys.stderr,
    )

    return {
        "formatVersion": FORMAT_VERSION,
        "id": scenario_id,
        "description": description,
        "seed": seed,
        "difficulty": difficulty,
        "script": plan.script,
    }


def write_scenario(scenario: Mapping[str, Any], path: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(scenario, indent=2) + "\n")


def _description(path: str) -> str:
    """What the Scenario says about itself, carried across a regeneration.

    The description is prose about what the run reaches and why, and it is the one part of the
    file this tool cannot derive. Writing a template over it would lose that, so a
    regeneration keeps what is there and a change to it stays somebody's edit."""
    if not os.path.exists(path):
        return "The game won, played offline by tools/oracle/generate_apotheosis.py."
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)["description"]


def _main(argv: Iterable[str]) -> int:
    parser = argparse.ArgumentParser(description="Write the winning Scenario, offline.")
    parser.add_argument("--out", required=True, help="where to write the Scenario")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--difficulty", default="very-easy")
    args = parser.parse_args(list(argv))

    scenario_id = os.path.basename(args.out).split(".")[0]
    scenario = generate(args.seed, args.difficulty, scenario_id, _description(args.out))
    write_scenario(scenario, args.out)
    print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
