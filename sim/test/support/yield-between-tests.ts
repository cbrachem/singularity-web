// boundary-intent harness: keeps the worker RPC alive between blocking Oracle runs
import { afterEach } from "vitest";

// The Oracle runs through `spawnSync`, which blocks this worker's event loop. Vitest's worker
// RPC times out after a fixed 60 seconds, and back-to-back blocking tests exceed that in sum.
// `setImmediate` comes after the poll phase, so the pending replies arrive before the next test.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
