const PROOF_URL = "./proofs.json";
const BASESCAN_TX = "https://basescan.org/tx/";
const BASESCAN_ADDRESS = "https://basescan.org/address/";
const BASE_RPC = "https://mainnet.base.org";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const ledgerState = {
  rows: [],
  filter: "all",
};

initializeCopyButtons();
initializeLedgerFilters();
loadProofs();

async function loadProofs() {
  try {
    const response = await fetch(PROOF_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`proof request failed with ${response.status}`);
    const proofs = await response.json();
    const summary = proofs.coverage?.summary || {};
    ledgerState.rows = Array.isArray(proofs.coverage?.rows) ? proofs.coverage.rows : [];
    updateMetrics(summary);
    renderLedger();
    renderCoveredServices();
    await updateReserve(proofs.coverage?.reserveStatus);
  } catch (error) {
    showDataError("coverage-ledger-body", 5, "Verified receipts are temporarily unavailable. Open proof JSON instead.");
    showDataError("covered-services-body", 4, "Covered services are temporarily unavailable. Open the full ledger instead.");
    console.warn(error);
  }
}

function updateMetrics(summary) {
  document.querySelectorAll("[data-proof-metric]").forEach((element) => {
    const value = summary[element.dataset.proofMetric];
    if (value !== undefined) element.textContent = String(value);
  });
}

function initializeLedgerFilters() {
  document.querySelectorAll("[data-ledger-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      ledgerState.filter = button.dataset.ledgerFilter || "all";
      document.querySelectorAll("[data-ledger-filter]").forEach((candidate) => {
        candidate.setAttribute("aria-pressed", String(candidate === button));
      });
      renderLedger();
    });
  });
}

function renderLedger() {
  const body = document.getElementById("coverage-ledger-body");
  if (!body) return;

  const rows = [...ledgerState.rows]
    .reverse()
    .filter((row) => matchesFilter(row.outcome, ledgerState.filter));

  body.replaceChildren();
  if (!rows.length) {
    appendMessageRow(body, 5, "No receipt rows match this filter.");
    return;
  }

  const fragment = document.createDocumentFragment();
  rows.forEach((row) => fragment.append(createLedgerRow(row)));
  body.append(fragment);
}

function createLedgerRow(row) {
  const tr = document.createElement("tr");

  const route = createCell("Route");
  const routeTitle = document.createElement("strong");
  routeTitle.textContent = row.label || "Covered route";
  const scope = document.createElement("span");
  scope.className = "scope-label";
  scope.textContent = isExternal(row) ? "External buyer" : "Internal proof";
  route.append(routeTitle, scope);

  const buyer = createCell("Buyer");
  const buyerLink = document.createElement("a");
  buyerLink.className = "mono-link";
  buyerLink.href = `${BASESCAN_ADDRESS}${row.buyerWallet}`;
  buyerLink.rel = "noreferrer";
  buyerLink.textContent = shortValue(row.buyerWallet);
  buyerLink.setAttribute("aria-label", `View buyer wallet ${row.buyerWallet} on Basescan`);
  buyer.append(buyerLink);

  const target = createCell("Target");
  const targetName = document.createElement("strong");
  targetName.textContent = row.targetAgent || "Supported service";
  const targetId = document.createElement("code");
  targetId.textContent = shortValue(row.targetServiceId);
  target.append(targetName, targetId);

  const outcome = createCell("Outcome");
  const outcomeBadge = document.createElement("span");
  outcomeBadge.className = `ledger-outcome ${outcomeClass(row.outcome)}`;
  outcomeBadge.textContent = outcomeLabel(row.outcome);
  outcome.append(outcomeBadge);

  const transactions = createCell("Transactions");
  transactions.classList.add("transaction-links");
  const links = transactionSet(row);
  links.forEach(({ label, hash }) => transactions.append(createTransactionLink(label, hash)));

  tr.append(route, buyer, target, outcome, transactions);
  return tr;
}

function renderCoveredServices() {
  const body = document.getElementById("covered-services-body");
  if (!body) return;

  const services = new Map();
  ledgerState.rows.forEach((row) => {
    const id = row.targetServiceId;
    if (!id) return;
    const current = services.get(id) || {
      id,
      name: row.targetAgent || "Supported service",
      rows: [],
      outcomes: new Set(),
    };
    current.rows.push(row);
    current.outcomes.add(outcomeLabel(row.outcome));
    current.latest = row;
    services.set(id, current);
  });

  body.replaceChildren();
  const fragment = document.createDocumentFragment();
  [...services.values()]
    .sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name))
    .forEach((service) => {
      const tr = document.createElement("tr");

      const name = createCell("Service");
      const strong = document.createElement("strong");
      strong.textContent = service.name;
      const code = document.createElement("code");
      code.textContent = shortValue(service.id);
      name.append(strong, code);

      const count = createCell("Covered routes");
      count.textContent = String(service.rows.length);

      const outcomes = createCell("Recorded outcomes");
      outcomes.textContent = [...service.outcomes].join(" / ");

      const proof = createCell("Latest proof");
      const finalTx = finalTransaction(service.latest);
      if (finalTx) proof.append(createTransactionLink("Open receipt", finalTx));
      else proof.textContent = "Recorded in proof JSON";

      tr.append(name, count, outcomes, proof);
      fragment.append(tr);
    });
  body.append(fragment);
}

