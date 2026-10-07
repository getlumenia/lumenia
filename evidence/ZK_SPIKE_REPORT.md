# ZK spike report: a commitment escrow on testnet (SOW 2, D2)

This spike does not hide the amount: LumenDrop.deposit moves it through a public SAC transfer, so it
stays in the invocation, the auth entry and the token transfer event regardless of the storage
record; the stored record carries the commitment next to the escrowed amount because the reveal must
be checked against what was actually deposited.

Status: **2026-10-06, testnet only.** Nothing from this spike was deployed to mainnet, and no preview
cryptography touched real money.

## What remains public

Measured on the first commitment deposit and its claim (testnet), read back from the RPC. Every row
names the raw RPC field, the XDR type and the JSON path inside it; the full decoded values are in
[`spike11/visibility.json`](spike11/visibility.json).

| # | Where | RPC field / XDR type | JSON path | Shows the amount? |
|---|---|---|---|---|
| 1 | The deposit call `(from, link, commitment, amount, expiry)` | `getTransaction.envelopeXdr` / `TransactionEnvelope` | `v1.tx.operations[0].body.invokeHostFunctionOp.hostFunction.invokeContract` | yes |
| 2 | The amount argument itself | same | `...invokeContract.args[3]` | yes |
| 3 | The sender's auth entry, root invocation `deposit` | same | `v1.tx.operations[0].body.invokeHostFunctionOp.auth[0].rootInvocation.function.contractFn` | yes |
| 4 | Its sub-invocation: the SAC `transfer(from, to, amount)` | same | `...auth[0].rootInvocation.subInvocations[0].function.contractFn` | yes |
| 5 | The token event in the meta (`mint` here, `transfer` for any sender who is not the issuer; CAP-67) | `getTransaction.events.contractEventsXdr[0][0]` / `ContractEvent` | `v4.operations[0].events[0]` | yes |
| 6 | The escrow's own `deposit` event | `getTransaction.events.contractEventsXdr[0][1]` / `ContractEvent` | `v4.operations[0].events[1]` | **no** (link, sender, commitment, expiry) |
| 7 | The escrow's token balance entry created in the meta | `getTransaction.resultMetaXdr` / `TransactionMeta` | `v4.operations[0].changes[1].created.data.contractData` | yes |
| 8 | The escrow's Drop entry created in the meta | same | `v4.operations[0].changes[3].created.data.contractData` | yes |
| 9 | The Drop entry today, `DropEntry::V1` | `getLedgerEntries.entries[0].xdr` / `LedgerEntryData` | `contractData.val` | yes |
| 10 | `Drop.commitment` | same | `contractData.val.vec[1].map[1].val` | no (a sha256) |
| 11 | `Drop.escrowed` | same | `contractData.val.vec[1].map[2].val` | **yes, in the clear** |
| 12 | The claim call `(link, payout, sig, amount, salt)`: the reveal is public | `getTransaction.envelopeXdr` (claim) | `v1.tx.operations[0].body.invokeHostFunctionOp.hostFunction.invokeContract` | yes |
| 13 | The revealed amount | same | `...invokeContract.args[3]` | yes |
| 14 | The revealed salt: with the amount, anyone can recompute the stored commitment | same | `...invokeContract.args[4]` | no |

