# LumenDropCommit - a testnet spike, never for mainnet

**Status: TESTNET SPIKE.** An experiment for the private-links work: the LumenDrop escrow with a
sha256 commitment to the amount stored in each drop record. It shows the reveal/verify mechanics,
the storage schema a commitment-based escrow needs, and the byte layouts a client must reproduce.
**It does not hide the amount** (see [What it does NOT hide](#what-it-does-not-hide)).

- Never deployed to mainnet. Nothing in the product (web app, extension, sponsor Workers) calls
  it; the live escrow is [`contracts/lumen-drop`](../lumen-drop).
- No professional audit. The tests and tools below are self-assessment.
- Contract source: [`src/lib.rs`](src/lib.rs) - tests: [`src/test.rs`](src/test.rs)

## What it does

LumenDrop's one-to-one link drop, unchanged in shape: the sender escrows a fixed amount of one
pinned SAC token behind a link's ephemeral Ed25519 **public key**, the recipient picks a payout
address **at claim time**, the link key signs it, anyone (a gas-paying relayer) may submit the
claim, and after `expiry` the original sender can reclaim. The one addition is a commitment:

- At deposit, the sender's client draws a random 32-byte `salt` and passes
  `commitment = sha256(0x03 || link || amount || salt)` next to the amount.
- A claim must reveal `(amount, salt)`. The contract recomputes the commitment, checks that the
  revealed amount is the one escrowed, and verifies the link key's signature over a message that
  binds the payout **and** the reveal.
- Group pools are out of scope for the spike.

### Interface

| Function | Authorization | What it does |
|---|---|---|
| `__constructor(token, owner)` | deploy | pins the ONE SAC token + sets the governance owner |
| `deposit(from, link, commitment, amount, expiry)` | `from` (`require_auth`) | escrows `amount` behind `link` with `commitment` next to it; pausable |
| `claim(link, payout, sig, amount, salt)` | **reveal + in-contract Ed25519 signature** | pays `escrowed` to the link-signed `payout` |
| `reclaim(link)` | recorded `sender` | after `expiry`, refunds exactly `escrowed` |
| `get_drop(link)` | view | `Drop { sender, commitment, escrowed, expiry, claimed }` |
| `commitment_of(link, amount, salt)` | view (pure) | the commitment, for client parity |
| `claim_message(link, payout, amount, salt)` | view | the exact bytes the link key must sign |
| `paused` / `get_owner` | view | state reads |
| `pause` / `unpause` / `upgrade` / ownership fns | `owner` | governance, identical to LumenDrop |

Storage: `DataKey::Token` (instance) and `DataKey::Drop(link)` (persistent), each record wrapped
as `DropEntry::V1(Drop)` so a later upgrade can add a `V2` without the host trapping on old ones.
Events: `DepositEvent { link, sender, commitment, expiry }` (no amount),
`ClaimEvent { link, payout, amount }`, `ReclaimEvent { link, sender, amount }`, each with the
topics `[name, link]` as in LumenDrop.

### Byte layouts

```
commitment = sha256( 0x03 || link(32) || amount(16) || salt(32) )       81-byte preimage
claim msg  = 0x04 || network_id(32) || contract_address_xdr || link(32)
             || payout_xdr || amount(16) || salt(32)
```

`amount` is the `i128` as 16 bytes, big-endian two's complement. The tags continue LumenDrop's
(`0x01` single claim, `0x02` group claim), so none of these byte strings can stand in for
another. Binding the network id and the contract address makes a signature useless on any other
network or deployment; binding the payout makes redirection impossible; binding the reveal stops
a relayer from pairing a signature with any other `(amount, salt)`.

Known-answer vector, asserted by `cargo test` and by the TypeScript parity check
(`apps/sponsor/src/spike11-commitment.ts`): link = 32 bytes of `0x11`, amount = `1234567`,
salt = 32 bytes of `0x22` gives
`ea3424656bc0651d6bfc1f35d020dd77fd5c906fae5e81a443ecd58228a3f8d5`.

### Claim check order

| Step | On failure |
|---|---|
| 1. the drop exists | `NothingHere` (2) |
| 2. it is not claimed or reclaimed | `AlreadyClaimed` (3) |
| 3. the reveal opens the stored commitment (sha256 of the preimage above) | `BadReveal` (13) |
| 4. the revealed amount equals `escrowed` | `RevealMismatch` (14) |
| 5. the link key signed the claim message | the host traps the transaction |

Then the effects (`claimed = true`), then the transfer of `escrowed` to `payout`. Error codes 1
to 12 keep LumenDrop's numbers; 5 and 7 to 10 are never returned here (`NotSender` is unused in
LumenDrop too, the rest are group-only). `BadReveal` and `RevealMismatch` are new.

## What it does NOT hide

**This spike does not hide the amount.** On chain, the amount stays public everywhere it was
public before:

| Where | What is visible |
|---|---|
| `deposit` invocation arguments (the transaction envelope) | `amount` |
| the sender's auth entry | the signed invocation tree, including the sub-invocation `transfer(from, contract, amount)` on the SAC |
| the SAC's own `transfer` event, same transaction | `amount` |
| the drop's ledger entry (`get_drop`, `getLedgerEntries`) | `escrowed`, in the clear next to the commitment (see the next section) |
| token balances | the sender's and the contract's balances move by `amount` |
| `claim` invocation arguments | the revealed `amount` and `salt`, and the payout |
| `ClaimEvent` / `ReclaimEvent` and the SAC transfer out | the amount paid |

The one place the amount was removed is `DepositEvent`, which carries the commitment instead. On
its own that hides nothing, because the SAC event of the same invocation carries the amount;
`cargo test` asserts both halves, and the amount in the sender's auth entry as well
(`deposit_event_carries_no_amount_but_the_transfer_and_auth_do`). Hiding the amount for real would
need the escrowed value itself to move through something other than a plain SAC transfer, for
example a confidential asset as the escrowed token. This spike does not attempt that.

## Why `escrowed` is stored next to the commitment (the solvency trap)

All drops share ONE pooled SAC balance: the contract's own token balance. The contract cannot
check a commitment at deposit time, because it never sees the salt before a claim (taking the
salt at deposit would publish it and void the commitment). So nothing stops a sender from
depositing 1 while committing to 5.

If the reveal decided the payout, that sender, who holds their own link secret, could claim 5 to
themselves: the contract would pay 1 of their own escrow and 4 of everybody else's. That breaks
invariant 1 (global solvency: the contract balance equals the sum of unclaimed escrow) and
invariant 10 (no drop can withdraw more than its own escrow) of
[`contracts/lumen-drop/README.md`](../lumen-drop/README.md#invariant-specification).

So the record keeps `escrowed`, the amount the deposit actually pulled in, and the contract only
ever pays `escrowed`: a claim must reveal exactly that amount (else `RevealMismatch`), and a
reclaim returns exactly that amount. A drop whose commitment does not match its escrow is
unclaimable by anyone and goes back to its own sender after expiry; no other drop's money is
reachable from it. `dishonest_commitment_cannot_drain_other_drops` and the solvency property
test exactly this. Checked by hand: removing the `RevealMismatch` guard and paying the revealed
amount makes both fail.

The price of the rule is the row above: `escrowed` sits in the clear in the drop's ledger entry,
so the stored record does not hide the amount either.

## Invariants carried over from LumenDrop

Numbers refer to the [invariant specification](../lumen-drop/README.md#invariant-specification)
of `contracts/lumen-drop`.

| # | Invariant | Here | Tests |
|---|---|---|---|
| 1 | Global solvency | carries over, now with dishonest commitments in the population | `global_solvency_exact_over_honest_and_dishonest_commitments` |
| 2 | Single-drop exactly-once | carries over: one `claimed` flag is shared by `claim` and `reclaim` | `happy_reveal_pays_exactly_escrowed_once`, `reclaim_gating_and_mutual_exclusion`, the property |
| 3 | Payout integrity | carries over | `signature_binds_the_payout` |
| 4 | Cross-context replay resistance | carries over; the signature also binds the reveal | `claim_message_layout_binds_full_context`, `signature_for_one_contract_rejected_on_another`, `signature_binds_the_reveal` |
| 5 | Reclaim gating (time + sender auth) | carries over | `reclaim_gating_and_mutual_exclusion`, `reclaim_needs_sender_auth_claim_needs_none` |
| 6-9 | Group uniqueness, slot bound, pool conservation, pool claim/reclaim exclusion | do not apply: no group pools | - |
| 10 | Local implies global non-over-draw | carries over; it is what the solvency rule protects | `dishonest_commitment_cannot_drain_other_drops`, the property |
| 11 | Input validity | carries over for single drops: `amount > 0`, `now < expiry <= now + 30 days` | `deposit_inputs_and_expiry_bounds_enforced` |
| 12 | Verify-or-revert atomicity | carries over: a failed claim leaves balance and record untouched | `wrong_salt_is_bad_reveal`, `signature_binds_the_reveal`, the property |
| 13 | Admin cannot move funds, in this bytecode | carries over: the only transfers out are `claim` and `reclaim`; `upgrade` stays outside it, as in LumenDrop | `owner_surface_cannot_move_escrow_and_is_auth_gated` |
| 14 | Pause never traps funds | carries over: pause gates only `deposit` | `pause_blocks_deposit_never_claim_or_reclaim` |

Two properties are new to this crate:

- **Reveal binding.** A claim pays only when the revealed `(amount, salt)` opens the stored
  commitment for THIS link and the amount equals `escrowed` (`wrong_salt_is_bad_reveal`,
  `honest_commitment_with_another_revealed_amount_is_bad_reveal`,
  `reveal_bound_to_another_link_is_bad_reveal`, `dishonest_commitment_cannot_drain_other_drops`).
- **Check order.** The order in the table above is part of the interface
  (`claim_check_order_is_pinned`).

## Testing

```bash
cargo test                       # 21 tests: 20 unit tests + 1 model-based solvency property
cargo clippy --all-targets -- -D warnings \
  -W clippy::arithmetic_side_effects -W clippy::unwrap_used -W clippy::panic
cargo deny check                 # the same supply-chain policy as LumenDrop
PROPTEST_CASES=16 cargo mutants -f src/lib.rs   # mutation testing
```

The dependency versions are LumenDrop's exactly: `Cargo.lock` was copied from
`contracts/lumen-drop`, and only its root entry differs. This crate is not part of CI: `ci.yml`
and `contract-security.yml` run `contracts/lumen-drop` only.

## Build

```bash
stellar contract build           # -> target/wasm32v1-none/release/lumen_drop_commit.wasm
```

`stellar contract build` sets `SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1` itself; a
plain `cargo check --target wasm32v1-none` fails without it. Built here with stellar-cli 27.1.0
and rustc 1.96.0.

A testnet deploy, if the spike needs one (testnet only, never `--network mainnet`). Any SAC
works as the token; a test asset issued by the deploying key lets that key mint its own deposits.

```bash
stellar contract deploy --wasm target/wasm32v1-none/release/lumen_drop_commit.wasm \
  --source <testnet-key> --network testnet -- --token <testnet-SAC> --owner <owner-address>
```
