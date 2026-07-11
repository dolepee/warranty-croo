# Warranty Operations

Warranty must be online during judging because CROO orders are accepted through the provider worker.
The worker accepts negotiations through WebSocket plus polling fallback, places the target CAP order,
checks delivery through CROO finality, and returns either a fulfillment or refund receipt.

## Provider Runtime

Local judging runtime is installed with macOS `launchd` as:

```text
~/Library/LaunchAgents/com.dolepee.warranty-provider.plist
~/Library/LaunchAgents/com.dolepee.warranty-watchdog.plist
```

These plists do not contain secrets. The provider starts the worker from this repo, and `src/config.mjs`
loads the local `.env` file at runtime.

Runtime command:

```bash
WARRANTY_WAIT_MS=86400000 caffeinate -i node src/warranty-worker.mjs
```

The provider uses `KeepAlive`. The watchdog runs every 60 seconds and replaces the provider if its
15-second heartbeat becomes stale. CROO SDK calls also have bounded read/write deadlines, and startup
must pass the live provider/requester role compatibility probe before intake opens.

Logs are local-only:

```text
logs/warranty-provider.log
logs/warranty-provider.err.log
logs/warranty-watchdog.log
logs/warranty-watchdog.err.log
.warranty-state/health.json
```

## Check Runtime State

```bash
launchctl print gui/$(id -u)/com.dolepee.warranty-provider
launchctl print gui/$(id -u)/com.dolepee.warranty-watchdog
tail -n 40 logs/warranty-provider.log
tail -n 40 logs/warranty-provider.err.log
npm run preflight
npm run health:check
```

## Reserve Discipline

The public site displays the refund reserve wallet and attempts a direct browser-side Base USDC
`balanceOf` read. A snapshot is also stored in `site/proofs.json` and `data/coverage-ledger.json`.

Reserve wallet:

```text
0x7d287D5f5C40073aEF8bB92A485fC82e446EE7b9
```

Before demo or submission review, fund this reserve visibly enough that the refund promise does not
look empty on BaseScan.
