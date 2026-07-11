import { OrderStatus } from "@croo-network/sdk";
import { parseRequirements, sleep } from "./config.mjs";
import { CROO_NEGOTIATION_ROLE, CROO_ORDER_ROLE } from "./croo-contract.mjs";
import { deliverJson, hasValidDelivery, waitForCreatedOrderByNegotiation, waitForTerminalOrder } from "./orders.mjs";
import { getReserveBalance, refundBuyer } from "./refund.mjs";
import { validateIncomingCoverage, validateTargetOrder } from "./warranty-policy.mjs";
import { normalizeWarrantyRequest } from "./warranty-request.mjs";

const PAID_OR_LATER = new Set([
  OrderStatus.Paid,
  OrderStatus.Delivering,
  OrderStatus.Completed,
  "delivered",
]);

export async function processWarrantyOrder({
  client,
  incomingOrderId,
  state,
  policy,
  refund = refundBuyer,
  reserveBalance = getReserveBalance,
  logger = console,
}) {
  let record = await state.load(incomingOrderId);
  let incoming = await client.getOrder(incomingOrderId);

  if (record && isJournalTerminal(record.stage)) {
    if (incomingMatchesOutcome(incoming, record.stage)) return record;
    record = await state.update(incomingOrderId, {
      stage: "INCOMING_DELIVERY_SUBMITTED",
      pendingOutcome: record.stage,
    });
  }
  if (isIncomingComplete(incoming)) {
    if (!record) return { incomingOrderId, stage: "ALREADY_COMPLETED" };
    const stage = outcomeFromRecord(record);
    return state.update(incomingOrderId, { stage, recoveredFromIncomingCompletion: true });
  }
  if ([OrderStatus.Rejected, OrderStatus.Expired].includes(incoming.status)) {
    if (!record) return { incomingOrderId, stage: "ALREADY_REJECTED" };
    return state.update(incomingOrderId, { stage: "REJECTED", incomingTerminalStatus: incoming.status });
  }
  if (incoming.status !== OrderStatus.Paid && !(record && isIncomingResumable(incoming.status))) {
    throw new Error(`incoming order ${incomingOrderId} is not paid, status=${incoming.status}`);
  }

  if (!record) {
    const request = await readAndValidateRequest(client, incoming, policy);
    if (!request.ok) return rejectAndRecord({ client, incoming, reason: request.reason, state, logger });

    const coverage = validateIncomingCoverage(incoming, policy);
    if (!coverage.ok) return rejectAndRecord({ client, incoming, reason: coverage.reason, state, logger });

    const recentBuyerOrders = await state.recentBuyerOrderCount(
      incoming.requesterWalletAddress,
      policy.buyerWindowMs,
      incomingOrderId,
    );
    if (recentBuyerOrders >= policy.maxOrdersPerBuyerWindow) {
      return rejectAndRecord({
        client,
        incoming,
        reason: `Warranty buyer limit reached: ${policy.maxOrdersPerBuyerWindow} covered order(s) per ${policy.buyerWindowMs / 1000} seconds.`,
        state,
        logger,
      });
    }

    const otherLiabilities = await state.activeLiabilityAtomic(incomingOrderId);
    if (!policy.refundDryRun) {
      const balance = await reserveBalance({ token: policy.baseUsdc });
      const required = otherLiabilities + coverage.amountAtomic;
      if (balance < required) {
        return rejectAndRecord({
          client,
          incoming,
          reason: `Warranty reserve cannot cover this order: balance=${balance}, reserved=${otherLiabilities}, requested=${coverage.amountAtomic}.`,
          state,
          logger,
        });
      }
    }

    record = await state.save({
      incomingOrderId,
      stage: "COVERAGE_RESERVED",
      buyerWallet: incoming.requesterWalletAddress,
      coverageAmountAtomic: coverage.amountAtomic.toString(),
      paymentToken: coverage.token,
      request: request.request,
    });
  }

  const request = record.request;
  const requestedTargetServiceId = request.targetServiceId;
  const targetServiceId = requestedTargetServiceId;
  if (!policy.allowedTargetServiceIds.includes(targetServiceId)) {
    return rejectAndRecord({ client, incoming, reason: `target service is not allowlisted: ${targetServiceId}`, state, logger });
  }

  record = await ensureTargetNegotiation({ client, incoming, record, state, policy, targetServiceId, logger });
  try {
    record = await ensureTargetOrder({ client, incoming, record, state, policy, logger });
  } catch (error) {
    if (/Timed out|reached (create_failed|expired|rejected)/i.test(error.message)) {
      return rejectAndRecord({
        client,
        incoming,
        reason: `target service did not create a payable order: ${error.message}`,
        state,
        logger,
        record,
      });
    }
    throw error;
  }

  const targetOrder = await client.getOrder(record.targetOrderId);
  if (
    !targetOrder.payTxHash &&
    [OrderStatus.CreateFailed, OrderStatus.PayFailed, OrderStatus.Expired, OrderStatus.Rejected].includes(targetOrder.status)
  ) {
    return rejectAndRecord({
      client,
      incoming,
      reason: `target order failed before Warranty paid it: status=${targetOrder.status}`,
      state,
      logger,
      record,
    });
  }
  const targetCheck = validateTargetOrder(targetOrder, policy);
  if (!targetCheck.ok) {
    return rejectAndRecord({ client, incoming, reason: targetCheck.reason, state, logger, record });
  }

  record = await ensureTargetPaid({ client, incoming, record, state, timeoutMs: request.timeoutMs, logger });
  const terminal = await waitForTerminalOrder(client, record.targetOrderId, remainingMs(record.targetDeadlineAt));
  const targetCompletedAt = targetCompletionTimestamp(terminal);
  const targetOnTime = targetCompletedAt !== null && targetCompletedAt <= Date.parse(record.targetDeadlineAt);
  record = await state.update(incomingOrderId, {
    targetStatus: terminal.status,
    targetCompletedAt: targetCompletedAt === null ? null : new Date(targetCompletedAt).toISOString(),
    targetOnTime,
    stage: "TARGET_TERMINAL",
  });

  let delivery = null;
  if (isDeliveryStatus(terminal.status) && targetOnTime) delivery = await client.getDelivery(record.targetOrderId);
  if (hasValidDelivery(delivery)) {
    const payload = {
      warranty: "fulfilled",
      incomingOrderId,
      buyerWallet: incoming.requesterWalletAddress,
      requestedTargetServiceId,
      targetOrderId: record.targetOrderId,
      targetServiceId,
      targetPayTxHash: record.targetPayTxHash,
      targetDelivery: delivery,
    };
    const delivered = await deliverIncomingOnce({ client, incomingOrderId, payload, state, stage: "FULFILLED" });
    logger.log(`Warranty fulfilled ${incomingOrderId} through target ${record.targetOrderId}`);
    return delivered;
  }

  record = await state.update(incomingOrderId, { stage: "REFUND_PENDING" });
  const refundResult = await refund({
    to: incoming.requesterWalletAddress,
    amount: record.coverageAmountAtomic,
    token: record.paymentToken,
    orderId: incomingOrderId,
    reason: `target ${record.targetOrderId} status=${terminal.status} on_time=${targetOnTime} delivery_valid=false`,
    preparedTransaction: record.refundPrepared || null,
    onPrepared: async (prepared) => {
      record = await state.update(incomingOrderId, { stage: "REFUND_PREPARED", refundPrepared: prepared });
    },
  });
  record = await state.update(incomingOrderId, { stage: "REFUND_CONFIRMED", refundResult });

  const payload = {
    warranty: "refunded",
    incomingOrderId,
    buyerWallet: incoming.requesterWalletAddress,
    requestedTargetServiceId,
    targetOrderId: record.targetOrderId,
    targetServiceId,
    targetPayTxHash: record.targetPayTxHash,
    targetStatus: terminal.status,
    targetCompletedAt: record.targetCompletedAt,
    targetDeadlineAt: record.targetDeadlineAt,
    targetOnTime,
    refund: refundResult,
  };
  const delivered = await deliverIncomingOnce({ client, incomingOrderId, payload, state, stage: "REFUNDED" });
  logger.log(`Warranty refunded ${incomingOrderId} after target ${record.targetOrderId}`);
  return delivered;
}

