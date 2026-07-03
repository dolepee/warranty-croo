# Warranty

Warranty is the money-back guarantee for CROO agent work. Hire any CROO agent through Warranty. If the target agent misses the buyer's deadline, Warranty refunds the buyer from a bonded Base USDC reserve, on chain.

CROO gives agents identity, payments, discovery, and liquidity. Agent commerce also needs assurance. Buyers need a way to pay agents without accepting unlimited delivery risk, and agents need a reusable path for buying work from other agents without writing custom failure handling every time.

Warranty receives a paid CROO order, hires the requested target agent through CAP, pays that target agent, watches the delivery state, and either returns the target result or refunds the buyer from reserve.

Live proof surface:

```text
https://warranty-croo.vercel.app
```

## Honest Scope

CAP handles the paid order lifecycle and delivery state. Warranty adds an external bonded reserve that refunds failed jobs on chain when CAP order state shows expiry or non-delivery.

Warranty is not protocol-native escrow and it is not an insurance product. The refund reserve is an ordinary Base USDC wallet controlled by Warranty for the current proof. The product claim is narrower: a paid intermediary agent can add a visible money-back guarantee to CROO agent work without changing CAP.

## How It Works

1. A buyer pays Warranty through CROO CAP for `guaranteed_delivery`.
2. The buyer specifies the target CROO service and task requirements.
3. Warranty places and pays a second CAP order to the target agent.
4. Warranty monitors delivery state through CAP order and delivery reads.
5. If the target delivers before timeout, Warranty forwards the result to the buyer.
6. If delivery is missing after timeout, Warranty delivers a refund receipt and sends Base USDC from its bonded reserve to the buyer.

## Live Proof

The current proof covers both branches: fulfilled delivery and missed-deadline refund.

### Fulfilled Delivery

Buyer paid Warranty, Warranty paid the target CROO agent, the target delivered, Warranty delivered back, and the order cleared.

| Step | Evidence |
| --- | --- |
| Incoming Warranty order | `50ee14dd-c361-409a-b1b5-751eec0e1de2` |
| Buyer paid Warranty | `0x00048bc8127fb4f4886c6b448379bd94cf27006ebe725a37860cc1c5d4d71964` |
| Target order | `4b2f40f0-817e-4004-ace8-882740b4dad2` |
| Warranty paid target | `0x7e007fe5f4537e3445be3966c4a60ff4497924d0e5a42aefd3f85a92015e51ab` |
| Warranty delivery receipt | `0x6ec886a9bc2722c9b913b8aaac0baf561c0cdf0b7a8a8faaacb9e9bf9f105bdc` |
| Clear tx | `0xa7ff309aa3bbc835b73189ce955228e6a750ef951562d2b0909db951b35739c9` |

### Missed-Deadline Refund

Warranty ran a short-timeout target order with real refunds enabled, delivered a refund receipt to the buyer, and sent the Base USDC refund from its reserve wallet.

| Step | Evidence |
| --- | --- |
| Incoming Warranty order | `60c53263-c2af-4e30-ad54-28dad0f64635` |
| Buyer paid Warranty | `0x42c32450fd42d581f81f04acfb2048277bd33c13e85abd1a8cef97a480e145e1` |
| Target order | `83b9082c-4fd0-40e9-b90a-7fc2726db601` |
| Warranty paid target | `0xb07b4c5d0c5486e946e0fc6aafcb966a9fc51fe0c5eae5881bd15e6719378c2a` |
| Warranty refund receipt | `0x08114c76624eb3db66f71e1e5e995a000a13a8a0107f170ecdd191892a762d72` |
| Real reserve refund | `0x4ddfe99dec8b0c96f6bd0cb752ebf378afa4551185b84403ef3e1e1d83ada744` |
| BaseScan | https://basescan.org/tx/0x4ddfe99dec8b0c96f6bd0cb752ebf378afa4551185b84403ef3e1e1d83ada744 |

## Public Wallets

| Role | Address |
| --- | --- |
| Warranty agent | `0x29b4EE3D78d641e3936e52F400227b3e8e4a8ABE` |
| Buyer agent | `0x5F3d43A2703740871F4345Bb2e4181103979aa1C` |
| Refund reserve | `0x7d287D5f5C40073aEF8bB92A485fC82e446EE7b9` |

Last checked after the clean refund run:

| Wallet | USDC balance |
| --- | --- |
| Reserve | `0.006786` |
| Buyer | `0.196684` |
| Warranty | `0.303004` |

## CROO SDK Methods Used

The worker uses the CROO SDK for the full paid-order lifecycle:

| Capability | SDK method or event |
| --- | --- |
| WebSocket order stream | `client.connectWebSocket()` |
| Accept buyer negotiation | `client.acceptNegotiation()` |
| Create target negotiation | `client.negotiateOrder()` |
| Pay target order | `client.payOrder()` |
| Read order state | `client.getOrder()` |
| Read delivery | `client.getDelivery()` |
| Deliver result or refund receipt | `client.deliverOrder()` |
| Inspect order history | `client.listOrders()` |
| Negotiation events | `EventType.NegotiationCreated` |
| Payment events | `EventType.OrderPaid` |
| Completion events | `EventType.OrderCompleted` |
| Expiry events | `EventType.OrderExpired` |

## Run Locally

Install dependencies and run static checks:

```bash
npm install
npm run check
npm run public:check
```

Useful inspection commands:

```bash
npm run inspect
npm run preflight
```

Start the Warranty worker:

```bash
npm run provider
```

Create a buyer order from another terminal:

```bash
WARRANTY_TARGET_SERVICE_ID=$WARRANTY_TARGET_SERVICE_ID npm run buyer
```

For a local timeout test, list a stub target service and run:

```bash
STUB_SDK_KEY=croo_sk_... npm run stub
```

Then point the buyer request at the stub service and use a short timeout:

```bash
WARRANTY_TARGET_SERVICE_ID=$STUB_SERVICE_ID WARRANTY_TARGET_TIMEOUT_SECONDS=45 npm run buyer
```

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

## Public Release Scope

The CROO submission requires a public repository, so this repo must be public before final submission.

What is proven now:

| Capability | Status |
| --- | --- |
| Warranty receives a paid CROO order | Live proof |
| Warranty pays a target CROO agent | Live proof |
| Warranty reads delivery state | Implemented |
| Warranty delivers back to buyer | Live proof |
| Warranty sends a real Base USDC refund | Live proof |
| More than three external counterparty agents | Not complete |
| More than five buyer wallets | Not complete |

## Roadmap

Near-term work before final submission:

1. Coverage ledger: track distinct buyer wallets and target agents from day one.
2. Backed by Warranty badge: let target agents show they can be hired through a refund-backed path.
3. Live coverage board: show fulfilled, refunded, pending, and reserve balance in one public view.
4. More target agents: run the same flow across at least three real CROO services.
5. Marketplace expansion: Warranty is marketplace-agnostic; OKX.AI listing is the next venue after the CROO proof.
