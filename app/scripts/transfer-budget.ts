import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

/**
 * The startup budget is **1 MB compressed for the initial transfer**, checked in CI as a byte
 * count. This is that check.
 *
 * "Initial transfer" is the document plus everything the document itself asks the browser to
 * fetch before first paint: the entry module, its preloaded chunks, and the stylesheets.
 * Anything loaded later — a lazy chunk, a font a stylesheet references — is out of it by
 * construction, so the gate measures what the first paint costs and not what the build weighs.
 */
export const TRANSFER_BUDGET_BYTES = 1024 * 1024;

/**
 * The `rel` values whose fetch the first paint waits for. A `<link>` is not a request on its
 * own — its `rel` says what the browser does with it — and most of what a document links is
 * fetched after first paint or not fetched at all: an icon, a manifest, a `prefetch` for the
 * next navigation, a `preconnect` that opens a socket and asks for no bytes. Counting those
 * would spend a budget the first paint never waits for, and would turn an off-budget
 * decision, a second icon size, into a regression in it.
 */
const FIRST_PAINT_RELS: readonly string[] = ["stylesheet", "modulepreload", "preload"];

const TAG = /<(script|link)\b([^>]*)>/gi;
const ATTRIBUTE = /([A-Za-z_:][-\w:.]*)\s*=\s*["']([^"']*)["']/g;

function attributesOf(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of tag.matchAll(ATTRIBUTE)) {
    found.set((match[1] as string).toLowerCase(), match[2] as string);
  }
  return found;
}

/** What one tag asks the browser to fetch before first paint, if anything. */
function fetchedBy(name: string, attributes: Map<string, string>): string | undefined {
  if (name === "script") return attributes.get("src");
  const rel = attributes.get("rel");
  if (rel === undefined) return undefined;
  const asks = rel
    .toLowerCase()
    .split(/\s+/)
    .some((token) => FIRST_PAINT_RELS.includes(token));
  return asks ? attributes.get("href") : undefined;
}

/** The build-relative paths the document asks for up front, in document order, deduplicated. */
export function collectInitialTransfer(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(TAG)) {
    const reference = fetchedBy(
      (match[1] as string).toLowerCase(),
      attributesOf(match[2] as string),
    );
    if (reference === undefined) continue;
    if (/^[a-z]+:|^\/\//i.test(reference)) continue; // off-origin: not ours to count
    const path = reference.replace(/^\.?\//, "");
    if (path !== "" && !found.includes(path)) found.push(path);
  }
  return found;
}

export function brotliSize(bytes: Buffer | Uint8Array): number {
  return brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
  }).byteLength;
}

export interface TransferEntry {
  readonly path: string;
  readonly compressed: number;
  /** The document asks for it and the build has no file for it: counted as nothing, named. */
  readonly missing: boolean;
}

export interface TransferReport {
  readonly entries: readonly TransferEntry[];
  readonly total: number;
  readonly budget: number;
  readonly withinBudget: boolean;
  /** The referenced paths with no file behind them, in document order. */
  readonly missing: readonly string[];
}

export function measureTransfer(
  distDir: string,
  read: (path: string) => Buffer = (path) => readFileSync(path),
  budget: number = TRANSFER_BUDGET_BYTES,
): TransferReport {
  const html = read(resolve(distDir, "index.html"));
  const entries: TransferEntry[] = [
    { path: "index.html", compressed: brotliSize(html), missing: false },
    ...collectInitialTransfer(html.toString("utf8")).map((path) => measureOne(distDir, path, read)),
  ];
  const total = entries.reduce((sum, entry) => sum + entry.compressed, 0);
  return {
    entries,
    total,
    budget,
    withinBudget: total <= budget,
    missing: entries.filter((entry) => entry.missing).map((entry) => entry.path),
  };
}

/**
 * A file the document references and the build does not have is a finding, not a crash: the
 * gate's job is the byte count, and throwing out of the read would lose it to the smaller
 * problem while reading as a fault in the gate rather than in the build.
 */
function measureOne(distDir: string, path: string, read: (path: string) => Buffer): TransferEntry {
  try {
    return { path, compressed: brotliSize(read(resolve(distDir, path))), missing: false };
  } catch {
    return { path, compressed: 0, missing: true };
  }
}

export function formatReport(report: TransferReport): string {
  const lines = report.entries.map((entry) =>
    entry.missing
      ? `  ${"—".padStart(9)}  ${entry.path}  (referenced, not in the build)`
      : `  ${String(entry.compressed).padStart(9)}  ${entry.path}`,
  );
  const verdict = report.withinBudget ? "within budget" : "OVER BUDGET";
  return [
    "Initial transfer, brotli-compressed bytes:",
    ...lines,
    `  ${String(report.total).padStart(9)}  total`,
    `  ${String(report.budget).padStart(9)}  budget — ${verdict}`,
  ].join("\n");
}
