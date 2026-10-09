#![no_std]
//! # LumenDropCommit - a TESTNET SPIKE, never for mainnet
//!
//! LumenDrop's one-to-one link drop (contracts/lumen-drop: late-bound payout, in-contract
//! anti-drain, sender reclaim after expiry) with ONE addition: the drop record carries a sha256
//! COMMITMENT to (link, amount, salt), and a claim must reveal an (amount, salt) that opens it.
//! The link key's signature binds the payout AND that reveal. Group pools are out of scope.
//!
//! What this does NOT do is hide the amount. `deposit` still moves it through a public SAC
//! `transfer`, so it stays in the invocation arguments, the sender's auth entry and the token's
//! own transfer event, and the record stores it again as `escrowed`. Only `DepositEvent` leaves
//! it out, which on its own hides nothing. See README.md.
//!
//! The solvency rule, i.e. why `escrowed` sits next to the commitment: every drop shares ONE
//! pooled SAC balance. If the reveal decided the payout, a sender could deposit 1, commit to 5,
//! claim to themselves and walk off with 4 of other people's escrow (LumenDrop invariants 1 and
//! 10). The contract cannot check a commitment at deposit time without the salt, so it pays only
//! the stored `escrowed`, and a reveal that opens the commitment but promises another amount is
//! refused (`RevealMismatch`): such a drop can only go back to its own sender after expiry.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contractmeta, contracttype, token,
    xdr::ToXdr, Address, Bytes, BytesN, Env,
};
use stellar_access::ownable::{self as ownable, Ownable};
use stellar_contract_utils::pausable::{self as pausable, Pausable};
use stellar_contract_utils::upgradeable::{self as upgradeable, Upgradeable};
use stellar_macros::{only_owner, when_not_paused};

// SEP-46 contract metadata; `binver` per SEP-49 so explorers can show the deployed version.
contractmeta!(key = "binver", val = "0.1.0");

/// Persistent-storage TTL bumps (~1 day threshold, ~30 days extend at 5s ledgers).
const TTL_THRESHOLD: u32 = 17_280;
const TTL_EXTEND: u32 = 518_400;

/// Upper bound on how far in the future a drop's `expiry` may sit (seconds). Not an archival
/// guarantee: the bump at deposit fires only below TTL_THRESHOLD, so a new record lives the
/// network minimum (testnet ~7 days, mainnet ~120) and can archive while claimable (README).
const MAX_EXPIRY_HORIZON: u64 = 30 * 24 * 60 * 60;

/// Domain-separation tags. They continue LumenDrop's (0x01 single claim, 0x02 group claim), so a
/// commitment preimage (0x03) and this contract's claim message (0x04) can never be mistaken for
/// each other or for any byte string a LumenDrop link key signs.
const TAG_COMMIT: u8 = 0x03;
const TAG_CLAIM: u8 = 0x04;

/// Every LumenDrop code keeps its number, so anything that already decodes LumenDrop's numbers
/// never misreads this contract. Codes 5 and 7-10 are never returned here (`NotSender` is unused
/// in LumenDrop too, the rest are group-only); the two reveal failures are new.
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
    /// The revealed (amount, salt) does not open the stored commitment for this link.
    BadReveal = 13,
    /// The reveal opens the commitment, but the amount it promises is not what the deposit
    /// escrowed (the sender committed to one amount and deposited another).
    RevealMismatch = 14,
}

#[contracttype]
#[derive(Clone)]
pub struct Drop {
    pub sender: Address,
    /// sha256(0x03 || link || amount_be16 || salt), computed by the sender's client.
    pub commitment: BytesN<32>,
    /// What `deposit` actually pulled in, and the ONLY amount a claim or a reclaim ever pays.
    pub escrowed: i128,
    pub expiry: u64,
    pub claimed: bool,
}

/// VERSIONED storage envelope, as in LumenDrop: a bare struct layout cannot change once records
/// exist without the host trapping on the old ones, so the record is wrapped in a single-variant
/// enum from day one and a later upgrade can add `V2(...)` and read both.
#[contracttype]
#[derive(Clone)]
pub enum DropEntry {
    V1(Drop),
}

/* ------------------------------------- events -------------------------------------------
 * One event per state change. Topic layout as in LumenDrop: [fixed name, link], so the link
 * stays the indexable key.
 * --------------------------------------------------------------------------------------- */

