# Final QC report

## Identity, time, environment

- Tested implementation SHA: `74f8e459ee3bfa518093eadef38da38c9d973161`.
- Final submission commit: the subsequent `docs: record final executed QC evidence` commit, containing only this report. Obtain its full SHA with `git rev-parse HEAD`; the final handoff also records it. No code changes occur in that report commit.
- Date: 2026-09-27, Asia/Kolkata. Early design commit at 16:20; final implementation checks and scenario execution at approximately 16:31–16:32. Approximately 15 minutes of agent work including pre-commit inspection/setup; this is an elapsed estimate, not eight hours of claimed human work. Candidate personal review/walkthrough time is not yet recorded.
- macOS arm64, Apple M2, 8 CPU cores, 17.18 GB RAM (decimal), Node 22.20.0, npm 11.6.2, real native MongoDB 8.2.0 standalone with journaling, default two worker loops. Compose specifies MongoDB 8.0; that image has not been run here.
- Docker is not installed. The official scenario/provider files and report templates were not attached. Reports and fixtures are locally authored replacements, labeled as such.

## Executed commands and results

| Command                                                                  | Actual result                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `npm ci`                                                                 | PASS: clean lockfile installation, 220 packages added, zero reported vulnerabilities                   |
| `npm run format:check`                                                   | PASS: all matched files formatted                                                                      |
| `npm run lint`                                                           | PASS                                                                                                   |
| `npm run typecheck`                                                      | PASS: strict TypeScript                                                                                |
| `npm test`                                                               | PASS: 13 tests, one source test file; final run ~1.54 seconds                                          |
| `npm run build`                                                          | PASS                                                                                                   |
| `npm audit --omit=dev`                                                   | PASS: zero reported vulnerabilities at execution time; not a security guarantee                        |
| `MONGO_DB=jobfeed_final_qc_20260927 PORT=3002 node dist/src/main.js all` | PASS: fresh named database, API ready, two worker loops                                                |
| `API_URL=http://127.0.0.1:3002 npm run demo`                             | PASS: all 20 synthetic HTTP expectations, both phases drained, final projection/retry/isolation checks |
| `API_URL=http://127.0.0.1:3002 npm run load`                             | PASS: exact counts, all 900 final projections and every event completion checked                       |
| `npm run setup` / Docker Compose build/start                             | NOT RUN: Docker absent; native clean installation and compiled-service setup used instead              |
| Official supplied fixture scenario                                       | NOT RUN: files absent                                                                                  |

Initial sandboxed DB startup/tests hit local socket/network EPERM; approved local-network execution resolved this. No application concurrency failure was hidden by mocks. Earlier code checks exposed strict inference and lint issues, which were fixed. After building, Vitest discovered both source and compiled tests; a dedicated include pattern fixed duplicate discovery. Final tests execute 13 distinct cases once.

## Final measured load

Tenant `load-1790506907460`, HTTP concurrency 20, default backoff 1s/2s, lease 10s, polling 100ms, fake provider default success. Server was the compiled application, against an otherwise fresh database after the demo. Other idle local service instances were present, so the machine was not an isolated benchmark host.

- 1,000 distinct requests accepted with 202.
- 200 exact replays returned 200.
- Zero other HTTP statuses and no transport errors.
- HTTP p50: 7.014 ms; p95: 14.820 ms.
- Submission duration: 485.625 ms.
- Drain after submission: 1,024.824 ms, including polling/inspection overhead.
- End-to-end load duration: 1,510.449 ms.
- Final jobs: 900; all version checks passed, including 50 jobs receiving versions 3, 1, 2 in submission order.

These are measured local fake-provider results. SCALE.md's 2,000/s production service rate is an explicit unverified planning assumption, not an extrapolation of this run.

## Failure hypotheses challenged

1. **Two identical requests create duplicate work.** Twenty concurrent POSTs produced exactly one 202, nineteen 200s, and one database event. Real MongoDB unique index enforced identity. Conflicting reuse and corrected reuse after 400 also passed.
2. **A slower old version overwrites a newer job, or two first inserts create duplicate jobs.** Delayed verification reversed completion order; final version stayed 5. Concurrent pipeline upserts of versions 1/2 yielded one version-2 job. Dollar-prefixed titles remained literal data. Archive-before-upsert plus delayed version 2 retained the version-3 tombstone.
3. **A process dies after projection and accepted work is lost or applied twice.** A child worker exits with code 77 inside the post-projection/pre-ack hook. Database work remains processing. After lease expiry and API/database-client restart, replacement workers complete it without a second logical job. Replay still returns 200. An additional test confirms old lease tokens cannot complete a reclaimed event.
4. **Retries spin or change projection after verification failure.** Real attempt timestamps prove >=20ms then >=40ms configured test delays; retry success takes three attempts, 422 takes one, exhaustion takes three and remains failed. A failed higher version leaves the lower successful version visible; later success advances it.
5. **Documentation overstates readiness, replay, retention, or capacity.** Compared README/API examples, source indexes, worker defaults, and SCALE.md. Health only establishes API/database readiness; lastError may remain after success; pagination is live; core has no TTL or fairness/admission implementation; production throughput is assumed. Corrected outcome reporting so a lost version race is marked stale. Missing Docker/official fixture evidence is explicitly disclosed.

## Input, scoping, and dependency review

All event identities and read scopes pass schema validation. MongoDB query objects are constructed internally, never taken directly from request JSON. Tenant is mandatory for reads; source is mandatory to resolve an event. Malformed JSON and object-shaped injection inputs are rejected. Body/page sizes and worker concurrency are bounded. Dynamic aggregation content is protected with `$literal`. API errors omit database details; .env, node_modules, local DB files, and build output are ignored. No credentials or real-user data were added. Demo tenant IDs are trusted, as allowed; authentication/authorization and production rate limiting remain design items. Dependencies are locked and the production audit returned zero advisories.

## Limits and remaining handoff

- Candidate personal review is mandatory and not performed by this agent on their behalf. AI review plus executable checks does not establish human understanding.
- Obtain official fixtures/templates and run their exact scenario. Validate Compose on a Docker-equipped machine, including its MongoDB 8.0 image.
- Native tests cover API/client restart and a real worker process crash. They do not simulate primary failover, machine power loss, storage corruption, or provider external side-effect duplication.
- No retained monitoring exporter, production authentication, admission quotas, tenant fairness, TTL cleanup, shard implementation, or frontend. These are not claimed as implemented.
- The core retains event records indefinitely; production retention/replay policy requires a separate design rollout.
- No hosted repository URL/reviewer permissions are configured. Local Git has early design, implementation, test correction, and QC commits. Publish only after the candidate reviews the submission.
- If code/generated non-QC documentation changes after this report, rerun affected checks and update the tested SHA and evidence.
