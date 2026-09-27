// Test-only fault injection; no crash switch is exposed by the production API.
import { Store } from "../src/store.js";
import { Worker } from "../src/worker.js";
const store = new Store();
await store.open();
await new Worker(store, async () => 200, {
  leaseMs: 150,
  providerTimeoutMs: 50,
  afterProjection: async () => {
    process.exit(77);
  },
}).tick();
await store.close();
