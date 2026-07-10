import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  keccak256,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_USDC, clean, optionalEnv, requiredEnv } from "./config.mjs";

export async function getReserveBalance({ token = BASE_USDC, clients = null } = {}) {
  const runtime = clients || createRefundClients();
  const refundToken = getAddress(token);
  return runtime.publicClient.readContract({
    address: refundToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [runtime.account.address],
  });
}

export async function refundBuyer({
  to,
  amount,
  token,
  reason,
  orderId,
  preparedTransaction = null,
  onPrepared = null,
  clients = null,
}) {
  const dryRun = optionalEnv("WARRANTY_REFUND_DRY_RUN", "1") !== "0";
  const refundToken = getAddress(token || BASE_USDC);
  const refundTo = getAddress(to);
  const refundAmount = BigInt(amount);
  if (refundAmount <= 0n) throw new Error("refund amount must be positive");

  if (dryRun) {
    return {
      dryRun: true,
      to: refundTo,
      token: refundToken,
      amount: refundAmount.toString(),
      reason,
      orderId,
      note: "Dry-run refund only; no money moved.",
    };
  }

  const runtime = clients || createRefundClients();
  if (!preparedTransaction) {
    const balance = await getReserveBalance({ token: refundToken, clients: runtime });
    if (balance < refundAmount) throw new Error(`reserve balance ${balance} is below refund amount ${refundAmount}`);
  }

  const prepared = preparedTransaction || (await prepareRefundTransaction(runtime, {
    amount: refundAmount,
    to: refundTo,
    token: refundToken,
  }));
  validatePreparedRefund(prepared, { amount: refundAmount, to: refundTo, token: refundToken });

  if (!preparedTransaction && onPrepared) await onPrepared(prepared);

  let receipt = await receiptOrNull(runtime.publicClient, prepared.txHash);
  if (!receipt) {
    try {
      const broadcastHash = await runtime.publicClient.sendRawTransaction({
        serializedTransaction: prepared.serializedTransaction,
      });
      if (broadcastHash.toLowerCase() !== prepared.txHash.toLowerCase()) {
        throw new Error(`refund broadcast hash mismatch: expected ${prepared.txHash}, got ${broadcastHash}`);
      }
    } catch (error) {
      receipt = await receiptOrNull(runtime.publicClient, prepared.txHash);
      if (!receipt && !isKnownTransactionError(error)) throw error;
    }
    receipt ||= await runtime.publicClient.waitForTransactionReceipt({ hash: prepared.txHash, timeout: 120_000 });
  }
  if (receipt.status !== "success") throw new Error(`refund transfer reverted: ${prepared.txHash}`);

  return {
    dryRun: false,
    txHash: prepared.txHash,
    explorer: `https://basescan.org/tx/${prepared.txHash}`,
    from: runtime.account.address,
    to: refundTo,
    token: refundToken,
    amount: refundAmount.toString(),
    reason,
    orderId,
  };
}

export function createRefundClients() {
  const key = normalizeKey(requiredEnv("WARRANTY_RESERVE_PRIVATE_KEY", "Reserve wallet key that sends refunds"));
  const account = privateKeyToAccount(key);
  const rpc = clean(process.env.BASE_RPC_URL) || "https://mainnet.base.org";
  const transport = http(rpc, { timeout: 60_000, retryCount: 3 });
  return {
    account,
    publicClient: createPublicClient({ chain: base, transport }),
    walletClient: createWalletClient({ account, chain: base, transport }),
  };
}

async function prepareRefundTransaction(runtime, { amount, to, token }) {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amount],
  });
  const request = await runtime.walletClient.prepareTransactionRequest({
    account: runtime.account,
    chain: base,
    to: token,
    data,
    value: 0n,
  });
  const serializedTransaction = await runtime.account.signTransaction(request);
  return {
    txHash: keccak256(serializedTransaction),
    serializedTransaction,
    token,
    to,
    amount: amount.toString(),
    nonce: String(request.nonce),
    preparedAt: new Date().toISOString(),
  };
}

function validatePreparedRefund(prepared, expected) {
  if (!prepared?.txHash || !prepared?.serializedTransaction) throw new Error("saved refund transaction is incomplete");
  if (getAddress(prepared.token) !== expected.token) throw new Error("saved refund token does not match this order");
  if (getAddress(prepared.to) !== expected.to) throw new Error("saved refund recipient does not match this order");
  if (BigInt(prepared.amount) !== expected.amount) throw new Error("saved refund amount does not match this order");
  if (keccak256(prepared.serializedTransaction).toLowerCase() !== prepared.txHash.toLowerCase()) {
    throw new Error("saved refund transaction hash is invalid");
  }
}

async function receiptOrNull(publicClient, hash) {
  try {
    return await publicClient.getTransactionReceipt({ hash });
  } catch (error) {
    if (String(error?.name || "").includes("TransactionReceiptNotFound")) return null;
    if (/could not be found|not found/i.test(String(error?.message || ""))) return null;
    throw error;
  }
}

function isKnownTransactionError(error) {
  return /already known|known transaction|nonce too low|replacement transaction underpriced/i.test(String(error?.message || ""));
}

function normalizeKey(value) {
  if (!value) return null;
  return value.startsWith("0x") ? value : `0x${value}`;
}
