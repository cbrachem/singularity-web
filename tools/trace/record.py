"""Record the reference's Trace for a Scenario.

    .venv/bin/python -m tools.trace.record scenarios/grace-quiet.scenario.json
    .venv/bin/python -m tools.trace.record scenarios/grace-quiet.scenario.json --digest
    .venv/bin/python -m tools.trace.record scenarios/research.scenario.json --allocation-order
    .venv/bin/python -m tools.trace.record scenarios/research.scenario.json --resource-flow

One JSON object per line, one line per Scenario step. The output is deliberately not
committed: at kilobytes per step a scenario runs to megabytes, and a reference bump would
invalidate every one of them. What is committed is the digest manifest — see `manifest.py`.

A trace written to a file carries the `.trace.jsonl` suffix, which `--out` insists on. That
is what `.gitignore` ignores and what the suite checks nothing tracked ever matches, so the
convention is what keeps a trace out of a commit by accident.

`--considered` names an order of bases the player is looking at, `--considered-item` an item
the player is looking at inside a base — the two places upstream writes `considered_buyables`
from (`screens/location.py:411`, `screens/base.py:103,182,446`). With `--resource-flow` either
is the hypothetical the Projection is asked about. With the trace itself it opens the dialog
before every step and throws the answer away: what is under test then is not the answer but
whether *asking* moved anything, because upstream's build dialog moves CPU allocations
(`Item.finish` reaches `recalc_cpu`) and this recorder undoes that. A Trace recorded that way
has to be identical to one recorded without it: the build dialog's write is not a Deviation,
so that is a check rather than a Normalisation. The item dialogs write
a plain `Buyable`, which reaches nothing and needs no undo.

The run also reports **which Scenario it recorded** on stderr, as `recorded-scenario <id>`,
read off the Scenario it loaded. A seed does not name a game — several committed Scenarios
carry the same one — so this is what ties a comparison's label to the file the reference
actually ran. Without it a run recorded from one Scenario and compared under another's name
matches at every record, and the fidelity gate reads a Scenario as compared whose file never
ran.

Beside it the run reports **the seed it installed**, as `seeded-from <n>`. It is
provenance rather than trace: deviation 2 says the reference is reproducible only because
the harness seeds it, and the comparison can only check that claim if the reference says
what it was seeded with instead of the harness restating the Scenario twice. It goes on
stderr because stdout is the trace, and the trace is what the digest manifest is measured on.

Beside those the run reports **which effect sites it reached**, one `reached-site <where>
<attribute> <kind>` line per `EFFECT_SURFACE` entry whose effect survived the filter and
reached the trace. That is the register checked inwards: an entry declared reachable that no
committed Scenario ever reaches is a claim nothing tests. Same reasoning for the stream it
goes on — provenance about the run, not part of what the digest measures.

Last on that stream are `considered-bases <n>` and `considered-items <n>`: how many fake bases
the build dialog's question built and how many plain buyables the item dialogs' question did,
counted by the recorder rather than read back off the arguments. A Trace that came out
unchanged because the dialog was never opened would satisfy the check above while measuring
nothing, and an answer that agrees because neither side was asked is worth as little.

`--allocation-order` is the one part of the reference's state a record cannot carry.
`canonical_line` sorts every object's keys, so a Trace record hands the port `cpu_usage` in
alphabetical order — and the order upstream keeps it in is behaviour rather than
presentation (see `allocation_order` below). It is emitted on its own rather than added to
the record, because the record is what the digest manifest is measured on and that manifest
is a tripwire on the *reference* changing.

`--resource-flow` is emitted on its own for the same reason, and for one more: it is a
**Projection** rather than state (`Player.compute_future_resource_flow`, `player.py:770`).
The port computes it from a State root the reference never handed it, so what the comparison
holds is a pure function's answer, step for step, and not another field of the record.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from typing import IO, Any, Iterable, Iterator

from .reference import (
    ConsideredBases,
    ConsideredItems,
    ConsideredOrder,
    ReferenceRun,
    record_trace,
    resource_flow,
)
from .scenario import Scenario, load_scenario

TRACE_SUFFIX = ".trace.jsonl"

SCENARIO_REPORT_PREFIX = "recorded-scenario "

SEED_REPORT_PREFIX = "seeded-from "

SITE_REPORT_PREFIX = "reached-site "

CONSIDERED_REPORT_PREFIX = "considered-bases "

CONSIDERED_ITEMS_REPORT_PREFIX = "considered-items "


def canonical_line(record: Any) -> str:
    """One record as one line, in a form two runs can be compared byte for byte."""
    return json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def write_trace(
    scenario: Scenario,
    out: IO[str],
    provenance: IO[str] | None = None,
    considered: Iterable[ConsideredOrder] = (),
) -> int:
    """Write one line per step, and report on `provenance` which Scenario the run recorded,
    what it seeded from, which effect sites it reached, and how many hypothetical buyables
    the dialogs' question built.

    The seed is read off the run rather than off the Scenario, so what the report carries is
    what the reference's generator was actually started with. The sites and the buyables
    are read off the recorder for the same reason: observed, not declared. The Scenario id
    comes off the run's own Scenario, so a comparison can hold its label to the file that
    ran instead of to the argument it was given."""
    run = ReferenceRun(scenario)
    steps = 0
    for record in run.records(considered):
        out.write(canonical_line(record))
        out.write("\n")
        steps += 1
    if provenance is not None and run.seeded_from is not None:
        provenance.write(f"{SCENARIO_REPORT_PREFIX}{run.scenario.id}\n")
        provenance.write(f"{SEED_REPORT_PREFIX}{run.seeded_from}\n")
        for where, attribute, kind in run.reached_sites:
            provenance.write(f"{SITE_REPORT_PREFIX}{where} {attribute} {kind}\n")
        provenance.write(f"{CONSIDERED_REPORT_PREFIX}{run.considered_bases_built}\n")
        provenance.write(f"{CONSIDERED_ITEMS_REPORT_PREFIX}{run.considered_items_built}\n")
    return steps


def allocation_order(scenario: Scenario) -> Iterator[list[str]]:
    """The reference's own `cpu_usage` key order, one list per Scenario step.

    `cpu_usage` is a dict, and dicts keep insertion order, so the key order is behaviour:
    `Player.give_time` walks the allocations in that order and offers each tech the **full**
    cash balance in turn (`player.py:341`, `buyable.py:204`). The allocation made first is
    therefore the one paid first when there is not enough cash for every tech, and
    re-allocating a task already in the dict leaves it where it was rather than promoting it
    to the end.

    A Trace record cannot carry that: `canonical_line` sorts keys. So the order is recorded
    beside the trace and compared on its own — the port's projection is expected to produce
    the same keys in the same order, step for step, in every Scenario that allocates CPU.
    """
    for record in record_trace(scenario):
        yield list(record["persistent"]["player"]["cpu_usage"])


def write_allocation_order(scenario: Scenario, out: IO[str]) -> None:
    """One JSON list of task ids per line, one line per step, in the reference's own order."""
    for order in allocation_order(scenario):
        out.write(json.dumps(order, separators=(",", ":"), ensure_ascii=True))
        out.write("\n")


