# Design — initial implementation plan

The API durably inserts one event document before acknowledging acceptance. This same document is the work item, avoiding a separate enqueue failure. Unique compound indexes scope events by tenant/source/event and jobs by tenant/source/external job ID. Identifiers are never silently trimmed. Replay equality compares canonical original parsed JSON, before payload normalization; object key order is ignored and array order preserved.

Workers use atomic leased claims, persisted attempts and due timestamps. Claim tokens fence acknowledgments. Projection writes are atomic conditional updates: only a strictly greater version changes state. Archives retain tombstones. Projection and acknowledgment are separate writes; replay after a crash is harmless to the projection. This is at-least-once execution, not exactly-once external effects. A stale worker may apply a verified event, but cannot regress the projection or acknowledge another claim. Verification must be read-only or externally idempotent.

An attempt is consumed when its durable start record is written, before provider invocation. Crashes therefore consume an attempt. Recovery first checks for an already-applied/stale version; otherwise it retries within the three-attempt budget. Expired leases recover work without relying on process memory. Lease duration exceeds provider timeout; production long operations would renew leases.

No multi-document transactions are necessary: failed acceptance creates no acknowledged work; failed projection writes leave retryable leased work; failed acknowledgment leaves recoverable idempotent work. Majority+journal write concern is used. Local standalone MongoDB is sufficient for testing these single-document boundaries; production uses a replicated deployment.

Rejected alternatives: in-memory queues lose accepted work on restart; Redis/Kafka add a second durable system and an acceptance/enqueue atomicity problem, and are excluded from the core; transactions across provider calls hold resources without making external effects transactional.

The first likely bottleneck is queue polling/claim index contention and provider latency. We deliberately accept fixed polling and a shared collection for this small implementation. Same-version conflicting job content is outside the fixture contract: first successful projection wins; production should retain version fingerprints and quarantine conflicts for investigation.

Reads require tenant scope, with source mandatory for event identity lookup. Demo tenant IDs are trusted. Production must derive authorized tenants from authenticated credentials, enforce source permissions, and apply per-tenant quotas. Cursors provide a live traversal by immutable _id, not a snapshot: updates can change membership; newly inserted IDs above the cursor may appear and records moving behind it are not revisited.

Status meanings: pending = accepted; processing = leased; retry_wait = delayed retry; completed = applied or stale; failed = terminal. A completed stale event may have no provider attempts. Health means API/database/index readiness, not worker liveness.

## Final implementation boundaries

The API rejects unknown event/payload fields. Canonical JSON is stored directly rather than hashing it, avoiding hash-collision assumptions for replay equality; this costs storage. Invalid requests are checked before identity reservation. Concurrent insert losers read the winner and compare canonical JSON. All input values enter MongoDB through validated fields; aggregation literals protect dollar-prefixed display values.

The job update pipeline replaces state only when its incoming version exceeds the current version. A concurrent first-insert duplicate-key error retries as a non-upsert guarded update. The update result distinguishes applied from stale. Payload is removed on archive; the tombstone and version remain. Claims and acknowledgment are single-document operations. Claim tokens fence completion but do not provide exactly-once provider invocation. Infrastructure errors leave processing leases to expire; no work is silently discarded.

Worker result records can retain lastError after successful recovery as historical context. An interrupted attempt can have no finishedAt until recovery starts another attempt; if recovery discovers the version already applied or the budget exhausted, the missing result itself records the uncertainty. A lease can expire during prolonged DB stalls. An old worker's successfully verified projection write remains safe under the version guard, while its acknowledgment is fenced. Production cancellation/renewal is not implemented.

Health is registered only after startup connects and creates indexes; subsequent health calls ping MongoDB. It does not continuously re-audit indexes or provider/worker liveness. Core retention is indefinite; safe production retention is described in SCALE.md. No TTL deletes pending events or archive tombstones.
