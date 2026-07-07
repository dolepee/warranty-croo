import { EventType, OrderStatus } from "@croo-network/sdk";
import { optionalEnv, parseRequirements, stringify, warrantyClient } from "./config.mjs";
import {
  deliverJson,
  hasValidDelivery,
  waitForCreatedOrderByNegotiation,
  waitForPaidProviderOrder,
  waitForTerminalOrder,
} from "./orders.mjs";
import { refundBuyer } from "./refund.mjs";

const client = warrantyClient();
const incomingOrderId = process.env.WARRANTY_INCOMING_ORDER_ID;

let stream = null;
if (!incomingOrderId) {
  stream = await client.connectWebSocket();
  stream.on(EventType.NegotiationCreated, async (event) => {
    if (!event.negotiation_id) return;
    try {
      const negotiation = await client.getNegotiation(event.negotiation_id);
      const req = parseRequirements(negotiation.requirements);
      const requestedTarget = req.targetServiceId || process.env.WARRANTY_TARGET_SERVICE_ID;
      if (!isAllowedTarget(requestedTarget)) {
        await client.rejectNegotiation(
          event.negotiation_id,
          `target service is not allowlisted for supervised Warranty coverage: ${requestedTarget || "missing"}`,
        );
        console.log(`rejected Warranty negotiation ${event.negotiation_id}, target not allowlisted`);
        return;
      }
      const result = await client.acceptNegotiation(event.negotiation_id);
      console.log(`accepted Warranty negotiation ${event.negotiation_id}, order ${result.order.orderId}`);
    } catch (error) {
      console.warn(`could not accept negotiation ${event.negotiation_id}: ${error.message}`);
    }
  });
  stream.on(EventType.OrderPaid, (event) => {
    console.log(`Warranty order paid ${event.order_id || ""}`);
  });
  stream.onAny((event) => {
    if (process.env.CROO_VERBOSE === "1") console.log(`event ${event.type}`, event.order_id || event.negotiation_id || "");
  });
  console.log("Warranty worker online. Waiting for a paid incoming order.");
}

const incomingSnapshot = incomingOrderId
  ? await client.getOrder(incomingOrderId)
  : await waitForPaidProviderOrder(client, Number(process.env.WARRANTY_WAIT_MS || "180000"));
const incoming = await client.getOrder(incomingSnapshot.orderId);

if (incoming.status !== OrderStatus.Paid && incoming.status !== OrderStatus.Completed) {
  throw new Error(`incoming order ${incoming.orderId} is not paid, status=${incoming.status}`);
}

const req = parseRequirements(await getIncomingRequirements(client, incoming));
const requestedTargetServiceId = req.targetServiceId || process.env.WARRANTY_TARGET_SERVICE_ID;
const targetServiceId = process.env.WARRANTY_FORCE_TARGET_SERVICE_ID || requestedTargetServiceId;
if (!targetServiceId) throw new Error("incoming requirements must include targetServiceId or set WARRANTY_TARGET_SERVICE_ID");
if (!isAllowedTarget(targetServiceId)) throw new Error(`target service is not allowlisted: ${targetServiceId}`);

const forcedTargetRequirements = process.env.WARRANTY_FORCE_TARGET_REQUIREMENTS;
const targetRequirements = formatTargetRequirements(
  forcedTargetRequirements
    ? parseRequirements(forcedTargetRequirements)
    : req.targetRequirements || {
    task: req.task || "Return a short paid result for the Warranty CAP spike.",
    buyerOrderId: incoming.orderId,
  },
);
const targetTimeoutMs =
  req.timeoutMs !== undefined
    ? Number(req.timeoutMs)
    : Number(process.env.WARRANTY_TARGET_TIMEOUT_SECONDS || "180") * 1000;

console.log(`incoming order ${incoming.orderId}`);
console.log(`buyer wallet ${incoming.requesterWalletAddress}`);
console.log(`target service ${targetServiceId}`);
if (requestedTargetServiceId && requestedTargetServiceId !== targetServiceId) {
  console.log(`forced fallback target ${targetServiceId} replacing requested ${requestedTargetServiceId}`);
}

const negotiation = await client.negotiateOrder({
  serviceId: targetServiceId,
  requirements: targetRequirements,
  metadata: JSON.stringify({
    warrantyIncomingOrderId: incoming.orderId,
    warrantyBuyerWallet: incoming.requesterWalletAddress,
  }),
});
console.log(`target negotiation ${negotiation.negotiationId}`);

const targetOrder = await waitForCreatedOrderByNegotiation(
  client,
  negotiation.negotiationId,
  "buyer",
  Number(process.env.WARRANTY_TARGET_ACCEPT_MS || "180000"),
);
console.log(`target order ${targetOrder.orderId} status=${targetOrder.status} price=${targetOrder.price}`);

const paid = await client.payOrder(targetOrder.orderId);
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

function formatTargetRequirements(value) {
  return JSON.stringify(value);
}

function isAllowedTarget(targetServiceId) {
  const raw = optionalEnv("WARRANTY_ALLOWED_TARGET_SERVICE_IDS");
  if (!raw) return true;
  const allowed = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return Boolean(targetServiceId && allowed.includes(targetServiceId));
}
