import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { JobEvent } from "./domain.js";
import { Store, jobKey, duplicate, type EventRecord } from "./store.js";
export type Provider = (event: JobEvent, attempt: number) => Promise<number>;
export type Plan = Record<string, number[]>;
export function plannedProvider(plan: Plan): Provider {
  return async (e, attempt) =>
    plan[JSON.stringify([e.tenantId, e.sourceId, e.eventId])]?.[attempt - 1] ??
    200;
}
export async function loadProvider(path: string) {
  return plannedProvider(JSON.parse(await readFile(path, "utf8")) as Plan);
}
export type WorkerOptions = {
  leaseMs: number;
  backoffMs: number;
  pollMs: number;
  providerTimeoutMs: number;
  afterProjection?: (event: EventRecord) => Promise<void>;
};
export const defaults: WorkerOptions = {
  leaseMs: 10000,
  backoffMs: 1000,
  pollMs: 100,
  providerTimeoutMs: 2000,
};
export class Worker {
  options: WorkerOptions;
  constructor(
    private store: Store,
    private provider: Provider,
    options: Partial<WorkerOptions> = {},
  ) {
    this.options = { ...defaults, ...options };
    if (this.options.leaseMs <= this.options.providerTimeoutMs)
      throw Error("Lease must exceed provider timeout");
  }
  async claim() {
    const now = new Date(),
      leaseToken = randomUUID();
    const update = {
      $set: {
        status: "processing" as const,
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + this.options.leaseMs),
      },
    };
    return (
      (await this.store.events.findOneAndUpdate(
        { status: "processing", leaseExpiresAt: { $lte: now } },
        update,
        { sort: { leaseExpiresAt: 1 }, returnDocument: "after" },
      )) ??
      (await this.store.events.findOneAndUpdate(
        {
          status: { $in: ["pending", "retry_wait"] },
          nextAttemptAt: { $lte: now },
        },
        update,
        { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: "after" },
      ))
    );
  }
  async finish(e: EventRecord, outcome: "applied" | "stale") {
    await this.store.events.updateOne(
      { _id: e._id, leaseToken: e.leaseToken, status: "processing" },
      {
        $set: { status: "completed", outcome, completedAt: new Date() },
        $unset: { leaseToken: "", leaseExpiresAt: "" },
      },
    );
  }
  async project(e: EventRecord) {
    const key = jobKey(e.event),
      now = new Date();
    const incoming = {
      ...key,
      version: e.event.version,
      status: e.event.operation === "archive" ? "archived" : "active",
      ...(e.event.operation === "upsert" ? { payload: e.event.payload } : {}),
      lastAppliedEventId: e.event.eventId,
      updatedAt: now,
    };
    const pipeline = [
      {
        $replaceWith: {
          $cond: [
            {
              $gt: [
                { $literal: e.event.version },
                { $ifNull: ["$version", 0] },
              ],
            },
            {
              $mergeObjects: [
                { $literal: incoming },
                {
                  _id: "$_id",
                  createdAt: { $ifNull: ["$createdAt", { $literal: now }] },
                },
              ],
            },
            "$$ROOT",
          ],
        },
      },
    ];
    try {
      const result = await this.store.jobs.updateOne(key, pipeline, {
        upsert: true,
      });
      return result.modifiedCount > 0 || result.upsertedCount > 0;
    } catch (error) {
      if (!duplicate(error)) throw error;
      const result = await this.store.jobs.updateOne(key, pipeline);
      return result.modifiedCount > 0;
    }
  }
  async tick(): Promise<boolean> {
    const e = await this.claim();
    if (!e) return false;
    const fence = {
      _id: e._id,
      leaseToken: e.leaseToken,
      status: "processing" as const,
    };
    const current = await this.store.jobs.findOne(jobKey(e.event));
    if (current && current.version >= e.event.version) {
      await this.finish(e, "stale");
      return true;
    }
    if (e.attemptCount >= 3) {
      await this.store.events.updateOne(fence, {
        $set: {
          status: "failed",
          lastError: "Attempt budget exhausted after interrupted processing",
          completedAt: new Date(),
        },
        $unset: { leaseToken: "", leaseExpiresAt: "" },
      });
      return true;
    }
    const attempt = e.attemptCount + 1;
    const attempts = e.attempts.map((a) =>
      a.finishedAt
        ? a
        : {
            ...a,
            finishedAt: new Date(),
            error: "Worker interrupted before result was recorded",
          },
    );
    attempts.push({ number: attempt, startedAt: new Date() });
    const started = await this.store.events.updateOne(fence, {
      $set: { attemptCount: attempt, attempts },
    });
    if (!started.matchedCount) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let code: number;
    try {
      code = await Promise.race([
        this.provider(e.event, attempt),
        new Promise<number>((resolve) => {
          timer = setTimeout(
            () => resolve(503),
            this.options.providerTimeoutMs,
          );
        }),
      ]);
    } catch {
      code = 503;
    } finally {
      clearTimeout(timer);
    }
    const error = code === 200 ? undefined : `Provider returned ${code}`;
    attempts[attempt - 1] = {
      ...attempts[attempt - 1]!,
      finishedAt: new Date(),
      code,
      ...(error ? { error } : {}),
    };
    const recorded = await this.store.events.updateOne(fence, {
      $set: { attempts, ...(error ? { lastError: error } : {}) },
    });
    if (!recorded.matchedCount) return true;
    if (code === 200) {
      const applied = await this.project(e);
      await this.options.afterProjection?.(e);
      await this.finish(e, applied ? "applied" : "stale");
      return true;
    }
    const retry = (code === 429 || code === 503) && attempt < 3;
    await this.store.events.updateOne(fence, {
      $set: {
        status: retry ? "retry_wait" : "failed",
        ...(retry
          ? {
              nextAttemptAt: new Date(
                Date.now() + this.options.backoffMs * 2 ** (attempt - 1),
              ),
            }
          : { completedAt: new Date() }),
      },
      $unset: { leaseToken: "", leaseExpiresAt: "" },
    });
    return true;
  }
  async run(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        if (await this.tick()) continue;
      } catch (error) {
        console.error(
          "Worker operation failed; lease will recover",
          error instanceof Error ? error.message : error,
        );
      }
      await sleep(this.options.pollMs);
    }
  }
}
