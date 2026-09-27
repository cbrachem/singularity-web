"""Record what the reference's player log does when it is driven past its cap.

`Player.__init__` makes the log a bounded ring — `collections.deque(maxlen=1000)`
(`player.py:112`) — so the reference silently drops the oldest entry once a game has
produced more than a thousand. The cap is observable: `Player.serialize_obj` writes the
whole deque out (`player.py:644`), and `Player.deserialize_obj` reads a saved log back
through the same bound (`player.py:689`), so a save carrying more than the cap loses its
oldest entries at load.

Nothing in a committed Scenario reaches a thousand entries yet, so the port cannot be
compared against a recorded Trace here. This records the three answers instead, off the
reference itself:

    .venv/bin/python tools/oracle/log_ring.py
    .venv/bin/python tools/oracle/log_ring.py --check [FIXTURE]

Writes sim/test/fixtures/reference-log-ring.json. `--check` writes nothing and compares
instead, exiting non-zero and naming what moved; `sim/test/log.trace.test.ts` runs it, so a
reference bump that changes the cap is caught by the suite rather than by somebody
remembering. Rerun it after a reference bump — a changed fixture is a changed specification.
"""

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
REFERENCE = os.path.join(ROOT, "singularity")
OUTPUT = os.path.join(ROOT, "sim", "test", "fixtures", "reference-log-ring.json")
SCRIPT = "tools/oracle/log_ring.py"

sys.path.insert(0, HERE)
sys.path.insert(0, REFERENCE)

import fixture_check  # noqa: E402
import pygame_stub  # noqa: E402

pygame_stub.install()

from singularity.code import data, dirs, g, savegame  # noqa: E402
from singularity.code.logmessage import LogEmittedEvent  # noqa: E402
from singularity.code.player import Player  # noqa: E402

DIFFICULTY = "normal"
SEED = 1

# One more than the cap, so the ring has to drop exactly one entry and the entry it drops is
# the one a test can name. Emit times count from 0, so the oldest survivor is 1.
OVER_BY = 1


def span(entries, key):
    """What a run of log entries covers, as the ends a test compares."""
    times = [entry[key] for entry in entries]
    return {
        "entries": len(entries),
        "oldestRawEmitTime": times[0] if times else None,
        "newestRawEmitTime": times[-1] if times else None,
    }


def appended(player, event_id, count):
    """`Player.append_log` (`player.py:175`), called past the cap."""
    for raw_emit_time in range(count):
        player.append_log(LogEmittedEvent(raw_emit_time, event_id))
    return span([{"raw_emit_time": entry.raw_emit_time} for entry in player.log], "raw_emit_time")


def restored(player, saved_log, game_version):
    """`Player.deserialize_obj` (`player.py:689`), handed a log longer than the cap."""
    obj_data = player.serialize_obj()
    obj_data["log"] = saved_log
    loaded = Player.deserialize_obj(DIFFICULTY, player.raw_sec, obj_data, game_version)
    return span([entry.serialize_obj() for entry in loaded.log], "raw_emit_time")


def build():
    dirs.create_directories(True)
    data.reload_all()
    g.new_game(DIFFICULTY, SEED)
    player = g.pl

    cap = player.log.maxlen
    # The first event by id, so the record names the same one on every run. Which event it is
    # does not matter — the log holds every kind in one ring.
    event_id = sorted(g.events)[0]
    over = cap + OVER_BY

    appended_span = appended(player, event_id, over)
    serialised = player.serialize_obj()["log"]

    # A saved log longer than the cap, in the schema's own form: the ids are internal, which
    # is what `id_converter("event")` writes and reads back (`logmessage.py:181`).
    internal = g.to_internal_id("event", event_id)
    offered = [
        {
            "log_id": LogEmittedEvent.log_message_serial_id,
            "raw_emit_time": time,
            "event_id": internal,
        }
        for time in range(over)
    ]
    version = savegame.current_save_format.internal_version

    return {
        "generatedBy": SCRIPT,
        "python": sys.version.split()[0],
        "reference": "singularity/singularity/code/player.py",
        "maxEntries": cap,
        "eventId": event_id,
        "appendedPastTheCap": {"offered": over, **appended_span},
        "serialised": span(serialised, "raw_emit_time"),
        "restoredPastTheCap": {
            "offered": len(offered),
            **restored(player, offered, version),
        },
    }


def write(document):
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(fixture_check.render(document))
    print(
        "wrote %s — cap %d, %d offered, %d kept"
        % (
            fixture_check.named(OUTPUT),
            document["maxEntries"],
            document["appendedPastTheCap"]["offered"],
            document["appendedPastTheCap"]["entries"],
        )
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    fixture_check.add_check_argument(parser, OUTPUT)
    arguments = parser.parse_args()

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
