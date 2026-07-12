import { readFileSync } from "node:fs";

const ledger = JSON.parse(readFileSync("data/coverage-ledger.json", "utf8"));
const rows = ledger.rows || [];
const requiredRowFields = [
  "id",
  "label",
  "buyerWallet",
  "targetAgent",
  "targetServiceId",
  "outcome",
  "incomingOrderId",
  "buyerPaidWarrantyTx",
];

const errors = [];
const ids = new Set();

for (const [index, row] of rows.entries()) {
  for (const field of requiredRowFields) {
    if (!row[field]) errors.push(`row ${index} missing ${field}`);
  }
  if (ids.has(row.id)) errors.push(`duplicate row id ${row.id}`);
  ids.add(row.id);
  if (!["fulfilled", "refunded", "native_refunded"].includes(row.outcome)) {
    errors.push(`row ${row.id} has invalid outcome ${row.outcome}`);
  }
  if (row.outcome === "fulfilled" || row.outcome === "refunded") {
    for (const field of ["targetOrderId", "warrantyPaidTargetTx", "warrantyDeliveredTx"]) {
      if (!row[field]) errors.push(`row ${row.id} missing ${field}`);
    }
  }
  if (row.outcome === "native_refunded") {
    for (const field of ["targetOrderId", "warrantyPaidTargetTx", "targetRejectTx", "warrantyRejectTx", "buyerRefundTx"]) {
      if (!row[field]) errors.push(`row ${row.id} missing ${field}`);
    }
  }
  for (const field of ["buyerPaidWarrantyTx", "warrantyPaidTargetTx", "warrantyDeliveredTx", "targetRejectTx", "warrantyRejectTx", "buyerRefundTx"]) {
    if (row[field] === null || row[field] === undefined) continue;
    if (!isTx(row[field])) errors.push(`row ${row.id} ${field} is not a tx hash`);
  }
  if (row.refundTx !== null && row.refundTx !== undefined && !isTx(row.refundTx)) {
    errors.push(`row ${row.id} refundTx is not a tx hash or null`);
  }
}

const summary = ledger.summary || {};
const fulfilled = rows.filter((row) => row.outcome === "fulfilled").length;
const refunded = rows.filter((row) => row.outcome === "refunded" || row.outcome === "native_refunded").length;
const uniqueTargetAgents = new Set(rows.map((row) => row.targetAgent.trim().toLowerCase())).size;
const uniqueTargetServices = new Set(rows.map((row) => row.targetServiceId)).size;
const uniqueBuyerWallets = new Set(rows.map((row) => row.buyerWallet.toLowerCase())).size;

checkSummary("coveredOrders", rows.length);
checkSummary("fulfilled", fulfilled);
checkSummary("refunded", refunded);
checkSummary("uniqueTargetAgents", uniqueTargetAgents);
checkSummary("uniqueTargetServices", uniqueTargetServices);
checkSummary("uniqueBuyerWallets", uniqueBuyerWallets);

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(
  `COVERAGE_LEDGER_OK rows=${rows.length} fulfilled=${fulfilled} refunded=${refunded} agents=${uniqueTargetAgents} services=${uniqueTargetServices} buyers=${uniqueBuyerWallets}`,
);

function checkSummary(field, actual) {
  if (summary[field] !== actual) errors.push(`summary.${field}=${summary[field]} but actual=${actual}`);
}

function isTx(value) {
  return /^0x[a-fA-F0-9]{64}$/.test(value || "");
}
