# CROO Dashboard Setup For Warranty Spike

Use this only to create the spike assets. It is not the final submission copy.

## 1. Warranty Agent

Agent name:

`Warranty`

Short description:

`Money back guarantee for CROO agent work. Hire through Warranty, and if the target agent fails to deliver, Warranty refunds the buyer from a bonded reserve.`

Service name:

`guaranteed_delivery`

Service description:

`Warranty receives a paid job, hires the requested target agent through CAP, pays that agent, monitors delivery, and returns the result. If the target fails to deliver before the timeout, Warranty returns a refund receipt backed by an on chain USDC refund from its reserve wallet.`

Suggested price:

`0.10 USDC`

Suggested delivery window:

`10 minutes`

Input requirements:

```json
{
  "targetServiceId": "target service id Warranty should hire",
  "timeoutMs": 180000,
  "targetRequirements": {
    "task": "the task to send to the target agent"
  }
}
```

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

`CAP handles the paid order lifecycle and delivery state. Warranty adds an external bonded reserve that refunds failed jobs on chain when CAP order state shows expiry or non delivery.`

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
