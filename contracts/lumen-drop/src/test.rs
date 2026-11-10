#![cfg(test)]
// Tests may unwrap/index freely - the strict lints (unwrap_used, arithmetic_side_effects)
// gate the CONTRACT code; a panicking test is a failing test, which is exactly what we want.
#![allow(clippy::unwrap_used, clippy::arithmetic_side_effects)]
extern crate std;

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, EnvTestConfig, Events as _, Ledger as _};
use soroban_sdk::xdr::{
    ContractDataDurability, ContractExecutable, LedgerEntryData, LedgerKey, Limits, ScAddress,
    ScContractInstance, ScEnvMetaEntry, ScEnvMetaEntryInterfaceVersion, ScErrorType, ScVal,
    WriteXdr,
};
use soroban_sdk::{map, token, vec, Address, Bytes, BytesN, Env, IntoVal, Map, Symbol, Val};

/// A deterministic Ed25519 link key (no rng needed) from a one-byte seed.
fn link_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}
fn link_pub(env: &Env, sk: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &sk.verifying_key().to_bytes())
}
/// Sign the EXACT message the contract will rebuild (parity is the whole point).
fn sign(env: &Env, sk: &SigningKey, msg: &Bytes) -> BytesN<64> {
    let bytes: std::vec::Vec<u8> = msg.iter().collect();
    BytesN::from_array(env, &sk.sign(&bytes).to_bytes())
}

struct Fixture<'a> {
    env: Env,
    /// The deployed contract's address (used by property tests to read the escrow balance).
    id: Address,
    /// The governance owner (upgrade/pause authority) set at construction.
    owner: Address,
    client: LumenDropClient<'a>,
    token: token::Client<'a>,
    sac: token::StellarAssetClient<'a>,
}

fn setup<'a>() -> Fixture<'a> {
    setup_in(Env::default())
}

/// The same fixture on an Env that writes no snapshot file at drop: for the property tests whose
/// dozens of cases would otherwise litter `test_snapshots/` (the repo's .gitignore excludes the
/// older property tests' per-case snapshots by name; these never write one).
fn setup_quiet<'a>() -> Fixture<'a> {
    setup_in(Env::new_with_config(EnvTestConfig { capture_snapshot_at_drop: false }))
}

fn setup_in<'a>(env: Env) -> Fixture<'a> {
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let token_addr = sac.address();
    let id = env.register(LumenDrop, (token_addr.clone(), owner.clone()));
    Fixture {
        client: LumenDropClient::new(&env, &id),
        token: token::Client::new(&env, &token_addr),
        sac: token::StellarAssetClient::new(&env, &token_addr),
        id,
        owner,
        env,
    }
}

fn funded_sender(f: &Fixture, amount: i128) -> Address {
    let s = Address::generate(&f.env);
    f.sac.mint(&s, &amount);
    s
}

/* --------------------------------- one-to-one -------------------------------- */

#[test]
fn deposit_then_claim_to_late_bound_payout() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(7);
    let link = link_pub(&f.env, &sk);

    f.client.deposit(&sender, &link, &50, &2000);
    assert_eq!(f.token.balance(&sender), 50);

    // payout chosen AT CLAIM TIME (late binding) - no pre-created account.
    let payout = Address::generate(&f.env);
    let msg = f.client.claim_message(&1, &link, &payout);
    let sig = sign(&f.env, &sk, &msg);

    f.client.claim(&link, &payout, &sig);
    assert_eq!(f.token.balance(&payout), 50);
    assert!(f.client.get_drop(&link).unwrap().claimed);

    // second claim is rejected.
    assert!(f.client.try_claim(&link, &payout, &sig).is_err());
}

#[test]
fn relayer_cannot_redirect_funds() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(9);
    let link = link_pub(&f.env, &sk);
    f.client.deposit(&sender, &link, &40, &2000);

    let payout_a = Address::generate(&f.env);
    let attacker = Address::generate(&f.env);
    // The link key signs for payout_a only.
    let sig_a = sign(&f.env, &sk, &f.client.claim_message(&1, &link, &payout_a));

    // A malicious relayer tries to claim to `attacker` with A's signature -> trap.
    assert!(f.client.try_claim(&link, &attacker, &sig_a).is_err());
    assert_eq!(f.token.balance(&attacker), 0);

    // The legitimate payout still works and funds are intact.
    f.client.claim(&link, &payout_a, &sig_a);
    assert_eq!(f.token.balance(&payout_a), 40);
    assert_eq!(f.token.balance(&attacker), 0);
}

#[test]
fn wrong_link_key_is_rejected() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let real = link_key(1);
    let link = link_pub(&f.env, &real);
    f.client.deposit(&sender, &link, &10, &2000);

    let payout = Address::generate(&f.env);
    // A different key signs the correct message -> verification fails.
    let forger = link_key(2);
    let sig = sign(&f.env, &forger, &f.client.claim_message(&1, &link, &payout));
    assert!(f.client.try_claim(&link, &payout, &sig).is_err());
    assert_eq!(f.token.balance(&payout), 0);
}

#[test]
fn reclaim_after_expiry_only_by_sender() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(3);
    let link = link_pub(&f.env, &sk);
    f.client.deposit(&sender, &link, &60, &2000);

    f.env.ledger().set_timestamp(1000);
    assert!(f.client.try_reclaim(&link).is_err()); // NotExpired

    f.env.ledger().set_timestamp(2500);
    f.client.reclaim(&link);
    assert_eq!(f.token.balance(&sender), 100); // refunded in full
    assert!(f.client.get_drop(&link).unwrap().claimed);
}

#[test]
fn duplicate_deposit_and_bad_amount_rejected() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(4);
    let link = link_pub(&f.env, &sk);

    assert_eq!(f.client.try_deposit(&sender, &link, &0, &2000), Err(Ok(Error::BadInput)));
    f.client.deposit(&sender, &link, &20, &2000);
    assert_eq!(f.client.try_deposit(&sender, &link, &20, &2000), Err(Ok(Error::AlreadyExists)));
}

/* ----------------------------------- group ---------------------------------- */

#[test]
fn group_drop_first_n_equal_shares() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(11);
    let link = link_pub(&f.env, &sk);
    f.client.create_drop(&sender, &link, &90, &3, &2000); // per = 30

    let mut payouts = std::vec::Vec::new();
    for _ in 0..3 {
        let p = Address::generate(&f.env);
        let sig = sign(&f.env, &sk, &f.client.claim_message(&2, &link, &p));
        f.client.claim_share(&link, &p, &sig);
        assert_eq!(f.token.balance(&p), 30);
        payouts.push(p);
    }
    let pool = f.client.get_pool(&link).unwrap();
    assert_eq!(pool.claimed, 3);
    assert_eq!(pool.remaining, 0);

    // pool is empty for a 4th distinct payout.
    let fourth = Address::generate(&f.env);
    let sig4 = sign(&f.env, &sk, &f.client.claim_message(&2, &link, &fourth));
    assert_eq!(f.client.try_claim_share(&link, &fourth, &sig4), Err(Ok(Error::DropEmpty)));

    // a payout that already claimed cannot double-claim.
    let sig_dupe = sign(&f.env, &sk, &f.client.claim_message(&2, &link, &payouts[0]));
    // (recreate a fresh pool to exercise AlreadyClaimedThis before DropEmpty)
    let sk2 = link_key(12);
    let link2 = link_pub(&f.env, &sk2);
    let sender2 = funded_sender(&f, 100);
    f.client.create_drop(&sender2, &link2, &90, &3, &2000);
    let p = Address::generate(&f.env);
    let sig = sign(&f.env, &sk2, &f.client.claim_message(&2, &link2, &p));
    f.client.claim_share(&link2, &p, &sig);
    assert_eq!(f.client.try_claim_share(&link2, &p, &sig), Err(Ok(Error::AlreadyClaimedThis)));
    let _ = sig_dupe;
}

