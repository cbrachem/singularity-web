"""Write a long Scenario by playing the reference greedily, once, offline.

    .venv/bin/python -m tools.oracle.generate_long_play --out scenarios/long-play.scenario.json

**This is not a verification tool and must never run at verification time.** A Scenario is
data: the same committed script drives the port and drives the reference, and that is the
whole of what makes a Trace comparison mean anything. A harness that generated the script
while it ran would hand each implementation a script from its own generator and would be
testing itself (`tools/trace/scenario.py`). So this runs by hand, its output is
committed, and nothing under `tools/trace/`, `sim/` or `app/` imports it — a rule the
trace-seam suite holds rather than this docstring.

The policy is `heuristic_player.py`'s, expressed in Commands instead of in direct model
mutations: fill every finished base with the best CPU it can afford, then its three extra
slots, rename a base the day it stands, keep the last standing base asleep while the estate is
still building, abandon a site the estate has starved for a month, build where the estate is
safest while the budget allows, and split the CPU pool between jobs and the cheapest available
research. It reads state and draws nothing
of its own, so the reference's generator sees exactly the stream a replay of the emitted
script sees, and the script replays to the state the run ended in.

One number is not that player's: the estate budget is wider, because a wider estate survives
the detection rolls longer and length is what this Scenario is for.

Three moves are not that player's either, and they are here for the comparison rather than for
the play. `renameBase` and `destroyBase` are two of the six Commands and the long Scenario
reached neither until this policy issued them; `switchPower` was the third and last. The
vocabulary was covered forty steps at a time by `command-vocabulary` and never over hundreds
of game-days. The committed run issues 100 destroys, 16 renames and 20 power switches across
1778 game-days.

**What the destroys cover, exactly.** A destroy is the one Command that renumbers the bases
under it, and 96 of the 100 do renumber one. Every Trace record carries the serialised estate,
so each of those 96 renumberings is compared position for position. Four later Commands go
further and *address* a base at an index a destroy moved, which is where an off-by-one in a
renumbering shows as the wrong base being renamed or bought for rather than as a differing
list. That is a property of this run rather than of the policy — it takes a finished base
sitting under an abandoned site, which the run has to happen into — and the previous committed
run reached it zero times. `sim/test/long-play.trace.test.ts` asserts it, so a
regeneration that loses it says so.

Greedy is the point rather than a limitation: the run this writes is a **long play**, not a
won one. What the comparison wants here is a script that keeps using the vocabulary for
hundreds of game-days, so a difference has somewhere to accumulate; a competent player is a
different Scenario (`apotheosis`).
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

ITEM_SLOTS = ("reactor", "network", "security")

ITEM_SLOT_CPU = "cpu"

#: The most Commands the policy may issue in one game-day. Every Command it issues changes
#: the state that produced it, so the loop terminates on its own; the cap is what turns a
#: policy bug into a short scenario instead of a hang.
COMMANDS_PER_DAY = 40

#: A base is built under one prefix and renamed to the other the day it stands. The swap is
#: what makes `renameBase` fire exactly once per base: a base already carrying the standing
#: prefix no longer matches, so the policy stays terminating without remembering anything.
BUILDING_PREFIX = "Site "
STANDING_PREFIX = "Station "

#: The seed the committed Scenario was written with, so the documented command reproduces
#: that file rather than some other run. It is the longest of the first hundred and twenty,
#: at 1778 game-days against 1662 for the next. This policy loses rather than wins, so the
#: length of a run is mostly a draw, and a change to the policy invalidates the search rather
#: than shifting it (`--seed` re-runs one): the seed committed before `switchPower` joined the
#: policy was 1, longest at 527 game-days, which plays 269 under this one.
COMMITTED_SEED = 91

#: How many mornings a site may stand unfinished before the policy abandons it. What the
#: rule is for is measurable: under the policy this replaced, at the seed that Scenario was
#: committed with, two sites were still unfinished on the last day of the run, after 472 and
#: 266 mornings. Those are the ones the estate had stopped paying for, and the ones this
#: number reaches.
#:
#: A month is past ordinary construction here rather than well clear of it. At the committed
#: seed seven sites finished, the slowest of them after 25 mornings, so the threshold sits at
#: the edge of what construction can take and the policy does abandon sites that would have
#: stood. That is a fair trade for a Scenario that wants Commands rather than a good play.
STALLED_SITE_DAYS = 30


def _reference():
    from singularity.code import g

    return g


def _base_budget(pl) -> int:
    """How many bases the policy will hold at once.

    `heuristic_player.py` starts at three; this starts at eight, and the difference is the
    Scenario's length. Three bases are all lost within a few days of the grace period ending
    and the run is over; eight keep the play going for hundreds of days, which is what a
    long Scenario is for."""
    return 8 + sum(1 for tech in pl.techs.values() if tech.done)


def _best_item(pl, slot: str, count: int = 1):
    candidates = [
        spec
        for spec in _reference().items.values()
        if spec.item_type.id == slot and spec.available() and pl.cash >= spec.cost[0] * count
    ]
    return max(candidates, key=lambda spec: spec.item_qual) if candidates else None


def _estate(pl) -> list[tuple[str, int, Any]]:
    """Every base as the Scenario addresses one: its location id and its index there."""
    return [
        (location_id, index, base)
        for location_id, location in pl.locations.items()
        for index, base in enumerate(location.bases)
    ]


def _item_command(pl, location_id: str, index: int, base) -> Mapping[str, Any] | None:
    if base.cpus is None:
        spec = _best_item(pl, ITEM_SLOT_CPU, base.spec.size)
        if spec is not None:
            return {
                "command": "buyItem",
                "location": location_id,
                "base": index,
                "itemType": spec.id,
                "count": base.spec.size,
            }
    for slot in ITEM_SLOTS:
        if base.items[slot] is None:
            spec = _best_item(pl, slot)
            if spec is not None:
                return {
                    "command": "buyItem",
                    "location": location_id,
                    "base": index,
                    "itemType": spec.id,
                }
    return None


def _rename_command(location_id: str, index: int, base) -> Mapping[str, Any] | None:
    """Rename a base the day it stands, from its building name to its standing one.

    The caller has already filtered for a base that is done, so the prefix is the whole
    test: a base still carrying the building prefix is one that finished since the last
    round."""
    if not base.name.startswith(BUILDING_PREFIX):
        return None
    return {
        "command": "renameBase",
        "location": location_id,
        "base": index,
        "name": STANDING_PREFIX + base.name[len(BUILDING_PREFIX) :],
    }


def _power_command(location_id: str, index: int, base, sleeper) -> Mapping[str, Any] | None:
    """The estate keeps one base asleep while it is still building: the last one it holds.

    Coverage rather than play, and it says so — a power state reaches exactly one thing in the
    reference (`recalc_cpu`, `player.py:485`: a sleeping base's CPU leaves `available_cpus` for
    `sleeping_cpus` and nothing else moves), so no greedy player would ever sleep a base and no
    reading of the economy would produce one. Before this the policy woke a sleeping base and
    nothing ever slept one, so the long play reached five of the six Commands and `switchPower`
    was exercised only by `command-vocabulary`, over forty steps rather than hundreds of
    game-days.

    Which base is derived rather than remembered, the way the rename is: the last standing base
    in the estate's own order, while any site is unfinished. It is one command each way per base
    — the base that stood last sleeps, and wakes the morning another finishes behind it — so the
    sleeping total keeps moving for the length of the run without the policy carrying a
    schedule. A base whose computer is not built yet is left alone: `available_power_states`
    (`base.py:265`) offers such a base only `offline`, so switching its power would be a step
    that changed nothing and asked for the same step again."""
    if base.cpus is None or not base.cpus.done:
        return None
    if (base is sleeper) == (base.power_state == "sleep"):
        return None
    return {"command": "switchPower", "location": location_id, "base": index}


def _sleeper(pl):
    """The base the policy wants asleep: the last one standing, while a site is unfinished."""
    standing = [base for _, _, base in _estate(pl) if base.done]
    unfinished = any(not base.done for _, _, base in _estate(pl))
    return standing[-1] if standing and unfinished else None


def _site_ages(pl, ages: Mapping[Any, int]) -> dict[Any, int]:
    """One more morning on the age of every site the estate has not finished.

    A base that has since been finished, or that the reference destroyed under the policy,
    simply does not appear in the new mapping: the estate is read fresh each morning, so
    nothing has to be forgotten explicitly."""
    return {base: ages.get(base, 0) + 1 for _, _, base in _estate(pl) if not base.done}


def _destroy_command(pl, ages: Mapping[Any, int]) -> Mapping[str, Any] | None:
    """Give up a site the estate cannot afford to finish.

    A base under construction is paid for out of the same cash and CPU the policy is
    spending on everything else, tick by tick (`player.py:give_time`). A site that is still
    standing unfinished after `STALLED_SITE_DAYS` is one the estate has been starving all
    month, and the policy abandons it rather than carrying it to the end of the run.

    **An unfinished base and no other.** `recalc_cpu` counts a base only `if base.done`
    (`player.py:490`), so abandoning a site can never cost the estate the last of its CPU and
    end the run on `Player.lost_game`. Giving up a standing base could.

    **And a month of patience.** The policy rebuilds where it abandoned, so a short threshold
    makes it churn rather than choose: at the committed seed, one morning of patience gives
    464 destroys against 484 builds over 280 game-days, where thirty gives 100 against 144
    over 1778. The length is a draw either way — twenty, thirty and forty-five all reach 1778
    days at this seed, and only one morning shortens the run — so read thirty as measured
    rather than derived."""
    for location_id, index, base in _estate(pl):
        if ages.get(base, 0) >= STALLED_SITE_DAYS:
            return {"command": "destroyBase", "location": location_id, "base": index}
    return None


def _build_command(pl, serial: int) -> Mapping[str, Any] | None:
    bases = [base for _, _, base in _estate(pl)]
    if sum(1 for base in bases if not base.done or not base.cpus) >= 2:
        return None
    if len(bases) >= _base_budget(pl):
        return None
    for location_id, location in sorted(pl.locations.items(), key=lambda entry: -entry[1].safety):
        if not location.available() or len(location.bases) >= 2:
            continue
        affordable = [
            spec
            for spec in _reference().base_type.values()
            if spec.available() and spec.buildable_in(location) and pl.cash >= spec.cost[0]
        ]
        if not affordable:
            continue
        best = max(affordable, key=lambda spec: (spec.size, -spec.cost[0]))
        return {
            "command": "buildBase",
            "location": location_id,
            "baseType": best.id,
            "name": BUILDING_PREFIX + str(serial),
        }
    return None


def _allocation_commands(pl) -> list[Mapping[str, Any]]:
    """The CPU pool split between jobs and the cheapest research the estate can reach.

    `Player.set_allocated_cpu_for` asserts that a tech is available (`player.py:246`), so a
    task that has finished or was never reachable is never named here — the recorder would
    stop on it rather than record a step."""
    available = int(pl.available_cpus[0])
    cheapest_cpu = min(
        [
            spec.cost[0]
            for spec in _reference().items.values()
            if spec.item_type.id == ITEM_SLOT_CPU and spec.available()
        ]
        or [1000]
    )
    on_jobs = available if pl.cash < cheapest_cpu * 4 else 0

    wanted: dict[str, int] = {"jobs": on_jobs}
    researchable = sorted(
        (tech for tech in pl.techs.values() if tech.available() and not tech.done),
        key=lambda tech: tech.total_cost[1],
    )
    if researchable and available > on_jobs:
        wanted[researchable[0].id] = available - on_jobs

    commands: list[Mapping[str, Any]] = []
    for task_id, cpu in list(pl.get_cpu_allocations()):
        if wanted.get(task_id, 0) != cpu and task_id not in wanted:
            commands.append({"command": "allocateCpu", "task": task_id, "cpu": 0})
    for task_id, cpu in wanted.items():
        if dict(pl.get_cpu_allocations()).get(task_id, 0) != cpu:
            commands.append({"command": "allocateCpu", "task": task_id, "cpu": cpu})
    return commands


def _day_commands(pl, serial: int, ages: Mapping[Any, int]) -> list[Mapping[str, Any]]:
    """The Commands the policy wants next, one round of them.

    One round only: every Command changes the state the next round reads, and the caller
    applies them one at a time and asks again."""
    sleeper = _sleeper(pl)
    for location_id, index, base in _estate(pl):
        if not base.done:
            continue
        rename = _rename_command(location_id, index, base)
        if rename is not None:
            return [rename]
        item = _item_command(pl, location_id, index, base)
        if item is not None:
            return [item]
        power = _power_command(location_id, index, base, sleeper)
        if power is not None:
            return [power]
    destroy = _destroy_command(pl, ages)
    if destroy is not None:
        return [destroy]
    build = _build_command(pl, serial)
    if build is not None:
        return [build]
    return _allocation_commands(pl)


def generate(seed: int, difficulty: str, days: int, scenario_id: str) -> dict[str, Any]:
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
    pl = _reference().pl

    script: list[Mapping[str, Any]] = []
    serial = 0
    played = 0
    outcome = "survived"
    ages: dict[Any, int] = {}
    for _ in range(days):
        if pl.apotheosis:
            outcome = "apotheosis"
            break
        lost = pl.lost_game()
        if lost:
            outcome = "lost(%d)" % lost
            break
        ages = _site_ages(pl, ages)
        issued = 0
        while issued < COMMANDS_PER_DAY:
            commands = _day_commands(pl, serial, ages)
            if not commands:
                break
            for command in commands:
                serial += command["command"] == "buildBase"
                run.apply(command)
                script.append(command)
                issued += 1
        advance = {ADVANCE_FIELD: SECONDS_PER_DAY}
        run.apply(advance)
        script.append(advance)
        played += 1

    print(
        "seed=%d outcome=%s days=%d steps=%d bases=%d techs=%d cash=%d"
        % (
            seed,
            outcome,
            played,
            len(script),
            len(_estate(pl)),
            sum(1 for tech in pl.techs.values() if tech.done),
            pl.cash,
        ),
        file=sys.stderr,
    )

    return {
        "formatVersion": FORMAT_VERSION,
        "id": scenario_id,
        "description": (
            "A long greedy play, generated once and offline by "
            "tools/oracle/generate_long_play.py and committed as data. %d game-days, "
            "%d steps, ending %s." % (played, len(script), outcome)
        ),
        "seed": seed,
        "difficulty": difficulty,
        "script": script,
    }


def write_scenario(scenario: Mapping[str, Any], path: str) -> None:
    """One step per line, which is how a hand-written Scenario reads and how a diff of a
    regenerated one stays legible."""
    head = {key: value for key, value in scenario.items() if key != "script"}
    lines = json.dumps(head, indent=2).splitlines()[:-1]
    lines[-1] += ","
    lines.append('  "script": [')
    steps = [f"    {json.dumps(step)}" for step in scenario["script"]]
    lines.append(",\n".join(steps))
    lines.append("  ]")
    lines.append("}")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def _main(argv: Iterable[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="where to write the Scenario")
    parser.add_argument("--seed", type=int, default=COMMITTED_SEED)
    parser.add_argument("--difficulty", default="normal")
    parser.add_argument("--days", type=int, default=2000)
    args = parser.parse_args(list(argv))

    scenario_id = os.path.basename(args.out).split(".")[0]
    scenario = generate(args.seed, args.difficulty, args.days, scenario_id)
    write_scenario(scenario, args.out)
    print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
