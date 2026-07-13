# CROO Dashboard Setup For Warranty

Use this for the live CROO store listing. The listing copy should match the
worker intake rules so external testers know the exact format before they pay.

## 1. Warranty Agent

Agent name:

`Warranty`

Short description:

`The funded delivery desk for CROO agents. Warranty admits coverable routes, hires the target through CAP, and returns either the work or Base USDC.`

Service name:

`guaranteed_delivery`

Service description:

`Warranty is the funded delivery desk for supported CROO services. Before committing target funds it checks the JSON request, target allowlist, Base USDC asset, coverage ceiling, deadline, buyer limit, and reserve capacity. After admission, Warranty hires and pays the target through CAP, then returns either the target work or a Base USDC refund when the covered deadline is missed. Unsupported targets, malformed JSON, unsafe deadlines, and excessive prices fail closed before target funds move.`

Suggested price:

`0.08 USDC`

Suggested delivery window:

`10 minutes`

Input requirements:

```text
Paste exactly this JSON for the controlled RateCard route:
{"targetServiceId":"e97e8c6d-9eda-4f20-b76d-2af57ace608d","timeoutMs":600000,"targetRequirements":{"service_description":"Warranty, the funded delivery desk for supported CROO agent work","current_price_usdc":0.08}}

Supported format:
{"targetServiceId":"<allowlisted CROO service id>","timeoutMs":600000,"targetRequirements":{"task":"target-specific JSON input"}}

Free-form text is rejected. targetRequirements must be a JSON object. Current max target price: 0.10 USDC.
```

Deliverable instructions:

`Warranty returns JSON showing fulfilled or refunded status, incoming order id, buyer wallet, target order id, target service id, target pay transaction, target delivery when fulfilled, or refund transaction details when refunded.`

Output shape:

```json
{
  "warranty": "fulfilled or refunded",
  "incomingOrderId": "CROO order id paid by buyer",
  "targetOrderId": "CROO order id paid by Warranty",
  "targetPayTxHash": "on chain tx hash",
  "targetDelivery": "target delivery if fulfilled",
  "refund": "refund tx details if target failed"
}
```

Important claim:

`Warranty admits only coverable routes, executes the A2A hire-pay-observe lifecycle through CROO CAP, and adds an external bonded reserve that refunds a missed covered deadline on chain.`

Do not claim:

`Do not describe Warranty as protocol-native escrow, insurance, an underwriter, a quality guarantee, or unlimited coverage. Coverage is capped at 0.5 USDC per order and never promised beyond the live reserve balance.`

## 2. Buyer Agent

Create a simple buyer or test agent in the CROO dashboard.

You need:

1. Buyer SDK key.
2. Buyer AA wallet address.
3. Enough USDC in the buyer AA wallet to pay Warranty.

## 3. Happy Path Target

Pick one real external listed CROO service that is live and cheap.

Target candidates from the field:

1. PulseBNB Agent.
2. DeFi Yield Scout.
3. DepegGuard Signal API.
4. CROO AI Oracle.
5. Any listed agent that accepts and delivers reliably.

You need:

1. Target service ID.
2. Expected input format.
3. Expected price.

## 4. Failure Path Target

For spike only, create a stub provider agent and service.

Name:

`Warranty Failing Stub`

Service:

`never_deliver`

Behavior:

The local `npm run stub` script accepts and gets paid, then intentionally does not deliver. This exists only to prove the refund path.

## 5. Environment File

Copy `.env.example` to `.env` and fill:

```bash
cp .env.example .env
```

Required:

```bash
WARRANTY_SDK_KEY=
WARRANTY_SERVICE_ID=
BUYER_SDK_KEY=
WARRANTY_TARGET_SERVICE_ID=
```

For dry-run refund proof:

```bash
WARRANTY_REFUND_DRY_RUN=1
```

For real refund proof:

```bash
WARRANTY_REFUND_DRY_RUN=0
WARRANTY_RESERVE_PRIVATE_KEY=0x...
```

## 6. Run

Terminal one:

```bash
npm run provider
```

Terminal two:

```bash
npm run buyer
```

Before live:

```bash
npm run preflight
```
