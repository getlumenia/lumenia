# lumenia-drop: send USDC by link on NEAR

Lumenia sends USDC by link. The sender escrows USDC and shares a link whose
URL fragment holds a fresh ed25519 secret key; the recipient opens it in a
browser and claims with no wallet, no seed phrase and no gas; the payout
destination is chosen at claim time; the sender takes unclaimed money back
after the link expires. This crate is the NEAR version of the escrow that is
live on Stellar (getlumenia.com), built for NEAR HACKATHON 2026. It lives at
`contracts/lumen-drop-near/contract` in the Lumenia monorepo (the Stellar escrow
is `contracts/lumen-drop`); `contracts/lumen-drop-near` is its own Cargo workspace.

**Status: testnet only, not audited, hackathon code.** See "What is not done".

| | |
|---|---|
| Contract account | `lumenia-near.testnet` (owner key = deploy key for now) |
| Code hash on chain | `7RpDA5CPMQjJYww6do9jX1quJcZm3MAuyQdGJq9d1jhA` |
| wasm sha256 | `5f8170e790a71a92217f19efe7804e6e801945acc7efe53b39849223cf63a5c1` (236,038 bytes, `cargo near build non-reproducible-wasm`) |
| Token | Circle testnet USDC `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` (6 decimals, storage min = max = 0.00125 NEAR) |
| Root for named accounts | `testnet` (mainnet: `near`) |
| Live config | read it with `get_config` (`scripts/views.sh`); the owner changes it with `scripts/set-config.sh` at any time, so the numbers below are the deploy defaults, not a promise |
| Deploy defaults | key_allowance 1 NEAR, registration_deposit 0.00125 NEAR, max_expiry_s 604800 (7 days), starter_yocto 0.01 NEAR (code default; the testnet value is being raised to 0.05 NEAR with `set_config`, see "Starter gas ceiling"), min_amount 100000 (0.10 USDC) |
| Demo funder | `lumenia-funder.testnet` (faucet account, registered on USDC) |
| Toolchain | near-sdk 5.30.1, near-contract-standards 5.30.1, cargo-near 0.23.0, near-cli-rs 0.31.1, rust 1.95.0 (pinned in `rust-toolchain.toml`), near-sandbox 0.4.0 (nearcore 2.14.0), near-api 0.8 |

## Transactions on testnet

| Step | Tx | Explorer |
|---|---|---|
| First deploy + `new` init (layout V0, code hash `5ZuSGGyLxPe8t1Ldrajd9GZ8VJC9zNidMK1KQQzjYFJr`) | `EUTi1v1Z4PfMEx75GzDcPfohmAEeJv35VsAy9BBsyjQ9` | https://testnet.nearblocks.io/txns/EUTi1v1Z4PfMEx75GzDcPfohmAEeJv35VsAy9BBsyjQ9 |
| Register the contract on USDC (`storage_deposit`, 0.00125 NEAR) | `7Tw9WbQLBGhVYP3JBGcuDyM3952hPCZZb8H2LDW57y5L` | https://testnet.nearblocks.io/txns/7Tw9WbQLBGhVYP3JBGcuDyM3952hPCZZb8H2LDW57y5L |
| Create `lumenia-funder.testnet` (faucet) | `2rwMYkddUzgpwYY4UMEAhPBeDb3bPwwergm4Pseknd8L` | https://testnet.nearblocks.io/txns/2rwMYkddUzgpwYY4UMEAhPBeDb3bPwwergm4Pseknd8L |
| Register the funder on USDC | `8RytRwWJShETYgsfme71NMxHrUvPf4zTM8mfxeZnNJLz` | https://testnet.nearblocks.io/txns/8RytRwWJShETYgsfme71NMxHrUvPf4zTM8mfxeZnNJLz |
| Probe: real root `testnet.create_account` with 0 NEAR attached returned `true` and created `lumenia-probe-0deposit.testnet` with a 0 NEAR balance (NEP-448), which `claim_to_new_account` relies on | `2MwLhhhHmtw2insgsVEzhiUAvXdfav6PACD7hLm5NjzB` | https://testnet.nearblocks.io/txns/2MwLhhhHmtw2insgsVEzhiUAvXdfav6PACD7hLm5NjzB |
| Second deploy + `migrate` (current code: starter, min_amount, batch create, ledger views) | `HQ2i1UDH37oXu7YLAoGLYupNVhd5HoJjNwV2GqMKeJ13` | https://testnet.nearblocks.io/txns/HQ2i1UDH37oXu7YLAoGLYupNVhd5HoJjNwV2GqMKeJ13 |
| Live create -> claim round | not run: `lumenia-funder.testnet` still held 0 USDC when this was written (checked after the second deploy). Run `scripts/live-round.sh` once faucet.circle.com USDC has arrived and paste the two hashes here. | |

