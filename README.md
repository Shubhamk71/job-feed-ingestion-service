# Jobfeed

A strict TypeScript/Express/MongoDB service for durable asynchronous job ingestion. Two workers compete for leased events. Atomic version guards preserve the latest successfully verified job state, including archive tombstones. No frontend is required by the assignment; this implementation focuses on its reliability requirements.

## Setup and demo

Requirements: Node.js 22+ and Docker Compose. From a clean checkout, the one setup command is:

```sh
npm ci && npm run setup
```

Wait for `curl http://127.0.0.1:3000/health` to return `{"status":"ready"}`, then run the one demo command:

```sh
npm run demo
```

The demo expects a database without previous `demo-a`/`demo-b` events. It asserts 20 HTTP submissions, drains phase 1, then submits/drains phase 2 and checks outcomes. It does not delete data. To repeat safely, use a new database via the native setup below. Docker volume data survives container restart; `docker compose down` preserves it.

**Fixture limitation:** Only the assignment text was supplied. `scripts/scenario.ts` and `fixtures/provider-plan.json` are our synthetic replacements, not the missing official fixture pack. AI/QC report templates were also absent. Replace/adapt these fixtures once the official files are available; the business logic contains no fixture IDs.

## Native setup

With MongoDB already running at `127.0.0.1:27017`:

```sh
npm ci
MONGO_DB=jobfeed_fresh npm run dev
```

This starts the API and two independent worker loops. `npm run api` and `npm run worker` can instead run in separate processes. Environment variables are read from the shell; `.env.example` documents them, but `.env` is not automatically loaded. Choose a fresh database name for a fresh demo. `API_URL` selects the server for demo/load scripts.

## API

| Endpoint                                                         | Behavior                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `POST /events`                                                   | One JSON event; 202 durable acceptance, 200 exact replay, 409 conflicting identity, 400 invalid event    |
| `GET /jobs?tenantId=demo-a&sourceId=main&status=active&limit=20` | Tenant required; source optional; active (default), archived, or all; limit 1–100                        |
| `GET /events/first?tenantId=demo-a&sourceId=main`                | Both scope identifiers required; processing state, normalized event, attempts, last error; 404 if absent |
| `GET /health`                                                    | 200 API/database ready; 503 dependency unavailable                                                       |

```sh
curl -i http://127.0.0.1:3000/events \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"example","sourceId":"main","eventId":"e1","externalJobId":"job1","version":1,"operation":"upsert","payload":{"title":"Developer","company":"Example","location":"Surat","experienceMin":1,"experienceMax":3,"applyUrl":"https://example.test/job1","skills":[" TypeScript ","typescript"]}}'
```

An archive contains the same identity/version fields and `"operation":"archive"`, with no payload. Unknown fields are rejected. Identifiers reject surrounding whitespace; display strings are trimmed; skills are lowercased and deduplicated in first-occurrence order. Request bodies are capped at 64 KB (413 above the cap). A 503 does not prove an insert failed: retry the same event identity/document to resolve ambiguous acceptance safely.

Replay equality is based on the original parsed JSON: object-key order is ignored, array order is significant, and normalization does not erase content differences. `statusUrl` points to the existing event on both acceptance and replay.

List results contain `jobs` and `nextCursor`. Pass the opaque cursor with the same tenant/source/status. The immutable `_id` order is deterministic, but pagination is a live view, not a snapshot: records changing status can leave/enter the filter, and later inserts beyond the cursor may appear. Limit can change between pages.

Event statuses: `pending`, `processing`, `retry_wait`, `completed`, `failed`. Completed outcomes are `applied` or `stale`. `lastError` retains the last observed provider error even after eventual success; inspect status for final success. Stale events may have zero attempts.

## Provider and recovery

`PROVIDER_PLAN` points to JSON mapping `JSON.stringify([tenantId, sourceId, eventId])` to attempt status arrays, e.g. `[429,503,200]`. Missing entries/attempts default to 200. This adapter is a local fake, not a network service. Official fixture encoding may require an adapter when supplied.

429/503 retry at configurable exponential delays (default 1s, 2s), maximum three durably started attempts. 422 and other non-success, non-retryable responses fail immediately. Timeout/exception maps to 503. A crash consumes a started attempt; an expired lease recovers work. If its version is already projected, recovery completes without verifying again. Read-only/idempotent verification is required because invocation can repeat after a crash. Real network providers should support cancellation; this fake timeout wrapper does not cancel an arbitrary underlying promise.

## Checks

With local MongoDB running (or set `MONGO_URL` to a reachable test database server):

```sh
npm run check
npm run build
npm run load
```

Tests create and drop only a randomly named `test_...` database. They require permissions to create indexes and drop that test database. Docker's MongoDB is intentionally not exposed to the host; to run tests with Compose use `docker compose exec api npm test`.

The load scenario uses a unique `load-...` tenant, 1,000 distinct events, 200 replays, 50 out-of-order jobs, and bounded concurrency (default 20, configurable via `LOAD_CONCURRENCY`). It checks all 900 final jobs and waits for every event to complete. Drain time includes status-polling overhead.

## Submission and limits

See DESIGN.md, SCALE.md, AI_USAGE.md, QC_REPORT.md, and DEMO.md. No credentials or production data are needed. Production authentication, rate limits, tenant fairness, retention cleanup, metrics export, sharding, and lease renewal are design work, not implemented features. Queue workers retry infrastructure failures after the poll interval; prolonged database outages need production alerting/backpressure.

Local Docker execution must still be verified on a Docker-equipped machine. Repository hosting/reviewer access is not configured. Get the final local SHA with `git rev-parse HEAD`; QC_REPORT.md references the tested implementation SHA. Record any additional human work and rerun affected checks after changes.
