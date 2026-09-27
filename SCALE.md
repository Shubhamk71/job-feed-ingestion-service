# Capacity and growth design

These are explicit planning assumptions, not production benchmark claims. The core implements a shared MongoDB queue, two loops by default, and local fake verification. It does not implement the admission, partitioning, metrics, or retention systems below.

## Rates and worker capacity

100,000/day averages 1.157 events/s; 10 million/day averages 115.741/s. A 5,000/s burst needs an explicit duration. Assume production verification plus DB work occupies a worker slot for 50 ms, with 1.1 attempts/event on average and a 70% utilization budget. At 160 concurrent slots across processes, conservative capacity is `160 / 0.050 / 1.1 * 0.70 = 2,036` events/s. Round DOWN to 2,000/s for planning. This capacity must be demonstrated against the real provider and replicated database; it is not implied by the local benchmark.

Starting empty, a 120-second burst at 5,000/s with service capacity 2,000/s builds `(5000-2000)*120 = 360,000` events. Queue waiting time at burst end is about `360000/2000 = 180s`; drain after the burst at normal 115.741/s traffic takes `360000/(2000-115.741) = 191.1s`. The maximum queue delay is around 180 seconds, within five minutes, plus processing/retry delay. FIFO approximation assumes no noisy-tenant starvation and bounded retries. Design admission threshold: 480,000 queued events (240s of service), leaving about 60s for retry/provider uncertainty. This threshold supports about `480000/3000 = 160s` of the specified burst from empty. We promise only 120s in this example; sustained longer bursts require extra capacity or rejection before acceptance.

A full 5,000/s sustained rate under the same assumptions needs at least `5000*.050*1.1/.70 = 393` slots, and separately verified database/provider capacity. Slots alone cannot remove DB write contention. With approximately six event/projection writes per successfully applied event (insert, claim, attempt start, result, projection, completion), 2,000 events/s implies roughly 12,000 logical writes/s plus reads/index maintenance; acceptance during bursts independently demands 5,000 inserts/s. Stale work is cheaper. Retries and crashes add costs.

## Storage and retention

At 1 KB raw/event, seven days at 10 million/day is 70 GB decimal of raw payload. Current code stores canonical original JSON and normalized event data, roughly doubling payload storage. Budget 1 KB metadata/history per event, giving around 210 GB primary logical event data before compression. Assume ~300 bytes/event combined index cost: ~21 GB more. At ~2 KB/job including indexes, one million projections add ~2 GB. Three data-bearing replicas imply approximately 699 GB logical replicated storage under these assumptions, before oplog, backups, fragmentation, and 30–50% free headroom. Measure BSON/index sizes and compression against actual data.

There is intentionally NO TTL in the core: deleting accepted pending work or tombstones would violate correctness, and deleting identity records loses replay protection. Production separates raw bodies (TTL after at least seven days, and only after terminal completion or external archival) from compact identity/fingerprint records. Exact arbitrary replay equality requires retaining canonical documents or adopting a documented collision-resistant hash comparison policy. Keeping replay IDs forever is unbounded storage; negotiate an explicit replay horizon or archive searchable identity records. Job tombstones retain their maximum version for as long as old events may arrive. A terminal failure summary should outlive its raw payload under the documented observability policy.

## Indexes, hot keys, and sharding

Implemented indexes are in src/store.ts: unique event identity, due work, expired leases, unique job identity, and four tenant/source/status list combinations. Extra list indexes deliberately trade writes/storage for predictable reads. Query-plan validation and production cardinality measurements are required before scale-up.

Repeated updates to one job serialize on one document. A huge tenant can dominate the queue. Proposed partitioning: assign a stable partition from a hash of `(tenantId,sourceId)` and route claims by partition, then apply round-robin tenant scheduling with per-tenant in-flight limits. This keeps a tenant/source together but cannot split an exceptionally hot source; introducing finer job-based routing makes replay uniqueness more complex because event identity does not include job ID.

For sharding, a possible ranged shard key is `{tenantId:1, sourceId:1}`. The existing compound unique event and job indexes both include that shard-key prefix, preserving MongoDB's unique-index constraint. Pre-split/distribute tenant/source ranges; a large single tenant/source remains a hot chunk. Avoid claiming that a hashed shard key automatically preserves these unique constraints. Queue workers should target assigned tenant/source partitions rather than scatter-gather claims. Resolve a hot source with routing/identity design changes, not an unsupported uniqueness claim.

## Protection and observability

Reject excess requests with 429 plus Retry-After BEFORE durable acceptance when queue age/depth, tenant quotas, or DB saturation exceed limits. Return 503 for dependency failures. Already accepted work must remain durable and drain. Bound connection pools, worker concurrency, body sizes, retry counts, and HTTP in-flight requests. Current code bounds body size, worker slots, page size, and provider attempts; production HTTP admission limits remain to implement.

Use exponential backoff with jitter and a provider-wide concurrency/rate budget in production. The exercise uses deterministic increasing backoff for repeatable checks. Stop admitting low-priority/noisy tenants before starving others; separate provider retry capacity from fresh work to prevent storms.

Metrics: accepted/replayed/conflicting/rejected requests, HTTP latency, oldest eligible and total outstanding event age, acceptance-to-terminal p50/p95/p99, claim conflicts/lease recovery, retry/422/exhaustion rates, provider latency, per-tenant backlog, pool wait time, MongoDB CPU/I/O/cache eviction/replication lag. Alert on oldest accepted age >180s (warning), >240s (page), sustained pool saturation, rising failures, or missing worker progress. Readiness is not a worker-liveness metric.

Add a separate broker when polling/index contention, global fairness, or isolation requirements exceed MongoDB queue capacity. Retain MongoDB acceptance plus an outbox/CDC publishing path to avoid losing work between DB insertion and broker publication. Consumers remain idempotent and version guarded. Benchmark a partitioned queue before promising the five-minute objective under real verification costs.

## Local measurement

The reproducible command is `npm run load`; final measured environment/counts/latencies are recorded in QC_REPORT.md. Fake provider calls are instantaneous, data fits in memory, and local standalone MongoDB differs from production replication. Do not extrapolate local throughput linearly to production.
