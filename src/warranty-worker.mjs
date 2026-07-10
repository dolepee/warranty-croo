import { EventType, OrderStatus } from "@croo-network/sdk";
import { optionalEnv, parseRequirements, sleep, stringify, warrantyClient } from "./config.mjs";
import {
  deliverJson,
  hasValidDelivery,
  waitForCreatedOrderByNegotiation,
  waitForPaidProviderOrder,
  waitForTerminalOrder,
} from "./orders.mjs";
import { refundBuyer } from "./refund.mjs";
import { normalizeWarrantyRequest, parseUsdcAtomic, usdcToAtomic } from "./warranty-request.mjs";

const client = warrantyClient();
const incomingOrderId = process.env.WARRANTY_INCOMING_ORDER_ID;
const intakeWaitMs = Number(process.env.WARRANTY_WAIT_MS || "180000");

const { incomingSnapshot, stream } = incomingOrderId
  ? { incomingSnapshot: await getIncomingOrderWithRetry(client, incomingOrderId), stream: null }
  : await waitForPaidIncomingOrder(client, intakeWaitMs);
const incoming = await client.getOrder(incomingSnapshot.orderId);

if (incoming.status !== OrderStatus.Paid && incoming.status !== OrderStatus.Completed) {
  throw new Error(`incoming order ${incoming.orderId} is not paid, status=${incoming.status}`);
}

const requestCheck = normalizeWarrantyRequest(parseRequirements(await getIncomingRequirements(client, incoming)), {
  allowedTargetServiceIds: optionalEnv("WARRANTY_ALLOWED_TARGET_SERVICE_IDS"),
  defaultTimeoutMs: Number(process.env.WARRANTY_TARGET_TIMEOUT_SECONDS || "600") * 1000,
});
if (!requestCheck.ok) {
  await rejectIncoming(incoming, requestCheck.reason);
  stream?.close();
  process.exit(0);
}
const req = requestCheck.request;
const requestedTargetServiceId = req.targetServiceId;
const targetServiceId = process.env.WARRANTY_FORCE_TARGET_SERVICE_ID || requestedTargetServiceId;

const forcedTargetRequirements = process.env.WARRANTY_FORCE_TARGET_REQUIREMENTS;
const targetRequirements = JSON.stringify(forcedTargetRequirements ? parseRequirements(forcedTargetRequirements) : req.targetRequirements);
const targetTimeoutMs = req.timeoutMs;

console.log(`incoming order ${incoming.orderId}`);
console.log(`buyer wallet ${incoming.requesterWalletAddress}`);
console.log(`target service ${targetServiceId}`);
if (requestedTargetServiceId && requestedTargetServiceId !== targetServiceId) {
  console.log(`forced fallback target ${targetServiceId} replacing requested ${requestedTargetServiceId}`);
}

let negotiation;
try {
  negotiation = await client.negotiateOrder({
    serviceId: targetServiceId,
    requirements: targetRequirements,
    metadata: JSON.stringify({
      warrantyIncomingOrderId: incoming.orderId,
      warrantyBuyerWallet: incoming.requesterWalletAddress,
    }),
  });
} catch (error) {
  await rejectBeforeTargetPayment(incoming, `target service did not accept negotiation: ${errorMessage(error)}`, {
    requestedTargetServiceId,
    targetServiceId,
  });
}
console.log(`target negotiation ${negotiation.negotiationId}`);

let targetOrder;
try {
  targetOrder = await waitForCreatedOrderByNegotiation(
    client,
    negotiation.negotiationId,
    "buyer",
    Number(process.env.WARRANTY_TARGET_ACCEPT_MS || "180000"),
  );
} catch (error) {
  await rejectBeforeTargetPayment(incoming, `target service did not create an order: ${errorMessage(error)}`, {
    requestedTargetServiceId,
    targetServiceId,
    targetNegotiationId: negotiation.negotiationId,
  });
}
const targetOrderDetail = await client.getOrder(targetOrder.orderId);
console.log(`target order ${targetOrder.orderId} status=${targetOrder.status} price=${targetOrderDetail.price || targetOrder.price}`);