#[test]
fn group_reclaim_leftover_after_expiry() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(13);
    let link = link_pub(&f.env, &sk);
    f.client.create_drop(&sender, &link, &90, &3, &2000); // 3 x 30

    let p = Address::generate(&f.env);
    let sig = sign(&f.env, &sk, &f.client.claim_message(&2, &link, &p));
    f.client.claim_share(&link, &p, &sig); // one share taken -> 60 left

    f.env.ledger().set_timestamp(2500);
    f.client.reclaim_pool(&link);
    // sender started 100, funded 90 into the pool (-90 -> 10), one share left (-30 to payout),
    // reclaims the remaining 60 -> 10 + 60 = 70.
    assert_eq!(f.token.balance(&sender), 70);
    assert_eq!(f.token.balance(&p), 30);
}

#[test]
fn group_signature_is_domain_separated_from_single() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(21);
    let link = link_pub(&f.env, &sk);
    f.client.create_drop(&sender, &link, &30, &1, &2000);

    let payout = Address::generate(&f.env);
    // A SINGLE-tag signature must NOT authorize a GROUP claim (different domain tag).
    let single_sig = sign(&f.env, &sk, &f.client.claim_message(&1, &link, &payout));
    assert!(f.client.try_claim_share(&link, &payout, &single_sig).is_err());
    // The correct group-tag signature works.
    let group_sig = sign(&f.env, &sk, &f.client.claim_message(&2, &link, &payout));
    f.client.claim_share(&link, &payout, &group_sig);
    assert_eq!(f.token.balance(&payout), 30);
}

#[test]
fn group_claim_blocked_after_expiry() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(30);
    let link = link_pub(&f.env, &sk);
    f.client.create_drop(&sender, &link, &90, &3, &2000);

    f.env.ledger().set_timestamp(2500); // past expiry -> only reclaim may move funds
    let payout = Address::generate(&f.env);
    let sig = sign(&f.env, &sk, &f.client.claim_message(&2, &link, &payout));
    assert_eq!(f.client.try_claim_share(&link, &payout, &sig), Err(Ok(Error::Expired)));
    assert_eq!(f.token.balance(&payout), 0);
}

/// REGRESSION (critical): a pool creator must NOT be able to reclaim the pool AND then claim its
/// shares out of the contract's SHARED token balance - which would drain OTHER drops' escrow.
#[test]
fn reclaimed_pool_cannot_drain_another_drops_escrow() {
    let f = setup();

    // A victim escrows 100 USDC as a normal one-to-one drop in the SAME contract.
    let victim = funded_sender(&f, 100);
    let vk = link_key(50);
    let vlink = link_pub(&f.env, &vk);
    f.client.deposit(&victim, &vlink, &100, &2000);

    // The attacker (who holds their own pool's link secret) escrows 100 as a 3-slot pool.
    let attacker = funded_sender(&f, 100);
    let ak = link_key(51);
    let alink = link_pub(&f.env, &ak);
    f.client.create_drop(&attacker, &alink, &100, &3, &2000);

    // Time passes; the attacker reclaims their pool (gets their own 100 back).
    f.env.ledger().set_timestamp(2500);
    f.client.reclaim_pool(&alink);
    assert_eq!(f.token.balance(&attacker), 100);

    // The exploit attempt: also claim shares of the now-reclaimed pool -> MUST fail (Expired +
    // the pool is closed). Nothing leaves the contract.
    let evil = Address::generate(&f.env);
    let sig = sign(&f.env, &ak, &f.client.claim_message(&2, &alink, &evil));
    assert_eq!(f.client.try_claim_share(&alink, &evil, &sig), Err(Ok(Error::Expired)));
    assert_eq!(f.token.balance(&evil), 0);

    // Proof the victim's escrow was never touched: their drop still pays out the full 100.
    let vpayout = Address::generate(&f.env);
    let vsig = sign(&f.env, &vk, &f.client.claim_message(&1, &vlink, &vpayout));
    f.client.claim(&vlink, &vpayout, &vsig);
    assert_eq!(f.token.balance(&vpayout), 100);
}

/* ---------------------------------------------------------------------------------------------
 * PROPERTY-BASED INVARIANTS (soroban skill, Part 2 "Property-Based Testing").
 * The reclaim-then-claim double-spend slipped past the example tests because they can't cover the
 * combinatorial space of pool lifecycles. proptest fuzzes random operation sequences and asserts
 * the safety INVARIANT directly - the class of bug, not a single instance.
 * ------------------------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------------------------
 * INVARIANT SUITE (pre-mainnet hardening pass). Each test maps to a numbered invariant of the
 * security spec:
 *   1 global solvency; 2 single-drop exactly-once; 3 payout integrity; 4 context binding ,
 *   5 reclaim gating (time + sender auth); 6 group per-payout uniqueness; 7 group slot bound ,
 *   8 pool conservation; 9 claim/reclaim mutual exclusion; 10 local => global non-over-draw ,
 *   11 input positivity + expiry bounds; 12 verify-or-revert atomicity.
 * 6/7/9 are covered by the group tests + the bystander property below; the tests in this section
 * add the missing invariants and the model-based master property (1 + 10).
 * ------------------------------------------------------------------------------------------- */

/* ------------------------- invariant 11: inputs + expiry bounds ------------------------ */

#[test]
fn expiry_bounds_enforced() {
    let f = setup();
    let sender = funded_sender(&f, 1000);
    let sk = link_key(60);
    let link = link_pub(&f.env, &sk);
    let now = 1_000_000u64;
    f.env.ledger().set_timestamp(now);
    // the horizon is the upgrade delay plus the clock grace (was 30 days before 0.3.0)
    const MAX: u64 = 7 * 24 * 60 * 60 + 60 * 60;

    // expiry in the past / exactly now -> rejected
    assert_eq!(f.client.try_deposit(&sender, &link, &10, &(now - 1)), Err(Ok(Error::BadExpiry)));
    assert_eq!(f.client.try_deposit(&sender, &link, &10, &now), Err(Ok(Error::BadExpiry)));
    // beyond the horizon -> rejected; exactly at it -> accepted; the old 30-day horizon is gone
    assert_eq!(
        f.client.try_deposit(&sender, &link, &10, &(now + MAX + 1)),
        Err(Ok(Error::BadExpiry))
    );
    assert_eq!(
        f.client.try_deposit(&sender, &link, &10, &(now + 30 * 24 * 60 * 60)),
        Err(Ok(Error::BadExpiry))
    );
    f.client.deposit(&sender, &link, &10, &(now + MAX));

    // the same bounds gate group creation
    let gk = link_key(61);
    let glink = link_pub(&f.env, &gk);
    assert_eq!(
        f.client.try_create_drop(&sender, &glink, &10, &2, &now),
        Err(Ok(Error::BadExpiry))
    );
    assert_eq!(
        f.client.try_create_drop(&sender, &glink, &10, &2, &(now + MAX + 1)),
        Err(Ok(Error::BadExpiry))
    );
    f.client.create_drop(&sender, &glink, &10, &2, &(now + 1));
}

#[test]
fn create_drop_bad_inputs_rejected() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(62);
    let link = link_pub(&f.env, &sk);
    assert_eq!(f.client.try_create_drop(&sender, &link, &0, &1, &2000), Err(Ok(Error::BadInput)));
    assert_eq!(f.client.try_create_drop(&sender, &link, &-5, &1, &2000), Err(Ok(Error::BadInput)));
    assert_eq!(f.client.try_create_drop(&sender, &link, &10, &0, &2000), Err(Ok(Error::BadInput)));
    assert_eq!(f.client.try_create_drop(&sender, &link, &2, &3, &2000), Err(Ok(Error::BadInput)));
}

/* --------------------- invariant 5: reclaim needs the SENDER's auth -------------------- */

#[test]
fn reclaim_rejected_without_sender_auth() {
    // The global fixture mocks ALL auths, which proves nothing about WHO must sign. Here the
    // mock is dropped after setup: with no auth available, reclaim must fail; restored, it
    // succeeds - i.e. `sender.require_auth()` is what gates the refund (same pattern for pools).
    let f = setup();
    let sender = funded_sender(&f, 200);
    let sk = link_key(63);
    let link = link_pub(&f.env, &sk);
    f.client.deposit(&sender, &link, &50, &2000);
    let pk = link_key(64);
    let plink = link_pub(&f.env, &pk);
    f.client.create_drop(&sender, &link_pub(&f.env, &pk), &60, &3, &2000);
    f.env.ledger().set_timestamp(2500);

    f.env.set_auths(&[]); // no authorizations available from here on
    assert!(f.client.try_reclaim(&link).is_err());
    assert!(f.client.try_reclaim_pool(&plink).is_err());
    assert_eq!(f.token.balance(&f.id), 110); // nothing left the escrow

    f.env.mock_all_auths();
    f.client.reclaim(&link);
    f.client.reclaim_pool(&plink);
    assert_eq!(f.token.balance(&sender), 200); // full refund, only with the sender's auth
}

