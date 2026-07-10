import assert from "node:assert/strict";
import { normalizeWarrantyRequest, parseUsdcAtomic, usdcToAtomic } from "../src/warranty-request.mjs";

const rateCard = "e97e8c6d-9eda-4f20-b76d-2af57ace608d";

const direct = normalizeWarrantyRequest({
  targetServiceId: rateCard,
  timeoutMs: 600000,
  targetRequirements: {
    service_description: "Warranty, a refund-backed CROO route",
    current_price_usdc: 0.08,
  },
}, { allowedTargetServiceIds: rateCard });
assert.equal(direct.ok, true);
assert.equal(direct.request.targetServiceId, rateCard);
assert.equal(direct.request.timeoutMs, 600000);

const textWrapped = normalizeWarrantyRequest({
  text: JSON.stringify({
    targetServiceId: rateCard,
    timeoutMs: "600000",
    targetRequirements: JSON.stringify({
      service_description: "Warranty",
      current_price_usdc: 0.08,
    }),
  }),
}, { allowedTargetServiceIds: rateCard });
assert.equal(textWrapped.ok, true);
assert.equal(textWrapped.request.targetRequirements.service_description, "Warranty");

const missingTarget = normalizeWarrantyRequest({ targetRequirements: { task: "run" } });
assert.equal(missingTarget.ok, false);
assert.match(missingTarget.reason, /targetServiceId/);

const malformedText = normalizeWarrantyRequest({ text: "please certify data-validator-007" });
assert.equal(malformedText.ok, false);

const unsupported = normalizeWarrantyRequest({
  targetServiceId: "other-service",
  targetRequirements: { task: "run" },
}, { allowedTargetServiceIds: rateCard });
assert.equal(unsupported.ok, false);
assert.match(unsupported.reason, /allowlisted/);

const missingTargetRequirements = normalizeWarrantyRequest({ targetServiceId: rateCard }, { allowedTargetServiceIds: rateCard });
assert.equal(missingTargetRequirements.ok, false);
assert.match(missingTargetRequirements.reason, /targetRequirements/);

const badTimeout = normalizeWarrantyRequest({
  targetServiceId: rateCard,
  timeoutMs: 10,
  targetRequirements: { task: "run" },
}, { allowedTargetServiceIds: rateCard });
assert.equal(badTimeout.ok, false);
assert.match(badTimeout.reason, /timeoutMs/);

const missingAllowlist = normalizeWarrantyRequest({
  targetServiceId: rateCard,
  timeoutMs: 60000,
  targetRequirements: { task: "run" },
});
assert.equal(missingAllowlist.ok, false);
assert.match(missingAllowlist.reason, /allowlist is unavailable/);

assert.equal(parseUsdcAtomic("100000"), 100000n);
assert.equal(parseUsdcAtomic("100000.00000000"), 100000n);
assert.equal(parseUsdcAtomic(""), null);
assert.equal(usdcToAtomic("0.10"), 100000n);
assert.equal(usdcToAtomic("0.000001"), 1n);
assert.equal(usdcToAtomic("0.0000001"), null);

console.log("WARRANTY_REQUEST_OK");
