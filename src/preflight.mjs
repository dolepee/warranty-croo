import { createPublicClient, erc20Abi, formatUnits, getAddress, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_USDC, optionalEnv, stringify } from "./config.mjs";

const checks = [];

checkEnv("CROO_API_URL", false, "defaults to https://api.croo.network");
checkEnv("CROO_WS_URL", false, "defaults to wss://api.croo.network/ws");
checkEnv("WARRANTY_SDK_KEY", true, "Warranty provider agent SDK key");
checkEnv("WARRANTY_SERVICE_ID", true, "Warranty service ID listed in CROO dashboard");
checkEnv("BUYER_SDK_KEY", true, "Buyer agent SDK key");
checkEnv("WARRANTY_TARGET_SERVICE_ID", true, "External target service ID Warranty will hire");
checkEnv("BASE_RPC_URL", false, "defaults to https://mainnet.base.org");
checkEnv("BASE_USDC", false, `defaults to ${BASE_USDC}`);
checkEnv("WARRANTY_REFUND_DRY_RUN", false, "defaults to 1, which does not move funds");

const dryRun = optionalEnv("WARRANTY_REFUND_DRY_RUN", "1") !== "0";
if (!dryRun) {
  checkEnv("WARRANTY_RESERVE_PRIVATE_KEY", true, "reserve wallet key required only for real refunds");
}

let reserve = null;
if (!dryRun && process.env.WARRANTY_RESERVE_PRIVATE_KEY) {
  const key = normalizeKey(process.env.WARRANTY_RESERVE_PRIVATE_KEY);
  const account = privateKeyToAccount(key);
  const client = createPublicClient({ chain: base, transport: http(optionalEnv("BASE_RPC_URL", "https://mainnet.base.org")) });
  const token = getAddress(optionalEnv("BASE_USDC", BASE_USDC));
  const balance = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  reserve = {
    address: account.address,
    token,
    balance: balance.toString(),
    balanceFormatted: formatUnits(balance, 6),
  };
}

const missing = checks.filter((check) => check.required && !check.present);
const report = {
  ok: missing.length === 0,
  mode: dryRun ? "dry-run refund" : "real refund",
  checks,
  missing: missing.map((check) => check.name),
  reserve,
  next:
    missing.length === 0
      ? "Run npm run provider in one terminal, then npm run buyer in another."
      : "Fill the missing dashboard values before running the live spike.",
};

console.log(stringify(report));
if (!report.ok) process.exit(1);

function checkEnv(name, required, note) {
  const value = process.env[name]?.trim() ?? "";
  checks.push({
    name,
    required,
    present: Boolean(value) && !value.includes("REPLACE_ME"),
    note,
  });
}

function normalizeKey(value) {
  if (!value) return null;
  return value.startsWith("0x") ? value : `0x${value}`;
}
