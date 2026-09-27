"""Drive the pinned reference simulation through a Scenario and record a Trace.

This is the Oracle in its recording role. One Scenario step produces one **trace
record**, carrying four parts in this order of importance:

1. **persistent** — the state in upstream's own save schema (`savegame.py`: the header's
   `difficulty` and `game_time`, plus `g.pl.serialize_obj()` and `stats.serialize_obj()`).
   The header's wall-clock `time` is left out: it is the one non-deterministic field, and
   nothing in the game reads it.
2. **derived** — what upstream does not persist because it rebuilds it at load. Traced
   anyway: a fault in `recalc_cpu` shows up here one tick before it reaches persistent
   state.
3. **effects** — the calls and attribute sets the Simulation makes into the GUI, captured by
   a recorder standing in for the map screen. Nothing reads the GUI; the stub *is* the
   capture.
4. **draws** — the RNG draw log, `(function, result)` pairs in order and deliberately
   **without call sites**. Sites would bind arrangement, which the port is free to change;
   the bare sequence binds sequencing, which it is not.

There is one record per step and no record for setup, so the **first** record also carries
what creating the game drew and did. Dropping those draws would leave the order in which the
region modifiers and `start_day` are drawn unbound, and that order moves the whole stream.

Results are recorded as integers so that comparison stays exact equality on integers,
strings and booleans, with no tolerance policy anywhere:

| function  | result                                                          |
| --------- | --------------------------------------------------------------- |
| `random`  | the exact numerator over 2^53 — CPython's `random()` is `k/2^53` |
| `randint` | the drawn integer                                                |
| `choice`  | the index drawn, not the element                                 |
| `shuffle` | the permutation, as the original index of each element after it  |

Three departures from letting the reference run untouched, all recorded rather than hidden:

- `auto_save` is intercepted. Upstream writes a save file mid-tick (`player.py:576`); here
  it becomes an effect at the position where upstream calls it, which is what the autosave
  Deviation's Normalisation later moves. Writing the file would also mean writing inside
  the read-only vendored reference.
- Whatever the reference prints is swallowed. It is not part of the Trace, and letting it
  reach stdout would corrupt a trace written there.
- Asked a resource-flow question, the recorder undoes what asking it moved. Standing in for
  upstream's build dialog means building its fake bases, and building one reaches
  `g.pl.recalc_cpu` — which throws CPU allocations away. The build dialog's write is not a
  Deviation either. Only a run that is asked departs at all, and the undo is
  measured: `records(considered=...)` opens the dialog before every step and the Trace has to
  come out unchanged. Standing in for the **item** dialogs costs nothing of the kind: what
  they write is a plain `Buyable`, with no `Item.finish` and no base to check the power of,
  so there is nothing to put back.

## Where the effect list stops

The recorder drives the model, so the effect list holds the calls the **Simulation** makes
into Presentation — not the ones Presentation makes to itself. Upstream does not respect
that boundary, so the two lists differ, and the shorter one is what the port is written
against. `EFFECT_SURFACE` below is the register: every place the reference reaches
`g.map_screen`, and for each one the recorder cannot be driven to, why.
`python -m tools.trace.reference`
prints the register beside a fresh scan of the reference, which is what keeps the two from
drifting apart at a bump.

`g.map_screen` is the whole of that surface. The only other reach-out from outside
`screens/` and `graphics/` is `mixer.play_music` (`player.py:155`, `effect.py:63`), which
the pygame stub satisfies: audio is out of scope for the port, so it never becomes an
Effect.

## What the recorder drops

The register carries a second flag, and it fails in the other direction. `reached` says the
recorder cannot be driven somewhere; `compared` says the port has no counterpart for what it
finds when it can. `needs_rebuild` is the whole of the second list: upstream sets it to say
the displayed state moved, and a reactive Presentation has no such concept, so the port
deliberately produces nothing there: render invalidation is not an Effect. The
recorder therefore drops it before it reaches a Trace — it is not a Deviation and gets no
Normalisation, because nothing a player can observe differs.

Dropping is where this mechanism could go wrong, so it is narrow and it is checked: `FILTERED`
is derived from the register rather than written beside it, and the trace-seam suite asserts
that no Effect the port can produce maps onto anything in it.

## What the register is checked against

The register is a claim about the reference in two directions, and both are checked. Outwards:
nothing appears in a Trace that the register does not carry, and the scan of the vendored
syntax tree carries nothing the register does not declare. Inwards: an entry declared `reached`
and `compared` has to *be* reached, or the claim is a guess that happens to read well.

So the recorder writes down where each effect it records came from — the enclosing function of
the frame that made the call or the set, in the same `module.Class.function` form the scan
produces — and `tools.trace.record` reports the set of them on stderr beside the seed, as
`reached-site <where> <attribute> <kind>`. It goes on stderr because stdout is the trace and
the trace is what the digest manifest is measured on. The trace-seam suite takes the union over
every committed Scenario and requires every reached-and-compared entry to be in it; one that is
not is either mis-declared or missing the Scenario that would drive it.
"""

