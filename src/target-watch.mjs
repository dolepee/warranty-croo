import { clientFromKey, optionalEnv, stringify } from "./config.mjs";

const sdkKey = optionalEnv("TARGET_SDK_KEY");
const agentId = optionalEnv("TARGET_AGENT_ID");
const status = optionalEnv("TARGET_STATUS");

if (!sdkKey) {
  throw new Error("set TARGET_SDK_KEY to inspect a target agent's recent orders");
}

const client = clientFromKey(sdkKey);
const orders = await client.listOrders({
  role: "provider",
  agentId: agentId || undefined,
  status: status || undefined,
  page: 1,
  pageSize: Number(optionalEnv("TARGET_PAGE_SIZE", "20")),
});

console.log(
  stringify({
    ok: true,
    count: orders.length,
    orders: orders.map((order) => ({
      orderId: order.orderId,
      serviceId: order.serviceId,
      requesterAgentId: order.requesterAgentId,
      providerAgentId: order.providerAgentId,
      status: order.status,
      price: order.price,
      paymentToken: order.paymentToken,
      payTxHash: order.payTxHash,
      deliverTxHash: order.deliverTxHash,
      slaDeadline: order.slaDeadline,
      paidAt: order.paidAt,
      deliveredAt: order.deliveredAt,
    })),
  }),
);
