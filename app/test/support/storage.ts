import type { SaveStorage } from "../../src/host/save-store.ts";

export interface FakeStorage extends SaveStorage {
  /** Every key, in insertion order — what `list()` is built from. */
  keys(): readonly string[];
}

/**
 * `localStorage` with the test holding the quota.
 *
 * The quota is the part that has to be a fake rather than the real thing: a browser's is
 * megabytes and refusing at it would mean building a save that large, whereas the behaviour
 * under test is one line — `setItem` throws, as a whole, and what was under the key is still
 * there afterwards.
 */
export function fakeStorage({ quota = Number.POSITIVE_INFINITY } = {}): FakeStorage {
  const entries = new Map<string, string>();
  const used = (without: string): number => {
    let total = 0;
    for (const [key, value] of entries) if (key !== without) total += key.length + value.length;
    return total;
  };

  return {
    get length() {
      return entries.size;
    },
    key(index) {
      return [...entries.keys()][index] ?? null;
    },
    getItem(key) {
      return entries.get(key) ?? null;
    },
    setItem(key, value) {
      if (used(key) + key.length + value.length > quota) {
        // The browser's own name for it, so a caller that matches on it matches on the
        // real thing too.
        const error = new Error(`QuotaExceededError: ${key} does not fit`);
        error.name = "QuotaExceededError";
        throw error;
      }
      entries.set(key, value);
    },
    removeItem(key) {
      entries.delete(key);
    },
    keys() {
      return [...entries.keys()];
    },
  };
}
