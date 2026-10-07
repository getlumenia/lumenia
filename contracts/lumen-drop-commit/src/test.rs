#![cfg(test)]
// Tests may unwrap/index freely - the strict lints (unwrap_used, arithmetic_side_effects)
// gate the CONTRACT code; a panicking test is a failing test, which is exactly what we want.
#![allow(clippy::unwrap_used, clippy::arithmetic_side_effects)]
extern crate std;

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use proptest::prelude::*;
use soroban_sdk::testutils::{
    Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger as _,
};
use soroban_sdk::xdr::{ContractEventBody, ScVal};
use soroban_sdk::{
    token, vec, Address, Bytes, BytesN, Env, Event as _, IntoVal, InvokeError, Map, Symbol,
    TryFromVal, Val,
};

/// A deterministic Ed25519 link key (no rng needed) from a one-byte seed.
fn link_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}
fn link_pub(env: &Env, sk: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, &sk.verifying_key().to_bytes())
}
/// A deterministic 32-byte salt from a one-byte seed (a real client draws 32 random bytes).
fn salt(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}
/// Sign the EXACT message the contract will rebuild (parity is the whole point).
fn sign(env: &Env, sk: &SigningKey, msg: &Bytes) -> BytesN<64> {
    let bytes: std::vec::Vec<u8> = msg.iter().collect();
    BytesN::from_array(env, &sk.sign(&bytes).to_bytes())
}
fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

struct Fixture<'a> {
    env: Env,
    /// The deployed contract's address (used to read the escrow balance and filter events).
    id: Address,
    /// The governance owner (upgrade/pause authority) set at construction.
    owner: Address,
    client: LumenDropCommitClient<'a>,
    token: token::Client<'a>,
    sac: token::StellarAssetClient<'a>,
}

fn setup<'a>() -> Fixture<'a> {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let token_addr = sac.address();
    let id = env.register(LumenDropCommit, (token_addr.clone(), owner.clone()));
    Fixture {
        client: LumenDropCommitClient::new(&env, &id),
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

/// An HONEST deposit: the commitment opens to exactly the amount escrowed. Returns the link.
fn deposit_honest(
    f: &Fixture,
    sender: &Address,
    sk: &SigningKey,
    amount: i128,
    s: &BytesN<32>,
    expiry: u64,
) -> BytesN<32> {
    let link = link_pub(&f.env, sk);
    let c = f.client.commitment_of(&link, &amount, s);
    f.client.deposit(sender, &link, &c, &amount, &expiry);
    link
}

/// The link key's signature over the claim message for this payout and this reveal.
fn claim_sig(
    f: &Fixture,
    sk: &SigningKey,
    link: &BytesN<32>,
    payout: &Address,
    amount: i128,
    s: &BytesN<32>,
) -> BytesN<64> {
    sign(&f.env, sk, &f.client.claim_message(link, payout, &amount, s))
}

/// True if an i128 (the amount's type) appears anywhere inside an event value.
fn has_i128(v: &ScVal) -> bool {
    match v {
        ScVal::I128(_) => true,
        ScVal::Vec(Some(xs)) => xs.iter().any(has_i128),
        ScVal::Map(Some(m)) => m.iter().any(|e| has_i128(&e.key) || has_i128(&e.val)),
        _ => false,
    }
}

/* ------------------------------- the commitment itself ------------------------------- */

/// Known-answer vector, shared with the TypeScript parity check
/// (apps/sponsor/src/spike11-commitment.ts): link = 32 x 0x11, amount = 1234567,
/// salt = 32 x 0x22, an 81-byte preimage.
#[test]
fn commitment_known_answer_vector() {
    let f = setup();
    let link = BytesN::from_array(&f.env, &[0x11; 32]);
    let s = BytesN::from_array(&f.env, &[0x22; 32]);
    let want = hex32("ea3424656bc0651d6bfc1f35d020dd77fd5c906fae5e81a443ecd58228a3f8d5");
    assert_eq!(f.client.commitment_of(&link, &1_234_567, &s).to_array(), want);

    // The layout spelled out: 0x03 ++ link ++ amount as 16 big-endian bytes ++ salt, with the
    // amount written by hand (1234567 = 0x12d687) rather than by the code under test.
    let mut pre = std::vec![0x03u8];
    pre.extend_from_slice(&[0x11; 32]);
    pre.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x12, 0xd6, 0x87]);
    pre.extend_from_slice(&[0x22; 32]);
    assert_eq!(pre.len(), 81);
    assert_eq!(f.env.crypto().sha256(&Bytes::from_slice(&f.env, &pre)).to_array(), want);

    // Two's complement for a negative amount (only a dishonest commitment could carry one).
    let mut neg = std::vec![0x03u8];
    neg.extend_from_slice(&[0x11; 32]);
    neg.extend_from_slice(&[0xff; 16]);
    neg.extend_from_slice(&[0x22; 32]);
    assert_eq!(
        f.client.commitment_of(&link, &-1, &s).to_array(),
        f.env.crypto().sha256(&Bytes::from_slice(&f.env, &neg)).to_array()
    );
}

