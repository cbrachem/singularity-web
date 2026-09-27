#!/usr/bin/env python3
"""Build the world map's land path from Natural Earth 110m.

The map is DOM and inline SVG, and the graphic comes from Natural Earth land at 110m, by way
of the ``world-atlas`` TopoJSON build, projected into the 0-100 equirectangular grid and
simplified at **tolerance 0.3**. The projection is not
a choice — the reference's own ``position_list`` values decode exactly to latitude and
longitude under equirectangular, so the graphic has to match the Content rather than the
other way round — and the tolerance was chosen by looking at coastlines, not by counting
bytes.

The output is a committed TypeScript module under ``app/src/ui/map/``. It is not converter
output, so it may not live in ``content/``, whose dirty-tree check in CI depends on that
directory holding nothing but the Content converter's own output.

    .venv/bin/python tools/assets/build_land_path.py
    .venv/bin/python tools/assets/build_land_path.py --check

``--check`` re-derives the path and fails if the committed module has drifted, which is the
same tripwire ``content/`` gets from its dirty-tree check.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import sys
import tarfile
import urllib.request
from pathlib import Path

# The exact build the path is derived from, pinned the way an install would pin it. The
# integrity is npm's own for this tarball, so a substituted archive fails before it is read.
PACKAGE = "world-atlas"
VERSION = "2.0.2"
TARBALL = f"https://registry.npmjs.org/{PACKAGE}/-/{PACKAGE}-{VERSION}.tgz"
# One unbroken token: it is compared against what the registry reports, by eye as often as
# by this script, and a wrapped hash is a hash nobody can compare.
INTEGRITY = "sha512-IXfV0qwlKXpckz1FhwXVwKRjiIhOnWttOskm5CtxMsjgE/MXAYRHWJqgXOpM8IkcPBoXnyTU5lFHcYa5ChG0LQ=="  # noqa: E501
MEMBER = "package/land-110m.json"

# Douglas-Peucker, in grid units — the same units the pins are placed in, so the tolerance
# is 0.3% of the map's width and reads the same at any rendered size.
TOLERANCE = 0.3

# Coordinates are written with one decimal, which is 0.1 grid units — a third of the
# tolerance, and below what any supported viewport can resolve (the globe is floored
# at 624px, where 0.1 grid units is 0.6px).
PRECISION = 1

REPOSITORY = Path(__file__).resolve().parents[2]
OUTPUT = REPOSITORY / "app" / "src" / "ui" / "map" / "land.ts"


def fetch_topology(source: Path | None) -> dict:
    if source is not None:
        return json.loads(source.read_text(encoding="utf-8"))

    archive = urllib.request.urlopen(TARBALL).read()
    algorithm, expected = INTEGRITY.split("-", 1)
    digest = base64.b64encode(hashlib.new(algorithm, archive).digest()).decode("ascii")
    if digest != expected:
        raise SystemExit(f"{TARBALL}: integrity is {algorithm}-{digest}, expected {INTEGRITY}")

    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        member = tar.extractfile(MEMBER)
        if member is None:
            raise SystemExit(f"{TARBALL}: no {MEMBER} in the archive")
        return json.loads(member.read().decode("utf-8"))


def decode_arcs(topology: dict) -> list[list[tuple[float, float]]]:
    """TopoJSON's quantised delta arcs, back to (longitude, latitude) pairs."""
    scale = topology["transform"]["scale"]
    translate = topology["transform"]["translate"]
    decoded = []
    for arc in topology["arcs"]:
        x = y = 0
        points = []
        for dx, dy in arc:
            x += dx
            y += dy
            points.append((x * scale[0] + translate[0], y * scale[1] + translate[1]))
        decoded.append(points)
    return decoded


def ring_points(
    indices: list[int], arcs: list[list[tuple[float, float]]]
) -> list[tuple[float, float]]:
    """One ring, stitched out of its arcs. A negative index means the arc, reversed."""
    points: list[tuple[float, float]] = []
    for index in indices:
        arc = arcs[~index][::-1] if index < 0 else arcs[index]
        points.extend(arc[1:] if points else arc)
    return points


def project(point: tuple[float, float]) -> tuple[float, float]:
    """Equirectangular, into the 0-100 grid the Content's positions are written in."""
    longitude, latitude = point
    return ((longitude + 180.0) / 360.0 * 100.0, (90.0 - latitude) / 180.0 * 100.0)


def _perpendicular_distance(
    point: tuple[float, float],
    start: tuple[float, float],
    end: tuple[float, float],
) -> float:
    (px, py), (ax, ay), (bx, by) = point, start, end
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    return abs(dy * px - dx * py + bx * ay - by * ax) / (dx * dx + dy * dy) ** 0.5


