import { EventType, OrderStatus } from "@croo-network/sdk";
import { parseRequirements, sleep, warrantyClient } from "./config.mjs";
import { processWarrantyOrder } from "./warranty-engine.mjs";
import { loadWarrantyPolicy } from "./warranty-policy.mjs";
import { normalizeWarrantyRequest } from "./warranty-request.mjs";
import { WarrantyStateStore } from "./warranty-state.mjs";

const client = warrantyClient();
const policy = loadWarrantyPolicy();
if (policy.refundDryRun && process.env.WARRANTY_ALLOW_DRY_RUN_WORKER !== "1") {
  throw new Error("Warranty refuses live intake while refunds are in dry-run mode. Set real refunds or explicitly enable local dry-run intake.");
}
const state = new WarrantyStateStore();
await state.acquireLock();

let stream = null;
let stopping = false;
installSignalHandlers();

try {
  stream = await connectNegotiationStream(client, policy);
  console.log("Warranty worker online. Refund policy and durable recovery are armed.");

  const requestedOrderId = process.env.WARRANTY_INCOMING_ORDER_ID?.trim();
  if (requestedOrderId) {
    await processWithRetry(requestedOrderId);
  } else {
    while (!stopping) {
      const active = (await state.listActive())[0];
      const pending = active || await waitForNextPaidOrder(client);
      if (!pending) break;
      const incomingOrderId = pending.incomingOrderId || pending.orderId;
      await processWithRetry(incomingOrderId);
    }
  }
} finally {
  stream?.close();
  await state.releaseLock();
}

async function processWithRetry(incomingOrderId) {
  let attempt = 0;
  while (!stopping) {
    try {
      const result = await processWarrantyOrder({ client, incomingOrderId, state, policy });
      console.log(JSON.stringify({ ok: true, incomingOrderId, stage: result.stage }));
      return result;
    } catch (error) {
      const delayMs = Math.min(30_000, 2_000 * 2 ** Math.min(attempt++, 4));
      console.error(`Warranty order ${incomingOrderId} paused safely: ${error.message}; reconciling in ${delayMs / 1000}s`);
      await sleep(delayMs);
    }
  }
}

async function waitForNextPaidOrder(agentClient) {
  while (!stopping) {
    try {
      const paid = await agentClient.listOrders({ role: "provider", status: OrderStatus.Paid, page: 1, pageSize: 50 });
      if (paid.length) {
        const ordered = [...paid].sort((a, b) => String(a.createdTime || a.createdAt).localeCompare(String(b.createdTime || b.createdAt)));
        return ordered[0];
      }
    } catch (error) {
      console.warn(`Warranty intake poll failed: ${error.message}`);
    }
    await sleep(5_000);
  }
  return null;
}

async function connectNegotiationStream(agentClient, activePolicy) {
  const nextStream = await agentClient.connectWebSocket();
  nextStream.on(EventType.NegotiationCreated, async (event) => {
    if (!event.negotiation_id) return;
    try {
      const negotiation = await agentClient.getNegotiation(event.negotiation_id);
      const requestCheck = normalizeWarrantyRequest(parseRequirements(negotiation.requirements), {
        allowedTargetServiceIds: activePolicy.allowedTargetServiceIds.join(","),
        defaultTimeoutMs: activePolicy.defaultTimeoutMs,
        minTimeoutMs: activePolicy.minTimeoutMs,
        maxTimeoutMs: activePolicy.maxTimeoutMs,
      });
      if (!requestCheck.ok) {
        await agentClient.rejectNegotiation(event.negotiation_id, requestCheck.reason);
        console.log(`rejected Warranty negotiation ${event.negotiation_id}: ${requestCheck.reason}`);
        return;
      }
      const result = await agentClient.acceptNegotiation(event.negotiation_id);
      console.log(`accepted Warranty negotiation ${event.negotiation_id}, order ${result.order.orderId}`);
    } catch (error) {
      console.warn(`could not handle negotiation ${event.negotiation_id}: ${error.message}`);
    }
  });
  nextStream.on(EventType.OrderPaid, (event) => {
    console.log(`Warranty order paid ${event.order_id || ""}`);
  });
  return nextStream;
}

function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      stopping = true;
      stream?.close();
    });
  }
}