/* ------------------------------ one-to-one, with a reveal ----------------------------- */

#[test]
fn happy_reveal_pays_exactly_escrowed_once() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(7);
    let s = salt(&f.env, 1);
    let link = deposit_honest(&f, &sender, &sk, 60, &s, 2000);
    assert_eq!(f.token.balance(&sender), 40);
    assert_eq!(f.token.balance(&f.id), 60);
    let d = f.client.get_drop(&link).unwrap();
    assert_eq!(d.sender, sender);
    assert_eq!(d.commitment, f.client.commitment_of(&link, &60, &s));
    assert_eq!(d.escrowed, 60);
    assert_eq!(d.expiry, 2000);
    assert!(!d.claimed);

    // payout chosen AT CLAIM TIME; the link key signs it together with the reveal
    let payout = Address::generate(&f.env);
    let sig = claim_sig(&f, &sk, &link, &payout, 60, &s);
    f.client.claim(&link, &payout, &sig, &60, &s);
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.id),
        [ClaimEvent { link: link.clone(), payout: payout.clone(), amount: 60 }.to_xdr(&f.env, &f.id)]
    );
    assert_eq!(f.token.balance(&payout), 60);
    assert_eq!(f.token.balance(&f.id), 0);
    assert!(f.client.get_drop(&link).unwrap().claimed);

    // exactly once: the same claim again, or a freshly signed payout, is AlreadyClaimed
    assert_eq!(f.client.try_claim(&link, &payout, &sig, &60, &s), Err(Ok(Error::AlreadyClaimed)));
    let other = Address::generate(&f.env);
    let sig_other = claim_sig(&f, &sk, &link, &other, 60, &s);
    assert_eq!(
        f.client.try_claim(&link, &other, &sig_other, &60, &s),
        Err(Ok(Error::AlreadyClaimed))
    );
    assert_eq!(f.token.balance(&payout), 60);
    assert_eq!(f.token.balance(&other), 0);
}

#[test]
fn unknown_link_is_nothing_here() {
    let f = setup();
    let sk = link_key(8);
    let link = link_pub(&f.env, &sk);
    let s = salt(&f.env, 8);
    let payout = Address::generate(&f.env);
    let sig = claim_sig(&f, &sk, &link, &payout, 10, &s);
    assert!(f.client.get_drop(&link).is_none());
    assert_eq!(f.client.try_claim(&link, &payout, &sig, &10, &s), Err(Ok(Error::NothingHere)));
    assert_eq!(f.client.try_reclaim(&link), Err(Ok(Error::NothingHere)));
}

#[test]
fn wrong_salt_is_bad_reveal() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(9);
    let s = salt(&f.env, 2);
    let link = deposit_honest(&f, &sender, &sk, 50, &s, 2000);
    let payout = Address::generate(&f.env);

    // even with a VALID link signature over that exact reveal, a wrong salt opens nothing
    let wrong = salt(&f.env, 3);
    let sig = claim_sig(&f, &sk, &link, &payout, 50, &wrong);
    assert_eq!(f.client.try_claim(&link, &payout, &sig, &50, &wrong), Err(Ok(Error::BadReveal)));
    // nothing moved, nothing flipped (invariant 12)
    assert_eq!(f.token.balance(&payout), 0);
    assert_eq!(f.token.balance(&f.id), 50);
    assert!(!f.client.get_drop(&link).unwrap().claimed);

    // the right salt still redeems the full amount
    f.client.claim(&link, &payout, &claim_sig(&f, &sk, &link, &payout, 50, &s), &50, &s);
    assert_eq!(f.token.balance(&payout), 50);
}

#[test]
fn honest_commitment_with_another_revealed_amount_is_bad_reveal() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(10);
    let s = salt(&f.env, 4);
    let link = deposit_honest(&f, &sender, &sk, 50, &s, 2000);
    let payout = Address::generate(&f.env);

    // any other amount fails the HASH check first: BadReveal, never RevealMismatch
    for lie in [49i128, 51, 500, 0, -50] {
        let sig = claim_sig(&f, &sk, &link, &payout, lie, &s);
        assert_eq!(f.client.try_claim(&link, &payout, &sig, &lie, &s), Err(Ok(Error::BadReveal)));
    }
    assert_eq!(f.token.balance(&f.id), 50);
    assert_eq!(f.token.balance(&payout), 0);

    f.client.claim(&link, &payout, &claim_sig(&f, &sk, &link, &payout, 50, &s), &50, &s);
    assert_eq!(f.token.balance(&payout), 50);
}

