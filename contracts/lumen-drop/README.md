# LumenDrop - the Lumenia v2 Soroban escrow

Send USDC by link. The sender escrows a fixed amount behind a link's **ephemeral Ed25519
public key**; the recipient picks a payout address **at claim time**, the link key signs it, and
the contract releases exactly that amount to exactly that address. Anyone (a gas-paying relayer)
may submit the claim - the funds can only ever reach the payout the link key signed, enforced in
the contract's own bytecode. After `expiry`, the original sender can reclaim an unclaimed drop.

Group drops work the same way with `slots` equal shares to the first N **distinct** payouts.

New bytecode cannot be installed on a whim: an upgrade must be **proposed on chain and can only
execute seven days later, with the same hash** (the timelock, since 0.3.0). Pause stays instant.

- Contract source: [`src/lib.rs`](src/lib.rs), tests + invariants: [`src/test.rs`](src/test.rs)
- Security policy + disclosure: [`../../SECURITY.md`](../../SECURITY.md)
- **Status: no professional audit yet** - the tooling below is self-assessment. The crate runs on
  testnet and, as a hand-approved capped pilot, on mainnet; the hashes those deployments actually
  run are pinned in `apps/sponsor/wrangler.toml` and recorded in `EVIDENCE.md`. As of 2026-11-10
  both run 0.2.0, whose `upgrade` is one-step: **0.3.0, this source with the timelock, is not
  installed anywhere yet.** Check the pins before trusting any sentence here about what is live.

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
| `get_drop(link)` / `get_pool(link)` / `paused()` / `get_owner()` | view | state reads |
| `propose_upgrade(new_wasm_hash, operator)` | `owner` | step one of an upgrade: records the hash, executable from `now + 7 days` |
| `cancel_upgrade(operator)` | `owner` | withdraws the pending proposal |
| `upgrade(new_wasm_hash, operator)` | `owner`, **and a 7-day-old proposal of the same hash** | step two: installs the proposed wasm |
| `pending_upgrade()` | view | the pending proposal (`wasm_hash`, `not_before`, `proposed_at`), if any |
| `pause(caller)` / `unpause(caller)` | `owner` | instant brake on NEW escrow only - see governance |
| `transfer_ownership` / `accept_ownership` / `renounce_ownership` | `owner` / pending owner | two-step handover and renounce (OpenZeppelin `Ownable`) |

`operator` on the three upgrade functions is kept for shape parity with OpenZeppelin's
`Upgradeable` trait; what gates every owner function is the stored owner's authorization.

### Errors

| Code | Name | Raised by |
|---|---|---|
| 1 | `AlreadyExists` | `deposit` / `create_drop` on a link that already has a record |
| 2 | `NothingHere` | a claim or reclaim on an unknown link |
| 3 | `AlreadyClaimed` | `claim` / `reclaim` on a closed drop |
| 4 | `NotExpired` | `reclaim` / `reclaim_pool` before `expiry` |
| 5 | `NotSender` | reserved (unused; the sender check is `require_auth`) |
| 6 | `BadInput` | `amount <= 0`, `slots == 0`, `amount < slots` |
| 7 | `DropEmpty` | `claim_share` on a full pool, `reclaim_pool` with nothing left |
| 8 | `AlreadyClaimedThis` | a second `claim_share` by the same payout |
| 9 | `Expired` | `claim_share` at or after `expiry` |
| 10 | `Overflow` | checked arithmetic that would wrap (unreachable in practice) |
| 11 | `NotInitialized` | the token was never pinned |
| 12 | `BadExpiry` | `expiry` outside `(now, now + 7 days + 1 hour]` |
| 13 | `UpgradePending` | `propose_upgrade` while a proposal is pending |
| 14 | `NoPendingUpgrade` | `upgrade` / `cancel_upgrade` with nothing proposed |
| 15 | `UpgradeTooEarly` | `upgrade` before the proposal's `not_before` |
| 16 | `UpgradeHashMismatch` | `upgrade` with a hash other than the proposed one |

`upgrade` keeps the OpenZeppelin trait's unit-returning shape, so it raises 14-16 with
`panic_with_error!`; on the wire that is the same `Error(Contract, #code)` a `Result` gives.

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

