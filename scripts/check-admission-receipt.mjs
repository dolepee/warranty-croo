import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const admission = JSON.parse(readFileSync("site/admission.json", "utf8"));
const proofs = JSON.parse(readFileSync("site/proofs.json", "utf8"));
const errors = [];

const { snapshotDigest, ...payload } = admission;
const expectedDigest = digest(payload);
if (snapshotDigest !== expectedDigest) errors.push("snapshotDigest does not match the public admission payload");
if (admission.schemaVersion !== 1) errors.push("schemaVersion must be 1");
if (admission.desk?.status !== "open") errors.push("public desk status must be open");
if (admission.desk?.mode !== "real_refund") errors.push("public desk must be in real-refund mode");
if (!admission.desk?.reserve?.canCoverNextMaxOrder) errors.push("reserve cannot cover the next maximum order");
if (admission.desk?.reserve?.balanceAtomic !== proofs.coverage?.reserveStatus?.balanceAtomic) {
  errors.push("admission reserve balance does not match proofs.json");
}
if (admission.latestAdmission?.decision !== "admitted") errors.push("latest receipt is not admitted");
if (admission.latestAdmission?.checks?.some((check) => check.result !== "pass")) {
  errors.push("latest admission contains a failed check");
}
if (JSON.stringify(admission).includes("targetRequirements")) {
  errors.push("public admission receipt must not expose targetRequirements");
}

const route = proofs.coverage?.rows?.find(
  (row) => row.incomingOrderId === admission.latestAdmission?.incomingOrderId,
);
if (!route) errors.push("latest admission does not map to a public proof row");
if (route && route.warrantyPaidTargetTx !== admission.latestAdmission?.outcome?.targetPayTxHash) {
  errors.push("latest admission target payment does not match proofs.json");
}
if (route && route.targetOrderId !== admission.latestAdmission?.outcome?.targetOrderId) {
  errors.push("latest admission target order does not match proofs.json");
}
if (route && route.targetServiceId !== admission.latestAdmission?.targetServiceId) {
  errors.push("latest admission target service does not match proofs.json");
}
if (route && route.buyerWallet.toLowerCase() !== admission.latestAdmission?.buyerWallet?.toLowerCase()) {
  errors.push("latest admission buyer wallet does not match proofs.json");
}
if (route && publicFinalTransaction(route) !== admission.latestAdmission?.outcome?.finalTxHash) {
  errors.push("latest admission final receipt does not match proofs.json");
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(
  `ADMISSION_RECEIPT_OK decision=${admission.latestAdmission.decision} checks=${admission.latestAdmission.checks.length} digest=${snapshotDigest}`,
);

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function publicFinalTransaction(route) {
  if (route.outcome === "refunded" || route.outcome === "native_refunded") {
    return route.refundTx || route.warrantyRejectTx || route.targetRejectTx || null;
  }
  return route.warrantyDeliveredTx || route.targetDeliveredTx || route.targetAttestationTx || null;
}