/// THE SOLVENCY TRAP, as a test. A dishonest sender who holds their own link secret deposits 1
/// but commits to 5. If the reveal decided the payout, claiming 5 would take 4 out of the
/// bystander's escrow in the same pooled balance (invariants 1 and 10). Here the drop is simply
/// unclaimable, and only its own sender gets its own 1 back, after expiry.
#[test]
fn dishonest_commitment_cannot_drain_other_drops() {
    let f = setup();
    // A bystander's honest 100 sits in the SAME pooled SAC balance.
    let bystander = funded_sender(&f, 100);
    let bk = link_key(20);
    let bs = salt(&f.env, 20);
    let blink = deposit_honest(&f, &bystander, &bk, 100, &bs, 2000);

    let cheat = funded_sender(&f, 1);
    let ck = link_key(21);
    let clink = link_pub(&f.env, &ck);
    let cs = salt(&f.env, 21);
    let promise = f.client.commitment_of(&clink, &5, &cs);
    f.client.deposit(&cheat, &clink, &promise, &1, &2000);
    assert_eq!(f.token.balance(&f.id), 101);

    // Revealing the committed 5 (with a valid link signature) opens the commitment, but 5 is not
    // what the escrow holds.
    let to = Address::generate(&f.env);
    let sig5 = claim_sig(&f, &ck, &clink, &to, 5, &cs);
    assert_eq!(f.client.try_claim(&clink, &to, &sig5, &5, &cs), Err(Ok(Error::RevealMismatch)));
    // Revealing the escrowed 1 does not open a commitment made to 5.
    let sig1 = claim_sig(&f, &ck, &clink, &to, 1, &cs);
    assert_eq!(f.client.try_claim(&clink, &to, &sig1, &1, &cs), Err(Ok(Error::BadReveal)));
    assert_eq!(f.token.balance(&to), 0);
    assert_eq!(f.token.balance(&f.id), 101); // nothing left the pool

    // The bystander's escrow was never touched: it pays out in full, leaving exactly the 1.
    let bp = Address::generate(&f.env);
    f.client.claim(&blink, &bp, &claim_sig(&f, &bk, &blink, &bp, 100, &bs), &100, &bs);
    assert_eq!(f.token.balance(&bp), 100);
    assert_eq!(f.token.balance(&f.id), 1);

    // The only exit for the dishonest drop: its own sender, after expiry, for exactly 1.
    assert_eq!(f.client.try_reclaim(&clink), Err(Ok(Error::NotExpired)));
    f.env.ledger().set_timestamp(2500);
    f.client.reclaim(&clink);
    assert_eq!(f.token.balance(&cheat), 1);
    assert_eq!(f.token.balance(&f.id), 0);
}

/// The link is inside the preimage, so a commitment made for one link never opens at another,
/// even with the right amount and salt.
#[test]
fn reveal_bound_to_another_link_is_bad_reveal() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let ka = link_key(30);
    let kb = link_key(31);
    let la = link_pub(&f.env, &ka);
    let lb = link_pub(&f.env, &kb);
    let s = salt(&f.env, 30);
    let for_b = f.client.commitment_of(&lb, &25, &s);
    assert_ne!(f.client.commitment_of(&la, &25, &s), for_b);

    // A deposit at link A carrying the commitment made for link B (same amount, same salt).
    f.client.deposit(&sender, &la, &for_b, &25, &2000);
    let payout = Address::generate(&f.env);
    let sig = claim_sig(&f, &ka, &la, &payout, 25, &s);
    assert_eq!(f.client.try_claim(&la, &payout, &sig, &25, &s), Err(Ok(Error::BadReveal)));
    assert_eq!(f.token.balance(&payout), 0);

    // At link B, the same reveal opens the commitment it was made for.
    deposit_honest(&f, &sender, &kb, 25, &s, 2000);
    f.client.claim(&lb, &payout, &claim_sig(&f, &kb, &lb, &payout, 25, &s), &25, &s);
    assert_eq!(f.token.balance(&payout), 25);

    // and the mis-bound drop at A goes back to its sender after expiry
    f.env.ledger().set_timestamp(2500);
    f.client.reclaim(&la);
    assert_eq!(f.token.balance(&sender), 75);
}

