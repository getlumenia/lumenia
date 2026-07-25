#![no_std]
//! # Lumenia LumenDrop — v2 Soroban escrow (late-bound payout + in-contract anti-drain)
//!
//! The v2 primitive that fuses the best of the Monad sibling (Damla) with Lumenia's own
//! strengths (see docs/V2_SOROBAN_ESCROW.md):
//!
//!   * **Late-bound payout.** A drop is keyed by the link's ephemeral Ed25519 *public key*
//!     (the secret private key lives only in the URL `#fragment`). The recipient picks the
//!     `payout` address AT CLAIM TIME; the link key signs it; the contract releases the USDC
//!     to exactly that address. There is NO pre-created recipient account, NO reserve to lock,
//!     and NO throwaway-account fragmentation — so the whole v1 sweep/consolidation machinery
//!     simply never exists here.
//!   * **In-contract anti-drain (no trusted relayer).** ANYONE (a gas-paying relayer) may submit the
//!     claim tx, but the funds can ONLY reach the payout the link key signed. The relayer can
//!     never steal or redirect a single stroop — enforced in auditable bytecode, not by an
//!     off-chain validator. The signature is bound to this contract + network (anti-replay).
//!   * **USDC, not a volatile native token.** The escrow holds a single pinned SAC token
//!     (USDC's Stellar Asset Contract), set at deploy time.
//!   * **Group drops.** One link, `slots` equal shares, first N distinct payouts each claim one
//!     — walletless + gasless, for tips/giveaways/splits. Leftover reclaimable after expiry.
//!
//! Non-custodial: the contract is the escrow; it only ever moves the exact stored amount to the
//! link-signed payout, or refunds the original sender after expiry. Checks-effects-interactions
//! throughout; Soroban's synchronous model rules out classic reentrancy.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contractmeta, contracttype, token,
    xdr::ToXdr, Address, Bytes, BytesN, Env,
};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_contract_utils::pausable::{self as pausable, Pausable};
use stellar_contract_utils::upgradeable::{self as upgradeable, Upgradeable};
use stellar_macros::{only_owner, when_not_paused};

// SEP-46 contract metadata; `binver` per SEP-49 so explorers can show the deployed version.
contractmeta!(key = "binver", val = "0.2.0");

/// Persistent-storage TTL bumps (~1 day threshold, ~30 days extend at 5s ledgers).
const TTL_THRESHOLD: u32 = 17_280;
const TTL_EXTEND: u32 = 518_400;

/// Upper bound on how far in the future a drop's `expiry` may sit (seconds). Keeps every
/// drop's whole life inside the ~30-day persistent-TTL window bumped at deposit, so a live
/// (claimable) drop can never hit archival before it is either claimed or reclaimable.
const MAX_EXPIRY_HORIZON: u64 = 30 * 24 * 60 * 60;

/// Domain-separation tags folded into the signed message so a signature for one drop kind
/// can never be replayed against the other.
const TAG_SINGLE: u8 = 0x01;
const TAG_GROUP: u8 = 0x02;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    AlreadyExists = 1,
    NothingHere = 2,
    AlreadyClaimed = 3,
    NotExpired = 4,
    NotSender = 5,
    BadInput = 6,
    DropEmpty = 7,
    AlreadyClaimedThis = 8,
    Expired = 9,
    Overflow = 10,
    NotInitialized = 11,
    BadExpiry = 12,
}

#[contracttype]
#[derive(Clone)]
pub struct Drop {
    pub sender: Address,
    pub amount: i128,
    pub expiry: u64,
    pub claimed: bool,
}

#[contracttype]
#[derive(Clone)]
pub struct Pool {
    pub sender: Address,
    pub amount_per: i128,
    pub remaining: i128,
    pub slots: u32,
    pub claimed: u32,
    pub expiry: u64,
}

/// VERSIONED storage envelopes (OZ "plan-ahead" migration pattern, SEP-0049). Escrow records
/// outlive contract upgrades, and a bare struct layout cannot be changed later without the host
/// trapping on deserialization of pre-upgrade entries. Wrapping every stored record in a
/// single-variant enum from day one lets a future upgrade ADD a `V2(...)` variant and read both —
/// this cannot be retrofitted safely once real deposits exist.
#[contracttype]
#[derive(Clone)]
pub enum DropEntry {
    V1(Drop),
}