/* ------------------- invariants 3 + 12: payout integrity + atomicity ------------------- */

#[test]
fn failed_claim_leaves_state_untouched() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(90);
    let link = link_pub(&f.env, &sk);
    f.client.deposit(&sender, &link, &70, &2000);

    let payout = Address::generate(&f.env);
    let forged = sign(&f.env, &link_key(91), &f.client.claim_message(&1, &link, &payout));
    assert!(f.client.try_claim(&link, &payout, &forged).is_err());
    // nothing moved, nothing flipped
    assert_eq!(f.token.balance(&f.id), 70);
    assert_eq!(f.token.balance(&payout), 0);
    assert!(!f.client.get_drop(&link).unwrap().claimed);
    // the real signature still redeems the full amount afterwards
    let sig = sign(&f.env, &sk, &f.client.claim_message(&1, &link, &payout));
    f.client.claim(&link, &payout, &sig);
    assert_eq!(f.token.balance(&payout), 70);
}

/* ------------------------ invariant 4: full-context sig binding ------------------------ */

#[test]
fn claim_message_layout_binds_full_context() {
    // Structural check of the signed message: tag ++ network_id ++ contract ++ link ++ payout.
    // Every component is present and any component change yields a different message.
    let f = setup();
    let sk = link_key(70);
    let link = link_pub(&f.env, &sk);
    let payout = Address::generate(&f.env);
    let m1: std::vec::Vec<u8> = f.client.claim_message(&1, &link, &payout).iter().collect();
    let m2: std::vec::Vec<u8> = f.client.claim_message(&2, &link, &payout).iter().collect();
    assert_eq!(m1[0], 0x01);
    assert_eq!(m2[0], 0x02); // tag differs single vs group
    let net = f.env.ledger().network_id().to_array();
    assert_eq!(&m1[1..33], &net[..]); // network id bound at bytes 1..33
    let m3: std::vec::Vec<u8> =
        f.client.claim_message(&1, &link, &Address::generate(&f.env)).iter().collect();
    assert_ne!(m1, m3); // payout bound
    let m4: std::vec::Vec<u8> =
        f.client.claim_message(&1, &link_pub(&f.env, &link_key(71)), &payout).iter().collect();
    assert_ne!(m1, m4); // link bound
}

#[test]
fn signature_for_one_contract_rejected_on_another() {
    // Two LumenDrop instances over the SAME token: a sig minted against instance A's message
    // must not release funds from instance B (contract-address binding = cross-contract replay).
    let f = setup();
    let id_b = f.env.register(LumenDrop, (f.token.address.clone(), f.owner.clone()));
    let client_b = LumenDropClient::new(&f.env, &id_b);

    let sender = funded_sender(&f, 200);
    let sk = link_key(72);
    let link = link_pub(&f.env, &sk);
    f.client.deposit(&sender, &link, &50, &2000);
    client_b.deposit(&sender, &link, &50, &2000);

    let payout = Address::generate(&f.env);
    let sig_a = sign(&f.env, &sk, &f.client.claim_message(&1, &link, &payout));
    assert!(client_b.try_claim(&link, &payout, &sig_a).is_err()); // replay on B trapped
    assert_eq!(f.token.balance(&payout), 0);
    f.client.claim(&link, &payout, &sig_a); // and works where it was minted
    assert_eq!(f.token.balance(&payout), 50);
}

/* --------------------- boundary conditions (mutation-testing gaps) --------------------- */

/// The expiry boundary is EXACT for both reclaim paths: at `timestamp == expiry` a reclaim is
/// already allowed (and a group claim is already refused). One second earlier, neither.
#[test]
fn expiry_boundary_is_exact() {
    let f = setup();
    let sender = funded_sender(&f, 300);
    let sk = link_key(64);
    let l = link_pub(&f.env, &sk);
    let pk = link_key(65);
    let pl = link_pub(&f.env, &pk);
    f.client.deposit(&sender, &l, &50, &2000);
    f.client.create_drop(&sender, &pl, &60, &2, &2000);

    f.env.ledger().set_timestamp(1999); // one second BEFORE expiry -> still locked
    assert_eq!(f.client.try_reclaim(&l), Err(Ok(Error::NotExpired)));
    assert_eq!(f.client.try_reclaim_pool(&pl), Err(Ok(Error::NotExpired)));

    f.env.ledger().set_timestamp(2000); // exactly AT expiry -> reclaimable, claims refused
    let p = Address::generate(&f.env);
    assert_eq!(
        f.client.try_claim_share(&pl, &p, &sign(&f.env, &pk, &f.client.claim_message(&2, &pl, &p))),
        Err(Ok(Error::Expired))
    );
    f.client.reclaim(&l);
    f.client.reclaim_pool(&pl);
    assert_eq!(f.token.balance(&sender), 300);
}

/// `amount == slots` (one stroop per share) is the smallest VALID pool; `amount == slots - 1`
/// is the largest invalid one.
#[test]
fn pool_amount_equals_slots_is_the_valid_boundary() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(66);
    let l = link_pub(&f.env, &sk);
    assert_eq!(f.client.try_create_drop(&sender, &l, &2, &3, &2000), Err(Ok(Error::BadInput)));
    f.client.create_drop(&sender, &l, &3, &3, &2000); // amount == slots is accepted
    let pool = f.client.get_pool(&l).unwrap();
    assert_eq!(pool.amount_per, 1);
    let p = Address::generate(&f.env);
    f.client.claim_share(&l, &p, &sign(&f.env, &sk, &f.client.claim_message(&2, &l, &p)));
    assert_eq!(f.token.balance(&p), 1);
}

/* ----------------- invariants 13 + 14: the governance safety net ----------------------- */

/// Invariant 14 - pause gates ONLY new escrow; every exit stays callable in the paused state,
/// so no reachable state can trap escrowed funds.
#[test]
fn pause_gates_only_new_escrow() {
    let f = setup();
    let sender = funded_sender(&f, 300);
    let sk1 = link_key(41);
    let l1 = link_pub(&f.env, &sk1);
    f.client.deposit(&sender, &l1, &50, &2000); // claimed while paused
    let sk2 = link_key(42);
    let l2 = link_pub(&f.env, &sk2);
    f.client.deposit(&sender, &l2, &40, &2000); // reclaimed while paused
    let sk3 = link_key(43);
    let l3 = link_pub(&f.env, &sk3);
    f.client.create_drop(&sender, &l3, &60, &2, &2000); // share-claim + repool while paused

    f.client.pause(&f.owner);
    assert!(f.client.paused());

    // new escrow is stopped...
    let sk4 = link_key(44);
    let l4 = link_pub(&f.env, &sk4);
    assert!(f.client.try_deposit(&sender, &l4, &10, &2000).is_err());
    assert!(f.client.try_create_drop(&sender, &l4, &10, &2, &2000).is_err());

    // ...but every exit still works
    let p = Address::generate(&f.env);
    f.client.claim(&l1, &p, &sign(&f.env, &sk1, &f.client.claim_message(&1, &l1, &p)));
    let p3 = Address::generate(&f.env);
    f.client.claim_share(&l3, &p3, &sign(&f.env, &sk3, &f.client.claim_message(&2, &l3, &p3)));
    f.env.ledger().set_timestamp(2500);
    f.client.reclaim(&l2);
    f.client.reclaim_pool(&l3);

    f.client.unpause(&f.owner);
    f.client.deposit(&sender, &l4, &10, &3500); // new escrow resumes after unpause
}

