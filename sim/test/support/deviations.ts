// boundary-intent harness: the Deviation register, as data
/**
 * The Deviation register: every place where the port knowingly departs from the reference.
 *
 * It lives here as data so that the rule it carries — exactly one Normalisation per entry,
 * and a Normalisation without an entry refused — is enforced by a program rather than by
 * attention.
 */

export interface Deviation {
  /** Its number in the register, which is how a Normalisation names the entry it cancels. */
  readonly id: number;
  /** The entry's own opening sentence. */
  readonly title: string;
}

export const DEVIATION_REGISTER: readonly Deviation[] = [
  { id: 1, title: "Midnight overshoot is carried forward rather than discarded." },
  { id: 2, title: "The RNG is seeded and injectable." },
  { id: 3, title: "The autosave snapshot is taken at end of tick, not mid-tick." },
  { id: 4, title: "Saves carry the generator state; upstream's do not." },
  { id: 5, title: "An allocation is clamped to the CPU that exists." },
];

export function deviation(id: number): Deviation {
  const found = DEVIATION_REGISTER.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(
      `there is no deviation ${id} in the register. A Normalisation without a register entry ` +
        `is forbidden: add the entry to DEVIATION_REGISTER first, or drop the Normalisation.`,
    );
  }
  return found;
}
