"""Minimal permissive stand-in for pygame.

The reference simulation is headless, but four modules still import pygame at load
time (`data.py -> graphics.theme` chief among them). Nothing here is called during a
tick; this only satisfies the imports. Install with `install()` before importing
`singularity.code`.
"""

import sys
import types


class _Any:
    def __init__(self, *args, **kwargs):
        pass

    def __getattr__(self, name):
        return _Any()

    def __call__(self, *args, **kwargs):
        return _Any()

    def __bool__(self):
        return False

    def __lt__(self, other):
        return False

    def __gt__(self, other):
        return False

    def __le__(self, other):
        return False

    def __ge__(self, other):
        return False

    def __iter__(self):
        return iter(())

    def __getitem__(self, key):
        return _Any()

    def __len__(self):
        return 0


def _module(name):
    mod = types.ModuleType(name)
    mod.__getattr__ = lambda attr: _Any()
    return mod


def install():
    for name in (
        "pygame",
        "pygame.font",
        "pygame.mixer",
        "pygame.display",
        "pygame.image",
        "pygame.transform",
        "pygame.draw",
        "pygame.event",
        "pygame.key",
        "pygame.time",
        "pygame.locals",
    ):
        sys.modules.setdefault(name, _module(name))

    # The one attribute the widget stack branches on at import time.
    version = _module("pygame.version")
    version.vernum = (2, 6, 0)
    sys.modules["pygame.version"] = version
    sys.modules["pygame"].version = version
