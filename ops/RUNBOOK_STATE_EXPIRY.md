# Runbook: escrow contract state expiry (Soroban rent)

Soroban ledger entries expire. When the LumenDrop contract's **instance** entry or its **code**
(wasm) entry passes its `liveUntilLedgerSeq`, the contract is archived: the escrowed USDC is not
destroyed, but every `claim`, `claim_share`, `reclaim` and `reclaim_pool` fails until someone pays
to restore the entries. Nothing in the product extends these two entries on its own: the contract's
`extend_ttl` calls only touch the per-drop entries, and on mainnet the network minimum
(`minPersistentTtl` = 2,073,600 ledgers) already exceeds the contract's bump, so it is a no-op there.

There is a **third entry with rent of its own**: the escrow's **USDC balance on the USDC Stellar
Asset Contract** (contract data on the SAC, key `["Balance", <escrow address>]`, persistent). It was
written by the first deposit into the escrow, it is bumped only when the SAC's own threshold is
crossed, and it expires on its own clock, months before the instance and the code (found
2026-11-08: 20.5 days left on mainnet while the instance and the code had four months). If it
archives, every claim, reclaim and exit that moves USDC out of the escrow fails until it is restored,
exactly as with the instance. The drop entries themselves were written later with the 120-day
minimum and outlive it.

## What was found on 2026-09-06

| Network | Contract | Entry | liveUntilLedgerSeq at the check | State |
|---|---|---|---|---|
| testnet | `CAMCI5VPRLQUL6H4QKLZ6X7ASLVCEYBYWS7N3QG7JVOA25HCY2TN3HP3` | instance + code | 4,645,547 / 4,645,546 (about 6 days) | **extended the same day to 7,539,961 / 7,539,962** |
| mainnet | `CAC5JYQ2XEEVJ54EXC7KCG6MTARO5CSUQ2WNKSOM6FALCCU5UTEIWGR4` | instance | 65,729,667 | **extended 2026-09-09 to 67,352,276** (tx `58960839…`, ~174 days at 5s, about 2027-03-02) |
| mainnet | same | code `38941538b964af2110a6fd2fae4c1c3de2ff6585ef0da5d1a59de2ce29edec6a` | 65,729,642 | **extended 2026-09-09 to 66,952,291** (tx `e10204e9…`, 2,600,000 ledgers, ~150 days at 5s, about 2027-02-06). The watchdog will page again around mid-January 2027; a short top-up then costs a few XLM |
| testnet | the three legacy ids in `LUMENDROP_LEGACY_CONTRACTS` | instance + code | 0 | **already archived**; an exit through one auto-restores at the sponsor's cost (about 1.1 to 1.5 XLM each) |

Both mainnet values are exactly the deploy-time minimum: no extension has ever been submitted by
the owner or the sponsor.

## What was found on 2026-11-08 (the USDC balance entries)

| Network | Entry | liveUntilLedgerSeq at the check | State |
|---|---|---|---|
| mainnet | USDC balance of `CAC5JYQ2...WGR4` on the SAC `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` (1.5 USDC) | 65,729,729 at ledger 65,375,602: 354,127 ledgers, **20.5 days, about 2026-11-29** | extended 2026-11-10 17:18Z from the sponsor hot key (tx 2f7d29319f90a91f32d02dd404b7ebcfdc5bdcf83bce830aa170504b512ac4cf, 0.056 XLM): live until ledger 68,409,016, about 2027-05-03. A first try from the utility key failed with TxInsufficientBalance: its USDC trustline raises its reserve to 1.5 XLM, leaving 0.015 XLM for fees |
| testnet | USDC balance of `CAMCI5VP...3HP3` on the SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` (12.1 USDC) | 6,141,535 at ledger 5,628,083 (29.7 days); re-read 2026-11-10: 6,160,295 at 5,660,925 (28.9 days) after a claim touched it | the SAC's own bump on access moved it by about 19,000 ledgers; that bump only runs when the entry is already under the SAC's threshold, so it is not a plan |

Until 2026-11-10 the watchdog did not read this entry at all.

## The watchdog now watches this

`apps/sponsor/src/lib/watchdog.ts` (`checkStateExpiry`) reads all three entries every 15 minutes
(the instance, the code, and the escrow's USDC balance entry on the SAC, built from the configured
USDC asset exactly as the apps build it) and pages when the soonest of the three is fewer than
`SPONSOR_MIN_TTL_DAYS` days away (default 21, set explicitly in both `wrangler.toml` blocks). The
page carries the three commands below, each labelled; a balance entry the RPC has no live copy of
is its own page ("Escrow USDC balance entry not found") with the restore command. Deploy both
Workers for it to take effect: `npx wrangler deploy` (testnet) and `npx wrangler deploy --env mainnet`.

## The procedure: three commands, any funded key

No owner or sponsor key is needed. TTL extension is unauthenticated on Stellar; whoever submits
pays the rent. Use any funded account (a personal wallet is fine; do not drain the sponsor for it).
The sponsor hot key may pay too: `extend_footprint_ttl` and `restore_footprint` are on the
watchdog's sponsor-sourced allowlist, so paying from it never pages or halts.

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

### 3. the escrow's USDC balance entry on the SAC (cents; its own clock)

The entry belongs to the **USDC Stellar Asset Contract**, not to the escrow, so `--id` names the
SAC and `--key-xdr` names the storage key. `--key-xdr` takes the **ScVal** of the key (base64),
the vector `["Balance", Address(<escrow>)]`, NOT the full `LedgerKey` XDR (that one is what the
RPC's `getLedgerEntries` reads; see "Verify afterwards"). Checked against `stellar 30.0.1` with
`--build-only` on 2026-11-10: the built transaction's footprint carries the SAC's Balance entry.

```bash
# mainnet: USDC SAC CCW67TSZ...MI75, escrow CAC5JYQ2...WGR4
stellar contract extend --id CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75 \
  --key-xdr AAAAEAAAAAEAAAACAAAADwAAAAdCYWxhbmNlAAAAABIAAAABBdTiGrkJVPeEuL6hG8yYIu6KVIas1UnM8UCxCp2kyIs= \
  --ledgers-to-extend 3000000 --durability persistent --source-account <FUNDED_SECRET_OR_IDENTITY> --network mainnet