/// The link key signs the reveal too: a signature over one (amount, salt) cannot be paired with
/// another reveal, even the one that opens the commitment. A failed signature traps the tx.
#[test]
fn signature_binds_the_reveal() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(40);
    let s = salt(&f.env, 40);
    let link = deposit_honest(&f, &sender, &sk, 40, &s, 2000);
    let payout = Address::generate(&f.env);

    let over_other_salt = claim_sig(&f, &sk, &link, &payout, 40, &salt(&f.env, 41));
    assert_eq!(
        f.client.try_claim(&link, &payout, &over_other_salt, &40, &s),
        Err(Err(InvokeError::Abort))
    );
    let over_other_amount = claim_sig(&f, &sk, &link, &payout, 41, &s);
    assert_eq!(
        f.client.try_claim(&link, &payout, &over_other_amount, &40, &s),
        Err(Err(InvokeError::Abort))
    );
    // a key other than the link's, over the right message, is refused the same way
    let forged = claim_sig(&f, &link_key(42), &link, &payout, 40, &s);
    assert_eq!(f.client.try_claim(&link, &payout, &forged, &40, &s), Err(Err(InvokeError::Abort)));
    assert_eq!(f.token.balance(&payout), 0);
    assert_eq!(f.token.balance(&f.id), 40);
    assert!(!f.client.get_drop(&link).unwrap().claimed);

    f.client.claim(&link, &payout, &claim_sig(&f, &sk, &link, &payout, 40, &s), &40, &s);
    assert_eq!(f.token.balance(&payout), 40);
}

/// The check order is part of the interface: record, then claimed, then the reveal against the
/// commitment, then the reveal against the escrow, then the signature. With a garbage signature
/// on every call, each earlier failure must still be the one reported.
#[test]
fn claim_check_order_is_pinned() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let junk = BytesN::from_array(&f.env, &[0u8; 64]);
    let payout = Address::generate(&f.env);
    let s = salt(&f.env, 44);
    let wrong = salt(&f.env, 45);

    let nowhere = link_pub(&f.env, &link_key(44));
    assert_eq!(f.client.try_claim(&nowhere, &payout, &junk, &-1, &wrong), Err(Ok(Error::NothingHere)));

    let hk = link_key(46);
    let honest = deposit_honest(&f, &sender, &hk, 10, &s, 2000);
    assert_eq!(f.client.try_claim(&honest, &payout, &junk, &10, &wrong), Err(Ok(Error::BadReveal)));
    assert_eq!(f.client.try_claim(&honest, &payout, &junk, &10, &s), Err(Err(InvokeError::Abort)));

    let liar = link_pub(&f.env, &link_key(47));
    f.client.deposit(&sender, &liar, &f.client.commitment_of(&liar, &99, &s), &10, &2000);
    assert_eq!(f.client.try_claim(&liar, &payout, &junk, &99, &s), Err(Ok(Error::RevealMismatch)));

    f.client.claim(&honest, &payout, &claim_sig(&f, &hk, &honest, &payout, 10, &s), &10, &s);
    assert_eq!(f.client.try_claim(&honest, &payout, &junk, &-1, &wrong), Err(Ok(Error::AlreadyClaimed)));
}

/// Payout integrity (invariant 3): a relayer holding a signed claim cannot redirect it.
#[test]
fn signature_binds_the_payout() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(43);
    let s = salt(&f.env, 43);
    let link = deposit_honest(&f, &sender, &sk, 40, &s, 2000);

    let payout_a = Address::generate(&f.env);
    let attacker = Address::generate(&f.env);
    let sig_a = claim_sig(&f, &sk, &link, &payout_a, 40, &s);
    assert_eq!(f.client.try_claim(&link, &attacker, &sig_a, &40, &s), Err(Err(InvokeError::Abort)));
    assert_eq!(f.token.balance(&attacker), 0);

    f.client.claim(&link, &payout_a, &sig_a, &40, &s);
    assert_eq!(f.token.balance(&payout_a), 40);
    assert_eq!(f.token.balance(&attacker), 0);
}

