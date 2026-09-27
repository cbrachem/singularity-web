import {
  ITEM_SLOTS,
  LABOR,
  availablePowerStates,
  content,
  detectChance,
  slotOf,
  type BaseState,
  type BaseType,
  type Command,
  type LocationState,
  type SimulationState,
} from "@singularity/sim";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { Hotkey } from "./Hotkey.tsx";
import { plainLabel, toCpu, toMoney, toTime } from "./readouts.ts";
import { shortcutKey, shortcutsOn } from "./shortcuts.ts";
import { LEVEL_WORDS, detectChanceToDangerLevel, toPercent } from "./threat.ts";
import {
  ESTATE_HOTKEYS,
  MAX_ORDER,
  baseKeys,
  compactBaseStatus,
  buildOrder,
  buildProjection,
  buildableBaseTypes,
  buyItemOrder,
  buyableItems,
  destroyOrder,
  destroyRefusal,
  itemProjection,
  itemQualityLines,
  noRoomRefusal,
  orderFlow,
  roomFor,
  selectedBases,
  showsCpu,
  specDetectChance,
} from "./estate.ts";
import "./Inspector.css";

export interface InspectorProps {
  readonly state: SimulationState;
  readonly locationId: string;
  readonly onClose: () => void;
  readonly onCommand?: (command: Command) => void;
  /**
   * True while any other surface is in front of the inspector. The shell decides it, because
   * the shell is what draws those surfaces (`App.tsx`, `surfaces.ts`), and it is the same
   * answer the shell stops its own keyboard on — one rule about what is in front of the
   * player, evaluated in one place, rather than a second policy here that could drift from it.
   */
  readonly obscured?: boolean;
}

/** How long the armed destroy confirm stands before it is withdrawn. */
export const DESTROY_CONFIRM_TIMEOUT_MS = 5000;

/**
 * The inspector, and with it the two bulk affordances the estate is shaped through: a
 * **quantity dial** that orders *n* bases, and a **multi-select** that destroys the ones the
 * player ticked.
 *
 * Both are Presentation and neither needs anything from the Simulation. They decompose into
 * the commands that already exist — *n* × build, *n* × destroy, issued in order — and command
 * order is exactly what the Trace binds, so a bulk action carries no fidelity risk.
 * The rules they read are in `./estate.ts`, which is where the reasoning for each of them is.
 *
 * # Why the quantity dial does not confirm
 *
 * Building costs nothing at the moment of the click: a base is paid off over the ticks that
 * follow. Ordering twenty bases is therefore not a spending decision but a decision to dilute
 * construction throughput, and a confirmation would ask the player to approve a payment that
 * is not happening. So the affordance **projects** — four readouts say what the order will
 * draw and what it will cost to keep, and two more say where the next day goes with it in the
 * queue — and the button then does it.
 *
 * # Why the selection lives here rather than in the list
 *
 * The location detail is unmounted whenever the player looks at one base and comes back, and a
 * selection that survives that is the difference between a usable multi-select and a
 * frustrating one. The location the selection belongs to is this component's prop, so the
 * reset when that changes is here too — a base identity means nothing in another location.
 *
 * The selection holds *identities* and never indices (`baseKeys` in `./estate.ts`). The world
 * removes bases behind the player's back, every removal shifts the indices behind it, and a
 * remembered index would then tick a row the player never chose.
 */
