// boundary-intent harness: spawns a command and reads what it said
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { repoRoot } from "./support/scenario.ts";

// A checkout without its own `node_modules` does not fail cleanly: `vitest` resolves
// *upwards* into the main checkout, starts, and then dies in project setup naming
// `@preact/preset-vite` — a dependency of `app/`, so a symptom and not the cause — after
// writing its `node_modules/.vite-temp` scratch into the tree it borrowed from. `tsc -b`
// borrows the same tree and says nothing at all.
//
// `checkout-guard.ts` is the one line that replaces that. These are the tests that keep it
// wired to the gates it has to run in front of; the guard itself is exercised as the
// command the gates run, against a directory that is and is not installed.

const GUARD = "checkout-guard.ts";
const guardPath = resolve(repoRoot, GUARD);

const temporaries: string[] = [];

afterAll(() => {
  for (const directory of temporaries) rmSync(directory, { recursive: true, force: true });
});

function aCheckout(options: { installed: boolean }): string {
  const directory = mkdtempSync(join(tmpdir(), "checkout-guard-"));
  temporaries.push(directory);
  if (options.installed) mkdirSync(join(directory, "node_modules"));
  return directory;
}

function runGuardIn(directory: string) {
  const done = spawnSync("bun", ["run", guardPath], { cwd: directory, encoding: "utf8" });
  if (done.error) throw done.error;
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
}

describe("the checkout guard", () => {
  it("names the cause, the fix and the checkout, in one line", () => {
    const directory = aCheckout({ installed: false });

    const { status, stderr } = runGuardIn(directory);

    expect(status).toBe(1);
    expect(stderr.trim().split("\n")).toHaveLength(1);
    expect(stderr).toContain(directory);
    expect(stderr).toContain("no node_modules here");
    expect(stderr).toContain("bun install");
  });

  it("says nothing at all when the checkout is installed", () => {
    const { status, stdout, stderr } = runGuardIn(aCheckout({ installed: true }));

    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });
});

describe("the gates the guard runs in front of", () => {
  const scripts = (
    JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;

  // Every gate that would otherwise reach into the borrowed tree: `vitest` and `vite` write
  // into it, `tsc -b` reads it. The guard runs before the tool is even started, so nothing
  // of this checkout's is left in another one.
  it.each(["test", "typecheck", "build"])("runs the guard before `bun run %s`", (gate) => {
    expect(scripts[gate]).toBeDefined();
    expect(scripts[`pre${gate}`]).toBe(`bun run ${GUARD}`);
  });

  // The pre-scripts only fire through `bun run`. The root config is what a bare `vitest`
  // loads first, so the same guard sits there too — and before `projects`, because
  // resolving those is what loads `app/vite.config.ts` and produces the misleading error.
  it("runs the guard from the root vitest config, before the projects are resolved", () => {
    const config = readFileSync(resolve(repoRoot, "vitest.config.ts"), "utf8");

    expect(config).toContain(`from "./${GUARD}"`);
    expect(config.indexOf("requireInstall(")).toBeGreaterThan(-1);
    expect(config.indexOf("requireInstall(")).toBeLessThan(config.indexOf("defineConfig("));
  });
});
