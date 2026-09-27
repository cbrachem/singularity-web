"""Readers for the four file formats the reference keeps its Content in.

`read_ini` is `singularity.code.data.generic_load`'s body, kept deliberately close to it:
twenty-one of the twenty-four data files are `RawConfigParser` INI, and the parser carries
behaviour the file format does not (option names lower-cased, section names not; a literal
`%`; `str.strip()` eating U+00A0). Using `RawConfigParser` itself is the point.

The other three files are not INI and get a reader each. Where upstream writes a warning to
stderr and carries on, these raise: the converter runs offline against a pinned reference,
so a malformed line is a fault to stop on rather than to skip past.
"""

from configparser import RawConfigParser


class SourceError(RuntimeError):
    """A source file does not have the shape its reader requires."""


def _is_list_option(option):
    # data.py:107 — the test is off by one, so a field named exactly `x_list` is not a list.
    return len(option) > 6 and option[-5:] == "_list"


def read_ini(path):
    """Read one INI data file into records, in section order.

    The `_list` split is the file format rather than a reading of it, so it is applied
    uniformly here — upstream reaches the same values through per-field allow-lists in
    `load_generic_defs`.
    """
    config = RawConfigParser()
    with open(path, encoding="utf-8") as handle:
        config.read_file(handle)

    records = []
    for section in config.sections():
        record = {"id": section}
        for option in config.options(section):
            value = config.get(section, option)
            if _is_list_option(option):
                record[option[:-5]] = [element.strip() for element in value.split("|")]
            else:
                record[option] = value.strip()
        records.append(record)
    return records


def read_numbers(path):
    """Read `numbers.dat`: one integer per line, `#` starts a comment."""
    numbers = []
    with open(path, encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            value = line.split("#")[0].strip()
            if not value:
                continue
            try:
                numbers.append(int(value))
            except ValueError:
                raise SourceError(
                    "%s line %d: %r is not an integer" % (path, line_number, value)
                ) from None
    return numbers


def read_internal_ids(path):
    """Read `internal_id.dat`: `type|human id = 0xNNNN`, `#` comments, blank lines."""
    records = []
    seen_ids = set()
    with open(path, encoding="utf-8") as handle:
        for line_number, raw in enumerate(handle, 1):
            line = raw.strip()
            if not line or line[0] == "#":
                continue

            parts = line.split("=")
            if len(parts) != 2:
                raise SourceError(
                    "%s line %d: expected one '=', got %d" % (path, line_number, len(parts) - 1)
                )
            names = parts[0].split("|")
            if len(names) != 2:
                raise SourceError(
                    "%s line %d: expected 'type|id' left of '='" % (path, line_number)
                )

            object_type = names[0].strip()
            object_id = names[1].strip()
            internal_id = parts[1].strip()
            if not object_type or not object_id or not internal_id:
                raise SourceError("%s line %d: empty field" % (path, line_number))

            # load_internal_id exits on a repeated (type, id) and deliberately does not check
            # the other direction: a repeated internal id is a rename alias. tech|Fusion
            # Reactor and tech|Fusion Power both carry 0x0101001d, and the first names no
            # tech — it is the name the tech had before the rename, which is what lets a save
            # written under the old name resolve to the new one. Transcribed as it stands;
            # sim/test/content.trace.test.ts has the check.
            if (object_type, object_id) in seen_ids:
                raise SourceError(
                    "%s line %d: %s|%s is already mapped"
                    % (path, line_number, object_type, object_id)
                )
            seen_ids.add((object_type, object_id))

            records.append({"type": object_type, "id": object_id, "internal_id": internal_id})
    return records


def read_story(path):
    """Read `story.dat`: `[section]`, `|`-prefixed text, a blank line ends a dialog.

    `# TRANSLATORS:` comments attach to the dialog they precede, as they do upstream.
    """
    sections = []
    current = None
    segment = ""
    comments = ""

    def flush():
        nonlocal segment, comments
        if not segment:
            return
        if current is None:
            raise SourceError("%s: text before the first section" % path)
        current["parts"].append({"text": segment, "translator_comments": comments.strip()})
        segment = ""
        comments = ""

    with open(path, encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line or line == "\n":
                flush()
                continue

            if line[0] == "#":
                if line.startswith("# TRANSLATORS:") and current is not None:
                    comments += " " + line[14:].strip()
            elif line[0] == "[":
                if line.rstrip("\n")[-1:] != "]":
                    raise SourceError(
                        "%s line %d: line starts with '[' and is not a section"
                        % (path, line_number)
                    )
                current = {"id": line.rstrip("\n")[1:-1], "parts": []}
                sections.append(current)
            elif line[0] == "|":
                if current is None:
                    raise SourceError("%s: text before the first section" % path)
                segment += line[1:]
            else:
                raise SourceError("%s line %d: invalid command" % (path, line_number))

    flush()
    return sections
