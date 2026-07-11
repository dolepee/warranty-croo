import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class RuntimeHealth {
  constructor(root = process.env.WARRANTY_STATE_DIR || path.resolve(".warranty-state")) {
    this.root = root;
    this.path = path.join(root, "health.json");
    this.startedAt = new Date().toISOString();
    this.snapshot = {};
    this.timer = null;
    this.queue = Promise.resolve();
  }

  async start(initial = {}) {
    await this.update({ status: "starting", ...initial });
    this.timer = setInterval(() => {
      this.update().catch(() => {});
    }, 15_000);
    this.timer.unref?.();
  }

  async update(patch = {}) {
    this.snapshot = {
      schemaVersion: 1,
      pid: process.pid,
      startedAt: this.startedAt,
      ...this.snapshot,
      ...patch,
      heartbeatAt: new Date().toISOString(),
    };
    const payload = `${JSON.stringify(this.snapshot, null, 2)}\n`;
    this.queue = this.queue.catch(() => {}).then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, payload, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    return this.queue;
  }

  async stop(patch = {}) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.update({ status: "stopping", ...patch });
    await this.queue;
  }
}

export async function readRuntimeHealth(root = process.env.WARRANTY_STATE_DIR || path.resolve(".warranty-state")) {
  return JSON.parse(await readFile(path.join(root, "health.json"), "utf8"));
}

export function evaluateRuntimeHealth(snapshot, options = {}) {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 90_000;
  const heartbeatAt = Date.parse(snapshot?.heartbeatAt || "");
  if (!snapshot || !Number.isInteger(snapshot.pid)) return { ok: false, reason: "health snapshot has no worker pid" };
  if (!Number.isFinite(heartbeatAt)) return { ok: false, reason: "health snapshot has no valid heartbeat" };
  if (now - heartbeatAt > maxAgeMs) return { ok: false, reason: `worker heartbeat is ${now - heartbeatAt}ms old` };
  const isPidAlive = options.isPidAlive || processIsRunning;
  if (!isPidAlive(snapshot.pid)) return { ok: false, reason: `worker pid ${snapshot.pid} is not running` };
  return { ok: true, ageMs: now - heartbeatAt, pid: snapshot.pid, status: snapshot.status || "unknown" };
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