export function Inspector({
  state,
  locationId,
  onClose,
  onCommand,
  obscured = false,
}: InspectorProps): JSX.Element | null {
  const [baseIndex, setBaseIndex] = useState<number | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [order, setOrder] = useState(1);
  const [baseTypeId, setBaseTypeId] = useState<string | null>(null);
  /** Read now rather than closed over: an Effect re-registers a paint late (`App.tsx`). */
  const covered = useRef(obscured);
  covered.current = obscured;

  /** Whether the destroy button has been pressed once and is waiting to be pressed again. */
  const [confirmingDestroy, setConfirmingDestroy] = useState(false);

  /**
   * The bulk row recedes behind a disclosure: the location view leads with the
   * base table, and Select all / Clear / Destroy appear when a selection starts. The state
   * follows the selection — open when a row is ticked, closed when the last untick empties it
   * — and the toggle button overrides it either way. The hotkeys never read it: `a` and `d`
   * act on the selection itself, and `a` opens it through this effect, so the player sees
   * what a keyboard select-all armed.
   */
  const [bulkOpen, setBulkOpen] = useState(false);
  const someSelected = selected.size > 0;
  useEffect(() => setBulkOpen(someSelected), [someSelected]);

  /*
   * The estate's answer, in the AI's own voice. Build and destroy used to succeed into
   * silence — the only response a list mutation out of the player's gaze, and nothing at all
   * for a screen reader. Transient: the next acknowledgment replaces it, and a location
   * change clears it. The region it fills is rendered always, because a live region added
   * together with its text is often not announced.
   */
  const [acknowledgment, setAcknowledgment] = useState("");

  useEffect(() => {
    setBaseIndex(null);
    setSelected(new Set());
    setAcknowledgment("");
  }, [locationId]);

  /*
   * A standing question is about the set of bases it was asked for. Change the selection and
   * the question is withdrawn, so a press left over from three bases ago cannot be spent on
   * whatever is ticked now.
   */
  useEffect(() => setConfirmingDestroy(false), [selected]);

  /*
   * And it expires: `d` arms it invisibly, so a second `d` minutes later — button off-screen,
   * player elsewhere in the panel — would destroy with no question the player ever saw.
   * Wall-clock deliberately: this is Presentation, and the game clock may be paused while the
   * player is still acting.
   */
  useEffect(() => {
    if (!confirmingDestroy) return;
    const timer = setTimeout(() => setConfirmingDestroy(false), DESTROY_CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [confirmingDestroy]);

  const location = content.locations.byId.get(locationId);
  const locationState = state.locations.find((candidate) => candidate.specId === locationId);
  const buildable = buildableBaseTypes(state, locationId);
  const chosen = buildable.find((spec) => spec.id === baseTypeId) ?? buildable[0] ?? null;
  const bases = locationState?.bases ?? [];
  /*
   * Derived during render, never trusted from state: the remembered index outlives its base
   * whenever the player switches location before the reset effect runs, or the world removes
   * bases while one is inspected. When the base is gone, the inspector falls back to the
   * location list rather than dereferencing what is not there.
   */
  const inspectedBase = baseIndex === null ? null : (bases[baseIndex] ?? null);
  const selection = selectedBases(bases, selected);
  const refusal = selection.length === 0 ? null : destroyRefusal(state, selection);

  /*
   * Every other estate action withdraws the question too: a player who builds, redials the
   * order or opens a base has moved on from the destroy they armed.
   */
  const build = (): void => {
    setConfirmingDestroy(false);
    if (!chosen) return;
    for (const command of buildOrder(locationId, chosen, order)) onCommand?.(command);
    setAcknowledgment(`Ordered ${order} × ${plainLabel(chosen.name)}.`);
  };
  const changeOrder = (next: number): void => {
    setConfirmingDestroy(false);
    setOrder(next);
  };
  const inspectBase = (index: number): void => {
    setConfirmingDestroy(false);
    setBaseIndex(index);
  };
  /*
   * Destroying is the one action in the shell that cannot be undone, and it was one press
   * away from a button that unticks a checkbox. So it asks first — and the asking lives here,
   * on the one function both callers go through, rather than on the button: `d` is a hotkey
   * for the same action (`ESTATE_HOTKEYS.destroy`), and a guard on the button alone would
   * leave the keyboard destroying without a question.
   *
   * The button itself asks again rather than a dialog doing it: a modal here would stop a
   * game that is still running to protect a click the player can simply not make twice.
   */
  const destroy = (): void => {
    if (selection.length === 0 || refusal) return;
    if (!confirmingDestroy) {
      /*
       * The question takes the acknowledgment's line, so it takes the acknowledgment with it:
       * withdrawing the question — by the timeout, by a changed selection, by another estate
       * action — would otherwise put the last answer back into a polite region and announce an
       * order the player made minutes ago, with nothing to prompt it.
       */
      setAcknowledgment("");
      setConfirmingDestroy(true);
      return;
    }
    setConfirmingDestroy(false);
    for (const command of destroyOrder(locationId, bases, selected)) onCommand?.(command);
    setSelected(new Set());
    setAcknowledgment(
      `${selection.length} ${selection.length === 1 ? "base" : "bases"} destroyed.`,
    );
  };
  const selectAll = (): void => setSelected(new Set(baseKeys(bases)));

  /**
   * The bulk path's keyboard. It runs in the capture phase because Escape is
   * shared: while there is a selection, Escape clears it and the shell's own Escape — which
   * closes whatever is over the map — must not also fire. With nothing selected the key is
   * left alone and the shell closes the inspector, which is what a player pressing it twice
   * expects.
   *
   * It reaches nothing at all while something is drawn over the inspector, which is the
   * shell's own rule about the keyboard rather than a second one: the surface in front of
   * the player owns the keys, the way upstream's dialogs do. Without that, a research sheet
   * over the inspector would leave `b` and `d` live behind it, and the player would be
   * building and destroying bases into a surface that shows neither. The Escape that clears
   * a selection is inside the same guard: while a sheet is up, Escape is the sheet's.
   *
   * Nothing here reaches the digits: `0`–`4` are the speed control's, and the shell already
   * stops them at an open surface anyway.
   */
  useEffect(() => {
    const pressed = (event: KeyboardEvent) => {
      if (covered.current) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (inspectedBase !== null) {
        /*
         * In the detail, Escape steps back one level to the location table — and stops
         * there, the way the selection-clear does, or the shell's own Escape would also
         * fire and close the inspector the player meant to step back inside.
         * The estate keys stay dead here: there is no build control in the detail.
         */
        if (event.key === "Escape") {
          event.stopPropagation();
          setBaseIndex(null);
        }
        return;
      }
      if (event.key === ESTATE_HOTKEYS.clear) {
        if (selected.size === 0) return;
        event.stopPropagation();
        setSelected(new Set());
        return;
      }
      if (isTextEntry(event.target)) return;
      // Everything below this line is one unmodified character, which is what the player may
      // turn off (WCAG 2.1.4, `shortcuts.ts`). Escape is above it and is never turned off.
      if (!shortcutsOn.value) return;
      switch (event.key.toLowerCase()) {
        case ESTATE_HOTKEYS.build:
          return build();
        case ESTATE_HOTKEYS.more:
          return changeOrder(Math.min(order + 1, MAX_ORDER));
        case ESTATE_HOTKEYS.fewer:
          return changeOrder(Math.max(order - 1, 1));
        case ESTATE_HOTKEYS.selectAll:
          return selectAll();
        case ESTATE_HOTKEYS.destroy:
          return destroy();
      }
    };
    window.addEventListener("keydown", pressed, true);
    return () => window.removeEventListener("keydown", pressed, true);
  });

  if (!location || !locationState) return null;

  return (
    <aside class="inspector" aria-label="Inspector">
      <header class="inspector__header">
        <div>
          <h1>{plainLabel(location.name)}</h1>
        </div>
        <button
          type="button"
          class="inspector__close"
          aria-label="Close inspector"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div class="inspector__body">
        {baseIndex === null || inspectedBase === null ? (
          <>
            <LocationDetail
              location={locationState}
              safety={location.safety}
              selected={selected}
              count={selection.length}
              refusal={refusal}
              onInspectBase={inspectBase}
              onToggle={(key) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (!next.delete(key)) next.add(key);
                  return next;
                })
              }
              onSelectAll={selectAll}
              onClear={() => setSelected(new Set())}
              confirming={confirmingDestroy}
              onDestroy={destroy}
              bulkOpen={bulkOpen}
              onToggleBulk={() => setBulkOpen((open) => !open)}
            />
            <BuildOrder
              state={state}
              locationId={locationId}
              buildable={buildable}
              chosen={chosen}
              order={order}
              onBaseType={setBaseTypeId}
              onOrder={changeOrder}
              onBuild={build}
            />
          </>
        ) : (
          <>
            <div class="inspector__nav">
              <button type="button" class="inspector__back" onClick={() => setBaseIndex(null)}>
                Back to {plainLabel(location.name)}
              </button>
              {/*
                Cycling by index, wrapping — an identity would be no safer here: the world
                removing a base is the derived-base guard's case either way, and the guard
                above already falls back to the table. One base offers no cycle at all.
              */}
              {bases.length > 1 && (
                <div class="inspector__cycle">
                  <button
                    type="button"
                    aria-label="Previous base"
                    onClick={() => inspectBase((baseIndex + bases.length - 1) % bases.length)}
                  >
                    ‹ Prev
                  </button>
                  <button
                    type="button"
                    aria-label="Next base"
                    onClick={() => inspectBase((baseIndex + 1) % bases.length)}
                  >
                    Next ›
                  </button>
                </div>
              )}
            </div>
            <BaseDetail
              state={state}
              location={locationState}
              baseIndex={baseIndex}
              base={inspectedBase}
              {...(onCommand && { onCommand })}
            />
          </>
        )}
        {/*
          The armed destroy is spoken here rather than only on the button, because `d` arms it
          from anywhere in the panel: the button's label changes where nobody is looking, and a
          screen reader user's second `d` would then be the first thing they hear about the
          question. Derived rather than stored — the arming is already state, and
          the acknowledgment underneath is what the line falls back to when it is withdrawn.
        */}
        <output class="inspector__acknowledgment" aria-label="Acknowledgment" aria-live="polite">
          {confirmingDestroy ? destroyQuestion(selection.length) : acknowledgment}
        </output>
      </div>
    </aside>
  );
}

