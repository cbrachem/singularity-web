import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ruff, the one formatter and linter for the Python under `tools/`. It formats and
 * lints in a single binary, so the gate is one tool rather than the two the TypeScript side
 * needs.
 *
 * It is installed from `tools/requirements.txt` and invoked through that environment's own
 * interpreter as `python -m ruff`, so the gate provably runs the installation the reference
 * harness runs, without a second path to keep pointed at it.
 */

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The shared environment lives at the main checkout's `.venv/` and is not per checkout, so a
 * worktree finds it a level or two up. The same contract as the Oracle's
 * (`sim/test/support/oracle.ts`): `SINGULARITY_PYTHON` wins, and CI points it at the
 * interpreter the workflow provisioned.
 */
function findInterpreter(): string | undefined {
  const fromEnvironment = process.env.SINGULARITY_PYTHON;
  if (fromEnvironment) return existsSync(fromEnvironment) ? fromEnvironment : undefined;

  let directory = repoRoot;
  for (let level = 0; level < 4; level += 1) {
    const candidate = resolve(directory, ".venv/bin/python");
    if (existsSync(candidate) && existsSync(resolve(directory, "tools/requirements.txt"))) {
      return candidate;
    }
    const parent = resolve(directory, "..");
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

const interpreter = findInterpreter();

/** Whether this checkout has a Python environment to lint from at all. */
export const ruffAvailable = interpreter !== undefined;

/**
 * Where the Python environment is *required*, its absence is a failure rather than a reason
 * to skip — the same switch the Oracle uses, because it is the same environment. CI sets it,
 * so the gate can never quietly stop running there.
 */
export const ruffRequired = process.env.SINGULARITY_ORACLE_REQUIRED === "1";

export interface RuffResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Everything under `tools/`, linted. */
export const LINT_ARGUMENTS = ["check", "--color", "never", "tools"] as const;

/** Everything under `tools/`, checked against the formatter rather than rewritten. */
export const FORMAT_ARGUMENTS = ["format", "--check", "--color", "never", "tools"] as const;

/** The files ruff would take, one per line — the gate's own reach, read back. */
export const REACH_ARGUMENTS = ["check", "--color", "never", "--show-files", "tools"] as const;

export function runRuff(args: readonly string[]): RuffResult {
  if (!interpreter) {
    throw new Error(
      "the Python environment is missing. Create it with:\n" +
        "  python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt",
    );
  }
  try {
    const stdout = execFileSync(interpreter, ["-m", "ruff", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      // `--color never` as well as the variable: ruff colours a failing run through NO_COLOR
      // alone, and the gate's output is what a reader takes the fix from.
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    if (failure.status === undefined) throw error;
    return { status: failure.status, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** What ruff said, when what it said is the failure worth reading. */
export function complaint(result: RuffResult): string {
  return result.status === 0 ? "" : `${result.stdout}${result.stderr}`.trim();
}
