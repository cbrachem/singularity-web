import {
  ITEM_CONSTRUCTED,
  allBases,
  content,
  type LogEntry,
  type SimulationState,
} from "@singularity/sim";
import type { JSX } from "preact";
import { useState } from "preact/hooks";

import { ESTATE_HOTKEYS } from "./estate.ts";
import { formatGameTime } from "./game-time.ts";
import { plainLabel, toMoney } from "./readouts.ts";
import { setShortcutsOn, shortcutsOn } from "./shortcuts.ts";
import "./Console.css";

const ROW_HEIGHT = 46;
const EXPANDED_ROW_HEIGHT = 92;
const VIEWPORT_ROWS = 12;
/**
 * Kind, heading, and the field the heading shows — the subject the Console chooses to name,
 * not whichever field the entry lists first. It read right off a position only because
 * `sim/src/advance.ts` and `LOG_KINDS` (`sim/src/project.ts`) both put the subject first, and
 * that order is now load-bearing for whether a save loads at all: a reorder there
 * would otherwise silently retitle every row of the kind.
 */
const logKinds = [
  ["tech-researched", "Tech researched", "tech_id"],
  ["base-constructed", "Base constructed", "base_name"],
  // The kind the Simulation emits, taken from it rather than spelled again: this row read
  // `item-constructed`, which nothing emits, so finished items had no filter and no heading.
  [ITEM_CONSTRUCTED, "Item constructed", "item_spec_id"],
  ["base-lost-maint", "Base lost to maintenance", "base_name"],
  ["base-lost-discovered", "Base discovered", "base_name"],
  ["event-emitted", "Event emitted", "event_id"],
] as const;
type Tab = "Log" | "Report" | "Settings";

export interface ConsoleProps {
  readonly state: SimulationState;
  readonly onClose: () => void;
  readonly nightVisible: boolean;
  readonly onNightVisible: (visible: boolean) => void;
  /**
   * The surface the console is the second way into: the licences, because whoever
   * receives the bundle must be able to find them without ending a game. The save list was
   * the other one and is gone with the surface itself.
   *
   * It is an entry beside the tabs rather than a tab, because it is not console content: it
   * opens its own surface *over* the console and closes back to it (`App.tsx`). Left out
   * where there is nothing behind it — a shell booted with no page under it draws no entry
   * it cannot honour.
   */
  readonly onLicences?: () => void;
}