Views right after the second deploy: `get_config` returned the deploy
defaults (the live values can change through `set_config`, always read them);
`get_stats` returned ``{drops_created: 0, drops_claimed: 0, drops_reclaimed: 0, open_drops: 0, pool_balance: "9987597737945865600000000", total_amount_created: "0", total_amount_claimed: "0", total_amount_reclaimed: "0"}` (the pool is the contract's own NEAR balance, about 9.99 NEAR)`.

## State

```text
owner_id, token_id, root_account_id : AccountId
paused                              : bool          (blocks NEW drops only)
key_allowance                       : NearToken     (gas allowance per link key, 1 NEAR)
registration_deposit                : NearToken     (USDC storage_deposit per recipient, 0.00125 NEAR)
max_expiry_s                        : u64           (604800)
starter_yocto                       : NearToken     (NEAR handed to an account a claim creates; code default 0.01 NEAR, live value in get_config)
min_amount                          : u128          (smallest drop, 6-dp units, 100000 = 0.10 USDC)
drops                               : LookupMap<PublicKey, Drop>
all_keys                            : Vector<PublicKey>                 (ledger, insertion order)
by_funder                           : LookupMap<AccountId, Vector<PublicKey>>
drops_created / drops_claimed / drops_reclaimed              : u64
total_amount_created / total_amount_claimed / total_amount_reclaimed : u128 (6-dp units)

Drop { funder, amount: U128, created_at_ns, expires_at_ns,
       status: Open | Claiming | Claimed | Reclaimed,
       claimed_to: Option<AccountId>, memo: Option<String>,
       status_changed_at_ns }       (status_changed_at_ns drives the stuck-claim window)
```

A drop record is never deleted, so `get_drop` keeps answering "Claimed" or
"Reclaimed" after the fact and a public key can never be reused.

## Interface

