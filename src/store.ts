import { MongoClient, ObjectId, type Collection } from "mongodb";
import type { JobEvent } from "./domain.js";
export type Attempt = {
  number: number;
  startedAt: Date;
  finishedAt?: Date;
  code?: number;
  error?: string;
};
export type EventRecord = {
  _id: ObjectId;
  tenantId: string;
  sourceId: string;
  eventId: string;
  externalJobId: string;
  event: JobEvent;
  canonical: string;
  status: "pending" | "processing" | "retry_wait" | "completed" | "failed";
  attemptCount: number;
  attempts: Attempt[];
  createdAt: Date;
  nextAttemptAt: Date;
  leaseToken?: string;
  leaseExpiresAt?: Date;
  completedAt?: Date;
  lastError?: string;
  outcome?: "applied" | "stale";
};
export type JobRecord = {
  _id: ObjectId;
  tenantId: string;
  sourceId: string;
  externalJobId: string;
  version: number;
  status: "active" | "archived";
  payload?: Extract<JobEvent, { operation: "upsert" }>["payload"];
  lastAppliedEventId: string;
  createdAt: Date;
  updatedAt: Date;
};
export class Store {
  client: MongoClient;
  events: Collection<EventRecord>;
  jobs: Collection<JobRecord>;
  constructor(
    url = process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017",
    name = process.env.MONGO_DB ?? "jobfeed",
  ) {
    this.client = new MongoClient(url, {
      writeConcern: { w: "majority", j: true },
      serverSelectionTimeoutMS: 3000,
    });
    const db = this.client.db(name);
    this.events = db.collection("events");
    this.jobs = db.collection("jobs");
  }
  async open() {
    await this.client.connect();
    await this.events.createIndexes([
      {
        key: { tenantId: 1, sourceId: 1, eventId: 1 },
        unique: true,
        name: "event_identity",
      },
      { key: { status: 1, nextAttemptAt: 1, createdAt: 1 }, name: "due_work" },
      { key: { status: 1, leaseExpiresAt: 1 }, name: "expired_leases" },
    ]);
    await this.jobs.createIndexes([
      {
        key: { tenantId: 1, sourceId: 1, externalJobId: 1 },
        unique: true,
        name: "job_identity",
      },
      { key: { tenantId: 1, status: 1, _id: 1 } },
      { key: { tenantId: 1, sourceId: 1, status: 1, _id: 1 } },
      { key: { tenantId: 1, _id: 1 } },
      { key: { tenantId: 1, sourceId: 1, _id: 1 } },
    ]);
  }
  async close() {
    await this.client.close();
  }
}
export function jobKey(e: JobEvent) {
  return {
    tenantId: e.tenantId,
    sourceId: e.sourceId,
    externalJobId: e.externalJobId,
  };
}
export function duplicate(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 11000
  );
}