/// Carries the commitment and NO amount. That alone hides nothing: the SAC `transfer` event of
/// the same invocation still carries the amount (the tests assert both halves).
#[contractevent(topics = ["deposit"])]
#[derive(Clone)]
pub struct DepositEvent {
    #[topic]
    pub link: BytesN<32>,
    pub sender: Address,
    pub commitment: BytesN<32>,
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

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// The pinned SAC token address.
    Token,
    /// A one-to-one drop, keyed by the link's Ed25519 public key.
    Drop(BytesN<32>),
}

#[contract]
pub struct LumenDropCommit;

#[contractimpl]
impl LumenDropCommit {
    /// Deploy-time init: pin the ONE SAC token this escrow holds and set the owner (the
    /// upgrade/pause authority). The owner has NO path that moves escrowed funds (invariant 13).
    pub fn __constructor(env: Env, token: Address, owner: Address) {
        env.storage().instance().set(&DataKey::Token, &token);
        ownable::set_owner(&env, &owner);
        upgradeable::set_schema_version(&env, 1);
    }

    /// Sender locks `amount` behind `link` (the link's Ed25519 public key) together with a
    /// `commitment` to it. The contract cannot check the commitment here (it never sees the salt
    /// before a claim), so it records what it actually received as `escrowed` and pays only that.
    ///
    /// Pause gates ONLY this entrypoint: `claim`/`reclaim` are NEVER pausable, so every escrowed
    /// unit can always exit to its rightful owner in any state (invariant 14).
    #[when_not_paused]
    pub fn deposit(
        env: Env,
        from: Address,
        link: BytesN<32>,
        commitment: BytesN<32>,
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
        // Pull the sender's tokens into the escrow (the sender authorized above). This transfer is
        // public whatever the record holds: its arguments, the sender's auth entry and the SAC's
        // own event all carry `amount`.
        token::Client::new(&env, &Self::token(&env)?).transfer(
            &from,
            env.current_contract_address(),
            &amount,
        );
        env.storage().persistent().set(
            &key,
            &DropEntry::V1(Drop {
                sender: from.clone(),
                commitment: commitment.clone(),
                escrowed: amount,
                expiry,
                claimed: false,
            }),
        );
        env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        DepositEvent { link, sender: from, commitment, expiry }.publish(&env);
        Ok(())
    }

    /// Claim the drop to the chosen `payout` by revealing the committed `(amount, salt)`.
    /// Submittable by ANYONE (a relayer paying the fee): the funds go ONLY to `payout`, and only
    /// if the link key signed exactly this (contract, network, link, payout, amount, salt). No
    /// `require_auth`: the Ed25519 signature IS the authorization, as in LumenDrop.
    ///
    /// Check order: the record exists, it is unclaimed, the reveal opens the commitment, the
    /// revealed amount is the escrowed one, the signature verifies. Then effects, then the
    /// transfer of `escrowed`.
    pub fn claim(
        env: Env,
        link: BytesN<32>,
        payout: Address,
        sig: BytesN<64>,
        amount: i128,
        salt: BytesN<32>,
    ) -> Result<(), Error> {
        let key = DataKey::Drop(link.clone());
        let DropEntry::V1(mut d) =
            env.storage().persistent().get(&key).ok_or(Error::NothingHere)?;
        if d.claimed {
            return Err(Error::AlreadyClaimed);
        }
        if Self::commit(&env, &link, amount, &salt) != d.commitment {
            return Err(Error::BadReveal);
        }
        // The solvency rule: an opened commitment is a PROMISE, the escrow is what exists. A drop
        // whose sender committed to another amount than they deposited is unclaimable, and paying
        // the revealed amount would take the difference out of OTHER drops' escrow.
        if amount != d.escrowed {
            return Err(Error::RevealMismatch);
        }
        // In-contract anti-drain: the link key must have signed THIS payout and THIS reveal.
        // ed25519_verify traps the tx on a bad signature, so a relayer can neither redirect the
        // funds nor pair the signature with another reveal.
        let msg = Self::message(&env, &link, &payout, amount, &salt);
        env.crypto().ed25519_verify(&link, &msg, &sig);

        d.claimed = true; // effects before interaction
        env.storage().persistent().set(&key, &DropEntry::V1(d.clone()));
        env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        token::Client::new(&env, &Self::token(&env)?).transfer(
            &env.current_contract_address(),
            &payout,
            &d.escrowed,
        );
        ClaimEvent { link, payout, amount: d.escrowed }.publish(&env);
        Ok(())
    }

