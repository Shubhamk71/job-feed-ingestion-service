import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { JobEvent } from "../src/domain.js";
export const base = process.env.API_URL ?? "http://127.0.0.1:3000";
export async function submit(body: unknown) {
  return fetch(`${base}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}
export async function state(
  e: Pick<JobEvent, "eventId" | "tenantId" | "sourceId">,
) {
  const r = await fetch(
    `${base}/events/${encodeURIComponent(e.eventId)}?${new URLSearchParams({ tenantId: e.tenantId, sourceId: e.sourceId })}`,
    { signal: AbortSignal.timeout(10000) },
  );
  assert.equal(r.status, 200);
  return (await r.json()) as {
    status: string;
    attemptCount: number;
    lastError?: string;
    attempts: { startedAt: string; finishedAt?: string; code?: number }[];
  };
}
export async function settle(
  events: Pick<JobEvent, "eventId" | "tenantId" | "sourceId">[],
  timeout = 120000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const states = await Promise.all(events.map(state));
    if (states.every((e) => ["completed", "failed"].includes(e.status)))
      return states;
    await sleep(100);
  }
  throw Error("Queue failed to settle");
}
export async function jobs(tenantId: string) {
  const all: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  do {
    const query: URLSearchParams = new URLSearchParams({
      tenantId,
      status: "all",
      limit: "100",
      ...(cursor ? { cursor } : {}),
    });
    const r: Response = await fetch(`${base}/jobs?${query}`);
    assert.equal(r.status, 200);
    const page = (await r.json()) as {
      jobs: Record<string, unknown>[];
      nextCursor: string | null;
    };
    all.push(...page.jobs);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}
