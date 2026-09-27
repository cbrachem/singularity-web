// boundary-intent harness: a test, so it decides what to drive and what to expect
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  content,
  loadContent,
  rawContent,
  type Content,
  type RawContent,
  type RawInternalId,
} from "../src/index.ts";
import { referenceShape, type ReferenceContentValues } from "./support/content-shape.ts";
import { referenceContent, referenceContentPath, staleFixture } from "./support/fixtures.ts";
import { contentVectorsCheck, oracleAvailable, oracleRequired } from "./support/oracle.ts";
import { repoRoot } from "./support/scenario.ts";

// The trace seam, for Content. The Converter transcribes and refuses to interpret,
// so every reading — a location's region references, the `absolute` prefix in a position,
// prerequisite promotion, the division in a `6/5` modifier — happens in the port's loader.
// This file is the oracle for that half: `tools/oracle/content_vectors.py` records what
// upstream's own loaders end up holding, and the port is compared against it value by value.

const COLLECTIONS = [
  "regions",
  "locations",
  "bases",
  "items",
  "itemTypes",
  "techs",
  "events",
  "tasks",
  "difficulties",
  "groups",
  "dangers",
  "knowledge",
  "warnings",
  "story",
] as const;

const loaded = referenceShape(content);

describe("the loaded Content against the reference", () => {
  for (const name of COLLECTIONS) {
    it(`holds the same ${name} the reference holds`, () => {
      expect(loaded[name]).toEqual(referenceContent[name]);
    });
  }

  it("holds the same internal id tables and significant numbers", () => {
    expect(loaded.internalIds).toEqual(referenceContent.internalIds);
    expect(loaded.numbers).toEqual(referenceContent.numbers);
  });

  it("compares against a fixture that covers every object type", () => {
    const compared: readonly (keyof ReferenceContentValues)[] = [
      ...COLLECTIONS,
      "internalIds",
      "numbers",
    ];
    // Fifteen object types plus the plain list of numbers.
    expect(compared).toHaveLength(16);
    expect(Object.keys(loaded).sort()).toEqual([...compared].sort());
  });
});

describe("what the loader resolves", () => {
  it("resolves a location's region references, in both directions", () => {
    const urban = content.regions.byId.get("URBAN");
    // The order Region.__init__ shuffles a list of modifier indices against, so it is
    // contract rather than presentation.
    expect(urban?.locations).toEqual([
      "N AMERICA",
      "S AMERICA",
      "EUROPE",
      "ASIA",
      "AFRICA",
      "AUSTRALIA",
    ]);
    expect(content.locations.byId.get("N AMERICA")?.regions).toEqual(["URBAN"]);
    expect(content.locations.byId.get("MOON")?.regions).toEqual([]);

    // A base's `allowed` list names regions and locations alike; the region expands.
    expect(content.bases.byId.get("Covert Base")?.buildableIn).toEqual({
      anywhere: false,
      locations: [...(urban?.locations ?? []), "ANTARCTIC"],
    });
    expect(content.bases.byId.get("Undersea Lab")?.buildableIn).toEqual({
      anywhere: false,
      locations: ["OCEAN"],
    });
    // `ALL` sets the flag and contributes nothing, because upstream re-tests it per element.
    expect(content.items.byId.get("PC")?.buildableIn).toEqual({ anywhere: true, locations: [] });
  });

  it("resolves a position, including the absolute prefix", () => {
    expect(content.locations.byId.get("N AMERICA")).toMatchObject({
      absolute: false,
      x: -0.25,
      y: -0.29,
    });
    expect(content.locations.byId.get("MOON")).toMatchObject({
      absolute: true,
      x: -0.14,
      y: -0.13,
    });
  });

  it("resolves prerequisites, however the file writes them", () => {
    // One string, promoted.
    expect(content.locations.byId.get("OCEAN")?.prerequisites).toEqual({
      mode: "all",
      techs: ["Autonomous Vehicles"],
    });
    // A list, kept in order.
    expect(content.techs.byId.get("Simulacra")?.prerequisites).toEqual({
      mode: "all",
      techs: ["Voice Synthesis", "Advanced Autonomous Vehicles", "Advanced Media Manipulation"],
    });
    // Absent.
    expect(content.techs.byId.get("Sociology")?.prerequisites).toEqual({ mode: "all", techs: [] });
    // The one marker that means never.
    expect(content.locations.byId.get("ORBIT")?.prerequisites).toEqual({ mode: "impossible" });

    // `OR` leads a list upstream reads as any-of. The pinned content uses none, so the
    // branch is exercised on a record of this test's own making rather than left untested.
    const patched = withTechPrerequisite(["OR", "Stealth", "Sociology"]);
    expect(loadContent(patched).techs.all[0]?.prerequisites).toEqual({
      mode: "any",
      techs: ["Stealth", "Sociology"],
    });
  });

  it("divides a modifier written as a fraction", () => {
    const urban = content.regions.byId.get("URBAN");
    expect(urban?.modifiers).toHaveLength(5);
    expect(urban?.modifiers[0]?.get("cpu")).toBe(1.2);
    // The division, not a rounding of it: 5/6 is 0.8333333333333334.
    expect(urban?.modifiers[0]?.get("stealth")).toBe(5 / 6);
    expect(urban?.modifiers[2]?.get("thrift")).toBe(6 / 5);

    // A location may carry its own table, and a plain decimal stays what it is.
    const moon = content.locations.byId.get("MOON");
    expect([...(moon?.modifiers ?? [])]).toEqual([
      ["stealth", 1.5],
      ["thrift", 0.5],
      ["speed", 0.5],
    ]);
    expect(content.locations.byId.get("N AMERICA")?.modifiers.size).toBe(0);
  });

  it("applies the two readings upstream makes without saying so", () => {
    // load_tasks ignores whatever a cpu_pool task writes for value and pre.
    expect(content.tasks.byId.get("CPU Pool")).toMatchObject({
      value: 0,
      prerequisites: { mode: "all", techs: [] },
    });
    // EventSpec turns a non-positive duration into "does not expire".
    expect(content.events.byId.get("the-plague")?.duration).toBeNull();
    expect(content.events.byId.get("scandal")?.duration).toBe(21);
    // A base type declares `danger` and upstream drops it, so the port holds no such field.
    expect(content.bases.all[0]).not.toHaveProperty("danger");
  });
});