/// Invariant 13 - no owner action can move escrowed funds; and the owner surface itself is
/// auth-gated (a stranger can neither pause nor propose, cancel or execute an upgrade).
///
/// What this proves: pause/unpause leave the escrow balance untouched, an unauthorized caller
/// cannot reach the owner surface at all, and exits still work afterwards. What it CANNOT prove:
/// anything about a wasm a compromised owner might install - `upgrade` replaces the rules, so it
/// sits outside the invariant by construction (see the governance block in lib.rs).
#[test]
fn owner_surface_cannot_move_escrow_and_is_auth_gated() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(45);
    let l = link_pub(&f.env, &sk);
    f.client.deposit(&sender, &l, &100, &2000);
    let before = f.token.balance(&f.id);

    // with NO auth available, the whole owner surface is unusable
    f.env.set_auths(&[]);
    let some_hash = BytesN::from_array(&f.env, &[7u8; 32]);
    assert!(f.client.try_pause(&f.owner).is_err());
    assert!(f.client.try_propose_upgrade(&some_hash, &f.owner).is_err());
    assert!(f.client.try_cancel_upgrade(&f.owner).is_err());
    assert!(f.client.try_upgrade(&some_hash, &f.owner).is_err());

    // the full owner surface, exercised with auth, never touches the escrow balance
    f.env.mock_all_auths();
    f.client.pause(&f.owner);
    f.client.unpause(&f.owner);
    f.client.propose_upgrade(&some_hash, &f.owner);
    f.client.cancel_upgrade(&f.owner);
    assert_eq!(f.token.balance(&f.id), before);

    // escrow still exits normally afterwards
    let p = Address::generate(&f.env);
    f.client.claim(&l, &p, &sign(&f.env, &sk, &f.client.claim_message(&1, &l, &p)));
    assert_eq!(f.token.balance(&p), 100);
}

/// Renounce permanently locks the owner surface (the road to immutability): after
/// `renounce_ownership`, pause and the whole upgrade surface are dead - but escrow flows keep
/// working.
#[test]
fn renounce_locks_owner_surface_forever() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(46);
    let l = link_pub(&f.env, &sk);
    f.client.deposit(&sender, &l, &30, &2000);

    f.client.renounce_ownership();
    assert_eq!(f.client.get_owner(), None);
    let some_hash = BytesN::from_array(&f.env, &[7u8; 32]);
    assert!(f.client.try_pause(&f.owner).is_err());
    assert!(f.client.try_propose_upgrade(&some_hash, &f.owner).is_err());
    assert!(f.client.try_cancel_upgrade(&f.owner).is_err());
    assert!(f.client.try_upgrade(&some_hash, &f.owner).is_err());

    // escrow lifecycle is untouched by the renounce
    let p = Address::generate(&f.env);
    f.client.claim(&l, &p, &sign(&f.env, &sk, &f.client.claim_message(&1, &l, &p)));
    assert_eq!(f.token.balance(&p), 30);
    f.client.deposit(&sender, &l1_fresh(&f.env), &10, &2000);
}

/// Tiny helper for a fresh link key in the renounce test (keeps seeds unique).
fn l1_fresh(env: &Env) -> BytesN<32> {
    link_pub(env, &link_key(47))
}

/// The two-step ownership handover: `transfer_ownership` only PROPOSES (the old owner keeps
/// control), `accept_ownership` completes it, and only then does the new owner's authority
/// take effect. A one-step transfer to a wrong address is the mistake this design prevents.
#[test]
fn ownership_transfer_is_two_step() {
    let f = setup();
    let next = Address::generate(&f.env);
    assert_eq!(f.client.get_owner(), Some(f.owner.clone()));

    f.client.transfer_ownership(&next, &1000);
    assert_eq!(f.client.get_owner(), Some(f.owner.clone()), "proposal must not transfer");

    f.client.accept_ownership();
    assert_eq!(f.client.get_owner(), Some(next.clone()));

    // The new owner's authority is live: pause works and reads back through `paused()`.
    assert!(!f.client.paused());
    f.client.pause(&next);
    assert!(f.client.paused());
    f.client.unpause(&next);
    assert!(!f.client.paused());
}

/// `paused()` is a real read of contract state, not a constant: it tracks pause/unpause and
/// agrees with the behavior of the gated entrypoints.
#[test]
fn paused_view_tracks_state() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(48);
    let l = link_pub(&f.env, &sk);

    assert!(!f.client.paused());
    f.client.deposit(&sender, &l, &10, &2000); // works while unpaused

    f.client.pause(&f.owner);
    assert!(f.client.paused());
    assert!(f.client.try_deposit(&sender, &link_pub(&f.env, &link_key(49)), &10, &2000).is_err());

    f.client.unpause(&f.owner);
    assert!(!f.client.paused());
    f.client.deposit(&sender, &link_pub(&f.env, &link_key(49)), &10, &2000);
}

/// `upgrade` really reaches the host's wasm-swap (it is not a no-op): a proposal for a hash
/// that is not an uploaded wasm passes every timelock check once its delay is over and then
/// TRAPS in the host, which only happens if the swap is actually attempted - and the trap rolls
/// the whole call back, so the proposal is still pending afterwards and can be cancelled. The
/// positive case, a real swap into a different module, is `upgrade_at_not_before_swaps_the_wasm`.
#[test]
fn upgrade_reaches_the_host_wasm_swap() {
    let f = setup();
    f.env.ledger().set_timestamp(1_000);
    let unknown = BytesN::from_array(&f.env, &[0xABu8; 32]);
    f.client.propose_upgrade(&unknown, &f.owner);
    f.env.ledger().set_timestamp(1_000 + 7 * 24 * 60 * 60);
    let e = f.client.try_upgrade(&unknown, &f.owner).unwrap_err().unwrap();
    assert!(!e.is_type(ScErrorType::Contract), "must fail in the host swap, not on a timelock check: {e:?}");
    assert_eq!(f.client.pending_upgrade().unwrap().wasm_hash, unknown);
    f.client.cancel_upgrade(&f.owner);
    assert!(f.client.pending_upgrade().is_none());
}

