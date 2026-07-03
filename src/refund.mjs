import { createPublicClient, createWalletClient, erc20Abi, getAddress, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_USDC, clean, optionalEnv, requiredEnv } from "./config.mjs";

export async function refundBuyer({ to, amount, token, reason, orderId }) {
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
      note: "Set WARRANTY_REFUND_DRY_RUN=0 and WARRANTY_RESERVE_PRIVATE_KEY to send a real refund.",
    };
  }

  const key = normalizeKey(requiredEnv("WARRANTY_RESERVE_PRIVATE_KEY", "Reserve wallet key that sends refunds"));
  const account = privateKeyToAccount(key);
  const rpc = clean(process.env.BASE_RPC_URL) || "https://mainnet.base.org";
  const publicClient = createPublicClient({ chain: base, transport: http(rpc, { timeout: 60_000, retryCount: 3 }) });
  const wallet = createWalletClient({ account, chain: base, transport: http(rpc, { timeout: 60_000, retryCount: 3 }) });

  const balance = await publicClient.readContract({
    address: refundToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  if (balance < refundAmount) {
    throw new Error(`reserve balance ${balance} is below refund amount ${refundAmount}`);
  }

  const txHash = await wallet.writeContract({
    address: refundToken,
    abi: erc20Abi,
    functionName: "transfer",
    args: [refundTo, refundAmount],
    account,
    chain: base,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`refund transfer reverted: ${txHash}`);
  return {
    dryRun: false,
    txHash,
    explorer: `https://basescan.org/tx/${txHash}`,
    from: account.address,
    to: refundTo,
    token: refundToken,
    amount: refundAmount.toString(),
    reason,
    orderId,
  };
}

function normalizeKey(value) {
  if (!value) return null;
  return value.startsWith("0x") ? value : `0x${value}`;
}
