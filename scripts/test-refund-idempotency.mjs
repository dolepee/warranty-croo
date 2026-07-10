import assert from "node:assert/strict";
import { keccak256 } from "viem";
import { refundBuyer } from "../src/refund.mjs";

const token = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const to = "0x1111111111111111111111111111111111111111";
const serializedTransaction = "0x02abcd";
const preparedTransaction = {
  txHash: keccak256(serializedTransaction),
  serializedTransaction,
  token,
  to,
  amount: "80000",
};
let balanceReads = 0;
let broadcasts = 0;
const clients = {
  account: { address: "0x2222222222222222222222222222222222222222" },
  publicClient: {
    async readContract() {
      balanceReads += 1;
      throw new Error("a recovered refund must check its saved receipt before checking current balance");
    },
    async getTransactionReceipt() {
      return { status: "success" };
    },
    async sendRawTransaction() {
      broadcasts += 1;
      return preparedTransaction.txHash;
    },
  },
};

const previous = process.env.WARRANTY_REFUND_DRY_RUN;
process.env.WARRANTY_REFUND_DRY_RUN = "0";
try {
  const result = await refundBuyer({
    to,
    token,
    amount: "80000",
    orderId: "recovered-order",
    reason: "recovery test",
    preparedTransaction,
    clients,
  });
  assert.equal(result.txHash, preparedTransaction.txHash);
  assert.equal(balanceReads, 0);
  assert.equal(broadcasts, 0);
} finally {
  if (previous === undefined) delete process.env.WARRANTY_REFUND_DRY_RUN;
  else process.env.WARRANTY_REFUND_DRY_RUN = previous;
}

console.log("REFUND_IDEMPOTENCY_OK");
