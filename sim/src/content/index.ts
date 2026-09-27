/**
 * Content, resolved once.
 *
 * The Simulation owns its Content rather than being handed it: it does not change while a
 * game is played, it is fixed when the build is made, and there is nothing about it a Host
 * could legitimately vary. Resolving it at module load keeps the Simulation's entry points
 * free of a parameter that would only ever carry the same value.
 */

import { rawContent } from "./documents.ts";
import { loadContent } from "./load.ts";
import type { Content } from "./types.ts";

export const content: Content = loadContent(rawContent);
