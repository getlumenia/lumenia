# Spike 11: the commitment escrow next to the live v2 escrow (testnet)

Generated 2026-10-06T18:27:53.388Z by `apps/sponsor/src/spike11-commitment.ts`. Testnet, protocol 29, RPC https://soroban-testnet.stellar.org.
Node v24.21.0, @stellar/stellar-sdk 16.3.0. Every row is in `measurements.json`; where the amount stays public is in `visibility.json`.

- commit: `CAGWIGEGGTPZK7SPERJRW3EYSEHGSZKQEKEH6SU4ECU6EI7BKTAILCXA` (contracts/lumen-drop-commit, wasm 0a7dbe551dacffc8894f8a20d7afaf72bd77e263c25b627d5d35e45a2d7e5ee4), asset USDC:GBKXPL53GR536LZWQ4MYFMIFVI5PXVBC55KRA57SLU6J3FLU5DQZMSAF
- control: `CAMCI5VPRLQUL6H4QKLZ6X7ASLVCEYBYWS7N3QG7JVOA25HCY2TN3HP3` (the live testnet v2 escrow), asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5

Each cell is median / max over the rows of that contract and operation.

| metric | commit deposit | control deposit | commit claim | control claim |
|---|---:|---:|---:|---:|
| n | 5 | 5 | 5 | 5 |
| instructions | 964260 / 964260 | 988716 / 988716 | 1502768 / 1502768 | 1449153 / 1449153 |
| diskReadBytes | 0 / 144 | 116 / 116 | 116 / 116 | 116 / 116 |
| writeBytes | 588 / 588 | 644 / 644 | 704 / 704 | 644 / 644 |
| footprint read-only entries | 3 / 4 | 3 / 3 | 3 / 3 | 3 / 3 |
| footprint read-write entries | 2 / 2 | 3 / 3 | 3 / 3 | 3 / 3 |
| minResourceFee (stroops) | 233726 / 782200 | 204074 / 204074 | 28150 / 28150 | 27800 / 27800 |
| transactionData resourceFee (stroops) | 233726 / 782200 | 204074 / 204074 | 28150 / 28150 | 27800 / 27800 |
| inclusion fee offered (stroops) | 10000 / 10000 | 10000 / 10000 | 10000 / 10000 | 10000 / 10000 |
| fee offered (stroops) | 243726 / 792200 | 214074 / 214074 | 38150 / 38150 | 37800 / 37800 |
| feeCharged (stroops) | 196600 / 673769 | 171363 / 171363 | 18301 / 18301 | 17951 / 17951 |
| wall ms, send to SUCCESS | 4295 / 4394 | 4283 / 4770 | 4377 / 4530 | 4450 / 4673 |

Difference of medians, commit minus control (see note 2 before reading the deposit column):

| metric | deposit | claim |
|---|---:|---:|
| instructions | -24456 | 53615 |
| diskReadBytes | -116 | 0 |
| writeBytes | -56 | 60 |
| footprint read-only entries | 0 | 0 |
| footprint read-write entries | -1 | 0 |
| minResourceFee (stroops) | 29652 | 350 |
| transactionData resourceFee (stroops) | 29652 | 350 |
| inclusion fee offered (stroops) | 0 | 0 |
| fee offered (stroops) | 29652 | 350 |
| feeCharged (stroops) | 25237 | 350 |
| wall ms, send to SUCCESS | 12 | -73 |

One-time deployment of the commitment contract:

| op | tx | instructions | diskReadBytes | writeBytes | resourceFee | feeCharged |
|---|---|---:|---:|---:|---:|---:|
| upload | `b3952a541d7a4744a0b43c3fe3a84b17ae8beaf1e0a5fb59d288a83fd279bc68` | 14179277 | 0 | 15652 | 57593260 | 50080607 |
| create | `f2a4a6d02f7bdc9548f1becc149875c084ed8f4e7b0d670b5161b9a8d307d1f7` | 1147983 | 0 | 292 | 185964 | 154471 |

Notes

1. The sender T submitted and paid for every transaction directly; no sponsor relay is in any number here.
2. The commitment deposit is sent by the asset's issuer (T issues the USDC code the commitment escrow pins), so its SAC leg is a mint: no sender trustline is read or written, and the SAC emits `mint` rather than `transfer` (CAP-67). The control deposit spends T's Circle USDC trustline. Deposit rows are therefore not like-for-like; the per-row footprint labels in measurements.json show the difference entry by entry. Claim rows are like-for-like (escrow balance to R's trustline on both legs).
3. The commitment does not hide the amount. The deposit moves it through a public SAC `transfer` call (emitted as `mint` here, see note 2), the escrow stores it in the clear as `escrowed` (it pays out the stored amount, never the revealed one), and the claim reveals amount and salt. visibility.json lists each place.
4. wall ms runs from sendTransaction to the first getTransaction SUCCESS, polled every 500 ms: it is dominated by ledger close time and carries up to one poll interval of granularity. Max columns include first-time effects, such as the first commitment deposit creating the escrow's SAC balance entry.
5. Field names (stellar-sdk 16.3.0): minResourceFee is the simulateTransaction result; instructions, diskReadBytes, writeBytes are SorobanResources accessors of the simulated transactionData; footprint entries are LedgerFootprint.readOnly() / readWrite() lengths; resourceFee is SorobanTransactionData.resourceFee(); fee offered is Transaction.fee after assembleTransaction (inclusion fee + resourceFee); feeCharged is TransactionResult.feeCharged() from getTransaction.