## Governance: a seven-day timelock on upgrades, an instant brake, immutable after audit

The contract uses OpenZeppelin's Stellar contracts for `Ownable`, `Pausable` and `Upgradeable`,
with the upgrade delay written into this bytecode (OpenZeppelin 0.7.2 ships no timelock for a
contract's own upgrade; its separate `stellar-governance` controller would also put pause behind
the delay, which this design refuses).

- **Upgrades are two-step.** `propose_upgrade(hash)` records `PendingUpgrade { wasm_hash,
  not_before = now + 7 days, proposed_at = now }` in instance storage (enum-versioned as
  `UpgradeEntry::V1`) and emits `upgrade_proposed`. `upgrade(hash)` installs it only at or after
  `not_before`, only for that hash, clears the slot, bumps the schema marker and emits `upgraded`;
  `cancel_upgrade` withdraws it (`upgrade_cancelled`). A second proposal is refused while one is
  pending, so a hash can never be swapped silently under a running delay. The delay is a constant,
  not a setting: an owner-settable delay is one more thing a stolen owner quorum could shorten.
- **The owner is intended to be a multisig account**, and the delay still applies to it: a stolen
  quorum must announce new code seven days ahead, where the sponsor's watchdog and anyone else
  can see it, and the honest signers can `cancel_upgrade` or `pause` in the meantime.
- **Pause is instant and stops only `deposit` and `create_drop`.** Claims and reclaims are never
  pausable and never wait on the timelock, so no reachable state can trap escrowed funds.
- **The owner has no path that moves escrowed funds** - the only `transfer`s out of the contract
  are in `claim`/`claim_share` (link-signature gated) and `reclaim`/`reclaim_pool` (sender-auth
  gated).
