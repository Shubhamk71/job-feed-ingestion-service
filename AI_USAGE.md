# AI usage

The supplied template was not included; this report uses the requested fields.

- Tool: OpenAI Codex (model family exposed as GPT-6; exact serving model identifier unavailable).
- Prompt summary: Read the job-feed assignment, propose a MERN architecture, then implement the service and verify it.
- Artifacts: TypeScript API, worker, validation, MongoDB indexes, tests, synthetic fixtures, demo/load scripts, Docker configuration, and design/submission documents. Implementation commit is identified in QC_REPORT.md.
- Accepted decisions: MongoDB event records double as durable queue items; original JSON canonicalization for replay; atomic monotonic job updates; token-fenced acknowledgment; persistent retry history; two workers.
- Corrections during execution: fixed strict TypeScript inference errors in the pagination script; corrected middleware lint compliance; changed projection outcomes to report stale when a concurrent newer version won; expanded recovery testing from an exception to actual child-process termination; restricted Vitest discovery to source tests after a clean build revealed duplicate execution from dist/.
- Verification: executable real-MongoDB tests, formatting/lint/type checks, demo, load measurements, and manual source/claim review. Actual commands/results and limits are in QC_REPORT.md. No fabricated benchmark or defect is claimed.
- Human responsibility: the candidate must personally review the source, interpret test evidence, and practice the walkthrough. This automated implementation and report do not constitute the assignment's required candidate self-review. No human review is claimed here.
- Privacy: only synthetic data; no production access, credentials, or private chat transcript committed.

Elapsed agent implementation time is recorded in QC_REPORT.md; candidate review time is not yet recorded.