from __future__ import annotations

import ast
import contextlib
import copy
import io
import json
import os
import random
import sys
from dataclasses import dataclass
from typing import Any, Iterable, Iterator, Mapping

from . import scenario as scenario_mod
from .scenario import Scenario

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REFERENCE_ROOT = os.path.join(REPO_ROOT, "singularity")
REFERENCE_CODE_ROOT = os.path.join(REFERENCE_ROOT, "singularity", "code")
ORACLE_ROOT = os.path.join(REPO_ROOT, "tools", "oracle")

SCREEN_ATTRIBUTE = "map_screen"

DERIVED_FIELDS = (
    "cpu_pool",
    "available_cpus",
    "sleeping_cpus",
    "interest_rate",
    "income",
    "labor_bonus",
    "job_bonus",
    "apotheosis",
    "display_discover",
)

#: The two halves of what `Player.compute_future_resource_flow` returns (`player.py:770`).
#: `DryRunInfo` is an empty class the routine hangs attributes on, so there is no declaration
#: to read them off: they are named here, in the order the routine sets them.
CASH_FLOW_FIELDS = (
    "interest",
    "income",
    "jobs",
    "tech",
    "maintenance_needed",
    "construction_needed",
    "difference",
)

CPU_FLOW_FIELDS = (
    "sleeping",
    "total",
    "explicit_jobs",
    "tech",
    "effective_pool",
    "construction_needed",
    "maintenance_needed",
    "difference",
)

#: What `Player.recalc_cpu` writes (`player.py:482`). Named so that a caller which has to
#: undo an incidental call to it puts back exactly what that call could have moved.
RECALCULATED_FIELDS = ("available_cpus", "sleeping_cpus", "cpu_usage")

DRAW_FUNCTIONS = ("random", "randint", "choice", "shuffle")

#: What the shuffle probe seeds the generator with. Any seed whose permutation moves the two
#: repeated positions past each other will do; the trace-seam suite fails if this one stops
#: doing that, rather than passing on a case that cannot tell the two recoveries apart.
SHUFFLE_PROBE_SEED = 0

ITEM_SLOT_CPU = "cpu"


@dataclass(frozen=True)
class ConsideredBases:
    """An order the player is looking at but has not placed: *n* bases of one type, here.

    Upstream's build dialog writes the equivalent onto `Player.considered_buyables` while it
    is open and clears it when it closes (`screens/location.py:411,447`). The port turns
    that write into an argument, so this is what the argument carries.
    """

    location: str
    base_type: str
    count: int

    #: How one is written on a command line: `LOCATION/BASE TYPE/COUNT`. A slash rather than
    #: a colon, because a location id has no slash in it and upstream's names are free text.
    SEPARATOR = "/"

    @classmethod
    def parse(cls, text: str) -> ConsideredBases:
        parts = text.split(cls.SEPARATOR)
        if len(parts) != 3:
            raise ValueError(f"expected LOCATION{cls.SEPARATOR}TYPE{cls.SEPARATOR}COUNT: {text!r}")
        location, base_type, count = parts
        return cls(location=location, base_type=base_type, count=int(count))


@dataclass(frozen=True)
class ConsideredItems:
    """An order the player is looking at inside a base: *n* of one item, here.

    Upstream's item dialogs write the equivalent onto `Player.considered_buyables` while they
    are open and clear it when they close (`screens/base.py:103,182,446`): a plain
    `buyable.Buyable(item_spec, count=n)`, not the `Item` a base would hold. The port turns
    that write into an argument, so this is what the argument carries.

    **One `Buyable` carrying the count, where a base order is one per base.** Upstream writes
    exactly one, and its constructor divides the labor multiplication back out
    (`buyable.py:117`), so *n* of one item bought into one slot install as fast as one.
    """

    item: str
    count: int

    #: How one is written on a command line: `ITEM/COUNT`. The same separator the base order
    #: uses, and the field count is what tells the two apart.
    SEPARATOR = "/"

    @classmethod
    def parse(cls, text: str) -> ConsideredItems:
        parts = text.split(cls.SEPARATOR)
        if len(parts) != 2:
            raise ValueError(f"expected ITEM{cls.SEPARATOR}COUNT: {text!r}")
        item, count = parts
        return cls(item=item, count=int(count))


#: Either kind of hypothetical, as the recorder's one `considered` argument carries them.
ConsideredOrder = ConsideredBases | ConsideredItems


@dataclass(frozen=True)
class EffectSite:
    """One place the reference reaches into Presentation through `g.map_screen`, whether a
    Scenario can drive the recorder to it, and whether what it says is part of the compared
    surface at all.

    The two flags are independent and they fail in opposite directions. `reached` is about
    the *recorder*: a site only Presentation reaches never appears in a Trace, however
    faithful the port is. `compared` is about the *port*: a site the Simulation does reach
    and the recorder does capture, but which the port deliberately does not produce."""

    where: str
    """The enclosing function, as `module.Class.function`. Not a line number: a bump moves
    lines without moving anything the port cares about."""
    attribute: str
    kind: str
    reached: bool
    reason: str = ""
    compared: bool = True
    why_not_compared: str = ""

    def as_json(self) -> dict[str, Any]:
        described = {"where": self.where, "attribute": self.attribute, "kind": self.kind}
        described["reached"] = self.reached
        if self.reason:
            described["reason"] = self.reason
        described["compared"] = self.compared
        if self.why_not_compared:
            described["whyNotCompared"] = self.why_not_compared
        return described