describe("the ordering contract", () => {
  it("keeps every collection in .dat parse order", () => {
    // Event checking rolls per event and returns on the first hit, so the order
    // decides which event fires and how many draws are consumed.
    expect(content.events.all.map((event) => event.id)).toEqual(
      rawContent.events.records.map((record) => record.id),
    );
    for (const [name, records] of committedRecords()) {
      const collection = content[name];
      expect(
        collection.all.map((entry) => entry.id),
        name,
      ).toEqual(records);
    }
  });

  it("builds every id map from its array, not beside it", () => {
    for (const [name] of committedRecords()) {
      const collection = content[name];
      expect([...collection.byId.keys()], name).toEqual(collection.all.map((entry) => entry.id));
      for (const entry of collection.all) {
        expect(collection.byId.get(entry.id), `${name} ${entry.id}`).toBe(entry);
      }
    }
  });
});

describe("the internal id table", () => {
  it("covers exactly the seven object types a Save names", () => {
    expect([...content.internalIds.forward.keys()].sort()).toEqual(
      Object.keys(CATALOGUE_BY_INTERNAL_ID_TYPE).sort(),
    );
    expect([...content.internalIds.backward.keys()].sort()).toEqual(
      Object.keys(CATALOGUE_BY_INTERNAL_ID_TYPE).sort(),
    );
  });

  it("gives every object of those types an internal id", () => {
    for (const [type, catalogueName] of Object.entries(CATALOGUE_BY_INTERNAL_ID_TYPE)) {
      const forward = content.internalIds.forward.get(type);
      for (const entry of content[catalogueName].all) {
        expect(forward?.get(entry.id), `${type}|${entry.id}`).toMatch(/^0x[0-9a-f]{8}$/);
      }
    }
  });

  it("keeps the alias a rename left behind, and resolves it to the id that survived", () => {
    // `tech|Fusion Reactor` and `tech|Fusion Power` share 0x0101001d. The first
    // names no tech; it is the name the tech had before the rename, kept so that a save
    // written under the old name resolves to the new one — which is what upstream's
    // `convert_internal_id` does, human id -> internal id -> human id (`g.py:337`).
    const techs = content.internalIds.forward.get("tech");
    expect(techs?.get("Fusion Reactor")).toBe("0x0101001d");
    expect(techs?.get("Fusion Power")).toBe("0x0101001d");
    expect(content.internalIds.backward.get("tech")?.get("0x0101001d")).toBe("Fusion Power");
    expect(content.techs.byId.has("Fusion Reactor")).toBe(false);
    expect(content.techs.byId.has("Fusion Power")).toBe(true);
  });

  it("holds nothing but aliases: no dangling entry, and no id shared by two live objects", () => {
    expect(internalIdFaults(content)).toEqual({ dangling: [], shared: [] });
  });

  it("would say so if a bump made a rename alias stale, or collided two live objects", () => {
    // The two faults the check above exists for, each on a table of this test's own making,
    // because the pinned content has neither.
    const stale = internalIdFaults(
      loadContent(
        withInternalIds([{ type: "tech", id: "Cold Fusion", internal_id: "0x01019999" }]),
      ),
    );
    expect(stale.dangling).toEqual(["tech|Cold Fusion"]);

    const collided = internalIdFaults(
      loadContent(
        withInternalIds([{ type: "tech", id: "Stock Manipulation", internal_id: "0x0101001d" }]),
      ),
    );
    expect(collided.shared).toEqual(["tech|0x0101001d: Stock Manipulation, Fusion Power"]);
  });
});