export function Console({
  state,
  onClose,
  nightVisible,
  onNightVisible,
  onLicences,
}: ConsoleProps): JSX.Element {
  const [tab, setTab] = useState<Tab>("Log");
  return (
    <section class="console" aria-label="Console" data-bottom="reserved-band" data-opaque="true">
      <header class="console__header">
        <div role="tablist" aria-label="Console sections">
          {(["Log", "Report", "Settings"] as const).map((name) => (
            <button
              key={name}
              role="tab"
              type="button"
              aria-selected={tab === name}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </div>
        <div class="console__entries">
          {onLicences && (
            <button type="button" class="console__entry" onClick={onLicences}>
              Licences &amp; source
            </button>
          )}
          <button type="button" class="console__close" aria-label="Close console" onClick={onClose}>
            ×
          </button>
        </div>
      </header>
      <div class="console__body">
        {tab === "Log" && <Log entries={state.log} />}
        {tab === "Report" && <Report state={state} />}
        {tab === "Settings" && (
          <Settings nightVisible={nightVisible} onNightVisible={onNightVisible} />
        )}
      </div>
    </section>
  );
}

function Log({ entries }: { readonly entries: readonly LogEntry[] }): JSX.Element {
  const [shown, setShown] = useState<Set<string>>(() => new Set(logKinds.map(([kind]) => kind)));
  const [firstRow, setFirstRow] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);
  const rows = entries.filter((entry) => shown.has(entry.kind));
  return (
    <div class="console__log">
      <fieldset class="console__filters">
        <legend>Log filters</legend>
        {logKinds.map(([kind, label]) => (
          <label key={kind}>
            <input
              type="checkbox"
              checked={shown.has(kind)}
              aria-label={`Show ${label} log entries`}
              onInput={(event) =>
                setShown((current) => {
                  const next = new Set(current);
                  if (event.currentTarget.checked) next.add(kind);
                  else next.delete(kind);
                  return next;
                })
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      <VirtualList
        class="console__log-list"
        total={rows.length}
        firstRow={firstRow}
        onScroll={setFirstRow}
        extraRow={expanded}
      >
        {rows.slice(firstRow, firstRow + VIEWPORT_ROWS).map((entry, offset) => {
          const index = firstRow + offset;
          return (
            <button
              key={`${entry.rawEmitTime}-${index}`}
              type="button"
              class="console__log-row"
              style={{ height: `${expanded === index ? EXPANDED_ROW_HEIGHT : ROW_HEIGHT}px` }}
              onClick={() => setExpanded(expanded === index ? null : index)}
            >
              {/*
                When, then what. The day was at the far right of a full-width row, so pairing
                an entry with its time meant crossing the whole console for every line; the
                timestamps are also the repeating half — nine rows of one game day in a row —
                so as a left column they form a spine the eye can skip down instead.
              */}
              <span>{formatGameTime(entry.rawEmitTime)}</span>
              <strong>{logLabel(entry)}</strong>
              {expanded === index && (
                <small>
                  {Object.entries(entry.fields)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join(" · ")}
                </small>
              )}
            </button>
          );
        })}
      </VirtualList>
    </div>
  );
}

function Report({ state }: { readonly state: SimulationState }): JSX.Element {
  const allocated = state.cpuUsage.reduce((total, allocation) => total + allocation.cpu, 0);
  const maintenance = [...allBases(state)].reduce((total, base) => total + base.maintenance[0], 0);
  const difficulty = content.difficulties.byId.get(state.difficulty);
  return (
    <div class="console__report">
      <ReportBlock
        title="Financial report"
        rows={[
          ["Cash", state.cash],
          ["Income / day", state.income],
          ["Maintenance / day", -maintenance],
          ["Net / day", state.income - maintenance],
        ]}
      />
      <ReportBlock
        title="CPU usage"
        rows={[
          ["Available", state.availableCpus[0] ?? 0],
          ["Allocated", allocated],
          ["Sleeping", state.sleepingCpus],
          ["Pool", (state.availableCpus[0] ?? 0) - allocated],
        ]}
      />
      <ReportBlock
        title="Statistics"
        rows={[
          ["Difficulty", plainLabel(difficulty?.name ?? state.difficulty)],
          ["Cash earned", state.stats.cashEarned],
          ["CPU used", state.stats.cpuUsed],
          ["Technologies", state.stats.techCreated],
          ["Bases", state.stats.baseCreated],
          ["Items", state.stats.itemCreated],
        ]}
      />
    </div>
  );
}

function ReportBlock({
  title,
  rows,
}: {
  readonly title: string;
  readonly rows: readonly (readonly [string, number | string])[];
}): JSX.Element {
  return (
    <section class="console__report-block">
      <h2>{title}</h2>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {typeof value === "number" ? (
                toMoney(value)
              ) : (
                <output aria-label={label} aria-live="off">
                  {value}
                </output>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Settings({
  nightVisible,
  onNightVisible,
}: Pick<ConsoleProps, "nightVisible" | "onNightVisible">): JSX.Element {
  const [warnings, setWarnings] = useState(
    () => new Set(content.warnings.all.map((warning) => warning.id)),
  );
  return (
    <div class="console__settings">
      <h2>Warnings</h2>
      {content.warnings.all.map((warning) => (
        <label key={warning.id}>
          <input
            type="checkbox"
            checked={warnings.has(warning.id)}
            onInput={(event) =>
              setWarnings((current) => {
                const next = new Set(current);
                if (event.currentTarget.checked) next.add(warning.id);
                else next.delete(warning.id);
                return next;
              })
            }
          />
          {plainLabel(warning.name)}
        </label>
      ))}
      {/*
        The whole keyboard, written down where a player can find it. The digits are also on
        each speed button's `title`, which only a mouse discovers; Escape was nowhere at all.
        Two entries is the whole list — if it grows past what fits here, it wants
        its own surface, not a longer paragraph.
      */}
      <h2>Keyboard</h2>
      {/*
        The off switch WCAG 2.1.4 asks for, beside the list of the keys it governs: every
        shortcut below except Escape is one unmodified character, and two of them change what
        the player owns (`shortcuts.ts`). The list stays whatever the switch says — it is what
        the keys *are*, and it is where the player comes to turn them back on.
      */}
      <label>
        <input
          type="checkbox"
          checked={shortcutsOn.value}
          onInput={(event) => {
            setShortcutsOn(event.currentTarget.checked);
          }}
        />
        Single-key shortcuts
      </label>
      <dl class="console__keys">
        <div>
          <dt>0 1 2 3 4</dt>
          <dd>Speed, from paused to the fastest setting</dd>
        </div>
        <div>
          <dt>Escape</dt>
          <dd>Clear a selection, or close whatever is in front</dd>
        </div>
        {/*
          The five the estate answers to. They were in `ESTATE_HOTKEYS` and nowhere a player
          could read them — this list said the shell had two shortcuts when it has seven. Each
          is also printed on its own control (`Hotkey.tsx`); this is where they can be read
          together.
        */}
        <div>
          <dt>B</dt>
          <dd>Build the order the dial is set to</dd>
        </div>
        {/*
          The keys, not the dial's glyphs. The dial prints `−` because that is the arithmetic
          sign, and the key is the hyphen the keyboard actually has — a difference the control
          itself cannot say, which is half of why this list exists.
        */}
        <div>
          <dt>
            {ESTATE_HOTKEYS.more} {ESTATE_HOTKEYS.fewer}
          </dt>
          <dd>More or fewer bases in that order</dd>
        </div>
        <div>
          <dt>A</dt>
          <dd>Select every base at the open location</dd>
        </div>
        <div>
          <dt>D</dt>
          <dd>Destroy the selection. It asks once before it does</dd>
        </div>
      </dl>
      <label>
        <input
          type="checkbox"
          checked={nightVisible}
          onInput={(event) => onNightVisible(event.currentTarget.checked)}
        />
        Day/night
      </label>
    </div>
  );
}

function VirtualList({
  class: className,
  total,
  firstRow,
  onScroll,
  children,
  extraRow,
}: {
  readonly class: string;
  readonly total: number;
  readonly firstRow: number;
  readonly onScroll: (row: number) => void;
  readonly children: readonly JSX.Element[];
  readonly extraRow?: number | null;
}): JSX.Element {
  const extraHeight = extraRow === null || extraRow === undefined ? 0 : ROW_HEIGHT;
  const translatedExtra =
    extraRow !== null && extraRow !== undefined && firstRow > extraRow ? ROW_HEIGHT : 0;
  return (
    <div
      class={className}
      data-total-rows={total}
      onScroll={(event) => onScroll(Math.floor(event.currentTarget.scrollTop / ROW_HEIGHT))}
    >
      <div class="console__spacer" style={{ height: `${total * ROW_HEIGHT + extraHeight}px` }}>
        <div
          class="console__rows"
          style={{ transform: `translateY(${firstRow * ROW_HEIGHT + translatedExtra}px)` }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function logLabel(entry: LogEntry): string {
  const found = logKinds.find(([kind]) => kind === entry.kind);
  const subject = found && entry.fields[found[2]];
  return `${found?.[1] ?? entry.kind}: ${subject ?? ""}`;
}
