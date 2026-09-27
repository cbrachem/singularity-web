#!/usr/bin/env python3
"""Fetch the two self-hosted woff2 subsets the shell's type is set in.

**Two self-hosted woff2 subsets, no font CDN.** The inspector puts eight numbers side by
side that must not shift, so tabular figures are load-bearing, and a family named but never
loaded makes every screenshot machine-dependent.

Two files, because two is what the design asks for and each one is a request:

* **Archivo**, the sans, as the *variable* latin subset — one file covering 100..900, so a
  weight is a design choice rather than another download.
* **IBM Plex Mono**, the readout face, latin subset at 400. Numbers are what it is here
  for; a second weight would be a second file for emphasis the sans already carries.

Both are under the SIL Open Font License 1.1. The licence text travels with them, and
`NOTICE` carries the provenance block.

    .venv/bin/python tools/assets/fetch_fonts.py
    .venv/bin/python tools/assets/fetch_fonts.py --check

The gstatic URLs are pinned, because they carry the font's version (`v25`) and a rebuild
that silently picked up a new one would move every glyph without saying so. `--check`
re-downloads them and compares bytes against what is committed; a moved URL fails there,
which is where a version bump should be noticed. Re-pin by re-reading the CSS API:

    curl -A '<a browser UA>' \\
      'https://fonts.googleapis.com/css2?family=Archivo:wght@100..900&display=swap'
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
FONT_DIR = REPOSITORY / "app" / "src" / "ui" / "fonts"

OFL_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/archivo/OFL.txt"


@dataclass(frozen=True)
class Subset:
    file: str
    url: str
    sha256: str
    family: str
    weight: str
    copyright: str
    project: str


SUBSETS: tuple[Subset, ...] = (
    Subset(
        file="archivo-latin-variable.woff2",
        url="https://fonts.gstatic.com/s/archivo/v25/k3kPo8UDI-1M0wlSV9XAw6lQkqWY8Q82sLydOxI.woff2",
        sha256="8f704806dbedeaaeca334b11ec348bc3ac3a439d6431544b3afb54f534ee4967",
        family="Archivo",
        weight="100 900 (variable)",
        copyright="Copyright 2020 The Archivo Project Authors "
        "(https://github.com/Omnibus-Type/Archivo)",
        project="https://github.com/Omnibus-Type/Archivo",
    ),
    Subset(
        file="ibm-plex-mono-latin-400.woff2",
        url="https://fonts.gstatic.com/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1i8q1w.woff2",
        sha256="08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7",
        family="IBM Plex Mono",
        weight="400",
        copyright="Copyright 2017 IBM Corp. All rights reserved.",
        project="https://github.com/IBM/plex",
    ),
)

SIDECAR = """\
{family}, {weight}, latin subset — {file}

Source:     Google Fonts, {url}
Upstream:   {project}
Licence:    SIL Open Font License 1.1 — see LICENSE.OFL-1.1.txt beside this file
{copyright}

Fetched and verified by tools/assets/fetch_fonts.py. This is the subset Google Fonts
serves for the `latin` unicode-range; no glyphs were added, removed or reshaped.
"""


def ofl_body(text: str) -> str:
    """The licence itself, without the one font's copyright line above it.

    Every OFL.txt in the Google Fonts tree opens with the copyright of the family it sits
    beside. Two families share this file, so the shared half is what is committed and each
    family's own copyright goes in its `.license` sidecar — which is what the OFL asks for
    anyway: the notice travels with the font.
    """
    banner = text.index("-----------------------------------------------------------")
    return text[banner:]


def download(url: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            # gstatic serves woff2 only to a client that says it can read it; the default
            # Python agent gets ttf, which is a different file and a larger one.
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
    )
    return urllib.request.urlopen(request).read()


def fetch(subset: Subset) -> bytes:
    payload = download(subset.url)
    digest = hashlib.sha256(payload).hexdigest()
    if subset.sha256 and digest != subset.sha256:
        raise SystemExit(
            f"{subset.url}: sha256 is {digest}, expected {subset.sha256} — "
            "the pinned URL now serves something else"
        )
    if not payload.startswith(b"wOF2"):
        raise SystemExit(f"{subset.url}: not a woff2 file")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail if a committed subset differs from what the pinned URL serves",
    )
    arguments = parser.parse_args()

    FONT_DIR.mkdir(parents=True, exist_ok=True)
    stale = False

    for subset in SUBSETS:
        payload = fetch(subset)
        target = FONT_DIR / subset.file
        sidecar = target.with_suffix(target.suffix + ".license")
        note = SIDECAR.format(
            family=subset.family,
            weight=subset.weight,
            file=subset.file,
            url=subset.url,
            project=subset.project,
            copyright=subset.copyright,
        )

        if arguments.check:
            if not target.exists() or target.read_bytes() != payload:
                print(f"{target}: stale — re-run tools/assets/fetch_fonts.py", file=sys.stderr)
                stale = True
            elif not sidecar.exists() or sidecar.read_text(encoding="utf-8") != note:
                print(f"{sidecar}: stale — re-run tools/assets/fetch_fonts.py", file=sys.stderr)
                stale = True
            else:
                print(f"{target}: up to date ({len(payload)} bytes)")
            continue

        target.write_bytes(payload)
        sidecar.write_text(note, encoding="utf-8")
        print(f"{target}: {len(payload)} bytes, sha256 {hashlib.sha256(payload).hexdigest()}")

    licence = FONT_DIR / "LICENSE.OFL-1.1.txt"
    text = ofl_body(download(OFL_URL).decode("utf-8"))
    if arguments.check:
        if not licence.exists() or licence.read_text(encoding="utf-8") != text:
            print(f"{licence}: stale — re-run tools/assets/fetch_fonts.py", file=sys.stderr)
            stale = True
    else:
        licence.write_text(text, encoding="utf-8")
        print(f"{licence}: {len(text)} characters")

    return 1 if stale else 0


if __name__ == "__main__":
    raise SystemExit(main())
