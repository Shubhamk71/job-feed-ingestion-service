import express, { type ErrorRequestHandler } from "express";
import { createHash } from "node:crypto";
import { ObjectId, type Filter } from "mongodb";
import { canonical, eventSchema, scopeSchema } from "./domain.js";
import { duplicate, type JobRecord, Store } from "./store.js";
export function app(store: Store) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.post("/events", async (req, res) => {
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid event", details: parsed.error.issues });
      return;
    }
    const e = parsed.data;
    const identity = {
      tenantId: e.tenantId,
      sourceId: e.sourceId,
      eventId: e.eventId,
    };
    const doc = canonical(req.body);
    const respond = (status: number, state: string) =>
      res.status(status).json({
        eventId: e.eventId,
        status: state,
        statusUrl: `/events/${encodeURIComponent(e.eventId)}?${new URLSearchParams({ tenantId: e.tenantId, sourceId: e.sourceId })}`,
      });
    const existing = await store.events.findOne(identity);
    if (existing) {
      if (existing.canonical !== doc)
        res
          .status(409)
          .json({ error: "Event identity reused with different content" });
      else respond(200, existing.status);
      return;
    }
    try {
      await store.events.insertOne({
        _id: new ObjectId(),
        ...identity,
        externalJobId: e.externalJobId,
        event: e,
        canonical: doc,
        status: "pending",
        attemptCount: 0,
        attempts: [],
        createdAt: new Date(),
        nextAttemptAt: new Date(),
      });
      respond(202, "pending");
    } catch (error) {
      if (!duplicate(error)) throw error;
      const winner = await store.events.findOne(identity);
      if (winner?.canonical === doc) respond(200, winner.status);
      else
        res
          .status(409)
          .json({ error: "Event identity reused with different content" });
    }
  });
  app.get("/events/:eventId", async (req, res) => {
    const scope = scopeSchema.safeParse(req.query);
    if (!scope.success || !scope.data.sourceId) {
      res.status(400).json({ error: "tenantId and sourceId required" });
      return;
    }
    const event = await store.events.findOne(
      { ...scope.data, eventId: req.params.eventId },
      { projection: { canonical: 0, leaseToken: 0 } },
    );
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    res.json(event);
  });
  app.get("/jobs", async (req, res) => {
    const scope = scopeSchema.safeParse(req.query);
    const status = req.query.status ?? "active";
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (
      !scope.success ||
      !["active", "archived", "all"].includes(String(status)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (req.query.limit !== undefined && typeof req.query.limit !== "string")
    ) {
      res
        .status(400)
        .json({ error: "Invalid scope, status, or limit (1–100)" });
      return;
    }
    const query: Filter<JobRecord> = { ...scope.data };
    if (status !== "all") query.status = status as "active" | "archived";
    const fingerprint = createHash("sha256")
      .update(canonical({ ...scope.data, status }))
      .digest("hex");
    if (req.query.cursor !== undefined) {
      try {
        if (typeof req.query.cursor !== "string") throw Error();
        const cursor = JSON.parse(
          Buffer.from(req.query.cursor, "base64url").toString(),
        ) as { id: string; scope: string };
        if (cursor.scope !== fingerprint || !ObjectId.isValid(cursor.id))
          throw Error();
        query._id = { $gt: new ObjectId(cursor.id) };
      } catch {
        res.status(400).json({ error: "Invalid cursor for this query" });
        return;
      }
    }
    const jobs = await store.jobs
      .find(query)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .toArray();
    const more = jobs.length > limit;
    if (more) jobs.pop();
    res.json({
      jobs,
      nextCursor: more
        ? Buffer.from(
            JSON.stringify({
              id: jobs.at(-1)!._id.toHexString(),
              scope: fingerprint,
            }),
          ).toString("base64url")
        : null,
    });
  });
  app.get("/health", async (_req, res) => {
    try {
      await store.client.db().command({ ping: 1 });
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  const errors: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status =
      err instanceof SyntaxError
        ? 400
        : typeof err === "object" &&
            err !== null &&
            "status" in err &&
            err.status === 413
          ? 413
          : 503;
    res.status(status).json({
      error:
        status === 400
          ? "Invalid JSON"
          : status === 413
            ? "Request too large"
            : "Service unavailable",
    });
  };
  app.use(errors);
  return app;
}