/** The standing destroy, in the same voice the acknowledgment answers in. */
function destroyQuestion(count: number): string {
  return `Destroy ${count} ${count === 1 ? "base" : "bases"}? Press destroy again to confirm.`;
}

/** A key typed into a field is text, whatever else the surface would have done with it. */
function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  );
}

function LocationDetail({
  location,
  safety,
  selected,
  count,
  refusal,
  confirming,
  onInspectBase,
  onToggle,
  onSelectAll,
  onClear,
  onDestroy,
  bulkOpen,
  onToggleBulk,
}: {
  readonly location: LocationState;
  readonly safety: number;
  /** Base identities, not indices — see `baseKeys` in `./estate.ts`. */
  readonly selected: ReadonlySet<string>;
  /** How many of those identities still stand here, which is what the button will destroy. */
  readonly count: number;
  readonly refusal: string | null;
  /** Whether the destroy button has been pressed once and is waiting for the second press. */
  readonly confirming: boolean;
  readonly onInspectBase: (index: number) => void;
  readonly onToggle: (key: string) => void;
  readonly onSelectAll: () => void;
  readonly onClear: () => void;
  readonly onDestroy: () => void;
  /** Whether the bulk row is disclosed — the selection's own state, held by the parent. */
  readonly bulkOpen: boolean;
  readonly onToggleBulk: () => void;
}): JSX.Element {
  const [limit, setLimit] = useState(20);
  // Keyed over the whole list, then cut: the ordinal a repeated identity carries has to be the
  // one `selectedBases` and `destroyOrder` compute over the same list, not one counted from
  // the top of the page the player happens to be on.
  const keys = baseKeys(location.bases);
  const bases = location.bases.slice(0, limit);
  return (
    <>
      <p class="inspector__summary">
        Safety tier {safety} · {location.bases.length} bases
      </p>
      {location.bases.length === 0 ? (
        <p class="inspector__empty">No bases here yet.</p>
      ) : (
        <>
          {/*
            Upstream's location list is this table (`screens/location.py:221-269`), and the
            status vocabulary and the CPU cell's reticence are its own — an unfinished base is
            no longer indistinguishable from a finished one. The type sits under the name in
            the same cell and the building status is compact with the full sentence in title,
            so a row stays one two-line block at the panel's width. The name
            stays the button that opens the detail, so the row's one operable keeps its
            stable accessible name.
          */}
          <table class="inspector__bases">
            <thead>
              <tr>
                <th scope="col" />
                <th scope="col">Name</th>
                <th scope="col">CPU</th>
                <th scope="col">Status</th>
                <th scope="col">Power</th>
              </tr>
            </thead>
            <tbody>
              {bases.map((base, index) => {
                const status = compactBaseStatus(base);
                const key = keys[index] as string;
                return (
                  <tr key={key}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${base.name}`}
                        checked={selected.has(key)}
                        onChange={() => onToggle(key)}
                      />
                    </td>
                    <td class="inspector__name">
                      <button type="button" title={base.name} onClick={() => onInspectBase(index)}>
                        {base.name}
                      </button>
                      <span class="inspector__base-type">
                        {plainLabel(content.bases.byId.get(base.specId)?.name ?? base.specId)}
                      </span>
                    </td>
                    <td class="inspector__cpu">{showsCpu(base) ? toMoney(base.cpu) : ""}</td>
                    <td class="inspector__status" title={status.title ?? undefined}>
                      {status.text}
                    </td>
                    <td>{base.powerState}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/*
            The disclosure the bulk row recedes behind. A real button over a
            conditional region rather than `details`/`summary`, because the open state is the
            selection's — ticking a row opens it, emptying the selection closes it — and a
            native `details` holds that state itself.
          */}
          <button
            type="button"
            class="inspector__bulk-toggle"
            aria-expanded={bulkOpen}
            onClick={onToggleBulk}
          >
            <span aria-hidden="true">{bulkOpen ? "▾" : "▸"}</span> Bulk actions
          </button>
          {bulkOpen && (
            <div class="inspector__selection">
              <button
                type="button"
                aria-label="Select all bases"
                {...shortcutKey(ESTATE_HOTKEYS.selectAll)}
                onClick={onSelectAll}
              >
                Select all
                <Hotkey of={ESTATE_HOTKEYS.selectAll} />
              </button>
              {/*
              Escape is contextual: while there is a selection it clears it, and with nothing
              ticked it is the shell's again and closes the inspector (`Inspector.tsx`'s
              keyboard). The mark is on the control it does something to.
            */}
              <button
                type="button"
                aria-label="Clear selection"
                {...shortcutKey(ESTATE_HOTKEYS.clear)}
                onClick={onClear}
              >
                Clear
                <Hotkey of={ESTATE_HOTKEYS.clear} />
              </button>
              <button
                type="button"
                class="inspector__destroy"
                aria-label={
                  confirming ? "Confirm destroying selected bases" : "Destroy selected bases"
                }
                aria-disabled={refusal || count === 0 ? "true" : undefined}
                {...shortcutKey(ESTATE_HOTKEYS.destroy)}
                data-confirming={confirming ? "true" : undefined}
                onClick={onDestroy}
              >
                {confirming ? `Destroy ${count} — confirm` : `Destroy ${count}`}
                <Hotkey of={ESTATE_HOTKEYS.destroy} />
              </button>
            </div>
          )}
          {/*
            The refusal was `aria-live="off"` and drawn only when it had something to say, so a
            refused destroy was never spoken at all. It is a standing polite region
            now — standing for the same reason the acknowledgment is: a live region added
            together with its text is often not announced. The region stands outside
            the bulk disclosure; what it says still follows it, because a refusal is about a
            button the closed disclosure is not offering.
          */}
          <output class="inspector__refusal" aria-label="Destroy refusal" aria-live="polite">
            {bulkOpen ? (refusal ?? "") : ""}
          </output>
        </>
      )}
      {limit < location.bases.length && (
        <button type="button" class="inspector__more" onClick={() => setLimit(limit + 20)}>
          Show more bases
        </button>
      )}
    </>
  );
}

/**
 * The quantity dial and what it projects.
 *
 * There is no name field, and that is the point: a build command carries no name, the
 * Simulation names the base from the simulation RNG, and the player renames afterwards if
 * they care — which is already a command. Bulk build is therefore *simpler* than upstream's
 * single build rather than harder.
 */
function BuildOrder({
  state,
  locationId,
  buildable,
  chosen,
  order,
  onBaseType,
  onOrder,
  onBuild,
}: {
  readonly state: SimulationState;
  readonly locationId: string;
  readonly buildable: readonly BaseType[];
  readonly chosen: BaseType | null;
  readonly order: number;
  readonly onBaseType: (id: string) => void;
  readonly onOrder: (order: number) => void;
  readonly onBuild: () => void;
}): JSX.Element {
  if (!chosen) {
    return (
      <section class="inspector__build" aria-label="Build">
        <p class="inspector__empty">Nothing can be built here yet.</p>
      </section>
    );
  }

  const projection = buildProjection(state, locationId, chosen, order);
  const flow = orderFlow(state, locationId, chosen, order);
  return (
    <section class="inspector__build" aria-label="Build">
      <label class="inspector__field">
        <span>Base type</span>
        <select
          aria-label="Base type"
          value={chosen.id}
          onChange={(event) => onBaseType(event.currentTarget.value)}
        >
          {buildable.map((spec) => (
            <option key={spec.id} value={spec.id}>
              {plainLabel(spec.name)}
            </option>
          ))}
        </select>
      </label>
      {/*
        What the chosen type IS, before it is ordered — upstream's New Base dialog prose
        (`BaseSpec.get_info`, `base.py:131-179`), minus the cash and CPU figures the
        projections below already carry: the forced computer or the room for chosen ones,
        the labor time, the chances of being found, and the type's own words. Secondary by
        design — the select answers "which", this block answers "what am I choosing".
      */}
      <div class="inspector__type-info">
        {chosen.forceCpu != null && (
          <p>
            Computer: {plainLabel(content.items.byId.get(chosen.forceCpu)?.name ?? chosen.forceCpu)}
          </p>
        )}
        {chosen.forceCpu == null &&
          chosen.size > 1 && (
            // Upstream's sentence exactly (`base.py:151`) — player-visible text.
            <p>Has space for {chosen.size} computers.</p>
          )}
        <p>Build time: {toTime(projection.constructionTime)}</p>
        <DetectionTable state={state} chances={specDetectChance(state, locationId, chosen)} />
        <p class="inspector__type-description">{chosen.description}</p>
      </div>
      {/*
        A slider rather than a free-text field: the research sheet's control for
        the same kind of decision, so the shell offers one way to choose a quantity. The
        readout beside it is the figure the slider means; the steppers and their hotkeys are
        the fine adjustment.
      */}
      <div class="inspector__dial">
        <button
          type="button"
          aria-label="Fewer bases"
          {...shortcutKey(ESTATE_HOTKEYS.fewer)}
          aria-disabled={order <= 1 ? "true" : undefined}
          onClick={() => onOrder(Math.max(order - 1, 1))}
        >
          −
        </button>
        <input
          type="range"
          class="inspector__slide"
          min="1"
          max={MAX_ORDER}
          step="1"
          aria-label="Quantity"
          value={order}
          style={`--slide: ${((order - 1) / (MAX_ORDER - 1)) * 100}%`}
          onInput={(event) => onOrder(Number(event.currentTarget.value))}
        />
        <output aria-label="Quantity readout" aria-live="off">
          {order}
        </output>
        <button
          type="button"
          aria-label="More bases"
          {...shortcutKey(ESTATE_HOTKEYS.more)}
          aria-disabled={order >= MAX_ORDER ? "true" : undefined}
          onClick={() => onOrder(Math.min(order + 1, MAX_ORDER))}
        >
          +
        </button>
      </div>
      {/*
        Six figures, and they answer three different questions: what the order draws while it
        is being built, what it costs to keep once it stands, and where the estate's day ends
        up with it in the queue. They were one flat grid of six equal cells, which is the
        arrangement that says "these are six of the same thing" — so the player read six
        numbers and did the grouping in their head.

        Three named pairs, and the last one is the answer rather than a peer: the first two
        say what this costs, the third says whether the estate can carry it, and that is the
        decision the dial is actually for (`estate.ts`, `orderFlow`).
      */}
      <div class="inspector__projections">
        <section class="inspector__projection-group">
          <h2>While it is built</h2>
          <dl class="inspector__projection">
            <Projected label="Cash" name="Projected construction cash">
              {toMoney(projection.constructionCash)}
            </Projected>
            <Projected label="CPU" name="Projected construction CPU">
              {toCpu(projection.constructionCpu)}
            </Projected>
          </dl>
        </section>
        <section class="inspector__projection-group">
          <h2>Every day after</h2>
          <dl class="inspector__projection">
            <Projected label="Cash" name="Projected maintenance cash">
              {toMoney(projection.maintenanceCash)}
            </Projected>
            <Projected label="CPU" name="Projected maintenance CPU">
              {toMoney(projection.maintenanceCpu)}
            </Projected>
          </dl>
        </section>
        <section class="inspector__projection-group inspector__projection-group--answer">
          <h2>Your day, with this ordered</h2>
          <dl class="inspector__projection">
            <Projected label="Cash flow" name="Projected cash flow">
              {toMoney(flow.cash.difference)}
            </Projected>
            <Projected label="CPU spare" name="Projected CPU spare">
              {toMoney(flow.cpu.difference)}
            </Projected>
          </dl>
        </section>
      </div>
      <button
        type="button"
        class="inspector__order"
        aria-label="Build bases"
        {...shortcutKey(ESTATE_HOTKEYS.build)}
        onClick={() => onBuild()}
      >
        Build {order} × {plainLabel(chosen.name)}
        <Hotkey of={ESTATE_HOTKEYS.build} />
      </button>
    </section>
  );
}

function Projected({
  label,
  name,
  children,
}: {
  readonly label: string;
  readonly name: string;
  readonly children: JSX.Element | string;
}): JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <output aria-label={name} aria-live="off">
          {children}
        </output>
      </dd>
    </div>
  );
}

/**
 * Per-group detection chances on the danger ramp — `detect_chance_to_danger_level`'s cut,
 * the shared tokens, and the level's word printed beside the figure, because colour never
 * carries alone. One table for the two surfaces that ask the question: the base
 * detail about a standing base, and the build section about a type being considered.
 */
function DetectionTable({
  state,
  chances,
}: {
  readonly state: SimulationState;
  readonly chances: ReadonlyMap<string, number>;
}): JSX.Element {
  return (
    <table class="inspector__detection">
      <caption>Detection chance</caption>
      <tbody>
        {state.groups.map((group) => {
          const chance = chances.get(group.specId) ?? 0;
          const level = detectChanceToDangerLevel(chance);
          return (
            <tr key={group.specId}>
              <th scope="row">
                {plainLabel(content.groups.byId.get(group.specId)?.name ?? group.specId)}
              </th>
              <td class="inspector__chance" data-level={level}>
                {toPercent(chance)}
                <span class="inspector__chance-word">{LEVEL_WORDS[level]}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * One base, and what the player may do to it.
 *
 * It is handed the base's **index** as well as the base, because that is how a Command
 * addresses one (`sim/src/command.ts`) — the base object itself has no identity the
 * Simulation would recognise. The index and `onCommand` are the whole of the plumbing, and
 * they are deliberately not item-specific: every per-base affordance takes the same two.
 */
function BaseDetail({
  state,
  location,
  baseIndex,
  base,
  onCommand,
}: {
  readonly state: SimulationState;
  readonly location: LocationState;
  /** The base's position in its location's list — how a Command addresses it. */
  readonly baseIndex: number;
  readonly base: BaseState;
  readonly onCommand?: (command: Command) => void;
}): JSX.Element {
  const spec = content.bases.byId.get(base.specId);
  const chances = detectChance(state, base, location.specId);
  return (
    <section class="inspector__base" aria-label={base.name}>
      <h2>{base.name}</h2>
      {/*
        The power state is a readout rather than plain text, because the button that changes
        it no longer says where it is going (`PowerSwitch`): the press has to be
        answered somewhere, and this is the line that already carried the state.
      */}
      <p class="inspector__type">
        {plainLabel(spec?.name ?? base.specId)} ·{" "}
        <output aria-label="Power state" aria-live="polite">
          {base.powerState}
        </output>
      </p>
      {/*
        Detection first: whether this base is about to be found is the question the detail
        is opened for, so it does not sit under the slots any more. Each value
        wears the danger ramp — `detect_chance_to_danger_level`'s cut, the shared tokens —
        and the level's word is printed beside it, because colour never carries alone.
      */}
      <DetectionTable state={state} chances={chances} />
      <PowerSwitch
        locationId={location.specId}
        baseIndex={baseIndex}
        base={base}
        {...(onCommand && { onCommand })}
      />
      {/*
        Keyed on the base's identity, so the field belongs to the base it was filled from:
        the detail is re-rendered with another base's props by the Prev/Next cycle above
        rather than remounted, and a draft that outlived that would point at a base the
        player never typed it for. The key comes from the location's whole list, because two
        bases the player named alike separate only by their place in it (`baseKeys`).
      */}
      <RenameBase
        key={baseKeys(location.bases)[baseIndex]}
        locationId={location.specId}
        baseIndex={baseIndex}
        base={base}
        {...(onCommand && { onCommand })}
      />
      <dl class="inspector__numbers">
        <div>
          <dt>CPU</dt>
          <dd>{toMoney(base.cpu)}</dd>
        </div>
        <div>
          <dt>Cash / day</dt>
          <dd>{toMoney(base.maintenance[0])}</dd>
        </div>
        <div>
          <dt>CPU / day</dt>
          <dd>{toMoney(base.maintenance[1])}</dd>
        </div>
      </dl>
      {/*
        A base whose spec forces its computer holds no player-chosen items at all, so its
        three extra slots are not "Empty" — they do not exist for the player. One sentence
        in the AI's own voice says so, and only the forced computer's cell remains.
      */}
      <ul class="inspector__slots" aria-label={`${base.name} item slots`}>
        {Object.entries(base.items)
          .filter(([slot]) => spec?.forceCpu == null || slot === "cpu")
          .map(([slot, item]) => (
            <li key={slot}>
              <span>{slot}</span>
              <strong>
                {item
                  ? plainLabel(content.items.byId.get(item.specId)?.name ?? item.specId)
                  : "Empty"}
              </strong>
              {/* Upstream's per-pane build line while the item is under construction
                  (screens/base.py:620-628) — without it a just-bought item looks
                  finished. */}
              {item && !item.buyable.done && (
                <span class="inspector__slot-build">
                  Completion in {toTime(item.buyable.costLeft[LABOR])}.
                </span>
              )}
            </li>
          ))}
      </ul>
      {spec?.forceCpu != null && (
        <p class="inspector__fixed">This base's hardware is fixed; I cannot refit it.</p>
      )}
      {/* A base whose spec forces its computer holds no player-chosen items at all —
          upstream hides every CHANGE button on it (screens/base.py:607) — and upstream
          never opens an unfinished base at all (screens/location.py:322), so neither
          offers the install section.

          Unkeyed, unlike the rename field above: the dial it holds belongs to the base it was
          dialled on and a rename does not make that another base, but a base's identity holds
          the player's own name for it (`baseKeys`). So the base is held in the dial itself
          (`ItemOrder`) rather than being made this component's mounting. */}
      {spec?.forceCpu == null && base.buyable.done && (
        <ItemOrder
          state={state}
          locationId={location.specId}
          baseIndex={baseIndex}
          base={base}
          {...(onCommand && { onCommand })}
        />
      )}
    </section>
  );
}

/** Presentation's own text, for the base that has no second state to be switched into. */
const NO_OTHER_POWER_STATE = "This base stays offline until it and a computer in it are finished.";

/**
 * The power switch: **one button, named after what it does, not after where the base is**.
 *
 * `switchPower` carries no target (`sim/src/command.ts`) — the Simulation steps to the next
 * state the base can hold and wraps — so a control that let the player *pick* a state would
 * be describing a Command that does not exist. The button is that step, and nothing else.
 *
 * It used to be named after the state the step lands on, read off `switchPower(base)` itself:
 * `Switch to sleep`, then `Switch to active`. Truthful, and the wrong property to optimise
 * for. An accessible name that turns around with the state cannot be addressed by a driver
 * that does not already know the state — "click Switch to sleep" is a click that works on
 * every other press — and that is exactly what the stable-accessible-name rule is
 * against. Upstream names its own button for the control rather than the state
 * (`screens/location.py:99`, `&POWER STATE`), and this follows it.
 *
 * What the fixed name gives up is the sentence saying where the press lands. The state is
 * printed beside the button instead (`BaseDetail`), in a polite region, so the press is still
 * answered — and with two available states, naming the one the base is in names the other by
 * elimination.
 *
 * A base with one available state is offered nothing rather than a disabled button, because
 * every label such a button could carry names a state the base cannot hold —
 * `availablePowerStates` (`sim/src/base.ts`) is the whole of that rule. Upstream disables its
 * own POWER STATE button on the same condition (`screens/location.py:212`).
 */
function PowerSwitch({
  locationId,
  baseIndex,
  base,
  onCommand,
}: {
  readonly locationId: string;
  readonly baseIndex: number;
  readonly base: BaseState;
  readonly onCommand?: (command: Command) => void;
}): JSX.Element {
  if (availablePowerStates(base).length < 2) {
    // Off, and deliberately: this one is not an answer to anything the player did — it is part
    // of the detail as it opens, and reading in document order is where it belongs.
    return (
      <output class="inspector__refusal" aria-label="Power refusal" aria-live="off">
        {NO_OTHER_POWER_STATE}
      </output>
    );
  }
  return (
    <button
      type="button"
      class="inspector__power"
      onClick={() => onCommand?.({ command: "switchPower", location: locationId, base: baseIndex })}
    >
      Switch power state
    </button>
  );
}

/**
 * Renaming a standing base — the other half of "the simulation names the bases it creates":
 * a build command carries no name, so ordering twenty needs no name entry, and
 * the player names one afterwards if they care.
 *
 * It is upstream's own affordance reduced to what it is (`screens/location.py:341`): a text
 * entry prefilled with the base's current name, and one button. Upstream renames on
 * `if name:` and does nothing at all otherwise, so an empty field sends nothing and says
 * nothing — inventing a refusal here would be inventing player-visible text.
 *
 * A `<form>` rather than a bare field and button, because Enter in a name field is what the
 * player will press and the platform already does it.
 */
function RenameBase({
  locationId,
  baseIndex,
  base,
  onCommand,
}: {
  readonly locationId: string;
  readonly baseIndex: number;
  readonly base: BaseState;
  readonly onCommand?: (command: Command) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(base.name);
  const rename = (): void => {
    if (!draft) return;
    onCommand?.({ command: "renameBase", location: locationId, base: baseIndex, name: draft });
  };
  return (
    <form
      class="inspector__rename"
      onSubmit={(event) => {
        event.preventDefault();
        rename();
      }}
    >
      {/* The visible words are the accessible name, the way every other field on this
          surface is written ("Base type", "Item") — the label wraps the input, so there is
          nothing for an `aria-label` to add and it cannot drift from what is on the screen. */}
      <label class="inspector__field">
        <span>Base name</span>
        <input type="text" value={draft} onInput={(event) => setDraft(event.currentTarget.value)} />
      </label>
      <button type="submit" aria-disabled={draft ? undefined : "true"}>
        Rename base
      </button>
    </form>
  );
}

/** A slot as the player reads it: the item type's own text, hotkey marker stripped. */
function slotLabel(slot: string): string {
  return plainLabel(content.itemTypes.byId.get(slot)?.text ?? slot);
}

/**
 * Buying an item into one of the base's four slots, and replacing the one that is there.
 *
 * **One control for all four**, where upstream opens a dialog per slot: the slot is the
 * item's own (`slotOf`), so picking a reactor *is* picking the reactor slot and a second
 * choice would only be a way to pick the wrong one. The options are grouped by slot, so the
 * list still reads as four.
 *
 * The quantity dial belongs to the CPU slot alone and appears only for it. The other three
 * hold exactly one, and the command carries no count for them at all — the Simulation
 * refuses one rather than reading it as one (`./estate.ts`, `buyItemOrder`).
 *
 * # Why it projects rather than confirms
 *
 * The same reason the build dial does not: an item costs nothing at the moment of the click
 * and is paid off over the ticks that install it, so there is no payment to approve.
 * Upstream's dialog does ask, and what it asks about is the computers going offline while
 * the new ones are installed — which is a consequence the projection states in numbers
 * instead, beside the day the HUD is already showing.
 */
function ItemOrder({
  state,
  locationId,
  baseIndex,
  base,
  onCommand,
}: {
  readonly state: SimulationState;
  readonly locationId: string;
  readonly baseIndex: number;
  readonly base: BaseState;
  readonly onCommand?: (command: Command) => void;
}): JSX.Element {
  const [itemId, setItemId] = useState<string | null>(null);
  /**
   * The dial, and the base and item it was dialled for. Held as the triple rather than as a
   * figure of its own because the reset belongs to what was dialled and not to any control's
   * event.
   *
   * The item, because `chosen` falls back to `offered[0]` while the player has chosen nothing,
   * and `offered` is sorted by cost, so a tech finishing mid-look puts another computer under a
   * dial no `onChange` ever fired for. The pair answers that route and the select's
   * alike.
   *
   * The base, because this detail is re-rendered with another base's props by the Prev/Next
   * cycle rather than remounted, so `Install 8 × PC` was read back on a base the player had
   * only just opened and asked nothing of. Held here rather than made the
   * component's mounting: a base's identity holds the player's own name for it (`baseKeys`),
   * and keying on that threw the dial away when the player renamed the base under it.
   */
  const [dialled, setDialled] = useState<{
    baseIndex: number;
    itemId: string;
    wanted: number;
  } | null>(null);

  const offered = buyableItems(state, locationId);
  const chosen = offered.find((spec) => spec.id === itemId) ?? offered[0] ?? null;
  if (!chosen) {
    return (
      <section class="inspector__build" aria-label="Install">
        <p class="inspector__empty">Nothing can be installed here yet.</p>
      </section>
    );
  }

  const stacks = slotOf(chosen) === "cpu";
  const room = roomFor(base, chosen);
  const wanted =
    dialled?.baseIndex === baseIndex && dialled.itemId === chosen.id ? dialled.wanted : 1;
  const setWanted = (next: number): void =>
    setDialled({ baseIndex, itemId: chosen.id, wanted: next });
  // Still clamped, because the room moves under a dial that is not touched: buy five PCs
  // and the room is three. The dial follows it down rather than sending a figure the base
  // cannot take. Another item is a new question and starts at one — see `dialled` above.
  const count = Math.min(Math.max(wanted, 1), Math.max(room, 1));
  const refusal = room < 1 ? noRoomRefusal(plainLabel(chosen.name)) : null;
  const projection = itemProjection(state, chosen, count);
  const install = (): void => {
    if (refusal) return;
    onCommand?.(buyItemOrder(locationId, baseIndex, chosen, count));
  };

  return (
    <section class="inspector__build" aria-label="Install">
      <label class="inspector__field">
        <span>Item</span>
        {/*
          Choosing another item puts the dial back to one, and nothing here has
          to do that: the count is held with the item it was dialled for (`dialled` above), so
          a new chosen item is a dial at one however it was chosen. A player who had just
          filled the base with eight PCs and then picked a Server was one press away from
          ordering eight Servers, having asked for none of them. The button did say
          `Install 8 × Server`, which is a label carrying a decision the player never made.
        */}
        <select
          aria-label="Item"
          value={chosen.id}
          onChange={(event) => setItemId(event.currentTarget.value)}
        >
          {ITEM_SLOTS.map((slot) => {
            const forSlot = offered.filter((spec) => slotOf(spec) === slot);
            return forSlot.length === 0 ? null : (
              // The Content's own word for the slot (`itemtypes_str.dat`), not the id the
              // Simulation keys on — every other string on this surface is a name the player
              // reads, and an `optgroup` label cannot be styled into one.
              <optgroup key={slot} label={slotLabel(slot)}>
                {forSlot.map((spec) => (
                  <option key={spec.id} value={spec.id}>
                    {plainLabel(spec.name)}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      </label>
      {/*
        What the chosen item IS, before it is ordered — the sibling of the build surface's
        base-type block: upstream's item info (`ItemSpec.get_info`, `item.py:133-141`, plus
        `get_quality_info`'s bonus lines) minus the cash and CPU figures the projections
        below already carry. Secondary by design.
      */}
      <div class="inspector__type-info">
        <p>Build time: {toTime(projection.constructionTime)}</p>
        {itemQualityLines(chosen).map((line) => (
          <p key={line}>{line}</p>
        ))}
        <p class="inspector__type-description">{chosen.description}</p>
      </div>
      {/*
        The slider's right end is the room the base has left for this computer, so "fill the
        base" is one gesture to the far stop rather than a press of + per machine
        — upstream's Auto-build fills with `space_left_for` the same way
        (`screens/base.py:439`).
      */}
      {stacks && (
        <div class="inspector__dial">
          <button
            type="button"
            aria-label="Fewer items"
            aria-disabled={count <= 1 ? "true" : undefined}
            onClick={() => setWanted(Math.max(count - 1, 1))}
          >
            −
          </button>
          <input
            type="range"
            class="inspector__slide"
            min="1"
            max={Math.max(room, 1)}
            step="1"
            aria-label="Item quantity"
            value={count}
            style={`--slide: ${((count - 1) / Math.max(room - 1, 1)) * 100}%`}
            onInput={(event) => setWanted(Number(event.currentTarget.value))}
          />
          <output aria-label="Item quantity readout" aria-live="off">
            {count}
          </output>
          <button
            type="button"
            aria-label="More items"
            aria-disabled={count >= room ? "true" : undefined}
            onClick={() => setWanted(Math.min(count + 1, Math.max(room, 1)))}
          >
            +
          </button>
        </div>
      )}
      <dl class="inspector__projection">
        <Projected label="Item cash" name="Projected item cash">
          {toMoney(projection.constructionCash)}
        </Projected>
        <Projected label="Item CPU" name="Projected item CPU">
          {toCpu(projection.constructionCpu)}
        </Projected>
        <Projected label="Cash flow / day" name="Projected item cash flow">
          {toMoney(projection.flow.cash.difference)}
        </Projected>
        <Projected label="CPU spare" name="Projected item CPU spare">
          {toMoney(projection.flow.cpu.difference)}
        </Projected>
      </dl>
      <button
        type="button"
        class="inspector__order"
        aria-label="Buy item"
        aria-disabled={refusal ? "true" : undefined}
        onClick={install}
      >
        Install {stacks ? `${count} × ` : ""}
        {plainLabel(chosen.name)}
      </button>
      {/* Standing and polite, like the destroy refusal above: it arrives when the
          player picks an item the base has no room for, which is an answer to an action. */}
      <output class="inspector__refusal" aria-label="Install refusal" aria-live="polite">
        {refusal ?? ""}
      </output>
    </section>
  );
}
