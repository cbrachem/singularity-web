/**
 * Naming a base — `generate_base_name` (`screens/location.py:451`).
 *
 * Upstream files this in a screen module. It is **Simulation** all the same, identified by
 * role rather than by file location: it draws from the simulation RNG, and a
 * draw not made displaces every draw after it. So the port keeps it on this side of the
 * seam, a build Command carries no name, and the Host never names anything — which is also
 * what makes bulk build simpler here than upstream's single build rather than harder.
 *
 * Three or four draws per attempt, in this order: one `random` to choose between a
 * significant number and an arbitrary one, one for the number itself, one for the city, one
 * for the base type's flavour. The attempt repeats while the name is one the location
 * already holds, which is why the count is not a function of the call count.
 */

import { content } from "./content/index.ts";
import type { BaseType, Location } from "./content/types.ts";
import type { Rng } from "./rng/random.ts";

/** `random.random() < 0.3` — the chance of reaching for a significant number instead. */
const SIGNIFICANT_CHANCE = 0.3;

/** The arbitrary number's range, inclusive at both ends as `randint` is. */
const ARBITRARY_LOW = 0;
const ARBITRARY_HIGH = 32767;

/**
 * A name no base in `taken` already carries.
 *
 * Upstream's `attempts > 100` branch is not here, and it cannot be: the fallback it builds
 * is `city + " " + flavor + " " + number`, character for character the template it is
 * guarding against a translator having mangled, so in the port's untranslated Content the
 * two branches are the same string. Where they would differ — a location with no cities —
 * upstream raises a `TypeError` on `None + " "` rather than producing a different name, so
 * there is no behaviour to reproduce and nothing observable to record.
 */
export function generateBaseName(
  rng: Rng,
  location: Location,
  spec: BaseType,
  taken: ReadonlySet<string>,
): string {
  let name: string;
  do {
    const number =
      rng.random() < SIGNIFICANT_CHANCE
        ? String(rng.choice(content.numbers))
        : String(rng.randint(ARBITRARY_LOW, ARBITRARY_HIGH));
    const city = location.cities.length > 0 ? rng.choice(location.cities) : null;
    const flavor = spec.flavor.length > 0 ? rng.choice(spec.flavor) : spec.name;
    name = city === null ? `${flavor} ${number}` : `${city} ${flavor} ${number}`;
  } while (taken.has(name));
  return name;
}
