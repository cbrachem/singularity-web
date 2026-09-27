// boundary-intent harness: spawns a command and reads what it said
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { repoRoot } from "./support/scenario.ts";

// `bun` is the script runner here and `vitest` is the test runner, so `bun test`
// — bun's own runner, one word away from `bun run test` — collects the Vitest files and
// runs them without Vitest: no `vitest` globals, no `happy-dom`, no Vite resolution, so
// `app/test/app.test.tsx` dies on `react/jsx-dev-runtime`. A CI job or a new terminal that
// types the short form gets a red suite that says nothing about the mistake in it.
//
// The guard is a preload: it runs before bun collects a single file, says which command to
// use, and exits. A wrong command that answers with the right one costs nothing to run into.

const GUARD = "bun-test-guard.ts";

// Bun colours its output when it is spawned rather than typed, and a colour reset on its own
// line survives `trim()`. Counting those as things bun said makes the count depend on whether
// the spawning process looked like a terminal, which is not what this test is about.
const ANSI = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");

function plain(text: string): string {
  return text.replace(ANSI, "");
}

function runBunTest() {
  const done = spawnSync("bun", ["test"], { cwd: repoRoot, encoding: "utf8", timeout: 60_000 });
  if (done.error) throw done.error;
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
}

describe("`bun test` at the repository root", () => {
  it("fails, naming the command that does run the suite", () => {
    const { status, stderr } = runBunTest();

    expect(status).toBe(1);
    expect(stderr).toContain("bun run test");
    expect(stderr).toContain("bun test");
  });

  it("stops before it runs a test, so the message is the last word on it", () => {
    const { stdout, stderr } = runBunTest();
    const said = plain(stderr)
      .split("\n")
      .filter((line) => line.trim() !== "");

    // Bun names the file it was about to run; the complaint is the line after it, and there
    // is no third — no assertion ran, and nothing reached the module error that a collected
    // `app/test` file dies on.
    expect(said.at(-1)).toContain("bun run test");
    expect(said.length).toBeLessThanOrEqual(2);
    expect(stderr).not.toContain("react/jsx-dev-runtime");
    expect(stdout).not.toContain("expect() calls");
  });

  it("is wired as a preload, which is what makes it run before collection", () => {
    const config = readFileSync(resolve(repoRoot, "bunfig.toml"), "utf8");

    expect(config).toMatch(/^\[test\]$/m);
    expect(config).toContain(`preload = ["./${GUARD}"]`);
  });
});
