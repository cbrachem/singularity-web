"""Transcribe the reference simulation's Content into the committed JSON under `content/`.

    .venv/bin/python tools/convert/convert_content.py

Reads the twenty-four data files of the pinned reference and writes one JSON document per
object type plus an index. The conversion is deterministic and its output is committed, so
re-running it and finding no diff is what says the port's Content still matches upstream.
`tools/convert/verify.py` is the oracle check that
what is carried across is what upstream's own loaders end up holding.

The converter transcribes. Its only liberties are the `_list` split — the file format rather
than a reading of it — and merging each structural file with its `_str` counterpart into one
record per object. Resolving references, positions, prerequisites and the `6/5` modifiers
belongs to the port's loader, where a Trace can still reach it.
"""

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

sys.path.insert(0, HERE)

import readers  # noqa: E402
import schema  # noqa: E402

DATA_DIR = os.path.join(ROOT, "singularity", "singularity", "data")
CONTENT_DIR = os.path.join(ROOT, "content")

# Object types whose structural file is merged with its _str counterpart.
MERGED_SOURCES = {
    "groups": ("groups.dat", "groups_str.dat"),
    "difficulties": ("difficulties.dat", "difficulties_str.dat"),
    "tasks": ("tasks.dat", "tasks_str.dat"),
    "events": ("events.dat", "events_str.dat"),
    "locations": ("locations.dat", "locations_str.dat"),
    "techs": ("techs.dat", "techs_str.dat"),
    "itemtypes": ("itemtypes.dat", "itemtypes_str.dat"),
    "items": ("items.dat", "items_str.dat"),
    "bases": ("bases.dat", "bases_str.dat"),
}

# Object types with a single INI file. `regions` has no strings; `dangers` and `knowledge`
# are strings with no structural half.
SINGLE_SOURCES = {
    "dangers": "dangers_str.dat",
    "knowledge": "knowledge_str.dat",
    "regions": "regions.dat",
}

# The three files that are not INI.
PLAIN_SOURCES = ("internal_id.dat", "numbers.dat", "story.dat")

INI_SOURCES = tuple(name for pair in MERGED_SOURCES.values() for name in pair) + tuple(
    SINGLE_SOURCES.values()
)

# load_warning_defs (data.py:580) writes these as Python literals: there is no source file
# for them, so the diff over content/ cannot see a change upstream makes to them and they
# must be checked by hand at a reference bump. They are marked as literal in the output.
WARNINGS = [
    {
        "id": "cpu_usage",
        "name": "Do not use all the available CPU.",
        "message": (
            "I didn't use all the available processor power. I will use the CPU time"
            " left to work whatever Jobs I can."
        ),
    },
    {
        "id": "one_base",
        "name": "Only one base remaining.",
        "message": (
            "Only one base can hold my conscience. I am in danger to lose the last"
            " place left to survive."
        ),
    },
    {
        "id": "cpu_pool_zero",
        "name": "CPU POOL is empty.",
        "message": ("My cpu pool is empty. Some of my bases or items cannot be build without CPU."),
    },
    {
        "id": "cpu_maintenance",
        "name": "CPU POOL not enough for maintenance.",
        "message": ("My cpu pool is not enough to maintain some of my bases. I may lose them."),
    },
]

WARNINGS_NOTE = (
    "No source file: load_warning_defs writes these as Python literals, so the diff over"
    " content/ cannot see an upstream change to them. Check them by hand at a reference"
    " bump."
)

# Order follows data.reload_all(), which is load order: item types before the items that
# name one, regions before the locations that name one.
OUTPUT_ORDER = (
    "internal_id",
    "dangers",
    "numbers",
    "story",
    "warnings",
    "groups",
    "knowledge",
    "difficulties",
    "tasks",
    "events",
    "regions",
    "locations",
    "techs",
    "itemtypes",
    "items",
    "bases",
)


def _document(sources, records):
    return {"sources": list(sources), "records": records}


def _merge(structural_file, strings_file):
    structural = readers.read_ini(os.path.join(DATA_DIR, structural_file))
    strings = {
        record["id"]: record for record in readers.read_ini(os.path.join(DATA_DIR, strings_file))
    }

    unmatched = set(strings) - {record["id"] for record in structural}
    if unmatched:
        raise schema.ContentError(
            "%s has sections with no counterpart in %s: %s"
            % (strings_file, structural_file, ", ".join(sorted(unmatched)))
        )

    merged = []
    for record in structural:
        combined = dict(record)
        for field, value in strings.get(record["id"], {}).items():
            if field != "id":
                combined[field] = value
        merged.append(combined)
    return merged


def check_regions(records):
    """load_regions scans modifier1, modifier2, ... and stops at the first gap."""
    for record in records:
        index = 0
        while "modifier%d" % (index + 1) in record:
            index += 1
        expected = {"id"} | {"modifier%d" % n for n in range(1, index + 1)}
        unknown = set(record) - expected
        if unknown:
            raise schema.ContentError(
                "region %s has unknown keys: %s" % (record["id"], ", ".join(sorted(unknown)))
            )
        for number in range(1, index + 1):
            field = "modifier%d" % number
            schema.check_field("regions", record["id"], field, record[field], schema.MODIFIERS)


def check_knowledge(records):
    """load_knowledge requires every entry beside the area name to be a pair."""
    for record in records:
        schema.check_record("knowledge", {"id": record["id"], "name": record["name"]})
        for field, value in record.items():
            if field in ("id", "name"):
                continue
            if not isinstance(value, list) or len(value) != 2:
                raise schema.ContentError(
                    "knowledge %s entry %s must be a name/description pair" % (record["id"], field)
                )


