#[allow(dead_code)]
mod common;

use common::fr_from_str;
use soroban_sdk::Env;

#[test]
fn caller_accepts_largest_canonical_public_input() {
    let env = Env::default();

    fr_from_str(
        &env,
        "52435875175126190479447740508185965837690552500527637822603658699938581184512",
    );
}

#[test]
#[should_panic(expected = "public signal must be canonical")]
fn caller_rejects_noncanonical_public_input() {
    let env = Env::default();

    fr_from_str(
        &env,
        "52435875175126190479447740508185965837690552500527637822603658699938581184513",
    );
}
