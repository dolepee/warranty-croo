import { parseRequirements } from "./config.mjs";

const DEFAULT_MAX_TIMEOUT_MS = 86_400_000;

export function normalizeWarrantyRequest(raw, options = {}) {
  const value = unwrapTextRequest(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("Warranty requirements must be a JSON object.");
  }

  const targetServiceId = typeof value.targetServiceId === "string" ? value.targetServiceId.trim() : "";
  if (!targetServiceId) return invalid("Warranty requires targetServiceId.");

  const allowedTargets = parseAllowedTargets(options.allowedTargetServiceIds);
  if (allowedTargets.length && !allowedTargets.includes(targetServiceId)) {
    return invalid(`target service is not allowlisted for supervised Warranty coverage: ${targetServiceId}`);
  }

  const targetRequirements = normalizeTargetRequirements(value.targetRequirements);
  if (!targetRequirements.ok) return invalid(targetRequirements.reason);

  const timeoutMs = normalizeTimeoutMs(value.timeoutMs, options.defaultTimeoutMs, options.maxTimeoutMs);
  if (!timeoutMs.ok) return invalid(timeoutMs.reason);

  return {
    ok: true,
    request: {
      targetServiceId,
      timeoutMs: timeoutMs.value,
      targetRequirements: targetRequirements.value,
    },
  };
}

export function parseAllowedTargets(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function parseUsdcAtomic(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return BigInt(Math.trunc(value));
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
  if (/^\d+\.\d+$/.test(trimmed)) return BigInt(trimmed.split(".")[0]);
  return null;
}

export function usdcToAtomic(value) {
  if (typeof value === "bigint") return value;
  const text = String(value ?? "").trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function unwrapTextRequest(raw) {
  const value = raw && typeof raw === "object" && typeof raw.text === "string"
    ? parseRequirements(raw.text)
    : raw;
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function normalizeTargetRequirements(value) {
  const parsed = typeof value === "string" ? parseRequirements(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid("Warranty requires targetRequirements as a JSON object.");
  }
  return { ok: true, value: parsed };
}

function normalizeTimeoutMs(value, defaultTimeoutMs = 600_000, maxTimeoutMs = DEFAULT_MAX_TIMEOUT_MS) {
  const raw = value === undefined || value === null || value === "" ? defaultTimeoutMs : Number(value);
  if (!Number.isFinite(raw) || raw < 1_000) return invalid("timeoutMs must be at least 1000 milliseconds.");
  const max = Number(maxTimeoutMs || DEFAULT_MAX_TIMEOUT_MS);
  if (raw > max) return invalid(`timeoutMs must be no more than ${max} milliseconds.`);
  return { ok: true, value: Math.trunc(raw) };
}

function invalid(reason) {
  return { ok: false, reason };
}
