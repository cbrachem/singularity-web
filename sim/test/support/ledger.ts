// boundary-intent harness: what a run compared, written where a check after the run reads it
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The comparison ledger: one line per Trace comparison a run actually made.
 *
 * The claim it exists for is about a run — the fidelity gate compares the Scenario that uses
 * every Command — and no rule over the suites' source can make it. A suite that keeps an id at
 * module scope and compares a different Scenario reads as covered; one that builds the id from
 * parts reads as covering nothing. So the comparison says its own name instead:
 * `compareTraces` writes the Scenario it drove, and the check runs the gate and reads back what
 * came out of it.
 *
 * Off unless a reader asked for it. `LEDGER_VARIABLE` names a directory in the environment;
 * without one nothing is written, so an ordinary run pays nothing and leaves nothing behind.
 *
 * One file per process, named after the pid, because the suites run in parallel workers and
 * appends from several of them to one file may interleave. The reader takes the union.
 */

export const LEDGER_VARIABLE = "SINGULARITY_COMPARISON_LEDGER";

export const LEDGER_SUFFIX = ".jsonl";

export interface ComparisonEntry {
  /** The id of the Scenario the comparison drove. */
  readonly scenario: string;
}

/** Write one entry into the named ledger, creating it if this is the first. */
export function writeComparison(directory: string, entry: ComparisonEntry): void {
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `${process.pid}${LEDGER_SUFFIX}`);
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

/** Write one entry, if this run was asked to keep a ledger at all. */
export function recordComparison(entry: ComparisonEntry): void {
  const directory = process.env[LEDGER_VARIABLE];
  if (directory) writeComparison(directory, entry);
}

/**
 * Every entry in a ledger, in no particular order.
 *
 * A directory that is not there is a run that compared nothing, not an error: the reader is
 * always used by a check that says what an empty ledger means.
 */
export function readLedger(directory: string): readonly ComparisonEntry[] {
  let files: readonly string[];
  try {
    files = readdirSync(directory).filter((name) => name.endsWith(LEDGER_SUFFIX));
  } catch {
    return [];
  }

  return files.flatMap((name) => {
    const path = resolve(directory, name);
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line, index) => {
        try {
          return JSON.parse(line) as ComparisonEntry;
        } catch {
          throw new Error(`${path}: line ${index + 1} is not a ledger entry: ${line}`);
        }
      });
  });
}

/** The Scenarios a run compared, without repeats, sorted. */
export function comparedScenarios(directory: string): readonly string[] {
  return [...new Set(readLedger(directory).map((entry) => entry.scenario))].sort();
}