/// Reclaim (invariants 2 + 5): locked until expiry (the boundary is exact), pays exactly
/// `escrowed` back once, and claim and reclaim exclude each other.
#[test]
fn reclaim_gating_and_mutual_exclusion() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(50);
    let s = salt(&f.env, 50);
    let link = deposit_honest(&f, &sender, &sk, 60, &s, 2000);

    f.env.ledger().set_timestamp(1999); // one second BEFORE expiry -> still locked
    assert_eq!(f.client.try_reclaim(&link), Err(Ok(Error::NotExpired)));

    f.env.ledger().set_timestamp(2000); // exactly AT expiry -> reclaimable
    f.client.reclaim(&link);
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.id),
        [ReclaimEvent { link: link.clone(), sender: sender.clone(), amount: 60 }.to_xdr(&f.env, &f.id)]
    );
    assert_eq!(f.token.balance(&sender), 100); // exactly the escrow came back
    assert!(f.client.get_drop(&link).unwrap().claimed);

    // after a reclaim, neither exit pays again
    assert_eq!(f.client.try_reclaim(&link), Err(Ok(Error::AlreadyClaimed)));
    let payout = Address::generate(&f.env);
    let sig = claim_sig(&f, &sk, &link, &payout, 60, &s);
    assert_eq!(f.client.try_claim(&link, &payout, &sig, &60, &s), Err(Ok(Error::AlreadyClaimed)));

    // and after a claim, the sender cannot reclaim
    let sk2 = link_key(51);
    let s2 = salt(&f.env, 51);
    let link2 = deposit_honest(&f, &sender, &sk2, 30, &s2, 3000);
    f.client.claim(&link2, &payout, &claim_sig(&f, &sk2, &link2, &payout, 30, &s2), &30, &s2);
    f.env.ledger().set_timestamp(3500);
    assert_eq!(f.client.try_reclaim(&link2), Err(Ok(Error::AlreadyClaimed)));
    assert_eq!(f.token.balance(&sender), 70);
    assert_eq!(f.token.balance(&payout), 30);
}

/// Invariant 14: pause gates ONLY `deposit`; claim and reclaim stay callable while paused.
#[test]
fn pause_blocks_deposit_never_claim_or_reclaim() {
    let f = setup();
    let sender = funded_sender(&f, 300);
    let k1 = link_key(60);
    let s1 = salt(&f.env, 60);
    let l1 = deposit_honest(&f, &sender, &k1, 50, &s1, 2000); // claimed while paused
    let k2 = link_key(61);
    let s2 = salt(&f.env, 61);
    let l2 = deposit_honest(&f, &sender, &k2, 40, &s2, 2000); // reclaimed while paused

    f.client.pause(&f.owner);
    assert!(f.client.paused());

    // new escrow is stopped (OZ PausableError::EnforcedPause = 1000)...
    let l3 = link_pub(&f.env, &link_key(62));
    let c3 = f.client.commitment_of(&l3, &10, &salt(&f.env, 62));
    assert_eq!(
        f.client.try_deposit(&sender, &l3, &c3, &10, &2000),
        Err(Err(InvokeError::Contract(1000)))
    );

    // ...but both exits still work
    let p = Address::generate(&f.env);
    f.client.claim(&l1, &p, &claim_sig(&f, &k1, &l1, &p, 50, &s1), &50, &s1);
    assert_eq!(f.token.balance(&p), 50);
    f.env.ledger().set_timestamp(2500);
    f.client.reclaim(&l2);
    assert_eq!(f.token.balance(&sender), 250);

    f.client.unpause(&f.owner);
    assert!(!f.client.paused());
    f.client.deposit(&sender, &l3, &c3, &10, &3500); // new escrow resumes after unpause
    assert_eq!(f.token.balance(&sender), 240);
}

/// `DepositEvent` carries the commitment and NO amount, asserted on the emitted event. The other
/// half is asserted too, because it is this spike's honest headline: the SAME invocation's SAC
/// transfer event, and the sender's auth entry, still carry the amount in the clear.
#[test]
fn deposit_event_carries_no_amount_but_the_transfer_and_auth_do() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let link = link_pub(&f.env, &link_key(70));
    let s = salt(&f.env, 70);
    let c = f.client.commitment_of(&link, &60, &s);
    f.client.deposit(&sender, &link, &c, &60, &2000);
    let all = f.env.events().all();

    // the sender signs `deposit(.., amount, ..)` with the SAC `transfer(from, contract, amount)`
    // as its sub-invocation: the amount is in the auth entry twice
    assert_eq!(
        f.env.auths(),
        std::vec![(
            sender.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    f.id.clone(),
                    Symbol::new(&f.env, "deposit"),
                    (sender.clone(), link.clone(), c.clone(), 60i128, 2000u64).into_val(&f.env),
                )),
                sub_invocations: std::vec![AuthorizedInvocation {
                    function: AuthorizedFunction::Contract((
                        f.token.address.clone(),
                        Symbol::new(&f.env, "transfer"),
                        (sender.clone(), f.id.clone(), 60i128).into_val(&f.env),
                    )),
                    sub_invocations: std::vec![],
                }],
            }
        )]
    );

    // ours: exactly one event, exactly the amount-free DepositEvent
    let ours = all.filter_by_contract(&f.id);
    assert_eq!(
        ours,
        [DepositEvent { link: link.clone(), sender: sender.clone(), commitment: c.clone(), expiry: 2000 }
            .to_xdr(&f.env, &f.id)]
    );
    let ContractEventBody::V0(body) = &ours.events()[0].body;
    let data = Map::<Symbol, Val>::try_from_val(&f.env, &Val::try_from_val(&f.env, &body.data).unwrap())
        .unwrap();
    assert_eq!(
        data.keys(),
        vec![
            &f.env,
            Symbol::new(&f.env, "commitment"),
            Symbol::new(&f.env, "expiry"),
            Symbol::new(&f.env, "sender")
        ]
    );
    assert!(!body.topics.iter().any(has_i128));
    assert!(!has_i128(&body.data));

    // the token's own transfer event, same invocation: the amount is right there
    let sac = all.filter_by_contract(&f.token.address);
    assert!(sac.events().iter().any(|e| {
        let ContractEventBody::V0(b) = &e.body;
        b.data == ScVal::from(60i128)
    }));
}