#[contracttype]
#[derive(Clone)]
pub enum PoolEntry {
    V1(Pool),
}

/* ------------------------------------- events -------------------------------------------
 * One event per state change (audit trail / repudiation resistance). Topic layout keeps the
 * pre-#[contractevent] shape: [fixed name, link], so the link stays the indexable key.
 * --------------------------------------------------------------------------------------- */

#[contractevent(topics = ["deposit"])]
#[derive(Clone)]
pub struct DepositEvent {
    #[topic]
    pub link: BytesN<32>,
    pub sender: Address,
    pub amount: i128,
    pub expiry: u64,
}

#[contractevent(topics = ["claim"])]
#[derive(Clone)]
pub struct ClaimEvent {
    #[topic]
    pub link: BytesN<32>,
    pub payout: Address,
    pub amount: i128,
}

#[contractevent(topics = ["reclaim"])]
#[derive(Clone)]
pub struct ReclaimEvent {
    #[topic]
    pub link: BytesN<32>,
    pub sender: Address,
    pub amount: i128,
}

#[contractevent(topics = ["newpool"])]
#[derive(Clone)]
pub struct NewPoolEvent {
    #[topic]
    pub link: BytesN<32>,
    pub sender: Address,
    pub amount: i128,
    pub slots: u32,
}

#[contractevent(topics = ["share"])]
#[derive(Clone)]
pub struct ShareEvent {
    #[topic]
    pub link: BytesN<32>,
    pub payout: Address,
    pub amount: i128,
    pub claimed: u32,
}

#[contractevent(topics = ["repool"])]
#[derive(Clone)]
pub struct RepoolEvent {
    #[topic]
    pub link: BytesN<32>,
    pub sender: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// The pinned USDC SAC token address.
    Token,
    /// A one-to-one drop, keyed by the link's Ed25519 public key.
    Drop(BytesN<32>),
    /// A group pool, keyed by the link's Ed25519 public key.
    Pool(BytesN<32>),
    /// Per-payout claim flag for a group pool (link, payout) → claimed.
    PoolClaimed(BytesN<32>, Address),
}

#[contract]
pub struct LumenDrop;

#[contractimpl]
impl LumenDrop {
    /// Deploy-time init: pin the ONE USDC SAC token this escrow escrows, and set the owner
    /// (the upgrade/pause authority — a timelock/multisig on mainnet; renounced to immutable
    /// after audit). The owner has NO path that moves escrowed funds (invariant 13).
    pub fn __constructor(env: Env, token: Address, owner: Address) {
        env.storage().instance().set(&DataKey::Token, &token);
        ownable::set_owner(&env, &owner);
        upgradeable::set_schema_version(&env, 1);
    }

    /* --------------------------- one-to-one link drop --------------------------- */

    /// Sender locks `amount` USDC for whoever holds the link secret for `link` (its Ed25519
    /// public key). `expiry` is a unix timestamp; after it, an unclaimed drop is reclaimable.
    ///
    /// Pause gates ONLY the two escrow-creating entrypoints (`deposit` + `create_drop`) —
    /// `claim`/`claim_share`/`reclaim`/`reclaim_pool` are NEVER pausable, so every escrowed
    /// dollar can always exit to its rightful owner in any state (invariant 14).
    #[when_not_paused]
    pub fn deposit(
        env: Env,
        from: Address,
        link: BytesN<32>,
        amount: i128,
        expiry: u64,
    ) -> Result<(), Error> {
        from.require_auth();
        if amount <= 0 {
            return Err(Error::BadInput);
        }
        Self::check_expiry(&env, expiry)?;
        let key = DataKey::Drop(link.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
        }
        // Pull the sender's USDC into the escrow (the sender authorized above).
        token::Client::new(&env, &Self::token(&env)?).transfer(
            &from,
            env.current_contract_address(),
            &amount,
        );
        env.storage().persistent().set(
            &key,
            &DropEntry::V1(Drop { sender: from.clone(), amount, expiry, claimed: false }),
        );
        env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        DepositEvent { link, sender: from, amount, expiry }.publish(&env);
        Ok(())
    }