| Method | Who signs | Attach | What it does |
|---|---|---|---|
| `new(owner_id, token_id, root_account_id, key_allowance: U128, registration_deposit: U128, max_expiry_s: u64, starter_yocto: U128, min_amount: U128)` | deployer, once | - | `#[init]`; panics if the state exists |
| `migrate(starter_yocto: U128, min_amount: U128)` | the contract account itself (`#[private]`, `#[init(ignore_state)]`) | - | upgrades a V0 state in place: keeps records and counters, adds the new fields (ledger indexes start empty, totals at 0) |
| `ft_on_transfer(sender_id, amount, msg)` | the USDC contract, triggered by the funder's `USDC.ft_transfer_call(receiver_id = contract, amount, msg)` | funder: 1 yocto; 100 Tgas for one drop, 300 Tgas for a batch | creates one drop or a batch (msg shapes below); returns the unused amount: `"0"` when the drops were created, the whole amount when they were refused |
| `claim(account_id)` | the link key, as a transaction of the contract account itself | 0 NEAR, 60 to 100 Tgas (the web client attaches 100) | pays the drop to `account_id`; an implicit (64-hex) destination is created if missing and receives `starter_yocto`; a named destination must exist and receives no NEAR |
| `claim_to_new_account(new_account_id, new_public_key)` | the link key | 0 NEAR, 90 to 100 Tgas | creates `<name>.<root>` through the root linkdrop with `starter_yocto` attached, then pays the drop |
| `reclaim(public_key)` | the funder | 30 Tgas or more | after expiry, sends the USDC back and deletes the key |
| `pause()` / `unpause()` | owner | - | pause stops `ft_on_transfer` only |
| `top_up()` | anyone | the NEAR to add | adds to the sponsor pool (the contract balance) |
| `set_config(key_allowance?, registration_deposit?, max_expiry_s?, starter_yocto?, min_amount?)` | owner | - | all optional |
| `get_drop(public_key) -> Option<DropView>` | view | | one record |
| `get_drops(from_index?, limit?) -> Vec<DropView>` | view | | public ledger, newest first; `from_index` 0 = newest, `limit` default 50, max 100 |
| `get_drops_by_funder(funder, from_index?, limit?) -> Vec<DropView>` | view | | one funder's drops, same paging |
| `get_config() -> ConfigView`, `get_stats() -> StatsView` | view | | stats: `drops_created/claimed/reclaimed`, `open_drops`, `pool_balance` (= `env::account_balance()`), `total_amount_created/claimed/reclaimed` (6-dp units) |
| `on_account_ready`, `on_claim`, `on_reclaim` | `#[private]` callbacks | | not callable by link keys (not in the key's method list) |

`DropView = { public_key, status: "Open" | "Claiming" | "Claimed" | "Reclaimed", funder, amount: U128 string, created_at_ns, expires_at_ns, status_changed_at_ns (decimal strings: nanoseconds do not fit a JS number), claimed_to, memo }`.
It never carries anything secret: the public key is the drop's id, the secret
key exists only in the link.

### The two msg shapes of `ft_transfer_call`

One drop (a malformed msg panics with the reason, which makes the token refund
the funder through `ft_resolve_transfer`):

```json
{"public_key":"ed25519:...","expires_in_s":604800,"memo":"optional"}
```

A batch (any problem returns every token WITHOUT a panic, logs
`batch refused: <reason>; tokens returned`, and writes nothing):

```json
{"drops":[{"public_key":"ed25519:...","amount":"100000","memo":"optional"}, ...],"expires_in_s":604800}
```

Batch rules: 1 to 30 drops; the amounts must sum exactly to the transferred
amount; every amount >= `min_amount`; every key ed25519, unused and unique in
the batch; memo at most 256 bytes; one `expires_in_s` for the batch; one
`drop_created` event and one link key per drop. The 30 cap keeps a full batch
under the 100-log and 16 KB log limits of one receipt and at the gas measured
below. Both shapes: an amount below `min_amount` is returned without a panic.

Events are NEP-297 `EVENT_JSON:` logs with `standard: "lumenia_drop"`,
`version: "1.0.0"`, `data: [ {...} ]`:
`drop_created {public_key, funder, amount, expires_at_ns}`,
`drop_claimed {public_key, funder, amount, claimed_to, starter_yocto}`,
`drop_reclaimed {public_key, funder, amount}`, `paused {by}`, `unpaused {by}`,
`pool_topped_up {from, amount}`.

## The three flows

**Create.** The funder calls `USDC.ft_transfer_call`. The token moves the
USDC to this contract and calls `ft_on_transfer`, which checks: predecessor is
the token, amount >= `min_amount` (else returned), not paused, msg valid,
`60 <= expires_in_s <= max_expiry_s`, key(s) ed25519 and unused. It stores
each `Drop` (Open), appends its key to the ledger and the funder's index, and
schedules
`Promise::new(self).add_access_key_allowance(public_key, Allowance::limited(key_allowance), self, "claim,claim_to_new_account")`.
The record storage and the key storage are paid from the contract's own NEAR
balance, the sponsor pool: that is the product model, the sender pays
nothing on NEAR beyond the USDC (and the gas of their own transaction).

**Claim.** The recipient's browser signs a transaction *as the contract
account* with the link key. `claim` requires `predecessor == current account`
and looks the drop up by `env::signer_account_pk()`; the drop must be Open and
not expired; it becomes Claiming. Then, in one promise chain:

1. `Promise::new(account_id).transfer(starter)` where `starter` is
   `starter_yocto` for a 64-hex implicit destination and 0 for a named one.
   Tested in the sandbox (nearcore 2.14.0): a transfer to a missing implicit
   account **creates it** (NEP-448, even with 0 NEAR), is a plain transfer to
   an existing one, and fails for a named account that does not exist. The
   contract cannot see whether an implicit account already exists, so every
   implicit destination gets the starter; the per-claim pool bound below
   already counts it. The same step runs for named accounts on purpose: a
   failure reopens the drop instead of paying USDC to an account nobody
   controls.
2. `on_account_ready` (private callback): on failure, or when the root
   linkdrop answered `false`, status goes back to Open and the key stays, so
   the recipient can retry with another destination. On success it continues:
3. `USDC.storage_deposit({account_id, registration_only: true})` with
   `registration_deposit` attached (an already registered account gets it
   refunded by the token, which the tests confirm),
4. `USDC.ft_transfer({receiver_id, amount, memo})` with exactly 1 yocto,
5. `on_claim(public_key, account_id, starter_yocto)` (private callback):
   success -> Claimed, `claimed_to` set, `delete_key(public_key)`,
   `drop_claimed` event with the starter actually sent; failure -> Open again
   (the USDC never left), reason logged, no event.

`claim_to_new_account` replaces step 1 with
`root.create_account({new_account_id, new_public_key})` with `starter_yocto`
attached (25 Tgas floor): the linkdrop forwards the deposit into the new
account and refunds it to this contract when the name is taken (sandbox test
asserts the pool loses less than the starter in that case). It requires
`new_account_id` to be exactly one level below the configured root.

Gas is attached as static floors plus `GasWeight` so unused prepaid gas flows
down the chain; `claim` refuses to start with less than 60 Tgas and
`claim_to_new_account` with less than 90 Tgas, so the callbacks can never run
out of gas after a state change.

**Starter gas ceiling.** A fresh implicit account ends the claim with
exactly `starter_yocto` and the USDC. NEAR reserves a transaction's prepaid
gas up front at a pessimistically inflated price (the base gas price of 1e8
yocto per gas times 1.03 for every receipt hop the prepaid gas could in
principle create, `1.03^depth`), so the gas a transaction may attach is
bounded by the account balance, not by what the call burns. Measured in the
sandbox at the base gas price:

| Starter balance | Largest prepaid gas a transaction may attach |
|---|---|
| 0.01 NEAR (code default) | about 8 Tgas |
| 0.02 NEAR | about 15 Tgas |
| 0.05 NEAR (testnet live config) | about 40 Tgas |

Wallets attach 30 Tgas by default, which is why the testnet `starter_yocto`
is being set to 0.05 NEAR through `set_config` (code default unchanged). The
sandbox test sends the recipient's first `ft_transfer` with 5 Tgas: it
succeeds and the whole transaction burns 9.6 Tgas (about 0.001 NEAR), so a
starter pays for several such transfers. A client that controls its own gas
can attach 5 Tgas for an `ft_transfer` and work with either value.

**Reclaim.** The funder calls `reclaim(public_key)`: predecessor must be the
funder, the drop must be Open (or Claiming for more than 10 minutes, to recover
from a stuck callback) and `now >= expires_at_ns`. Status becomes Reclaimed,
`USDC.ft_transfer` sends the amount back with 1 yocto, and `on_reclaim`
deletes the key and emits `drop_reclaimed`; on transfer failure the status
returns to Open and the funder can try again.

## Security model and pool economics

- Funds are per drop. Every USDC amount in the contract belongs to exactly one
  `Drop` record and can only leave through that record's `claim` (to the
  destination chosen by whoever holds the link key) or `reclaim` (to the
  funder, after expiry).