SCREEN_FLOW_REASON = (
    "Only Presentation assigns `considered_buyables` — the build dialog in "
    "screens/location.py, the item dialogs in screens/base.py — so this set fires from a "
    "screen flow, never from a Command. A Scenario carries Commands, not dialog "
    "interactions, and the flow's own base-name draws depend on how the player scrolled. "
    "The port never performs the mutation either (Presentation must not mutate "
    "Simulation state), so there is no difference for a Normalisation to cancel."
)

RENDER_INVALIDATION_REASON = (
    "Render invalidation. `needs_rebuild = True` says the displayed state moved; a reactive "
    "Presentation has no such concept, so the port neither has nor can have a counterpart. "
    "The Simulation does make this one and the recorder does capture "
    "it, so it is dropped here — before it reaches a Trace — rather than by a Normalisation: "
    "there is no player-observable difference for the Deviation register to hold."
)

EFFECT_SURFACE = (
    EffectSite("effect.Effect._apply_effect", "show_story_section", "call", True),
    EffectSite(
        "player.Player.considered_buyables",
        "needs_rebuild",
        "set",
        False,
        SCREEN_FLOW_REASON,
        compared=False,
        why_not_compared=RENDER_INVALIDATION_REASON,
    ),
    EffectSite("player.Player.give_time", "show_story_section", "call", True),
    EffectSite("player.Player.pause_game", "find_speed_button", "call", True),
    EffectSite(
        "player.Player.pause_game",
        "needs_rebuild",
        "set",
        True,
        compared=False,
        why_not_compared=RENDER_INVALIDATION_REASON,
    ),
    EffectSite(
        "player.Player.recalc_cpu",
        "needs_rebuild",
        "set",
        True,
        compared=False,
        why_not_compared=RENDER_INVALIDATION_REASON,
    ),
    EffectSite(
        "player.Player.remove_bases",
        "needs_rebuild",
        "set",
        True,
        compared=False,
        why_not_compared=RENDER_INVALIDATION_REASON,
    ),
    EffectSite("player.Player.remove_bases", "show_message", "call", True),
    EffectSite("player.Player.trigger_event", "show_message", "call", True),
)

FILTERED = tuple(
    sorted({(site.attribute, site.kind) for site in EFFECT_SURFACE if not site.compared})
)
"""What the recorder drops instead of recording, derived from the register above rather than
written twice. Every entry is a place the port could not produce a counterpart for; an entry
it *could* would be a false drop, and the trace-seam suite checks the port's own mapping
against this list in exactly that direction."""


class CommandError(RuntimeError):
    """A Command that the reference cannot carry out as written."""


@contextlib.contextmanager
def _quiet():
    """Swallow whatever the reference prints. It is not part of the Trace, and letting it
    reach stdout would corrupt a trace written there."""
    with contextlib.redirect_stdout(io.StringIO()):
        yield


def _import_reference():
    for path in (ORACLE_ROOT, REFERENCE_ROOT):
        if path not in sys.path:
            sys.path.insert(0, path)
    import pygame_stub

    pygame_stub.install()

    from singularity.code import base, buyable, data, dirs, g, item, player, savegame
    from singularity.code import stats as stats_mod

    return {
        "base": base,
        "buyable": buyable,
        "data": data,
        "dirs": dirs,
        "g": g,
        "item": item,
        "player": player,
        "savegame": savegame,
        "stats": stats_mod,
    }


REFERENCE_MODULE_PREFIX = "singularity.code."


def _calling_site(depth: int) -> str:
    """The function `depth` frames above this one's caller, as `module.Class.function`.

    That is the form `scan_effect_surface` reads out of the syntax tree, so a site observed
    at run time and a site declared in the register are the same string. `.<locals>.` comes
    out of the qualified name because the scan's own stack does not have it.

    Empty for a frame outside the vendored reference: the recorder's probes call in from
    `tools/`, and a probe is not a place the reference reaches Presentation from."""
    frame = sys._getframe(depth + 1)
    module = frame.f_globals.get("__name__", "")
    if not module.startswith(REFERENCE_MODULE_PREFIX):
        return ""
    qualified = frame.f_code.co_qualname.replace(".<locals>", "")
    return f"{module[len(REFERENCE_MODULE_PREFIX) :]}.{qualified}"