    /// Claim a one-to-one drop to the chosen `payout`. Submittable by ANYONE (a relayer paying
    /// the fee): the funds go ONLY to `payout`, and only if the link key signed exactly this
    /// (contract, network, link, payout). No `require_auth` — the Ed25519 signature IS the
    /// authorization, which is what makes it walletless + gasless.
    pub fn claim(env: Env, link: BytesN<32>, payout: Address, sig: BytesN<64>) -> Result<(), Error> {
        let key = DataKey::Drop(link.clone());
        let DropEntry::V1(mut d) =
            env.storage().persistent().get(&key).ok_or(Error::NothingHere)?;
        if d.claimed {
            return Err(Error::AlreadyClaimed);
        }
        // In-contract anti-drain: the link key must have signed THIS payout. ed25519_verify
        // panics (traps the tx) if the signature is wrong — the relayer cannot redirect funds.
        let msg = Self::message(&env, TAG_SINGLE, &link, &payout);
        env.crypto().ed25519_verify(&link, &msg, &sig);

        d.claimed = true; // effects before interaction
        env.storage().persistent().set(&key, &DropEntry::V1(d.clone()));
        env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        token::Client::new(&env, &Self::token(&env)?).transfer(
            &env.current_contract_address(),
            &payout,
            &d.amount,
        );
        ClaimEvent { link, payout, amount: d.amount }.publish(&env);
        Ok(())
    }

    /// After expiry, the original sender reclaims an unclaimed drop (the 7-day safety net).
    pub fn reclaim(env: Env, link: BytesN<32>) -> Result<(), Error> {
        let key = DataKey::Drop(link.clone());
        let DropEntry::V1(mut d) =
            env.storage().persistent().get(&key).ok_or(Error::NothingHere)?;
        if d.claimed {
            return Err(Error::AlreadyClaimed);
        }
        if env.ledger().timestamp() < d.expiry {
            return Err(Error::NotExpired);
        }
        d.sender.require_auth();
        d.claimed = true;
        env.storage().persistent().set(&key, &DropEntry::V1(d.clone()));
        token::Client::new(&env, &Self::token(&env)?).transfer(
            &env.current_contract_address(),
            &d.sender,
            &d.amount,
        );
        ReclaimEvent { link, sender: d.sender, amount: d.amount }.publish(&env);
        Ok(())
    }

    pub fn get_drop(env: Env, link: BytesN<32>) -> Option<Drop> {
        env.storage()
            .persistent()
            .get(&DataKey::Drop(link))
            .map(|DropEntry::V1(d)| d)
    }

    /* ------------------------------- group drop -------------------------------- */

    /// Fund a pool of `slots` equal shares behind `link`. `amount` USDC is pulled from `from`;
    /// each of the first `slots` distinct payouts claims `amount / slots`. Pause-gated like
    /// `deposit` (new escrow only — exits are never pausable, invariant 14).
    #[when_not_paused]
    pub fn create_drop(
        env: Env,
        from: Address,
        link: BytesN<32>,
        amount: i128,
        slots: u32,
        expiry: u64,
    ) -> Result<(), Error> {
        from.require_auth();
        if amount <= 0 || slots == 0 || amount < slots as i128 {
            return Err(Error::BadInput);
        }
        Self::check_expiry(&env, expiry)?;
        let key = DataKey::Pool(link.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
        }
        // slots != 0 guarded above; checked form keeps the arithmetic explicit for the linters.
        let amount_per = amount.checked_div(slots as i128).ok_or(Error::Overflow)?;
        token::Client::new(&env, &Self::token(&env)?).transfer(
            &from,
            env.current_contract_address(),
            &amount,
        );
        env.storage().persistent().set(
            &key,
            &PoolEntry::V1(Pool {
                sender: from.clone(),
                amount_per,
                remaining: amount,
                slots,
                claimed: 0,
                expiry,
            }),
        );
        env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        NewPoolEvent { link, sender: from, amount, slots }.publish(&env);
        Ok(())
    }

