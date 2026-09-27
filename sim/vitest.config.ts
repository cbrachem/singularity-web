import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "sim",
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Thirty seconds rather than Vitest's silent five: much of this project drives the pinned
    // reference through a Python process, which takes seconds on an idle machine and multiples
    // of that under the parallelism of a full run. Five seconds is not a budget anybody chose
    // — it is what a suite gets for saying nothing — and crossing it turns a busy machine into
    // a red suite that says nothing about the code.
    //
    // The number is measured and answerable in tools/suite/oracle-timeout.test.ts, which fails
    // if it stops fitting what driving the Oracle costs. A test that needs longer still says so
    // itself; nothing here stops it.
    testTimeout: 30_000,
  },
});