    /// After expiry, the original sender reclaims an unclaimed drop: exactly `escrowed`, whatever
    /// the commitment says. It is also the only exit for a drop whose commitment never matched.
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
            &d.escrowed,
        );
        ReclaimEvent { link, sender: d.sender, amount: d.escrowed }.publish(&env);
        Ok(())
    }

    pub fn get_drop(env: Env, link: BytesN<32>) -> Option<Drop> {
        env.storage()
            .persistent()
            .get(&DataKey::Drop(link))
            .map(|DropEntry::V1(d)| d)
    }

    /* --------------------------------- helpers --------------------------------- */

    /// The commitment a sender's client stores for `(link, amount, salt)`. A pure view, so a
    /// client can check its own hashing against the contract's (parity). The 81-byte preimage:
    ///   0x03(1) ++ link(32) ++ amount as i128 big-endian two's complement(16) ++ salt(32)
    /// The link is part of it, so a commitment cannot be moved to another drop.
    pub fn commitment_of(env: Env, link: BytesN<32>, amount: i128, salt: BytesN<32>) -> BytesN<32> {
        Self::commit(&env, &link, amount, &salt)
    }

    /// The EXACT bytes the link key must sign for a claim (a view, for signing parity). Layout:
    ///   0x04(1) ++ network_id(32) ++ contract_address_xdr ++ link(32) ++ payout_xdr
    ///     ++ amount_be16(16) ++ salt(32)
    /// Contract + network block cross-deployment replay, the payout blocks redirection, and the
    /// reveal blocks pairing the signature with any other (amount, salt).
    pub fn claim_message(
        env: Env,
        link: BytesN<32>,
        payout: Address,
        amount: i128,
        salt: BytesN<32>,
    ) -> Bytes {
        Self::message(&env, &link, &payout, amount, &salt)
    }

    fn commit(env: &Env, link: &BytesN<32>, amount: i128, salt: &BytesN<32>) -> BytesN<32> {
        let mut pre = Bytes::new(env);
        pre.push_back(TAG_COMMIT);
        pre.append(&Bytes::from_array(env, &link.to_array()));
        pre.append(&Bytes::from_array(env, &amount.to_be_bytes()));
        pre.append(&Bytes::from_array(env, &salt.to_array()));
        env.crypto().sha256(&pre).to_bytes()
    }

    fn message(
        env: &Env,
        link: &BytesN<32>,
        payout: &Address,
        amount: i128,
        salt: &BytesN<32>,
    ) -> Bytes {
        let mut m = Bytes::new(env);
        m.push_back(TAG_CLAIM);
        m.append(&Bytes::from_array(env, &env.ledger().network_id().to_array()));
        m.append(&env.current_contract_address().to_xdr(env));
        m.append(&Bytes::from_array(env, &link.to_array()));
        m.append(&payout.clone().to_xdr(env));
        m.append(&Bytes::from_array(env, &amount.to_be_bytes()));
        m.append(&Bytes::from_array(env, &salt.to_array()));
        m
    }

    /// `expiry` must sit in `(now, now + MAX_EXPIRY_HORIZON]`: a past expiry would make a drop
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

/* ------------------------- governance: the same safety net as LumenDrop -------------------------
 * Identical to contracts/lumen-drop, so the spike has the same deployment shape:
 *   invariant 13 - the owner has NO entrypoint that can move escrowed funds: the ONLY
 *     `token.transfer` sites out of the contract are `claim` (reveal- and link-signature-gated)
 *     and `reclaim` (sender-auth-gated). That holds for THIS bytecode; `upgrade` installs other
 *     bytecode, which is why it sits outside the invariant.
 *   invariant 14 - pause gates ONLY `deposit`; both exits stay callable, so no reachable state
 *     can trap escrowed funds.
 * This crate is a testnet spike and is never deployed to mainnet (README.md).
 * ------------------------------------------------------------------------------------------ */

#[contractimpl]
impl Upgradeable for LumenDropCommit {
    /// Swap the contract's wasm (storage is preserved; the `DropEntry` versioned enum keeps old
    /// records readable). Owner-gated.
    #[only_owner]
    fn upgrade(e: &Env, new_wasm_hash: BytesN<32>, _operator: Address) {
        upgradeable::upgrade(e, &new_wasm_hash);
    }
}

#[contractimpl]
impl Pausable for LumenDropCommit {
    fn paused(e: &Env) -> bool {
        pausable::paused(e)
    }

    /// Emergency brake: stops NEW escrow only (deposit). Exits never pause.
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
impl Ownable for LumenDropCommit {
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