stellar.expert shows rows 1 to 5 on the transaction page:
[deposit](https://stellar.expert/explorer/testnet/tx/78183bfa875d264f42bdda6e92b1809bc79651cc0ef0898ca3b900cb9952ec2b),
[claim](https://stellar.expert/explorer/testnet/tx/f478345c357c103e44f3e6c9e700e2dc6597bd402eccc475b71a0f9acac139a3).

Also public, as on every Lumenia link: the sender's account, the escrow, the time, the expiry, and on
claim the payout account. The commitment hides nothing that the transaction does not already show.

## Scope and non-goals

- **Testnet only.** The spike contract is a separate crate that the sponsor cannot reach: the live
  relay refuses every contract but the configured LumenDrop escrow (`apps/sponsor/src/lib/soroban-relay.ts`:
  the deposit guard at line 327, and `exitContract` at line 129 for claims and reclaims, which admits only
  that escrow and the superseded ones it lists), which is the point.
  A throwaway testnet key paid every fee directly and owns the spike contract.
- **No mixing, no shielded pool, no pooled anonymity set** of user funds (refused in the SOW as
  preview-grade on Stellar and compliance-hostile under the EU's 2027 AMLR rules).
- **The sponsor keeps reading amounts.** The sponsor reads the amount at deposit time from the
  transaction it fee-bumps; the $5 per transfer and $50 per day caps are unaffected.
- **No ZK or commitment contract on mainnet.** Mainnet contract changes wait for the professional
  security review; the production escrow (`contracts/lumen-drop`) is unchanged by this spike.

## What was built

`contracts/lumen-drop-commit`: the LumenDrop one-to-one drop with the plaintext amount replaced, in the
stored record's interface, by a commitment that is opened at claim time. soroban-sdk 26.1.1, the same
OpenZeppelin `stellar-access` / `stellar-contract-utils` / `stellar-macros` 0.7.2 governance
(Ownable two-step, Pausable gating only `deposit`, Upgradeable), records stored as the versioned
`DropEntry::V1`, never a bare struct. No group pools.

```
deposit(from, link, commitment: BytesN<32>, amount: i128, expiry: u64)
claim(link, payout, sig: BytesN<64>, amount: i128, salt: BytesN<32>)
reclaim(link)                       get_drop(link) -> Option<Drop>
commitment_of(link, amount, salt)   claim_message(link, payout, amount, salt)   (views, for client parity)

Drop { sender, commitment, escrowed, expiry, claimed }
commitment    = sha256( 0x03 || link(32) || amount as i128 big-endian(16) || salt(32) )       (81 bytes)
claim message = 0x04 || network_id(32) || contract_address_xdr || link(32) || payout_xdr || amount(16) || salt(32)
```

**The solvency rule.** If the record held only the commitment and the reveal decided the payout, a
sender could deposit 1 and reveal 5: the claim would pay 5 out of the escrow's single pooled token
balance, taking 4 from other people's drops (breaking invariants 1 and 10 of
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

The escrow schema is ready for a confidential asset.

### Tests

`cargo test` in `contracts/lumen-drop-commit`: **21 passed** (CI job "Spike contract (testnet only)"),
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

## Deployment (testnet)

| | |
|---|---|
| Commitment escrow | [`CAGWIGEGGTPZK7SPERJRW3EYSEHGSZKQEKEH6SU4ECU6EI7BKTAILCXA`](https://stellar.expert/explorer/testnet/contract/CAGWIGEGGTPZK7SPERJRW3EYSEHGSZKQEKEH6SU4ECU6EI7BKTAILCXA) |
| Wasm | 15,549 bytes, sha256 `0a7dbe551dacffc8894f8a20d7afaf72bd77e263c25b627d5d35e45a2d7e5ee4` (`stellar contract build`, `wasm32v1-none`) |
| Upload / create | [`b3952a54...9bc68`](https://stellar.expert/explorer/testnet/tx/b3952a541d7a4744a0b43c3fe3a84b17ae8beaf1e0a5fb59d288a83fd279bc68), [`f2a4a6d0...7d1f7`](https://stellar.expert/explorer/testnet/tx/f2a4a6d02f7bdc9548f1becc149875c084ed8f4e7b0d670b5161b9a8d307d1f7) |
| Pinned token | a SELF-ISSUED `USDC` whose issuer is the throwaway key (`GBKXPL53...MSAF`), its SAC `CCX2B4R3UOJWUO7H2CIKEFPZP7J54ULHXKRRBQXAQSEQGWEYTSYCMWME`. The live testnet escrow pins Circle's testnet USDC, which a throwaway key cannot mint. |
| One deposit / one claim | [`78183bfa...2ec2b`](https://stellar.expert/explorer/testnet/tx/78183bfa875d264f42bdda6e92b1809bc79651cc0ef0898ca3b900cb9952ec2b) / [`f478345c...139a3`](https://stellar.expert/explorer/testnet/tx/f478345c357c103e44f3e6c9e700e2dc6597bd402eccc475b71a0f9acac139a3) |
| Control leg | the live testnet v2 escrow `CAMCI5VPRLQUL6H4QKLZ6X7ASLVCEYBYWS7N3QG7JVOA25HCY2TN3HP3` with Circle testnet USDC from the testnet sponsor's `/faucet`; e.g. deposit [`3fcba5c5...75710`](https://stellar.expert/explorer/testnet/tx/3fcba5c55296161ea230da943ed06b88d0a3649e4a16560d8fe530fe89275710), claim [`799c7a14...49131`](https://stellar.expert/explorer/testnet/tx/799c7a14a8d87d6264e303e3bf5341fe7858d592404b3670e5b57fc8cc749131) |

The deploy used the JavaScript SDK (`Operation.uploadContractWasm` + `createCustomContract` with
constructor arguments) from `apps/sponsor/src/spike11-commitment.ts`, not the CLI. stellar-cli 27.1.0
warns on testnet that the network is on protocol 29 while it supports 27; a CLI deploy was never tried,
so that stays UNVERIFIED, and the SDK path made it unnecessary.

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

## Tier 2: Groth16 on BLS12-381 (computed estimate, UNVERIFIED on chain)

Not built, not deployed: computed estimate, UNVERIFIED on chain: measured in the local host budget
model, not deployed; no circuit of ours exists; circom and snarkjs are not installed.

How it was computed (2026-10-06): the upstream BLS12-381 Groth16 verifier from `stellar/soroban-examples`
(commit `03d42aa`, which now pins soroban-sdk 28) was re-pinned to soroban-sdk 26.1.1, the version this
repository uses; its source compiles unchanged and its 8 upstream tests pass (4,781-byte wasm). One
`verify_proof` call on the example's own proof was run as wasm in the host's budget model
(`env.cost_estimate()`), and the cost was priced with the live network configuration read from the RPC
(`getLedgerEntries` on the CONFIG_SETTING entries; testnet and mainnet are identical).

| | 1 public input (the circom and gnark examples) | 9 public inputs (the arkworks example) |
|---|---:|---:|
| CPU instructions, one verification | 41,347,090 | 68,660,030 |
| share of the 400,000,000-instruction transaction limit | 10.3 % | 17.2 % |
| CPU fee at 7 stroops per 10,000 instructions | about 28,943 stroops (0.0029 XLM) | about 48,063 stroops (0.0048 XLM) |
| memory | 1,500,248 bytes (limit 41,943,040) | |
| proof / verification key | 384 bytes / 768 + 96n bytes (864 at n = 1) | 384 bytes / 1,632 bytes |

A rule of thumb from the two measurements: about 37.9M instructions plus 3.4M per public input (only
n = 1 and n = 9 were measured). The four-input pairing check alone is 30,335,852 instructions, 73 % of
a verification. A Tier 2 drop would prove that a committed amount sits inside a range (a 32-bit
decomposition plus a commitment inside the circuit) with one or two public inputs, so about 41 to 45
million instructions and well under 0.01 XLM of CPU fee per claim; a full transaction would add size,
history and storage fees (a rough total of about 39,000 stroops for a 2 KB transaction is an
assumption, not a measurement). The 47M figure in the sprint plan has no source and is not reproduced
here; the SDK's own `fee()` helper uses a 2024 fee snapshot that overstates the CPU fee about 3.6 times.
The raw outputs, the RPC responses and the re-pinned verifier are kept with the working notes.

## Real amount hiding

Real amount hiding needs a confidential asset as the escrowed token; Stellar's Confidential Tokens and
Private Payments are developer previews, unaudited, testnet only, not for real assets
(developers.stellar.org, read on 2026-10-06).

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

Confidential Tokens are Noir circuits with UltraHonk proofs verified on BN254 (balances are Pedersen
commitments on Grumpkin); Private Payments use Groth16. Neither uses this spike's contract, and this
spike's Tier 2 estimate is the upstream example verifier, not theirs.

What this spike shows is the escrow half of that future: a drop record that does not need to read the
amount in order to release it correctly, a reveal checked against what was deposited, and a claim
signature that binds the reveal. When the escrowed token itself hides amounts, the `deposit` call,
the auth entry and the token event stop showing it; until then they show it, whatever the record holds.

## What was cut, and why

- **Groth16 on chain (T-ZK-06):** cut as planned. No circuit of ours exists, and circom and snarkjs are
  not installed; Tier 2 above is a computed estimate, not a deployment.
- **A like-for-like deposit leg:** the commitment deposit was sent by the asset's issuer (so the spike
  needed only friendbot XLM). A separate token holder as sender would make the deposit rows comparable;
  the claim rows already are.
- **Group drops** were left out of the spike crate; a pot of equal shares has a public per-share amount
  by construction.

## Toolchain

| | |
|---|---|
| Network | testnet protocol 29 (read from the RPC during the run). Mainnet moved to protocol 29 on 2026-10-01 (ledger 64,717,645), testnet on 2026-09-29 (ledger 4,935,524), both read from the RPC on 2026-10-06 |
| Contract | soroban-sdk 26.1.1, OZ stellar-* 0.7.2, rustc 1.96.0, `stellar contract build` (stellar-cli 27.1.0), target `wasm32v1-none` |
| Script | Node v24.21.0, @stellar/stellar-sdk 16.3.0, tsx |

## Reproduce

```bash
cd contracts/lumen-drop-commit && cargo test && stellar contract build
OFFLINE=1 pnpm --filter @lumenia/sponsor spike11   # the offline self-check: known answer, byte layouts (94/94)
N=5 pnpm --filter @lumenia/sponsor spike11         # testnet: a new throwaway key, a self-issued USDC, deploy, 5 + 5 runs
```

The throwaway keys live in `apps/sponsor/.env.spike11.json` (gitignored, written before any funding).
