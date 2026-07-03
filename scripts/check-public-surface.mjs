import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["README.md", "SPIKE_STATUS.md", "DASHBOARD_SETUP.md", "site"];
const forbidden = [
  /croo_sk_[a-z0-9]+/i,
  /0x[a-f0-9]{64}/i,
  /WARRANTY_RESERVE_PRIVATE_KEY=0x[a-f0-9]+/i,
];

const allowedPrivateKeyPlaceholder = "0xREPLACE_ME";
const files = [];

for (const root of roots) collect(root);

const findings = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const pattern of forbidden) {
    for (const match of text.matchAll(new RegExp(pattern, "gi"))) {
      if (match[0] === allowedPrivateKeyPlaceholder) continue;
      if (isTransactionHashContext(text, match.index ?? 0)) continue;
      findings.push(`${file}: possible secret or raw private key near "${match[0].slice(0, 18)}..."`);
    }
  }
}

if (findings.length) {
  console.error(findings.join("\n"));
  process.exit(1);
}

console.log(`PUBLIC_SURFACE_OK ${files.length} files checked`);

function collect(path) {
  const stats = statSync(path);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(path)) collect(join(path, entry));
    return;
  }
  if (/\.(html|css|svg|json|md|mjs|txt)$/.test(path)) files.push(path);
}

function isTransactionHashContext(text, index) {
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + 120);
  const context = text.slice(start, end).toLowerCase();
  return /tx|transaction|hash|basescan|buyer paid|target paid|refund|delivery|clear/.test(context);
}
