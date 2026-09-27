import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Server } from "node:http";
import { Store } from "../src/store.js";
import { app } from "../src/api.js";
import { Worker, plannedProvider, type Provider } from "../src/worker.js";
import { canonical, eventSchema, type JobEvent } from "../src/domain.js";
import { sample } from "../scripts/scenario.js";
const name = `test_${randomUUID().replaceAll("-", "")}`;
let store: Store;
let server: Server;
let base: string;
const fast = { leaseMs: 150, providerTimeoutMs: 50, backoffMs: 20, pollMs: 5 };
async function post(body: unknown) {
  return fetch(`${base}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function drain(provider: Provider = async () => 200) {
  const a = new Worker(store, provider, fast),
    b = new Worker(store, provider, fast);
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    await Promise.all([a.tick(), b.tick()]);
    if (
      !(await store.events.countDocuments({
        status: { $nin: ["completed", "failed"] },
      }))
    )
      return;
    await sleep(5);
  }
  throw Error("drain timed out");
}
async function event(id: string) {
  return (await store.events.findOne({ eventId: id }))!;
}
beforeAll(async () => {
  store = new Store(undefined, name);
  await store.open();
  server = app(store).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error();
  base = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  await store.events.deleteMany({});
  await store.jobs.deleteMany({});
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await store.client.db(name).dropDatabase();
  await store.close();
});
describe("validation and replay", () => {
  it("normalizes and validates contract boundaries", () => {
    const e = eventSchema.parse(sample("a"));
    expect(e.operation === "upsert" && e.payload.skills).toEqual([
      "typescript",
      "mongodb",
    ]);
    for (const bad of [
      { tenantId: " x" },
      { eventId: " " },
      { version: 0 },
      { version: Number.MAX_SAFE_INTEGER + 1 },
      { operation: "delete" },
    ])
      expect(eventSchema.safeParse({ ...sample("a"), ...bad }).success).toBe(
        false,
      );
    const original = sample("a");
    if (original.operation !== "upsert") throw Error();
    for (const bad of [
      { title: " " },
      { experienceMin: 4, experienceMax: 3 },
      { experienceMin: -1 },
      { experienceMax: 51 },
      { experienceMin: 1.5 },
      { applyUrl: "http://example.test" },
      { skills: [" "] },
    ])
      expect(
        eventSchema.safeParse({
          ...original,
          payload: { ...original.payload, ...bad },
        }).success,
      ).toBe(false);
    expect(canonical({ b: 2, a: [1, 2] })).toBe(canonical({ a: [1, 2], b: 2 }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });
  it("rejects invalid input without reserving identity and compares original JSON", async () => {
    const body = sample("a");
    expect((await post({ ...body, version: 0 })).status).toBe(400);
    expect((await post(body)).status).toBe(202);
    expect(
      (await post(Object.fromEntries(Object.entries(body).reverse()))).status,
    ).toBe(200);
    expect((await post({ ...body, version: 2 })).status).toBe(409);
    if (body.operation !== "upsert") throw Error();
    expect(
      (
        await post({
          ...body,
          payload: {
            ...body.payload,
            skills: ["typescript", "MongoDB", "typescript"],
          },
        })
      ).status,
    ).toBe(409);
    expect(await store.events.countDocuments()).toBe(1);
  });
  it("concurrent duplicates insert exactly one work item", async () => {
    const statuses = await Promise.all(
      Array.from(
        { length: 20 },
        async () => (await post(sample("same"))).status,
      ),
    );
    expect(statuses.filter((s) => s === 202)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(19);
    expect(await store.events.countDocuments()).toBe(1);
  });
});
describe("workers and durable state", () => {
  it("isolates tenants/sources and keeps tombstones against delayed updates", async () => {
    const archive: JobEvent = {
      tenantId: "demo-a",
      sourceId: "main",
      eventId: "archive",
      externalJobId: "alpha",
      version: 3,
      operation: "archive",
    };
    await post(archive);
    await drain();
    await post(sample("old", "alpha", 2));
    await post(sample("archive", "alpha", 1, "other"));
    await post(sample("archive", "alpha", 1, "demo-a", "other"));
    await drain();
    expect(await store.jobs.countDocuments()).toBe(3);
    expect(
      (await store.jobs.findOne({ tenantId: "demo-a", sourceId: "main" }))
        ?.status,
    ).toBe("archived");
    expect((await event("old")).attemptCount).toBe(0);
  });
  it("handles concurrent first inserts and reversed completion order", async () => {
    await post(sample("low", "race", 1));
    await post(sample("high", "race", 5));
    const provider: Provider = async (e) => {
      if (e.version === 1) await sleep(20);
      return 200;
    };
    await drain(provider);
    expect(await store.jobs.countDocuments()).toBe(1);
    expect((await store.jobs.findOne({ externalJobId: "race" }))?.version).toBe(
      5,
    );
    await post(sample("equal", "race", 5));
    await drain(async () => {
      throw Error("must skip");
    });
    expect((await event("equal")).attemptCount).toBe(0);
  });
  it("records increasing retry delays, permanent failure, and exhaustion", async () => {
    for (const id of ["retry", "bad", "exhaust"]) await post(sample(id));
    const provider = plannedProvider({
      '["demo-a","main","retry"]': [429, 503, 200],
      '["demo-a","main","bad"]': [422],
      '["demo-a","main","exhaust"]': [503, 503, 503],
    });
    await drain(provider);
    const retry = await event("retry");
    expect(retry.status).toBe("completed");
    expect(retry.attemptCount).toBe(3);
    expect(
      retry.attempts[1]!.startedAt.getTime() -
        retry.attempts[0]!.finishedAt!.getTime(),
    ).toBeGreaterThanOrEqual(20);
    expect(
      retry.attempts[2]!.startedAt.getTime() -
        retry.attempts[1]!.finishedAt!.getTime(),
    ).toBeGreaterThanOrEqual(40);
    expect((await event("bad")).attemptCount).toBe(1);
    expect((await event("bad")).status).toBe("failed");
    expect((await event("exhaust")).attemptCount).toBe(3);
    expect((await event("exhaust")).lastError).toContain("503");
    expect(await store.jobs.countDocuments()).toBe(1);
  });
  it("keeps lower successful version when a higher version fails", async () => {
    await post(sample("base", "job", 1));
    await drain();
    await post(sample("fail", "job", 2));
    await drain(async () => 422);
    expect((await store.jobs.findOne({ externalJobId: "job" }))?.version).toBe(
      1,
    );
    await post(sample("success", "job", 3));
    await drain();
    expect((await store.jobs.findOne({ externalJobId: "job" }))?.version).toBe(
      3,
    );
  });
  it("recovers after projection write before acknowledgment and reconnect", async () => {
    await post(sample("crash"));
    const worker = new Worker(store, async () => 200, {
      ...fast,
      afterProjection: async () => {
        throw Error("deliberate crash");
      },
    });
    await expect(worker.tick()).rejects.toThrow("deliberate crash");
    expect((await event("crash")).status).toBe("processing");
    expect(await store.jobs.countDocuments()).toBe(1);
    const replacement = new Store(undefined, name);
    await replacement.open();
    await sleep(160);
    await new Worker(
      replacement,
      async () => {
        throw Error("must not verify again");
      },
      fast,
    ).tick();
    await replacement.close();
    expect((await event("crash")).status).toBe("completed");
    expect((await event("crash")).attemptCount).toBe(1);
    expect(await store.jobs.countDocuments()).toBe(1);
  });
  it("fences an abandoned claim and recovers interrupted attempts", async () => {
    await post(sample("abandoned"));
    const a = new Worker(store, async () => 200, fast);
    const claim = await a.claim();
    expect(claim).not.toBeNull();
    await store.events.updateOne(
      { _id: claim!._id },
      {
        $set: {
          attemptCount: 1,
          attempts: [{ number: 1, startedAt: new Date() }],
        },
      },
    );
    await sleep(160);
    const b = new Worker(store, async () => 200, fast);
    const reclaimed = await b.claim();
    expect(reclaimed?.leaseToken).not.toBe(claim?.leaseToken);
    await a.finish(claim!, "applied");
    expect((await event("abandoned")).status).toBe("processing");
    await sleep(160);
    await b.tick();
    expect((await event("abandoned")).attemptCount).toBe(2);
    expect((await event("abandoned")).attempts[0]?.error).toContain(
      "interrupted",
    );
  });
});
it("requires tenant scope and paginates with query-bound cursors", async () => {
  for (let i = 0; i < 5; i++) await post(sample(`p${i}`));
  await drain();
  expect((await fetch(`${base}/jobs`)).status).toBe(400);
  expect((await fetch(`${base}/events/p0?tenantId=demo-a`)).status).toBe(400);
  const page = (await (
    await fetch(`${base}/jobs?tenantId=demo-a&limit=2`)
  ).json()) as { jobs: { _id: string }[]; nextCursor: string };
  expect(page.jobs).toHaveLength(2);
  const second = (await (
    await fetch(
      `${base}/jobs?tenantId=demo-a&limit=2&cursor=${page.nextCursor}`,
    )
  ).json()) as { jobs: { _id: string }[] };
  expect(second.jobs).toHaveLength(2);
  expect(second.jobs.some((j) => page.jobs.some((p) => p._id === j._id))).toBe(
    false,
  );
  expect(
    (await fetch(`${base}/jobs?tenantId=other&cursor=${page.nextCursor}`))
      .status,
  ).toBe(400);
  expect((await fetch(`${base}/jobs?tenantId=demo-a&limit=101`)).status).toBe(
    400,
  );
  expect((await fetch(`${base}/health`)).status).toBe(200);
});

it("survives actual worker process exit after projection, then API restart", async () => {
  const { spawn } = await import("node:child_process");
  await post(sample("process-crash"));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "tests/crash-child.ts"],
    { env: { ...process.env, MONGO_DB: name }, stdio: "pipe" },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += String(data);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  expect(code, stderr).toBe(77);
  expect((await event("process-crash")).status).toBe("processing");
  await new Promise<void>((r) => server.close(() => r()));
  await store.close();
  store = new Store(undefined, name);
  await store.open();
  server = app(store).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error();
  base = `http://127.0.0.1:${address.port}`;
  await sleep(160);
  await drain();
  expect((await event("process-crash")).status).toBe("completed");
  expect(await store.jobs.countDocuments()).toBe(1);
  expect((await post(sample("process-crash"))).status).toBe(200);
});
it("atomically protects concurrent first creation and treats dollar strings as literals", async () => {
  const a = sample("a", "new", 1),
    b = sample("b", "new", 2);
  if (a.operation !== "upsert" || b.operation !== "upsert") throw Error();
  a.payload.title = "$version";
  b.payload.title = "$literal";
  await post(a);
  await post(b);
  const worker = new Worker(store, async () => 200, fast);
  await Promise.all([
    worker.project(await event("a")),
    worker.project(await event("b")),
  ]);
  expect(await store.jobs.countDocuments()).toBe(1);
  const job = await store.jobs.findOne({ externalJobId: "new" });
  expect(job?.version).toBe(2);
  expect(job?.payload?.title).toBe("$literal");
});
it("rejects malformed JSON and object-shaped tenant inputs", async () => {
  expect(
    (
      await fetch(`${base}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"bad":',
      })
    ).status,
  ).toBe(400);
  expect(
    (await post({ ...sample("injection"), tenantId: { $ne: null } })).status,
  ).toBe(400);
  expect((await fetch(`${base}/jobs?tenantId[$ne]=x`)).status).toBe(400);
});
