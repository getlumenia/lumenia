mod common;

use common::{deploy, load_fixture, replace_first_signal};
use soroban_sdk::Env;

#[test]
fn verifies_circom_fixture_with_supplied_vk() {
    let env = Env::default();

    let fixture = load_fixture(&env, "circom");
    let client = deploy(&env);

    assert!(client.verify_proof(
        &fixture.verification_key,
        &fixture.proof,
        &fixture.public_signals
    ));
}

#[test]
fn rejects_circom_fixture_with_wrong_public_signal() {
    let env = Env::default();
    let fixture = load_fixture(&env, "circom");
    let client = deploy(&env);
    let wrong_signals = replace_first_signal(&env, &fixture.public_signals, "22");

    assert!(!client.verify_proof(&fixture.verification_key, &fixture.proof, &wrong_signals));
}