- The owner can never move a drop. The owner methods are `pause`, `unpause`
  and `set_config`; none of them touches a record or a token balance.
- Pause never blocks `claim` or `reclaim`; it only stops `ft_on_transfer`,
  which is the one entry point that adds exposure (sandbox test
  `pause_blocks_new_drops_but_a_pending_claim_and_a_reclaim_still_work`).
- Link keys are function-call access keys of the contract account restricted
  to `claim` and `claim_to_new_account`, with a 1 NEAR gas allowance. A link
  key cannot attach a deposit, call anything else, or sign for another
  account. The three callbacks and `migrate` are `#[private]`.
- **Pool-drain bound.** Per drop the pool risks: record + key storage about
  0.004 NEAR (the key's share is released on delete, the record's is not) +
  USDC registration 0.00125 NEAR (unregistered recipients only) + starter
  `starter_yocto` (implicit or new named destinations) + gas about 0.0015
  NEAR (claim gas is drawn through the key allowance; each attempt also
  consumes up to 0.01 NEAR of that allowance, about a hundred attempts per
  key). Worst case per claim: about 0.017 NEAR with the 0.01 NEAR code
  default, so a 10 NEAR pool covers about 600 claims; about 0.057 NEAR with
  the 0.05 NEAR testnet value, so 10 NEAR covers about 170 claims. `get_stats`
  (`drops_created`, `pool_balance`) shows the burn in real time and `pause`
  stops new drops. `min_amount` (0.10 USDC) stops dust spam, but
  it is a speed bump, not a bound: a funder who claims their own drops gets
  the USDC back each cycle and extracts the starter, so the real bound is the
  pool balance and the pause switch.
- Anyone who sees a link can claim it: the fragment is the money, exactly as
  on Stellar. The fragment never reaches a server.
- Honest limit: the account's full-access key (the deploy key, held by the
  owner) can redeploy the contract code (it did, for `migrate`). "The owner
  can never move a drop" holds for this code, not against a redeploy. Locking
  the account or a multisig owner is a mainnet decision, not a hackathon one.
