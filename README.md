# Endgame: Singularity in the browser

A browser port of [Endgame: Singularity](https://github.com/singularity/singularity), the
game about an AI that tries to survive and grow without being discovered.

This is an unofficial port. It is not affiliated with or endorsed by the Endgame:
Singularity project.

The simulation is a hand translation of the original Python rules into TypeScript. Its
behaviour is checked against the original game, which is vendored in `singularity/`. The
interface is new: one map, one inspector, no stack of modal dialogs.

## Play

The game runs in any current desktop browser. It saves to local storage in that browser.

## Develop

You need [bun](https://bun.sh) 1.3 and, for the tests against the original game, Python 3.13.

```bash
bun install
python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt
bunx playwright-core install --only-shell chromium   # once per machine, for the browser tests

bun run dev        # development server, with a scenario menu on the start screen
bun run test       # the whole suite
bun run typecheck
bun run lint
bun run build      # production build into app/dist/
bun run preview    # build, then serve what ships
```

`package.json` lists more `check:*` scripts. Each one is a filter over the same test run.

## Layout

| Path           | Content                                                                             |
| -------------- | ----------------------------------------------------------------------------------- |
| `sim/`         | The simulation. Pure TypeScript, no browser API.                                    |
| `app/`         | The browser application: host, save store and interface (Preact).                   |
| `content/`     | Game data, converted from the original `.dat` files.                                |
| `scenarios/`   | Recorded game situations, for tests and for the development start screen.           |
| `singularity/` | The original game, read-only. Used by the tests and the content converter.          |
| `tools/`       | Python and TypeScript tooling: content converter, trace recorder, asset generators. |

## Licence

GPL-2.0-or-later. The game data in `content/` is CC-BY-SA 3.0. `NOTICE` lists every
source and its terms, and the game shows the same text on its licences page.
