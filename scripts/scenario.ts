import type { JobEvent } from "../src/domain.js";
export const sample = (
  eventId: string,
  externalJobId = eventId,
  version = 1,
  tenantId = "demo-a",
  sourceId = "main",
): JobEvent => ({
  tenantId,
  sourceId,
  eventId,
  externalJobId,
  version,
  operation: "upsert",
  payload: {
    title: " Developer ",
    company: " Example ",
    location: " Surat ",
    experienceMin: 1,
    experienceMax: 3,
    applyUrl: "https://example.test/jobs/alpha",
    skills: [" TypeScript ", "MongoDB", "typescript"],
  },
});
export type RequestFixture = { phase: 1 | 2; body: unknown; http: number };
export function scenario(): RequestFixture[] {
  const first = sample("first", "alpha");
  return [
    { phase: 1, body: first, http: 202 },
    { phase: 1, body: JSON.parse(JSON.stringify(first)), http: 200 },
    { phase: 1, body: { ...first, version: 2 }, http: 409 },
    {
      phase: 1,
      body: { ...sample("corrected", "beta"), version: 0 },
      http: 400,
    },
    { phase: 1, body: sample("corrected", "beta"), http: 202 },
    {
      phase: 1,
      body: {
        tenantId: "demo-a",
        sourceId: "main",
        eventId: "archive",
        externalJobId: "ghost",
        version: 3,
        operation: "archive",
      },
      http: 202,
    },
    { phase: 1, body: sample("first", "alpha", 1, "demo-b"), http: 202 },
    {
      phase: 1,
      body: sample("first", "alpha", 1, "demo-a", "secondary"),
      http: 202,
    },
    { phase: 1, body: sample("retry", "retry-job"), http: 202 },
    { phase: 1, body: sample("permanent", "bad-job"), http: 202 },
    { phase: 1, body: sample("exhaust", "exhaust-job"), http: 202 },
    { phase: 1, body: sample("base", "survivor"), http: 202 },
    { phase: 1, body: sample("failed-high", "survivor", 2), http: 202 },
    { phase: 1, body: { ...sample("bad-id"), tenantId: " demo-a" }, http: 400 },
    { phase: 1, body: sample("newest", "ordered", 5), http: 202 },
    { phase: 2, body: sample("delayed", "ghost", 2), http: 202 },
    { phase: 2, body: sample("old", "ordered", 2), http: 202 },
    { phase: 2, body: sample("equivalent", "alpha"), http: 202 },
    { phase: 2, body: sample("later-success", "survivor", 3), http: 202 },
    { phase: 2, body: first, http: 200 },
  ];
}