def check_dangers(records):
    """load_danger derives the danger level from the id."""
    for record in records:
        schema.check_record("dangers", record)
        danger_id = record["id"]
        if not danger_id.startswith("danger_"):
            raise schema.ContentError("invalid format for danger id: %s" % danger_id)
        try:
            int(danger_id[7:])
        except ValueError:
            raise schema.ContentError("danger id %s has no level" % danger_id) from None


def check_tasks(records):
    """load_tasks accepts two types, and the game needs one job nobody has to unlock."""
    unlocked = False
    for record in records:
        schema.check_record("tasks", record)
        if record["type"] == "jobs":
            if "value" not in record:
                raise schema.ContentError("task %s lacks key value" % record["id"])
            if "pre" not in record:
                unlocked = True
        elif record["type"] != "cpu_pool":
            raise schema.ContentError(
                "only jobs and cpu_pool tasks are supported, task %s is %s"
                % (record["id"], record["type"])
            )
    if not unlocked:
        raise schema.ContentError(
            "a minimum of one job task without prerequisite is needed for the game"
        )


def check_events(records):
    """EventSpec refuses an event that neither expires nor happens once."""
    for record in records:
        schema.check_record("events", record)
        duration = int(record.get("duration", 0))
        unique = int(record.get("unique", 0))
        if duration < 1 and not unique:
            raise schema.ContentError(
                "event %s must have either a non-zero duration or be unique" % record["id"]
            )


def check_references(documents):
    """The two cross-file lookups upstream's loaders exit on."""
    regions = {record["id"] for record in documents["regions.json"]["records"]}
    for record in documents["locations.json"]["records"]:
        for region in schema.promote(record.get("region", [])):
            if region not in regions:
                raise schema.ContentError(
                    "location %s names unknown region %s" % (record["id"], region)
                )

    item_types = {record["id"] for record in documents["itemtypes.json"]["records"]}
    for record in documents["items.json"]["records"]:
        if record["type"] not in item_types:
            raise schema.ContentError(
                "item %s names unknown item type %s" % (record["id"], record["type"])
            )


def build():
    """Read the reference and return every output document, keyed by file name."""
    documents = {}

    for kind, (structural_file, strings_file) in MERGED_SOURCES.items():
        documents[kind + ".json"] = _document(
            (structural_file, strings_file), _merge(structural_file, strings_file)
        )

    for kind, source in SINGLE_SOURCES.items():
        documents[kind + ".json"] = _document(
            (source,), readers.read_ini(os.path.join(DATA_DIR, source))
        )

    documents["numbers.json"] = {
        "sources": ["numbers.dat"],
        "numbers": readers.read_numbers(os.path.join(DATA_DIR, "numbers.dat")),
    }
    documents["internal_id.json"] = _document(
        ("internal_id.dat",),
        readers.read_internal_ids(os.path.join(DATA_DIR, "internal_id.dat")),
    )
    documents["story.json"] = _document(
        ("story.dat",), readers.read_story(os.path.join(DATA_DIR, "story.dat"))
    )
    documents["warnings.json"] = {
        "sources": [],
        "literal": True,
        "note": WARNINGS_NOTE,
        "records": [dict(record) for record in WARNINGS],
    }

    for kind in MERGED_SOURCES:
        if kind not in ("tasks", "events"):
            for record in documents[kind + ".json"]["records"]:
                schema.check_record(kind, record)
    check_tasks(documents["tasks.json"]["records"])
    check_events(documents["events.json"]["records"])
    check_dangers(documents["dangers.json"]["records"])
    check_knowledge(documents["knowledge.json"]["records"])
    check_regions(documents["regions.json"]["records"])
    check_references(documents)

    documents["index.json"] = {
        "files": [
            {
                "name": kind,
                "file": kind + ".json",
                "sources": documents[kind + ".json"]["sources"],
                "literal": documents[kind + ".json"].get("literal", False),
                "count": len(
                    documents[kind + ".json"].get(
                        "records", documents[kind + ".json"].get("numbers", [])
                    )
                ),
            }
            for kind in OUTPUT_ORDER
        ]
    }

    missing = set(OUTPUT_ORDER) - {name[: -len(".json")] for name in documents}
    if missing:  # pragma: no cover - a name in OUTPUT_ORDER that build() never wrote
        raise schema.ContentError("index names files that were not built: %s" % missing)
    return documents


def render(documents):
    """Serialise every document. Indented and not ASCII-escaped, so the diff is readable
    and a non-ASCII character introduced by a future bump appears as itself."""
    return {
        name: json.dumps(document, indent=2, ensure_ascii=False) + "\n"
        for name, document in documents.items()
    }


def write(documents, directory=CONTENT_DIR):
    os.makedirs(directory, exist_ok=True)
    written = render(documents)
    for name, text in sorted(written.items()):
        with open(os.path.join(directory, name), "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)

    stale = set(os.listdir(directory)) - set(written)
    if stale:
        raise schema.ContentError(
            "content/ holds files the converter did not write: %s" % ", ".join(sorted(stale))
        )
    return sorted(written)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default=CONTENT_DIR, help="directory to write (default: content/)")
    arguments = parser.parse_args()

    names = write(build(), arguments.out)
    print("wrote %d files to %s" % (len(names), os.path.relpath(arguments.out, ROOT)))


if __name__ == "__main__":
    main()