def write_resource_flow(
    scenario: Scenario, out: IO[str], considered: Iterable[ConsideredOrder] = ()
) -> int:
    """One JSON object per line, one line per step: the reference's own resource flow.

    Emitted beside the trace for the same reason the allocation order is — a Projection is
    not state, and putting it inside a record would move every digest in the manifest while
    saying nothing about the reference.
    """
    steps = 0
    for flow in resource_flow(scenario, considered):
        out.write(json.dumps(flow, sort_keys=True, separators=(",", ":"), ensure_ascii=True))
        out.write("\n")
        steps += 1
    return steps


def digest(scenario: Scenario) -> tuple[str, int]:
    """One hash per scenario over the reference's full trace, plus the step count."""
    hasher = hashlib.sha256()
    steps = 0
    for record in record_trace(scenario):
        hasher.update(canonical_line(record).encode("utf-8"))
        hasher.update(b"\n")
        steps += 1
    return "sha256:" + hasher.hexdigest(), steps


def _main(argv: Iterable[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenario", help="path to a *.scenario.json file")
    parser.add_argument(
        "--digest",
        action="store_true",
        help="print the trace digest instead of the trace",
    )
    parser.add_argument(
        "--allocation-order",
        action="store_true",
        help="print the cpu_usage key order per step instead of the trace",
    )
    parser.add_argument(
        "--resource-flow",
        action="store_true",
        help="print the reference's resource flow per step instead of the trace",
    )
    parser.add_argument(
        "--considered",
        action="append",
        default=[],
        metavar=f"LOCATION{ConsideredBases.SEPARATOR}TYPE{ConsideredBases.SEPARATOR}COUNT",
        help=(
            "an order of bases the player is looking at: projected by --resource-flow, and, "
            "with the trace itself, asked about before every step so the Trace shows what "
            "asking moved; repeatable"
        ),
    )
    parser.add_argument(
        "--considered-item",
        action="append",
        default=[],
        metavar=f"ITEM{ConsideredItems.SEPARATOR}COUNT",
        help=(
            "an item the player is looking at inside a base, as the item dialogs would be "
            "showing it; goes the same places as --considered and is repeatable"
        ),
    )
    parser.add_argument(
        "--out",
        help=f"write the trace here instead of stdout; must end in {TRACE_SUFFIX}",
    )
    args = parser.parse_args(list(argv))

    scenario = load_scenario(args.scenario)

    asked = [args.digest, args.allocation_order, args.resource_flow]
    if sum(1 for wanted in asked if wanted) > 1:
        parser.error("--digest, --allocation-order and --resource-flow ask for different things")

    try:
        considered: list[ConsideredOrder] = [
            ConsideredBases.parse(order) for order in args.considered
        ]
        considered += [ConsideredItems.parse(order) for order in args.considered_item]
    except ValueError as bad:
        parser.error(str(bad))

    if considered and (args.digest or args.allocation_order):
        parser.error(
            "--considered and --considered-item go with the trace itself or with --resource-flow"
        )

    if args.out and any(asked):
        parser.error(
            "--out writes the trace; --digest, --allocation-order and --resource-flow print "
            "instead of it"
        )

    if args.resource_flow:
        write_resource_flow(scenario, sys.stdout, considered)
        return 0

    if args.digest:
        value, steps = digest(scenario)
        print(json.dumps({"id": scenario.id, "steps": steps, "digest": value}))
        return 0

    if args.allocation_order:
        write_allocation_order(scenario, sys.stdout)
        return 0

    if args.out:
        if not args.out.endswith(TRACE_SUFFIX):
            parser.error(f"--out must end in {TRACE_SUFFIX}; traces are not committed")
        with open(args.out, "w", encoding="utf-8") as handle:
            write_trace(scenario, handle, sys.stderr, considered)
    else:
        write_trace(scenario, sys.stdout, sys.stderr, considered)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