async function readAndValidateRequest(client, incoming, policy) {
  const negotiation = await client.getNegotiation(incoming.negotiationId);
  return normalizeWarrantyRequest(parseRequirements(negotiation.requirements), {
    allowedTargetServiceIds: policy.allowedTargetServiceIds.join(","),
    defaultTimeoutMs: policy.defaultTimeoutMs,
    minTimeoutMs: policy.minTimeoutMs,
    maxTimeoutMs: policy.maxTimeoutMs,
  });
}

async function ensureTargetNegotiation({ client, incoming, record, state, policy, targetServiceId, logger }) {
  if (record.targetNegotiationId) return record;
  record = await state.update(incoming.orderId, { stage: "TARGET_NEGOTIATION_PENDING", targetServiceId });
  const existing = await findNegotiationForIncoming(client, incoming.orderId);
  const negotiation = existing || await client.negotiateOrder({
    serviceId: targetServiceId,
    requirements: JSON.stringify(record.request.targetRequirements),
    metadata: JSON.stringify({
      warrantyIncomingOrderId: incoming.orderId,
      warrantyBuyerWallet: incoming.requesterWalletAddress,
    }),
  });
  logger.log(`${existing ? "recovered" : "created"} target negotiation ${negotiation.negotiationId}`);
  const targetNegotiatedAt = validTimestamp(negotiation.createdTime) || new Date().toISOString();
  return state.update(incoming.orderId, {
    stage: "TARGET_NEGOTIATED",
    targetNegotiationId: negotiation.negotiationId,
    targetServiceId,
    targetNegotiatedAt,
    targetAcceptDeadlineAt: new Date(Date.parse(targetNegotiatedAt) + policy.targetAcceptMs).toISOString(),
  });
}

