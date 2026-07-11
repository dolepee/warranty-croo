import { execFileSync } from "node:child_process";
import { readRuntimeHealth, evaluateRuntimeHealth } from "./runtime-health.mjs";

const label = process.env.WARRANTY_LAUNCHD_LABEL || "com.dolepee.warranty-provider";
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

if (result.ok) {
  console.log(JSON.stringify({ ok: true, action: "none", ...result }));
  process.exit(0);
}

const target = `gui/${process.getuid()}/${label}`;
execFileSync("/bin/launchctl", ["kickstart", "-k", target], { stdio: "inherit" });
console.warn(JSON.stringify({ ok: false, action: "restarted", target, reason: result.reason }));
