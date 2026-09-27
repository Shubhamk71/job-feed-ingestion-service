import assert from "node:assert/strict";
import { scenario } from "./scenario.js";
import { eventSchema } from "../src/domain.js";
import { submit, settle, jobs, state } from "./client.js";
const fixtures = scenario();
for (const phase of [1, 2]) {
  const accepted = [];
  for (const fixture of fixtures.filter((f) => f.phase === phase)) {
    const response = await submit(fixture.body);
    assert.equal(response.status, fixture.http, JSON.stringify(fixture.body));
    await response.text();
    if ([200, 202].includes(fixture.http))
      accepted.push(eventSchema.parse(fixture.body));
  }
  await settle(accepted);
  const list = await jobs("demo-a");
  const main = list.filter((j) => j.sourceId === "main");
  assert.equal(
    main.find((j) => j.externalJobId === "survivor")?.version,
    phase === 1 ? 1 : 3,
  );
  assert.equal(
    main.find((j) => j.externalJobId === "ghost")?.status,
    "archived",
  );
  assert.equal(main.find((j) => j.externalJobId === "ordered")?.version, 5);
  assert.equal(
    main.some(
      (j) => j.externalJobId === "bad-job" || j.externalJobId === "exhaust-job",
    ),
    false,
  );
  console.log(`Phase ${phase} settled and projection assertions passed`);
}
for (const [eventId, count, status] of [
  ["retry", 3, "completed"],
  ["permanent", 1, "failed"],
  ["exhaust", 3, "failed"],
] as const) {
  const e = await state({ tenantId: "demo-a", sourceId: "main", eventId });
  assert.equal(e.attemptCount, count);
  assert.equal(e.status, status);
}
assert.equal((await jobs("demo-b")).length, 1);
assert.equal(
  (await jobs("demo-a")).filter((j) => j.externalJobId === "alpha").length,
  2,
);
console.log(
  "PASS: 20 synthetic requests, both phases, retries, failures, and isolation",
);
