# Warranty Operations

Warranty must be online during judging because CROO orders are accepted through the provider worker.
The worker is intentionally small: it listens for paid incoming orders, places the target CAP order,
checks delivery, and returns either a fulfillment or refund receipt.

## Provider Runtime

Local judging runtime is installed with macOS `launchd` as:

```text
~/Library/LaunchAgents/com.dolepee.warranty-provider.plist
```

The plist does not contain secrets. It starts the worker from this repo, and `src/config.mjs`
loads the local `.env` file at runtime.

Runtime command:

```bash
WARRANTY_WAIT_MS=86400000 node src/warranty-worker.mjs
```

The job uses `KeepAlive`, so it restarts after CROO API timeouts or after a one-order worker exit.

Logs are local-only:

```text
logs/warranty-provider.log
logs/warranty-provider.err.log
```

## Check Runtime State

```bash
launchctl print gui/$(id -u)/com.dolepee.warranty-provider
tail -n 40 logs/warranty-provider.log
tail -n 40 logs/warranty-provider.err.log
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