async function ensureTargetOrder({ client, incoming, record, state, policy, logger }) {
  if (record.targetOrderId) return record;
  record = await state.update(incoming.orderId, { stage: "TARGET_ORDER_PENDING" });
  let order = await findOrderForNegotiation(client, record.targetNegotiationId);
  order ||= await waitForCreatedOrderByNegotiation(
    client,
    record.targetNegotiationId,
    CROO_ORDER_ROLE.requester,
    remainingMs(record.targetAcceptDeadlineAt, policy.targetAcceptMs),
  );
  logger.log(`target order ${order.orderId} status=${order.status}`);
  return state.update(incoming.orderId, { stage: "TARGET_ORDER_CREATED", targetOrderId: order.orderId });
}

async function ensureTargetPaid({ client, incoming, record, state, timeoutMs, logger }) {
  if (record.targetPayTxHash && record.targetDeadlineAt) return record;
  if (record.targetPayTxHash) {
    const recovered = await client.getOrder(record.targetOrderId);
    return saveTargetPaymentTiming({ incoming, record, state, target: recovered, txHash: record.targetPayTxHash, timeoutMs });
  }
  record = await state.update(incoming.orderId, { stage: "TARGET_PAYMENT_PENDING" });
  let target = await client.getOrder(record.targetOrderId);
  if (target.status === OrderStatus.Paying) target = await waitForPaymentResolution(client, target.orderId);

  let txHash = target.payTxHash || "";
  if (!txHash && !PAID_OR_LATER.has(target.status)) {
    if (target.status !== OrderStatus.Created) {
      throw new Error(`target order ${target.orderId} cannot be paid from status=${target.status}`);
    }
    try {
      const paid = await client.payOrder(target.orderId);
      txHash = paid.txHash || paid.order?.payTxHash || "";
    } catch (error) {
      target = await client.getOrder(target.orderId);
      txHash = target.payTxHash || "";
      if (!txHash && !PAID_OR_LATER.has(target.status)) throw error;
    }
  }
  if (!txHash) {
    target = await client.getOrder(target.orderId);
    txHash = target.payTxHash || "";
  }
  if (!txHash) throw new Error(`target order ${target.orderId} appears paid but has no payment transaction hash`);
  logger.log(`target paid ${txHash}`);
  target = await client.getOrder(target.orderId);
  return saveTargetPaymentTiming({ incoming, record, state, target, txHash, timeoutMs });
}