def simplify(points: list[tuple[float, float]], tolerance: float) -> list[tuple[float, float]]:
    """Douglas-Peucker, iterative so a 1000-point ring cannot exhaust the stack."""
    if len(points) < 3:
        return list(points)

    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    pending = [(0, len(points) - 1)]
    while pending:
        first, last = pending.pop()
        if last <= first + 1:
            continue
        worst, at = tolerance, -1
        for index in range(first + 1, last):
            distance = _perpendicular_distance(points[index], points[first], points[last])
            if distance > worst:
                worst, at = distance, index
        if at != -1:
            keep[at] = True
            pending.append((first, at))
            pending.append((at, last))
    return [point for point, kept in zip(points, keep, strict=True) if kept]


def rounded(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Rounded to the emitted precision, with the duplicates that produces removed."""
    out: list[tuple[float, float]] = []
    for x, y in points:
        point = (round(x, PRECISION) + 0.0, round(y, PRECISION) + 0.0)
        if not out or point != out[-1]:
            out.append(point)
    return out


def enclosed_area(ring: list[tuple[float, float]]) -> float:
    """The shoelace area, unsigned. Zero for a ring whose corners are collinear."""
    twice = 0.0
    for index, (x1, y1) in enumerate(ring):
        x2, y2 = ring[(index + 1) % len(ring)]
        twice += x1 * y2 - x2 * y1
    return abs(twice) / 2


def land_rings(topology: dict) -> list[list[tuple[float, float]]]:
    arcs = decode_arcs(topology)
    rings: list[list[tuple[float, float]]] = []
    for geometry in topology["objects"]["land"]["geometries"]:
        polygons = [geometry["arcs"]] if geometry["type"] == "Polygon" else geometry["arcs"]
        for polygon in polygons:
            for ring in polygon:
                projected = [project(point) for point in ring_points(ring, arcs)]
                simplified = rounded(simplify(projected, TOLERANCE))
                if simplified and simplified[0] == simplified[-1]:
                    simplified = simplified[:-1]
                # An island the simplification flattened encloses no area at all — its
                # corners came out collinear. These are the small islands the map drops,
                # and the rule is what they became rather than how big they were: a ring
                # with no area draws as a hairline in the ocean, which reads as a defect
                # rather than as a coastline.
                if len(simplified) >= 3 and enclosed_area(simplified) > 0:
                    rings.append(simplified)
    return rings


def path_data(rings: list[list[tuple[float, float]]]) -> str:
    def number(value: float) -> str:
        text = f"{value:.{PRECISION}f}".rstrip("0").rstrip(".")
        return "0" if text in ("", "-0") else text

    parts = []
    for ring in rings:
        first, *rest = ring
        parts.append("M" + number(first[0]) + " " + number(first[1]))
        parts.extend("L" + number(x) + " " + number(y) for x, y in rest)
        parts.append("Z")
    return "".join(parts)


def module_source(path: str, rings: int) -> str:
    return f'''/**
 * The world map's land, as one SVG path in the 0-100 equirectangular grid.
 *
 * **Generated. Do not edit.** Rebuild with:
 *
 * ```
 * .venv/bin/python tools/assets/build_land_path.py
 * ```
 *
 * Natural Earth 1:110m land (public domain), by way of {PACKAGE}@{VERSION} (ISC),
 * projected equirectangular into the 0-100 grid and simplified with Douglas-Peucker at
 * tolerance {TOLERANCE} — {rings} rings. Provenance is recorded in `NOTICE`.
 *
 * The projection matches the Content rather than the other way round: a location's
 * `position` decodes to longitude and latitude under equirectangular, so `x` and `y` here
 * are the same two percentages a pin is placed at (`./geometry.ts`).
 */

export const LAND_RING_COUNT = {rings};

export const LAND_PATH =
  "{path}";
'''


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        help=f"a local {MEMBER}, instead of downloading {PACKAGE}@{VERSION}",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail if the committed module differs from what would be written",
    )
    arguments = parser.parse_args()

    rings = land_rings(fetch_topology(arguments.source))
    source = module_source(path_data(rings), len(rings))

    if arguments.check:
        if not OUTPUT.exists():
            print(f"{OUTPUT}: missing", file=sys.stderr)
            return 1
        if OUTPUT.read_text(encoding="utf-8") != source:
            print(f"{OUTPUT}: stale — re-run tools/assets/build_land_path.py", file=sys.stderr)
            return 1
        print(f"{OUTPUT}: up to date ({len(rings)} rings)")
        return 0

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(source, encoding="utf-8")
    print(f"{OUTPUT}: {len(rings)} rings, {len(source)} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