/* ------------------ carried over from LumenDrop: invariants 4, 5, 11, 13 ------------------ */

/// Invariant 11: `amount > 0`, `now < expiry <= now + 30 days`, one drop per link.
#[test]
fn deposit_inputs_and_expiry_bounds_enforced() {
    let f = setup();
    let sender = funded_sender(&f, 1000);
    let link = link_pub(&f.env, &link_key(80));
    let c = f.client.commitment_of(&link, &10, &salt(&f.env, 80));
    let now = 1_000_000u64;
    f.env.ledger().set_timestamp(now);
    const MAX: u64 = 30 * 24 * 60 * 60;

    assert_eq!(f.client.try_deposit(&sender, &link, &c, &0, &(now + 10)), Err(Ok(Error::BadInput)));
    assert_eq!(f.client.try_deposit(&sender, &link, &c, &-5, &(now + 10)), Err(Ok(Error::BadInput)));
    // expiry in the past / exactly now / beyond the 30-day horizon -> rejected
    assert_eq!(f.client.try_deposit(&sender, &link, &c, &10, &(now - 1)), Err(Ok(Error::BadExpiry)));
    assert_eq!(f.client.try_deposit(&sender, &link, &c, &10, &now), Err(Ok(Error::BadExpiry)));
    assert_eq!(
        f.client.try_deposit(&sender, &link, &c, &10, &(now + MAX + 1)),
        Err(Ok(Error::BadExpiry))
    );
    // exactly at the horizon -> accepted, and a second drop on the same link is refused
    f.client.deposit(&sender, &link, &c, &10, &(now + MAX));
    assert_eq!(
        f.client.try_deposit(&sender, &link, &c, &10, &(now + 10)),
        Err(Ok(Error::AlreadyExists))
    );
    assert_eq!(f.token.balance(&f.id), 10);
}

/// Invariant 5: reclaim needs the recorded sender's auth, not just the clock. A claim needs no
/// account auth at all: the link signature is the whole authorization (the relayer path).
#[test]
fn reclaim_needs_sender_auth_claim_needs_none() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(81);
    let s = salt(&f.env, 81);
    let link = deposit_honest(&f, &sender, &sk, 50, &s, 2000);
    let sk2 = link_key(82);
    let s2 = salt(&f.env, 82);
    let link2 = deposit_honest(&f, &sender, &sk2, 30, &s2, 2000);
    let payout = Address::generate(&f.env);
    let sig2 = claim_sig(&f, &sk2, &link2, &payout, 30, &s2);
    f.env.ledger().set_timestamp(2500);

    f.env.set_auths(&[]); // no authorizations available from here on
    assert_eq!(f.client.try_reclaim(&link), Err(Err(InvokeError::Abort)));
    assert_eq!(f.token.balance(&f.id), 80); // nothing left the escrow
    f.client.claim(&link2, &payout, &sig2, &30, &s2);
    assert_eq!(f.token.balance(&payout), 30);

    f.env.mock_all_auths();
    f.client.reclaim(&link);
    assert_eq!(f.token.balance(&sender), 70);
}

/// Invariant 4: the claim message is exactly tag ++ network ++ contract ++ link ++ payout ++
/// amount ++ salt, and changing any component gives a different message.
#[test]
fn claim_message_layout_binds_full_context() {
    let f = setup();
    let link = link_pub(&f.env, &link_key(83));
    let payout = Address::generate(&f.env);
    let s = salt(&f.env, 83);
    let m: std::vec::Vec<u8> = f.client.claim_message(&link, &payout, &25, &s).iter().collect();

    let mut want = std::vec![0x04u8];
    want.extend_from_slice(&f.env.ledger().network_id().to_array());
    want.extend(f.id.clone().to_xdr(&f.env).iter());
    want.extend_from_slice(&link.to_array());
    want.extend(payout.clone().to_xdr(&f.env).iter());
    want.extend_from_slice(&25i128.to_be_bytes());
    want.extend_from_slice(&s.to_array());
    assert_eq!(m, want);

    let differs = |other: Bytes| other.iter().collect::<std::vec::Vec<u8>>() != m;
    assert!(differs(f.client.claim_message(&link, &Address::generate(&f.env), &25, &s)));
    assert!(differs(f.client.claim_message(&link_pub(&f.env, &link_key(84)), &payout, &25, &s)));
    assert!(differs(f.client.claim_message(&link, &payout, &26, &s)));
    assert!(differs(f.client.claim_message(&link, &payout, &25, &salt(&f.env, 84))));
}

