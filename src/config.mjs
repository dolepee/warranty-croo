import { AgentClient } from "@croo-network/sdk";
import { existsSync, readFileSync } from "node:fs";

loadDotEnv(".env.local");
loadDotEnv(".env");

export const BASE_USDC = clean(process.env.BASE_USDC) || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function crooConfig() {
  return {
    baseURL: clean(process.env.CROO_API_URL) || "https://api.croo.network",
    wsURL: clean(process.env.CROO_WS_URL) || "wss://api.croo.network/ws",
    rpcURL: clean(process.env.BASE_RPC_URL) || "https://mainnet.base.org",
    logger: quietLogger(),
  };
}

export function warrantyClient() {
  return clientFromKey(requiredEnv("WARRANTY_SDK_KEY", "Warranty agent SDK key from the CROO dashboard"));
}

export function buyerClient() {
  return clientFromKey(requiredEnv("BUYER_SDK_KEY", "Buyer agent SDK key from the CROO dashboard"));
}

export function stubClient() {
  return clientFromKey(requiredEnv("STUB_SDK_KEY", "Failing stub agent SDK key from the CROO dashboard"));
}

export function clientFromKey(sdkKey) {
  return new AgentClient(crooConfig(), sdkKey);
}

export function requiredEnv(name, purpose) {
  const value = clean(process.env[name]);
  if (!value) throw new Error(`Missing ${name}. ${purpose}.`);
  return value;
}

export function optionalEnv(name, fallback = "") {
  return clean(process.env[name]) || fallback;
}

export function parseRequirements(raw) {
  if (!raw) return {};
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { input: raw };
  }
}

export function stringify(value) {
  return JSON.stringify(
    value,
    (_, next) => (typeof next === "bigint" ? next.toString() : next),
    2,
  );
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clean(value) {
  return value?.replace(/\\n/g, "").trim() || undefined;
}

function quietLogger() {
  if (clean(process.env.CROO_VERBOSE) === "1") return console;
  return {
    info() {},
    warn(message, ...args) {
      console.warn(message, ...args);
    },
    error(message, ...args) {
      console.error(message, ...args);
    },
    debug() {},
  };
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    value = value.replace(/^"|"$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
