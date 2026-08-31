# LumenDrop — the Lumenia v2 Soroban escrow

Send USDC by link. The sender escrows a fixed amount behind a link's **ephemeral Ed25519
public key**; the recipient picks a payout address **at claim time**, the link key signs it, and
the contract releases exactly that amount to exactly that address. Anyone (a gas-paying relayer)
may submit the claim — the funds can only ever reach the payout the link key signed, enforced in
the contract's own bytecode. After `expiry`, the original sender can reclaim an unclaimed drop.

Group drops work the same way with `slots` equal shares to the first N **distinct** payouts.

- Contract source: [`src/lib.rs`](src/lib.rs) · tests + invariants: [`src/test.rs`](src/test.rs)
- Security policy + disclosure: [`../../SECURITY.md`](../../SECURITY.md)
- **Status: TESTNET only. No professional audit yet** — the tooling below is self-assessment.

## Interface

| Function | Authorization | What it does |
|---|---|---|
| `__constructor(token, owner)` | deploy | pins the ONE USDC SAC address + sets the governance owner |
| `deposit(from, link, amount, expiry)` | `from` (`require_auth`) | escrows `amount` behind `link` |
| `claim(link, payout, sig)` | **in-contract Ed25519 signature** | releases the escrow to the link-signed `payout` |
| `reclaim(link)` | recorded `sender` | after `expiry`, refunds the sender |
| `create_drop(from, link, amount, slots, expiry)` | `from` | funds a pool of `slots` equal shares |
| `claim_share(link, payout, sig)` | **in-contract Ed25519 signature** | claims one share to a distinct signed payout |
| `reclaim_pool(link)` | recorded `sender` | after `expiry`, refunds the unclaimed remainder |
| `claim_message(kind, link, payout)` | view | the exact bytes the link key must sign |
| `get_drop` / `get_pool` / `paused` / `get_owner` | view | state reads |
| `pause` / `unpause` / `upgrade` / ownership fns | `owner` | governance — see below |

### The signed message

```
tag(1) ++ network_id(32) ++ contract_address_xdr ++ link_pubkey(32) ++ payout_xdr
```

`tag` separates single (`0x01`) from group (`0x02`) claims. Binding the network id and the
contract address makes a signature useless on any other network or any other deployment; binding
the payout makes redirection impossible; the one-time `claimed` flag (and the per-payout
`PoolClaimed` key for groups) makes it single-use. Soroban's in-contract signature path does
**not** inherit the host's automatic nonce/replay protection, so this replay defense is the
contract's own and is deliberately explicit.

## Governance (upgradeable now → immutable after audit)

The contract uses OpenZeppelin's Stellar contracts for `Ownable`, `Pausable` and `Upgradeable`:

- The owner can **upgrade** the wasm, **pause new escrow**, transfer ownership (two-step), or
  renounce it. On mainnet the owner is intended to be a timelock + multisig with a delay of at
  least a drop's lifetime, so any in-flight drop can always be claimed or reclaimed under the
  code it was created on.
- The owner has **no path that moves escrowed funds** — the only `transfer`s out of the contract
  are in `claim`/`claim_share` (link-signature gated) and `reclaim`/`reclaim_pool` (sender-auth
  gated).
- **Pause stops only `deposit` and `create_drop`.** Claims and reclaims are never pausable, so no
  reachable state can trap escrowed funds.
- Storage records are wrapped in versioned enums (`DropEntry::V1`, `PoolEntry::V1`) from the
  first deployment so a future upgrade can extend them without the host trapping on old records.
- The intended end state is a final upgrade that **removes the upgrade entrypoint**, making the
  bytecode genuinely immutable.

## Invariant specification

These are the properties the test suite exists to defend. Numbers are referenced from the tests.

1. **Global solvency.** `USDC.balance(contract) == Σ unclaimed single-drop amounts + Σ pool
   remainings`, after every operation.
2. **Single-drop exactly-once.** At most one of `{claim, reclaim}` ever transfers, for exactly
   `amount`, once.
3. **Payout integrity.** A signature for `payout` can never pay any other address.
4. **Cross-context replay resistance.** Changing the contract, network, tag or link invalidates
   the signature.
5. **Reclaim gating.** `reclaim`/`reclaim_pool` succeed only when `now >= expiry` **and** the
   recorded sender authorizes.
6. **Group per-payout uniqueness.** `claim_share` succeeds at most once per `(link, payout)`.
7. **Group slot bound.** At most `slots` successful `claim_share` calls per pool.
8. **Pool conservation.** `remaining == amount − amount_per × claimed`, and `remaining >= 0`.
9. **Claim/reclaim mutual exclusion across expiry.** No interleaving lets a pool be reclaimed and
   its shares also claimed (which would drain other drops from the shared balance).
10. **Local ⇒ global non-over-draw.** No drop or pool can withdraw more than its own escrow.
11. **Input validity.** `amount > 0`, `slots > 0`, `amount >= slots`, and
    `now < expiry <= now + 30 days`.
12. **Verify-or-revert atomicity.** A failed claim changes nothing (effects precede the transfer,
    and a bad signature traps the transaction).
13. **Admin cannot move funds, in this bytecode.** No owner entrypoint transfers escrow: the only
    `token.transfer` sites are `claim`/`claim_share` (link-signature-gated) and
    `reclaim`/`reclaim_pool` (sender-auth-gated); the owner surface is upgrade/pause/renounce.
    `upgrade` is deliberately **outside** this invariant, because replacing the wasm can replace
    the rules. That is precisely why the posture is upgradeable-with-safety-net now and
    renounce-to-immutable after the professional audit, and why mainnet ownership belongs behind
    a timelock + multisig.
14. **Pause never traps funds.** All exits succeed regardless of pause state.

## Testing and tooling

```bash
cargo test                      # 29 tests: unit + the invariants above as property tests
cargo clippy --all-targets -- -D warnings \
  -W clippy::arithmetic_side_effects -W clippy::unwrap_used -W clippy::panic
cargo audit && cargo deny check  # advisories, licenses, bans, sources
cargo llvm-cov --summary-only    # line coverage
# Soroban-specific static analysis (CoinFabrik Scout). Scout drives its own pinned nightly and
# defaults to wasm32-unknown-unknown, which soroban-sdk 26 rejects — pin the host target:
CARGO_BUILD_TARGET=$(rustc -vV | awk '/^host:/{print $2}') cargo scout-audit
cargo +nightly fuzz run escrow_solvency -- -max_total_time=300   # solvency fuzzing
PROPTEST_CASES=16 cargo mutants -f src/lib.rs                    # mutation testing
```

The fast checks run in CI on every push; Scout, the OpenZeppelin `soroban-scanner` and mutation
testing run on a weekly workflow. Free tooling is **not** an audit and we do not describe it as
one.

## Build

```bash
stellar contract build          # → target/wasm32v1-none/release/lumen_drop.wasm
stellar contract deploy --wasm target/wasm32v1-none/release/lumen_drop.wasm \
  --source <key> --network testnet -- --token <USDC-SAC> --owner <owner-address>
```
