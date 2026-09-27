"""Record what the Reference simulation holds after it has loaded its own Content.

`tools/convert/verify.py` proves that the committed JSON under `content/` says what the
`.dat` files say. It stops there on purpose: the converter transcribes and does not
interpret, so the reading — a location's region references, the `absolute`
prefix in a position, prerequisite promotion, the division in a `6/5` modifier — happens in
the port's loader instead, where a Trace can reach it.

This script is the oracle for *that* half. It loads the pinned reference headlessly, lets
upstream's own loaders run, and writes down the values they end up holding, under upstream's
own field names. `sim/test/content.trace.test.ts` projects the port's loaded Content into the
same shape and compares, so a misread fraction or a dropped region expansion is a failing
test naming the object rather than two numbers that differ with nothing to blame.

Collection order is part of the record, everywhere, because it is contract: event
checking rolls per event and returns on the first hit, and `Region` shuffles an index list
against `spec.locations`, so a reordered collection moves every later draw.

    .venv/bin/python tools/oracle/content_vectors.py
    .venv/bin/python tools/oracle/content_vectors.py --check [FIXTURE]

Writes sim/test/fixtures/reference-content.json. Rerun it after a reference bump; a changed
file is a changed specification and has to be a deliberate commit.

`--check` writes nothing and compares instead, exiting non-zero and naming what moved. That
is the half a bump can invalidate without touching `content/`: the `.dat` files stay
identical while a loader in `singularity/` changes how it reads them, so the Converter's
dirty-tree check in CI stays green and the committed fixture keeps asserting the old reading.
`sim/test/content.trace.test.ts` runs this, so the check is part of the suite
rather than a step somebody has to remember.
"""

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
REFERENCE = os.path.join(ROOT, "singularity")
OUTPUT = os.path.join(ROOT, "sim", "test", "fixtures", "reference-content.json")
SCRIPT = "tools/oracle/content_vectors.py"

sys.path.insert(0, HERE)
sys.path.insert(0, REFERENCE)

import fixture_check  # noqa: E402
import pygame_stub  # noqa: E402

pygame_stub.install()

from singularity.code import data, difficulty, dirs, g, item, warning  # noqa: E402


def regions():
    return [
        {
            "id": spec.id,
            "modifiers_list": [dict(modifiers) for modifiers in spec.modifiers_list],
            # Appended by load_locations in location order, and shuffled against by
            # Region.__init__ — so this order is contract, not presentation.
            "locations": list(spec.locations),
        }
        for spec in g.regions.values()
    ]


def locations():
    return [
        {
            "id": spec.id,
            "absolute": spec.absolute,
            "x": spec.x,
            "y": spec.y,
            "safety": spec.safety,
            "regions": list(spec.regions),
            "modifiers": dict(spec.modifiers),
            "prerequisites": list(spec.prerequisites),
            "name": spec.name,
            "hotkey": spec.hotkey,
            "cities": list(spec.cities),
        }
        for spec in g.locations.values()
    ]


def bases():
    return [
        {
            "id": spec.id,
            "size": spec.size,
            "force_cpu": spec.force_cpu,
            # BuyableSpec.regions replaces a region id with that region's locations; the
            # flag is upstream's _region_all, which "ALL" anywhere in the list sets.
            "regions": list(spec.regions),
            "region_all": spec._region_all,
            "detect_chance": dict(spec.detect_chance),
            "cost": list(spec._cost),
            "maintenance": list(spec.maintenance),
            "prerequisites": list(spec.prerequisites),
            # No danger: BaseSpec declares the field and then drops it, because
            # create_from_data_file passes only what __init__ names and __init__ does not
            # name danger. Upstream holds no such attribute, so neither does the port.
            "name": spec.name,
            "description": spec.description,
            "flavor": list(spec.flavor),
        }
        for spec in g.base_type.values()
    ]


def items():
    return [
        {
            "id": spec.id,
            "cost": list(spec._cost),
            "item_type": spec.item_type.id,
            "qualities": dict(spec.item_qual),
            "regions": list(spec.regions),
            "region_all": spec._region_all,
            "prerequisites": list(spec.prerequisites),
            "name": spec.name,
            "description": spec.description,
        }
        for spec in g.items.values()
    ]


def item_types():
    return [
        {"id": spec.id, "is_extra": spec.is_extra, "text": spec.text}
        for spec in item.item_types.values()
    ]


