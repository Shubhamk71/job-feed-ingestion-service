import assert from "node:assert/strict";
import { cpus, totalmem, platform, arch } from "node:os";
import { performance } from "node:perf_hooks";
import { sample } from "./scenario.js";
import { submit, jobs, base } from "./client.js";
import { setTimeout as sleep } from "node:timers/promises";
const tenant = `load-${Date.now()}`;
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 20);
assert(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 200);
const events = Array.from({ length: 1000 }, (_, i) =>
  sample(
    `event-${i}`,
    i < 150 ? `ordered-${Math.floor(i / 3)}` : `job-${i}`,
    i < 150 ? [3, 1, 2][i % 3]! : 1,
    tenant,
  ),
);
const requests = [...events, ...events.slice(0, 200)];
const latencies: number[] = [];
const counts: Record<string, number> = {};
let index = 0;
const started = performance.now();
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (index < requests.length) {
      const event = requests[index++]!;
      const start = performance.now();
      const r = await submit(event);
      await r.text();
      latencies.push(performance.now() - start);
      counts[r.status] = (counts[r.status] ?? 0) + 1;
    }
  }),
);
const submitted = performance.now();
// Sample every event in bounded batches so status polling cannot create unbounded fan-out.
const deadline = Date.now() + 120000;
let finished = false;
while (Date.now() < deadline) {
  let pending = 0;
  for (let i = 0; i < events.length; i += concurrency) {
    const states = await Promise.all(
      events.slice(i, i + concurrency).map(async (e) => {
        const r = await fetch(
          `${base}/events/${e.eventId}?${new URLSearchParams({ tenantId: tenant, sourceId: "main" })}`,
        );
        assert.equal(r.status, 200);
        return (await r.json()) as { status: string };
      }),
    );
    pending += states.filter((e) => e.status !== "completed").length;
  }
  if (!pending) {
    finished = true;
    break;
  }
  await sleep(100);
}
assert(finished, "Load queue did not complete");
const drained = performance.now();
const final = await jobs(tenant);
assert.equal(counts[202], 1000);
assert.equal(counts[200], 200);
assert.equal(final.length, 900);
for (const job of final)
  assert.equal(
    job.version,
    String(job.externalJobId).startsWith("ordered-") ? 3 : 1,
  );
latencies.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      tenant,
      machine: {
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        cores: cpus().length,
        ramGB: totalmem() / 1e9,
        node: process.version,
      },
      concurrency,
      counts,
      httpP50Ms: latencies[Math.floor(latencies.length * 0.5)],
      httpP95Ms: latencies[Math.floor(latencies.length * 0.95)],
      submissionMs: submitted - started,
      drainAfterSubmissionMs: drained - submitted,
      totalMs: drained - started,
      finalJobs: final.length,
      finalState: "passed",
    },
    null,
    2,
  ),
);