describe("what reaches the loader", () => {
  it("covers every document the Converter writes", () => {
    const onDisk = readdirSync(resolve(repoRoot, "content"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();

    expect(Object.keys(rawContent).sort()).toEqual(onDisk);
    expect(rawContent.index.files.map((entry) => entry.file).sort()).toEqual(
      onDisk.filter((name) => name !== "index").map((name) => `${name}.json`),
    );
  });

  it("reads a document a validator would refuse, because nothing validates at play time", () => {
    // A base type with a key the Converter's schema rejects outright, no `pre` at all, and a
    // `flavor` written as one string rather than as a list. The content is fixed when the
    // build is made and checked in CI twice over, so the loader carries on.
    const raw = {
      ...rawContent,
      bases: {
        sources: [],
        records: [
          {
            id: "Cardboard Box",
            size: "1",
            allowed: "URBAN",
            detect_chance: ["news:5"],
            cost: ["1", "2", "3"],
            maint: ["0", "0", "0"],
            name: "Cardboard Box",
            description: "",
            flavor: "Box | Carton",
            colour: "beige",
          },
        ],
      },
    } as unknown as RawContent;

    const box = loadContent(raw).bases.byId.get("Cardboard Box");
    expect(box?.prerequisites).toEqual({ mode: "all", techs: [] });
    expect(box?.buildableIn.locations).toEqual(content.regions.byId.get("URBAN")?.locations);
    // load_generic_defs splits `flavor` on `|` whether or not the file wrote it as a list,
    // and Python's strip() takes the no-break space in bases_str.dat with it.
    expect(box?.flavor).toEqual(["Box", "Carton"]);
  });
});

// Everything above compares the port against the *committed* fixture, which closes only half
// the chain: the fixture matches the reference at the moment it is generated, and nothing has
// been watching since. A reference bump that changes a loader in `singularity/` without
// changing a `.dat` file leaves `content/` byte-identical, so the Converter's dirty-tree check
// in CI stays green and the fixture goes on asserting the old reading.
//
// This is the other half: the fixture against a reference run made now. With it, port ≡
// fixture ≡ reference; without it, only the first link is checked.
//
// Driving the Oracle needs the Python environment in `.venv`. A working copy without one skips rather than failing on setup it does not have; CI sets
// SINGULARITY_ORACLE_REQUIRED, so there the absence is a failure and this cannot quietly stop
// running.
const runsTheOracle = oracleAvailable || oracleRequired;

describe.skipIf(!runsTheOracle)("the fixture against a fresh reference run", () => {
  it("still holds what upstream's own loaders hold", () => {
    const result = contentVectorsCheck();

    expect(`${result.stdout}${result.stderr}`.trim()).toContain("matches the reference");
    expect(result.status).toBe(0);
  });

  it("goes red on a changed reading, naming the object it changed", () => {
    const stale = staleFixture(referenceContentPath, (document) => {
      const techs = document["techs"] as Record<string, unknown>[];
      const simulacra = techs.find((tech) => tech["id"] === "Simulacra") as Record<string, unknown>;
      simulacra["cost"] = [1, 2, 3];
    });

    const result = contentVectorsCheck(stale);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('techs[3 "Simulacra"].cost[0]: 1 -> 70000');
    expect(result.stderr).toContain("tools/oracle/content_vectors.py");
  });

  it("goes red on a collection that gained or lost an entry", () => {
    const stale = staleFixture(referenceContentPath, (document) => {
      const events = document["events"] as unknown[];
      events.pop();
    });

    const result = contentVectorsCheck(stale);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("events: 7 entries");
  });

  // The recording interpreter is provenance, not specification: what the port is compared
  // against is the record, and a CPython that read the content differently would show up as a
  // differing value rather than as a differing version string. Tolerating it is what lets CI
  // run the check on whatever interpreter it provisioned.
  it("does not mistake the recording interpreter for a changed reading", () => {
    const elsewhere = staleFixture(referenceContentPath, (document) => {
      document["python"] = "0.0.0";
    });

    const result = contentVectorsCheck(elsewhere);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0.0.0");
  });

  it("leaves the committed fixture alone while checking it", () => {
    const before = readFileSync(referenceContentPath, "utf8");

    expect(contentVectorsCheck().status).toBe(0);

    expect(readFileSync(referenceContentPath, "utf8")).toBe(before);
  });
});

/** The ids the committed JSON carries, per collection the loader keys by id. */
function committedRecords(): readonly (readonly [
  (typeof COLLECTIONS)[number],
  readonly string[],
])[] {
  return [
    ["regions", rawContent.regions.records.map((record) => record.id)],
    ["locations", rawContent.locations.records.map((record) => record.id)],
    ["bases", rawContent.bases.records.map((record) => record.id)],
    ["items", rawContent.items.records.map((record) => record.id)],
    ["itemTypes", rawContent.itemtypes.records.map((record) => record.id)],
    ["techs", rawContent.techs.records.map((record) => record.id)],
    ["events", rawContent.events.records.map((record) => record.id)],
    ["tasks", rawContent.tasks.records.map((record) => record.id)],
    ["difficulties", rawContent.difficulties.records.map((record) => record.id)],
    ["groups", rawContent.groups.records.map((record) => record.id)],
    ["dangers", rawContent.dangers.records.map((record) => record.id)],
    ["knowledge", rawContent.knowledge.records.map((record) => record.id)],
    ["warnings", rawContent.warnings.records.map((record) => record.id)],
    ["story", rawContent.story.records.map((record) => record.id)],
  ];
}

/**
 * The catalogue each internal id type names. Seven of them — the table covers what a Save
 * writes an id for, and nothing else.
 */
const CATALOGUE_BY_INTERNAL_ID_TYPE = {
  region: "regions",
  location: "locations",
  base: "bases",
  item: "items",
  tech: "techs",
  event: "events",
  group: "groups",
} as const satisfies Record<string, (typeof COLLECTIONS)[number]>;

type InternalIdType = keyof typeof CATALOGUE_BY_INTERNAL_ID_TYPE;

/**
 * What separates a rename alias from a fault. `dangling` names a forward entry whose internal
 * id resolves back to no object at all; `shared` names an internal id two live objects both
 * claim, which is the collision the Save format could not survive.
 */
function internalIdFaults(subject: Content): {
  readonly dangling: readonly string[];
  readonly shared: readonly string[];
} {
  const dangling: string[] = [];
  const shared: string[] = [];

  for (const [type, forward] of subject.internalIds.forward) {
    const byId = subject[CATALOGUE_BY_INTERNAL_ID_TYPE[type as InternalIdType]].byId;
    const backward = subject.internalIds.backward.get(type);
    const live = new Map<string, string[]>();

    for (const [humanId, internalId] of forward) {
      const survivor = backward?.get(internalId);
      if (survivor === undefined || !byId.has(survivor)) dangling.push(`${type}|${humanId}`);
      if (byId.has(humanId)) {
        const claimants = live.get(internalId) ?? [];
        claimants.push(humanId);
        live.set(internalId, claimants);
      }
    }

    for (const [internalId, claimants] of live) {
      if (claimants.length > 1) shared.push(`${type}|${internalId}: ${claimants.join(", ")}`);
    }
  }

  return { dangling, shared };
}

/** The committed content with internal id entries replaced in place, or appended if new. */
function withInternalIds(overrides: readonly RawInternalId[]): RawContent {
  const matches = (record: RawInternalId, other: RawInternalId) =>
    record.type === other.type && record.id === other.id;
  const records = rawContent.internal_id.records.map(
    (record) => overrides.find((override) => matches(record, override)) ?? record,
  );
  const appended = overrides.filter(
    (override) => !rawContent.internal_id.records.some((record) => matches(record, override)),
  );

  return {
    ...rawContent,
    internal_id: { ...rawContent.internal_id, records: [...records, ...appended] },
  };
}

/** The committed content with one tech standing in for a prerequisite form it does not use. */
function withTechPrerequisite(pre: readonly string[]): RawContent {
  const first = rawContent.techs.records[0] as RawContent["techs"]["records"][number];
  return {
    ...rawContent,
    techs: { ...rawContent.techs, records: [{ ...first, pre }] },
  };
}
