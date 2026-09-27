import { describe, expect, it } from "vitest";

import {
  TRANSFER_BUDGET_BYTES,
  collectInitialTransfer,
  formatReport,
  measureTransfer,
} from "../scripts/transfer-budget.ts";

const HTML = [
  "<!doctype html>",
  '<html><head><meta charset="utf-8" />',
  '<script type="module" crossorigin src="/assets/index-abc.js"></script>',
  '<link rel="modulepreload" crossorigin href="/assets/vendor-def.js" />',
  '<link rel="stylesheet" crossorigin href="/assets/index-ghi.css" />',
  '<link rel="icon" href="https://example.invalid/icon.png" />',
  '</head><body><div id="app"></div></body></html>',
].join("\n");

describe("the initial transfer", () => {
  it("counts the entry module, its preloads and the stylesheets", () => {
    expect(collectInitialTransfer(HTML)).toEqual([
      "assets/index-abc.js",
      "assets/vendor-def.js",
      "assets/index-ghi.css",
    ]);
  });

  // A `<link>` says what it is for in its `rel`, and most of what a document links is not
  // fetched before first paint — an icon is fetched after it, a `preconnect` is not a fetch
  // at all, a manifest waits for an install prompt. Counting them would spend the budget on
  // bytes the first paint never waits for, and would make an off-budget decision (a second
  // icon size) read as a regression in it.
  it("counts a link by what its rel says the browser does with it", () => {
    const linked = (rel: string): string[] =>
      collectInitialTransfer(`<link rel="${rel}" href="/assets/thing.css" />`);

    for (const rel of ["stylesheet", "modulepreload", "preload", "STYLESHEET"]) {
      expect(linked(rel)).toEqual(["assets/thing.css"]);
    }
    for (const rel of [
      "icon",
      "apple-touch-icon",
      "preconnect",
      "dns-prefetch",
      "prefetch",
      "manifest",
    ]) {
      expect(linked(rel)).toEqual([]);
    }

    // A rel is a token list, and a link without one asks the browser for nothing.
    expect(linked("preload stylesheet")).toEqual(["assets/thing.css"]);
    expect(collectInitialTransfer('<link href="/assets/thing.css" />')).toEqual([]);
  });

  it("counts a same-origin icon no more than an off-origin one", () => {
    const withIcon = `${HTML}\n<link rel="icon" href="/favicon-32.png" />`;

    expect(collectInitialTransfer(withIcon)).toEqual(collectInitialTransfer(HTML));
  });

  it("counts each reference once, and nothing off-origin", () => {
    const twice = `${HTML}\n<script type="module" src="/assets/index-abc.js"></script>`;

    expect(collectInitialTransfer(twice)).toHaveLength(3);
    expect(collectInitialTransfer(twice).some((path) => path.includes("example.invalid"))).toBe(
      false,
    );
  });

  it("is 1 MB, and the check fails above it", () => {
    expect(TRANSFER_BUDGET_BYTES).toBe(1024 * 1024);

    // Pseudorandom, so brotli cannot talk it back under the budget.
    const noise = Buffer.alloc(64 * 1024);
    let seed = 1;
    for (let i = 0; i < noise.length; i += 1) {
      seed = (Math.imul(seed, 1103515245) + 12345) | 0;
      noise[i] = (seed >>> 16) & 0xff;
    }

    const read = (path: string): Buffer =>
      path.endsWith("index.html") ? Buffer.from(HTML, "utf8") : noise;

    const report = measureTransfer("dist", read, 1024);

    expect(report.total).toBeGreaterThan(1024);
    expect(report.withinBudget).toBe(false);
  });

  it("passes a build that fits", () => {
    const read = (path: string): Buffer =>
      path.endsWith("index.html") ? Buffer.from(HTML, "utf8") : Buffer.from("const a = 1;\n");

    const report = measureTransfer("dist", read);

    expect(report.entries.map((entry) => entry.path)).toEqual([
      "index.html",
      "assets/index-abc.js",
      "assets/vendor-def.js",
      "assets/index-ghi.css",
    ]);
    expect(report.withinBudget).toBe(true);
    expect(report.missing).toEqual([]);
  });

  // A reference the build has no file for is a broken first paint, and the gate's job is to
  // say so. Throwing says it as a stack trace out of `readFileSync`, which reads as the gate
  // being broken rather than the build — and it takes the byte count with it, so the one
  // number the gate exists to report is lost to the smaller finding.
  it("reports a reference with no file behind it, and still counts the rest", () => {
    const read = (path: string): Buffer => {
      if (path.endsWith("index.html")) return Buffer.from(HTML, "utf8");
      if (path.endsWith("vendor-def.js")) throw new Error("ENOENT: no such file or directory");
      return Buffer.from("const a = 1;\n");
    };

    const report = measureTransfer("dist", read);

    expect(report.missing).toEqual(["assets/vendor-def.js"]);
    expect(report.entries.map((entry) => entry.path)).toEqual([
      "index.html",
      "assets/index-abc.js",
      "assets/vendor-def.js",
      "assets/index-ghi.css",
    ]);
    expect(report.entries.find((entry) => entry.missing)?.compressed).toBe(0);
    expect(report.total).toBeGreaterThan(0);
    expect(formatReport(report)).toContain("not in the build");
  });
});
