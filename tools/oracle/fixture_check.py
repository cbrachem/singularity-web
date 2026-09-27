"""Compare a committed oracle fixture against a record built from the reference *now*.

The scripts in this directory write fixtures that `sim/test/` then reads as specification,
comparing the port against them value by value. What nothing else compares is the fixture
against the reference after the moment it was generated: a bump that changes
a loader or a roll function in `singularity/` leaves `content/` byte-identical, so the
Converter's dirty-tree check in CI stays green while the committed fixture goes on asserting
the old reading.

So a fixture script takes `--check [FIXTURE]`: it builds its record as usual, writes nothing,
and compares. This module is the half those scripts share — the walk that names *what* moved,
rather than handing over a diff of one long line of minified JSON.
"""

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# What a record is *about* rather than part of: the port is compared against the values, and
# an interpreter that read them differently would show up as a differing value rather than as
# a differing version string. Excluding these is what lets the check run on whatever
# interpreter CI provisioned.
PROVENANCE = ("generatedBy", "python")

# What identifies an entry within a collection, when it carries one. Content records key by
# id; the random vectors carry the seed they were drawn from instead.
LABEL_KEYS = ("id", "seed")

MISSING = object()

# Enough to see what moved without pasting the fixture into a CI log.
REPORTED = 12


def render(document):
    """The one shape a committed fixture is written in — every generator here writes through it.

    Two-space indent because a fixture is read in a diff, and one shape because `oxfmt` does
    not format these files: `.oxfmtrc.json` ignores `sim/test/fixtures/`, so what
    a generator writes is what stays committed, and a regeneration leaves `format:check`
    green with no reformatting step in between. `reshaped` below is what holds that: put the
    directory back under the formatter and the `--check` runs in the suite go red.
    """
    return json.dumps(document, indent=2, ensure_ascii=False) + "\n"


def named(path):
    relative = os.path.relpath(path, ROOT)
    return path if relative.startswith(os.pardir) else relative


def shown(value):
    if value is MISSING:
        return "absent"
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= 120 else text[:117] + "…"


def entry_label(index, entry):
    if isinstance(entry, dict):
        for key in LABEL_KEYS:
            name = entry.get(key)
            if isinstance(name, str):
                return "[%d %s]" % (index, json.dumps(name))
    return "[%d]" % index


def differences(committed, fresh, path):
    """Every place the two records disagree, as (path, committed, fresh)."""
    if isinstance(committed, dict) and isinstance(fresh, dict):
        keys = list(committed) + [key for key in fresh if key not in committed]
        for key in keys:
            child = "%s.%s" % (path, key) if path else key
            yield from differences(committed.get(key, MISSING), fresh.get(key, MISSING), child)
    elif isinstance(committed, list) and isinstance(fresh, list):
        if len(committed) != len(fresh):
            yield (path, "%d entries" % len(committed), "%d entries" % len(fresh))
        # Not strict: a length difference is reported above and then walked as far as the
        # shorter side goes, because the entries that do line up are the readable part.
        for index, (left, right) in enumerate(zip(committed, fresh, strict=False)):
            yield from differences(left, right, path + entry_label(index, right))
    elif committed != fresh:
        yield (path, shown(committed), shown(fresh))


def add_check_argument(parser, output):
    parser.add_argument(
        "--check",
        nargs="?",
        const=output,
        default=None,
        metavar="FIXTURE",
        help="compare against a committed fixture instead of writing one",
    )


def reshaped(path):
    """Whether a committed fixture has drifted out of the shape `render` writes.

    The values are compared below; this compares the *shape*, which is what makes a
    regeneration's diff readable. A fixture reformatted by hand or by a formatter that
    reclaimed the directory still holds every value, so nothing else here would
    say so, and the next regeneration would then rewrite the whole file for no reason.

    Only for a fixture in this repository: `--check` also takes a path, and the tests that
    exercise it hand over a mutated copy in a temporary directory, whose shape is theirs.
    """
    if os.path.relpath(path, ROOT).startswith(os.pardir):
        return ""
    with open(path, encoding="utf-8", newline="") as handle:
        text = handle.read()
    return "" if text == render(json.loads(text)) else named(path)


def check(document, path, script, subject, cause):
    """0 when the committed fixture still says what the reference says, 1 when it does not."""
    with open(path, encoding="utf-8") as handle:
        committed = json.load(handle)

    out_of_shape = reshaped(path)

    # Through the same serialisation the file went through, so a tuple compares as the list
    # it is written as rather than as something else.
    fresh = json.loads(render(document))
    record = {name: value for name, value in fresh.items() if name not in PROVENANCE}
    against = {name: value for name, value in committed.items() if name not in PROVENANCE}

    found = list(differences(against, record, ""))
    interpreter_note = "%s was recorded on CPython %s; this run is %s" % (
        named(path),
        committed.get("python", "an unrecorded interpreter"),
        fresh["python"],
    )

    if not found and not out_of_shape:
        print("%s matches %s" % (named(path), subject))
        if committed.get("python") != fresh["python"]:
            print("(%s — provenance only, no value differs)" % interpreter_note)
        return 0

    if not found:
        sys.stderr.write(
            "%s still matches %s, but is not in the shape %s writes.\n"
            "Rewrite it in that shape, so a regeneration diffs only what moved:\n"
            "  .venv/bin/python %s\n" % (out_of_shape, subject, script, script)
        )
        return 1

    lines = [
        "%s no longer matches %s." % (named(path), subject),
        "%d difference(s); committed, then what the reference now holds:" % len(found),
    ]
    for where, was, now in found[:REPORTED]:
        lines.append("  %s: %s -> %s" % (where or "(the record)", was, now))
    if len(found) > REPORTED:
        lines.append("  … and %d more" % (len(found) - REPORTED))
    if committed.get("python") != fresh["python"]:
        lines.append(interpreter_note + ", which is worth ruling out first.")
    lines.append("")
    lines.append("%s Regenerate deliberately and read the diff:" % cause)
    lines.append("  .venv/bin/python %s" % script)

    sys.stderr.write("\n".join(lines) + "\n")
    return 1
