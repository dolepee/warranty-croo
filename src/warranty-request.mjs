import { parseRequirements } from "./config.mjs";

const DEFAULT_MIN_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TIMEOUT_MS = 3_600_000;

export function normalizeWarrantyRequest(raw, options = {}) {
  const value = unwrapTextRequest(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("Warranty requirements must be a JSON object.");
  }

  const targetServiceId = typeof value.targetServiceId === "string" ? value.targetServiceId.trim() : "";
  if (!targetServiceId) return invalid("Warranty requires targetServiceId.");

  const allowedTargets = parseAllowedTargets(options.allowedTargetServiceIds);
  if (!allowedTargets.length) {
    return invalid("Warranty target allowlist is unavailable; coverage is closed.");
  }
  if (!allowedTargets.includes(targetServiceId)) {
    return invalid(`target service is not allowlisted for supervised Warranty coverage: ${targetServiceId}`);
  }

  const targetRequirements = normalizeTargetRequirements(value.targetRequirements);
  if (!targetRequirements.ok) return invalid(targetRequirements.reason);

  const timeoutMs = normalizeTimeoutMs(
    value.timeoutMs,
    options.defaultTimeoutMs,
    options.minTimeoutMs,
    options.maxTimeoutMs,
  );
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
  const malformedHexPath = findWhitespaceCorruptedHex(parsed);
  if (malformedHexPath) {
    return invalid(`targetRequirements.${malformedHexPath} looks like hex data but contains whitespace.`);
  }
  return { ok: true, value: parsed };
}

function findWhitespaceCorruptedHex(value, path = "") {
  if (typeof value === "string") {
    return /^0x/i.test(value) && /\s/.test(value) ? path || "value" : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const match = findWhitespaceCorruptedHex(value[index], `${path}[${index}]`);
      if (match) return match;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    const match = findWhitespaceCorruptedHex(nested, path ? `${path}.${key}` : key);
    if (match) return match;
  }
  return null;
}

function normalizeTimeoutMs(
  value,
  defaultTimeoutMs = 600_000,
  minTimeoutMs = DEFAULT_MIN_TIMEOUT_MS,
  maxTimeoutMs = DEFAULT_MAX_TIMEOUT_MS,
) {
  const raw = value === undefined || value === null || value === "" ? defaultTimeoutMs : Number(value);
  const min = Number(minTimeoutMs || DEFAULT_MIN_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw < min) return invalid(`timeoutMs must be at least ${min} milliseconds.`);
  const max = Number(maxTimeoutMs || DEFAULT_MAX_TIMEOUT_MS);
  if (raw > max) return invalid(`timeoutMs must be no more than ${max} milliseconds.`);
  return { ok: true, value: Math.trunc(raw) };
}

function invalid(reason) {
  return { ok: false, reason };
}