async function updateReserve(snapshot) {
  const balances = document.querySelectorAll("[data-reserve-balance]");
  const sources = document.querySelectorAll("[data-reserve-source]");
  if (!balances.length) return;

  if (snapshot?.balanceUSDC) {
    balances.forEach((element) => {
      element.textContent = `${snapshot.balanceUSDC} USDC`;
    });
    sources.forEach((element) => {
      element.textContent = "proof snapshot";
    });
  }

  try {
    const atomic = await readReserveBalance(snapshot?.wallet);
    balances.forEach((element) => {
      element.textContent = `${formatUsdc(atomic)} USDC`;
    });
    sources.forEach((element) => {
      element.textContent = "live Base balance";
    });
  } catch (error) {
    console.warn(error);
  }
}

async function readReserveBalance(wallet) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet || "")) throw new Error("invalid reserve wallet");
  const selector = "0x70a08231";
  const encodedWallet = wallet.toLowerCase().replace("0x", "").padStart(64, "0");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(BASE_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: BASE_USDC, data: `${selector}${encodedWallet}` }, "latest"],
      }),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!payload.result) throw new Error("Base RPC returned no reserve balance");
    return BigInt(payload.result);
  } finally {
    clearTimeout(timer);
  }
}

function initializeCopyButtons() {
  document.querySelectorAll("[data-copy-target]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = document.getElementById(button.dataset.copyTarget || "");
      const status = button.closest(".request-tool")?.querySelector("[data-copy-status]");
      if (!target) return;
      try {
        await copyText(target.textContent || "");
        button.textContent = "Copied";
        if (status) status.textContent = "Copied to clipboard.";
        setTimeout(() => {
          button.textContent = button.dataset.copyTarget === "badge-copy" ? "Copy text" : "Copy payload";
          if (status) status.textContent = "";
        }, 1800);
      } catch {
        if (status) status.textContent = "Copy failed. Select the text manually.";
      }
    });
  });
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy command failed");
}

function transactionSet(row) {
  const transactions = [
    { label: "Buyer", hash: row.buyerPaidWarrantyTx },
    { label: "Target", hash: row.warrantyPaidTargetTx },
    { label: outcomeLinkLabel(row.outcome), hash: finalTransaction(row) },
  ];
  const seen = new Set();
  return transactions.filter(({ hash }) => {
    if (!hash || seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
}

function finalTransaction(row) {
  if (row.outcome === "refunded" || row.outcome === "native_refunded") {
    return row.refundTx || row.warrantyRejectTx || row.targetRejectTx;
  }
  return row.warrantyDeliveredTx || row.targetDeliveredTx || row.targetAttestationTx;
}

function createTransactionLink(label, hash) {
  const link = document.createElement("a");
  link.className = "tx-link";
  link.href = `${BASESCAN_TX}${hash}`;
  link.rel = "noreferrer";
  link.textContent = `${label} ${shortValue(hash)}`;
  link.setAttribute("aria-label", `${label} transaction ${hash} on Basescan`);
  return link;
}

function createCell(label) {
  const td = document.createElement("td");
  td.dataset.label = label;
  return td;
}

function showDataError(id, columns, message) {
  const body = document.getElementById(id);
  if (!body) return;
  body.replaceChildren();
  appendMessageRow(body, columns, message);
}

function appendMessageRow(body, columns, message) {
  const tr = document.createElement("tr");
  tr.className = "ledger-loading";
  const td = document.createElement("td");
  td.colSpan = columns;
  td.textContent = message;
  tr.append(td);
  body.append(tr);
}

function matchesFilter(outcome, filter) {
  if (filter === "all") return true;
  if (filter === "fulfilled") return outcome === "fulfilled";
  if (filter === "refunded") return outcome === "refunded" || outcome === "native_refunded";
  return true;
}

function isExternal(row) {
  return String(row.scope || "").toLowerCase().includes("external");
}

function outcomeClass(outcome) {
  if (outcome === "fulfilled") return "is-delivered";
  if (outcome === "native_refunded") return "is-native-refund";
  return "is-refunded";
}

function outcomeLabel(outcome) {
  if (outcome === "fulfilled") return "Delivered";
  if (outcome === "native_refunded") return "Native refund";
  return "Reserve refund";
}

function outcomeLinkLabel(outcome) {
  return outcome === "fulfilled" ? "Delivery" : "Refund";
}

function shortValue(value) {
  const text = String(value || "");
  if (text.length <= 16) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function formatUsdc(atomic) {
  const whole = atomic / 1_000_000n;
  const fraction = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
