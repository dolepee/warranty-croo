import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { formatUnits } from "viem";
import { parseRequirements, requiredEnv, warrantyClient } from "../src/config.mjs";
import { createRefundClients, getReserveBalance } from "../src/refund.mjs";
import {
  loadWarrantyPolicy,
  validateIncomingCoverage,
  validateTargetOrder,
} from "../src/warranty-policy.mjs";
import { normalizeWarrantyRequest } from "../src/warranty-request.mjs";
import { WarrantyStateStore } from "../src/warranty-state.mjs";

const outputPath = process.env.WARRANTY_ADMISSION_OUTPUT || "site/admission.json";
const ledger = JSON.parse(await readFile("data/coverage-ledger.json", "utf8"));
const policy = loadWarrantyPolicy();
const state = new WarrantyStateStore();
const records = (await state.list())
  .filter((record) => record.coverageAmountAtomic && record.targetOrderId && record.request)
  .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));

if (!records.length) throw new Error("No completed Warranty journal record is available for a public admission receipt.");

const client = warrantyClient();
let evaluated = null;
for (const candidate of records) {
  const result = await evaluateRecord(candidate);
  if (result?.checks.every((item) => item.result === "pass")) {
    evaluated = result;
    break;
  }
}
if (!evaluated) throw new Error("No journaled route passes the current Warranty admission policy.");

const { record, route, checks, request, incoming, incomingValidation, target } = evaluated;

const activeRecords = await state.listActive();
const activeLiabilityAtomic = await state.activeLiabilityAtomic();
const refundClients = createRefundClients();
const reserveBalanceAtomic = await getReserveBalance({ token: policy.baseUsdc, clients: refundClients });
const availableCapacityAtomic = reserveBalanceAtomic > activeLiabilityAtomic
  ? reserveBalanceAtomic - activeLiabilityAtomic
  : 0n;
const canCoverNextMaxOrder = availableCapacityAtomic >= policy.coverageCapAtomic;

const publicPolicy = {
  baseUsdc: policy.baseUsdc,
  allowlistedTargetCount: policy.allowedTargetServiceIds.length,
  coverageCapAtomic: policy.coverageCapAtomic.toString(),
  coverageCapUSDC: formatUnits(policy.coverageCapAtomic, 6),
  maxTargetPriceAtomic: policy.maxTargetPriceAtomic.toString(),
  maxTargetPriceUSDC: formatUnits(policy.maxTargetPriceAtomic, 6),
  deadlineBoundsMs: [policy.minTimeoutMs, policy.maxTimeoutMs],
  buyerRateLimit: {
    maxOrders: policy.maxOrdersPerBuyerWindow,
    windowSeconds: policy.buyerWindowMs / 1000,
  },
};

const payload = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  desk: {
    status: !policy.refundDryRun && canCoverNextMaxOrder ? "open" : "closed",
    mode: policy.refundDryRun ? "dry_run" : "real_refund",
    serviceId: requiredEnv("WARRANTY_SERVICE_ID", "Warranty service ID listed in CROO"),
    policy: publicPolicy,
    policyDigest: digest(publicPolicy),
    reserve: {
      wallet: refundClients.account.address,
      balanceAtomic: reserveBalanceAtomic.toString(),
      balanceUSDC: formatUnits(reserveBalanceAtomic, 6),
      activeLiabilityAtomic: activeLiabilityAtomic.toString(),
      activeLiabilityUSDC: formatUnits(activeLiabilityAtomic, 6),
      availableCapacityAtomic: availableCapacityAtomic.toString(),
      availableCapacityUSDC: formatUnits(availableCapacityAtomic, 6),
      capacityAfterMaxOrderAtomic: canCoverNextMaxOrder
        ? (availableCapacityAtomic - policy.coverageCapAtomic).toString()
        : "0",
      capacityAfterMaxOrderUSDC: canCoverNextMaxOrder
        ? formatUnits(availableCapacityAtomic - policy.coverageCapAtomic, 6)
        : "0",
      activeOrderCount: activeRecords.length,
      canCoverNextMaxOrder,
    },
  },
  latestAdmission: {
    receiptId: `admission-${record.incomingOrderId}`,
    decision: checks.every((item) => item.result === "pass") ? "admitted" : "declined",
    source: "Warranty journal plus read-only CROO order reconciliation",
    admittedAt: record.createdAt,
    completedAt: record.updatedAt,
    incomingOrderId: record.incomingOrderId,
    buyerWallet: incoming.requesterWalletAddress,
    targetAgent: route.targetAgent,
    targetServiceId: request.targetServiceId,
    requestedDeadlineMs: request.timeoutMs,
    coverageAmountAtomic: incomingValidation.amountAtomic.toString(),
    coverageAmountUSDC: formatUnits(incomingValidation.amountAtomic, 6),
    checks,
    outcome: {
      stage: record.stage,
      targetOrderId: record.targetOrderId,
      targetStatus: target.status,
      targetOnTime: record.targetOnTime,
      targetPayTxHash: target.payTxHash,
      finalTxHash: route.warrantyDeliveredTx || route.refundTx || route.warrantyRejectTx || null,
    },
  },
};

