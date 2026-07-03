import { EventType } from "@croo-network/sdk";
import { stubClient } from "./config.mjs";

const client = stubClient();
const stream = await client.connectWebSocket();

console.log("failing stub provider online");
console.log("It accepts negotiations and paid orders, then intentionally does not deliver.");

stream.on(EventType.NegotiationCreated, async (event) => {
  if (!event.negotiation_id) return;
  const result = await client.acceptNegotiation(event.negotiation_id);
  console.log(`accepted negotiation ${event.negotiation_id}, order ${result.order.orderId}`);
});

stream.on(EventType.OrderPaid, async (event) => {
  console.log(`paid order ${event.order_id}; intentionally not delivering`);
});

stream.onAny((event) => {
  console.log(`event ${event.type}`, event.order_id || event.negotiation_id || "");
});

process.on("SIGINT", () => {
  stream.close();
  process.exit(0);
});