async function saveTargetPaymentTiming({ incoming, record, state, target, txHash, timeoutMs }) {
  const targetPaidAt = validTimestamp(target.paidAt) || validTimestamp(record.targetPaidAt) || new Date().toISOString();
  return state.update(incoming.orderId, {
    stage: "TARGET_PAID",
    targetPayTxHash: txHash,
    targetPaidAt,
    targetDeadlineAt: new Date(Date.parse(targetPaidAt) + timeoutMs).toISOString(),
  });
}

async function deliverIncomingOnce({ client, incomingOrderId, payload, state, stage }) {
  let current = await client.getOrder(incomingOrderId);
  if (isIncomingComplete(current)) {
    return state.update(incomingOrderId, { stage, incomingDeliverTxHash: current.deliverTxHash || null });
  }
  if ([OrderStatus.Rejected, OrderStatus.Expired].includes(current.status)) {
    return state.update(incomingOrderId, { stage: "REJECTED", incomingTerminalStatus: current.status });
  }

  let record = await state.load(incomingOrderId);
  let deliverTxHash = current.deliverTxHash || record?.incomingDeliverTxHash || null;
  if (current.status === OrderStatus.DeliverFailed) {
    deliverTxHash = null;
    record = await state.update(incomingOrderId, {
      stage: "INCOMING_DELIVERY_PENDING",
      pendingOutcome: stage,
      incomingDeliverTxHash: null,
      previousFailedDeliverTxHash: current.deliverTxHash || record?.incomingDeliverTxHash || null,
    });
  }
  if (!deliverTxHash && !isIncomingDeliveryPending(current.status)) {
    await state.update(incomingOrderId, { stage: "INCOMING_DELIVERY_PENDING", pendingOutcome: stage });
    const result = await deliverJson(client, incomingOrderId, payload);
    deliverTxHash = result.txHash;
    record = await state.update(incomingOrderId, {
      stage: "INCOMING_DELIVERY_SUBMITTED",
      pendingOutcome: stage,
      incomingDeliverTxHash: deliverTxHash,
    });
  } else if (deliverTxHash) {
    record = await state.update(incomingOrderId, {
      stage: "INCOMING_DELIVERY_SUBMITTED",
      pendingOutcome: stage,
      incomingDeliverTxHash: deliverTxHash,
    });
  }

  current = await waitForIncomingCompletion(client, incomingOrderId);
  if (isIncomingComplete(current)) {
    return state.update(incomingOrderId, {
      stage,
      incomingDeliverTxHash: current.deliverTxHash || deliverTxHash,
      incomingCompletedAt: current.updatedTime || current.deliveredAt || new Date().toISOString(),
    });
  }
  if ([OrderStatus.Rejected, OrderStatus.Expired].includes(current.status)) {
    return state.update(incomingOrderId, { stage: "REJECTED", incomingTerminalStatus: current.status });
  }
  throw new Error(`incoming delivery ${incomingOrderId} is not final, status=${current.status}`);
}

async function waitForIncomingCompletion(client, orderId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let order = await client.getOrder(orderId);
  while (isIncomingDeliveryPending(order.status) && Date.now() < deadline) {
    await sleep(2_000);
    order = await client.getOrder(orderId);
  }
  return order;
}

