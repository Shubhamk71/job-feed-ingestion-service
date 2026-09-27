import { Store } from "./store.js";
import { app } from "./api.js";
import { Worker, loadProvider, defaults } from "./worker.js";
const store = new Store();
await store.open();
const controller = new AbortController();
const mode = process.argv[2] ?? "all";
if (!["api", "worker", "all"].includes(mode))
  throw Error("Mode must be api, worker, or all");
const server =
  mode !== "worker"
    ? app(store).listen(Number(process.env.PORT ?? 3000), () =>
        console.log("API ready"),
      )
    : undefined;
const positive = (key: string, fallback: number) => {
  const n = Number(process.env[key] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1) throw Error(`Invalid ${key}`);
  return n;
};
const options = {
  leaseMs: positive("LEASE_MS", defaults.leaseMs),
  backoffMs: positive("BACKOFF_MS", defaults.backoffMs),
  pollMs: positive("POLL_MS", defaults.pollMs),
  providerTimeoutMs: positive(
    "PROVIDER_TIMEOUT_MS",
    defaults.providerTimeoutMs,
  ),
};
const loops: Promise<void>[] = [];
if (mode !== "api") {
  const provider = await loadProvider(
    process.env.PROVIDER_PLAN ?? "fixtures/provider-plan.json",
  );
  for (let i = 0; i < positive("WORKER_LOOPS", 2); i++)
    loops.push(new Worker(store, provider, options).run(controller.signal));
  console.log(`Started ${loops.length} worker loops`);
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  controller.abort();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(loops);
  await store.close();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