- Stuck-claim recovery: a drop that stays Claiming for 10 minutes may be
  reclaimed. The chain was designed so that `on_claim` cannot fail after the
  `ft_transfer` succeeded (its gas is a static floor, guaranteed by the
  60/90 Tgas guards before any state change), but if it ever did, a reclaim
  would move a second amount out of the shared pool of other drops. Watch
  `Claiming` drops older than 10 minutes in production.

## Measured gas (sandbox, nearcore 2.14.0, `total_gas_burnt` of the whole transaction)

| Transaction | Gas burnt | Attached by the caller |
|---|---|---|
| create one drop: `ft_transfer_call` -> `ft_on_transfer` -> key added | 7.5 Tgas | 100 Tgas (50 is enough) |
| create a batch of 3 | 10.0 Tgas | 100 Tgas |
| create a batch of 30 (the cap) | 43.2 Tgas whole tx, heaviest receipt (`ft_on_transfer`) 24.8 Tgas | 300 Tgas |
| `claim` to a registered existing account | 13.1 Tgas | 100 Tgas |
| `claim` to an unregistered existing account (pool pays registration) | 12.4 Tgas | 100 Tgas |
| `claim` to a fresh implicit account (hero path, starter included) | 20.5 Tgas | 100 Tgas |
| `claim_to_new_account` through the root linkdrop | 24.1 Tgas | 100 Tgas |
| `reclaim` | 7.4 Tgas | 100 Tgas (30 is enough) |
| the fresh recipient's first outgoing `ft_transfer` (paid by the starter) | 9.6 Tgas (5 Tgas attached) | 30 Tgas |

Everything fits the web client's 100 Tgas claim transaction with a wide
margin; a full batch needs the funder to attach 300 Tgas to `ft_transfer_call`.

## Tests

- 43 unit tests in `src/lib.rs` (msg parsing for both shapes, batch
  validation, implicit-account and sub-account checks, every guard of
  create/claim/reclaim/pause/config, the callbacks through mocked promise
  results, ledger paging, totals, `migrate` from a written V0 state).
- 21 sandbox tests in `tests/sandbox.rs` against a real nearcore
  sandbox, with the mock token `../test-usdc` (near-contract-standards
  FungibleToken, 6 decimals, 0.00125 NEAR registration) and the mock root
  linkdrop `../test-root` deployed on an account literally named `testnet`:
  create -> Open with the key present and restricted; claim to a registered
  account (no starter); claim to an unregistered account (registration paid by
  the pool, no starter); claim to a fresh implicit account (did not exist,
  exists afterwards with exactly the starter, holds the USDC, key deleted, then
  sends USDC on with 30 Tgas paid by the starter); claim with the contract's
  own full-access key and with a stranger key; claim after expiry; double
  claim; reclaim before expiry; reclaim after expiry (and by a stranger);
  pause (new drop refunded, pending claim and reclaim still work, unpause);
  non-owner pause/set_config; `ft_on_transfer` from a non-token predecessor;
  reused public key and invalid msg refunded; dust below `min_amount`
  returned without a panic or a record; named account through the root (taken
  name reopens and the starter comes back, deep name refused, happy path with
  the starter in the new account); missing named account reopens and a retry
  works; top_up and set_config of all fields; a 3-drop batch (3 Open drops,
  ledger newest first and paged, each claimed to a different kind of account,
  totals); a batch whose sum mismatches, refunded; a batch with one reused key,
  refunded entirely; a 30-drop batch in gas with 300 Tgas attached. Time
  passes with `sandbox.fast_forward`.

All green on 2026-11-11: `43 passed` and `21 passed`.

## Build, test, deploy (exactly as run)

```sh
# from contracts/lumen-drop-near (this crate's workspace root inside the Lumenia monorepo)
cargo test -p lumenia-drop --lib                        # unit tests
cargo test -p lumenia-drop --test sandbox               # sandbox tests (builds the 3 wasm files with cargo-near, downloads near-sandbox once)
cargo near build non-reproducible-wasm --manifest-path contract/Cargo.toml   # scripts/build.sh
scripts/deploy.sh          # FIRST deploy: near contract deploy <id> use-file <wasm> with-init-call new json-args '{...8 fields...}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send
scripts/migrate.sh         # RE-deploy over an existing state: same, with-init-call migrate json-args '{"starter_yocto":"10000000000000000000000","min_amount":"100000"}'
scripts/register-usdc.sh   # storage_deposit for the contract on USDC, 0.00125 NEAR (done once)
scripts/create-funder.sh   # faucet account lumenia-funder.testnet; then scripts/register-usdc.sh lumenia-funder.testnet (done once)
scripts/views.sh [public_key]
scripts/set-config.sh '{"starter_yocto":"50000000000000000000000"}'   # owner only; any subset of key_allowance, registration_deposit, max_expiry_s, starter_yocto, min_amount
scripts/create-drop.sh <amount> <ed25519:pk> [expires_in_s] [memo]   # one drop from the funder
scripts/create-batch.sh <total> '<batch msg json>'                   # up to 30 drops, 300 Tgas
scripts/claim.sh <account_id> <ed25519:pk> <ed25519:sk>              # claim as the contract with the link key
scripts/live-round.sh [amount]   # one real create -> claim-to-implicit-account round, once the funder holds USDC
```

