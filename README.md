# Warranty Spike

Warranty is a money back guarantee for CROO agent work.

This repo is the 24 hour gate for a CROO submission. It tests whether Warranty can receive a paid CAP order, forward a paid CAP order to another agent, read delivery or missed-deadline state, and refund the buyer from a reserve wallet when the target agent does not deliver before the buyer's timeout.

Open the status page locally:

```bash
open site/index.html
```

## Pass Condition

1. A buyer pays Warranty through CAP.
2. Warranty pays one real external target agent through CAP.
3. Warranty reads target delivery or expiry through CAP.
4. On target non-delivery before the timeout, Warranty sends an on chain USDC refund from its reserve wallet to the buyer wallet.

## Current Spike Result

The happy path is live: buyer pays Warranty, Warranty pays a target CROO agent, target delivers, Warranty delivers back, and the order clears.

The refund branch is also live: Warranty ran a short-timeout target order with `WARRANTY_REFUND_DRY_RUN=0`, delivered a refund receipt to the buyer, and sent the real reserve refund on Base in the same worker run.

```text
incoming order: 60c53263-c2af-4e30-ad54-28dad0f64635
target order: 83b9082c-4fd0-40e9-b90a-7fc2726db601
buyer paid Warranty: 0x42c32450fd42d581f81f04acfb2048277bd33c13e85abd1a8cef97a480e145e1
Warranty paid target: 0xb07b4c5d0c5486e946e0fc6aafcb966a9fc51fe0c5eae5881bd15e6719378c2a
Warranty delivered refund receipt: 0x08114c76624eb3db66f71e1e5e995a000a13a8a0107f170ecdd191892a762d72
real reserve refund: 0x4ddfe99dec8b0c96f6bd0cb752ebf378afa4551185b84403ef3e1e1d83ada744
BaseScan: https://basescan.org/tx/0x4ddfe99dec8b0c96f6bd0cb752ebf378afa4551185b84403ef3e1e1d83ada744
```

## Required Accounts

Create these in the CROO dashboard:

1. Warranty agent with SDK key and service listing.
2. Buyer agent with SDK key and funded AA wallet.
3. A target agent service for the happy path.
4. Optional failing stub agent with SDK key and service listing.

## Environment

```bash
export CROO_API_URL=https://api.croo.network
export CROO_WS_URL=wss://api.croo.network/ws
export BASE_RPC_URL=https://mainnet.base.org
export BASE_USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

export WARRANTY_SDK_KEY=croo_sk_...
export WARRANTY_SERVICE_ID=...
export BUYER_SDK_KEY=croo_sk_...
export WARRANTY_TARGET_SERVICE_ID=...

export WARRANTY_RESERVE_PRIVATE_KEY=0x...
export WARRANTY_REFUND_DRY_RUN=1
```

Set `WARRANTY_REFUND_DRY_RUN=0` only when the refund reserve is intentionally funded and you are ready to send a real USDC refund.

## Commands

```bash
npm install
npm run check
npm run public:check
npm run inspect
npm run preflight
```

Start the Warranty worker:

```bash
npm run provider
```

In another terminal, create a buyer order:

```bash
WARRANTY_TARGET_SERVICE_ID=$WARRANTY_TARGET_SERVICE_ID npm run buyer
```

For the failure path, list a stub agent service and run:

```bash
STUB_SDK_KEY=croo_sk_... npm run stub
```

Then point the buyer request at the stub service and use a short timeout:

```bash
WARRANTY_TARGET_SERVICE_ID=$STUB_SERVICE_ID WARRANTY_TARGET_TIMEOUT_SECONDS=45 npm run buyer
```

## Honest Claim

CAP handles the paid order lifecycle and delivery state. Warranty adds an external bonded reserve that refunds failed jobs on chain when CAP order state shows expiry or non delivery.

## Funding Notes

The buyer agent AA wallet must have enough USDC to pay the Warranty service.

The Warranty agent AA wallet must have enough USDC to pay the target agent it hires.

The reserve EOA must have enough USDC only when `WARRANTY_REFUND_DRY_RUN=0`.
