import assert from "node:assert/strict";
import { evaluateRuntimeHealth } from "../src/runtime-health.mjs";

const now = Date.parse("2026-07-11T07:00:00Z");
const healthy = evaluateRuntimeHealth(
  { pid: 42, heartbeatAt: "2026-07-11T06:59:30Z", status: "ready" },
  { now, maxAgeMs: 90_000, isPidAlive: () => true },
);
assert.equal(healthy.ok, true);
assert.equal(healthy.ageMs, 30_000);

assert.equal(evaluateRuntimeHealth(null, { now }).ok, false);
assert.equal(
  evaluateRuntimeHealth(
    { pid: 42, heartbeatAt: "2026-07-11T06:58:00Z" },
    { now, maxAgeMs: 90_000, isPidAlive: () => true },
  ).ok,
  false,
);
assert.equal(
  evaluateRuntimeHealth(
    { pid: 42, heartbeatAt: "2026-07-11T06:59:30Z" },
    { now, maxAgeMs: 90_000, isPidAlive: () => false },
  ).ok,
  false,
);

console.log("RUNTIME_HEALTH_OK");