def techs():
    return [
        {
            "id": spec.id,
            "cost": list(spec._cost),
            "prerequisites": list(spec.prerequisites),
            "danger": spec.danger,
            "effect_stack": list(spec.effect.effect_stack),
            "name": spec.name,
            "description": spec.description,
            "result": spec.result,
        }
        for spec in g.techs.values()
    ]


def events():
    return [
        {
            "id": spec.id,
            "event_type": spec.event_type,
            "effect_stack": list(spec.effect.effect_stack),
            "chance": spec.chance,
            # EventSpec turns a non-positive duration into None, which is what
            # decayable_event tests.
            "duration": spec.duration,
            "unique": spec.unique,
            "description": spec.description,
            "log_description": spec.log_description,
        }
        for spec in g.events.values()
    ]


def tasks():
    return [
        {
            "id": task.id,
            "type": task.type,
            # load_tasks forces both of these for a cpu_pool task, whatever the file says.
            "value": task.value,
            "prerequisites": list(task.prerequisites),
            "name": task.name,
            "description": task.description,
        }
        for task in g.tasks.values()
    ]


def difficulties():
    return [
        {
            "id": spec.id,
            "starting_cash": spec.starting_cash,
            "starting_interest_rate": spec.starting_interest_rate,
            "labor_multiplier": spec.labor_multiplier,
            "discover_multiplier": spec.discover_multiplier,
            "suspicion_multiplier": spec.suspicion_multiplier,
            "base_grace_multiplier": spec.base_grace_multiplier,
            "grace_period_cpu": spec.grace_period_cpu,
            "old_difficulty_value": spec.old_difficulty_value,
            "techs": list(spec.techs),
            "name": spec.name,
        }
        for spec in difficulty.difficulties.values()
    ]


def groups():
    return [
        {
            "id": spec.id,
            "suspicion_decay": spec.suspicion_decay,
            "name": spec.name,
            "discover_log": spec.discover_log,
            "discover_desc": spec.discover_desc,
        }
        for spec in g.groups.values()
    ]


def dangers():
    return [
        {
            "level": level,
            "id": danger.id,
            "research_desc": danger.untranslated_research_desc,
            "knowledge_desc": danger.untranslated_knowledge_desc,
        }
        for level, danger in g.dangers.items()
    ]


def knowledge():
    return [
        {
            "id": area.id,
            "name": area.untranslated_name,
            "entries": [
                {
                    "id": entry.id,
                    "name": entry.untranslated_name,
                    "description": entry.untranslated_description,
                }
                for entry in area.help_entries.values()
            ],
        }
        for area in g.knowledge.values()
    ]


def warnings():
    return [{"id": w.id, "name": w.name, "message": w.message} for w in warning.warnings.values()]


def story():
    return [
        {
            "id": section_id,
            "parts": [
                {"text": part.text, "translator_comments": part.translator_comments}
                for part in parts
            ],
        }
        for section_id, parts in g.story.items()
    ]


def internal_ids():
    return {
        "forward": {obj_type: dict(table) for obj_type, table in g.internal_id_forward.items()},
        "backward": {obj_type: dict(table) for obj_type, table in g.internal_id_backward.items()},
    }


def build():
    return {
        "generatedBy": SCRIPT,
        "python": sys.version.split()[0],
        "regions": regions(),
        "locations": locations(),
        "bases": bases(),
        "items": items(),
        "itemTypes": item_types(),
        "techs": techs(),
        "events": events(),
        "tasks": tasks(),
        "difficulties": difficulties(),
        "groups": groups(),
        "dangers": dangers(),
        "knowledge": knowledge(),
        "warnings": warnings(),
        "story": story(),
        "internalIds": internal_ids(),
        "numbers": list(g.significant_numbers),
    }


def write(document):
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(fixture_check.render(document))

    counted = ", ".join(
        "%d %s" % (len(document[name]), name)
        for name in document
        if isinstance(document[name], list)
    )
    print("wrote %s — %s" % (fixture_check.named(OUTPUT), counted))


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    fixture_check.add_check_argument(parser, OUTPUT)
    arguments = parser.parse_args()

    dirs.create_directories(True)
    data.reload_all()

    document = build()

    if arguments.check is None:
        write(document)
        return 0
    return fixture_check.check(
        document,
        arguments.check,
        SCRIPT,
        "the reference simulation",
        "A reference bump changes the specification.",
    )


if __name__ == "__main__":
    sys.exit(main())
