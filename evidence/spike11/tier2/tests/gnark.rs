mod common;

use bls12_381_verifier::Groth16Error;
use common::{deploy, load_fixture, replace_first_signal};
use soroban_sdk::{Env, vec};

#[test]
fn verifies_gnark_fixture_with_supplied_vk() {
    let env = Env::default();

    let fixture = load_fixture(&env, "gnark");
    let client = deploy(&env);

    assert!(client.verify_proof(
        &fixture.verification_key,
        &fixture.proof,
        &fixture.public_signals
    ));
}

#[test]
fn rejects_gnark_fixture_with_wrong_public_signal() {
    let env = Env::default();
    let fixture = load_fixture(&env, "gnark");
    let client = deploy(&env);
    let wrong_signals = replace_first_signal(&env, &fixture.public_signals, "23");

    assert!(!client.verify_proof(&fixture.verification_key, &fixture.proof, &wrong_signals));
}

#[test]
fn rejects_wrong_public_signal_count() {
    let env = Env::default();
    let fixture = load_fixture(&env, "gnark");
    let client = deploy(&env);
    let wrong_signals = vec![&env];

    assert_eq!(
        client.try_verify_proof(&fixture.verification_key, &fixture.proof, &wrong_signals),
        Err(Ok(Groth16Error::MalformedVerifyingKey))
    );
}

#[test]
fn supplied_verification_key_switches_between_bls_fixture_sets() {
    let env = Env::default();

    let gnark_fixture = load_fixture(&env, "gnark");
    let circom_fixture = load_fixture(&env, "circom");
    let client = deploy(&env);

    assert!(!client.verify_proof(
        &gnark_fixture.verification_key,
        &circom_fixture.proof,
        &circom_fixture.public_signals
    ));
    assert!(client.verify_proof(
        &circom_fixture.verification_key,
        &circom_fixture.proof,
        &circom_fixture.public_signals
    ));
}