/* ------------------ invariants 2, 3, 8 as properties (proptest) ------------------------ */

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// SINGLE-DROP EXACTLY-ONCE (invariant 2): across any interleaving of claim / reclaim
    /// attempts on both sides of the expiry, exactly ONE transfer of exactly `amount` ever
    /// leaves the escrow, and conservation holds after every step.
    #[test]
    fn single_drop_pays_exactly_once(
        amount in 1i128..=500,
        ops in proptest::collection::vec(0u8..=2, 1..10),
    ) {
        let f = setup();
        let sender = funded_sender(&f, amount);
        let sk = link_key(80);
        let link = link_pub(&f.env, &sk);
        f.client.deposit(&sender, &link, &amount, &2000);
        let payout = Address::generate(&f.env);
        let sig = sign(&f.env, &sk, &f.client.claim_message(&1, &link, &payout));

        for op in ops {
            match op {
                0 => { let _ = f.client.try_claim(&link, &payout, &sig); }
                1 => { let _ = f.client.try_reclaim(&link); }
                _ => f.env.ledger().set_timestamp(2500), // cross the expiry
            }
            let p = f.token.balance(&payout);
            let s = f.token.balance(&sender);
            let c = f.token.balance(&f.id);
            prop_assert_eq!(p + s + c, amount, "conservation broken");
            prop_assert!(p == 0 || p == amount, "partial payout impossible");
            prop_assert!(s == 0 || s == amount, "partial refund impossible");
            prop_assert!(!(p == amount && s == amount), "double spend");
        }
    }

    /// PAYOUT INTEGRITY (invariant 3): a signature minted for one payout can never pay any
    /// other address, for any link key.
    #[test]
    fn signature_never_pays_a_different_payout(seed in 1u8..=255) {
        let f = setup();
        let sender = funded_sender(&f, 100);
        let sk = link_key(seed);
        let link = link_pub(&f.env, &sk);
        f.client.deposit(&sender, &link, &40, &2000);
        let intended = Address::generate(&f.env);
        let other = Address::generate(&f.env);
        let sig = sign(&f.env, &sk, &f.client.claim_message(&1, &link, &intended));
        prop_assert!(f.client.try_claim(&link, &other, &sig).is_err());
        prop_assert_eq!(f.token.balance(&other), 0);
        f.client.claim(&link, &intended, &sig); // untouched drop still pays the intended payout
        prop_assert_eq!(f.token.balance(&intended), 40);
    }

    /// POOL CONSERVATION (invariants 7 + 8): after every state change,
    /// `remaining == amount - amount_per * claimed`, `remaining >= 0`, `claimed <= slots`.
    #[test]
    fn pool_conservation_holds(
        amount in 4i128..=1000,
        slots in 1u32..=6,
        claims in 0u32..=8,
    ) {
        prop_assume!(amount >= slots as i128);
        let f = setup();
        let sender = funded_sender(&f, amount);
        let sk = link_key(95);
        let link = link_pub(&f.env, &sk);
        f.client.create_drop(&sender, &link, &amount, &slots, &2000);
        let per = amount / slots as i128;
        for _ in 0..claims {
            let p = Address::generate(&f.env);
            let sig = sign(&f.env, &sk, &f.client.claim_message(&2, &link, &p));
            let _ = f.client.try_claim_share(&link, &p, &sig);
            let pool = f.client.get_pool(&link).unwrap();
            prop_assert!(pool.claimed <= pool.slots);
            prop_assert!(pool.remaining >= 0);
            prop_assert_eq!(pool.remaining, amount - per * (pool.claimed as i128));
        }
    }

    /// GLOBAL SOLVENCY, model-based (invariants 1 + 10 - the master property): over a mixed
    /// population of single drops and pools, under an arbitrary interleaving of claims,
    /// reclaims and an expiry crossing, the escrow's token balance EXACTLY equals
    /// sum of unclaimed single-drop amounts + sum of pool remainings - funds can neither leak out of
    /// nor be conjured into the shared escrow, and no object can over-draw its own share.
    #[test]
    fn global_solvency_exact_over_mixed_population(
        d_amounts in proptest::collection::vec(1i128..=300, 1..=3),
        p_amounts in proptest::collection::vec(4i128..=300, 1..=2),
        slots in 2u32..=4,
        ops in proptest::collection::vec((0u8..=4, 0usize..8), 0..=20),
    ) {
        let f = setup();
        // population: single drops - model state = (key, sender, amount, claimed)
        let mut singles: std::vec::Vec<(SigningKey, Address, i128, bool)> = std::vec::Vec::new();
        for (i, a) in d_amounts.iter().enumerate() {
            let s = funded_sender(&f, *a);
            let sk = link_key(100 + i as u8);
            f.client.deposit(&s, &link_pub(&f.env, &sk), a, &2000);
            singles.push((sk, s, *a, false));
        }
        // population: pools - model state = (key, amount_per, remaining)
        let mut pools: std::vec::Vec<(SigningKey, i128, i128)> = std::vec::Vec::new();
        for (i, a) in p_amounts.iter().enumerate() {
            let s = funded_sender(&f, *a);
            let sk = link_key(150 + i as u8);
            f.client.create_drop(&s, &link_pub(&f.env, &sk), a, &slots, &2000);
            pools.push((sk, *a / slots as i128, *a));
        }

        for (kind, idx) in ops {
            match kind {
                0 => { // claim a single drop
                    let i = idx % singles.len();
                    let link = link_pub(&f.env, &singles[i].0);
                    let p = Address::generate(&f.env);
                    let sig = sign(&f.env, &singles[i].0, &f.client.claim_message(&1, &link, &p));
                    if f.client.try_claim(&link, &p, &sig).is_ok() {
                        singles[i].3 = true;
                    }
                }
                1 => { // sender reclaims a single drop
                    let i = idx % singles.len();
                    let link = link_pub(&f.env, &singles[i].0);
                    if f.client.try_reclaim(&link).is_ok() {
                        singles[i].3 = true;
                    }
                }
                2 => { // claim one pool share to a fresh payout
                    let i = idx % pools.len();
                    let link = link_pub(&f.env, &pools[i].0);
                    let p = Address::generate(&f.env);
                    let sig = sign(&f.env, &pools[i].0, &f.client.claim_message(&2, &link, &p));
                    if f.client.try_claim_share(&link, &p, &sig).is_ok() {
                        pools[i].2 -= pools[i].1;
                        prop_assert!(pools[i].2 >= 0, "pool over-drew its own escrow");
                    }
                }
                3 => { // sender reclaims a pool
                    let i = idx % pools.len();
                    let link = link_pub(&f.env, &pools[i].0);
                    if f.client.try_reclaim_pool(&link).is_ok() {
                        pools[i].2 = 0;
                    }
                }
                _ => f.env.ledger().set_timestamp(2500), // cross every drop's expiry
            }
            let want: i128 = singles.iter().filter(|x| !x.3).map(|x| x.2).sum::<i128>()
                + pools.iter().map(|x| x.2).sum::<i128>();
            prop_assert_eq!(
                f.token.balance(&f.id), want,
                "escrow balance diverged from the model"
            );
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// FUND CONSERVATION ACROSS POOLS. A "bystander" pool escrows exactly 100 USDC. Then a random
    /// sequence of SUBJECT-pool operations runs - any interleaving of `claim_share` / `reclaim_pool`
    /// at any time, including the reclaim-then-claim double-spend the review caught. INVARIANT: the
    /// contract's escrow can NEVER drop below the bystander's 100 (its funds are sacrosanct) and can
    /// NEVER exceed 100 + subject-deposit (no funds are conjured). A regression (e.g. the pool not
    /// closing on reclaim, or a missing expiry gate) drains the bystander -> the property FAILS.
    #[test]
    fn no_pool_op_can_drain_or_inflate_a_bystander_pool(
        s_amount in 8i128..=800,
        s_slots in 1u32..=8,
        attempts in 0u32..=12,
        do_reclaim in any::<bool>(),
        reclaim_first in any::<bool>(),
    ) {
        let f = setup();
        let contract = f.id.clone();
        let floor = 100i128;
        let ceil = 100 + s_amount;

        // The bystander pool - its 100 USDC must survive everything below untouched.
        let vsender = Address::generate(&f.env);
        f.sac.mint(&vsender, &floor);
        let vsk = link_key(200);
        f.client.create_drop(&vsender, &link_pub(&f.env, &vsk), &floor, &4, &2000);

        // The subject pool - random size - is where every op (and any attack) happens.
        let ssender = Address::generate(&f.env);
        f.sac.mint(&ssender, &s_amount);
        let ssk = link_key(201);
        let slink = link_pub(&f.env, &ssk);
        f.client.create_drop(&ssender, &slink, &s_amount, &s_slots, &2000);
        prop_assert!(f.token.balance(&contract) >= floor && f.token.balance(&contract) <= ceil);

        if reclaim_first && do_reclaim {
            f.env.ledger().set_timestamp(2500);
            let _ = f.client.try_reclaim_pool(&slink);
            prop_assert!(f.token.balance(&contract) >= floor, "bystander drained by reclaim");
        }
        for _ in 0..attempts {
            let p = Address::generate(&f.env);
            let sig = sign(&f.env, &ssk, &f.client.claim_message(&2, &slink, &p));
            let _ = f.client.try_claim_share(&slink, &p, &sig);
            prop_assert!(f.token.balance(&contract) >= floor, "bystander drained by a share claim");
            prop_assert!(f.token.balance(&contract) <= ceil, "funds conjured from nowhere");
        }
        if do_reclaim && !reclaim_first {
            f.env.ledger().set_timestamp(2500);
            let _ = f.client.try_reclaim_pool(&slink);
        }
        prop_assert!(f.token.balance(&contract) >= floor && f.token.balance(&contract) <= ceil);
    }
}

/* ---------------- invariants 15-17: the two-step upgrade timelock (0.3.0) ---------------- */

/// Mirrors `UPGRADE_DELAY` / `EXPIRY_CLOCK_GRACE` in lib.rs (private there on purpose).
const DELAY: u64 = 7 * 24 * 60 * 60;
const GRACE: u64 = 60 * 60;

/// `upgrade` keeps the OpenZeppelin trait's unit-returning shape, so its generated client reports
/// a contract error as the SDK's generic `Error(Contract, #code)` rather than our enum; map ours
/// to it for exact comparisons (same codes on the wire either way).
fn as_sdk(e: Error) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(e as u32)
}