    /// Claim one share of a group pool to `payout`. Submittable by anyone (relayer). Each
    /// distinct payout may claim at most once; funds go only to the link-signed payout.
    pub fn claim_share(
        env: Env,
        link: BytesN<32>,
        payout: Address,
        sig: BytesN<64>,
    ) -> Result<(), Error> {
        let key = DataKey::Pool(link.clone());
        let PoolEntry::V1(mut p) =
            env.storage().persistent().get(&key).ok_or(Error::NothingHere)?;
        // Claims are only valid BEFORE expiry; after it, ONLY reclaim_pool may move funds.
        // Without this gate, a sender could reclaim the pool AND then claim its shares out of
        // the contract's shared token balance — draining OTHER drops' escrow (double-spend).
        if env.ledger().timestamp() >= p.expiry {
            return Err(Error::Expired);
        }
        // Guard on `remaining` too, not just the slot counter. In every reachable state the two
        // conditions coincide (they move together in claim_share and reclaim_pool closes both at
        // once), so this arm is DELIBERATELY REDUNDANT defense-in-depth: if a future edit ever
        // lets the counter and the balance diverge, the pool still cannot over-draw its own
        // escrow. Mutation testing flags the `||` as equivalent for exactly this reason — that is
        // the intent, not a missing test.
        if p.claimed >= p.slots || p.remaining < p.amount_per {
            return Err(Error::DropEmpty);
        }
        let claimed_key = DataKey::PoolClaimed(link.clone(), payout.clone());
        if env.storage().persistent().has(&claimed_key) {
            return Err(Error::AlreadyClaimedThis);
        }
        let msg = Self::message(&env, TAG_GROUP, &link, &payout);
        env.crypto().ed25519_verify(&link, &msg, &sig);

        // Both guarded above (claimed < slots, remaining >= amount_per); checked forms make the
        // implicit safety explicit and revert (never wrap) if a future edit breaks a guard.
        p.claimed = p.claimed.checked_add(1).ok_or(Error::Overflow)?;
        p.remaining = p.remaining.checked_sub(p.amount_per).ok_or(Error::Overflow)?;
        env.storage().persistent().set(&claimed_key, &true);
        env.storage().persistent().extend_ttl(&claimed_key, TTL_THRESHOLD, TTL_EXTEND);
        env.storage().persistent().set(&key, &PoolEntry::V1(p.clone()));
        env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        token::Client::new(&env, &Self::token(&env)?).transfer(
            &env.current_contract_address(),
            &payout,
            &p.amount_per,
        );
        ShareEvent { link, payout, amount: p.amount_per, claimed: p.claimed }.publish(&env);
        Ok(())
    }

    /// After expiry, the sender reclaims any unclaimed shares (and dust) of a pool.
    pub fn reclaim_pool(env: Env, link: BytesN<32>) -> Result<(), Error> {
        let key = DataKey::Pool(link.clone());
        let PoolEntry::V1(mut p) =
            env.storage().persistent().get(&key).ok_or(Error::NothingHere)?;
        if env.ledger().timestamp() < p.expiry {
            return Err(Error::NotExpired);
        }
        p.sender.require_auth();
        let amount = p.remaining;
        if amount <= 0 {
            return Err(Error::DropEmpty);
        }
        p.remaining = 0;
        p.claimed = p.slots; // CLOSE the pool: after a reclaim no claim_share can ever pass its guard
        env.storage().persistent().set(&key, &PoolEntry::V1(p.clone()));
        token::Client::new(&env, &Self::token(&env)?).transfer(
            &env.current_contract_address(),
            &p.sender,
            &amount,
        );
        RepoolEvent { link, sender: p.sender, amount }.publish(&env);
        Ok(())
    }

    pub fn get_pool(env: Env, link: BytesN<32>) -> Option<Pool> {
        env.storage()
            .persistent()
            .get(&DataKey::Pool(link))
            .map(|PoolEntry::V1(p)| p)
    }

    /* --------------------------------- helpers --------------------------------- */

    /// The EXACT bytes the link key must sign for a claim. Exposed as a view so the client can
    /// build the identical message (or simulate this) — signature parity is critical. Layout:
    ///   tag(1) ++ network_id(32) ++ contract_address_xdr ++ link_pubkey(32) ++ payout_xdr
    /// Binding contract + network blocks cross-contract / cross-network replay.
    pub fn claim_message(env: Env, kind: u32, link: BytesN<32>, payout: Address) -> Bytes {
        let tag = if kind == 2 { TAG_GROUP } else { TAG_SINGLE };
        Self::message(&env, tag, &link, &payout)
    }

