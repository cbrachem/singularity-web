"""Record how far the ported fdlibm `exp` is from numpy's, over the domain that matters.

This measures an accepted risk: the Reference computes
`chance = 1 - np.exp(-interval_rate)` (`singularity/singularity/code/chance.py:42`) and
compares a draw against it, so wherever numpy and the port round differently the comparison
can flip. The port does not chase numpy — a bit-exact numpy `exp` would cost a multiple of
the MT19937 port — it keeps the difference measured and visible.

This script writes that measurement down. It asks the port for its own `exp` over the grid
(`sim/test/support/exp-grid.ts`), computes numpy's over the same doubles, and records the
digest of numpy's run together with the ULP offset at every point where the two differ. The
test reconstructs numpy's run from the port's plus those offsets and checks the digest, so a
regression in the port cannot pass by quietly agreeing with a stale fixture.

    .venv/bin/python tools/oracle/exp_vectors.py

Writes sim/test/fixtures/numpy-exp.json.
"""

import os
import shutil
import struct
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
GRID = os.path.join(ROOT, "sim", "test", "support", "exp-grid.ts")
OUTPUT = os.path.join(ROOT, "sim", "test", "fixtures", "numpy-exp.json")

sys.path.insert(0, HERE)

import fixture_check  # noqa: E402

# Kept in step with STEPS in sim/test/support/exp-grid.ts; the test asserts they agree.
STEPS = 20000

FNV_OFFSET = 0xCBF29CE484222325
FNV_PRIME = 0x100000001B3
MASK64 = 0xFFFFFFFFFFFFFFFF


def digest(bit_patterns):
    """FNV-1a over the 64-bit patterns — the same walk as `digest` in exp-grid.ts."""
    value = FNV_OFFSET
    for pattern in bit_patterns:
        for shift in range(56, -8, -8):
            value = ((value ^ ((pattern >> shift) & 0xFF)) * FNV_PRIME) & MASK64
    return "%016x" % value


def port_exp_bits():
    runtime = shutil.which("bun") or shutil.which("node")
    if runtime is None:
        sys.exit("neither bun nor node is on PATH; both can run sim/test/support/exp-grid.ts")
    emitted = subprocess.run(
        [runtime, GRID, "bits"], cwd=ROOT, check=True, capture_output=True, text=True
    )
    return [int(line, 16) for line in emitted.stdout.split()]


def main():
    port = port_exp_bits()
    points = STEPS + 1
    if len(port) != points:
        sys.exit("the port emitted %d points, expected %d" % (len(port), points))

    arguments = np.array([-(index / STEPS) for index in range(points)])
    computed = np.exp(arguments)
    reference = [struct.unpack(">Q", struct.pack(">d", float(value)))[0] for value in computed]

    # Both runs are positive and finite over this domain, so a difference in the bit pattern
    # is a difference in units in the last place, and the offset carries its own sign.
    offsets = [
        [index, reference[index] - port[index]]
        for index in range(points)
        if reference[index] != port[index]
    ]
    largest = max(
        (
            abs(float(computed[index]) - struct.unpack(">d", struct.pack(">Q", port[index]))[0])
            for index, _ in offsets
        ),
        default=0.0,
    )

    fixture = {
        "generatedBy": "tools/oracle/exp_vectors.py",
        "python": sys.version.split()[0],
        "numpy": np.__version__,
        "steps": STEPS,
        "digest": digest(reference),
        "differing": len(offsets),
        "differingFraction": round(len(offsets) / points, 6),
        "largestAbsoluteDifference": "%016x" % struct.unpack(">Q", struct.pack(">d", largest))[0],
        "ulpOffsets": offsets,
    }

    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(fixture_check.render(fixture))
    print(
        "wrote %s — %d of %d points differ, largest |delta| %.17g"
        % (os.path.relpath(OUTPUT, ROOT), len(offsets), points, largest)
    )


if __name__ == "__main__":
    main()