const priceCheck = checkTargetPrice(targetOrderDetail, targetOrder);
if (!priceCheck.ok) {
  await rejectIncoming(incoming, priceCheck.reason);
  stream?.close();
  process.exit(0);
}

let paid;
try {
  paid = await client.payOrder(targetOrder.orderId);
} catch (error) {
  await rejectBeforeTargetPayment(incoming, `Warranty could not pay target before coverage began: ${errorMessage(error)}`, {
    requestedTargetServiceId,
    targetServiceId,
    targetOrderId: targetOrder.orderId,
  });
}
console.log(`target paid ${paid.txHash}`);

const terminal = await waitForTerminalOrder(client, targetOrder.orderId, targetTimeoutMs);
let delivery = null;
let fulfilled = false;
if (terminal.status === OrderStatus.Completed) {
  delivery = await client.getDelivery(targetOrder.orderId);
  fulfilled = hasValidDelivery(delivery);
}

if (fulfilled) {
  const result = await deliverJson(client, incoming.orderId, {
    warranty: "fulfilled",
    incomingOrderId: incoming.orderId,
    buyerWallet: incoming.requesterWalletAddress,
    requestedTargetServiceId,
    targetOrderId: targetOrder.orderId,
    targetServiceId,
    targetPayTxHash: paid.txHash,
    targetDelivery: delivery,
  });
  console.log(
    stringify({
      ok: true,
      outcome: "fulfilled",
      incomingOrderId: incoming.orderId,
      targetOrderId: targetOrder.orderId,
      targetPayTxHash: paid.txHash,
      warrantyDeliverTxHash: result.txHash,
    }),
  );
  stream?.close();
  process.exit(0);
}

const refund = await refundBuyer({
  to: incoming.requesterWalletAddress,
  amount: incoming.price,
  token: incoming.paymentToken,
  orderId: incoming.orderId,
  reason: `target ${targetOrder.orderId} status=${terminal.status} delivery_valid=${fulfilled}`,
});
const result = await deliverJson(client, incoming.orderId, {
  warranty: "refunded",
  incomingOrderId: incoming.orderId,
  buyerWallet: incoming.requesterWalletAddress,
  requestedTargetServiceId,
  targetOrderId: targetOrder.orderId,
  targetServiceId,
  targetPayTxHash: paid.txHash,
  targetStatus: terminal.status,
  refund,
});
console.log(
  stringify({
    ok: true,
    outcome: "refunded",
    incomingOrderId: incoming.orderId,
    targetOrderId: targetOrder.orderId,
    targetPayTxHash: paid.txHash,
    warrantyDeliverTxHash: result.txHash,
    refund,
  }),
);
stream?.close();

async function getIncomingRequirements(agentClient, order) {
  const negotiation = await agentClient.getNegotiation(order.negotiationId);
  return negotiation.requirements;
}

async function waitForPaidIncomingOrder(agentClient, waitMs) {
  const cycleMs = Math.min(waitMs, Number(process.env.WARRANTY_INTAKE_CYCLE_MS || "300000"));
  let attempt = 0;

  while (true) {
    let activeStream = null;
    try {
      activeStream = await connectNegotiationStream(agentClient);
      console.log("Warranty worker online. Waiting for a paid incoming order.");
      const snapshot = await waitForPaidProviderOrder(agentClient, cycleMs);
      return { incomingSnapshot: snapshot, stream: activeStream };
    } catch (error) {
      activeStream?.close?.();
      const delayMs = retryDelayMs(attempt++);
      console.warn(`Warranty intake wait failed: ${error.message}; retrying in ${Math.round(delayMs / 1000)}s`);
      await sleep(delayMs);
    }
  }
}

