// Added for the Lumenia D2 spike; not part of soroban-examples.
//
// Pins the exact bytes of the three `verify_proof` arguments (verification key, proof, public
// inputs), as ScVal XDR, for each upstream fixture, exactly as the upstream parser in
// tests/common builds them. apps/sponsor/src/spike12-groth16.ts encodes the same fixture files on
// its own and checks its bytes against these digests in its OFFLINE self-check, so the transaction
// it sends to testnet carries what the upstream tests verify.
//
// Run: cargo test --test args_xdr -- --nocapture
#[allow(dead_code)]
mod common;

use common::load_fixture;
use soroban_sdk::{
    xdr::{Limits, ScVal, WriteXdr},
    Bytes, Env, IntoVal, TryFromVal, Val,
};

fn xdr_of<T: IntoVal<Env, Val>>(env: &Env, v: &T) -> std::vec::Vec<u8> {
    let val: Val = v.into_val(env);
    ScVal::try_from_val(env, &val)
        .unwrap()
        .to_xdr(Limits::none())
        .unwrap()
}

/// (length, sha256 hex) of xdr(vk) || xdr(proof) || xdr(public inputs).
fn args_digest(fixture: &str) -> (usize, String) {
    let env = Env::default();
    let f = load_fixture(&env, fixture);
    let mut all = xdr_of(&env, &f.verification_key);
    all.extend(xdr_of(&env, &f.proof));
    all.extend(xdr_of(&env, &f.public_signals));
    let digest = env.crypto().sha256(&Bytes::from_slice(&env, &all)).to_array();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    println!("{fixture}: {} bytes, sha256 {hex}", all.len());
    (all.len(), hex)
}

#[test]
fn circom_args_xdr_is_pinned() {
    let (len, hex) = args_digest("circom");
    assert_eq!((len, hex.as_str()), (1512, "189ff04b30e1b2b04b0e9d61986b63f524b5b4e56132ed30110e039cc981e9b7"));
}

#[test]
fn gnark_args_xdr_is_pinned() {
    let (len, hex) = args_digest("gnark");
    assert_eq!((len, hex.as_str()), (1512, "7166968b900e7ba4e11ead38c01b36ce967bdd14c90738add7efd57f28f02ce0"));
}

#[test]
fn arkworks_args_xdr_is_pinned() {
    let (len, hex) = args_digest("arkworks");
    assert_eq!((len, hex.as_str()), (2632, "fb0715a96dcddb497e6d737811b478df799d3f93e53702849781e14c310830c7"));
}
