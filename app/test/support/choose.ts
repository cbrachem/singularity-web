import { fireEvent, screen } from "@testing-library/preact";

/**
 * Picking an option on a named select, the way a player does — and refusing a value the
 * select does not offer.
 *
 * `fireEvent.change` with a value no option carries changes nothing at all: the select keeps
 * whatever it had, the event never reaches the handler, and the test reads on as if it had
 * chosen. `base-power.test.tsx` asked for a "Warehouse" base type for a long time and
 * drove a "Server Access" one instead. A driver that quietly does nothing is a
 * test that can pass while steering nothing, so this one throws instead.
 */
export function choose(field: string, value: string): void {
  const select = screen.getByRole("combobox", { name: field }) as HTMLSelectElement;
  const offered = [...select.options].map((option) => option.value);
  if (!offered.includes(value)) {
    throw new Error(`the ${field} select offers no "${value}" — it offers ${offered.join(", ")}`);
  }
  fireEvent.change(select, { target: { value } });
}
