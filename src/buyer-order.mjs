import { EventType } from "@croo-network/sdk";
import { buyerClient, optionalEnv, stringify } from "./config.mjs";
import { waitForCreatedOrderByNegotiation, waitForTerminalOrder } from "./orders.mjs";

const client = buyerClient();
const warrantyServiceId = optionalEnv("WARRANTY_SERVICE_ID");
if (!warrantyServiceId) throw new Error("set WARRANTY_SERVICE_ID to the Warranty service listed in the CROO dashboard");

const targetServiceId = optionalEnv("WARRANTY_TARGET_SERVICE_ID");
if (!targetServiceId) throw new Error("set WARRANTY_TARGET_SERVICE_ID to the target service Warranty should hire");

const exactTargetRequirements = optionalEnv("WARRANTY_TARGET_REQUIREMENTS");
const requirements = {
  targetServiceId,
  timeoutMs: Number(optionalEnv("WARRANTY_TARGET_TIMEOUT_SECONDS", "180")) * 1000,
  targetRequirements: exactTargetRequirements
    ? parseTargetRequirements(exactTargetRequirements)
    : {
        task: optionalEnv("WARRANTY_TASK", "Return a short result for the Warranty CAP spike."),
        requestedAt: new Date().toISOString(),
      },
};

let stream = null;
try {
  stream = await client.connectWebSocket();
  stream.on(EventType.OrderCompleted, async (event) => {
    console.log(`buyer saw order completed ${event.order_id}`);
  });
} catch (error) {
  console.warn(`websocket unavailable, continuing with polling: ${error.message}`);
}

const negotiation = await client.negotiateOrder({
  serviceId: warrantyServiceId,
  requirements: JSON.stringify(requirements),
});
console.log(`warranty negotiation ${negotiation.negotiationId}`);

const order = await waitForCreatedOrderByNegotiation(
  client,
  negotiation.negotiationId,
  "buyer",
  Number(process.env.WARRANTY_ACCEPT_MS || "180000"),
);
console.log(`warranty order ${order.orderId} status=${order.status} price=${order.price}`);

const paid = await client.payOrder(order.orderId);
console.log(`warranty paid ${paid.txHash}`);

const terminal = await waitForTerminalOrder(client, order.orderId, Number(optionalEnv("WARRANTY_BUYER_TIMEOUT_SECONDS", "480")) * 1000);
let delivery = null;
if (terminal.status === "completed") {
  delivery = await client.getDelivery(order.orderId);
}

stream?.close();
console.log(
  stringify({
    ok: terminal.status === "completed",
    orderId: order.orderId,
    payTxHash: paid.txHash,
    status: terminal.status,
    requesterWalletAddress: terminal.requesterWalletAddress,
    providerWalletAddress: terminal.providerWalletAddress,
    delivery,
  }),
);

function parseTargetRequirements(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