const receipt = { ...payload, snapshotDigest: digest(payload) };
await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
console.log(`ADMISSION_RECEIPT_EXPORTED ${outputPath} ${receipt.snapshotDigest}`);

function check(id, label, passed, detail) {
  return { id, label, result: passed ? "pass" : "fail", detail };
}

async function evaluateRecord(record) {
  const route = ledger.rows.find((row) => row.incomingOrderId === record.incomingOrderId);
  if (!route) return null;

  const incoming = await client.getOrder(record.incomingOrderId);
  const [negotiation, target] = await Promise.all([
    client.getNegotiation(incoming.negotiationId),
    client.getOrder(record.targetOrderId),
  ]);
  const requestCheck = normalizeWarrantyRequest(parseRequirements(negotiation.requirements), {
    allowedTargetServiceIds: policy.allowedTargetServiceIds.join(","),
    defaultTimeoutMs: policy.defaultTimeoutMs,
    minTimeoutMs: policy.minTimeoutMs,
    maxTimeoutMs: policy.maxTimeoutMs,
  });
  const incomingCheck = validateIncomingCoverage(incoming, policy);
  const targetCheck = validateTargetOrder(target, policy);
  const targetMatchesRequest = requestCheck.ok
    && record.targetServiceId === requestCheck.request.targetServiceId
    && route.targetServiceId === requestCheck.request.targetServiceId
    && target.serviceId === requestCheck.request.targetServiceId;
  const checks = [
    check("request", "Structured target request", requestCheck.ok, requestCheck.ok ? "Normalized JSON request" : requestCheck.reason),
    check(
      "target",
      "Supported target",
      requestCheck.ok
        && targetMatchesRequest
        && policy.allowedTargetServiceIds.includes(requestCheck.request.targetServiceId),
      requestCheck.ok && targetMatchesRequest ? route.targetAgent : "Target service does not reconcile",
    ),
    check("asset", "Base USDC payment", incomingCheck.ok, incomingCheck.ok ? incomingCheck.token : incomingCheck.reason),
    check(
      "coverage",
      "Coverage within ceiling",
      incomingCheck.ok && incomingCheck.amountAtomic <= policy.coverageCapAtomic,
      incomingCheck.ok
        ? `${formatUnits(incomingCheck.amountAtomic, 6)} of ${formatUnits(policy.coverageCapAtomic, 6)} USDC`
        : incomingCheck.reason,
    ),
    check(
      "deadline",
      "Deadline inside policy",
      requestCheck.ok && requestCheck.request.timeoutMs >= policy.minTimeoutMs && requestCheck.request.timeoutMs <= policy.maxTimeoutMs,
      requestCheck.ok ? `${requestCheck.request.timeoutMs / 60_000} minutes` : requestCheck.reason,
    ),
    check(
      "targetPayment",
      "Target payment within limit",
      targetCheck.ok,
      targetCheck.ok
        ? `${formatUnits(targetCheck.amountAtomic, 6)} of ${formatUnits(policy.maxTargetPriceAtomic, 6)} USDC`
        : targetCheck.reason,
    ),
  ];
  return {
    record,
    route,
    checks,
    request: requestCheck.request,
    incoming,
    incomingValidation: incomingCheck,
    target,
  };
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