- **Drop expiry is bounded by the delay.** A drop may live at most 7 days + 1 hour, so every drop
  alive when an upgrade is proposed has expired, and is reclaimable, by the time that upgrade can
  execute, to within the one-hour clock grace (the apps compute `expiry` as "now + 7 days" on the
  sender's device). A drop created after the proposal has notice: the event, and
  `pending_upgrade()`, which an app can read to warn the sender. The horizon was 30 days before
  0.3.0; a client that asks for more now gets `BadExpiry`.
- Storage records are wrapped in versioned enums (`DropEntry::V1`, `PoolEntry::V1`,
  `UpgradeEntry::V1`) so a future upgrade can extend them without the host trapping on old
  records. OpenZeppelin's schema marker (`get_schema_version`) starts at 1 and is incremented by
  each executed `upgrade`; a future wasm that changes a record layout still ships its own
  migration guard.
- The intended end state is a final upgrade that **removes the upgrade entrypoint**, making the
  bytecode genuinely immutable.

### Upgrade procedure (for a multisig owner)

Nothing below has been run against a live deployment yet; it is the procedure the code enforces.

1. **Build and upload the new wasm.** `stellar contract build --locked`, then
   `stellar contract upload --wasm target/wasm32v1-none/release/lumen_drop.wasm --network <net>
   --source <any funded key>`; it prints the hash. Anyone may pay for the upload, and the hash is
   public before anything is proposed. Record the stellar-cli and rustc versions that built it
   (see Build below: the CLI stamps itself into the wasm).
2. **Propose.** `stellar contract invoke --id <escrow> --network <net> --source <owner> --
   propose_upgrade --new_wasm_hash <hash> --operator <owner>`. With a 2-of-3 owner account, build
   the transaction instead of sending it (`--build-only`), collect two signatures (`stellar tx
   sign`), then submit (`stellar tx send`); the owner runbook holds the signing pipeline. Watch
   for the `upgrade_proposed` event; `pending_upgrade` (a read-only invoke) shows `not_before`.
3. **Wait seven days.** Earlier attempts fail with `UpgradeTooEarly`; a different hash fails with
   `UpgradeHashMismatch`; nothing changes on a failed attempt.
4. **Install.** The same invoke with `upgrade --new_wasm_hash <hash> --operator <owner>` at or
   after `not_before`, signed the same way. The `upgraded` event names the hash; the swap takes
   effect when the invocation completes. Then re-pin the hash the sponsor's watchdog expects
   (`LUMENDROP_WASM_HASH` on each Worker), or it will page about the owner's own upgrade.
5. **To abort at any point:** `cancel_upgrade --operator <owner>`. A later proposal starts a fresh
   seven days from its own time.

**First install of the timelock itself.** The live 0.2.0 bytecode has only the one-step
`upgrade`, so installing 0.3.0 is one last instant `upgrade(new_hash, operator)` under the old
code: no proposal is possible there and no event is emitted beyond the hash change the watchdog
polls. Nothing migrates (the slot is simply absent until the first proposal). Testnet first; the
first timelocked upgrade on any network necessarily takes a real seven-day wait to prove its
positive path, while the refusals and the cancel path are provable the same day.

**Emergency.** `pause` is instant whether or not a proposal is pending; it stops new escrow and
nothing else. There is no owner path to escrowed funds, so there is nothing to "rescue".

## Events

Every state change emits one event. Topics are `[name, key]`; data is a map keyed by field name
(the `#[contractevent]` default), empty for the two hashless governance events. The names are a
contract with the sponsor's watchdog, which decodes them by name.

| Topic 0 | Topic 1 | Data |
|---|---|---|
| `deposit` | `link` | `sender`, `amount`, `expiry` |
| `claim` | `link` | `payout`, `amount` |
| `reclaim` | `link` | `sender`, `amount` |
| `newpool` | `link` | `sender`, `amount`, `slots` |
| `share` | `link` | `payout`, `amount`, `claimed` |
| `repool` | `link` | `sender`, `amount` |
| `upgrade_proposed` | `wasm_hash` | `not_before` |
| `upgrade_cancelled` | `wasm_hash` | (empty map) |
| `upgraded` | `wasm_hash` | (empty map) |

OpenZeppelin's modules add their own (0.7.2 names, from their source): `paused` / `unpaused`,
and `ownership_transfer` / `ownership_transfer_completed` / `ownership_renounced`.

## Invariant specification

These are the properties the test suite exists to defend. Numbers are referenced from the tests.

1. **Global solvency.** `USDC.balance(contract) == sum of unclaimed single-drop amounts + sum of
   pool remainings`, after every operation.
2. **Single-drop exactly-once.** At most one of `{claim, reclaim}` ever transfers, for exactly
   `amount`, once.
3. **Payout integrity.** A signature for `payout` can never pay any other address.
4. **Cross-context replay resistance.** Changing the contract, network, tag or link invalidates
   the signature.
5. **Reclaim gating.** `reclaim`/`reclaim_pool` succeed only when `now >= expiry` **and** the
   recorded sender authorizes.
6. **Group per-payout uniqueness.** `claim_share` succeeds at most once per `(link, payout)`.
7. **Group slot bound.** At most `slots` successful `claim_share` calls per pool.
8. **Pool conservation.** `remaining == amount - amount_per * claimed`, and `remaining >= 0`.
9. **Claim/reclaim mutual exclusion across expiry.** No interleaving lets a pool be reclaimed and
   its shares also claimed (which would drain other drops from the shared balance).
10. **Local => global non-over-draw.** No drop or pool can withdraw more than its own escrow.
11. **Input validity.** `amount > 0`, `slots > 0`, `amount >= slots`, and
    `now < expiry <= now + 7 days + 1 hour` (the upgrade delay plus the clock grace; 30 days
    before 0.3.0).
12. **Verify-or-revert atomicity.** A failed claim changes nothing (effects precede the transfer,
    and a bad signature traps the transaction).
13. **Admin cannot move funds, in this bytecode.** No owner entrypoint transfers escrow: the only
    `token.transfer` sites are `claim`/`claim_share` (link-signature-gated) and
    `reclaim`/`reclaim_pool` (sender-auth-gated); the owner surface is propose/cancel/upgrade,
    pause/unpause and the ownership functions. `upgrade` is deliberately **outside** this
    invariant, because replacing the wasm can replace the rules. That is precisely why the posture
    is upgradeable-with-safety-net now and renounce-to-immutable after the professional audit, why
    the delay lives in the bytecode (15-17), and why ownership belongs to a multisig.
14. **Pause never traps funds.** All exits succeed regardless of pause state.
15. **Upgrade notice.** `upgrade` succeeds only for a hash that `propose_upgrade` recorded at least
    7 days (`UPGRADE_DELAY`) earlier: no proposal, a different hash, or `now < not_before` each
    fail with their own error, and a failed attempt changes nothing. On success the executable
    hash is the proposed one and every escrow record is untouched.
16. **One proposal at a time; cancel clears.** `propose_upgrade` is refused while a proposal is
    pending, so a hash can never be swapped under a running delay; `cancel_upgrade` removes it,
    after which `upgrade` fails until a NEW proposal has waited its own full delay; a proposal's
    `not_before` never moves.
17. **Governance never delays an exit or the brake.** `pause`/`unpause` act instantly, proposal
    pending or not; the timelock gates nothing but `upgrade`; and with invariant 11 a drop alive
    at a proposal is reclaimable before that proposal can execute, to within the one-hour clock
    grace.

## Testing and tooling

```bash
cargo test                      # 41 tests: unit + the invariants above as property tests
cargo clippy --all-targets -- -D warnings \
  -W clippy::arithmetic_side_effects -W clippy::unwrap_used -W clippy::panic
cargo audit && cargo deny check  # advisories, licenses, bans, sources
cargo llvm-cov --summary-only    # line coverage
# the real self-upgrade through the timelock, into the wasm built from this source (opt-in,
# because CI runs the tests before the wasm build):
stellar contract build --locked && cargo test -- --ignored
# Soroban-specific static analysis (CoinFabrik Scout). Scout drives its own pinned nightly and
# defaults to wasm32-unknown-unknown, which soroban-sdk 26 rejects - pin the host target:
CARGO_BUILD_TARGET=$(rustc -vV | awk '/^host:/{print $2}') cargo scout-audit
cargo +nightly fuzz run escrow_solvency -- -max_total_time=300   # solvency fuzzing
PROPTEST_CASES=16 cargo mutants -f src/lib.rs                    # mutation testing
```

The timelock tests need no compiled fixture: they upload a minimal wasm module built in-process
(header plus the SDK's `contractenvmetav0` section) and read the instance's executable hash back
from the test ledger, so a passing "late upgrade" test means the host really swapped the code.

The fast checks run in CI on every push; Scout, the OpenZeppelin `soroban-scanner` and mutation
testing run on a weekly workflow. Free tooling is **not** an audit and we do not describe it as
one. Ignored advisories are listed with a dated reason in `.cargo/audit.toml` and `deny.toml`;
today that is RUSTSEC-2026-0387 (crypto-bigint, reachable on the host side only, not in the wasm).

## Build

```bash
stellar contract build --locked # -> target/wasm32v1-none/release/lumen_drop.wasm
stellar contract deploy --wasm target/wasm32v1-none/release/lumen_drop.wasm \
  --source <key> --network testnet -- --token <USDC-SAC> --owner <owner-address>
```

The crate version (`Cargo.toml`, 0.3.0) is stamped into the wasm as the `binver` meta entry.

Toolchain: stellar-cli 30.0.1 (`brew install stellar-cli`; CI downloads the same release binary,
sha256-pinned in `.github/workflows/ci.yml`, and runs this build on every push) with rustc 1.96.0
and the `wasm32v1-none` target. The CLI writes its own version into the wasm's `contractmetav0`
section (`cliver`, shown by `stellar contract info meta --wasm ...`), so the same source and rustc
give a different sha256 under a different CLI: on 2026-11-10 one checkout of 0.2.0 built
`4b5780eb...cb68b` with 27.1.0 (the testnet pin in `apps/sponsor/wrangler.toml`) and
`956cb6ee...a72a` with 30.0.1, the two files differing in nothing but that string. To
source-verify a deployed hash, build with the CLI and rustc that deployment recorded
(`EVIDENCE.md`). The mainnet bytecode was reproduced this way on 2026-11-10: the on-chain meta
reads `cliver: 25.2.0#` (a 25.2.0 build that stamped no commit), and the 0.2.0 escrow built from
that source with stellar-cli 25.2.0 and rustc 1.96.0, with that stamp normalized by
`ops/wasm-normalize-cliver.py`, is byte-identical to the mainnet pin `38941538...ec6a`
(21,323 bytes).
