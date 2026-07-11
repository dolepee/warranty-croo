import { readRuntimeHealth, evaluateRuntimeHealth } from "./runtime-health.mjs";

const maxAgeSeconds = Number(process.env.WARRANTY_HEALTH_MAX_AGE_SECONDS || "90");
if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 30 || maxAgeSeconds > 600) {
  throw new Error("WARRANTY_HEALTH_MAX_AGE_SECONDS must be an integer between 30 and 600.");
}

let result;
try {
  result = evaluateRuntimeHealth(await readRuntimeHealth(), { maxAgeMs: maxAgeSeconds * 1000 });
} catch (error) {
  result = { ok: false, reason: `cannot read worker health: ${error.message}` };
}

console.log(JSON.stringify(result));
if (!result.ok) process.exit(1);
