# Tier 2 source material: one Groth16 (BLS12-381) verification

Everything behind the Tier 2 numbers in [`../../ZK_SPIKE_REPORT.md`](../../ZK_SPIKE_REPORT.md), so they
can be re-derived from this repository alone.

**What this is:** the upstream example verifier from `stellar/soroban-examples`
(`groth16_verifier/contracts/bls12_381_verifier`, commit `03d42aa6b973dcf3a453a99d0c6a6e8d25a196e2`),
with its own test fixtures. It verifies the example proofs that ship with it, such as the circom
circuit `a * b = c` with the public output `c = 33`. **It is the upstream example circuit, not a
range proof of our own, and it hides no Lumenia amount.** Upstream says of it: "This project is for
demonstration purposes only" and "It has **not** undergone security auditing".

## Files

| Path | Origin |
|---|---|
| `src/lib.rs` | upstream, unchanged |
| `tests/arkworks.rs`, `tests/circom.rs`, `tests/gnark.rs`, `tests/modulo.rs`, `tests/common/mod.rs` | upstream, unchanged |
| `tests/data/{circom,gnark,arkworks}/` | upstream fixtures (proofs, verification keys, public inputs, fixture READMEs) and the circom circuit source, unchanged; the larger generated files (powers of tau, zkey, r1cs, witness wasm) are left upstream |
| `Cargo.toml` | upstream's, changed (noted in the file): `soroban-sdk` re-pinned from `"28"` to `"=26.1.1"` (the version this repository's contracts use), `rust-version` dropped, and the upstream workspace's release profile plus an empty `[workspace]` added so the crate builds on its own |
| `Cargo.lock` | resolved here (soroban-env-host 26.1.4, as `contracts/lumen-drop`) |
| `tests/bench.rs` | ours: runs one `verify_proof` per fixture in the host's budget model and prints the cost |
| `tests/args_xdr.rs` | ours: pins the exact bytes of the `verify_proof` arguments, which the on-chain script checks its own encoding against |
| `bench_output.txt` | the output of `tests/bench.rs` (re-run here on 2026-10-09; identical to the 2026-10-06 run the report first quoted) |
| `rpc/` | the network fee and limit settings read with `getLedgerEntries` on 2026-10-06 (`fetched_at.txt`), raw and decoded, testnet and mainnet |
| `onchain.json` | the testnet run of `apps/sponsor/src/spike12-groth16.ts`: upload, create, one `verify_proof`, and simulation-only reads |
| `stellar-expert-verify-proof.png` | stellar.expert's page for that `verify_proof` transaction, invocation expanded, captured 2026-10-09 |
| `LICENSE` | the upstream license (Apache License 2.0), which covers the upstream files above |

## Reproduce

```bash
cd evidence/spike11/tier2
stellar contract build          # stellar-cli 27.1.0, rustc 1.96.0 -> target/wasm32v1-none/release/bls12_381_verifier.wasm
shasum -a 256 target/wasm32v1-none/release/bls12_381_verifier.wasm
#   40706c83e703e9173ea1b1ad32ee84b19f0d26125349fe0f904f6c39364344c1  (4,781 bytes)
cargo test                      # 19 tests: 8 upstream + 2 upstream modulo + 6 bench + 3 argument pins
cargo test --test bench -- --nocapture --test-threads=1   # the numbers in bench_output.txt

# the on-chain run (testnet only; any funded throwaway testnet key)
OFFLINE=1 pnpm --filter @lumenia/sponsor exec tsx src/spike12-groth16.ts   # self-check, 17/17, no network
SPIKE12_IDENTITY=<testnet identity> pnpm --filter @lumenia/sponsor exec tsx src/spike12-groth16.ts
```

The build above gave the same hash in two different checkouts, and that hash is the code deployed on
testnet as
[`CBMYSVI2KCESZC6BNAKDTKHJKIA22EKXLOILPYVPQYIGVJ44R7PL75MD`](https://stellar.expert/explorer/testnet/contract/CBMYSVI2KCESZC6BNAKDTKHJKIA22EKXLOILPYVPQYIGVJ44R7PL75MD).
The wasm itself is not committed (this repository does not track build output); the code entry on
testnet is its public copy.

## The numbers

| | host budget model (local, `bench_output.txt`) | testnet, measured (`onchain.json`) |
|---|---:|---:|
| CPU instructions, circom fixture (1 public input) | 41,347,090 | **41,460,357** consumed (stellar-core's `core_metrics`; stellar.expert shows the same) |
| CPU instructions declared by the transaction | | 43,118,122 (from the simulation; the fee is charged on this figure) |
| memory | 1,500,248 bytes | 1,520,463 bytes |
| fee charged | | **39,623 stroops = 0.0039623 XLM** |
| arkworks fixture (9 public inputs) | 68,660,030 | 71,570,904 declared (simulated, not submitted) |

The fee breaks down exactly as the live settings in `rpc/` predict: CPU 30,183 (43,118,122 x 7 /
10,000, rounded up) + transaction size 738 (1,860 bytes x 406 / 1,024) + history 8,562 ((1,860 + 300) x
4,059 / 1,024) = 39,483 non-refundable, plus 40 refundable (the return value) and the 100-stroop
inclusion fee. A wrong public input (`22` instead of `33`) simulates to `false` at the same cost.
