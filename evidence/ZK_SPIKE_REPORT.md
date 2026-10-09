# Commitment spike report (the SOW's ZK spike)

**In plain words.** This was an experiment on Stellar's test network (testnet), with test money only.
Each test link's record on the ledger stores a sealed fingerprint of its amount (a sha256
"commitment"), and the money is paid out only when the claim opens that fingerprint correctly. It
does **not** hide the amount: the amount is visible on the public ledger when the money goes in, in
the stored record right next to the fingerprint, and when it comes out. No zero-knowledge proof of
our own was built. Separately, one zero-knowledge proof check (Stellar's own example proof, which
shows that someone knows two numbers whose product is 33) was run on testnet, to measure what such
a check costs on chain today.

## SOW wording vs what was delivered

| SOW wording | What was delivered | Status |
|---|---|---|
| a commitment stored in the escrow record | every drop record of the testnet contract `CAGWIG...LCXA` stores a sha256 commitment to (link, amount, salt), and a claim must open it ([check it yourself](#check-it-yourself)) | **met** |
| "instead of a plaintext amount" | the record keeps the plaintext amount (`escrowed`) **next to** the commitment, on purpose: all drops share one token balance, and without it a sender could deposit 1, reveal 5 and take 4 from other people's drops ([the solvency rule](#the-solvency-rule)) | **not met, by design** |
| "amount-hiding" | the deposit moves the amount through a public token transfer, so the call, the sender's signed authorization, the token's event and the balances all show it, whatever the record holds | **not met** |
| "with Stellar's shipped ZK primitives" | the escrow uses only the `sha256` and `ed25519_verify` host functions; a sha256 hash is not one of the zero-knowledge primitives on Stellar's privacy page | **not met in the escrow** |
| "a Groth16 range-proof variant on Stellar's live BLS12-381 host functions" (the stretch) | **measured on testnet with the upstream example circuit, not a range proof of our own**: one `verify_proof` of the soroban-examples circom proof, [`7a024510...48d6`](https://stellar.expert/explorer/testnet/tx/7a02451038580d5759466647bc04082a5674218511ef66ae2bcb6167fd9648d6), 41,460,357 CPU instructions, 0.0039623 XLM; it hides no Lumenia amount ([Tier 2](#tier-2-groth16-on-bls12-381-measured-on-testnet-with-the-upstream-example)) | **partly: the verification is measured, no range proof exists** |
| "an honest statement of what remains public" | [the table below](#what-remains-public), each row checkable on stellar.expert | **met** |

**No zero-knowledge proof of our own was built, and no zero-knowledge host function runs in the
escrow.** The one Groth16 proof verified on chain is the upstream example's (`a * b = c`); it proves
nothing about any Lumenia payment.

This is the spike's finding, a negative result: on Stellar today a hash commitment cannot hide the
amount of a token escrow. The token transfer that moves the money publishes the amount, and the
record has to keep the amount next to the commitment for the escrow to stay solvent. Hiding it needs
the escrowed token itself to hide amounts, a confidential token ([Real amount hiding](#real-amount-hiding)).
A variant without `escrowed` was left out on purpose: with a salt the sender picks it breaks
solvency, and with a commitment the contract computes from a public salt it hides nothing more,
because the transfer still shows the amount.

Status: **testnet only.** Built and measured 2026-10-06; Tier 2 measured on testnet, the ledger
state extended and this report revised 2026-10-09. Nothing from this spike was deployed to mainnet,
and no preview cryptography touched real money.

## Check it yourself

A browser is enough:

1. **The stored records:** [stellar.expert, contract storage](https://stellar.expert/explorer/testnet/contract/CAGWIGEGGTPZK7SPERJRW3EYSEHGSZKQEKEH6SU4ECU6EI7BKTAILCXA/storage).
   Each `"Drop"` row shows `"commitment"` (32 bytes, written in base64) right next to `"escrowed"`,
   the amount in the clear. Screenshot: [`spike11/stellar-expert-storage.png`](spike11/stellar-expert-storage.png).
2. **The first deposit:** [stellar.expert, transaction `78183bfa...2ec2b`](https://stellar.expert/explorer/testnet/tx/78183bfa875d264f42bdda6e92b1809bc79651cc0ef0898ca3b900cb9952ec2b).
   Open the operation's details (the double-arrow icon at its right): the call, the token transfer, the
   token's `mint` event, the escrow's new balance and the new drop record all show `1234567`; only the
   escrow's own `deposit` event leaves it out. Screenshot: [`spike11/stellar-expert-deposit.png`](spike11/stellar-expert-deposit.png).
3. **Its claim:** [stellar.expert, transaction `f478345c...139a3`](https://stellar.expert/explorer/testnet/tx/f478345c357c103e44f3e6c9e700e2dc6597bd402eccc475b71a0f9acac139a3):
   the reveal (amount `1234567` and the salt) is in the call. Screenshot: [`spike11/stellar-expert-claim.png`](spike11/stellar-expert-claim.png).

The first drop's stored record, decoded (read with `getLedgerEntries` on 2026-10-09):

| field | value |
|---|---|
| key | `Drop` + the link `d66b6140e8e985073425384ad1adec91c7639aa8b54190f7e70450914cc90049` (stellar.expert writes it `1mthQOjphQc0JThK0a3skcdjmqi1QZD35wRQkUzJAEk=`) |
| `commitment` | `58b1eec1e2fc7a995378308392445e7bc1b374c6516c8e31fe016d3ca05e9c2d` (stellar.expert: `WLHuweL8eplTeDCDkkRee8GzdMZRbI4x/gFtPKBenC0=`) |
| `escrowed` | `1234567`, that is 0.1234567 of the self-issued test USDC: **the amount, in the clear** |
| `claimed` | `true` today; [`spike11/visibility.json`](spike11/visibility.json) holds the same record as read right after the deposit, with `false` |
| `expiry` | `1791397572` (2026-10-07 18:26:12 UTC) |
| `sender` | `GBKXPL53GR536LZWQ4MYFMIFVI5PXVBC55KRA57SLU6J3FLU5DQZMSAF`, the spike's throwaway test key |

The other four drops have the same shape (`escrowed` 1234568 to 1234571), and all of them stay live on
testnet until about 2027-04 ([Keeping the state readable](#keeping-the-state-readable)).

## What remains public

Measured on the first commitment deposit and its claim (testnet). Every row can be checked on
stellar.expert as above. Its raw XDR is committed in [`spike11/visibility.json`](spike11/visibility.json)
with the RPC field, the XDR type and the JSON path of each item (deposit: `raw.deposit.envelopeXdr`,
`raw.deposit.resultMetaXdr`, `raw.deposit.contractEventsXdr`; claim: `raw.claim.envelopeXdr`; the
record: `raw.dropEntry.xdr`).

| # | Where | Shows the amount? | On stellar.expert | JSON path in the raw XDR |
|---|---|---|---|---|
| 1 | The deposit call `(from, link, commitment, amount, expiry)` | yes | deposit tx | `v1.tx.operations[0].body.invokeHostFunctionOp.hostFunction.invokeContract` |
| 2 | The amount argument itself | yes | deposit tx | `...invokeContract.args[3]` |
| 3 | The sender's auth entry, root invocation `deposit` | yes | deposit tx, details (as the invocation tree) | `v1.tx.operations[0].body.invokeHostFunctionOp.auth[0].rootInvocation.function.contractFn` |
| 4 | Its sub-invocation: the SAC `transfer(from, to, amount)` | yes | deposit tx, details (as the invocation tree) | `...auth[0].rootInvocation.subInvocations[0].function.contractFn` |
| 5 | The token event (`mint` here, `transfer` for any sender who is not the issuer; CAP-67) | yes | deposit tx, details | `v4.operations[0].events[0]` |
| 6 | The escrow's own `deposit` event | **no** (link, sender, commitment, expiry) | deposit tx, details | `v4.operations[0].events[1]` |
| 7 | The escrow's token balance entry, created | yes | deposit tx, details | `v4.operations[0].changes[1].created.data.contractData` |
| 8 | The escrow's Drop entry, created | yes | deposit tx, details | `v4.operations[0].changes[3].created.data.contractData` |
| 9 | The Drop entry today, `DropEntry::V1` | yes | contract storage | `contractData.val` |
| 10 | `Drop.commitment` | no (a sha256) | contract storage | `contractData.val.vec[1].map[1].val` |
| 11 | `Drop.escrowed` | **yes, in the clear** | contract storage | `contractData.val.vec[1].map[2].val` |
| 12 | The claim call `(link, payout, sig, amount, salt)`: the reveal is public | yes | claim tx | `v1.tx.operations[0].body.invokeHostFunctionOp.hostFunction.invokeContract` |
| 13 | The revealed amount | yes | claim tx | `...invokeContract.args[3]` |
| 14 | The revealed salt: with the amount, anyone can recompute the stored commitment | no | claim tx | `...invokeContract.args[4]` |

Where the raw data stays readable: the public RPC's `getTransaction` keeps about 7 days of history,
so it stops answering for these two transactions around 2026-10-13. Horizon keeps their envelopes
(rows 1 to 4 and 12 to 14) but not their meta (rows 5, 7 and 8); stellar.expert keeps both, and so
does `visibility.json` (decode with `stellar xdr decode --type TransactionEnvelope`, `TransactionMeta`
or `ContractEvent`).

Also public, as on every Lumenia link: the sender's account, the escrow, the time, the expiry, and on
claim the payout account. The commitment hides nothing that the transaction does not already show.

## Scope and non-goals

- **Testnet only.** The spike contract is a separate crate that the sponsor cannot reach. The live
  relay refuses every contract but the configured LumenDrop escrow, in
  `apps/sponsor/src/lib/soroban-relay.ts`: `relayDepositHandler` rejects a deposit ("wrong contract")
  unless the called contract is `config.lumendropContract`, and `exitContract`, which
  `relayClaimHandler` (`/v2-claim`) and `relayReclaimHandler` (`/v2-reclaim`) call, admits only that
  escrow and the superseded ones in `config.lumendropLegacyContracts`. That is the point. A
  throwaway testnet key paid every fee directly and owns the spike contract.
- **No mixing, no shielded pool, no pooled anonymity set** of user funds (refused in the SOW as
  preview-grade on Stellar and compliance-hostile under the EU's 2027 AMLR rules). The escrow's
  single token balance is shared accounting, not an anonymity set: each record is keyed by its own
  link (`DataKey::Drop(link)`), and every deposit and claim event carries that link as a topic,
  with the sender (deposit) or the payout (claim) next to it, so anyone can pair each deposit with
  its claim. On chain, the spike contract's 10 events (5 deposits and 5 claims, ledgers 5,057,518 to
  5,057,535) pair one to one by link (read with `getEvents` on 2026-10-09).
- **The sponsor keeps reading amounts.** The sponsor reads the amount at deposit time from the
  transaction it fee-bumps; the $5 per transfer and $50 per day caps are unaffected.
- **No ZK or commitment contract on mainnet.** Mainnet contract changes wait for the professional
  security review; the production escrow (`contracts/lumen-drop`) is unchanged by this spike.

## What was built

`contracts/lumen-drop-commit`: the LumenDrop one-to-one drop with one addition: next to the escrowed
amount, the stored record carries a sha256 commitment to it, which a claim must open. soroban-sdk
26.1.1, the same OpenZeppelin `stellar-access` / `stellar-contract-utils` / `stellar-macros` 0.7.2
governance (Ownable two-step, Pausable gating only `deposit`, Upgradeable), records stored as the
versioned `DropEntry::V1`, never a bare struct. No group pools.

```
deposit(from, link, commitment: BytesN<32>, amount: i128, expiry: u64)
claim(link, payout, sig: BytesN<64>, amount: i128, salt: BytesN<32>)
reclaim(link)                       get_drop(link) -> Option<Drop>
commitment_of(link, amount, salt)   claim_message(link, payout, amount, salt)   (views, for client parity)

Drop { sender, commitment, escrowed, expiry, claimed }
commitment    = sha256( 0x03 || link(32) || amount as i128 big-endian(16) || salt(32) )       (81 bytes)
claim message = 0x04 || network_id(32) || contract_address_xdr || link(32) || payout_xdr || amount(16) || salt(32)
```

### The solvency rule

If the record held only the commitment and the reveal decided the payout, a sender could deposit 1
and reveal 5: the claim would pay 5 out of the escrow's single pooled token balance, taking 4 from
other people's drops (breaking invariants 1 and 10 of
[`contracts/lumen-drop/README.md`](../contracts/lumen-drop/README.md)). So the record keeps
`escrowed` next to the commitment, the claim checks the reveal against both, and it always pays
`escrowed`:

1. the drop exists (`NothingHere`), 2. it is unclaimed (`AlreadyClaimed`),
3. `sha256(0x03 || link || amount || salt)` equals the stored commitment, else `BadReveal` (13),
4. the revealed amount equals `escrowed`, else `RevealMismatch` (14),
5. the link key signed the claim message, which binds the payout AND the reveal (a relayer can neither
   redirect the money nor pair the signature with another `(amount, salt)`),
6. effects, then the transfer of `escrowed`.

A sender who commits to an amount other than the one deposited makes a drop nobody can claim; it goes
back to that sender after expiry, and no other drop is touched. `DepositEvent` carries no amount
(row 6 above); `ClaimEvent` and `ReclaimEvent` keep it, since the claim reveals it anyway.

### Tests

`cargo test` in `contracts/lumen-drop-commit`: **22 passed** (CI job "Spike contract (testnet only)"),
`cargo clippy --all-targets -- -D warnings -W clippy::arithmetic_side_effects -W clippy::unwrap_used
-W clippy::panic` clean. The wrong-reveal cases and the adapted solvency property:

| Test | What it holds |
|---|---|
| `commitment_known_answer_vector` | link = 32 x 0x11, amount 1234567, salt = 32 x 0x22 gives `ea3424656bc0651d6bfc1f35d020dd77fd5c906fae5e81a443ecd58228a3f8d5` (the same vector the measurement script checks offline and against the deployed view) |
| `happy_reveal_pays_exactly_escrowed_once` | a correct reveal pays exactly `escrowed` to the payout, once |
| `wrong_salt_is_bad_reveal` | `BadReveal` |
| `honest_commitment_with_another_revealed_amount_is_bad_reveal` | a different amount with the right salt does not open the commitment: `BadReveal` |
| `dishonest_commitment_cannot_drain_other_drops` | deposit 1 committed to 5: revealing (5, salt) is `RevealMismatch`, revealing (1, salt) is `BadReveal`, other drops' balance is untouched, the sender reclaims 1 after expiry |
| `reveal_bound_to_another_link_is_bad_reveal` | a commitment cannot be moved to another drop (the link is in the preimage) |
| `signature_binds_the_reveal`, `signature_binds_the_payout`, `signature_for_one_contract_rejected_on_another`, `claim_message_layout_binds_full_context` | the signed message binds payout, reveal, contract and network |
| `claim_check_order_is_pinned` | the five checks run in the order above |
| `deposit_event_carries_no_amount_but_the_transfer_and_auth_do` | the escrow's event has no amount, while the token transfer and the auth entry carry it |
| `reclaim_gating_and_mutual_exclusion`, `reclaim_needs_sender_auth_claim_needs_none` | reclaim unchanged from LumenDrop: only after expiry, only the sender, never after a claim |
| `pause_blocks_deposit_never_claim_or_reclaim` | invariant 14: exits are never pausable |
| `owner_surface_cannot_move_escrow_and_is_auth_gated`, `ownership_two_step_then_renounce_locks_owner_surface`, `upgrade_reaches_the_host_wasm_swap` | invariant 13 and the governance surface |
| `global_solvency_exact_over_honest_and_dishonest_commitments` | property test (proptest): a mixed population of honest and dishonest commitments under random claims and reclaims; the escrow's token balance equals the sum of unclaimed `escrowed` at every step |
| `deposit_inputs_and_expiry_bounds_enforced`, `unknown_link_is_nothing_here` | input bounds |
| `deposit_bump_leaves_a_new_record_at_the_network_minimum_ttl` | under the live networks' state-archival settings, the deposit-time TTL bump does not fire on a new record, which lives exactly the network minimum; late in its life a claim does extend it (see [Keeping the state readable](#keeping-the-state-readable)) |

## Deployment (testnet)

| | |
|---|---|
| Commitment escrow | [`CAGWIGEGGTPZK7SPERJRW3EYSEHGSZKQEKEH6SU4ECU6EI7BKTAILCXA`](https://stellar.expert/explorer/testnet/contract/CAGWIGEGGTPZK7SPERJRW3EYSEHGSZKQEKEH6SU4ECU6EI7BKTAILCXA) |
| Wasm | 15,549 bytes, sha256 `0a7dbe551dacffc8894f8a20d7afaf72bd77e263c25b627d5d35e45a2d7e5ee4` (`stellar contract build`, `wasm32v1-none`; rebuilt from this repository's source on 2026-10-09 with stellar-cli 27.1.0 and rustc 1.96.0, the same hash) |
| Upload / create | [`b3952a54...9bc68`](https://stellar.expert/explorer/testnet/tx/b3952a541d7a4744a0b43c3fe3a84b17ae8beaf1e0a5fb59d288a83fd279bc68), [`f2a4a6d0...7d1f7`](https://stellar.expert/explorer/testnet/tx/f2a4a6d02f7bdc9548f1becc149875c084ed8f4e7b0d670b5161b9a8d307d1f7) |
| Pinned token | a SELF-ISSUED `USDC` whose issuer is the throwaway key (`GBKXPL53...MSAF`), its SAC `CCX2B4R3UOJWUO7H2CIKEFPZP7J54ULHXKRRBQXAQSEQGWEYTSYCMWME`. The live testnet escrow pins Circle's testnet USDC, which a throwaway key cannot mint. |
| One deposit / one claim | [`78183bfa...2ec2b`](https://stellar.expert/explorer/testnet/tx/78183bfa875d264f42bdda6e92b1809bc79651cc0ef0898ca3b900cb9952ec2b) / [`f478345c...139a3`](https://stellar.expert/explorer/testnet/tx/f478345c357c103e44f3e6c9e700e2dc6597bd402eccc475b71a0f9acac139a3) |
| Control leg | the live testnet v2 escrow `CAMCI5VPRLQUL6H4QKLZ6X7ASLVCEYBYWS7N3QG7JVOA25HCY2TN3HP3` with Circle testnet USDC from the testnet sponsor's `/faucet`; e.g. deposit [`3fcba5c5...75710`](https://stellar.expert/explorer/testnet/tx/3fcba5c55296161ea230da943ed06b88d0a3649e4a16560d8fe530fe89275710), claim [`799c7a14...49131`](https://stellar.expert/explorer/testnet/tx/799c7a14a8d87d6264e303e3bf5341fe7858d592404b3670e5b57fc8cc749131) |
| Live until | ledger 8,206,700 (instance), 8,206,702 (wasm), 8,206,707 (the five drop records): about 2027-04-07, extended 2026-10-09 ([Keeping the state readable](#keeping-the-state-readable)) |

The deploy used the JavaScript SDK (`Operation.uploadContractWasm` + `createCustomContract` with
constructor arguments) from `apps/sponsor/src/spike11-commitment.ts`, not the CLI. stellar-cli 27.1.0
warns on testnet that the network is on protocol 29 while it supports 27. A CLI deploy was never
tried, so that stays UNVERIFIED; `stellar contract extend` from the same CLI did work on protocol 29
(the seven transactions below).

## Keeping the state readable

Testnet archives a ledger entry nobody extends once its live-until ledger passes. A new persistent
entry gets the network minimum: 120,960 ledgers on testnet, about 7 days at the measured 5.0 s a
ledger (mainnet: 2,073,600 ledgers, about 120 days). The contract's own bump,
`extend_ttl(17,280, 518,400)`, only fires once fewer than 17,280 ledgers remain, so it did not extend
the new records: the first drop, deposited at ledger 5,057,518, was live until 5,178,477 (the deposit
ledger + 120,959), and the instance and the wasm until 5,178,472 and 5,178,471, about 2026-10-13
18:25 UTC. The test `deposit_bump_leaves_a_new_record_at_the_network_minimum_ttl` pins this for both
networks' settings. Archived is not lost: since protocol 23 a transaction that uses an archived
entry restores it automatically (its simulation adds the restore, and the transaction pays for it),
and the transactions themselves stay on stellar.expert. But a reviewer opening the contract after
that date would have found it archived.

On 2026-10-09 every entry this report points at was extended to the network maximum
(`stellar contract extend --ledgers-to-extend 3110399`; testnet's maximum entry TTL is 3,110,400
ledgers), paid by a throwaway testnet key:

| Entry | Live until before (ledger) | After | Transaction |
|---|---:|---:|---|
| escrow instance | 5,178,472 | 8,206,700 | [`e810ef50...ff392`](https://stellar.expert/explorer/testnet/tx/e810ef505a225ed9a95328d3d10337d44ea47aadf1ec838c36269bf1643ff392) |
| escrow wasm `0a7dbe55...5ee4` | 5,178,471 | 8,206,702 | [`f57c11c4...a186c`](https://stellar.expert/explorer/testnet/tx/f57c11c49b2688bb7bdd77f8f074407a128862387522823d4e2303a4455a186c) |
| the five drop records | 5,178,477 to 5,178,493 | 8,206,707 | [`cab6473f...baedf`](https://stellar.expert/explorer/testnet/tx/cab6473fb28da144e562159dfd53690d76cba340ee9f9dd412030ce2cb7baedf) |
| test asset SAC instance | 5,178,469 | 8,206,709 | [`6175758e...06f24`](https://stellar.expert/explorer/testnet/tx/6175758e59a0a8b250edc05e477b9f9b6cc82d445ad65fefbc7f8e8922806f24) |
| the escrow's balance entry in that SAC | 5,575,918 | 8,206,713 | [`169df691...b58e1`](https://stellar.expert/explorer/testnet/tx/169df691ce2577d08d35f57d8f7238a9f16358cbf98ab74319214c08326b58e1) |
| Tier 2 verifier instance `CBMYSVI2...75MD` | 5,217,407 | 8,206,867 | [`e57bb2c2...be62f`](https://stellar.expert/explorer/testnet/tx/e57bb2c216cb4fac0a6b624d035ebe5190978a747bb103b405b87cc77bcbe62f) |
| Tier 2 verifier wasm `40706c83...44c1` | 5,217,406 | 8,206,868 | [`639385d8...b7b9f`](https://stellar.expert/explorer/testnet/tx/639385d8682390d30afd800a0c7f9c81efd634c0b577e838fa400d61accb7b9f) |

Ledger 8,206,700 is about 2027-04-07 (5.0 s a ledger, measured over testnet ledgers 4,996,471 to
5,096,471). The "after" column was re-read with a read-only `getLedgerEntries` call at ledger
5,096,471 (2026-10-09 00:32 UTC). Every read and transaction is in [`spike11/ttl.json`](spike11/ttl.json),
and `pnpm --filter @lumenia/sponsor exec tsx src/spike11-ttl.ts` prints today's values. The seven
transactions cost 215.26 testnet XLM in fees, almost all of it rent, 211.15 of it for the two wasm
entries. While this was written, stellar.expert's storage view still showed the old values in its
TTL column; the RPC read is the authoritative one. A testnet reset would remove all of it
regardless; `visibility.json` keeps the raw XDR.

## Measurements

`N=5 pnpm --filter @lumenia/sponsor spike11`, 2026-10-06 18:25-18:28 UTC, testnet protocol 29, one
deposit and one claim per run on each contract, runs alternating. Each cell is median / max. The
full rows (hashes, ledgers, footprints entry by entry) are in
[`spike11/measurements.json`](spike11/measurements.json) and the generated table in
[`spike11/measurements.md`](spike11/measurements.md).

| metric | commit deposit | control deposit | commit claim | control claim |
|---|---:|---:|---:|---:|
| n | 5 | 5 | 5 | 5 |
| CPU instructions | 964,260 / 964,260 | 988,716 / 988,716 | 1,502,768 / 1,502,768 | 1,449,153 / 1,449,153 |
| disk read bytes | 0 / 144 | 116 / 116 | 116 / 116 | 116 / 116 |
| write bytes | 588 / 588 | 644 / 644 | 704 / 704 | 644 / 644 |
| minResourceFee (stroops) | 233,726 / 782,200 | 204,074 / 204,074 | 28,150 / 28,150 | 27,800 / 27,800 |
| feeCharged (stroops) | 196,600 / 673,769 | 171,363 / 171,363 | 18,301 / 18,301 | 17,951 / 17,951 |
| send to SUCCESS (ms) | 4,295 / 4,394 | 4,283 / 4,770 | 4,377 / 4,530 | 4,450 / 4,673 |

What it means:

- **The claim is the like-for-like comparison** (the escrow's balance to the recipient's trustline on
  both contracts). Opening the commitment costs **+53,615 CPU instructions** (one sha256 of 81 bytes and
  a signed message 48 bytes longer, about 3.7 % of the claim) and **+350 stroops** (0.000035 XLM), with
  60 more bytes written.
- **The deposit rows are not like-for-like:** on the commitment leg the sender is the asset's issuer,
  so its token leg is a mint that reads and writes no sender trustline, while the control deposit
  spends a Circle USDC trustline. The commitment deposit still costs about 25,000 stroops (0.0025 XLM)
  more in fees: rent for a drop record that is 32 bytes larger plus that leg's different footprint.
  The max column's 673,769 is the first deposit, which also created the escrow's token balance entry.
- **Latency is the ledger, not the code:** every transaction landed in about 4.3 to 4.5 seconds from
  `sendTransaction` to `SUCCESS` (polled every 500 ms), the same on both contracts.
- The one-time deployment cost 5.008 XLM to upload 15.5 KB of wasm and 0.015 XLM to create the
  instance.

The CPU instructions above are what each transaction declared, from its simulation, which adds a
margin over what the host then consumes. stellar.expert shows the consumed figure in each
transaction's details: 897,621 for the first commitment deposit (declared 964,260) and 1,421,256 for
its claim (declared 1,502,768). The comparisons above are declared against declared.

## Tier 2: Groth16 on BLS12-381, measured on testnet with the upstream example

**Upstream example circuit, not a range proof of our own.** On 2026-10-09 the upstream BLS12-381
Groth16 verifier from `stellar/soroban-examples` (commit `03d42aa`, re-pinned to soroban-sdk 26.1.1,
the version this repository uses) was deployed to testnet, and `verify_proof` was called once with
the example's own circom proof (the circuit `a * b = c`, public output `c = 33`). It returned `true`.
It hides no Lumenia amount and touches no escrow; it shows that one BLS12-381 Groth16 verification
runs on the live network, and what that costs. The source, fixtures, harness, raw outputs and the
network settings used are public in [`spike11/tier2/`](spike11/tier2/), and the run is
`apps/sponsor/src/spike12-groth16.ts` ([`spike11/tier2/onchain.json`](spike11/tier2/onchain.json)).

| | testnet, measured | local host budget model |
|---|---:|---:|
| the call | [`7a024510...48d6`](https://stellar.expert/explorer/testnet/tx/7a02451038580d5759466647bc04082a5674218511ef66ae2bcb6167fd9648d6), ledger 5,096,449, returned `true` | |
| CPU instructions consumed, 1 public input (circom fixture) | **41,460,357** (stellar-core's `core_metrics`; stellar.expert shows the same) | 41,347,090 |
| CPU instructions declared (from the simulation; the fee is charged on this) | 43,118,122 | |
| share of the 400,000,000-instruction transaction limit | 10.4 % | 10.3 % |
| memory | 1,520,463 bytes (limit 41,943,040) | 1,500,248 bytes |
| transaction size | 1,860 bytes (proof 384 bytes, verification key 864 bytes, as ScVal arguments 1,512 bytes) | |
| fee charged | **39,623 stroops (0.0039623 XLM)** | |
| 9 public inputs (arkworks fixture) | 71,570,904 declared (simulated, not submitted) | 68,660,030 |

The fee breaks down exactly as the live settings predict: CPU 30,183 stroops (43,118,122 x 7 / 10,000,
rounded up) + transaction size 738 + history 8,562 = 39,483 non-refundable, plus 40 refundable (the
return value) and the 100-stroop inclusion fee. The local model came within 0.3 % of the consumed
figure; it does not count decoding the arguments from the transaction. A wrong public input (`22`)
simulates to `false` at the same cost. One-time deployment: upload 2.6985009 XLM
([`22d01c4d...2034b`](https://stellar.expert/explorer/testnet/tx/22d01c4d30e0ccf0677d044a919215761ca60b4bc91eb6756579c6c0eeb2034b)),
create 0.0068598 XLM ([`bcf01adf...04cd7`](https://stellar.expert/explorer/testnet/tx/bcf01adf82a0123c5fbad2184faf2f21523f6992b8660adec6e4e056ba704cd7)),
contract [`CBMYSVI2KCESZC6BNAKDTKHJKIA22EKXLOILPYVPQYIGVJ44R7PL75MD`](https://stellar.expert/explorer/testnet/contract/CBMYSVI2KCESZC6BNAKDTKHJKIA22EKXLOILPYVPQYIGVJ44R7PL75MD).
Screenshot: [`spike11/tier2/stellar-expert-verify-proof.png`](spike11/tier2/stellar-expert-verify-proof.png).

What it would mean for a drop, as an estimate from the local model and not a measurement: about
37.9 million instructions plus 3.4 million per public input (only n = 1 and n = 9 were measured; the
four-input pairing check alone is 30,335,852 instructions, 73 % of a verification). A range proof
(a 32-bit decomposition plus a commitment inside the circuit) with one or two public inputs would sit
at about 41 to 45 million instructions, roughly 0.004 XLM per claim. That circuit does not exist: no
circuit of ours was written (circom and snarkjs are not installed). And even with it, a range proof
would not hide the amount while the escrowed token is a public SAC, because the transfer shows it.

How the local figures were produced: the verifier's source compiles unchanged against soroban-sdk
26.1.1 and its 8 upstream tests pass (4,781-byte wasm, sha256 `40706c83...44c1`, the code deployed
above). One `verify_proof` on each example proof was run as wasm in the host's budget model
(`env.cost_estimate()`), and priced with the network settings read with `getLedgerEntries` on the
CONFIG_SETTING entries on 2026-10-06. Testnet and mainnet had the same compute, bandwidth, history
and CPU cost settings that day. They differ in the settings that drive rent and archival: the target
state size behind the rent price (4 GB on testnet, 3 GB on mainnet), and the minimum persistent TTL
(120,960 ledgers on testnet, 2,073,600 on mainnet, both re-read on 2026-10-09). An earlier planning
figure of 47M instructions has no source and is not reproduced here; the SDK's own `fee()` helper
prices with a 2024 fee snapshot that overstates the CPU fee about 3.6 times.

## Real amount hiding

Real amount hiding needs a confidential asset as the escrowed token; Stellar's Confidential Tokens and
Private Payments are developer previews, unaudited and not for real assets (developers.stellar.org,
read on 2026-10-06).

The wording on that page (https://developers.stellar.org/docs/build/apps/privacy, last updated
2026-08-27, read 2026-10-06), verbatim with its dashes written as "--":

- Private Payments: "Stellar Private Payments is a developer preview. The contracts, SDKs, and demo
  linked below are unaudited -- testnet only, not intended for production use or real assets."
- Confidential Tokens: "Confidential tokens on Stellar are a developer preview. The contracts and demo
  linked below are unaudited -- not yet intended for production use or real assets." Its box does not
  say "testnet only"; the announcement it links (stellar.org blog, 2026-06-29) says "While they're not
  yet approved for mainnet, the Confidential Token contract is live on testnet."
- Since that page was written, OpenZeppelin audited the UltraHonk VERIFIER (31 August 2026: 5 low
  findings, 6 notes, per the verifier's README); the token contracts themselves are still described as
  unaudited.

Private Payments is named here only for its status: in the page's own words, its users "hold a
private balance in a shared shielded pool", which is the design this SOW refuses. The path this
spike points at is a confidential asset; the announcement describes Confidential Tokens as adding
"private balances and private transfer amounts to any SEP-41 token", which hides amounts and
balances and is not described as hiding who pays whom.

Confidential Tokens are Noir circuits with UltraHonk proofs verified on BN254 (balances are Pedersen
commitments on Grumpkin); Private Payments use Groth16. Neither uses this spike's contract, and this
spike's Tier 2 measurement is the upstream example verifier, not theirs.

What this spike shows is a release gated by opening a commitment, checked against what was deposited,
with a claim signature that binds the reveal. The payout still comes from the plaintext `escrowed`,
and the interface takes `amount: i128` at deposit and at claim. A confidential asset would need a
different interface (an encrypted amount and a proof in place of both), which this spike did not
build.

## What was cut, and why

- **A Groth16 circuit of our own (the range proof):** cut as planned. No circuit of ours exists, and
  circom and snarkjs are not installed. In its place, the upstream example verifier was measured on
  testnet (Tier 2 above).
- **A like-for-like deposit leg:** the commitment deposit was sent by the asset's issuer (so the spike
  needed only friendbot XLM). A separate token holder as sender would make the deposit rows comparable;
  the claim rows already are.
- **Group drops** were left out of the spike crate; a pot of equal shares has a public per-share amount
  by construction.

## Toolchain

| | |
|---|---|
| Network | testnet protocol 29 (read from the RPC during each run). Mainnet moved to protocol 29 on 2026-10-01 (ledger 64,717,645), testnet on 2026-09-29 (ledger 4,935,524), both read from the RPC on 2026-10-06 |
| Contract | soroban-sdk 26.1.1, OZ stellar-* 0.7.2, rustc 1.96.0, `stellar contract build` (stellar-cli 27.1.0), target `wasm32v1-none` |
| Scripts | Node v24.21.0, @stellar/stellar-sdk 16.3.0, tsx |

## Reproduce

```bash
cd contracts/lumen-drop-commit && cargo test && stellar contract build    # sha256 0a7dbe55...5ee4
OFFLINE=1 pnpm --filter @lumenia/sponsor spike11   # the offline self-check: known answer, byte layouts (94/94)
N=5 pnpm --filter @lumenia/sponsor spike11         # testnet: a new throwaway key, a self-issued USDC, deploy, 5 + 5 runs
pnpm --filter @lumenia/sponsor exec tsx src/spike11-ttl.ts               # read-only: how long the state stays live
OFFLINE=1 pnpm --filter @lumenia/sponsor exec tsx src/spike12-groth16.ts # Tier 2 self-check (17/17); the live run: spike11/tier2/README.md
```

The scripts use throwaway testnet keys only; no key that holds real money is involved, and none is
in this repository.
