import assert from "node:assert/strict";
import { hasValidDelivery } from "../src/orders.mjs";

assert.equal(hasValidDelivery(null), false);
assert.equal(hasValidDelivery({ status: "accepted", deliverableText: "done", deliverableSchema: "[]" }), true);
assert.equal(hasValidDelivery({ status: "accepted", deliverableText: "", deliverableSchema: "{\"ok\":true}" }), true);
assert.equal(hasValidDelivery({ status: "accepted", deliverableText: "", deliverableSchema: "[]" }), false);
assert.equal(hasValidDelivery({ status: "accepted", deliverableText: "", deliverableSchema: "{}" }), false);
assert.equal(hasValidDelivery({ status: "rejected", deliverableText: "done", deliverableSchema: "[]" }), false);

console.log("DELIVERY_VALIDATION_OK");
