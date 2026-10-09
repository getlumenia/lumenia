// Added for the Lumenia D2 spike; not part of soroban-examples.
// Cost measurement for ONE Groth16 (BLS12-381) verification of the
// soroban-examples fixtures, in the soroban-sdk 26.1.1 host budget model.
// Build the wasm first (`stellar contract build` writes it under target/), then
// run: cargo test --test bench -- --nocapture --test-threads=1
#[allow(dead_code)]
mod common;

use common::load_fixture;
use bls12_381_verifier::{Groth16Verifier, Groth16VerifierClient};
use soroban_sdk::{
    testutils::budget::ContractCostType,
    xdr::{Limits, ScVal, WriteXdr},
    Env, TryFromVal, Val, IntoVal,
};

const WASM: &[u8] = include_bytes!("../target/wasm32v1-none/release/bls12_381_verifier.wasm");

fn xdr_len<T: IntoVal<Env, Val>>(env: &Env, v: &T) -> usize {
    let val: Val = v.into_val(env);
    let sc = ScVal::try_from_val(env, &val).unwrap();
    sc.to_xdr(Limits::none()).unwrap().len()
}

fn run(fixture_name: &str, as_wasm: bool) {
    let env = Env::default();
    let fixture = load_fixture(&env, fixture_name);
    let contract_id = if as_wasm {
        env.register(WASM, ())
    } else {
        env.register(Groth16Verifier, ())
    };
    let client = Groth16VerifierClient::new(&env, &contract_id);

    let n_pub = fixture.public_signals.len();
    let vk_xdr = xdr_len(&env, &fixture.verification_key);
    let proof_xdr = xdr_len(&env, &fixture.proof);
    let pub_xdr = xdr_len(&env, &fixture.public_signals);
    let ic_len = fixture.verification_key.ic.len();

    let ok = client.verify_proof(
        &fixture.verification_key,
        &fixture.proof,
        &fixture.public_signals,
    );
    assert!(ok);

    let res = env.cost_estimate().resources();
    let fee = env.cost_estimate().fee();
    let budget = env.cost_estimate().budget();
    println!(
        "=== fixture={} mode={} ===",
        fixture_name,
        if as_wasm { "WASM" } else { "native" }
    );
    println!("public_inputs={} ic_points={}", n_pub, ic_len);
    println!(
        "raw_bytes: proof={} (G1 96 + G2 192 + G1 96), vk={} (G1 96 + 3*G2 192 + {}*G1 96), public_inputs={} (32 each)",
        96 + 192 + 96,
        96 + 3 * 192 + ic_len * 96,
        ic_len,
        n_pub * 32
    );
    println!(
        "scval_xdr_bytes: vk={} proof={} public_inputs={} total_args={}",
        vk_xdr,
        proof_xdr,
        pub_xdr,
        vk_xdr + proof_xdr + pub_xdr
    );
    println!(
        "resources: instructions={} mem_bytes={} disk_read_entries={} memory_read_entries={} write_entries={}",
        res.instructions,
        res.mem_bytes,
        res.disk_read_entries,
        res.memory_read_entries,
        res.write_entries
    );
    println!(
        "sdk_fee_estimate(2024-12-11 pubnet snapshot, stroops): total={} instructions={}",
        fee.total, fee.instructions
    );
    println!(
        "budget: cpu={} mem={}",
        budget.cpu_instruction_cost(),
        budget.memory_bytes_cost()
    );
    for ct in [
        ContractCostType::Bls12381Pairing,
        ContractCostType::Bls12381G1Mul,
        ContractCostType::Bls12381G1Add,
        ContractCostType::Bls12381G1CheckPointOnCurve,
        ContractCostType::Bls12381G1CheckPointInSubgroup,
        ContractCostType::Bls12381G2CheckPointOnCurve,
        ContractCostType::Bls12381G2CheckPointInSubgroup,
        ContractCostType::Bls12381G1ProjectiveToAffine,
        ContractCostType::Bls12381DecodeFp,
        ContractCostType::Bls12381EncodeFp,
        ContractCostType::Bls12381FrFromU256,
        ContractCostType::VmInstantiation,
        ContractCostType::WasmInsnExec,
        ContractCostType::ParseWasmInstructions,
    ] {
        let t = budget.tracker(ct);
        println!(
            "  {:?}: iterations={} inputs={:?} cpu={} mem={}",
            ct, t.iterations, t.inputs, t.cpu, t.mem
        );
    }
    println!("--- trackers (all cost types) ---");
    for ct in ContractCostType::variants() {
        let t = budget.tracker(ct);
        println!(
            "TRACKER {:?} {} {} {} {}",
            ct,
            t.iterations,
            t.inputs.map(|x| x.to_string()).unwrap_or("-".into()),
            t.cpu,
            t.mem
        );
    }
    println!("--- full budget table ---");
    budget.print();
}

#[test]
fn bench_circom_native() {
    run("circom", false);
}
#[test]
fn bench_circom_wasm() {
    run("circom", true);
}
#[test]
fn bench_gnark_native() {
    run("gnark", false);
}
#[test]
fn bench_gnark_wasm() {
    run("gnark", true);
}
#[test]
fn bench_arkworks_native() {
    run("arkworks", false);
}
#[test]
fn bench_arkworks_wasm() {
    run("arkworks", true);
}