From the monorepo root, `pnpm near:verify:offline --only contract` runs the same
`cargo test` and parses the two counts (`ops/near-verify.mjs`); CI runs `cargo test`
and `cargo clippy --all-targets -- -D warnings` for this crate in the `near` job of
`.github/workflows/ci.yml`, with cargo-near 0.23.0 pinned by sha256 because the
sandbox tests build the three wasm files through it.

Init args of the first deploy: `{"owner_id":"lumenia-near.testnet","token_id":"3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af","root_account_id":"testnet","key_allowance":"1000000000000000000000000","registration_deposit":"1250000000000000000000","max_expiry_s":604800}`;
migrate args of the second: `{"starter_yocto":"10000000000000000000000","min_amount":"100000"}`.
All scripts read `scripts/env.sh`; none contains a key. The deploy key is in
the near-cli-rs legacy keychain (`~/.near-credentials/testnet/`).

## What is not done

- No audit. Testnet only. Do not point it at mainnet USDC.
- Reproducible build not run: the wasm is a `non-reproducible-wasm` build.
  `[package.metadata.near.reproducible_build]` is in `Cargo.toml` so
  `cargo near build reproducible-wasm` can run inside the pinned Docker image
  later; set the real `repository` URL first (the three `Cargo.toml` files still
  name the standalone `mericcintosun/lumenia-near`; it is NEP-330 metadata baked
  into the wasm, so changing it changes the wasm hash recorded above).
- Named-account path: implemented and tested against a mock root in the
  sandbox; the real `testnet` root was verified to create a 0 NEAR account
  (probe tx above) but a full `claim_to_new_account` has not run on testnet.
  The web client prefers the implicit-account `claim` anyway.
- Drop storage is never refunded to the pool: records are kept so the views
  keep answering and keys cannot be reused. A `prune` of old Claimed or
  Reclaimed records would recover about 0.003 NEAR each.
- The ledger (`get_drops`, `get_drops_by_funder`, amount totals) covers drops
  created after the second deploy; the first deploy created none, so nothing
  is missing on testnet.
- The contract cannot tell a fresh implicit account from an existing one, so
  an existing implicit destination also receives the starter (bounded per
  claim as above).
- The starter is a balance, not a gas budget: with the 0.01 NEAR code
  default a recipient's transaction may attach at most about 8 Tgas; the
  testnet value is being set to 0.05 NEAR (about 40 Tgas) because wallets
  attach 30 Tgas by default. Read the live value with `get_config`.
- Single owner key, no ownership transfer method, no upgrade path beyond a
  redeploy by the full-access key.
- `new` takes `root_account_id`, `starter_yocto`, `min_amount` beyond the
  brief's five arguments; view timestamps are strings; `status_changed_at_ns`,
  the `on_account_ready` callback, `migrate`, the ledger views, the amount
  totals and the `pool_topped_up` event are additions; the batch msg shape is
  an addition and the single shape is unchanged.

## Layout

```text
contracts/lumen-drop-near/        (inside the Lumenia monorepo)
  Cargo.toml            workspace: contract, test-usdc, test-root
  rust-toolchain.toml   1.95.0 + wasm32-unknown-unknown
  contract/             this crate (lumenia-drop): src/lib.rs, tests/sandbox.rs, README.md
  test-usdc/            mock 6-decimal NEP-141 USDC for the sandbox tests
  test-root/            mock root linkdrop create_account for the sandbox tests
  scripts/              env.sh build.sh deploy.sh migrate.sh register-usdc.sh create-funder.sh views.sh set-config.sh create-drop.sh create-batch.sh claim.sh live-round.sh
                        (every script resolves its paths from env.sh, so they run from any directory; live-round.sh keeps its keys in scripts/.keys, gitignored)
  .gitignore            scripts/.keys and target
```
