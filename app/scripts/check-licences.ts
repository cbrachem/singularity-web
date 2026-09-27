import { REPOSITORY_ROOT, buildLicences, licenceComplaints } from "./licences.ts";

/**
 * The drift rules on their own, so CI can run them without a build — the build runs them too
 * (`licences-plugin.ts`), and this is the copy that says what is wrong in one screen.
 */
const complaints = licenceComplaints(REPOSITORY_ROOT);

if (complaints.length > 0) {
  console.error("NOTICE has drifted from the repository it describes:");
  for (const complaint of complaints) console.error(`  ${complaint}`);
  process.exit(1);
}

const licences = buildLicences(REPOSITORY_ROOT);
const source = licences.source ?? "not published; the commit above is the corresponding source";

console.log(
  `The licences surface reads NOTICE's ${licences.sections.length} sections, ` +
    `stamped ${licences.commit}${licences.dirty ? " (tree is dirty)" : ""}.\n` +
    `  Source: ${source}`,
);