async function getIncomingOrderWithRetry(agentClient, orderId) {
  let attempt = 0;
  while (true) {
    try {
      return await agentClient.getOrder(orderId);
    } catch (error) {
      const delayMs = retryDelayMs(attempt++);
      console.warn(`could not read incoming order ${orderId}: ${error.message}; retrying in ${Math.round(delayMs / 1000)}s`);
      await sleep(delayMs);
    }
  }
}

async function connectNegotiationStream(agentClient) {
  const nextStream = await agentClient.connectWebSocket();
  nextStream.on(EventType.NegotiationCreated, async (event) => {
    if (!event.negotiation_id) return;
    try {
      const negotiation = await agentClient.getNegotiation(event.negotiation_id);
      const requestCheck = normalizeWarrantyRequest(parseRequirements(negotiation.requirements), {
        allowedTargetServiceIds: optionalEnv("WARRANTY_ALLOWED_TARGET_SERVICE_IDS"),
        defaultTimeoutMs: Number(process.env.WARRANTY_TARGET_TIMEOUT_SECONDS || "600") * 1000,
      });
      if (!requestCheck.ok) {
        await agentClient.rejectNegotiation(event.negotiation_id, requestCheck.reason);
        console.log(`rejected Warranty negotiation ${event.negotiation_id}: ${requestCheck.reason}`);
        return;
      }
      const result = await agentClient.acceptNegotiation(event.negotiation_id);
      console.log(`accepted Warranty negotiation ${event.negotiation_id}, order ${result.order.orderId}`);
    } catch (error) {
      console.warn(`could not accept negotiation ${event.negotiation_id}: ${error.message}`);
    }
  });
  nextStream.on(EventType.OrderPaid, (event) => {
    console.log(`Warranty order paid ${event.order_id || ""}`);
  });
  nextStream.onAny((event) => {
    if (process.env.CROO_VERBOSE === "1") console.log(`event ${event.type}`, event.order_id || event.negotiation_id || "");
  });
  return nextStream;
}

async function rejectIncoming(order, reason) {
  if (order.status === OrderStatus.Paid) {
    await client.rejectOrder(order.orderId, reason);
    console.log(`rejected paid Warranty order ${order.orderId}: ${reason}`);
    return;
  }
  throw new Error(`incoming order ${order.orderId} missing targetServiceId and status=${order.status}`);
}

async function rejectBeforeTargetPayment(order, reason, details = {}) {
  console.warn(reason);
  await rejectIncoming(order, reason);
  stream?.close();
  console.log(
    stringify({
      ok: false,
      outcome: "rejected_before_target_payment",
      incomingOrderId: order.orderId,
      reason,
      ...details,
    }),
  );
  process.exit(0);
}

function errorMessage(error) {
  if (error?.reason) return error.reason;
  if (error?.message) return error.message;
  return String(error);
}

function retryDelayMs(attempt) {
  const baseMs = Number(process.env.WARRANTY_RETRY_BASE_MS || "5000");
  const maxMs = Number(process.env.WARRANTY_RETRY_MAX_MS || "60000");
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 4));
}

function checkTargetPrice(targetOrderDetail, targetOrder) {
  const rawPrice = targetOrderDetail.price || targetOrder.price || targetOrderDetail.amount || targetOrder.amount;
  const targetPriceAtomic = parseUsdcAtomic(rawPrice);
  if (targetPriceAtomic === null) return { ok: false, reason: "target order price was unreadable; Warranty did not pay it." };
  const maxTargetPriceAtomic = usdcToAtomic(optionalEnv("WARRANTY_MAX_TARGET_PRICE_USDC", "0.10"));
  if (maxTargetPriceAtomic === null) return { ok: false, reason: "WARRANTY_MAX_TARGET_PRICE_USDC is invalid." };
  if (targetPriceAtomic > maxTargetPriceAtomic) {
    return {
      ok: false,
      reason: `target price ${targetPriceAtomic} atomic USDC exceeds Warranty max ${maxTargetPriceAtomic} atomic USDC.`,
    };
  }
  return { ok: true };
}
