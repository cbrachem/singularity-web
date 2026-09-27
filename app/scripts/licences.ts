import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { LicenceDocument, LicenceSection } from "../src/ui/licences/document.ts";

/**
 * The licences surface, generated.
 *
 * The surface is **generated from `NOTICE` at build time and stamped with the commit**,
 * because a licences page that drifts from what it describes is worse than none.
 *
 * GPL-2.0 §3 asks for the source of what was *served*, and what answers that is the pair the
 * page prints: the address the source is published at, and the commit this bundle was built
 * from. The two together identify the tree, because a public repository makes every commit
 * reachable. So the address is taken exactly as the deployment gives it and nothing is
 * derived from it: the commit beside the link already says which tree it is.
 *
 * Everything here is a pure function over strings, plus two small readers at the bottom
 * that go to the filesystem and to `git`. The vite plugin beside this file is what turns it
 * into the module Presentation imports; `check-licences.ts` is what runs the drift rules on
 * their own.
 */

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The environment variable a deployment names its published source with. */
export const SOURCE_URL_VARIABLE = "SINGULARITY_SOURCE_URL";

/** The environment variable a build without `git` stamps the commit from. */
export const COMMIT_VARIABLE = "SINGULARITY_COMMIT";

const FULL_OBJECT_NAME = /^[0-9a-f]{40}$/;

/** `NOTICE`, split at its `##` headings, with everything above the first kept as preamble. */
export function noticeSections(notice: string): {
  preamble: string;
  sections: LicenceSection[];
} {
  const parts = notice.split(/^## +/m);
  const preamble = (parts[0] ?? "").replace(/^# +.*\n/, "").trim();
  const sections = parts.slice(1).map((part) => {
    const newline = part.indexOf("\n");
    const title = (newline === -1 ? part : part.slice(0, newline)).trim();
    return { title, body: (newline === -1 ? "" : part.slice(newline + 1)).trim() };
  });
  return { preamble, sections };
}

export interface LicenceInputs {
  readonly notice: string;
  readonly commit: string;
  readonly dirty: boolean;
  /** Where the published source is, exactly as the deployment gave it. */
  readonly source: string | undefined;
}

export function licenceDocument({ notice, commit, dirty, source }: LicenceInputs): LicenceDocument {
  if (!FULL_OBJECT_NAME.test(commit)) {
    throw new Error(`the licences surface is stamped with a commit, not with ${commit}`);
  }
  const { preamble, sections } = noticeSections(notice);
  return {
    commit,
    dirty,
    source,
    preamble,
    sections,
  };
}

/**
 * # The drift rules
 *
 * The page is generated, so it cannot drift from `NOTICE`. What can drift is `NOTICE` from
 * the repository, and that is what these three rules are about. They fail the build rather
 * than shipping, which is the acceptance criterion stated as a check.
 */

/** Every file path `NOTICE` names in a `| File | … |` or `| Files | … |` row. */
export function noticedPaths(notice: string): string[] {
  const found: string[] = [];
  for (const row of notice.matchAll(/^\| *Files? *\|(.*)\|/gm)) {
    for (const path of (row[1] as string).matchAll(/`([^`]+)`/g)) found.push(path[1] as string);
  }
  return found;
}

/** Every `<asset>.license` sidecar in the tree, as repository-relative paths. */
export function sidecarPaths(root: string, directories: readonly string[]): string[] {
  const walk = (directory: string): string[] =>
    !existsSync(directory)
      ? []
      : readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
          const path = resolve(directory, entry.name);
          return entry.isDirectory() ? walk(path) : [path];
        });

  return directories
    .flatMap((directory) => walk(resolve(root, directory)))
    .filter((path) => path.endsWith(".license"))
    .map((path) => relative(root, path))
    .sort();
}

/** Where the sidecar convention applies, and where a hand-written page would be found. */
export const ASSET_DIRECTORIES: readonly string[] = ["app/src", "sim/src", "content"];

export const SURFACE_DIRECTORY = "app/src/ui/licences";

/**
 * Prose a licences page must not carry itself. It is generated, so a copyright line or a
 * section heading appearing in its own source means somebody wrote the page by hand — which
 * is exactly the drift the generation exists to prevent.
 */
const HAND_WRITTEN: readonly string[] = ["Copyright (C)", "All rights reserved"];

export function licenceComplaints(root = REPOSITORY_ROOT): string[] {
  const notice = readFileSync(resolve(root, "NOTICE"), "utf8");
  const complaints: string[] = [];

  for (const sidecar of sidecarPaths(root, ASSET_DIRECTORIES)) {
    const asset = sidecar.slice(0, -".license".length);
    if (!notice.includes(asset)) {
      complaints.push(`NOTICE does not name ${asset}, which has a licence sidecar beside it`);
    }
  }

  for (const path of noticedPaths(notice)) {
    if (!existsSync(resolve(root, path))) {
      complaints.push(`NOTICE names ${path}, which is not in the tree`);
    }
  }

  const surface = resolve(root, SURFACE_DIRECTORY);
  const files = existsSync(surface) ? readdirSync(surface) : [];
  for (const name of files) {
    const text = readFileSync(resolve(surface, name), "utf8");
    for (const prose of HAND_WRITTEN) {
      if (text.includes(prose)) {
        complaints.push(
          `${SURFACE_DIRECTORY}/${name} carries licence prose (${JSON.stringify(prose)}); ` +
            "the licences surface is generated from NOTICE",
        );
      }
    }
  }

  return complaints;
}

/** The three readers. Everything above is a function of what they return. */

function git(root: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", [...args], { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return undefined;
  }
}

export function buildCommit(root = REPOSITORY_ROOT): { commit: string; dirty: boolean } {
  const named = process.env[COMMIT_VARIABLE];
  if (named !== undefined && named !== "") return { commit: named.trim(), dirty: false };

  const commit = git(root, ["rev-parse", "HEAD"]);
  if (commit === undefined) {
    throw new Error(
      `no commit to stamp the licences surface with: this is not a git checkout and ` +
        `${COMMIT_VARIABLE} is unset`,
    );
  }
  return { commit, dirty: (git(root, ["status", "--porcelain"]) ?? "") !== "" };
}

/**
 * Where this build says its source is published, or nothing when it has not been told.
 *
 * Nothing is inferred: a deployment knows its own host and writes the address it wants read,
 * including the ref if it wants one. A build that is not a deployment has no address to give
 * and says so on the page instead of guessing one out of a `git remote`.
 */
export function sourceUrl(): string | undefined {
  const named = process.env[SOURCE_URL_VARIABLE];
  return named !== undefined && named.trim() !== "" ? named.trim() : undefined;
}

/** The document this build ships, read off the repository it is being built from. */
export function buildLicences(root = REPOSITORY_ROOT): LicenceDocument {
  const { commit, dirty } = buildCommit(root);
  return licenceDocument({
    notice: readFileSync(resolve(root, "NOTICE"), "utf8"),
    commit,
    dirty,
    source: sourceUrl(),
  });
}
