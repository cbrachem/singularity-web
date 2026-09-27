"""Drive the reference simulation through the command vocabulary, playing greedily.

Written to establish two facts: the six commands are callable headless with no GUI, and a
greedy heuristic is not a competent player — it loses to suspicion or to running out of
powered bases, and never reaches Apotheosis. Kept as the primary source for those claims and
as the seed of the offline scenario generator.

Not a verification tool. It draws from the same global RNG as the simulation, so its
choices are part of the seeded stream rather than an independent input.

Usage: heuristic_player.py [seed] [max_days]
"""

import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
REFERENCE = os.path.join(ROOT, "singularity")

sys.path.insert(0, HERE)
sys.path.insert(0, REFERENCE)

import pygame_stub  # noqa: E402

pygame_stub.install()

from singularity.code import base as basemod  # noqa: E402
from singularity.code import data, dirs, g  # noqa: E402
from singularity.code import item as itemmod  # noqa: E402

SECONDS_PER_DAY = 86400
ITEM_SLOTS = ("reactor", "network", "security")


class EffectRecorder:
    """Stands in for g.map_screen, tallying calls instead of rendering."""

    needs_rebuild = False

    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return lambda *args, **kwargs: self.calls.append(name)


def base_budget(pl):
    return 3 + sum(1 for tech in pl.techs.values() if tech.done)


def build_bases(pl):
    bases = list(g.all_bases())
    if any(not b.done or not b.cpus for b in bases):
        return
    for loc in sorted(pl.locations.values(), key=lambda candidate: -candidate.safety):
        if not loc.available() or len(loc.bases) >= 2:
            continue
        if len(list(g.all_bases())) >= base_budget(pl):
            return
        affordable = [
            spec
            for spec in g.base_type.values()
            if spec.available() and spec.buildable_in(loc) and pl.cash >= spec.cost[0]
        ]
        if not affordable:
            continue
        best = max(affordable, key=lambda spec: (spec.size, -spec.cost[0]))
        loc.add_base(basemod.Base("B%d" % len(list(g.all_bases())), best))


def best_affordable_item(pl, slot, count=1):
    candidates = [
        spec
        for spec in g.items.values()
        if spec.item_type.id == slot and spec.available() and pl.cash >= spec.cost[0] * count
    ]
    return max(candidates, key=lambda spec: spec.item_qual) if candidates else None


def buy_items(pl):
    for b in g.all_bases():
        if not b.done:
            continue
        if b.cpus is None:
            spec = best_affordable_item(pl, "cpu", b.spec.size)
            if spec:
                b.cpus = itemmod.Item(spec, base=b, count=b.spec.size)
                b.check_power()
                b.recalc_cpu()
        for slot in ITEM_SLOTS:
            if b.items.get(slot) is None:
                spec = best_affordable_item(pl, slot)
                if spec:
                    b.items[slot] = itemmod.Item(spec, base=b)
                    b.check_power()
                    b.recalc_cpu()
        if b.power_state == "offline":
            b.switch_power()


def allocate_cpu(pl):
    available = pl.available_cpus[0]
    if available <= 0:
        return
    cheapest_cpu = min(
        [
            spec.cost[0]
            for spec in g.items.values()
            if spec.item_type.id == "cpu" and spec.available()
        ]
        or [1000]
    )
    on_jobs = available if pl.cash < cheapest_cpu * 4 else 0
    for task_id, _cpu in list(pl.get_cpu_allocations()):
        pl.set_allocated_cpu_for(task_id, 0)
    pl.set_allocated_cpu_for("jobs", on_jobs)
    researchable = sorted(
        (t for t in pl.techs.values() if t.available() and not t.done),
        key=lambda t: t.total_cost[1],
    )
    if researchable and available > on_jobs:
        pl.set_allocated_cpu_for(researchable[0].id, available - on_jobs)


def play(seed, max_days):
    dirs.create_directories(True)
    data.reload_all()
    random.seed(seed)
    g.new_game("normal", 1)
    recorder = EffectRecorder()
    g.map_screen = recorder
    pl = g.pl

    outcome = "survived"
    for _ in range(max_days):
        if pl.apotheosis:
            outcome = "apotheosis"
            break
        lost = pl.lost_game()
        if lost:
            outcome = "lost(%d)" % lost
            break
        buy_items(pl)
        build_bases(pl)
        buy_items(pl)
        allocate_cpu(pl)
        pl.give_time(SECONDS_PER_DAY)

    print(
        "seed=%d outcome=%s day=%d cash=%d bases=%d techs=%d/%d effects=%d max_suspicion=%d"
        % (
            seed,
            outcome,
            pl.raw_sec // SECONDS_PER_DAY,
            pl.cash,
            len(list(g.all_bases())),
            sum(1 for t in pl.techs.values() if t.done),
            len(pl.techs),
            len(recorder.calls),
            max(group.suspicion for group in pl.groups.values()),
        )
    )


if __name__ == "__main__":
    seed = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    max_days = int(sys.argv[2]) if len(sys.argv) > 2 else 4000
    play(seed, max_days)