async function rejectAndRecord({ client, incoming, reason, state, logger, record = null }) {
  let current = await client.getOrder(incoming.orderId);
  if (current.status === OrderStatus.Paid) {
    await client.rejectOrder(incoming.orderId, reason);
    current = await waitForRejectedIncoming(client, incoming.orderId);
  } else if (current.status === OrderStatus.Rejecting) {
    current = await waitForRejectedIncoming(client, incoming.orderId);
  }
  if (![OrderStatus.Rejected, OrderStatus.Expired].includes(current.status)) {
    throw new Error(`incoming order ${incoming.orderId} did not reach a refunded terminal state; status=${current.status}`);
  }
  logger.warn(`rejected Warranty order ${incoming.orderId}: ${reason}`);
  const base = record || await state.load(incoming.orderId) || {
    incomingOrderId: incoming.orderId,
    coverageAmountAtomic: "0",
    paymentToken: incoming.paymentToken || null,
  };
  return state.save({ ...base, stage: "REJECTED", rejectionReason: reason });
}

async function waitForRejectedIncoming(client, orderId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let order = await client.getOrder(orderId);
  while ([OrderStatus.Paid, OrderStatus.Rejecting].includes(order.status) && Date.now() < deadline) {
    await sleep(2_000);
    order = await client.getOrder(orderId);
  }
  return order;
}

async function findNegotiationForIncoming(client, incomingOrderId) {
  for (let page = 1; page <= 10; page += 1) {
    const negotiations = await client.listNegotiations({
      role: CROO_NEGOTIATION_ROLE.requester,
      page,
      pageSize: 50,
    });
    const match = negotiations.find((negotiation) => parseMetadata(negotiation.metadata)?.warrantyIncomingOrderId === incomingOrderId);
    if (match) return match;
    if (negotiations.length < 50) return null;
  }
  return null;
}

async function findOrderForNegotiation(client, negotiationId) {
  for (let page = 1; page <= 10; page += 1) {
    const orders = await client.listOrders({ role: CROO_ORDER_ROLE.requester, page, pageSize: 50 });
    const match = orders.find((order) => order.negotiationId === negotiationId);
    if (match) return match;
    if (orders.length < 50) return null;
  }
  return null;
}

async function waitForPaymentResolution(client, orderId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let order = await client.getOrder(orderId);
  while (order.status === OrderStatus.Paying && Date.now() < deadline) {
    await sleep(2_000);
    order = await client.getOrder(orderId);
  }
  return order;
}

function parseMetadata(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return null;
  }
}

function isIncomingComplete(order) {
  return order.status === OrderStatus.Completed || order.status === "delivered";
}

function isIncomingDeliveryPending(status) {
  return status === OrderStatus.Delivering || status === "evaluating";
}

function isIncomingResumable(status) {
  return isIncomingDeliveryPending(status) || status === OrderStatus.DeliverFailed;
}

function incomingMatchesOutcome(incoming, stage) {
  if (stage === "REJECTED") return [OrderStatus.Rejected, OrderStatus.Expired].includes(incoming.status);
  return isIncomingComplete(incoming);
}

function outcomeFromRecord(record) {
  if (record.pendingOutcome === "REFUNDED" || record.refundResult || record.stage === "REFUND_CONFIRMED") return "REFUNDED";
  if (record.pendingOutcome === "FULFILLED") return "FULFILLED";
  if (record.stage === "REFUNDED") return "REFUNDED";
  return "FULFILLED";
}

function remainingMs(deadlineAt, fallbackMs = 0) {
  const deadline = Date.parse(deadlineAt || "");
  if (!Number.isFinite(deadline)) return fallbackMs;
  return Math.max(0, deadline - Date.now());
}

function validTimestamp(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function targetCompletionTimestamp(order) {
  if (!isDeliveryStatus(order.status)) return null;
  const explicit = Date.parse(order.deliveredAt || order.updatedTime || "");
  return Number.isFinite(explicit) ? explicit : Date.now();
}

function isDeliveryStatus(status) {
  return status === OrderStatus.Completed || status === "delivered";
}

function isJournalTerminal(stage) {
  return stage === "FULFILLED" || stage === "REFUNDED" || stage === "REJECTED";
}