/// A module the host accepts as contract code, built in-process so no test depends on a compiled
/// fixture (CI runs `cargo test` before `stellar contract build`): the wasm header plus one custom
/// section, `contractenvmetav0`, carrying the interface version every contract built against this
/// SDK carries, and a second custom section whose byte makes distinct, equally valid modules. No
/// imports, no exports. A native test contract keeps the host's special empty executable, so an
/// upgrade into one of these is a real, observable swap: the instance's executable hash changes
/// and the host runs the new module from then on.
fn minimal_wasm(env: &Env, salt: u8) -> Bytes {
    let meta = ScEnvMetaEntry::ScEnvMetaKindInterfaceVersion(ScEnvMetaEntryInterfaceVersion {
        protocol: env.to_ledger_snapshot().protocol_version,
        pre_release: 0,
    })
    .to_xdr(Limits::none())
    .unwrap();
    let mut wasm = std::vec::Vec::from(*b"\0asm\x01\0\0\0");
    for (name, payload) in [(&b"contractenvmetav0"[..], &meta[..]), (&b"salt"[..], &[salt][..])] {
        let mut body = std::vec::Vec::new();
        body.push(name.len() as u8); // name length: one LEB128 byte (< 128)
        body.extend_from_slice(name);
        body.extend_from_slice(payload);
        wasm.push(0); // custom section id
        wasm.push(body.len() as u8); // section size: one LEB128 byte (< 128)
        wasm.extend_from_slice(&body);
    }
    Bytes::from_slice(env, &wasm)
}

/// Upload a distinct minimal module and return its hash (what `propose_upgrade` takes).
fn upload(f: &Fixture, salt: u8) -> BytesN<32> {
    f.env.deployer().upload_contract_wasm(minimal_wasm(&f.env, salt))
}

/// The contract's ledger entries (key, value, durability), read straight from the test ledger.
/// Needed once the native code has been swapped out: after a real upgrade the contract runs the
/// installed module, which exports nothing, so state is read from the ledger, not the client.
fn contract_entries(
    env: &Env,
    contract: &Address,
) -> std::vec::Vec<(ScVal, ScVal, ContractDataDurability)> {
    let want = ScAddress::from(contract);
    let snap = env.to_ledger_snapshot();
    let mut out = std::vec::Vec::new();
    for (key, (entry, _)) in &snap.ledger_entries {
        let LedgerKey::ContractData(k) = &**key else { continue };
        if k.contract != want {
            continue;
        }
        let LedgerEntryData::ContractData(d) = &entry.data else { continue };
        out.push((k.key.clone(), d.val.clone(), k.durability));
    }
    out.sort();
    out
}

fn instance(env: &Env, contract: &Address) -> ScContractInstance {
    contract_entries(env, contract)
        .into_iter()
        .find_map(|(k, v, _)| match (k, v) {
            (ScVal::LedgerKeyContractInstance, ScVal::ContractInstance(i)) => Some(i),
            _ => None,
        })
        .unwrap()
}

/// The hash of the wasm the contract currently executes.
fn executable_hash(env: &Env, contract: &Address) -> [u8; 32] {
    let ContractExecutable::Wasm(h) = instance(env, contract).executable else {
        unreachable!("the escrow is a wasm contract, never a Stellar Asset Contract")
    };
    h.0
}

/// The instance-storage value under a unit enum key named `name` (`PendingUpgrade`, OZ's
/// `SchemaVersion`), or None when the key is absent.
fn instance_value(env: &Env, contract: &Address, name: &str) -> Option<ScVal> {
    let map = instance(env, contract).storage?;
    map.iter().find_map(|e| match &e.key {
        ScVal::Vec(Some(v)) if matches!(v.first(), Some(ScVal::Symbol(s)) if &s[..] == name.as_bytes()) => {
            Some(e.val.clone())
        }
        _ => None,
    })
}

/// Everything in the contract's persistent storage except the instance entry itself (drops,
/// pools, claim flags), sorted.
fn persistent_entries(env: &Env, contract: &Address) -> std::vec::Vec<(ScVal, ScVal)> {
    contract_entries(env, contract)
        .into_iter()
        .filter(|(k, _, d)| {
            *d == ContractDataDurability::Persistent && *k != ScVal::LedgerKeyContractInstance
        })
        .map(|(k, v, _)| (k, v))
        .collect()
}

/// `pending_upgrade()` is None on a fresh contract; a proposal is announced on chain (topic
/// `upgrade_proposed` keyed by the hash, `not_before` as data) and reads back exactly: the hash,
/// `proposed_at = now`, `not_before = now + 7 days`.
#[test]
fn pending_upgrade_reads_back_after_propose() {
    let f = setup();
    assert!(f.client.pending_upgrade().is_none());
    let now = 1_700_000_000u64;
    f.env.ledger().set_timestamp(now);
    let hash = upload(&f, 1);
    f.client.propose_upgrade(&hash, &f.owner);
    assert_eq!(
        f.env.events().all(),
        vec![
            &f.env,
            (
                f.id.clone(),
                (Symbol::new(&f.env, "upgrade_proposed"), hash.clone()).into_val(&f.env),
                map![&f.env, (Symbol::new(&f.env, "not_before"), now + DELAY)].into_val(&f.env),
            )
        ]
    );
    let p = f.client.pending_upgrade().unwrap();
    assert_eq!(p.wasm_hash, hash);
    assert_eq!(p.proposed_at, now);
    assert_eq!(p.not_before, now + DELAY);
}

/// Invariant 15, the early side: right after the proposal and one second before the delay has
/// elapsed, `upgrade` is refused (`UpgradeTooEarly`), the executable is unchanged and the
/// proposal is intact.
#[test]
fn upgrade_before_not_before_is_refused() {
    let f = setup();
    f.env.ledger().set_timestamp(1_000);
    let hash = upload(&f, 1);
    let before = executable_hash(&f.env, &f.id);
    f.client.propose_upgrade(&hash, &f.owner);
    assert_eq!(f.client.try_upgrade(&hash, &f.owner), Err(Ok(as_sdk(Error::UpgradeTooEarly))));
    f.env.ledger().set_timestamp(1_000 + DELAY - 1);
    assert_eq!(f.client.try_upgrade(&hash, &f.owner), Err(Ok(as_sdk(Error::UpgradeTooEarly))));
    assert_eq!(executable_hash(&f.env, &f.id), before);
    let p = f.client.pending_upgrade().unwrap();
    assert_eq!(p.wasm_hash, hash);
    assert_eq!(p.not_before, 1_000 + DELAY);
}

/// Invariant 15, the late side: exactly at `not_before` the proposal installs. Proven on the
/// ledger, not by a flag: the instance's executable hash becomes the proposed one (it was the
/// host's native marker before), the `upgraded` event names it, the pending slot is gone, the
/// schema marker went 1 -> 2, every persistent escrow record is byte-identical to before the
/// swap and the escrow balance is untouched - a drop never notices the governance operation -
/// and from then on the host runs the installed module (which has no entrypoints), so the
/// native test code is provably no longer what answers.
#[test]
fn upgrade_at_not_before_swaps_the_wasm() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(110);
    let link = link_pub(&f.env, &sk);
    f.client.deposit(&sender, &link, &60, &5_000);
    f.client.create_drop(&sender, &link_pub(&f.env, &link_key(111)), &40, &2, &5_000);
    let escrow_before = persistent_entries(&f.env, &f.id);
    assert_eq!(escrow_before.len(), 2);

    f.env.ledger().set_timestamp(1_000);
    let hash = upload(&f, 1);
    let before = executable_hash(&f.env, &f.id);
    assert_ne!(before, hash.to_array());
    f.client.propose_upgrade(&hash, &f.owner);
    assert_eq!(instance_value(&f.env, &f.id, "SchemaVersion"), Some(ScVal::U32(1)));
    assert!(instance_value(&f.env, &f.id, "PendingUpgrade").is_some());

    f.env.ledger().set_timestamp(1_000 + DELAY);
    f.client.upgrade(&hash, &f.owner);
    assert_eq!(
        f.env.events().all(),
        vec![
            &f.env,
            (
                f.id.clone(),
                (Symbol::new(&f.env, "upgraded"), hash.clone()).into_val(&f.env),
                Map::<Symbol, Val>::new(&f.env).into_val(&f.env),
            )
        ]
    );
    assert_eq!(executable_hash(&f.env, &f.id), hash.to_array());
    assert_eq!(instance_value(&f.env, &f.id, "PendingUpgrade"), None);
    assert_eq!(instance_value(&f.env, &f.id, "SchemaVersion"), Some(ScVal::U32(2)));
    assert_eq!(persistent_entries(&f.env, &f.id), escrow_before);
    assert_eq!(f.token.balance(&f.id), 100);
    assert!(f.client.try_paused().is_err());
}

