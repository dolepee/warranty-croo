import { getAddress } from "viem";
import { BASE_USDC } from "./config.mjs";
import { parseAllowedTargets, parseUsdcAtomic, usdcToAtomic } from "./warranty-request.mjs";

export const HARD_MAX_COVERAGE_ATOMIC = 500_000n;
export const DEFAULT_MIN_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_TIMEOUT_MS = 3_600_000;

export function loadWarrantyPolicy(env = process.env) {
  const allowedTargetServiceIds = parseAllowedTargets(env.WARRANTY_ALLOWED_TARGET_SERVICE_IDS);
  if (!allowedTargetServiceIds.length) {
    throw new Error("WARRANTY_ALLOWED_TARGET_SERVICE_IDS must contain at least one service ID; Warranty fails closed.");
  }

  const coverageCapAtomic = parseUsdcConfig(env.WARRANTY_COVERAGE_CAP_USDC || "0.5", "WARRANTY_COVERAGE_CAP_USDC");
  if (coverageCapAtomic <= 0n || coverageCapAtomic > HARD_MAX_COVERAGE_ATOMIC) {
    throw new Error("WARRANTY_COVERAGE_CAP_USDC must be greater than 0 and no more than 0.5 USDC.");
  }

  const maxTargetPriceAtomic = parseUsdcConfig(
    env.WARRANTY_MAX_TARGET_PRICE_USDC || "0.10",
    "WARRANTY_MAX_TARGET_PRICE_USDC",
  );
  if (maxTargetPriceAtomic <= 0n || maxTargetPriceAtomic > coverageCapAtomic) {
    throw new Error("WARRANTY_MAX_TARGET_PRICE_USDC must be positive and no greater than the coverage cap.");
  }

  const minTimeoutMs = parseSeconds(env.WARRANTY_MIN_TIMEOUT_SECONDS || "60", "WARRANTY_MIN_TIMEOUT_SECONDS") * 1000;
  const maxTimeoutMs = parseSeconds(env.WARRANTY_MAX_TIMEOUT_SECONDS || "3600", "WARRANTY_MAX_TIMEOUT_SECONDS") * 1000;
  const defaultTimeoutMs = parseSeconds(
    env.WARRANTY_TARGET_TIMEOUT_SECONDS || "600",
    "WARRANTY_TARGET_TIMEOUT_SECONDS",
  ) * 1000;
  if (minTimeoutMs < DEFAULT_MIN_TIMEOUT_MS || maxTimeoutMs > DEFAULT_MAX_TIMEOUT_MS || minTimeoutMs > maxTimeoutMs) {
    throw new Error("Warranty timeout bounds must stay between 60 and 3600 seconds.");
  }
  if (defaultTimeoutMs < minTimeoutMs || defaultTimeoutMs > maxTimeoutMs) {
    throw new Error("WARRANTY_TARGET_TIMEOUT_SECONDS must be inside the configured timeout bounds.");
  }

  const maxOrdersPerBuyerWindow = parsePositiveInteger(
    env.WARRANTY_MAX_ORDERS_PER_BUYER_WINDOW || "1",
    "WARRANTY_MAX_ORDERS_PER_BUYER_WINDOW",
  );
  const buyerWindowMs = parsePositiveInteger(
    env.WARRANTY_BUYER_WINDOW_SECONDS || "86400",
    "WARRANTY_BUYER_WINDOW_SECONDS",
  ) * 1000;

  return {
    allowedTargetServiceIds,
    baseUsdc: getAddress(env.BASE_USDC || BASE_USDC),
    coverageCapAtomic,
    maxTargetPriceAtomic,
    minTimeoutMs,
    maxTimeoutMs,
    defaultTimeoutMs,
    targetAcceptMs: parseSeconds(env.WARRANTY_TARGET_ACCEPT_SECONDS || "180", "WARRANTY_TARGET_ACCEPT_SECONDS") * 1000,
    maxOrdersPerBuyerWindow,
    buyerWindowMs,
    refundDryRun: String(env.WARRANTY_REFUND_DRY_RUN || "1") !== "0",
  };
}

export function validateIncomingCoverage(order, policy) {
  let token;
  try {
    token = getAddress(order.paymentToken || "");
  } catch {
    return invalid("Warranty only covers payments made in Base USDC.");
  }
  if (token !== policy.baseUsdc) return invalid("Warranty only covers payments made in Base USDC.");

  const reportedPriceAtomic = parseUsdcAtomic(order.price);
  const feeAmountAtomic = parseUsdcAtomic(order.feeAmount);
  const amountAtomic = feeAmountAtomic && feeAmountAtomic > 0n ? feeAmountAtomic : reportedPriceAtomic;
  if (amountAtomic === null || amountAtomic <= 0n) return invalid("Warranty order price must be a positive Base USDC amount.");
  const fundAmountAtomic = parseUsdcAtomic(order.fundAmount) || 0n;
  if (fundAmountAtomic > 0n) return invalid("Warranty does not accept incoming fund-transfer orders.");
  if (amountAtomic > policy.coverageCapAtomic) {
    return invalid(`Warranty coverage is capped at ${policy.coverageCapAtomic} atomic USDC per order.`);
  }
  return { ok: true, amountAtomic, token };
}

export function validateTargetOrder(order, policy) {
  let token;
  try {
    token = getAddress(order.paymentToken || "");
  } catch {
    return invalid("Target order is outside Warranty policy: payment token is not Base USDC.");
  }
  if (token !== policy.baseUsdc) {
    return invalid("Target order is outside Warranty policy: payment token is not Base USDC.");
  }

  const reportedPriceAtomic = parseUsdcAtomic(order.price);
  const feeAmountAtomic = parseUsdcAtomic(order.feeAmount);
  const escrowFeeAtomic = feeAmountAtomic && feeAmountAtomic > 0n ? feeAmountAtomic : reportedPriceAtomic;
  if (escrowFeeAtomic === null || escrowFeeAtomic <= 0n) {
    return invalid("Target order is outside Warranty policy: actual escrow fee is unavailable or zero.");
  }

  const fundAmountAtomic = parseUsdcAtomic(order.fundAmount) || 0n;
  if (fundAmountAtomic > 0n) {
    let fundToken;
    try {
      fundToken = getAddress(order.fundToken || "");
    } catch {
      return invalid("Target order is outside Warranty policy: fund-transfer token is invalid.");
    }
    if (fundToken !== policy.baseUsdc) {
      return invalid("Target order is outside Warranty policy: fund transfers must also use Base USDC.");
    }
  }

  const amountAtomic = escrowFeeAtomic + fundAmountAtomic;
  if (amountAtomic > policy.maxTargetPriceAtomic) {
    return invalid(`Target order is outside Warranty policy: actual payment ${amountAtomic} exceeds ${policy.maxTargetPriceAtomic} atomic USDC.`);
  }
  return {
    ok: true,
    amountAtomic,
    feeAmountAtomic: escrowFeeAtomic,
    fundAmountAtomic,
    token,
  };
}

function parseUsdcConfig(value, name) {
  const parsed = usdcToAtomic(value);
  if (parsed === null) throw new Error(`${name} must be a USDC amount with no more than 6 decimals.`);
  return parsed;
}

function parseSeconds(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer number of seconds.`);
  return parsed;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function invalid(reason) {
  return { ok: false, reason };
}
