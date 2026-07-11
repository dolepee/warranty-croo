import { EventType, OrderStatus } from "@croo-network/sdk";
import { assertCrooContract, CROO_NEGOTIATION_ROLE, CROO_ORDER_ROLE } from "./croo-contract.mjs";
import { parseRequirements, requiredEnv, sleep, warrantyClient } from "./config.mjs";
import { RuntimeHealth } from "./runtime-health.mjs";
import { processWarrantyOrder } from "./warranty-engine.mjs";
import { loadWarrantyPolicy } from "./warranty-policy.mjs";
import { normalizeWarrantyRequest } from "./warranty-request.mjs";
import { WarrantyStateStore } from "./warranty-state.mjs";

const client = warrantyClient();
const policy = loadWarrantyPolicy();
const warrantyServiceId = requiredEnv("WARRANTY_SERVICE_ID", "Warranty service ID listed in CROO");
if (policy.refundDryRun && process.env.WARRANTY_ALLOW_DRY_RUN_WORKER !== "1") {
  throw new Error("Warranty refuses live intake while refunds are in dry-run mode. Set real refunds or explicitly enable local dry-run intake.");
}

const state = new WarrantyStateStore();
const health = new RuntimeHealth();
await state.acquireLock();
await health.start({ serviceId: warrantyServiceId });

let stream = null;
let stopping = false;
let intakePromise = null;
const negotiationInFlight = new Set();
installSignalHandlers();

try {
  const compatibility = await assertCrooContract(client);
  await health.update({
    status: "starting",
    compatibility,
    lastCrooSuccessAt: new Date().toISOString(),
  });

  try {
    stream = await connectNegotiationStream(client);
    await health.update({ websocket: "connected" });
  } catch (error) {
    console.warn(`Warranty websocket unavailable; polling intake remains active: ${error.message}`);
    await health.update({ websocket: "unavailable", lastError: error.message });
  }

  intakePromise = runNegotiationIntake(client);
  await health.update({ status: "ready" });
  console.log("Warranty worker online. Polling intake, bounded CROO calls, refunds, and durable recovery are armed.");

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
} catch (error) {
  await health.update({ status: "failed", lastError: error.message, lastErrorAt: new Date().toISOString() });
  throw error;
} finally {
  stopping = true;
  stream?.close();
  if (intakePromise) await Promise.race([intakePromise, sleep(6_000)]);
  await health.stop();
  await state.releaseLock();
}

async function processWithRetry(incomingOrderId) {
  let attempt = 0;
  while (!stopping) {
    try {
      const record = await state.load(incomingOrderId);
      await health.update({
        status: "processing",
        activeOrderId: incomingOrderId,
        activeStage: record?.stage || "DISCOVERED",
      });
      const result = await processWarrantyOrder({ client, incomingOrderId, state, policy });
      console.log(JSON.stringify({ ok: true, incomingOrderId, stage: result.stage }));
      await health.update({
        status: "ready",
        activeOrderId: null,
        activeStage: null,
        lastCompletedOrderId: incomingOrderId,
        lastCompletedStage: result.stage,
        lastCrooSuccessAt: new Date().toISOString(),
        lastError: null,
      });
      return result;
    } catch (error) {
      attempt += 1;
      const delayMs = Math.min(30_000, 2_000 * 2 ** Math.min(attempt - 1, 4));
      if (attempt <= 3 || attempt % 10 === 0) {
        console.error(`Warranty order ${incomingOrderId} paused safely: ${error.message}; reconciling in ${delayMs / 1000}s`);
      }
      await health.update({
        status: "degraded",
        activeOrderId: incomingOrderId,
        retryAttempt: attempt,
        lastError: error.message,
        lastErrorAt: new Date().toISOString(),
      });
      await sleep(delayMs);
    }
  }
  return null;
}

async function waitForNextPaidOrder(agentClient) {
  let failures = 0;
  while (!stopping) {
    try {
      const paid = await agentClient.listOrders({
        role: CROO_ORDER_ROLE.provider,
        status: OrderStatus.Paid,
        page: 1,
        pageSize: 50,
      });
      failures = 0;
      await health.update({ lastOrderPollAt: new Date().toISOString(), lastCrooSuccessAt: new Date().toISOString() });
      if (paid.length) {
        const ordered = [...paid].sort((a, b) => String(a.createdTime || a.createdAt).localeCompare(String(b.createdTime || b.createdAt)));
        return ordered[0];
      }
    } catch (error) {
      failures += 1;
      if (failures <= 3 || failures % 12 === 0) console.warn(`Warranty order poll failed: ${error.message}`);
      await health.update({ lastError: error.message, lastErrorAt: new Date().toISOString() });
    }
    await sleep(5_000);
  }
  return null;
}

async function runNegotiationIntake(agentClient) {
  let failures = 0;
  while (!stopping) {
    try {
      const pending = await agentClient.listNegotiations({
        role: CROO_NEGOTIATION_ROLE.provider,
        status: "pending",
        page: 1,
        pageSize: 50,
      });
      failures = 0;
      await health.update({ lastIntakePollAt: new Date().toISOString(), lastCrooSuccessAt: new Date().toISOString() });
      for (const negotiation of pending) await handleNegotiation(negotiation.negotiationId);
    } catch (error) {
      failures += 1;
      if (failures <= 3 || failures % 12 === 0) console.warn(`Warranty negotiation poll failed: ${error.message}`);
      await health.update({ lastError: error.message, lastErrorAt: new Date().toISOString() });
    }
    await sleep(5_000);
  }
}

async function handleNegotiation(negotiationId) {
  if (!negotiationId || negotiationInFlight.has(negotiationId)) return;
  negotiationInFlight.add(negotiationId);
  try {
    const negotiation = await client.getNegotiation(negotiationId);
    if (negotiation.status !== "pending") return;
    if (negotiation.serviceId !== warrantyServiceId) {
      await client.rejectNegotiation(negotiationId, "Negotiation does not target the Warranty service.");
      console.warn(`rejected non-Warranty negotiation ${negotiationId}`);
      return;
    }

    const requestCheck = normalizeWarrantyRequest(parseRequirements(negotiation.requirements), {
      allowedTargetServiceIds: policy.allowedTargetServiceIds.join(","),
      defaultTimeoutMs: policy.defaultTimeoutMs,
      minTimeoutMs: policy.minTimeoutMs,
      maxTimeoutMs: policy.maxTimeoutMs,
    });
    if (!requestCheck.ok) {
      await client.rejectNegotiation(negotiationId, requestCheck.reason);
      console.log(`rejected Warranty negotiation ${negotiationId}: ${requestCheck.reason}`);
      return;
    }

    const result = await client.acceptNegotiation(negotiationId);
    console.log(`accepted Warranty negotiation ${negotiationId}, order ${result.order.orderId}`);
    await health.update({ lastAcceptedNegotiationId: negotiationId, lastCrooSuccessAt: new Date().toISOString() });
  } catch (error) {
    const latest = await client.getNegotiation(negotiationId).catch(() => null);
    if (latest && latest.status !== "pending") return;
    throw error;
  } finally {
    negotiationInFlight.delete(negotiationId);
  }
}

async function connectNegotiationStream(agentClient) {
  const nextStream = await agentClient.connectWebSocket();
  nextStream.on(EventType.NegotiationCreated, (event) => {
    handleNegotiation(event.negotiation_id).catch((error) => {
      console.warn(`could not handle negotiation ${event.negotiation_id || ""}: ${error.message}`);
    });
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