/// Invariant 15, the hash side: after the delay, a hash other than the proposed one is refused
/// (`UpgradeHashMismatch`) and the proposal survives; the proposed hash then installs.
#[test]
fn upgrade_with_a_different_hash_is_refused() {
    let f = setup();
    f.env.ledger().set_timestamp(1_000);
    let proposed = upload(&f, 1);
    let other = upload(&f, 2);
    assert_ne!(proposed, other);
    f.client.propose_upgrade(&proposed, &f.owner);
    f.env.ledger().set_timestamp(1_000 + DELAY);
    assert_eq!(f.client.try_upgrade(&other, &f.owner), Err(Ok(as_sdk(Error::UpgradeHashMismatch))));
    assert_eq!(f.client.pending_upgrade().unwrap().wasm_hash, proposed);
    assert_ne!(executable_hash(&f.env, &f.id), other.to_array());
    f.client.upgrade(&proposed, &f.owner);
    assert_eq!(executable_hash(&f.env, &f.id), proposed.to_array());
}

/// Invariant 16: `cancel_upgrade` clears the proposal (topic `upgrade_cancelled`, keyed by the
/// hash), after which `upgrade` is refused even past the old `not_before`, a second cancel is
/// refused, and a new proposal starts a fresh seven days from ITS time, never inheriting the
/// cancelled one's.
#[test]
fn cancel_upgrade_clears_the_proposal() {
    let f = setup();
    f.env.ledger().set_timestamp(1_000);
    let hash = upload(&f, 1);
    assert_eq!(f.client.try_cancel_upgrade(&f.owner), Err(Ok(Error::NoPendingUpgrade)));
    f.client.propose_upgrade(&hash, &f.owner);
    f.client.cancel_upgrade(&f.owner);
    assert_eq!(
        f.env.events().all(),
        vec![
            &f.env,
            (
                f.id.clone(),
                (Symbol::new(&f.env, "upgrade_cancelled"), hash.clone()).into_val(&f.env),
                Map::<Symbol, Val>::new(&f.env).into_val(&f.env),
            )
        ]
    );
    assert!(f.client.pending_upgrade().is_none());
    assert_eq!(f.client.try_cancel_upgrade(&f.owner), Err(Ok(Error::NoPendingUpgrade)));
    f.env.ledger().set_timestamp(1_000 + DELAY);
    assert_eq!(f.client.try_upgrade(&hash, &f.owner), Err(Ok(as_sdk(Error::NoPendingUpgrade))));
    f.client.propose_upgrade(&hash, &f.owner);
    assert_eq!(f.client.pending_upgrade().unwrap().not_before, 1_000 + DELAY + DELAY);
    assert_eq!(f.client.try_upgrade(&hash, &f.owner), Err(Ok(as_sdk(Error::UpgradeTooEarly))));
}

/// Invariant 16: while a proposal is pending, a second one is refused (`UpgradePending`) - a
/// different hash, the same hash, before and after the delay - and the first keeps its hash,
/// its `proposed_at` and its `not_before`: time passing never moves them.
#[test]
fn propose_while_pending_is_refused() {
    let f = setup();
    f.env.ledger().set_timestamp(1_000);
    let first = upload(&f, 1);
    let second = upload(&f, 2);
    f.client.propose_upgrade(&first, &f.owner);
    assert_eq!(f.client.try_propose_upgrade(&second, &f.owner), Err(Ok(Error::UpgradePending)));
    f.env.ledger().set_timestamp(1_000 + DELAY + 1);
    assert_eq!(f.client.try_propose_upgrade(&first, &f.owner), Err(Ok(Error::UpgradePending)));
    let p = f.client.pending_upgrade().unwrap();
    assert_eq!(p.wasm_hash, first);
    assert_eq!(p.proposed_at, 1_000);
    assert_eq!(p.not_before, 1_000 + DELAY);
    assert_eq!(f.client.try_upgrade(&second, &f.owner), Err(Ok(as_sdk(Error::UpgradeHashMismatch))));
}

/// `upgrade` with nothing proposed is refused outright (`NoPendingUpgrade`), however much time
/// has passed: the one-step upgrade of 0.2.0 does not exist in this bytecode.
#[test]
fn upgrade_without_a_proposal_is_refused() {
    let f = setup();
    let hash = upload(&f, 1);
    let before = executable_hash(&f.env, &f.id);
    assert_eq!(f.client.try_upgrade(&hash, &f.owner), Err(Ok(as_sdk(Error::NoPendingUpgrade))));
    f.env.ledger().set_timestamp(DELAY * 10);
    assert_eq!(f.client.try_upgrade(&hash, &f.owner), Err(Ok(as_sdk(Error::NoPendingUpgrade))));
    assert_eq!(executable_hash(&f.env, &f.id), before);
}

/// The whole timelock surface is owner-gated: with no authorization available, propose, cancel
/// and upgrade all fail (before and while a proposal is pending, even once it is ready), nothing
/// in the slot or the executable changes, and the owner can still use all three afterwards.
#[test]
fn strangers_cannot_propose_cancel_or_upgrade() {
    let f = setup();
    f.env.ledger().set_timestamp(1_000);
    let hash = upload(&f, 1);
    f.env.set_auths(&[]);
    assert!(f.client.try_propose_upgrade(&hash, &f.owner).is_err());
    assert!(f.client.pending_upgrade().is_none());
    f.env.mock_all_auths();
    f.client.propose_upgrade(&hash, &f.owner);
    f.env.ledger().set_timestamp(1_000 + DELAY);
    f.env.set_auths(&[]);
    assert!(f.client.try_cancel_upgrade(&f.owner).is_err());
    assert!(f.client.try_upgrade(&hash, &f.owner).is_err());
    assert_eq!(f.client.pending_upgrade().unwrap().wasm_hash, hash);
    assert_ne!(executable_hash(&f.env, &f.id), hash.to_array());
    f.env.mock_all_auths();
    f.client.cancel_upgrade(&f.owner);
    assert!(f.client.pending_upgrade().is_none());
}

/// Invariant 17: pause is instant during a pending upgrade (the brake is never behind the
/// delay), gates only new escrow as always, does not shortcut the delay, and neither pause nor
/// unpause touches the proposal; every exit still works while both are in force.
#[test]
fn pause_is_instant_during_a_pending_upgrade() {
    let f = setup();
    let sender = funded_sender(&f, 200);
    let sk = link_key(112);
    let l = link_pub(&f.env, &sk);
    f.client.deposit(&sender, &l, &50, &2_000);
    let sk2 = link_key(113);
    let l2 = link_pub(&f.env, &sk2);
    f.client.deposit(&sender, &l2, &50, &2_000);

    f.env.ledger().set_timestamp(1_000);
    let hash = upload(&f, 1);
    f.client.propose_upgrade(&hash, &f.owner);
    f.client.pause(&f.owner); // no waiting
    assert!(f.client.paused());
    let fresh = link_pub(&f.env, &link_key(114));
    assert!(f.client.try_deposit(&sender, &fresh, &10, &2_000).is_err());
    assert_eq!(f.client.try_upgrade(&hash, &f.owner), Err(Ok(as_sdk(Error::UpgradeTooEarly))));

    let p = Address::generate(&f.env);
    f.client.claim(&l, &p, &sign(&f.env, &sk, &f.client.claim_message(&1, &l, &p)));
    assert_eq!(f.token.balance(&p), 50);
    f.env.ledger().set_timestamp(2_500);
    f.client.reclaim(&l2);
    assert_eq!(f.token.balance(&sender), 150);

    f.client.unpause(&f.owner);
    assert!(!f.client.paused());
    let pending = f.client.pending_upgrade().unwrap();
    assert_eq!(pending.wasm_hash, hash);
    assert_eq!(pending.not_before, 1_000 + DELAY);
    f.client.deposit(&sender, &fresh, &10, &5_000);
}