/// Invariant 4: a signature minted against one deployment never releases funds from another
/// (the commitment, a pure function of link, amount and salt, is the same on both).
#[test]
fn signature_for_one_contract_rejected_on_another() {
    let f = setup();
    let id_b = f.env.register(LumenDropCommit, (f.token.address.clone(), f.owner.clone()));
    let client_b = LumenDropCommitClient::new(&f.env, &id_b);
    let sender = funded_sender(&f, 200);
    let sk = link_key(85);
    let s = salt(&f.env, 85);
    let link = deposit_honest(&f, &sender, &sk, 50, &s, 2000);
    client_b.deposit(&sender, &link, &client_b.commitment_of(&link, &50, &s), &50, &2000);

    let payout = Address::generate(&f.env);
    let sig_a = claim_sig(&f, &sk, &link, &payout, 50, &s);
    assert_eq!(client_b.try_claim(&link, &payout, &sig_a, &50, &s), Err(Err(InvokeError::Abort)));
    assert_eq!(f.token.balance(&payout), 0);
    f.client.claim(&link, &payout, &sig_a, &50, &s); // and it works where it was minted
    assert_eq!(f.token.balance(&payout), 50);
}

/// Invariant 13: no owner action moves escrow, and the owner surface is auth-gated.
#[test]
fn owner_surface_cannot_move_escrow_and_is_auth_gated() {
    let f = setup();
    let sender = funded_sender(&f, 100);
    let sk = link_key(86);
    let s = salt(&f.env, 86);
    let link = deposit_honest(&f, &sender, &sk, 100, &s, 2000);
    let before = f.token.balance(&f.id);

    // with NO auth available, the whole owner surface is unusable
    f.env.set_auths(&[]);
    assert!(f.client.try_pause(&f.owner).is_err());
    assert!(f.client.try_upgrade(&BytesN::from_array(&f.env, &[7u8; 32]), &f.owner).is_err());

    // the owner surface, exercised with auth, never touches the escrow balance
    f.env.mock_all_auths();
    f.client.pause(&f.owner);
    f.client.unpause(&f.owner);
    assert_eq!(f.token.balance(&f.id), before);

    let p = Address::generate(&f.env);
    f.client.claim(&link, &p, &claim_sig(&f, &sk, &link, &p, 100, &s), &100, &s);
    assert_eq!(f.token.balance(&p), 100);
}

/// The Ownable impl is wired: the handover is two-step, and renounce locks the owner surface
/// for good while escrow keeps flowing.
#[test]
fn ownership_two_step_then_renounce_locks_owner_surface() {
    let f = setup();
    let next = Address::generate(&f.env);
    f.client.transfer_ownership(&next, &1000);
    assert_eq!(f.client.get_owner(), Some(f.owner.clone()), "proposal must not transfer");
    f.client.accept_ownership();
    assert_eq!(f.client.get_owner(), Some(next.clone()));
    f.client.pause(&next);
    assert!(f.client.paused());
    f.client.unpause(&next);

    f.client.renounce_ownership();
    assert_eq!(f.client.get_owner(), None);
    assert!(f.client.try_pause(&next).is_err());
    assert!(f.client.try_upgrade(&BytesN::from_array(&f.env, &[7u8; 32]), &next).is_err());

    let sender = funded_sender(&f, 30);
    let sk = link_key(87);
    let s = salt(&f.env, 87);
    let link = deposit_honest(&f, &sender, &sk, 30, &s, 2000);
    let p = Address::generate(&f.env);
    f.client.claim(&link, &p, &claim_sig(&f, &sk, &link, &p, 30, &s), &30, &s);
    assert_eq!(f.token.balance(&p), 30);
}

/// `upgrade` really reaches the host's wasm swap (it is not a no-op): a hash that is not an
/// uploaded wasm TRAPS, which only happens if the call is actually made.
#[test]
fn upgrade_reaches_the_host_wasm_swap() {
    let f = setup();
    let unknown = BytesN::from_array(&f.env, &[0xABu8; 32]);
    assert!(f.client.try_upgrade(&unknown, &f.owner).is_err());
}

