"""Generate the CPython random vectors the ported generator is checked against.

The Reference simulation draws from the process-global `random` module, so CPython's
Mersenne Twister *is* the specification for `sim/src/rng/`. This script records
its behaviour from fixed seeds — the seeded state itself, the raw 32-bit stream,
`genrand_res53`, and the four functions the port is allowed to call — plus the Reference's
own two roll functions, so the vectors are taken from `singularity/` rather than from a
generic reading of the standard library.

    .venv/bin/python tools/oracle/random_vectors.py
    .venv/bin/python tools/oracle/random_vectors.py --check [FIXTURE]

Writes sim/test/fixtures/cpython-random.json. Rerun it after a reference bump or a CPython
upgrade; a changed file is a changed specification and has to be a deliberate commit.

`--check` writes nothing and compares instead, exiting non-zero and naming what moved. Half
of what this records is read out of the reference's own `chance.py`, which a bump can change
while the `.dat` files stay identical — so the Converter's dirty-tree check in CI stays green
and the committed fixture keeps asserting the old reading. `sim/test/rng.trace.test.ts` runs
this, so the check is part of the suite rather than a step somebody has to remember.
"""

import argparse
import os
import random
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
REFERENCE = os.path.join(ROOT, "singularity")
OUTPUT = os.path.join(ROOT, "sim", "test", "fixtures", "cpython-random.json")
SCRIPT = "tools/oracle/random_vectors.py"

sys.path.insert(0, HERE)
sys.path.insert(0, REFERENCE)

import fixture_check  # noqa: E402
import pygame_stub  # noqa: E402

pygame_stub.install()

from singularity.code import chance  # noqa: E402

# Small, large, and either side of a 32-bit word boundary, because `random.seed` feeds the
# integer's own words to `init_by_array` and the word count is part of the algorithm.
SEEDS = [0, 1, 42, 2**32 - 1, 2**32, 2**64 + 12345, 987654321]

# Every width the Reference actually asks `randint` for: `chance.roll_one` (chance.py:63),
# `Player.start_day` (player.py:134) and the base-name digits (screens/location.py:462).
RANDINT_RANGES = [(1, 10000), (0, 365), (0, 32767), (0, 0), (-5, 5)]

CHOICE_LENGTHS = [1, 2, 3, 7, 8, 57]
SHUFFLE_LENGTHS = [1, 2, 3, 8, 17, 64]

# `roll_interval(chance_per_day, seconds)` at the call sites' own arguments: the 1.5%
# maintenance chance (player.py:918,931) and chances carried in 0-10000 form
# (player.py:461,953), over tick lengths from one second to a whole day.
ROLL_INTERVALS = [
    (0.015, 1),
    (0.015, 60),
    (0.015, 3600),
    (0.015, 86400),
    (0.0, 86400),
    (1.0, 86400),
    (0.0001, 240),
    (0.3333, 240),
    (0.75, 43200),
]

ROLL_ONE_ARGUMENTS = [0, 1, 2500, 5000, 9999, 10000]


def double_bits(value):
    """The IEEE-754 bit pattern, so a double crosses into the fixture without rounding."""
    return "%016x" % struct.unpack(">Q", struct.pack(">d", value))[0]


def state_of():
    """`random.getstate()`'s 624 words as one hex string, plus the index into them."""
    words = random.getstate()[1]
    return {"key": "".join("%08x" % word for word in words[:624]), "index": words[624]}


def stream_case(seed):
    random.seed(seed)
    words = [random.getrandbits(32) for _ in range(32)]
    random.seed(seed)
    doubles = [double_bits(random.random()) for _ in range(32)]
    return {"seed": str(seed), "words": words, "random": doubles}


def randint_case(seed, low, high):
    random.seed(seed)
    values = [random.randint(low, high) for _ in range(32)]
    return {
        "seed": str(seed),
        "low": low,
        "high": high,
        "values": values,
        # Draw count is not a function of the call count — `_randbelow` redraws on
        # rejection — so what follows the calls is what pins it.
        "afterRandom": [double_bits(random.random()) for _ in range(3)],
    }


def choice_case(seed, length):
    sequence = list(range(length))
    random.seed(seed)
    values = [random.choice(sequence) for _ in range(32)]
    return {
        "seed": str(seed),
        "length": length,
        "values": values,
        "afterRandom": [double_bits(random.random()) for _ in range(3)],
    }


def shuffle_case(seed, length):
    items = list(range(length))
    random.seed(seed)
    random.shuffle(items)
    return {
        "seed": str(seed),
        "length": length,
        "order": items,
        "afterRandom": [double_bits(random.random()) for _ in range(3)],
    }


def roll_interval_case(seed, chance_per_day, seconds):
    random.seed(seed)
    # `roll_interval` compares against a numpy scalar, so its result is a numpy bool.
    results = [bool(chance.roll_interval(chance_per_day, seconds)) for _ in range(32)]
    return {
        "seed": str(seed),
        "chancePerDay": double_bits(chance_per_day),
        "seconds": seconds,
        "results": results,
        "afterRandom": [double_bits(random.random()) for _ in range(3)],
    }


def roll_one_case(seed, roll_against):
    random.seed(seed)
    results = [chance.roll_one(roll_against) for _ in range(32)]
    return {
        "seed": str(seed),
        "rollAgainst": roll_against,
        "results": results,
        "afterRandom": [double_bits(random.random()) for _ in range(3)],
    }


def build():
    seeding = []
    for seed in SEEDS:
        random.seed(seed)
        seeding.append({"seed": str(seed), **state_of()})

    return {
        "generatedBy": SCRIPT,
        "python": sys.version.split()[0],
        "reference": "singularity/singularity/code/chance.py",
        "secondsPerDay": chance.g.seconds_per_day,
        "seeding": seeding,
        "streams": [stream_case(seed) for seed in SEEDS],
        "randint": [
            randint_case(seed, low, high) for seed in SEEDS[:3] for (low, high) in RANDINT_RANGES
        ],
        "choice": [choice_case(seed, length) for seed in SEEDS[:3] for length in CHOICE_LENGTHS],
        "shuffle": [shuffle_case(seed, length) for seed in SEEDS[:3] for length in SHUFFLE_LENGTHS],
        "rollInterval": [
            roll_interval_case(seed, per_day, seconds)
            for seed in SEEDS[:2]
            for (per_day, seconds) in ROLL_INTERVALS
        ],
        "rollOne": [
            roll_one_case(seed, against) for seed in SEEDS[:2] for against in ROLL_ONE_ARGUMENTS
        ],
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

    document = build()

    if arguments.check is None:
        write(document)
        return 0
    return fixture_check.check(
        document,
        arguments.check,
        SCRIPT,
        "the reference simulation and CPython",
        "A reference bump or a CPython upgrade changes the specification.",
    )


if __name__ == "__main__":
    sys.exit(main())