# testnet: USDC SAC CBIELTK6...DAMA, escrow CAMCI5VP...3HP3
stellar contract extend --id CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA \
  --key-xdr AAAAEAAAAAEAAAACAAAADwAAAAdCYWxhbmNlAAAAABIAAAABGCR2r4rhRfj8gpefX+CS6iJgOLS+3cDfTVwNdOLGpt0= \
  --ledgers-to-extend 3000000 --durability persistent --source-account <FUNDED_SECRET_OR_IDENTITY> --network testnet
```

The watchdog's page prints the same command with the ids it is configured with. To rebuild the key
by hand (after a contract or issuer change), from `apps/sponsor`:

```bash
node -e '
const { xdr, Address, Asset, Networks } = require("@stellar/stellar-sdk");
const [net, issuer, escrow] = process.argv.slice(1);
const pass = net === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
const sac = new Asset("USDC", issuer).contractId(pass);
const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), new Address(escrow).toScVal()]);
const ledgerKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(sac).toScAddress(), key, durability: xdr.ContractDataDurability.persistent() }));
console.log("sac", sac); console.log("--key-xdr", key.toXDR("base64")); console.log("getLedgerEntries key", ledgerKey.toXDR("base64"));
' mainnet GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN CAC5JYQ2XEEVJ54EXC7KCG6MTARO5CSUQ2WNKSOM6FALCCU5UTEIWGR4
```

(`USDC_ISSUER` and `LUMENDROP_CONTRACT` are in the matching `wrangler.toml` block.) The cost is
cents, like the instance: the entry is small. Any funded key may pay it.

For mainnet the CLI needs an RPC configured once:
`stellar network add mainnet --rpc-url https://mainnet.sorobanrpc.com --network-passphrase "Public Global Stellar Network ; September 2015"`.

### Measured cost

| Network | Instance | Code | How measured |
|---|---|---|---|
| testnet, 3,000,000 ledgers | 0.068 XLM | 28.98 XLM | paid on 2026-09-06, txs `0ebc57a4…` and `e619650b…` |
| mainnet, 3,000,000 ledgers (simulated 09-06) | 0.044 XLM | 19.58 XLM | `simulateTransaction`, not paid |
| mainnet, paid 2026-09-09 | 0.0015 XLM (3,000,000 ledgers) | 21.19 XLM (2,600,000 ledgers) | the 3,000,000-ledger code extension simulated at 28.12 XLM that day, so rent pricing moves: re-simulate before budgeting |

The code fee is proportional to the ledgers actually added, so extending mainnet earlier costs
roughly the same as extending it late; there is no saving in waiting.

### Verify afterwards

The CLI prints `New ttl ledger: N`. Independently:

```bash
curl -s -X POST https://mainnet.sorobanrpc.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLedgerEntries","params":{"keys":["<instance key XDR>"]}}'
```

For the USDC balance entry the key is the full `LedgerKey` (the script above prints it; mainnet:
`AAAABgAAAAGt785ZruUpaPdgYdSUwlJbdWWfpClqZfSZ7ynlZHfklgAAABAAAAABAAAAAgAAAA8AAAAHQmFsYW5jZQAAAAASAAAAAQXU4hq5CVT3hLi+oRvMmCLuilSGrNVJzPFAsQqdpMiLAAAAAQ==`,
testnet:
`AAAABgAAAAFQRc1ewHKado/VrQJQWFLfTwKNzoMOWsUiCbpISDsvAQAAABAAAAABAAAAAgAAAA8AAAAHQmFsYW5jZQAAAAASAAAAARgkdq+K4UX4/IKXn1/gkuoiYDi0vt3A301cDXTixqbdAAAAAQ==`);
the answer's `liveUntilLedgerSeq` is the new expiry, and an entry the RPC does not return is one
it has no live copy of.

Or simply wait for the next watchdog run: its `info` line reports the days left of all three
entries, and the page clears. The `ops/monitor` Blockaid-style monitors do not cover this; the
Worker watchdog is the only alarm.

## Restoring an archived contract (if this runbook was read too late)

`stellar contract restore --id <CONTRACT_ID> --durability persistent --source-account <FUNDED> --network mainnet`
and `stellar contract restore --wasm-hash <WASM_HASH> ...`, then extend as above. For the USDC
balance entry: `stellar contract restore --id <USDC_SAC> --key-xdr <KEY_XDR> --durability persistent --source-account <FUNDED> --network <net>`
with the same `--key-xdr` as in step 3, then extend it. Exits also self-restore on first use
because the relayer simulates and assembles the footprint, but that makes the sponsor pay the
restore rent and is not a plan.
