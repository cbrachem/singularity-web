"""Smoke test: drive the vendored reference simulation headlessly under CPython.

Not the trace oracle itself — only proof that the pinned reference is
runnable in CI: load content, start a game, advance time, observe state change.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
REFERENCE = os.path.join(ROOT, "singularity")

sys.path.insert(0, HERE)
sys.path.insert(0, REFERENCE)

import pygame_stub  # noqa: E402

pygame_stub.install()

from singularity.code import data, dirs, g, savegame  # noqa: E402,F401


def main():
    dirs.create_directories(True)
    data.reload_all()
    g.new_game("normal", 1)
    before = (g.pl.raw_sec, g.pl.cash)
    for _ in range(200):
        g.pl.give_time(600)
    after = (g.pl.raw_sec, g.pl.cash)
    assert after[0] > before[0], "game time did not advance"
    print(f"days={g.pl.raw_day} cash={g.pl.cash} bases={sum(1 for _ in g.all_bases())}")
    print("ok")


if __name__ == "__main__":
    main()