    fn message(env: &Env, tag: u8, link: &BytesN<32>, payout: &Address) -> Bytes {
        let mut m = Bytes::new(env);
        m.push_back(tag);
        m.append(&Bytes::from_array(env, &env.ledger().network_id().to_array()));
        m.append(&env.current_contract_address().to_xdr(env));
        m.append(&Bytes::from_array(env, &link.to_array()));
        m.append(&payout.clone().to_xdr(env));
        m
    }

    /// `expiry` must sit in `(now, now + MAX_EXPIRY_HORIZON]` — a past expiry would make a drop
    /// reclaim-only on arrival, and an unbounded one would outlive the storage-TTL guarantee.
    fn check_expiry(env: &Env, expiry: u64) -> Result<(), Error> {
        let now = env.ledger().timestamp();
        if expiry <= now || expiry > now.saturating_add(MAX_EXPIRY_HORIZON) {
            return Err(Error::BadExpiry);
        }
        Ok(())
    }

    fn token(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::NotInitialized)
    }
}

/* ------------------------- governance: the upgrade/pause safety net -------------------------
 * Posture: upgradeable-with-safety-net NOW → renounce-to-immutable AFTER the professional audit
 * (SEP-49 + the OZ-endorsed sequence). Hard properties:
 *   invariant 13 — the owner has NO entrypoint that can move escrowed funds: the ONLY
 *     `token.transfer` sites are `claim`/`claim_share` (link-signature-gated) and
 *     `reclaim`/`reclaim_pool` (sender-auth-gated). The owner surface is upgrade/pause/renounce.
 *   invariant 14 — pause gates ONLY `deposit`/`create_drop`; every exit stays callable, so no
 *     reachable state can trap escrowed funds.
 * Owner on mainnet = a timelock + multisig (delay ≥ the drop lifetime so in-flight drops can
 *   always be claimed/reclaimed under the code they were created on before new code activates).
 * Renounce = a final upgrade to a wasm with the upgrade entrypoint REMOVED (bytecode-level
 *   immutability), not a dead admin address. `Ownable::renounce_ownership` additionally lets the
 *   owner permanently lock all #[only_owner] surfaces ahead of that.
 * ------------------------------------------------------------------------------------------ */

#[contractimpl]
impl Upgradeable for LumenDrop {
    /// Swap the contract's wasm (storage is preserved; `DropEntry`/`PoolEntry` versioned enums
    /// guarantee old records stay readable). Owner-gated; on mainnet the owner is a
    /// timelock+multisig, and this entrypoint is deleted entirely in the post-audit
    /// immutability upgrade.
    #[only_owner]
    fn upgrade(e: &Env, new_wasm_hash: BytesN<32>, _operator: Address) {
        upgradeable::upgrade(e, &new_wasm_hash);
    }
}

#[contractimpl]
impl Pausable for LumenDrop {
    fn paused(e: &Env) -> bool {
        pausable::paused(e)
    }

    /// Emergency brake: stops NEW escrow only (deposit/create_drop). Exits never pause.
    #[only_owner]
    fn pause(e: &Env, _caller: Address) {
        pausable::pause(e);
    }

    #[only_owner]
    fn unpause(e: &Env, _caller: Address) {
        pausable::unpause(e);
    }
}

/// Two-step ownership transfer + renounce, straight from OZ (spelled out because
/// `#[contractimpl]` only exports methods physically present in the impl block).
#[contractimpl]
impl Ownable for LumenDrop {
    fn get_owner(e: &Env) -> Option<Address> {
        ownable::get_owner(e)
    }

    fn transfer_ownership(e: &Env, new_owner: Address, live_until_ledger: u32) {
        ownable::transfer_ownership(e, &new_owner, live_until_ledger);
    }

    fn accept_ownership(e: &Env) {
        ownable::accept_ownership(e);
    }

    fn renounce_ownership(e: &Env) {
        ownable::renounce_ownership(e);
    }
}

#[cfg(test)]
mod test;
