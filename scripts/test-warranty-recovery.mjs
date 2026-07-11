import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processWarrantyOrder } from "../src/warranty-engine.mjs";
import { loadWarrantyPolicy } from "../src/warranty-policy.mjs";
import { WarrantyStateStore } from "../src/warranty-state.mjs";

const SERVICE_ID = "e97e8c6d-9eda-4f20-b76d-2af57ace608d";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const policy = loadWarrantyPolicy({
  WARRANTY_ALLOWED_TARGET_SERVICE_IDS: SERVICE_ID,
  WARRANTY_COVERAGE_CAP_USDC: "0.5",
  WARRANTY_MAX_TARGET_PRICE_USDC: "0.1",
  WARRANTY_MIN_TIMEOUT_SECONDS: "60",
  WARRANTY_TARGET_TIMEOUT_SECONDS: "60",
  WARRANTY_MAX_TIMEOUT_SECONDS: "3600",
  WARRANTY_TARGET_ACCEPT_SECONDS: "1",
  WARRANTY_REFUND_DRY_RUN: "0",
  BASE_USDC: USDC,
});

async function targetPaymentRecovery() {
  await withRuntime("payment", async ({ state, client }) => {
    const fault = failOneUpdate(state, (patch) => Boolean(patch.targetPayTxHash));
    await assert.rejects(
      processWarrantyOrder(runtimeOptions(client, fault)),
      /simulated journal crash/,
    );
    assert.equal(client.payCalls, 1);

    const result = await processWarrantyOrder(runtimeOptions(client, state));
    assert.equal(result.stage, "FULFILLED");
    assert.equal(client.payCalls, 1, "restart must reconcile the paid target instead of paying again");
  });
}

async function incomingDeliveryRecovery() {
  await withRuntime("delivery", async ({ state, client }) => {
    const fault = failOneUpdate(state, (patch) => patch.stage === "FULFILLED");
    await assert.rejects(
      processWarrantyOrder(runtimeOptions(client, fault)),
      /simulated journal crash/,
    );
    assert.equal(client.deliverCalls, 1);

    const result = await processWarrantyOrder(runtimeOptions(client, state));
    assert.equal(result.stage, "FULFILLED");
    assert.equal(client.deliverCalls, 1, "restart must detect the completed incoming order instead of delivering again");
  });
}

async function refundRecovery() {
  await withRuntime("refund", async ({ state, client }) => {
    client.targetOutcome = "expired";
    const observedPrepared = [];
    const uniqueBroadcasts = new Set();
    let crash = true;
    const refund = async ({ preparedTransaction, onPrepared }) => {
      const prepared = preparedTransaction || {
        txHash: `0x${"ab".repeat(32)}`,
        serializedTransaction: `0x02${"cd".repeat(40)}`,
        token: USDC,
        to: client.incoming.requesterWalletAddress,
        amount: client.incoming.price,
      };
      if (!preparedTransaction) await onPrepared(prepared);
      observedPrepared.push(prepared.serializedTransaction);
      uniqueBroadcasts.add(prepared.txHash);
      if (crash) {
        crash = false;
        throw new Error("simulated crash after refund broadcast");
      }
      return { dryRun: false, txHash: prepared.txHash, amount: prepared.amount };
    };

    await assert.rejects(
      processWarrantyOrder(runtimeOptions(client, state, refund)),
      /simulated crash after refund broadcast/,
    );
    const result = await processWarrantyOrder(runtimeOptions(client, state, refund));
    assert.equal(result.stage, "REFUNDED");
    assert.equal(uniqueBroadcasts.size, 1, "restart must reuse the same signed refund transaction hash");
    assert.equal(observedPrepared[0], observedPrepared[1], "restart must rebroadcast the identical serialized refund transaction");
    assert.equal(client.payCalls, 1, "refund recovery must not repay the target order");
  });
}

function runtimeOptions(client, state, refund = undefined) {
  return {
    client,
    incomingOrderId: client.incoming.orderId,
    state,
    policy,
    reserveBalance: async () => 10_000_000n,
    refund,
    logger: { log() {}, warn() {} },
  };
}

async function withRuntime(label, callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), `warranty-${label}-`));
  const state = new WarrantyStateStore(root);
  const client = new FakeCROOClient();
  try {
    await callback({ state, client });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function failOneUpdate(state, predicate) {
  let armed = true;
  return new Proxy(state, {
    get(target, property) {
      if (property !== "update") {
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (orderId, patch) => {
        if (armed && predicate(patch)) {
          armed = false;
          throw new Error("simulated journal crash");
        }
        return target.update(orderId, patch);
      };
    },
  });
}

class FakeCROOClient {
  constructor() {
    this.incoming = {
      orderId: "incoming-1",
      negotiationId: "incoming-negotiation",
      requesterWalletAddress: "0x1111111111111111111111111111111111111111",
      price: "80000",
      paymentToken: USDC,
      status: "paid",
      deliverTxHash: "",
    };
    this.target = null;
    this.negotiation = null;
    this.payCalls = 0;
    this.deliverCalls = 0;
    this.rejectCalls = 0;
    this.targetOutcome = "completed";
  }

  async getOrder(orderId) {
    if (orderId === this.incoming.orderId) return { ...this.incoming };
    if (this.target && orderId === this.target.orderId) return { ...this.target };
    throw new Error(`unknown order ${orderId}`);
  }

  async getNegotiation(negotiationId) {
    if (negotiationId === this.incoming.negotiationId) {
      return {
        negotiationId,
        requirements: JSON.stringify({
          targetServiceId: SERVICE_ID,
          timeoutMs: 60_000,
          targetRequirements: { service_description: "test", current_price_usdc: 0.08 },
        }),
      };
    }
    return this.negotiation;
  }

  async listNegotiations({ role }) {
    assert.equal(role, "requester");
    return this.negotiation ? [{ ...this.negotiation }] : [];
  }

  async negotiateOrder({ serviceId, requirements, metadata }) {
    this.negotiation = {
      negotiationId: "target-negotiation",
      serviceId,
      requirements,
      metadata,
      status: "accepted",
    };
    this.target = {
      orderId: "target-1",
      negotiationId: this.negotiation.negotiationId,
      price: "80000",
      paymentToken: USDC,
      status: "created",
      payTxHash: "",
    };
    return { ...this.negotiation };
  }

  async listOrders({ role }) {
    if (role === "buyer") return this.target ? [{ ...this.target }] : [];
    return [{ ...this.incoming }];
  }

  async payOrder() {
    this.payCalls += 1;
    this.target.payTxHash = `0x${"12".repeat(32)}`;
    this.target.status = this.targetOutcome;
    return { order: { ...this.target }, txHash: this.target.payTxHash };
  }

  async getDelivery() {
    return {
      status: "submitted",
      deliverableText: JSON.stringify({ ok: true }),
      deliverableSchema: "",
    };
  }

  async deliverOrder(orderId) {
    assert.equal(orderId, this.incoming.orderId);
    this.deliverCalls += 1;
    this.incoming.status = "completed";
    this.incoming.deliverTxHash = `0x${"34".repeat(32)}`;
    return { txHash: this.incoming.deliverTxHash };
  }

  async rejectOrder() {
    this.rejectCalls += 1;
    this.incoming.status = "rejected";
    return { txHash: `0x${"56".repeat(32)}` };
  }
}

await targetPaymentRecovery();
await incomingDeliveryRecovery();
await refundRecovery();
console.log("WARRANTY_RECOVERY_OK");