class EffectRecorder:
    """Stands in for `g.map_screen`, so the calls the Simulation makes into the GUI become
    records. Attribute *sets* count too — `needs_rebuild = True` is how upstream says the
    displayed state moved.

    A set is **performed** whether or not it is recorded, so a read observes what was written
    rather than the default underneath it. Nothing in the vendored reference reads one back
    today; performing only what is recorded would make the day one does a silent wrong answer
    instead of a divergence.

    Recording is the part `FILTERED` narrows: a site the port cannot have a counterpart for
    is dropped here, so the compared surface is the one the port is written against.

    Beside the effects themselves it keeps `reached_sites`: the `EFFECT_SURFACE` entry each
    recorded effect came from, read off the calling frame. That set is what checks the
    register in the inward direction — an entry declared reached that no run ever reaches is
    a guess, not a fact. It holds only sites whose effect survived the filter, so it says
    exactly what a Trace shows."""

    # The value before anything sets it. `__setattr__` shadows this per instance, and a read
    # therefore never looks like a call: `__getattr__` only runs when the lookup fails.
    needs_rebuild = False

    def __init__(self) -> None:
        object.__setattr__(self, "effects", [])
        object.__setattr__(self, "reached_sites", set())

    def __getattr__(self, name: str):
        if name.startswith("_"):
            raise AttributeError(name)

        def record(*args: Any, **kwargs: Any) -> None:
            if (name, "call") in FILTERED:
                return
            self._reached(name, "call")
            self.effects.append(
                {
                    "kind": "call",
                    "name": name,
                    "args": [_jsonable(a) for a in args],
                    "kwargs": {k: _jsonable(v) for k, v in sorted(kwargs.items())},
                }
            )

        return record

    def __setattr__(self, name: str, value: Any) -> None:
        if (name, "set") not in FILTERED:
            self._reached(name, "set")
            self.effects.append(
                {"kind": "set", "name": name, "args": [_jsonable(value)], "kwargs": {}}
            )
        object.__setattr__(self, name, value)

    def _reached(self, name: str, kind: str) -> None:
        """Note which register entry this effect came from. The frame two up is the reference
        function that reached in: one for this helper, one for `record`/`__setattr__`."""
        where = _calling_site(2)
        if where:
            self.reached_sites.add((where, name, kind))

    def drain(self) -> list[dict[str, Any]]:
        drained = list(self.effects)
        self.effects.clear()
        return drained


@dataclass(frozen=True)
class _Marker:
    """One position in a list being shuffled, so the permutation is read rather than guessed."""

    index: int


class DrawRecorder:
    """Wraps the generator functions the Simulation calls, recording `(function, result)`
    and nothing else. The wrappers delegate, so the stream itself is untouched."""

    def __init__(self) -> None:
        self.draws: list[list[Any]] = []
        self._originals: dict[str, Any] = {}

    def install(self) -> None:
        self._originals = {name: getattr(random, name) for name in DRAW_FUNCTIONS}
        random.random = self._random
        random.randint = self._randint
        random.choice = self._choice
        random.shuffle = self._shuffle

    def uninstall(self) -> None:
        for name, original in self._originals.items():
            setattr(random, name, original)
        self._originals = {}

    def drain(self) -> list[list[Any]]:
        drained = list(self.draws)
        self.draws.clear()
        return drained

    def _random(self) -> float:
        value = self._originals["random"]()
        # CPython's random() is k / 2**53 for an integer k, so the numerator is exact.
        self.draws.append(["random", int(value * (1 << 53))])
        return value

    def _randint(self, a: int, b: int) -> int:
        value = self._originals["randint"](a, b)
        self.draws.append(["randint", int(value)])
        return value

    def _choice(self, seq):
        value = self._originals["choice"](seq)
        self.draws.append(["choice", _index_of(seq, value)])
        return value

    def _shuffle(self, x) -> None:
        """The permutation, read off markers rather than off the elements themselves.

        Recovering it from the elements after the fact cannot see a swap of two that are the
        *same object* — `Player.remove_bases` shuffles a list of locations, and two bases lost
        in one tick at one location put the same `Location` in it twice (`player.py:611`). The
        recorded permutation would then be the identity whatever the generator drew, and a real
        divergence in the draw would go unreported.

        `random.shuffle` only reads and writes elements by index, so shuffling markers in the
        caller's own list and putting the elements back in the order the markers landed records
        exactly what the generator did, whatever the list holds."""
        before = list(x)
        x[:] = [_Marker(index) for index in range(len(before))]
        self._originals["shuffle"](x)
        permutation = [marker.index for marker in x]
        x[:] = [before[index] for index in permutation]
        self.draws.append(["shuffle", permutation])


def _index_of(seq, value) -> int:
    for index, element in enumerate(seq):
        if element is value:
            return index
    return list(seq).index(value)


def _jsonable(value: Any) -> Any:
    if isinstance(value, (str, bool, int)) or value is None:
        return value
    if isinstance(value, float):
        return value
    if isinstance(value, Mapping):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if hasattr(value, "tolist"):
        return _jsonable(value.tolist())
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_jsonable(v) for v in value]
    if hasattr(value, "__iter__"):
        return [_jsonable(v) for v in value]
    return str(value)


