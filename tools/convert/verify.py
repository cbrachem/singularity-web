"""Check the Content converter against the reference simulation's own loaders.

The converter reproduces one function from the reference — `data.generic_load` — and three
of its hand-written readers. This script is the oracle for that claim: it loads the pinned
reference headlessly, runs upstream's loaders over the same files, and asserts that what the
converter carried across is what upstream ends up holding.

It also asserts the two properties the committed output rests on: the conversion is
deterministic, and `content/` on disk is exactly what a fresh conversion writes.

    .venv/bin/python tools/convert/verify.py
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
REFERENCE = os.path.join(ROOT, "singularity")
ORACLE = os.path.join(ROOT, "tools", "oracle")

sys.path.insert(0, HERE)
sys.path.insert(0, ORACLE)
sys.path.insert(0, REFERENCE)

import pygame_stub  # noqa: E402

pygame_stub.install()

import convert_content  # noqa: E402
import readers  # noqa: E402
import schema  # noqa: E402
from singularity.code import data, dirs, g, warning  # noqa: E402


def promote(value):
    return value if isinstance(value, list) else [value]


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def check_ini_reader():
    """Our copy of generic_load's body must agree with generic_load itself."""
    for name in convert_content.INI_SOURCES:
        path = os.path.join(convert_content.DATA_DIR, name)
        mine = readers.read_ini(path)
        theirs = data.generic_load(path, load_dirs=None)
        check(mine == theirs, "read_ini disagrees with generic_load for %s" % name)
    return len(convert_content.INI_SOURCES)


def check_numbers(documents):
    mine = documents["numbers.json"]["numbers"]
    check(
        mine == g.significant_numbers,
        "numbers.json does not match g.significant_numbers",
    )


def check_internal_ids(documents):
    forward = {}
    backward = {}
    for record in documents["internal_id.json"]["records"]:
        forward.setdefault(record["type"], {})[record["id"]] = record["internal_id"]
        backward.setdefault(record["type"], {})[record["internal_id"]] = record["id"]
    check(forward == g.internal_id_forward, "internal id forward table does not match")
    check(backward == g.internal_id_backward, "internal id backward table does not match")


def check_story(documents):
    sections = documents["story.json"]["records"]
    check(
        [s["id"] for s in sections] == list(g.story),
        "story sections differ from g.story",
    )
    for section in sections:
        theirs = g.story[section["id"]]
        check(
            len(section["parts"]) == len(theirs),
            "story section %s has %d parts, upstream has %d"
            % (section["id"], len(section["parts"]), len(theirs)),
        )
        for mine, part in zip(section["parts"], theirs, strict=True):
            check(
                mine["text"] == part.text,
                "story text differs in section %s" % section["id"],
            )
            check(
                mine["translator_comments"] == part.translator_comments,
                "translator comments differ in section %s" % section["id"],
            )


def check_warnings(documents):
    document = documents["warnings.json"]
    check(document["literal"] is True, "warnings.json is not marked as literal")
    check(document["sources"] == [], "warnings.json claims a source file")
    records = document["records"]
    check(
        [r["id"] for r in records] == list(warning.warnings),
        "warning ids or their order differ from warning.create_warnings()",
    )
    for record in records:
        upstream = warning.warnings[record["id"]]
        check(record["name"] == upstream.name, "warning %s name differs" % record["id"])
        check(
            record["message"] == upstream.message,
            "warning %s message differs" % record["id"],
        )


def check_merge(documents):
    """A merged record is the structural record plus its _str record, nothing else."""
    for name, (structural, strings) in convert_content.MERGED_SOURCES.items():
        merged = {r["id"]: r for r in documents[name + ".json"]["records"]}
        left = {
            r["id"]: r for r in readers.read_ini(os.path.join(convert_content.DATA_DIR, structural))
        }
        right = {
            r["id"]: r for r in readers.read_ini(os.path.join(convert_content.DATA_DIR, strings))
        }
        check(
            list(merged) == list(left),
            "%s records are not in %s order" % (name, structural),
        )
        check(
            set(right) <= set(left),
            "%s has sections with no counterpart in %s" % (strings, structural),
        )
        for object_id, record in merged.items():
            expected = dict(left[object_id])
            expected.update(right.get(object_id, {}))
            check(
                record == expected,
                "%s record %s is not the plain merge of its two sources" % (name, object_id),
            )


