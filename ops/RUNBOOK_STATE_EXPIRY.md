# Runbook: escrow contract state expiry (Soroban rent)

Soroban ledger entries expire. When the LumenDrop contract's **instance** entry or its **code**
(wasm) entry passes its `liveUntilLedgerSeq`, the contract is archived: the escrowed USDC is not
destroyed, but every `claim`, `claim_share`, `reclaim` and `reclaim_pool` fails until someone pays
to restore the entries. Nothing in the product extends these two entries on its own: the contract's
`extend_ttl` calls only touch the per-drop entries, and on mainnet the network minimum
(`minPersistentTtl` = 2,073,600 ledgers) already exceeds the contract's bump, so it is a no-op there.

## What was found on 2026-09-06

| Network | Contract | Entry | liveUntilLedgerSeq at the check | State |
|---|---|---|---|---|
| testnet | `CAMCI5VPRLQUL6H4QKLZ6X7ASLVCEYBYWS7N3QG7JVOA25HCY2TN3HP3` | instance + code | 4,645,547 / 4,645,546 (about 6 days) | **extended the same day to 7,539,961 / 7,539,962** |
| mainnet | `CAC5JYQ2XEEVJ54EXC7KCG6MTARO5CSUQ2WNKSOM6FALCCU5UTEIWGR4` | instance | 65,729,667 | not extended; archives about 2026-11-28 (5s ledgers) to 2026-12-14 (6s) |
| mainnet | same | code `38941538b964af2110a6fd2fae4c1c3de2ff6585ef0da5d1a59de2ce29edec6a` | 65,729,642 | same window |
| testnet | the three legacy ids in `LUMENDROP_LEGACY_CONTRACTS` | instance + code | 0 | **already archived**; an exit through one auto-restores at the sponsor's cost (about 1.1 to 1.5 XLM each) |

Both mainnet values are exactly the deploy-time minimum: no extension has ever been submitted by
the owner or the sponsor.

## The watchdog now watches this

`apps/sponsor/src/lib/watchdog.ts` (`checkStateExpiry`) reads both entries every 15 minutes and
pages when the sooner of the two is fewer than `SPONSOR_MIN_TTL_DAYS` days away (default 21, set
explicitly in both `wrangler.toml` blocks). The page carries the two commands below. Deploy both
Workers for it to take effect: `npx wrangler deploy` (testnet) and `npx wrangler deploy --env mainnet`.

## The procedure: two commands, any funded key

No owner or sponsor key is needed. TTL extension is unauthenticated on Stellar; whoever submits
pays the rent. Use any funded account (a personal wallet is fine; do not drain the sponsor for it).

```bash
# 1. the instance (cents)
stellar contract extend --id <CONTRACT_ID> --ledgers-to-extend 3000000 \
  --durability persistent --source-account <FUNDED_SECRET_OR_IDENTITY> --network <testnet|mainnet>

# 2. the code (the expensive half)
stellar contract extend --wasm-hash <WASM_HASH> --ledgers-to-extend 3000000 \
  --durability persistent --source-account <FUNDED_SECRET_OR_IDENTITY> --network <testnet|mainnet>
```

`<WASM_HASH>` is `LUMENDROP_WASM_HASH` in the matching `wrangler.toml` block. 3,000,000 ledgers
is just under the network maximum (3,110,400) and buys about 174 days at 5s per ledger. Extending
sets `liveUntil = current ledger + N`; asking for fewer ledgers than the entry already has left
costs almost nothing and changes nothing.

For mainnet the CLI needs an RPC configured once:
`stellar network add mainnet --rpc-url https://mainnet.sorobanrpc.com --network-passphrase "Public Global Stellar Network ; September 2015"`.

### Measured cost

| Network | Instance | Code | How measured |
|---|---|---|---|
| testnet, 3,000,000 ledgers | 0.068 XLM | 28.98 XLM | paid on 2026-09-06, txs `0ebc57a4…` and `e619650b…` |
| mainnet, 3,000,000 ledgers | 0.044 XLM | 19.58 XLM | `simulateTransaction` of the extend op on 2026-09-06 (not paid) |

The code fee is proportional to the ledgers actually added, so extending mainnet earlier costs
roughly the same as extending it late; there is no saving in waiting.

### Verify afterwards

The CLI prints `New ttl ledger: N`. Independently:

```bash
curl -s -X POST https://mainnet.sorobanrpc.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLedgerEntries","params":{"keys":["<instance key XDR>"]}}'
```

or simply wait for the next watchdog run: its `info` line reports the days left, and the page
clears. The `ops/monitor` Blockaid-style monitors do not cover this; the Worker watchdog is the
only alarm.

## Restoring an archived contract (if this runbook was read too late)

`stellar contract restore --id <CONTRACT_ID> --durability persistent --source-account <FUNDED> --network mainnet`
and `stellar contract restore --wasm-hash <WASM_HASH> ...`, then extend as above. Exits also
self-restore on first use because the relayer simulates and assembles the footprint, but that
makes the sponsor pay the restore rent and is not a plan.
