"""The Scenario file format.

A **Scenario** is a seed, a difficulty and an ordered script of steps, each either a time
advance or a **Command**. It is a data file, authored or generated
offline — never generated at verification time, because then the two implementations would
draw from different generators and the harness would be testing itself.

Scenarios live in `scenarios/<id>.scenario.json`:

    {
      "formatVersion": 1,
      "id": "grace-quiet",
      "description": "one sentence on what this scenario is for",
      "seed": 1,
      "difficulty": "normal",
      "script": [
        { "advanceBy": 3600 },
        { "command": "buildBase", "location": "N AMERICA",
          "baseType": "Stolen Computer Time", "name": "Alpha" }
      ]
    }

`seed` seeds the simulation's generator before the game is created; `difficulty` is an
upstream difficulty id. One script entry is one step, and one step is one Trace record.

**Advance steps** carry `advanceBy`, a whole number of game-seconds, at least one. The
Scenario therefore carries an explicit Tick partition and no speed setting and no frame rate:
the host's time model is verified separately rather than smuggled into every fidelity run.

Zero is refused rather than allowed and ignored. A step that advances no time binds nothing
in a Trace, and it is the one step the port's two drivers read differently: the simulation's
`advance` returns a fresh state root for it, while the browser host's per-frame tick returns
without making one, so a Scenario carrying it would boot a session into a state the trace
harness never derived.

**Commands** are the six of the input half of the seam. All six are named here even though
the port implements them later; a format that could not express one of them would have to
be revised exactly when it is hardest to revise.

| command       | fields                                          |
| ------------- | ----------------------------------------------- |
| `buildBase`   | `location`, `baseType`, `name` (optional)       |
| `destroyBase` | `location`, `base`                              |
| `buyItem`     | `location`, `base`, `itemType`, `count` (cpu)   |
| `allocateCpu` | `task`, `cpu`                                   |
| `switchPower` | `location`, `base`                              |
| `renameBase`  | `location`, `base`, `name`                      |

`location`, `baseType`, `itemType` and `task` are upstream content ids. A base is addressed
as `location` plus `base`, an index into that location's base list — which is how upstream's
own screen addresses it, and unlike a name it cannot be ambiguous. Indices shift when a base
is destroyed, identically on both sides.

`buildBase` may omit `name`, in which case the simulation generates one. Generation draws
from the simulation RNG, so it is part of the Simulation even though upstream files it in a
screen module; omitting the name is how a Scenario exercises it.

`buyItem` may carry `count`, and **the CPU slot is the only slot that has one**. Upstream's
own caller passes one for every other slot (`screens/base.py:583`), so a reactor, network or
security item is built exactly once whatever a dialog asked. A Scenario carrying a count for
one of them says something the game cannot do, and both sides refuse it rather than reading
it as one — the recorder in `reference.py`, the port in `sim/src/command.ts`.

The refusal is not here, because the tables below cannot make it: what a `count` means
depends on the item's slot, the slot comes out of Content, and this module deliberately
knows no Content — it is the format's authority, and importing the reference into it would
turn around the dependency the recorder already has on it.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Mapping

FORMAT_VERSION = 1

SCENARIO_SUFFIX = ".scenario.json"

ADVANCE_FIELD = "advanceBy"

#: The shortest advance a Scenario may carry, in game-seconds. See the module docstring.
ADVANCE_MINIMUM = 1

_STR = "string"
_INT = "integer"

COMMAND_FIELDS: Mapping[str, Mapping[str, str]] = {
    "buildBase": {"location": _STR, "baseType": _STR},
    "destroyBase": {"location": _STR, "base": _INT},
    "buyItem": {"location": _STR, "base": _INT, "itemType": _STR},
    "allocateCpu": {"task": _STR, "cpu": _INT},
    "switchPower": {"location": _STR, "base": _INT},
    "renameBase": {"location": _STR, "base": _INT, "name": _STR},
}

OPTIONAL_COMMAND_FIELDS: Mapping[str, Mapping[str, str]] = {
    "buildBase": {"name": _STR},
    "destroyBase": {},
    "buyItem": {"count": _INT},
    "allocateCpu": {},
    "switchPower": {},
    "renameBase": {},
}

COMMANDS = tuple(COMMAND_FIELDS)


class ScenarioError(ValueError):
    """A Scenario file that does not conform to the format."""


@dataclass(frozen=True)
class Scenario:
    id: str
    description: str
    seed: int
    difficulty: str
    script: tuple[Mapping[str, Any], ...]
    format_version: int = FORMAT_VERSION


def is_advance(step: Mapping[str, Any]) -> bool:
    return ADVANCE_FIELD in step


def parse_scenario(raw: Any, source: str = "<scenario>") -> Scenario:
    if not isinstance(raw, dict):
        raise ScenarioError(f"{source}: a scenario is an object, got {type(raw).__name__}")

    version = raw.get("formatVersion")
    if version != FORMAT_VERSION:
        raise ScenarioError(f"{source}: formatVersion must be {FORMAT_VERSION}, got {version!r}")

    scenario_id = _require(raw, "id", _STR, source)
    description = _require(raw, "description", _STR, source)
    seed = _require(raw, "seed", _INT, source)
    difficulty = _require(raw, "difficulty", _STR, source)

    script = raw.get("script")
    if not isinstance(script, list) or not script:
        raise ScenarioError(f"{source}: script must be a non-empty array")

    steps = tuple(_parse_step(step, f"{source}: step {index}") for index, step in enumerate(script))
    return Scenario(
        id=scenario_id,
        description=description,
        seed=seed,
        difficulty=difficulty,
        script=steps,
        format_version=FORMAT_VERSION,
    )


def load_scenario(path: str) -> Scenario:
    if not path.endswith(SCENARIO_SUFFIX):
        raise ScenarioError(f"{path}: a scenario file is named <id>{SCENARIO_SUFFIX}")
    with open(path, "r", encoding="utf-8") as handle:
        raw = json.load(handle)
    scenario = parse_scenario(raw, os.path.basename(path))
    expected = os.path.basename(path)[: -len(SCENARIO_SUFFIX)]
    if scenario.id != expected:
        raise ScenarioError(
            f"{expected}{SCENARIO_SUFFIX}: id is {scenario.id!r}; the file name carries the id"
        )
    return scenario


def scenario_paths(directory: str) -> list[str]:
    return sorted(
        os.path.join(directory, name)
        for name in os.listdir(directory)
        if name.endswith(SCENARIO_SUFFIX)
    )


def _parse_step(step: Any, source: str) -> Mapping[str, Any]:
    if not isinstance(step, dict):
        raise ScenarioError(f"{source}: a step is an object, got {type(step).__name__}")

    if is_advance(step):
        if "command" in step:
            raise ScenarioError(f"{source}: a step is either an advance or a command, not both")
        seconds = _require(step, ADVANCE_FIELD, _INT, source)
        if seconds < ADVANCE_MINIMUM:
            raise ScenarioError(
                f"{source}: {ADVANCE_FIELD} must be at least {ADVANCE_MINIMUM} game-second"
            )
        _reject_extras(step, {ADVANCE_FIELD}, source)
        return dict(step)

    command = step.get("command")
    if command not in COMMAND_FIELDS:
        raise ScenarioError(
            f"{source}: unknown command {command!r}; expected one of {', '.join(COMMANDS)}"
        )

    required = COMMAND_FIELDS[command]
    optional = OPTIONAL_COMMAND_FIELDS[command]
    for field, kind in required.items():
        _require(step, field, kind, source)
    for field, kind in optional.items():
        if field in step:
            _require(step, field, kind, source)
    _reject_extras(step, {"command", *required, *optional}, source)
    return dict(step)


def _require(obj: Mapping[str, Any], field: str, kind: str, source: str) -> Any:
    if field not in obj:
        raise ScenarioError(f"{source}: missing {field!r}")
    value = obj[field]
    if kind == _STR and not isinstance(value, str):
        raise ScenarioError(f"{source}: {field!r} must be a string, got {value!r}")
    if kind == _INT and (isinstance(value, bool) or not isinstance(value, int)):
        raise ScenarioError(f"{source}: {field!r} must be an integer, got {value!r}")
    return value


def _reject_extras(step: Mapping[str, Any], allowed: set[str], source: str) -> None:
    extras = sorted(set(step) - allowed)
    if extras:
        raise ScenarioError(f"{source}: unexpected field(s) {', '.join(extras)}")


def describe_format() -> dict[str, Any]:
    """The format's own description, so the port's parser can be checked against it rather
    than drifting from it quietly. Printed by `python -m tools.trace.scenario`."""
    return {
        "formatVersion": FORMAT_VERSION,
        "advanceField": ADVANCE_FIELD,
        "advanceMinimum": ADVANCE_MINIMUM,
        "commands": {
            command: {
                "required": dict(COMMAND_FIELDS[command]),
                "optional": dict(OPTIONAL_COMMAND_FIELDS[command]),
            }
            for command in COMMANDS
        },
    }


def step_kind(step: Mapping[str, Any]) -> str:
    return "advance" if is_advance(step) else str(step["command"])


if __name__ == "__main__":
    print(json.dumps(describe_format(), indent=2, sort_keys=True))


__all__ = [
    "COMMANDS",
    "COMMAND_FIELDS",
    "FORMAT_VERSION",
    "OPTIONAL_COMMAND_FIELDS",
    "SCENARIO_SUFFIX",
    "Scenario",
    "ScenarioError",
    "describe_format",
    "is_advance",
    "load_scenario",
    "parse_scenario",
    "scenario_paths",
    "step_kind",
]
