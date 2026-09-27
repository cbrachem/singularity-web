// boundary-intent harness: the one place the port's Projection is spelled in upstream's names
import type { ResourceFlow } from "../../src/index.ts";
import type { ReferenceResourceFlow } from "./oracle.ts";

/**
 * The port's resource-flow Projection in the reference's own field names, so the two can be
 * compared as one object rather than field by field at every call site.
 *
 * The mapping is written out rather than derived from the shape: `DryRunInfo` is an empty
 * class the reference hangs attributes on, so nothing on either side declares the pairing,
 * and a rename on either end has to be a deliberate edit here.
 */
export function asReferenceFlow(flow: ResourceFlow): ReferenceResourceFlow {
  return {
    cash: {
      interest: flow.cash.interest,
      income: flow.cash.income,
      jobs: flow.cash.jobs,
      tech: flow.cash.tech,
      maintenance_needed: flow.cash.maintenanceNeeded,
      construction_needed: flow.cash.constructionNeeded,
      difference: flow.cash.difference,
    },
    cpu: {
      sleeping: flow.cpu.sleeping,
      total: flow.cpu.total,
      explicit_jobs: flow.cpu.explicitJobs,
      tech: flow.cpu.tech,
      effective_pool: flow.cpu.effectivePool,
      construction_needed: flow.cpu.constructionNeeded,
      maintenance_needed: flow.cpu.maintenanceNeeded,
      difference: flow.cpu.difference,
    },
  };
}
