import { DeliverableType, OrderStatus } from "@croo-network/sdk";
import { sleep } from "./config.mjs";

const DEFAULT_POLL_MS = Number(process.env.WARRANTY_POLL_MS || "5000");

export async function waitForOrderByNegotiation(client, negotiationId, role = "buyer", timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const orders = await client.listOrders({ role, page: 1, pageSize: 50 });
    const match = orders.find((order) => order.negotiationId === negotiationId);
    if (match) return match;
    await sleep(DEFAULT_POLL_MS);
  }
  throw new Error(`Timed out waiting for order from negotiation ${negotiationId}`);
}

export async function waitForCreatedOrderByNegotiation(client, negotiationId, role = "buyer", timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "missing";
  while (Date.now() < deadline) {
    const orders = await client.listOrders({ role, page: 1, pageSize: 50 });
    const match = orders.find((order) => order.negotiationId === negotiationId);
    if (match) {
      lastStatus = match.status;
      if (match.status === OrderStatus.Created) return match;
      if (
        match.status === OrderStatus.CreateFailed ||
        match.status === OrderStatus.Expired ||
        match.status === OrderStatus.Rejected
      ) {
        throw new Error(`Order from negotiation ${negotiationId} reached ${match.status}: ${match.rejectReason || ""}`);
      }
    }
    await sleep(DEFAULT_POLL_MS);
  }
  throw new Error(`Timed out waiting for created order from negotiation ${negotiationId}; lastStatus=${lastStatus}`);
}

export async function waitForPaidProviderOrder(client, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const paid = await client.listOrders({ role: "provider", status: OrderStatus.Paid, page: 1, pageSize: 50 });
    if (paid.length) return paid[0];
    await sleep(DEFAULT_POLL_MS);
  }
  throw new Error("Timed out waiting for a paid provider order");
}

export async function waitForTerminalOrder(client, orderId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const order = await client.getOrder(orderId);
    if (
      order.status === OrderStatus.Completed ||
      order.status === "delivered" ||
      order.status === OrderStatus.Expired ||
      order.status === OrderStatus.Rejected
    ) {
      return order;
    }
    if (order.status === OrderStatus.DeliverFailed || order.status === OrderStatus.PayFailed || order.status === OrderStatus.CreateFailed) {
      return order;
    }
    await sleep(DEFAULT_POLL_MS);
  }
  return await client.getOrder(orderId);
}

export async function deliverJson(client, orderId, payload) {
  return client.deliverOrder(orderId, {
    deliverableType: DeliverableType.Text,
    deliverableText: JSON.stringify(payload, null, 2),
  });
}

export function hasValidDelivery(delivery) {
  if (!delivery) return false;
  if (!delivery.deliverableText || !delivery.deliverableText.trim()) return false;
  const status = String(delivery.status || "").toLowerCase();
  return status === "submitted" || status === "accepted" || status === "delivered" || status === "completed" || status === "";
}
