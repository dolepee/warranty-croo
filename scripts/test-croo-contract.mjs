import assert from "node:assert/strict";
import {
  CROO_NEGOTIATION_ROLE,
  CROO_ORDER_ROLE,
  assertCrooContract,
  probeCrooContract,
} from "../src/croo-contract.mjs";
import { withTimeout } from "../src/config.mjs";

const calls = [];
const client = {
  async listOrders(options) {
    calls.push(["orders", options.role]);
    return [];
  },
  async listNegotiations(options) {
    calls.push(["negotiations", options.role]);
    return [];
  },
};

const report = await assertCrooContract(client);
assert.equal(report.ok, true);
assert.deepEqual(calls, [
  ["orders", CROO_ORDER_ROLE.provider],
  ["orders", CROO_ORDER_ROLE.requester],
  ["negotiations", CROO_NEGOTIATION_ROLE.provider],
  ["negotiations", CROO_NEGOTIATION_ROLE.requester],
]);

const failed = await probeCrooContract({
  ...client,
  async listNegotiations(options) {
    if (options.role === CROO_NEGOTIATION_ROLE.requester) throw new Error("role must be requester or provider");
    return [];
  },
});
assert.equal(failed.ok, false);
assert.match(failed.checks.find((check) => !check.ok).error, /role must be requester/);

await assert.rejects(
  withTimeout(() => new Promise(() => {}), "test read", 5),
  /timed out after 5ms/,
);

console.log("CROO_CONTRACT_OK");
