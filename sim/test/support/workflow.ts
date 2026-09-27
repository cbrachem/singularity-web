// boundary-intent harness: reads the CI workflow
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { repoRoot } from "./scenario.ts";

/**
 * Just enough of the CI workflow to assert on it.
 *
 * What is asserted is the steps `bun run test` cannot reach: the two asset generators, the
 * Oracle's required-environment switch, and the post-build checks. Every other gate is a test
 * in the suite and needs no step of its own to be held in place.
 *
 * GitHub Actions YAML is a general format; what is read here is the subset this repository
 * actually writes — two-space indentation, one block scalar per `run:`, a flat `env:` map.
 * The point is a self-check that goes red when an edit turns a gate off, not a YAML
 * implementation, so anything outside that subset is ignored rather than guessed at.
 */

export const WORKFLOW_PATH = ".github/workflows/ci.yml";

export interface WorkflowStep {
  readonly name: string | undefined;
  readonly id: string | undefined;
  readonly uses: string | undefined;
  /** The step's shell body, dedented; empty for a `uses:` step. */
  readonly run: string;
  readonly env: Readonly<Record<string, string>>;
}

export function packageScripts(): Readonly<Record<string, string>> {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  return manifest.scripts;
}

export function readWorkflow(): string {
  return readFileSync(resolve(repoRoot, WORKFLOW_PATH), "utf8");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The lines nested under a header line, up to the first one that dedents back out. */
function nested(lines: readonly string[], start: number, indent: number): string[] {
  const out: string[] = [];
  for (const line of lines.slice(start)) {
    if (line.trim() === "") {
      out.push(line);
      continue;
    }
    if (indentOf(line) <= indent) break;
    out.push(line);
  }
  return out;
}

function childrenOf(lines: readonly string[], header: RegExp): string[] {
  const index = lines.findIndex((line) => header.test(line));
  const found = index === -1 ? undefined : lines[index];
  return found === undefined ? [] : nested(lines, index + 1, indentOf(found));
}

function unquote(raw: string): string {
  const value = raw.trim();
  const quote = value.charAt(0);
  const quoted = (quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote);
  return quoted ? value.slice(1, -1) : value;
}

const KEY = /^([A-Za-z_][\w-]*):\s?(.*)$/;

function parseStep(group: readonly string[]): WorkflowStep {
  // The leading `- ` is list syntax; blanking it puts the first key on the others' indent.
  const lines = group.map((line, index) => (index === 0 ? line.replace("- ", "  ") : line));
  const keyIndent = indentOf(lines[0] ?? "");
  const fields = new Map<string, string>();
  const env: Record<string, string> = {};

  for (const [index, line] of lines.entries()) {
    if (line.trim() === "" || indentOf(line) !== keyIndent) continue;
    const key = KEY.exec(line.trim());
    if (!key) continue;
    const [, name = "", value = ""] = key;

    if (name === "env") {
      for (const entry of nested(lines, index + 1, keyIndent)) {
        const [, envName, envValue = ""] = KEY.exec(entry.trim()) ?? [];
        if (envName !== undefined) env[envName] = unquote(envValue);
      }
    } else if (value === "|" || value === ">") {
      const body = nested(lines, index + 1, keyIndent).filter((entry) => entry.trim() !== "");
      const strip = Math.min(...body.map(indentOf));
      fields.set(name, body.map((entry) => entry.slice(strip)).join("\n"));
    } else {
      fields.set(name, unquote(value));
    }
  }

  return {
    name: fields.get("name"),
    id: fields.get("id"),
    uses: fields.get("uses"),
    run: fields.get("run") ?? "",
    env,
  };
}

/** The steps of one job, in order. */
export function jobSteps(source: string, job: string): WorkflowStep[] {
  const lines = source.split("\n");
  const jobs = childrenOf(lines, /^jobs:\s*$/);
  const theJob = childrenOf(jobs, new RegExp(`^\\s+${job}:\\s*$`));
  const stepLines = childrenOf(theJob, /^\s+steps:\s*$/);

  const dash = /^\s*-\s/;
  const first = stepLines.find((line) => dash.test(line));
  if (first === undefined) return [];
  const dashIndent = indentOf(first);

  const groups: string[][] = [];
  for (const line of stepLines) {
    if (dash.test(line) && indentOf(line) === dashIndent) groups.push([line]);
    else groups.at(-1)?.push(line);
  }
  return groups.map(parseStep);
}
