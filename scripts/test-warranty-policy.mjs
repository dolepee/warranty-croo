import assert from "node:assert/strict";
import { loadWarrantyPolicy, validateIncomingCoverage, validateTargetOrder } from "../src/warranty-policy.mjs";

const target = "e97e8c6d-9eda-4f20-b76d-2af57ace608d";
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

assert.throws(() => loadWarrantyPolicy({}), /fails closed/);
assert.throws(
  () => loadWarrantyPolicy({ WARRANTY_ALLOWED_TARGET_SERVICE_IDS: target, WARRANTY_COVERAGE_CAP_USDC: "0.500001" }),
  /no more than 0.5/,
);
assert.throws(
  () => loadWarrantyPolicy({ WARRANTY_ALLOWED_TARGET_SERVICE_IDS: target, WARRANTY_MIN_TIMEOUT_SECONDS: "1" }),
  /between 60 and 3600/,
);

const policy = loadWarrantyPolicy({
  WARRANTY_ALLOWED_TARGET_SERVICE_IDS: target,
  BASE_USDC: usdc,
});
assert.equal(validateIncomingCoverage({ paymentToken: usdc, price: "500000" }, policy).ok, true);
assert.equal(validateIncomingCoverage({ paymentToken: usdc, price: "500001" }, policy).ok, false);
assert.equal(
  validateIncomingCoverage({ paymentToken: "0x4200000000000000000000000000000000000006", price: "1000" }, policy).ok,
  false,
);

const zeruCompatibility = validateTargetOrder({
  paymentToken: usdc,
  price: "500000",
  feeAmount: "50000",
  fundAmount: "0",
}, policy);
assert.equal(zeruCompatibility.ok, true);
assert.equal(zeruCompatibility.amountAtomic, 50000n);
assert.equal(zeruCompatibility.feeAmountAtomic, 50000n);

const feeAmountWinsOverDisplayPrice = validateTargetOrder({
  paymentToken: usdc,
  price: "0.01",
  feeAmount: "100001",
}, policy);
assert.equal(feeAmountWinsOverDisplayPrice.ok, false);
assert.match(feeAmountWinsOverDisplayPrice.reason, /actual payment/);

const crossTokenFundTransfer = validateTargetOrder({
  paymentToken: usdc,
  price: "0.01",
  feeAmount: "10000",
  fundAmount: "1",
  fundToken: "0x4200000000000000000000000000000000000006",
}, policy);
assert.equal(crossTokenFundTransfer.ok, false);
assert.match(crossTokenFundTransfer.reason, /fund transfers must also use Base USDC/);

console.log("WARRANTY_POLICY_OK");
