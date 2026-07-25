#![no_main]
//! FUZZ TARGET — global escrow solvency under arbitrary operation sequences.
//!
//! The libFuzzer counterpart to the `global_solvency_exact_over_mixed_population` proptest:
//! the fuzzer drives a coverage-guided search over sequences of deposits, claims, reclaims,
//! group creates, share claims and pool reclaims (with arbitrary amounts, slot counts and
//! expiry crossings) and asserts, after EVERY step, the master invariant:
//!
//!   USDC.balance(contract) == Σ unclaimed single-drop amounts + Σ pool remainings
//!
//! Anything that breaks fund conservation — a missing guard, a wrong arithmetic edge, an
//! unexpected state transition — shows up as a failing assertion with a minimized input.
//!
//! RUN: cargo +nightly fuzz run escrow_solvency -- -max_total_time=300

use ed25519_dalek::{Signer, SigningKey};
use libfuzzer_sys::fuzz_target;
use lumen_drop::{LumenDrop, LumenDropClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Bytes, BytesN, Env};

/// One fuzzer-chosen operation against the escrow.
#[derive(Debug, arbitrary::Arbitrary)]
enum Op {
    Deposit { who: u8, amount: i64 },
    Claim { who: u8 },
    Reclaim { who: u8 },
    CreatePool { who: u8, amount: i64, slots: u8 },
    ClaimShare { who: u8 },
    ReclaimPool { who: u8 },
    AdvanceTime,
}

#[derive(Debug, arbitrary::Arbitrary)]
struct Input {
    ops: Vec<Op>,
}

const EXPIRY: u64 = 5_000;
const LATER: u64 = 9_000;
/// Bounded populations keep the fuzzer's search in the interesting region.
const SLOTS: usize = 4;

fn sign(env: &Env, sk: &SigningKey, msg: &Bytes) -> BytesN<64> {
    let bytes: Vec<u8> = msg.iter().collect();
    BytesN::from_array(env, &sk.sign(&bytes).to_bytes())
}

fuzz_target!(|input: Input| {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1);

    let sac_admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(sac_admin);
    let token_addr = sac.address();
    let id = env.register(LumenDrop, (token_addr.clone(), owner));
    let client = LumenDropClient::new(&env, &id);
    let token = token::Client::new(&env, &token_addr);
    let minter = token::StellarAssetClient::new(&env, &token_addr);

    // Model state, one slot per link key. `singles[i]` = Some(amount) while unclaimed.
    let mut singles: [Option<i128>; SLOTS] = [None; SLOTS];
    let mut pools: [Option<(i128, i128)>; SLOTS] = [None; SLOTS]; // (amount_per, remaining)
    let senders: Vec<Address> = (0..SLOTS).map(|_| Address::generate(&env)).collect();
    let skeys: Vec<SigningKey> = (0..SLOTS * 2)
        .map(|i| SigningKey::from_bytes(&[i as u8 + 1; 32]))
        .collect();
    let link_of = |i: usize| BytesN::from_array(&env, &skeys[i].verifying_key().to_bytes());

    for op in input.ops.into_iter().take(32) {
        match op {
            Op::Deposit { who, amount } => {
                let i = who as usize % SLOTS;
                let amt = (amount as i128).clamp(-10, 10_000);
                if amt > 0 {
                    minter.mint(&senders[i], &amt);
                }
                if client
                    .try_deposit(&senders[i], &link_of(i), &amt, &EXPIRY)
                    .is_ok()
                {
                    singles[i] = Some(amt);
                }
            }
            Op::Claim { who } => {
                let i = who as usize % SLOTS;
                let link = link_of(i);
                let payout = Address::generate(&env);
                let sig = sign(&env, &skeys[i], &client.claim_message(&1, &link, &payout));
                if client.try_claim(&link, &payout, &sig).is_ok() {
                    singles[i] = None;
                }
            }
            Op::Reclaim { who } => {
                let i = who as usize % SLOTS;
                if client.try_reclaim(&link_of(i)).is_ok() {
                    singles[i] = None;
                }
            }
            Op::CreatePool { who, amount, slots } => {
                let i = who as usize % SLOTS;
                let amt = (amount as i128).clamp(-10, 10_000);
                let n = (slots as u32 % 8) + 1;
                if amt > 0 {
                    minter.mint(&senders[i], &amt);
                }
                let link = link_of(SLOTS + i);
                if client
                    .try_create_drop(&senders[i], &link, &amt, &n, &EXPIRY)
                    .is_ok()
                {
                    pools[i] = Some((amt / n as i128, amt));
                }
            }
            Op::ClaimShare { who } => {
                let i = who as usize % SLOTS;
                let k = SLOTS + i;
                let link = link_of(k);
                let payout = Address::generate(&env);
                let sig = sign(&env, &skeys[k], &client.claim_message(&2, &link, &payout));
                if client.try_claim_share(&link, &payout, &sig).is_ok() {
                    if let Some((per, rem)) = pools[i] {
                        pools[i] = Some((per, rem - per));
                    }
                }
            }
            Op::ReclaimPool { who } => {
                let i = who as usize % SLOTS;
                if client.try_reclaim_pool(&link_of(SLOTS + i)).is_ok() {
                    if let Some((per, _)) = pools[i] {
                        pools[i] = Some((per, 0));
                    }
                }
            }
            Op::AdvanceTime => env.ledger().set_timestamp(LATER),
        }

        // THE INVARIANT: the escrow holds exactly what the model says is still owed.
        let expected: i128 = singles.iter().flatten().sum::<i128>()
            + pools.iter().flatten().map(|(_, rem)| *rem).sum::<i128>();
        assert_eq!(
            token.balance(&id),
            expected,
            "escrow balance diverged from the model (solvency broken)"
        );
    }
});
