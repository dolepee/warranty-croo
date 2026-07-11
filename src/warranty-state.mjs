import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const TERMINAL_STAGES = new Set(["FULFILLED", "REFUNDED", "REJECTED"]);

export class WarrantyStateStore {
  constructor(root = process.env.WARRANTY_STATE_DIR || path.resolve(".warranty-state")) {
    this.root = root;
    this.ordersDir = path.join(root, "orders");
    this.lockPath = path.join(root, "worker.lock");
    this.lockHandle = null;
  }

  async init() {
    await mkdir(this.ordersDir, { recursive: true, mode: 0o700 });
  }

  async acquireLock() {
    await this.init();
    try {
      this.lockHandle = await open(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST" || !(await this.#clearStaleLock())) throw error;
      this.lockHandle = await open(this.lockPath, "wx", 0o600);
    }
    await this.lockHandle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  }

  async releaseLock() {
    await this.lockHandle?.close();
    this.lockHandle = null;
    await rm(this.lockPath, { force: true });
  }

  async load(orderId) {
    try {
      return JSON.parse(await readFile(this.#orderPath(orderId), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(record) {
    if (!record?.incomingOrderId) throw new Error("journal record requires incomingOrderId");
    await this.init();
    const next = {
      schemaVersion: 1,
      createdAt: record.createdAt || new Date().toISOString(),
      ...record,
      updatedAt: new Date().toISOString(),
    };
    const target = this.#orderPath(next.incomingOrderId);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
    return next;
  }

  async update(orderId, patch) {
    const current = await this.load(orderId);
    if (!current) throw new Error(`missing journal for incoming order ${orderId}`);
    return this.save({ ...current, ...patch, incomingOrderId: orderId });
  }

  async list() {
    await this.init();
    const names = await readdir(this.ordersDir);
    const records = [];
    for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
      records.push(JSON.parse(await readFile(path.join(this.ordersDir, name), "utf8")));
    }
    return records;
  }

  async listActive() {
    return (await this.list()).filter((record) => !isTerminalStage(record.stage));
  }

  async activeLiabilityAtomic(excludeOrderId = null) {
    const active = await this.listActive();
    return active.reduce((total, record) => {
      if (record.incomingOrderId === excludeOrderId) return total;
      return total + BigInt(record.coverageAmountAtomic || "0");
    }, 0n);
  }

  async recentBuyerOrderCount(buyerWallet, windowMs, excludeOrderId = null, now = Date.now()) {
    const normalized = String(buyerWallet || "").toLowerCase();
    if (!normalized) return 0;
    const cutoff = now - windowMs;
    return (await this.list()).filter((record) => {
      if (record.incomingOrderId === excludeOrderId) return false;
      if (String(record.buyerWallet || "").toLowerCase() !== normalized) return false;
      const createdAt = Date.parse(record.createdAt || "");
      return Number.isFinite(createdAt) && createdAt >= cutoff;
    }).length;
  }

  #orderPath(orderId) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(orderId))) throw new Error(`unsafe order id: ${orderId}`);
    return path.join(this.ordersDir, `${orderId}.json`);
  }

  async #clearStaleLock() {
    try {
      const lock = JSON.parse(await readFile(this.lockPath, "utf8"));
      if (Number.isInteger(lock.pid) && processIsRunning(lock.pid)) return false;
      await rm(this.lockPath, { force: true });
      return true;
    } catch {
      const info = await stat(this.lockPath);
      if (Date.now() - info.mtimeMs < 120_000) return false;
      await rm(this.lockPath, { force: true });
      return true;
    }
  }
}

export function isTerminalStage(stage) {
  return TERMINAL_STAGES.has(String(stage || ""));
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
