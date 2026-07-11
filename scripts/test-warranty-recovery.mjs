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
    assert.equal(Date.parse(result.targetDeadlineAt) - Date.parse(result.targetPaidAt), 60_000);
  });
}

async function targetNegotiationRecovery() {
  await withRuntime("negotiation", async ({ state, client }) => {
    const fault = failOneUpdate(state, (patch) => Boolean(patch.targetNegotiationId));
    await assert.rejects(
      processWarrantyOrder(runtimeOptions(client, fault)),
      /simulated journal crash/,
    );
    assert.equal(client.negotiateCalls, 1);

    const result = await processWarrantyOrder(runtimeOptions(client, state));
    assert.equal(result.stage, "FULFILLED");
    assert.equal(client.negotiateCalls, 1, "restart must recover the metadata-linked target negotiation");
  });
}

async function targetOrderRecovery() {
  await withRuntime("target-order", async ({ state, client }) => {
    const fault = failOneUpdate(state, (patch) => patch.stage === "TARGET_ORDER_CREATED");
    await assert.rejects(
      processWarrantyOrder(runtimeOptions(client, fault)),
      /simulated journal crash/,
    );

    const result = await processWarrantyOrder(runtimeOptions(client, state));
    assert.equal(result.stage, "FULFILLED");
    assert.equal(client.negotiateCalls, 1, "restart must recover the already-created target order");
    assert.equal(client.payCalls, 1);
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

async function incomingSubmissionRecovery() {
  await withRuntime("delivery-submission", async ({ state, client }) => {
    const fault = failOneUpdate(state, (patch) => patch.stage === "INCOMING_DELIVERY_SUBMITTED");
    await assert.rejects(
      processWarrantyOrder(runtimeOptions(client, fault)),
      /simulated journal crash/,
    );
    assert.equal(client.deliverCalls, 1);

    const result = await processWarrantyOrder(runtimeOptions(client, state));
    assert.equal(result.stage, "FULFILLED");
    assert.equal(client.deliverCalls, 1, "restart must reconcile the submitted incoming delivery");
  });
}

async function incomingEvaluationWaitsForCompletion() {
  await withRuntime("evaluation", async ({ state, client }) => {
    const previousPoll = process.env.WARRANTY_POLL_MS;
    process.env.WARRANTY_POLL_MS = "1";
    client.incomingLifecycle = ["delivering", "evaluating", "completed"];
    try {
      const result = await processWarrantyOrder(runtimeOptions(client, state));
      assert.equal(result.stage, "FULFILLED");
      assert.equal(client.deliverCalls, 1);
      assert.ok(client.incomingReadsAfterDelivery >= 3, "Warranty must observe CROO completion after delivery submission");
    } finally {
      if (previousPoll === undefined) delete process.env.WARRANTY_POLL_MS;
      else process.env.WARRANTY_POLL_MS = previousPoll;
    }
  });
}

async function incomingDeliveryFailureRetries() {
  await withRuntime("delivery-failure", async ({ state, client }) => {
    client.failedIncomingDeliveries = 1;
    await assert.rejects(
      processWarrantyOrder(runtimeOptions(client, state)),
      /status=deliver_failed/,
    );
    assert.equal(client.deliverCalls, 1);

    const result = await processWarrantyOrder(runtimeOptions(client, state));
    assert.equal(result.stage, "FULFILLED");
    assert.equal(client.deliverCalls, 2, "an explicit failed CROO delivery should retry without repaying the target");
    assert.equal(client.payCalls, 1);
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

async function lateTargetRefunds() {
  await withRuntime("late-target", async ({ state, client }) => {
    client.targetDeliveredAtOffsetMs = 120_000;
    const refund = async ({ amount, to, token }) => ({
      dryRun: false,
      txHash: `0x${"ef".repeat(32)}`,
      amount,
      to,
      token,
    });
    const result = await processWarrantyOrder(runtimeOptions(client, state, refund));
    assert.equal(result.stage, "REFUNDED");
    assert.equal(result.targetOnTime, false);
    assert.equal(client.payCalls, 1);
  });
}

async function buyerRateLimitRejectsBeforeTargetPayment() {
  await withRuntime("buyer-rate-limit", async ({ state, client }) => {
    await state.save({
      incomingOrderId: "prior-covered-order",
      stage: "FULFILLED",
      buyerWallet: client.incoming.requesterWalletAddress,
      coverageAmountAtomic: "80000",
      paymentToken: USDC,
    });
    const result = await processWarrantyOrder(runtimeOptions(client, state));
    assert.equal(result.stage, "REJECTED");
    assert.match(result.rejectionReason, /buyer limit reached/);
    assert.equal(client.negotiateCalls, 0);
    assert.equal(client.payCalls, 0);
    assert.equal(client.rejectCalls, 1);
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
    this.negotiateCalls = 0;
    this.deliverCalls = 0;
    this.rejectCalls = 0;
    this.targetOutcome = "completed";
    this.incomingLifecycle = [];
    this.incomingReadsAfterDelivery = 0;
    this.failedIncomingDeliveries = 0;
    this.targetDeliveredAtOffsetMs = 0;
  }

  async getOrder(orderId) {
    if (orderId === this.incoming.orderId) {
      if (this.deliverCalls > 0 && this.incomingLifecycle.length) {
        this.incoming.status = this.incomingLifecycle.shift();
        this.incomingReadsAfterDelivery += 1;
      }
      return { ...this.incoming };
    }
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
    this.negotiateCalls += 1;
    this.negotiation = {
      negotiationId: "target-negotiation",
      serviceId,
      requirements,
      metadata,
      status: "accepted",
      createdTime: new Date().toISOString(),
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
    this.target.paidAt = new Date().toISOString();
    this.target.deliveredAt = new Date(Date.now() + this.targetDeliveredAtOffsetMs).toISOString();
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
    this.incoming.deliverTxHash = `0x${this.deliverCalls.toString(16).padStart(64, "0")}`;
    if (this.failedIncomingDeliveries > 0) {
      this.failedIncomingDeliveries -= 1;
      this.incoming.status = "deliver_failed";
      return { txHash: this.incoming.deliverTxHash };
    }
    this.incoming.status = this.incomingLifecycle.length ? "delivering" : "completed";
    return { txHash: this.incoming.deliverTxHash };
  }

  async rejectOrder() {
    this.rejectCalls += 1;
    this.incoming.status = "rejected";
    return { txHash: `0x${"56".repeat(32)}` };
  }
}

await targetNegotiationRecovery();
await targetOrderRecovery();
await targetPaymentRecovery();
await incomingDeliveryRecovery();
await incomingSubmissionRecovery();
await incomingEvaluationWaitsForCompletion();
await incomingDeliveryFailureRetries();
await refundRecovery();
await lateTargetRefunds();
await buyerRateLimitRejectsBeforeTargetPayment();
console.log("WARRANTY_RECOVERY_OK");
