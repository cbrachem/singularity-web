"""The committed digest manifest — one hash per Scenario over the reference's full trace.

    .venv/bin/python -m tools.trace.manifest            # check
    .venv/bin/python -m tools.trace.manifest --update   # rewrite after a deliberate change

The manifest is **not** the fidelity check: CI regenerates both traces and compares them in
flight. It is a tripwire on the *specification* changing. If the reference's own
output moves, the thing the port is written against has moved, and that has to be a
deliberate commit rather than a surprise inside an unrelated run.

It records the pinned revision alongside the digests, and refuses to check against a
manifest whose revision no longer matches `REFERENCE_REVISION` — a bump
invalidates every digest here, so a stale manifest is worse than none.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Iterable

from .record import digest
from .scenario import SCENARIO_SUFFIX, load_scenario, scenario_paths

MANIFEST_VERSION = 1

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCENARIO_DIR = os.path.join(REPO_ROOT, "scenarios")
MANIFEST_PATH = os.path.join(SCENARIO_DIR, "manifest.json")
# The upstream revision vendored at singularity/. Update it with every re-vendor.
REFERENCE_REVISION = "99729e859b400e8271445458995a1dc4951ee321"


class ManifestError(RuntimeError):
    pass


def pinned_revision() -> str:
    return REFERENCE_REVISION


def build() -> dict[str, Any]:
    entries: dict[str, Any] = {}
    for path in scenario_paths(SCENARIO_DIR):
        scenario = load_scenario(path)
        value, steps = digest(scenario)
        entries[scenario.id] = {"steps": steps, "digest": value}
    return {
        "manifestVersion": MANIFEST_VERSION,
        "reference": pinned_revision(),
        "scenarios": entries,
    }


def read() -> dict[str, Any]:
    with open(MANIFEST_PATH, "r", encoding="utf-8") as handle:
        return json.load(handle)


def write(manifest: dict[str, Any]) -> None:
    with open(MANIFEST_PATH, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")


def differences(recorded: dict[str, Any], fresh: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    if recorded.get("manifestVersion") != MANIFEST_VERSION:
        problems.append(
            f"manifestVersion is {recorded.get('manifestVersion')!r}, expected {MANIFEST_VERSION}"
        )
    if recorded.get("reference") != fresh["reference"]:
        problems.append(
            "reference is %r, but the pinned revision is %r — a bump invalidates every digest"
            % (recorded.get("reference"), fresh["reference"])
        )

    recorded_scenarios = recorded.get("scenarios") or {}
    for scenario_id in sorted(set(recorded_scenarios) | set(fresh["scenarios"])):
        if scenario_id not in recorded_scenarios:
            problems.append(f"{scenario_id}: not in the manifest")
            continue
        if scenario_id not in fresh["scenarios"]:
            problems.append(f"{scenario_id}: in the manifest, but there is no such scenario")
            continue
        was, now = recorded_scenarios[scenario_id], fresh["scenarios"][scenario_id]
        if was != now:
            problems.append(
                "%s: manifest says %s, the reference produced %s"
                % (scenario_id, json.dumps(was, sort_keys=True), json.dumps(now, sort_keys=True))
            )
    return problems


def _main(argv: Iterable[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--update",
        action="store_true",
        help="rewrite the manifest from the reference's current output",
    )
    args = parser.parse_args(list(argv))

    fresh = build()
    if args.update:
        write(fresh)
        print(f"wrote {os.path.relpath(MANIFEST_PATH, REPO_ROOT)}")
        return 0

    problems = differences(read(), fresh)
    if problems:
        print("the digest manifest is out of date:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1
    print(f"{len(fresh['scenarios'])} scenario(s) match the manifest")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))


__all__ = [
    "MANIFEST_PATH",
    "MANIFEST_VERSION",
    "SCENARIO_DIR",
    "SCENARIO_SUFFIX",
    "ManifestError",
    "build",
    "differences",
    "pinned_revision",
    "read",
    "write",
]