class ReferenceRun:
    """One scenario run against the reference. Not reusable: the reference keeps its state
    in module globals, so a second run means a second process or a second `new_game`."""

    def __init__(self, scenario: Scenario) -> None:
        self.scenario = scenario
        #: What the run seeded the reference's generator with, once it has. `None` until
        #: then, so a caller reports provenance it observed rather than provenance it
        #: assumed (deviation 2).
        self.seeded_from: int | None = None
        #: How many fake bases this run built for the build dialog's question, over the whole
        #: run. Provenance of the same kind as `seeded_from`: a Trace recorded with the dialog
        #: open has to be identical to one recorded without it, and a check of that is worth
        #: nothing unless the run says how many times it opened the dialog.
        self.considered_bases_built = 0
        #: How many plain buyables this run built for the item dialogs' question, over the
        #: whole run. Provenance of the same kind, and reported for the same reason: a
        #: comparison of two answers is worth nothing unless the run says it was asked.
        self.considered_items_built = 0
        self._mods = _import_reference()
        self._effects = EffectRecorder()
        self._draws = DrawRecorder()

    @property
    def reached_sites(self) -> list[tuple[str, str, str]]:
        """Which `EFFECT_SURFACE` entries this run's Trace actually shows, sorted. Observed
        by the recorder rather than declared, which is what lets it check the register in the
        direction the register cannot check itself."""
        return sorted(self._effects.reached_sites)

    def begin(self) -> None:
        """Seed the generator and create the game, which is everything a step is applied on
        top of. `records()` calls it; so does the offline scenario generator, which decides
        its next Command from the state this leaves behind (`tools/oracle/`)."""
        g = self._mods["g"]
        with _quiet():
            self._mods["dirs"].create_directories(True)
            self._mods["data"].reload_all()
            self._install_autosave_effect()
            self._draws.install()
            random.seed(self.scenario.seed)
            self.seeded_from = self.scenario.seed
            g.map_screen = self._effects
            g.new_game(self.scenario.difficulty, 1)
            # Nothing is drained here: creating the game draws (`start_day`, the region
            # modifier shuffles) and those draws are part of the stream the port has to
            # reproduce. They ride on the first record, which is the first place they can
            # go without inventing a step that the Scenario does not have.

    def apply(self, step: Mapping[str, Any]) -> None:
        """Apply one step and record nothing.

        For a caller that is writing a script rather than reading a Trace: the reference
        moves exactly as it does inside `records()`, so a script built this way replays
        step for step. What it produced on the way is dropped, so a run of thousands of
        steps does not accumulate effects and draws nobody reads."""
        with _quiet():
            self._apply(step)
        self._effects.drain()
        self._draws.drain()

    def records(self, considered: Iterable[ConsideredOrder] = ()) -> Iterator[dict[str, Any]]:
        """One record per Scenario step, with one of upstream's dialogs optionally open.

        `considered` is the order the player is looking at. Given one, the run asks the
        dialog's question — `compute_future_resource_flow` over the hypothetical — before
        every step and throws the answer away, because what is under test is not the answer
        but whether asking moved anything. The build dialog does move something (`recalc_cpu`
        via `Item.finish`), and `_considered_buyables` undoes it; a Trace recorded this way is
        therefore expected to be identical, line for line, to one recorded without it. The
        question goes *before* the step so that whatever it left behind lands in a record.
        """
        self.begin()
        orders = list(considered)

        try:
            for index, step in enumerate(self.scenario.script):
                with _quiet():
                    if orders:
                        self.resource_flow(orders)
                    self._apply(step)
                    record = {
                        "step": index,
                        "kind": scenario_mod.step_kind(step),
                        "persistent": self._persistent(),
                        "derived": self._derived(),
                        "effects": self._effects.drain(),
                        "draws": self._draws.drain(),
                    }
                yield record
        finally:
            self._draws.uninstall()

    def _install_autosave_effect(self) -> None:
        player = self._mods["player"]
        effects = self._effects

        def auto_save() -> None:
            effects.effects.append({"kind": "call", "name": "auto_save", "args": [], "kwargs": {}})

        player.auto_save = auto_save

    def _apply(self, step: Mapping[str, Any]) -> None:
        if scenario_mod.is_advance(step):
            self._mods["g"].pl.give_time(step[scenario_mod.ADVANCE_FIELD])
            return
        getattr(self, "_cmd_" + step["command"])(step)

    # -- the six commands -------------------------------------------------------------

    def _cmd_buildBase(self, step: Mapping[str, Any]) -> None:
        location = self._location(step["location"])
        spec = self._base_type(step["baseType"])
        name = step.get("name")
        if name is None:
            name = self._generate_base_name(location, spec)
        location.add_base(self._mods["base"].Base(name, spec))

    def _cmd_destroyBase(self, step: Mapping[str, Any]) -> None:
        self._base_at(step).destroy()

    def _cmd_buyItem(self, step: Mapping[str, Any]) -> None:
        target = self._base_at(step)
        spec = self._item_type(step["itemType"])
        count = step.get("count", 1)
        item = self._mods["item"]
        slot = spec.item_type.id

        if slot == ITEM_SLOT_CPU:
            # `space_left_for` already deducts the CPUs of this spec the base holds, and
            # upstream's own caller (screens/base.py set_current) validates against the
            # return value unmodified. Deducting them again here would be a rule the
            # reference does not have, in the specification the port is written against.
            space_left = target.space_left_for(spec)
            cpu_added = target.cpus is not None and target.cpus.spec == spec
            if count <= 0 or count > space_left:
                raise CommandError(
                    f"buyItem: {count} {spec.id} does not fit; {space_left} slot(s) left"
                )
            bought = item.Item(spec, base=target, count=count)
            if cpu_added:
                target.cpus += bought
            else:
                target.cpus = bought
            target.check_power()
        else:
            # Upstream's own caller passes one for every slot but the CPU's
            # (`screens/base.py:583`), so an extra is built exactly once whatever a dialog
            # asked. A Scenario carrying a count for one is therefore saying something the
            # reference cannot do, and reading it as one would record a trace that agrees
            # with a Scenario nobody wrote. The port refuses it in the same place
            # (`sim/src/command.ts`); neither parser can, because the slot comes out of
            # Content and `scenario.py` knows none.
            if "count" in step:
                raise CommandError(
                    f"buyItem: count is only for the cpu slot; {spec.id} fills the {slot} slot"
                )
            existing = target.items[slot]
            if existing is None or existing.spec != spec:
                target.items[slot] = item.Item(spec, base=target)
                target.check_power()
        target.recalc_cpu()

    def _cmd_allocateCpu(self, step: Mapping[str, Any]) -> None:
        self._mods["g"].pl.set_allocated_cpu_for(step["task"], step["cpu"])

    def _cmd_switchPower(self, step: Mapping[str, Any]) -> None:
        self._base_at(step).switch_power()

    def _cmd_renameBase(self, step: Mapping[str, Any]) -> None:
        self._base_at(step).name = step["name"]

    # -- resolution -------------------------------------------------------------------

    def _location(self, location_id: str):
        try:
            return self._mods["g"].pl.locations[location_id]
        except KeyError:
            raise CommandError(f"no such location: {location_id!r}") from None

    def _base_type(self, base_type_id: str):
        try:
            return self._mods["g"].base_type[base_type_id]
        except KeyError:
            raise CommandError(f"no such base type: {base_type_id!r}") from None

    def _item_type(self, item_id: str):
        try:
            return self._mods["g"].items[item_id]
        except KeyError:
            raise CommandError(f"no such item: {item_id!r}") from None

    def _base_at(self, step: Mapping[str, Any]):
        location = self._location(step["location"])
        index = step["base"]
        if not 0 <= index < len(location.bases):
            raise CommandError(
                f"{step['location']} has {len(location.bases)} base(s); asked for index {index}"
            )
        return location.bases[index]

    def _generate_base_name(self, location, spec) -> str:
        from singularity.code.screens.location import generate_base_name

        return generate_base_name(location, spec)

    # -- projections ------------------------------------------------------------------

    def _persistent(self) -> dict[str, Any]:
        g = self._mods["g"]
        return {
            "version": self._mods["savegame"].current_save_version,
            "difficulty": g.pl.difficulty.id,
            "game_time": g.pl.raw_sec,
            "player": _jsonable(g.pl.serialize_obj()),
            "stats": _jsonable(self._mods["stats"].itself.serialize_obj()),
        }

    def _derived(self) -> dict[str, Any]:
        pl = self._mods["g"].pl
        return {field: _jsonable(getattr(pl, field)) for field in DERIVED_FIELDS}

    def resource_flow(self, considered: Iterable[ConsideredOrder] = ()) -> dict[str, Any]:
        """`Player.compute_future_resource_flow` over a day, as two flat objects.

        A Projection rather than state: it reads the player and writes nothing, which is
        why it is asked for beside a Trace record instead of inside one. `DryRunInfo` carries
        whatever the routine set on it, so the fields are named here — a reference bump that
        renames one then fails the comparison instead of quietly dropping it out of the record.

        `considered` is the hypothetical one of upstream's dialogs would be showing — bases
        from the build dialog, an item from the item dialogs. Upstream leaves it on the
        player and the routine reads the field back out; the port takes it as an argument,
        so the recorder writes the field, asks, and clears it again — which is
        the only way the two can be asked the same question.
        """
        pl = self._mods["g"].pl
        pl.considered_buyables = self._considered_buyables(considered)
        try:
            cash_info, cpu_info = pl.compute_future_resource_flow()
        finally:
            pl.considered_buyables = []
        return {
            "cash": {field: _jsonable(getattr(cash_info, field)) for field in CASH_FLOW_FIELDS},
            "cpu": {field: _jsonable(getattr(cpu_info, field)) for field in CPU_FLOW_FIELDS},
        }

    def _considered_buyables(self, considered: Iterable[ConsideredOrder]) -> list[Any]:
        """What upstream's dialogs would have left on `Player.considered_buyables`.

        Two kinds, from two places, and only one of them costs anything to stand in for.
        """
        buyables: list[Any] = []
        for order in considered:
            if isinstance(order, ConsideredBases):
                buyables.extend(self._considered_bases(order))
            else:
                buyables.append(self._considered_item(order))
        return buyables

    def _considered_bases(self, order: ConsideredBases) -> list[Any]:
        """The fake bases `NewBaseDialog._update_desc_pane` builds (`screens/location.py:411`).

        One `Base` per unit ordered rather than one carrying a count: the routine walks the
        list and takes CPU out of the same pool for each entry in turn, so *n* of them is
        not one of them scaled by *n*.

        **Building one perturbs the player, and that perturbation is undone here.** A base
        type with a forced CPU builds its item and finishes it, `Item.finish` calls
        `Base.check_power`, and that calls `g.pl.recalc_cpu` (`item.py:242`,
        `base.py:286`) — which throws allocations away whenever a danger level is
        oversubscribed at that moment. So merely *looking* at a base type in upstream's
        dialog can move the CPU allocations, which is a defect of the write the port
        removed rather than a rule of the game.

        The port's Projection has no such effect and takes the hypothetical as an argument,
        so asking the two the same question means asking the reference about the state it
        was in before the dialog touched it. The three fields `recalc_cpu` writes are
        therefore taken before and put back after.

        That undo is a recorder-side repair and **not** a Normalisation: it cancels nothing
        between two Traces, because neither simulation makes the write while a Scenario runs.
        What keeps it
        honest is that it is measured — `records(considered=...)` asks the question before
        every step and the Trace has to come out unchanged.

        The undo is scoped to one base order rather than wrapped around every kind of
        hypothetical, so the same check over an item order measures the item dialogs' write
        instead of measuring this repair a second time.
        """
        pl = self._mods["g"].pl
        untouched = {field: copy.deepcopy(getattr(pl, field)) for field in RECALCULATED_FIELDS}
        base_mod = self._mods["base"]
        fakes = []
        try:
            location = self._location(order.location)
            spec = self._base_type(order.base_type)
            for _ in range(order.count):
                fake = base_mod.Base("<Undecided>", spec)
                location.modify_base(fake)
                fakes.append(fake)
                self.considered_bases_built += 1
        finally:
            for field, value in untouched.items():
                setattr(pl, field, value)
            # `recalc_cpu` asks the map screen to redraw when it scales an allocation down.
            # Nothing here reads a Trace, and that effect belongs to no step, so it goes.
            self._effects.drain()
        return fakes

    def _considered_item(self, order: ConsideredItems) -> Any:
        """The plain buyable the item dialogs build (`screens/base.py:103,182,446`).

        `buyable.Buyable(item_spec, count=n)`, not the `Item` a base would hold, and that
        distinction is the whole reason this half needs no undo: a plain `Buyable` has
        neither `Item.finish` nor a base to call `Base.check_power` on, so nothing here
        reaches `g.pl.recalc_cpu` the way the fake bases above do. It costs the
        player's `labor_bonus` into the spec's cost and stops there.

        One buyable carrying the count, again upstream's own shape: the dialogs write exactly
        one, and `Buyable.__init__` divides the labor multiplication back out.
        """
        considered = self._mods["buyable"].Buyable(self._item_type(order.item), count=order.count)
        self.considered_items_built += 1
        return considered


