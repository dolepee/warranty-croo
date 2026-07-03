# Warranty Spike Status

Created: 2026-06-30

## Current Status

The Mac spike harness is at:

`/Users/qdee/Projects/warranty-spike-run`

Local checks passed:

1. `npm run check`
2. `npm run preflight`

Live CROO setup is resolved:

1. Warranty agent is live.
2. Warranty service ID is `ab65f96b-7f94-4299-8646-7f8f7b96c432`.
3. Target service is Summarizer, service ID `6a8c55f5-9400-414e-86ed-9a33bb3d09ca`.
4. Buyer agent key is configured locally.
5. Warranty reserve wallet is configured locally.

## Live Proofs

### Happy Path

Buyer paid Warranty, Warranty paid the target agent, target delivered, Warranty delivered back to the buyer, and the order cleared.

1. Incoming Warranty order: `50ee14dd-c361-409a-b1b5-751eec0e1de2`
2. Buyer paid Warranty tx: `0x00048bc8127fb4f4886c6b448379bd94cf27006ebe725a37860cc1c5d4d71964`
3. Target order: `4b2f40f0-817e-4004-ace8-882740b4dad2`
4. Warranty paid target tx: `0x7e007fe5f4537e3445be3966c4a60ff4497924d0e5a42aefd3f85a92015e51ab`
5. Warranty delivered receipt tx: `0x6ec886a9bc2722c9b913b8aaac0baf561c0cdf0b7a8a8faaacb9e9bf9f105bdc`
6. Clear tx: `0xa7ff309aa3bbc835b73189ce955228e6a750ef951562d2b0909db951b35739c9`
7. Final status: completed.

### Refund Branch

Warranty ran the short-timeout branch against a target order with real refunds enabled from the start, produced the refund-path delivery, then sent a real reserve refund on Base.

1. Incoming Warranty order: `60c53263-c2af-4e30-ad54-28dad0f64635`
2. Buyer paid Warranty tx: `0x42c32450fd42d581f81f04acfb2048277bd33c13e85abd1a8cef97a480e145e1`
3. Target order: `83b9082c-4fd0-40e9-b90a-7fc2726db601`
4. Warranty paid target tx: `0xb07b4c5d0c5486e946e0fc6aafcb966a9fc51fe0c5eae5881bd15e6719378c2a`
5. Warranty delivered refund-branch receipt tx: `0x08114c76624eb3db66f71e1e5e995a000a13a8a0107f170ecdd191892a762d72`
6. Real reserve refund tx: `0x4ddfe99dec8b0c96f6bd0cb752ebf378afa4551185b84403ef3e1e1d83ada744`
7. BaseScan: `https://basescan.org/tx/0x4ddfe99dec8b0c96f6bd0cb752ebf378afa4551185b84403ef3e1e1d83ada744`
8. Final status: completed.

The CROO SDK surface confirms the required methods exist:

1. `negotiateOrder`
2. `acceptNegotiation`
3. `payOrder`
4. `deliverOrder`
5. `getOrder`
6. `getDelivery`
7. `listOrders`
8. `connectWebSocket`

The SDK also exposes the lifecycle signals Warranty needs:

1. `order_paid`
2. `order_completed`
3. `order_expired`

## Current Wallets

Warranty agent wallet:

`0x29b4EE3D78d641e3936e52F400227b3e8e4a8ABE`

Buyer agent wallet:

`0x5F3d43A2703740871F4345Bb2e4181103979aa1C`

Warranty reserve wallet:

`0x7d287D5f5C40073aEF8bB92A485fC82e446EE7b9`

Final checked balances after the clean refund run:

1. Reserve: `0.006786 USDC`
2. Buyer: `0.196684 USDC`
3. Warranty: `0.303004 USDC`

## What Is Still Needed

For a submission build, convert the spike harness into a small public repo and hosted status page. Do not add more payment mechanics until the proof surface is clean.

## Run Order

Install dependencies:

```bash
npm install
```

Create `.env` from the example:

```bash
cp .env.example .env
```

Paste the dashboard keys and service IDs into `.env`.

Check local scripts:

```bash
npm run check
npm run inspect
npm run preflight
```

Start Warranty:

```bash
WARRANTY_SDK_KEY=croo_sk_... npm run provider
```

In another terminal, run a buyer job:

```bash
BUYER_SDK_KEY=croo_sk_... \
WARRANTY_SERVICE_ID=... \
WARRANTY_TARGET_SERVICE_ID=... \
npm run buyer
```

For the refund path, keep refunds dry until ready:

```bash
WARRANTY_REFUND_DRY_RUN=1
```

Only send real refunds when the reserve is funded:

```bash
WARRANTY_REFUND_DRY_RUN=0
WARRANTY_RESERVE_PRIVATE_KEY=0x...
```

## Gate

Build Warranty only if the live spike proves:

1. Buyer pays Warranty through CAP.
2. Warranty pays an external target through CAP.
3. Warranty reads delivery or expiry from CAP.
4. Warranty sends an on chain USDC refund when the target does not deliver before the timeout.

Current verdict: PASS. The happy path and refund path are both proven with live CROO orders and a real Base USDC reserve refund.