/// Invariants 11 + 15 together: the longest drop the contract accepts, created one second before
/// a proposal, outlives that proposal's `not_before` by less than the clock grace (one hour) and
/// is reclaimable before the new code can be installed past it. The residual overlap is the
/// grace, stated here as a bound rather than hidden.
#[test]
fn a_drop_outlives_a_later_proposals_delay_by_at_most_the_clock_grace() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(115);
    let l = link_pub(&f.env, &sk);
    let now = 10_000u64;
    f.env.ledger().set_timestamp(now);
    f.client.deposit(&sender, &l, &100, &(now + DELAY + GRACE));
    f.env.ledger().set_timestamp(now + 1);
    let hash = upload(&f, 1);
    f.client.propose_upgrade(&hash, &f.owner);
    let not_before = f.client.pending_upgrade().unwrap().not_before;
    let expiry = f.client.get_drop(&l).unwrap().expiry;
    assert!(expiry > not_before && expiry - not_before < GRACE);
    assert_eq!(f.client.try_upgrade(&hash, &f.owner), Err(Ok(as_sdk(Error::UpgradeTooEarly))));
    f.env.ledger().set_timestamp(not_before + GRACE);
    f.client.reclaim(&l);
    assert_eq!(f.token.balance(&sender), 100);
    f.client.upgrade(&hash, &f.owner);
    assert_eq!(executable_hash(&f.env, &f.id), hash.to_array());
}

/// The positive path through THIS crate's real bytecode: upgrade the native test contract into
/// the wasm `stellar contract build --locked` produced from this very source, then read and
/// claim a pre-upgrade drop through the installed wasm, and check the timelock still gates the
/// next upgrade under it. Opt-in because CI runs `cargo test` before the wasm build.
#[test]
#[ignore = "needs target/wasm32v1-none/release/lumen_drop.wasm: `stellar contract build --locked`, then `cargo test -- --ignored`"]
fn upgrade_into_this_crates_own_wasm_keeps_drops_claimable() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/target/wasm32v1-none/release/lumen_drop.wasm");
    let wasm = std::fs::read(path).expect("build the wasm first");
    let f = setup_quiet(); // its snapshot would embed the wasm and churn on every rebuild
    f.env.ledger().set_timestamp(1_000);
    let sender = funded_sender(&f, 100);
    let sk = link_key(116);
    let l = link_pub(&f.env, &sk);
    f.client.deposit(&sender, &l, &70, &(1_000 + DELAY + GRACE));
    let hash = f.env.deployer().upload_contract_wasm(Bytes::from_slice(&f.env, &wasm));
    f.client.propose_upgrade(&hash, &f.owner);
    f.env.ledger().set_timestamp(1_000 + DELAY);
    f.client.upgrade(&hash, &f.owner);
    assert_eq!(executable_hash(&f.env, &f.id), hash.to_array());
    // from here on every call runs the installed wasm, not the native test code
    assert!(!f.client.paused());
    assert!(f.client.pending_upgrade().is_none());
    assert_eq!(f.client.get_owner(), Some(f.owner.clone()));
    let d = f.client.get_drop(&l).unwrap();
    assert_eq!((d.amount, d.claimed), (70, false));
    let p = Address::generate(&f.env);
    f.client.claim(&l, &p, &sign(&f.env, &sk, &f.client.claim_message(&1, &l, &p)));
    assert_eq!(f.token.balance(&p), 70);
    assert_eq!(f.client.try_upgrade(&hash, &f.owner), Err(Ok(as_sdk(Error::NoPendingUpgrade))));
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// TIMELOCK BOUNDARY (invariant 15): for any proposal time and any elapsed time up to two
    /// delays, `upgrade` with the proposed hash succeeds exactly when `elapsed >= 7 days`; on
    /// success the executable is the proposed hash and the slot is empty, on refusal nothing
    /// changed and the proposal still reads back.
    #[test]
    fn upgrade_succeeds_exactly_from_the_delay_on(
        proposed_at in 1u64..=4_000_000_000,
        elapsed in 0u64..=2 * DELAY,
    ) {
        let f = setup_quiet();
        f.env.ledger().set_timestamp(proposed_at);
        let hash = upload(&f, 1);
        let before = executable_hash(&f.env, &f.id);
        f.client.propose_upgrade(&hash, &f.owner);
        f.env.ledger().set_timestamp(proposed_at + elapsed);
        let r = f.client.try_upgrade(&hash, &f.owner);
        if elapsed >= DELAY {
            prop_assert!(r.is_ok());
            prop_assert_eq!(executable_hash(&f.env, &f.id), hash.to_array());
            prop_assert_eq!(instance_value(&f.env, &f.id, "PendingUpgrade"), None);
        } else {
            prop_assert_eq!(r, Err(Ok(as_sdk(Error::UpgradeTooEarly))));
            prop_assert_eq!(executable_hash(&f.env, &f.id), before);
            prop_assert_eq!(f.client.pending_upgrade().unwrap().not_before, proposed_at + DELAY);
        }
    }

    /// MODEL-BASED TIMELOCK (invariants 15 + 16): under any interleaving of propose (either of
    /// two real hashes), cancel, time passing and upgrade attempts, the contract's pending slot
    /// equals a one-line model (`Option<(hash, not_before)>`) after every step, and an upgrade
    /// succeeds exactly when the model says the presented hash is the pending one and its delay
    /// has elapsed - and then the executable is that hash.
    #[test]
    fn timelock_matches_the_model_under_any_op_sequence(
        ops in proptest::collection::vec((0u8..=3, any::<bool>(), 0u64..=DELAY), 1..=16),
    ) {
        let f = setup_quiet();
        let hashes = [upload(&f, 1), upload(&f, 2)];
        let mut now = 1_000u64;
        f.env.ledger().set_timestamp(now);
        let mut model: Option<(usize, u64)> = None;
        for (kind, which, dt) in ops {
            let i = usize::from(which);
            match kind {
                0 => {
                    let r = f.client.try_propose_upgrade(&hashes[i], &f.owner);
                    if model.is_none() {
                        prop_assert!(r.is_ok());
                        model = Some((i, now + DELAY));
                    } else {
                        prop_assert_eq!(r, Err(Ok(Error::UpgradePending)));
                    }
                }
                1 => {
                    let r = f.client.try_cancel_upgrade(&f.owner);
                    if model.is_some() {
                        prop_assert!(r.is_ok());
                        model = None;
                    } else {
                        prop_assert_eq!(r, Err(Ok(Error::NoPendingUpgrade)));
                    }
                }
                2 => {
                    now += dt;
                    f.env.ledger().set_timestamp(now);
                }
                _ => {
                    let r = f.client.try_upgrade(&hashes[i], &f.owner);
                    match model {
                        None => {
                            prop_assert_eq!(r, Err(Ok(as_sdk(Error::NoPendingUpgrade))));
                        }
                        Some((j, _)) if j != i => {
                            prop_assert_eq!(r, Err(Ok(as_sdk(Error::UpgradeHashMismatch))));
                        }
                        Some((_, nb)) if now < nb => {
                            prop_assert_eq!(r, Err(Ok(as_sdk(Error::UpgradeTooEarly))));
                        }
                        Some(_) => {
                            prop_assert!(r.is_ok());
                            prop_assert_eq!(executable_hash(&f.env, &f.id), hashes[i].to_array());
                            prop_assert_eq!(instance_value(&f.env, &f.id, "PendingUpgrade"), None);
                            break; // the native code is swapped out; the sequence ends here
                        }
                    }
                }
            }
            match model {
                None => {
                    prop_assert!(f.client.pending_upgrade().is_none());
                }
                Some((j, nb)) => {
                    let p = f.client.pending_upgrade().unwrap();
                    prop_assert_eq!(p.wasm_hash, hashes[j].clone());
                    prop_assert_eq!(p.not_before, nb);
                }
            }
        }
    }
}