def record_trace(scenario: Scenario) -> Iterator[dict[str, Any]]:
    """Yield one trace record per Scenario step.

    The build dialog stays shut here. A run that opens it goes through `ReferenceRun.records`
    directly, because what it produces is a second Trace to hold this one against rather than
    a Trace anything else reads."""
    return ReferenceRun(scenario).records()


def resource_flow(
    scenario: Scenario, considered: Iterable[ConsideredOrder] = ()
) -> Iterator[dict[str, Any]]:
    """Yield the reference's resource flow after each Scenario step.

    The run applies the steps without recording, because nothing here reads a Trace: what
    is compared is the Projection the port computes from the same state.
    """
    run = ReferenceRun(scenario)
    run.begin()
    orders = list(considered)
    for step in scenario.script:
        run.apply(step)
        yield run.resource_flow(orders)


# -- the effect list's edge ------------------------------------------------------------


def scan_effect_surface() -> list[dict[str, str]]:
    """Every `g.map_screen.<name>` in the vendored reference, read out of its syntax tree
    rather than declared. A bump that adds a call into Presentation then fails the register
    instead of lengthening the effect list unnoticed."""
    found: set[tuple[str, str, str]] = set()
    for directory, _, names in os.walk(REFERENCE_CODE_ROOT):
        for name in sorted(names):
            if not name.endswith(".py"):
                continue
            path = os.path.join(directory, name)
            module = os.path.relpath(path, REFERENCE_CODE_ROOT)[: -len(".py")]
            with open(path, encoding="utf-8") as handle:
                tree = ast.parse(handle.read(), filename=path)
            _collect_sites(tree, [module.replace(os.sep, ".")], found)
    return [
        {"where": where, "attribute": attribute, "kind": kind}
        for where, attribute, kind in sorted(found)
    ]


