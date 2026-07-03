import { AgentClient, EventType, OrderStatus } from "@croo-network/sdk";
import { crooConfig, optionalEnv, stringify } from "./config.mjs";

const proto = Object.getOwnPropertyNames(AgentClient.prototype).filter((name) => name !== "constructor");
const required = [
  "negotiateOrder",
  "acceptNegotiation",
  "payOrder",
  "deliverOrder",
  "getOrder",
  "getDelivery",
  "listOrders",
  "connectWebSocket",
];
const missing = required.filter((name) => !proto.includes(name));

const report = {
  ok: missing.length === 0,
  config: {
    baseURL: crooConfig().baseURL,
    wsURL: crooConfig().wsURL,
    rpcURL: crooConfig().rpcURL,
  },
  sdkMethods: proto,
  requiredMethods: required,
  missing,
  lifecycleSignals: {
    orderExpired: EventType.OrderExpired,
    orderCompleted: EventType.OrderCompleted,
    paidStatus: OrderStatus.Paid,
    completedStatus: OrderStatus.Completed,
    expiredStatus: OrderStatus.Expired,
  },
};

const key = optionalEnv("WARRANTY_SDK_KEY");
if (key) {
  const client = new AgentClient(crooConfig(), key);
  const [providerOrders, requesterOrders] = await Promise.all([
    client.listOrders({ role: "provider", page: 1, pageSize: 5 }).catch((error) => ({ error: error.message })),
    client.listOrders({ role: "buyer", page: 1, pageSize: 5 }).catch((error) => ({ error: error.message })),
  ]);
  report.live = { providerOrders, requesterOrders };
} else {
  report.live = { skipped: "set WARRANTY_SDK_KEY to inspect live Warranty orders" };
}

console.log(stringify(report));
if (!report.ok) process.exit(1);
