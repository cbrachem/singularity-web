import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import licences from "virtual:licences";
import { describe, expect, it } from "vitest";

import {
  REPOSITORY_ROOT,
  licenceComplaints,
  licenceDocument,
  noticeSections,
  noticedPaths,
  sidecarPaths,
} from "../scripts/licences.ts";

/**
 * The licences surface is **generated from `NOTICE` at build time and stamped with the
 * commit**. This is the generator, and the three rules that make a licences page
 * which has drifted from what it describes fail the build rather than ship.
 *
 * A licences page that drifts is worse than none, and the way it drifts is never the page:
 * it is `NOTICE` falling behind the repository, or somebody writing the page by hand. Both
 * are rules over the repository, applied by the suite and by the build.
 */

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOTICE = readFileSync(resolve(APP, "..", "NOTICE"), "utf8");

const A_COMMIT = "9".repeat(40);

describe("the document the bundle carries", () => {
  it("is NOTICE, section by section", () => {
    const { sections } = noticeSections(NOTICE);
    const headings = [...NOTICE.matchAll(/^## +(.*)$/gm)].map(([, title]) => title as string);

    expect(sections.map((section) => section.title)).toEqual(headings);
    for (const section of sections) expect(NOTICE).toContain(section.body);
  });

  it("keeps everything above the first section as the preamble", () => {
    const { preamble } = noticeSections(NOTICE);

    expect(preamble).toContain("browser port");
    expect(preamble).not.toContain("## ");
  });

  // The stamp is what the source link is for: §3 asks for the source of what was served, and
  // a page that named a branch would name whatever that branch says tomorrow.
  it("refuses to be stamped with anything that is not a commit", () => {
    for (const not of ["main", "HEAD", "", "9".repeat(39), "z".repeat(40)]) {
      expect(() =>
        licenceDocument({ notice: NOTICE, commit: not, dirty: false, source: undefined }),
      ).toThrow(/commit/);
    }
  });

  // The address is the deployment's, not the generator's. What answers GPL-2.0 §3 is the
  // pair the page prints — the address and the commit beside it — because a public
  // repository makes every commit reachable from its root. So nothing is derived from the
  // address here: an earlier version appended `/tree/<commit>`, which guessed a host's URL
  // shape, and then needed a placeholder syntax and a refusal rule for the guesses that were
  // wrong.
  it("carries the source address exactly as it was given", () => {
    for (const given of [
      "https://example.invalid/port",
      "https://example.invalid/port/",
      `https://example.invalid/port/tree/${A_COMMIT}`,
      "https://example.invalid/p/-/archive/x.tar.gz",
    ]) {
      expect(
        licenceDocument({ notice: NOTICE, commit: A_COMMIT, dirty: false, source: given }).source,
      ).toBe(given);
    }
  });

  // The surface Presentation imports, built by the plugin while this suite was loaded: the
  // criterion is that it is generated at build time, so the assertion is on the real one.
  it("reaches Presentation generated rather than committed", () => {
    expect(licences.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(licences.sections.map((section) => section.title)).toEqual(
      noticeSections(NOTICE).sections.map((section) => section.title),
    );
  });
});

describe("NOTICE against the repository it describes", () => {
  it("has not drifted", () => {
    expect(licenceComplaints(REPOSITORY_ROOT)).toEqual([]);
  });

  it("names every asset that has a licence sidecar beside it", () => {
    const sidecars = sidecarPaths(REPOSITORY_ROOT, ["app/src", "sim/src", "content"]);

    expect(sidecars.length).toBeGreaterThan(0);
    for (const sidecar of sidecars) {
      expect(NOTICE).toContain(sidecar.slice(0, -".license".length));
    }
  });

  it("names files that are in the tree", () => {
    expect(noticedPaths(NOTICE)).toContain("app/src/ui/map/land.ts");
  });
});

describe("what fails the build", () => {
  const aTree = (notice: string): string => {
    const root = mkdtempSync(resolve(tmpdir(), "licences-"));
    mkdirSync(resolve(root, "app/src/ui/licences"), { recursive: true });
    writeFileSync(resolve(root, "NOTICE"), notice);
    return root;
  };

  it("an asset with a sidecar that NOTICE does not name", () => {
    const root = aTree("# NOTICE\n\n## The port\n\nNothing here.\n");
    writeFileSync(resolve(root, "app/src/ui/licences/face.woff2"), "");
    writeFileSync(resolve(root, "app/src/ui/licences/face.woff2.license"), "some grant");

    expect(licenceComplaints(root)).toEqual([
      "NOTICE does not name app/src/ui/licences/face.woff2, which has a licence sidecar beside it",
    ]);
  });

  it("a file NOTICE names that is not in the tree", () => {
    const root = aTree("# NOTICE\n\n## Carried-in assets\n\n| File | `app/src/gone.ts` |\n");

    expect(licenceComplaints(root)).toEqual([
      "NOTICE names app/src/gone.ts, which is not in the tree",
    ]);
  });

  // The one shape the generation exists to prevent: a page somebody wrote by hand, which is
  // right on the day it is written and wrong from the next commit onwards.
  it("licence prose written into the surface by hand", () => {
    const root = aTree("# NOTICE\n\n## The port\n\nNothing here.\n");
    writeFileSync(
      resolve(root, "app/src/ui/licences/Hand.tsx"),
      'const notice = "Copyright (C) 2026 somebody";\n',
    );

    expect(licenceComplaints(root)).toEqual([
      'app/src/ui/licences/Hand.tsx carries licence prose ("Copyright (C)"); ' +
        "the licences surface is generated from NOTICE",
    ]);
  });
});