def _collect_sites(node: ast.AST, stack: list[str], found: set[tuple[str, str, str]]) -> None:
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            _collect_sites(child, [*stack, child.name], found)
            continue
        if _is_screen_attribute(child):
            assert isinstance(child, ast.Attribute)
            kind = "set" if isinstance(child.ctx, ast.Store) else "call"
            found.add((".".join(stack), child.attr, kind))
        _collect_sites(child, stack, found)


def _is_screen_attribute(node: ast.AST) -> bool:
    """`g.map_screen.<name>`, and nothing that merely mentions one of those names."""
    if not isinstance(node, ast.Attribute):
        return False
    owner = node.value
    return (
        isinstance(owner, ast.Attribute)
        and owner.attr == SCREEN_ATTRIBUTE
        and isinstance(owner.value, ast.Name)
        and owner.value.id == "g"
    )


def _probe_attribute_write() -> dict[str, Any]:
    """What a set on the recorder does, observed rather than claimed: the value before, what
    it recorded, and the value a read gets back afterwards."""
    probe = EffectRecorder()
    before = probe.needs_rebuild
    probe.needs_rebuild = True
    return {"before": before, "recorded": probe.drain(), "after": probe.needs_rebuild}


def _probe_call() -> dict[str, Any]:
    """The same probe for a call that is *not* filtered, so "the recorder records nothing"
    can never be mistaken for "the filter is working"."""
    probe = EffectRecorder()
    probe.find_speed_button()
    return {"recorded": probe.drain()}


