# Walkthrough

1. Clean setup: `npm ci && npm run setup`. Wait for `/health` to return ready. Run `npm run demo` once against unused demo tenants. Expect two settled phases and the final PASS message.
2. Inspect `GET /jobs?tenantId=demo-a&status=all`: ghost is archived at version 3, ordered stays at 5, survivor advances to 3. Inspect retry/exhaust events with tenantId=demo-a and sourceId=main: each has three attempts; only retry completes.
3. Run `npm test` with reachable real MongoDB, or `docker compose exec api npm test`. Explain the child-process crash test: projection survives process exit 77, lease expires, new worker skips verification and acknowledges safely. Point to the unique indexes and conditional pipeline update.
4. Run `npm run load`. Explain why 1,000 events create 900 jobs (50 jobs have three versions), and why 200 repeats return 200.
5. Defend SCALE.md's 120-second burst calculation and its unmeasured production assumptions.
6. Show AI_USAGE.md and QC_REPORT.md, then make a small reviewed change with a regression test and rerun affected checks.

These are synthetic replacement fixtures. Official fixture compatibility and Docker execution remain explicit review items until the missing files/environment are available.
