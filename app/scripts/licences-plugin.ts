import type { Plugin } from "vite";

import { REPOSITORY_ROOT, buildLicences, licenceComplaints } from "./licences.ts";

/**
 * How the generated licences document reaches Presentation: one virtual module, built while
 * the bundle is.
 *
 * A virtual module rather than a committed file, because a committed one is a file somebody
 * can edit — and the commit it would carry is the commit it was generated at rather than the
 * commit the bundle was built from, which is the one GPL-2.0 §3 asks about. There is nothing
 * to hand-edit here: `app/src/ui/licences/` holds a renderer and no prose, and
 * `licenceComplaints` fails the build if it ever holds any.
 */
export const LICENCES_MODULE = "virtual:licences";

const RESOLVED = `\0${LICENCES_MODULE}`;

export function licencesPlugin(root = REPOSITORY_ROOT): Plugin {
  const refuse = (): void => {
    const complaints = licenceComplaints(root);
    if (complaints.length > 0) {
      throw new Error(
        ["NOTICE has drifted from the repository it describes:", ...complaints].join("\n  "),
      );
    }
  };

  return {
    name: "singularity:licences",
    buildStart() {
      refuse();
    },
    resolveId(id) {
      return id === LICENCES_MODULE ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return undefined;
      refuse();
      return `export default ${JSON.stringify(buildLicences(root))};`;
    },
  };
}
