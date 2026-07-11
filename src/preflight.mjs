import { formatUnits } from "viem";
import { optionalEnv, stringify, warrantyClient } from "./config.mjs";
import { probeCrooContract } from "./croo-contract.mjs";
import { createRefundClients, getReserveBalance } from "./refund.mjs";
import { loadWarrantyPolicy } from "./warranty-policy.mjs";
import { WarrantyStateStore } from "./warranty-state.mjs";

const checks = [];

checkEnv("CROO_API_URL", false, "defaults to https://api.croo.network");
checkEnv("CROO_WS_URL", false, "defaults to wss://api.croo.network/ws");
checkEnv("WARRANTY_SDK_KEY", true, "Warranty provider agent SDK key");
checkEnv("WARRANTY_SERVICE_ID", true, "Warranty service ID listed in CROO dashboard");
checkEnv("WARRANTY_ALLOWED_TARGET_SERVICE_IDS", true, "comma-separated service IDs; empty means Warranty stays closed");
checkEnv("BASE_RPC_URL", false, "defaults to https://mainnet.base.org");
checkEnv("BASE_USDC", false, "defaults to canonical Base USDC");
checkEnv("WARRANTY_REFUND_DRY_RUN", false, "defaults to 1, which does not move funds");

let policy = null;
let policyError = null;
try {
  policy = loadWarrantyPolicy();
} catch (error) {
  policyError = error.message;
}

const dryRun = optionalEnv("WARRANTY_REFUND_DRY_RUN", "1") !== "0";
if (!dryRun) checkEnv("WARRANTY_RESERVE_PRIVATE_KEY", true, "reserve wallet key required for real refunds");

const state = new WarrantyStateStore();
const activeLiabilityAtomic = await state.activeLiabilityAtomic();
let reserve = null;
let reserveError = null;
if (!dryRun && process.env.WARRANTY_RESERVE_PRIVATE_KEY && policy) {
  try {
    const clients = createRefundClients();
    const balance = await getReserveBalance({ token: policy.baseUsdc, clients });
    const requiredForNextMaxOrder = activeLiabilityAtomic + policy.coverageCapAtomic;
    reserve = {
      address: clients.account.address,
      token: policy.baseUsdc,
      balance: balance.toString(),
      balanceFormatted: formatUnits(balance, 6),
      activeLiabilityAtomic: activeLiabilityAtomic.toString(),
      canCoverNextMaxOrder: balance >= requiredForNextMaxOrder,
      requiredForNextMaxOrderAtomic: requiredForNextMaxOrder.toString(),
    };
    if (!reserve.canCoverNextMaxOrder) reserveError = "reserve cannot cover active liabilities plus one maximum-size order";
  } catch (error) {
    reserveError = error.message;
  }
}

let crooCompatibility = null;
let crooCompatibilityError = null;
if (process.env.WARRANTY_SDK_KEY) {
  try {
    crooCompatibility = await probeCrooContract(warrantyClient());
    if (!crooCompatibility.ok) {
      crooCompatibilityError = crooCompatibility.checks
        .filter((check) => !check.ok)
        .map((check) => `${check.name}: ${check.error}`)
        .join("; ");
    }
  } catch (error) {
    crooCompatibilityError = error.message;
  }
}

const missing = checks.filter((check) => check.required && !check.present);
const report = {
  ok: missing.length === 0 && !policyError && !reserveError && !crooCompatibilityError,
  mode: dryRun ? "dry-run refund" : "real refund",
  checks,
  missing: missing.map((check) => check.name),
  policy: policy
    ? {
        baseUsdc: policy.baseUsdc,
        allowlistedTargets: policy.allowedTargetServiceIds.length,
        coverageCapAtomic: policy.coverageCapAtomic.toString(),
        maxTargetPriceAtomic: policy.maxTargetPriceAtomic.toString(),
        timeoutBoundsMs: [policy.minTimeoutMs, policy.maxTimeoutMs],
        buyerRateLimit: {
          maxOrders: policy.maxOrdersPerBuyerWindow,
          windowSeconds: policy.buyerWindowMs / 1000,
        },
      }
    : null,
  policyError,
  reserve,
  reserveError,
  crooCompatibility,
  crooCompatibilityError,
  next: "Run npm run provider only when this report returns ok: true.",
};

console.log(stringify(report));
if (!report.ok) process.exit(1);

function checkEnv(name, required, note) {
  const value = process.env[name]?.trim() ?? "";
  checks.push({
    name,
    required,
    present: Boolean(value) && !value.includes("REPLACE_ME"),
    note,
  });
}