@dataclass(frozen=True)
class _ProbeElement:
    """One element of the shuffle probe's list, carrying a label so the run can be read."""

    label: str


def _probe_shuffle() -> dict[str, Any]:
    """The permutation the draw recorder records for a list that holds one object twice,
    beside the permutation the bare generator produces from the same seed.

    `Player.remove_bases` shuffles a list of Locations and puts the same Location in it twice
    when two bases at one location are lost in one tick (`player.py:611`). Only two committed
    Scenarios reach that case, so a Trace comparison alone leaves this rule resting on those
    two continuing to reach it. `byIdentity` is what a recovery from the elements after the
    fact would produce, which is what makes the case able to tell the two apart at all."""
    repeated = _ProbeElement("repeated")
    before = [repeated, repeated, _ProbeElement("a"), _ProbeElement("b"), _ProbeElement("c")]
    subject = list(before)

    recorder = DrawRecorder()
    recorder.install()
    try:
        random.seed(SHUFFLE_PROBE_SEED)
        random.shuffle(subject)
    finally:
        recorder.uninstall()

    random.seed(SHUFFLE_PROBE_SEED)
    generator = list(range(len(before)))
    random.shuffle(generator)

    return {
        "seed": SHUFFLE_PROBE_SEED,
        "before": [element.label for element in before],
        "after": [element.label for element in subject],
        "repeated": [index for index, element in enumerate(before) if element is repeated],
        "recorded": recorder.drain(),
        "generator": generator,
        "byIdentity": _by_identity(before, subject),
    }


def _by_identity(before: list[Any], after: list[Any]) -> list[int]:
    """The permutation an after-the-fact recovery from the elements produces: each element's
    original index, matched by identity. Two entries that are the same object are one thing
    to it, so it hands back their original indices in ascending order whatever the generator
    drew."""
    positions: dict[int, list[int]] = {}
    for index, element in enumerate(before):
        positions.setdefault(id(element), []).append(index)
    return [positions[id(element)].pop(0) for element in after]


def describe_effect_surface() -> dict[str, Any]:
    """The register beside a fresh scan of the reference, so the port can be checked against
    what the recorder reaches instead of assuming it reaches everything, and beside live
    probes of the two recorders. Printed by `python -m tools.trace.reference`."""
    return {
        "recorder": {
            "attributeWrite": _probe_attribute_write(),
            "call": _probe_call(),
            "filtered": [list(entry) for entry in FILTERED],
            "shuffle": _probe_shuffle(),
        },
        "declared": [
            site.as_json()
            for site in sorted(
                EFFECT_SURFACE, key=lambda site: (site.where, site.attribute, site.kind)
            )
        ],
        "found": scan_effect_surface(),
    }


if __name__ == "__main__":
    print(json.dumps(describe_effect_surface(), indent=2, sort_keys=True))


__all__ = [
    "DERIVED_FIELDS",
    "DRAW_FUNCTIONS",
    "EFFECT_SURFACE",
    "FILTERED",
    "CommandError",
    "DrawRecorder",
    "EffectRecorder",
    "EffectSite",
    "ReferenceRun",
    "describe_effect_surface",
    "record_trace",
    "scan_effect_surface",
]