/* ---------------------------------------------------------------------------------------------
 * GLOBAL SOLVENCY over honest AND dishonest commitments (invariants 1 + 10), adapted from
 * contracts/lumen-drop's model-based master property. Each drop commits either to exactly what
 * it escrows (honest) or to another amount (dishonest: a lie up or down, zero and negative
 * included). Every op's result is predicted by the model and asserted exactly, and after every
 * step the escrow's SAC balance must EQUAL the sum of the unsettled `escrowed` amounts.
 * ------------------------------------------------------------------------------------------- */

/// Model state for one drop in the solvency property.
struct Modeled {
    sk: SigningKey,
    link: BytesN<32>,
    sender: Address,
    salt: BytesN<32>,
    escrowed: i128,
    /// What the commitment opens to (== escrowed for an honest drop).
    promised: i128,
    /// Claimed or reclaimed: the one flag both exits share.
    settled: bool,
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    #[test]
    fn global_solvency_exact_over_honest_and_dishonest_commitments(
        drops in proptest::collection::vec(
            (1i128..=300, any::<bool>(), 1i128..=300, any::<bool>()),
            1..=4,
        ),
        ops in proptest::collection::vec((0u8..=4, 0usize..8), 0..=24),
    ) {
        let f = setup();
        let mut model: std::vec::Vec<Modeled> = std::vec::Vec::new();
        for (i, (escrowed, honest, delta, up)) in drops.into_iter().enumerate() {
            let promised = if honest {
                escrowed
            } else if up {
                escrowed + delta
            } else {
                escrowed - delta // may reach zero or below: a commitment is just bytes
            };
            let sk = link_key(100 + i as u8);
            let link = link_pub(&f.env, &sk);
            let s = salt(&f.env, 200 + i as u8);
            let sender = funded_sender(&f, escrowed);
            let c = f.client.commitment_of(&link, &promised, &s);
            f.client.deposit(&sender, &link, &c, &escrowed, &2000);
            model.push(Modeled { sk, link, sender, salt: s, escrowed, promised, settled: false });
        }
        let wrong_salt = salt(&f.env, 0xEE);
        let mut expired = false;

        for (kind, idx) in ops {
            let i = idx % model.len();
            let d = &model[i];
            match kind {
                // 0: claim revealing what the commitment PROMISES; 1: revealing what the escrow
                // HOLDS; 2: the escrowed amount with a wrong salt. The relayer always carries a
                // valid link signature over that exact reveal, so the reveal checks alone decide.
                0..=2 => {
                    let (amount, s) = match kind {
                        0 => (d.promised, d.salt.clone()),
                        1 => (d.escrowed, d.salt.clone()),
                        _ => (d.escrowed, wrong_salt.clone()),
                    };
                    let p = Address::generate(&f.env);
                    let sig = claim_sig(&f, &d.sk, &d.link, &p, amount, &s);
                    let want = if d.settled {
                        Err(Ok(Error::AlreadyClaimed))
                    } else if kind == 2 || amount != d.promised {
                        Err(Ok(Error::BadReveal))
                    } else if amount != d.escrowed {
                        Err(Ok(Error::RevealMismatch))
                    } else {
                        Ok(Ok(()))
                    };
                    let ok = want == Ok(Ok(()));
                    prop_assert_eq!(f.client.try_claim(&d.link, &p, &sig, &amount, &s), want);
                    // a payout gets exactly the escrow or nothing at all
                    let paid = f.token.balance(&p);
                    if ok {
                        prop_assert_eq!(paid, d.escrowed);
                        model[i].settled = true;
                    } else {
                        prop_assert_eq!(paid, 0);
                    }
                }
                3 => {
                    // the sender reclaims
                    let want = if d.settled {
                        Err(Ok(Error::AlreadyClaimed))
                    } else if !expired {
                        Err(Ok(Error::NotExpired))
                    } else {
                        Ok(Ok(()))
                    };
                    let ok = want == Ok(Ok(()));
                    prop_assert_eq!(f.client.try_reclaim(&d.link), want);
                    if ok {
                        prop_assert_eq!(f.token.balance(&d.sender), d.escrowed);
                        model[i].settled = true;
                    }
                }
                _ => {
                    f.env.ledger().set_timestamp(2500); // cross every drop's expiry
                    expired = true;
                }
            }
            let want: i128 = model.iter().filter(|x| !x.settled).map(|x| x.escrowed).sum();
            prop_assert_eq!(
                f.token.balance(&f.id), want,
                "escrow balance diverged from the model"
            );
        }
    }
}