def check_loaded_lists(documents):
    """The uniform _list split must land where upstream's per-field allow-lists land."""
    for record in documents["bases.json"]["records"]:
        spec = g.base_type[record["id"]]
        check(
            promote(record["flavor"]) == spec.flavor,
            "flavor differs for base %s" % record["id"],
        )
    for record in documents["locations.json"]["records"]:
        spec = g.locations[record["id"]]
        if "cities" in record:
            check(
                promote(record["cities"]) == spec.cities,
                "cities differ for location %s" % record["id"],
            )
    for record in documents["knowledge.json"]["records"]:
        area = g.knowledge[record["id"]]
        check(record["name"] == area.untranslated_name, "knowledge name differs")
        for key, value in record.items():
            if key in ("id", "name"):
                continue
            entry = area.help_entries[key]
            check(
                value == [entry.untranslated_name, entry.untranslated_description],
                "knowledge entry %s differs" % key,
            )


def check_rejections(documents):
    """The enforcement is a gate, so it has to be shown refusing something."""
    base = dict(documents["bases.json"]["records"][0])
    task = [dict(r) for r in documents["tasks.json"]["records"]]
    event = dict(documents["events.json"]["records"][0])

    def rejects(description, call):
        try:
            call()
        except schema.ContentError:
            return
        raise AssertionError("the converter accepted %s" % description)

    missing = dict(base)
    del missing["size"]
    rejects("a base with no size", lambda: schema.check_record("bases", missing))

    unknown = dict(base, colour="beige")
    rejects("a base with an unknown key", lambda: schema.check_record("bases", unknown))

    not_a_number = dict(base, size="large")
    rejects("a non-integer size", lambda: schema.check_record("bases", not_a_number))

    short_cost = dict(base, cost=["1", "2"])
    rejects("a two-element cost", lambda: schema.check_record("bases", short_cost))

    bad_position = dict(documents["locations.json"]["records"][0], position=["a", "b"])
    rejects(
        "a non-integer position",
        lambda: schema.check_record("locations", bad_position),
    )

    locked = [dict(r, pre="Intrusion") if r["type"] == "jobs" else dict(r) for r in task]
    rejects(
        "a task list where every job has a prerequisite",
        lambda: convert_content.check_tasks(locked),
    )

    forever = dict(event, unique="0", duration="0")
    rejects(
        "an event that neither expires nor happens once",
        lambda: convert_content.check_events([forever]),
    )

    dangling = dict(documents["items.json"]["records"][0], type="nonexistent")
    patched = dict(documents)
    patched["items.json"] = {"sources": [], "records": [dangling]}
    rejects(
        "an item naming an unknown item type",
        lambda: convert_content.check_references(patched),
    )


def check_deterministic():
    once = convert_content.build()
    twice = convert_content.build()
    check(
        convert_content.render(once) == convert_content.render(twice),
        "two conversions of the same reference produced different bytes",
    )


def check_committed(documents):
    directory = convert_content.CONTENT_DIR
    check(os.path.isdir(directory), "content/ does not exist — run the converter")
    on_disk = sorted(os.listdir(directory))
    check(
        on_disk == sorted(documents),
        "content/ holds %s, the converter writes %s" % (on_disk, sorted(documents)),
    )
    rendered = convert_content.render(documents)
    for name, text in rendered.items():
        with open(os.path.join(directory, name), encoding="utf-8") as handle:
            check(
                handle.read() == text,
                "content/%s differs from a fresh conversion" % name,
            )


def check_index(documents):
    index = documents["index.json"]
    listed = [entry["file"] for entry in index["files"]]
    check(
        sorted(listed) == sorted(name for name in documents if name != "index.json"),
        "index.json does not list every written file",
    )
    for entry in index["files"]:
        document = documents[entry["file"]]
        check(
            entry["sources"] == document["sources"],
            "index sources for %s differ from the file itself" % entry["file"],
        )


def main():
    dirs.create_directories(True)
    data.reload_all()

    documents = convert_content.build()
    json.dumps(documents)  # every document must be plain JSON

    ini_files = check_ini_reader()
    check_numbers(documents)
    check_internal_ids(documents)
    check_story(documents)
    check_warnings(documents)
    check_merge(documents)
    check_loaded_lists(documents)
    check_index(documents)
    check_rejections(documents)
    check_deterministic()
    check_committed(documents)

    sources = set(convert_content.INI_SOURCES) | set(convert_content.PLAIN_SOURCES)
    on_disk = {n for n in os.listdir(convert_content.DATA_DIR) if n.endswith(".dat")}
    check(
        sources == on_disk,
        "converter covers %d of the reference's %d data files" % (len(sources), len(on_disk)),
    )

    print(
        "ok: %d ini + %d other data files -> %d json files"
        % (ini_files, len(convert_content.PLAIN_SOURCES), len(documents))
    )


if __name__ == "__main__":
    main()
