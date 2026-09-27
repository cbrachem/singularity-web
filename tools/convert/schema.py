"""What each record may contain, and the invariants upstream's loaders assert.

The tables here are hand-written, for the same reason as the port's Content
types: upstream declares `spec_data_fields` for eight of the object types and hand-rolls a
loader for the rest, so a table generated for half and written for half would leave nobody
able to say which half is safe to edit.

The converter transcribes — it does not convert `"6/5"` to a number or `"1"` to an integer,
because that arithmetic belongs in the port's loader where a Trace can reach it. What is
checked here is only shape: that a field upstream will call `int()` on is an integer, that
a cost has three elements, that a position is two or three. A bad conversion fails at
conversion time rather than as two numbers that differ with nothing to blame.
"""

TEXT = "text"  # a plain string
INT = "int"  # a string upstream parses with int()
STRINGS = "strings"  # a string, or a list of strings when written with _list
LIST = "list"  # always written with _list
COST = "cost"  # exactly three integers, cash/cpu/labor: see buyable.spec_parse_cost
PAIRS = "pairs"  # name/integer pairs: see item.convert_item_qualities
POSITION = "position"  # see location.position_data_parser
DETECT = "detect"  # "group:integer": see base.parse_detect_chance
MODIFIERS = "modifiers"  # "name:number" or "name:a/b": see g.read_modifiers_dict


class ContentError(RuntimeError):
    """A record does not have the shape the reference's loaders require of it."""


# field name -> (kind, mandatory). Mandatory follows upstream: a field it gives a default
# value to is optional here, and a field whose absence would leave a record without the
# text the port displays is required even where upstream falls back to the id.
TYPES = {
    "bases": {
        "size": (INT, True),
        "force_cpu": (TEXT, False),
        "allowed": (STRINGS, True),
        "detect_chance": (DETECT, True),
        "cost": (COST, True),
        "pre": (STRINGS, False),
        "danger": (INT, False),
        "maint": (COST, True),
        "name": (TEXT, True),
        "description": (TEXT, True),
        "flavor": (STRINGS, True),
    },
    "difficulties": {
        "starting_cash": (INT, True),
        "starting_interest_rate": (INT, True),
        "labor_multiplier": (INT, True),
        "discover_multiplier": (INT, True),
        "suspicion_multiplier": (INT, True),
        "base_grace_multiplier": (INT, True),
        "grace_period_cpu": (INT, True),
        "old_difficulty_value": (INT, True),
        "tech": (STRINGS, False),
        "name": (TEXT, True),
    },
    "events": {
        "type": (TEXT, True),
        "effect": (LIST, True),
        "chance": (INT, True),
        "unique": (INT, False),
        "duration": (INT, False),
        "description": (TEXT, True),
        "log_description": (TEXT, True),
    },
    "groups": {
        "suspicion_decay": (INT, False),
        "name": (TEXT, True),
        "discover_log": (TEXT, True),
        "discover_desc": (TEXT, True),
    },
    "items": {
        "cost": (COST, True),
        "type": (TEXT, True),
        "quality": (PAIRS, True),
        "build": (STRINGS, False),
        "pre": (STRINGS, False),
        "name": (TEXT, True),
        "description": (TEXT, True),
    },
    "itemtypes": {
        "is_extra": (INT, True),
        "text": (TEXT, True),
    },
    "locations": {
        "position": (POSITION, True),
        "region": (STRINGS, False),
        "safety": (INT, False),
        "modifier": (MODIFIERS, False),
        "pre": (STRINGS, False),
        "name": (TEXT, True),
        "hotkey": (TEXT, True),
        "cities": (STRINGS, False),
    },
    "tasks": {
        "type": (TEXT, True),
        "value": (INT, False),
        "pre": (STRINGS, False),
        "name": (TEXT, True),
        "description": (TEXT, True),
    },
    "techs": {
        "cost": (COST, True),
        "pre": (STRINGS, False),
        "effect": (LIST, False),
        "danger": (INT, False),
        "name": (TEXT, True),
        "description": (TEXT, True),
        "result": (TEXT, True),
    },
    "dangers": {
        "research_desc": (TEXT, True),
        "knowledge_desc": (TEXT, True),
    },
    "knowledge": {
        "name": (TEXT, True),
    },
}


def promote(value):
    return value if isinstance(value, list) else [value]


def _fail(kind, object_id, field, detail):
    raise ContentError("%s %s: %s %s" % (kind, object_id, field, detail))


def _check_int(kind, object_id, field, value):
    if not isinstance(value, str):
        _fail(kind, object_id, field, "must be a single value, got %r" % (value,))
    try:
        int(value)
    except ValueError:
        _fail(kind, object_id, field, "is not an integer: %r" % (value,))


def _check_number(text):
    if "/" in text:
        left, right = text.split("/")
        float(left.strip())
        float(right.strip())
    else:
        float(text)


def check_field(kind, object_id, field, value, field_kind):
    if field_kind == TEXT:
        if not isinstance(value, str):
            _fail(kind, object_id, field, "must be a single value, got %r" % (value,))

    elif field_kind == INT:
        _check_int(kind, object_id, field, value)

    elif field_kind == STRINGS:
        for element in promote(value):
            if not isinstance(element, str):
                _fail(kind, object_id, field, "must be strings, got %r" % (value,))

    elif field_kind == LIST:
        if not isinstance(value, list):
            _fail(kind, object_id, field, "must be written with _list")

    elif field_kind == COST:
        elements = promote(value)
        if len(elements) != 3:
            _fail(
                kind,
                object_id,
                field,
                "must have exactly 3 values (cash, cpu, labor), got %d" % len(elements),
            )
        for element in elements:
            _check_int(kind, object_id, field, element)

    elif field_kind == PAIRS:
        elements = promote(value)
        if len(elements) % 2 == 1:
            _fail(kind, object_id, field, "must have pair elements, got %d" % len(elements))
        for element in elements[1::2]:
            _check_int(kind, object_id, field, element)

    elif field_kind == POSITION:
        elements = promote(value)
        if len(elements) == 3:
            if elements[0] != "absolute":
                _fail(
                    kind,
                    object_id,
                    field,
                    'first of three elements must be "absolute", got %r' % elements[0],
                )
            elements = elements[1:]
        elif len(elements) != 2:
            _fail(kind, object_id, field, "must be 2 or 3 elements, got %d" % len(elements))
        for element in elements:
            _check_int(kind, object_id, field, element)

    elif field_kind == DETECT:
        for element in promote(value):
            if element.count(":") != 1:
                _fail(kind, object_id, field, "entry %r is not group:chance" % element)
            _check_int(kind, object_id, field, element.split(":")[1].strip())

    elif field_kind == MODIFIERS:
        for element in promote(value):
            if element.count(":") != 1:
                _fail(kind, object_id, field, "entry %r is not name:value" % element)
            try:
                _check_number(element.split(":")[1].strip())
            except ValueError:
                _fail(kind, object_id, field, "entry %r has no numeric value" % element)

    else:  # pragma: no cover - a kind added to a table but not to this function
        raise ContentError("unknown field kind %r" % field_kind)


def check_record(kind, record):
    """Required fields present, no unknown keys, every value the right shape."""
    fields = TYPES[kind]
    object_id = record["id"]

    for field, (field_kind, mandatory) in fields.items():
        if field in record:
            check_field(kind, object_id, field, record[field], field_kind)
        elif mandatory:
            raise ContentError("%s %s lacks key %s" % (kind, object_id, field))

    for field in record:
        if field != "id" and field not in fields:
            raise ContentError("%s %s has unknown key %s" % (kind, object_id, field))
