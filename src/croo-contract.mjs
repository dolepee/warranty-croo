export const CROO_ORDER_ROLE = Object.freeze({
  requester: "buyer",
  provider: "provider",
});

export const CROO_NEGOTIATION_ROLE = Object.freeze({
  requester: "requester",
  provider: "provider",
});

export async function probeCrooContract(client) {
  const checks = [
    ["orders.provider", () => client.listOrders({ role: CROO_ORDER_ROLE.provider, page: 1, pageSize: 1 })],
    ["orders.requester", () => client.listOrders({ role: CROO_ORDER_ROLE.requester, page: 1, pageSize: 1 })],
    ["negotiations.provider", () => client.listNegotiations({ role: CROO_NEGOTIATION_ROLE.provider, page: 1, pageSize: 1 })],
    ["negotiations.requester", () => client.listNegotiations({ role: CROO_NEGOTIATION_ROLE.requester, page: 1, pageSize: 1 })],
  ];
  const results = [];
  for (const [name, run] of checks) {
    try {
      const rows = await run();
      results.push({ name, ok: true, count: Array.isArray(rows) ? rows.length : null });
    } catch (error) {
      results.push({ name, ok: false, error: error.message });
    }
  }
  return { ok: results.every((result) => result.ok), checks: results };
}

export async function assertCrooContract(client) {
  const report = await probeCrooContract(client);
  if (!report.ok) {
    const failures = report.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.error}`);
    throw new Error(`CROO compatibility probe failed: ${failures.join("; ")}`);
  }
  return report;
}
