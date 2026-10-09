/**
 * ============================================================================
 *  SPIKE #12 - One Groth16 verification on testnet: the upstream BLS12-381 example (SOW 2, D2 Tier 2)
 * ============================================================================
 *
 *  GOAL. Replace the D2 spike's Tier 2 host-budget estimate with a number measured on the live
 *  network: deploy the upstream stellar/soroban-examples BLS12-381 Groth16 verifier (re-pinned to
 *  soroban-sdk 26.1.1; source, fixtures and the bench harness are in evidence/spike11/tier2/) to
 *  TESTNET and call verify_proof ONCE with the example's own circom fixture (a * b = c, public c = 33).
 *
 *  This is the UPSTREAM EXAMPLE CIRCUIT, not a range proof of our own. It hides no Lumenia amount and
 *  touches no escrow: it measures what one BLS12-381 Groth16 verification costs on chain today.
 *
 *  RECORDED (evidence/spike11/tier2/onchain.json): the wasm upload, the contract create and the one
 *  submitted verify_proof (hash, ledger, fee charged, the resource fee split from the meta, the
 *  simulated resources, the transaction size, the returned bool), plus simulation-only reads that
 *  are never submitted: the same proof against a wrong public input (must return false), and the
 *  gnark (1 public input) and arkworks (9 public inputs) fixtures.
 *
 *  KEY. Any funded TESTNET key, held in memory only and never written anywhere. Either a stellar-cli
 *  identity, which the script asks `stellar keys secret <name>` for, or SPIKE12_SECRET already set in
 *  the environment:
 *    stellar keys generate <name> --network testnet --fund
 *    SPIKE12_IDENTITY=<name> pnpm --filter @lumenia/sponsor exec tsx src/spike12-groth16.ts
 *  The script refuses every network but testnet before its first call, and prints only the public key.
 *
 *  RUN:  OFFLINE=1 ...   the self-check: fixture parsing, on-curve checks, byte layouts, and the
 *                        argument bytes against the digests that evidence/spike11/tier2/tests/args_xdr.rs
 *                        pins on the upstream parser. No network, no key.
 *        WASM=<path>     the verifier wasm (default evidence/spike11/tier2/target/wasm32v1-none/release/
 *                        bls12_381_verifier.wasm, from `stellar contract build` in that folder); its
 *                        sha256 must be WASM_SHA256 below.
 *        INCLUSION_FEE=<stroops>  the inclusion fee offered per transaction (default 10000, as spike 11)
 * ============================================================================
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

/* ---------- network: testnet, and only testnet ---------- */
const NET = Networks.TESTNET;
const RPC_URL = "https://soroban-testnet.stellar.org";
const TESTNET_HOSTS = ["soroban-testnet.stellar.org"];
/** Printed into the evidence, never fetched. */
const EXPLORER = "https://stellar.expert/explorer/testnet";

/* ---------- what is measured ---------- */
/** sha256 of the verifier wasm built from evidence/spike11/tier2 (stellar-cli 27.1.0, rustc 1.96.0, wasm32v1-none). */
const WASM_SHA256 = "40706c83e703e9173ea1b1ad32ee84b19f0d26125349fe0f904f6c39364344c1";
/** The upstream repository and commit the verifier source and fixtures come from. */
const UPSTREAM = "stellar/soroban-examples@03d42aa6b973dcf3a453a99d0c6a6e8d25a196e2 groth16_verifier/contracts/bls12_381_verifier";
/**
 * Byte length and sha256 of xdr(verification_key) || xdr(proof) || xdr(public_inputs) as the upstream
 * parser builds them (evidence/spike11/tier2/tests/args_xdr.rs asserts the same three values).
 */
const PINNED_ARGS: Record<FixtureName, { len: number; sha256: string }> = {
  circom: { len: 1512, sha256: "189ff04b30e1b2b04b0e9d61986b63f524b5b4e56132ed30110e039cc981e9b7" },
  gnark: { len: 1512, sha256: "7166968b900e7ba4e11ead38c01b36ce967bdd14c90738add7efd57f28f02ce0" },
  arkworks: { len: 2632, sha256: "fb0715a96dcddb497e6d737811b478df799d3f93e53702849781e14c310830c7" },
};
/** The host-budget estimate the report carried before this run (bench_output.txt, wasm mode). */
const HOST_MODEL_INSTRUCTIONS: Record<FixtureName, number> = { circom: 41_347_090, gnark: 41_347_090, arkworks: 68_660_030 };

/* ---------- paths ---------- */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TIER2 = join(REPO_ROOT, "evidence", "spike11", "tier2");
const FIXTURES = join(TIER2, "tests", "data");
const OUT_PATH = join(TIER2, "onchain.json");
const WASM_PATH = (() => {
  const w = process.env.WASM;
  if (!w) return join(TIER2, "target", "wasm32v1-none", "release", "bls12_381_verifier.wasm");
  return isAbsolute(w) ? w : join(REPO_ROOT, w);
})();

/* ---------- knobs ---------- */
const OFFLINE = process.env.OFFLINE === "1";
const INCLUSION_FEE = String(intEnv("INCLUSION_FEE", 10_000, 100, 10_000_000));
const POLL_MS = 500;
const SETTLE_TIMEOUT_MS = 90_000;
/** A read-only simulation needs a source account, not an existing one (as in spike 11). */
const NULL_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const t0 = Date.now();
const step = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in [${min}, ${max}], got "${raw}"`);
  return n;
}

function refuse(why: string): never {
  console.error(`\nREFUSED (testnet only): ${why}`);
  process.exit(2);
}

/** Checked before the first network call; the RPC is then asked which network it serves. */
function testnetRefusal(passphrase: string, urls: string[]): string | null {
  if (passphrase !== Networks.TESTNET) return `the network passphrase is not testnet's: "${passphrase}"`;
  for (const u of urls) {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      return `not a URL: ${u}`;
    }
    if (url.protocol !== "https:" || !TESTNET_HOSTS.includes(url.host)) return `not a testnet host: ${u}`;
  }
  return null;
}

/* ---------- BLS12-381: the field, the curve checks, the host's byte layout ---------- */

/** Base field modulus p and scalar field modulus r of BLS12-381. */
const P = 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaabn;
const R = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;
/** The largest canonical public input, as the upstream tests/modulo.rs spells it (r - 1). */
const UPSTREAM_MAX_CANONICAL = 52435875175126190479447740508185965837690552500527637822603658699938581184512n;

const mod = (a: bigint, m: bigint = P) => ((a % m) + m) % m;
type Fp2 = readonly [bigint, bigint]; // c0 + c1 * u, u^2 = -1
const f2mul = (a: Fp2, b: Fp2): Fp2 => [mod(a[0] * b[0] - a[1] * b[1]), mod(a[0] * b[1] + a[1] * b[0])];
const f2add = (a: Fp2, b: Fp2): Fp2 => [mod(a[0] + b[0]), mod(a[1] + b[1])];
const f2eq = (a: Fp2, b: Fp2) => a[0] === b[0] && a[1] === b[1];

/** G1: y^2 = x^3 + 4 over Fp. */
const onG1 = (x: bigint, y: bigint) => mod(y * y) === mod(x * x * x + 4n);
/** G2: y^2 = x^3 + 4(1 + u) over Fp2. */
const onG2 = (x: Fp2, y: Fp2) => f2eq(f2mul(y, y), f2add(f2mul(f2mul(x, x), x), [4n, 4n]));

/** A decimal string from the fixture JSON, checked canonical (below the modulus). */
function canon(s: string, m: bigint, what: string): bigint {
  if (!/^[0-9]+$/.test(s)) throw new Error(`${what}: not a decimal integer: "${s}"`);
  const v = BigInt(s);
  if (v >= m) throw new Error(`${what}: not canonical (>= modulus)`);
  return v;
}

/** 48-byte big-endian field element. */
function be48(v: bigint): Buffer {
  const hex = v.toString(16).padStart(96, "0");
  if (hex.length !== 96) throw new Error("field element wider than 48 bytes");
  return Buffer.from(hex, "hex");
}

/** The host's uncompressed G1 layout: be(X) || be(Y), 96 bytes, flag bits (top 3 of byte 0) clear. */
function g1Bytes(p: readonly [string, string, string], what: string): Buffer {
  if (p[2] !== "1") throw new Error(`${what}: not affine (z = ${p[2]})`);
  const x = canon(p[0], P, `${what}.x`);
  const y = canon(p[1], P, `${what}.y`);
  if (!onG1(x, y)) throw new Error(`${what}: not on the G1 curve`);
  const b = Buffer.concat([be48(x), be48(y)]);
  if ((b[0]! & 0xe0) !== 0) throw new Error(`${what}: flag bits set`);
  return b;
}

/** The host's uncompressed G2 layout: be(X.c1) || be(X.c0) || be(Y.c1) || be(Y.c0), 192 bytes. */
function g2Bytes(p: readonly [readonly [string, string], readonly [string, string], readonly [string, string]], what: string): Buffer {
  if (p[2][0] !== "1" || p[2][1] !== "0") throw new Error(`${what}: not affine`);
  const x: Fp2 = [canon(p[0][0], P, `${what}.x.c0`), canon(p[0][1], P, `${what}.x.c1`)];
  const y: Fp2 = [canon(p[1][0], P, `${what}.y.c0`), canon(p[1][1], P, `${what}.y.c1`)];
  if (!onG2(x, y)) throw new Error(`${what}: not on the G2 curve`);
  const b = Buffer.concat([be48(x[1]), be48(x[0]), be48(y[1]), be48(y[0])]);
  if ((b[0]! & 0xe0) !== 0) throw new Error(`${what}: flag bits set`);
  return b;
}

/* ---------- the fixtures, as verify_proof arguments ---------- */

type FixtureName = "circom" | "gnark" | "arkworks";
type G1Json = [string, string, string];
type G2Json = [[string, string], [string, string], [string, string]];
interface VkJson {
  vk_alpha_1: G1Json;
  vk_beta_2: G2Json;
  vk_gamma_2: G2Json;
  vk_delta_2: G2Json;
  IC: G1Json[];
}
interface ProofJson {
  pi_a: G1Json;
  pi_b: G2Json;
  pi_c: G1Json;
  publicSignals?: string[];
}

interface Args {
  fixture: FixtureName;
  publicInputs: string[];
  vk: xdr.ScVal;
  proof: xdr.ScVal;
  inputs: xdr.ScVal;
  xdrLen: number;
  sha256: string;
}

const readJson = <T>(...parts: string[]): T => JSON.parse(readFileSync(join(FIXTURES, ...parts), "utf8")) as T;

/** A contracttype struct as the host expects it: an ScMap with Symbol keys in sorted order. */
function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const names = Object.keys(fields).sort();
  return xdr.ScVal.scvMap(names.map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: fields[k]! })));
}

function argsFor(fixture: FixtureName, override?: string[]): Args {
  const vk = readJson<VkJson>(fixture, "verification_key.json");
  const pf = readJson<ProofJson>(fixture, "proof.json");
  const signals = override ?? pf.publicSignals ?? readJson<string[]>(fixture, "public.json");
  for (const [i, s] of signals.entries()) canon(s, R, `${fixture} public input ${i}`);
  if (signals.length + 1 !== vk.IC.length) throw new Error(`${fixture}: ${signals.length} public inputs for ${vk.IC.length} IC points`);
  const vkVal = struct({
    alpha: xdr.ScVal.scvBytes(g1Bytes(vk.vk_alpha_1, `${fixture} vk.alpha`)),
    beta: xdr.ScVal.scvBytes(g2Bytes(vk.vk_beta_2, `${fixture} vk.beta`)),
    gamma: xdr.ScVal.scvBytes(g2Bytes(vk.vk_gamma_2, `${fixture} vk.gamma`)),
    delta: xdr.ScVal.scvBytes(g2Bytes(vk.vk_delta_2, `${fixture} vk.delta`)),
    ic: xdr.ScVal.scvVec(vk.IC.map((p, i) => xdr.ScVal.scvBytes(g1Bytes(p, `${fixture} vk.ic[${i}]`)))),
  });
  const proofVal = struct({
    a: xdr.ScVal.scvBytes(g1Bytes(pf.pi_a, `${fixture} proof.a`)),
    b: xdr.ScVal.scvBytes(g2Bytes(pf.pi_b, `${fixture} proof.b`)),
    c: xdr.ScVal.scvBytes(g1Bytes(pf.pi_c, `${fixture} proof.c`)),
  });
  const inputsVal = xdr.ScVal.scvVec(signals.map((s) => nativeToScVal(BigInt(s), { type: "u256" })));
  const all = Buffer.concat([vkVal.toXDR(), proofVal.toXDR(), inputsVal.toXDR()]);
  return {
    fixture,
    publicInputs: signals,
    vk: vkVal,
    proof: proofVal,
    inputs: inputsVal,
    xdrLen: all.length,
    sha256: hash(all).toString("hex"),
  };
}

/* ---------- OFFLINE: the self-check ---------- */

function selfCheck(): void {
  let pass = 0;
  let fail = 0;
  const ok = (cond: boolean, what: string) => {
    if (cond) pass++;
    else {
      fail++;
      console.log(`  FAIL ${what}`);
    }
  };
  const throws = (f: () => unknown, what: string) => {
    try {
      f();
      ok(false, what);
    } catch {
      ok(true, what);
    }
  };

  ok(R - 1n === UPSTREAM_MAX_CANONICAL, "r - 1 is the upstream largest canonical public input");
  ok(be48(P - 1n).length === 48 && be48(0n).length === 48, "be48 is 48 bytes");
  // The generators are on their curves (the checks are not vacuous) and a moved point is not.
  const g1x = BigInt("0x17f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb");
  const g1y = BigInt("0x08b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1");
  ok(onG1(g1x, g1y), "the G1 generator is on G1");
  ok(!onG1(g1x, g1y + 1n), "a moved G1 point is not");
  // The SDK's own example bytes for the G1 generator (soroban-sdk 26.1.1 crypto/bls12_381.rs).
  ok(
    g1Bytes([g1x.toString(), g1y.toString(), "1"], "G1 generator").toString("hex") ===
      "17f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb08b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1",
    "G1 layout matches the SDK's documented generator bytes",
  );
  const g2: G2Json = [
    [
      "352701069587466618187139116011060144890029952792775240219908644239793785735715026873347600343865175952761926303160",
      "3059144344244213709971259814753781636986470325476647558659373206291635324768958432433509563104347017837885763365758",
    ],
    [
      "1985150602287291935568054521177171638300868978215655730859378665066344726373823718423869104263333984641494340347905",
      "927553665492332455747201965776037880757740193453592970025027978793976877002675564980949289727957565575433344219582",
    ],
    ["1", "0"],
  ];
  const g2b = g2Bytes(g2, "G2 generator");
  ok(g2b.length === 192, "G2 is 192 bytes");
  ok(g2b.subarray(0, 48).equals(be48(BigInt(g2[0][1]))), "G2 layout puts X.c1 first");
  ok(g2b.subarray(48, 96).equals(be48(BigInt(g2[0][0]))), "then X.c0");
  throws(() => g2Bytes([[g2[0][1], g2[0][0]], g2[1], g2[2]], "swapped"), "a G2 point with c0/c1 swapped is refused (not on the curve)");
  throws(() => canon(R.toString(), R, "r"), "a public input equal to r is refused (not canonical)");

  for (const name of ["circom", "gnark", "arkworks"] as const) {
    const a = argsFor(name);
    ok(a.xdrLen === PINNED_ARGS[name].len, `${name}: argument XDR is ${PINNED_ARGS[name].len} bytes (got ${a.xdrLen})`);
    ok(a.sha256 === PINNED_ARGS[name].sha256, `${name}: argument XDR sha256 matches tests/args_xdr.rs (got ${a.sha256})`);
  }
  const wrong = argsFor("circom", ["22"]);
  ok(wrong.sha256 !== PINNED_ARGS.circom.sha256, "the wrong-input variant differs from the real arguments");

  console.log(`spike12 OFFLINE self-check: ${pass}/${pass + fail}`);
  if (fail) process.exit(1);
}

/* ---------- RPC ---------- */

const RPC = new rpc.Server(RPC_URL);

const codeKey = (h: Buffer) => xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: h }));
const instanceKey = (contract: string) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

async function entry(key: xdr.LedgerKey): Promise<rpc.Api.LedgerEntryResult | null> {
  const res = await RPC.getLedgerEntries(key);
  return res.entries[0] ?? null;
}

/** The id createCustomContract will get: sha256 of HashIdPreimage::ContractId(network, deployer, salt). */
function contractIdFor(deployer: string, salt: Buffer): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(NET)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(deployer).toScAddress(), salt }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

interface SimNumbers {
  minResourceFee: string;
  resourceFee: string;
  instructions: number;
  diskReadBytes: number;
  writeBytes: number;
  footprintReadOnly: number;
  footprintReadWrite: number;
}

function simNumbers(sim: rpc.Api.SimulateTransactionSuccessResponse): SimNumbers {
  const data = sim.transactionData.build();
  const res = data.resources();
  return {
    minResourceFee: sim.minResourceFee,
    resourceFee: data.resourceFee().toString(),
    instructions: res.instructions(),
    diskReadBytes: res.diskReadBytes(),
    writeBytes: res.writeBytes(),
    footprintReadOnly: res.footprint().readOnly().length,
    footprintReadWrite: res.footprint().readWrite().length,
  };
}

interface Row extends SimNumbers {
  op: "upload" | "create" | "verify_proof";
  hash: string;
  explorer: string;
  ledger: number;
  createdAt: string;
  txSizeBytes: number;
  inclusionFeeOffered: string;
  feeOffered: string;
  feeCharged: string;
  nonRefundableResourceFeeCharged?: string;
  refundableResourceFeeCharged?: string;
  rentFeeCharged?: string;
  returnValue?: unknown;
  coreMetrics?: Record<string, string>;
  wallMs: number;
}

/** A return value for the evidence file: bytes (e.g. the uploaded wasm hash) as hex, the rest as scValToNative gives it. */
function readable(v: xdr.ScVal): unknown {
  const n: unknown = scValToNative(v);
  return n instanceof Uint8Array ? Buffer.from(n).toString("hex") : n;
}

/** Simulate, assemble, sign, send, poll every POLL_MS; returns the measured row. */
async function submit(source: Keypair, op: xdr.Operation, label: Row["op"]): Promise<{ row: Row; res: rpc.Api.GetSuccessfulTransactionResponse }> {
  const acc = await RPC.getAccount(source.publicKey());
  const raw = new TransactionBuilder(acc, { fee: INCLUSION_FEE, networkPassphrase: NET }).addOperation(op).setTimeout(120).build();
  const sim = await RPC.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${label}: simulation failed: ${sim.error.slice(0, 600)}`);
  if (rpc.Api.isSimulationRestore(sim)) throw new Error(`${label}: simulation asks for a state restore first`);
  const tx: Transaction = rpc.assembleTransaction(raw, sim).build();
  tx.sign(source);
  const txHash = tx.hash().toString("hex");
  const start = performance.now();
  let sent = await RPC.sendTransaction(tx);
  for (let i = 0; sent.status === "TRY_AGAIN_LATER" && i < 5; i++) {
    await sleep(1_000);
    sent = await RPC.sendTransaction(tx);
  }
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") throw new Error(`${label}: sendTransaction ${sent.status} for ${txHash}`);
  for (;;) {
    const g = await RPC.getTransaction(txHash);
    if (g.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const row: Row = {
        op: label,
        hash: txHash,
        explorer: `${EXPLORER}/tx/${txHash}`,
        ledger: g.ledger,
        createdAt: new Date(Number(g.createdAt) * 1000).toISOString(),
        txSizeBytes: tx.toEnvelope().toXDR().length,
        inclusionFeeOffered: INCLUSION_FEE,
        feeOffered: tx.fee,
        feeCharged: g.resultXdr.feeCharged().toString(),
        ...simNumbers(sim),
        wallMs: Math.round(performance.now() - start),
      };
      const meta = g.resultMetaXdr;
      if (meta.switch() === 4) {
        const sm = meta.v4().sorobanMeta();
        if (sm && sm.ext().switch() === 1) {
          const v1 = sm.ext().v1();
          row.nonRefundableResourceFeeCharged = v1.totalNonRefundableResourceFeeCharged().toString();
          row.refundableResourceFeeCharged = v1.totalRefundableResourceFeeCharged().toString();
          row.rentFeeCharged = v1.rentFeeCharged().toString();
        }
      }
      const metrics = coreMetrics(g);
      if (metrics) row.coreMetrics = metrics;
      if (g.returnValue) row.returnValue = readable(g.returnValue);
      return { row, res: g };
    }
    if (g.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error(`${label}: transaction FAILED on chain: ${txHash}`);
    if (performance.now() - start > SETTLE_TIMEOUT_MS) throw new Error(`${label}: not settled after ${SETTLE_TIMEOUT_MS / 1000} s: ${txHash}`);
    await sleep(POLL_MS);
  }
}

/**
 * stellar-core's own "core_metrics" diagnostic events (what the host actually consumed when the
 * transaction was applied: cpu_insn, mem_byte, ...), when the RPC's node has diagnostic events on.
 */
function coreMetrics(g: rpc.Api.GetSuccessfulTransactionResponse): Record<string, string> | null {
  const events: xdr.DiagnosticEvent[] = [...(g.diagnosticEventsXdr ?? [])];
  const meta = g.resultMetaXdr;
  if (meta.switch() === 4) events.push(...(meta.v4().diagnosticEvents() ?? []));
  const out: Record<string, string> = {};
  for (const d of events) {
    const body = d.event().body().v0();
    const topics = body.topics();
    if (topics.length !== 2) continue;
    const [t0, t1] = topics;
    if (t0!.switch().name !== "scvSymbol" || t0!.sym().toString() !== "core_metrics") continue;
    if (t1!.switch().name !== "scvSymbol") continue;
    out[t1!.sym().toString()] = String(scValToNative(body.data()));
  }
  return Object.keys(out).length ? out : null;
}

interface SimRow extends SimNumbers {
  fixture: FixtureName;
  variant: "fixture" | "wrong public input";
  publicInputs: string[];
  returned: unknown;
  /** The local host-budget figure for the same fixture (bench_output.txt), for comparison. */
  hostModelInstructions: number | null;
}

/** A read-only verify_proof: simulated against the live network, never submitted. */
async function simulateVerify(contract: string, a: Args, variant: SimRow["variant"]): Promise<SimRow> {
  const tx = new TransactionBuilder(new Account(NULL_SOURCE, "0"), { fee: BASE_FEE, networkPassphrase: NET })
    .addOperation(new Contract(contract).call("verify_proof", a.vk, a.proof, a.inputs))
    .setTimeout(60)
    .build();
  const sim = await RPC.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`verify_proof(${a.fixture}) simulation failed: ${sim.error.slice(0, 600)}`);
  const v = sim.result?.retval;
  return {
    fixture: a.fixture,
    variant,
    publicInputs: a.publicInputs,
    returned: v ? readable(v) : null,
    ...simNumbers(sim),
    hostModelInstructions: variant === "fixture" ? HOST_MODEL_INSTRUCTIONS[a.fixture] : null,
  };
}

/* ---------- live ---------- */

interface Previous {
  contract?: string;
  wasmSha256?: string;
  rows?: Row[];
}

/** The payer's secret, in memory only: from the stellar-cli keystore (SPIKE12_IDENTITY) or SPIKE12_SECRET. */
function payerSecret(): string | null {
  const identity = process.env.SPIKE12_IDENTITY;
  if (identity) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(identity)) refuse(`SPIKE12_IDENTITY is not an identity name: "${identity}"`);
    try {
      return execFileSync("stellar", ["keys", "secret", identity], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      refuse(`stellar keys secret ${identity} failed (is the identity in the stellar-cli keystore?)`);
    }
  }
  return process.env.SPIKE12_SECRET || null;
}

async function live(): Promise<void> {
  const refusal = testnetRefusal(NET, [RPC_URL]);
  if (refusal) refuse(refusal);
  const secret = payerSecret();
  if (!secret) refuse("no key: set SPIKE12_IDENTITY to a funded TESTNET stellar-cli identity, or SPIKE12_SECRET (see the header of this file)");
  let source: Keypair;
  try {
    source = Keypair.fromSecret(secret);
  } catch {
    refuse("the payer key is not a valid secret key (its value is not printed)");
  }
  const net = await RPC.getNetwork();
  if (net.passphrase !== Networks.TESTNET) refuse(`the RPC serves "${net.passphrase}", not testnet`);
  const latest = await RPC.getLatestLedger();
  step(`testnet protocol ${latest.protocolVersion}, ledger ${latest.sequence}; payer ${source.publicKey()}`);
  try {
    await RPC.getAccount(source.publicKey());
  } catch {
    refuse(`the payer ${source.publicKey()} has no account on testnet: fund it first (stellar keys fund <name> --network testnet)`);
  }

  if (!existsSync(WASM_PATH)) throw new Error(`no wasm at ${WASM_PATH}: run \`stellar contract build\` in evidence/spike11/tier2, or set WASM`);
  const wasm = readFileSync(WASM_PATH);
  const wasmHash = hash(wasm);
  if (wasmHash.toString("hex") !== WASM_SHA256) {
    throw new Error(`the wasm at ${WASM_PATH} has sha256 ${wasmHash.toString("hex")}, not the published ${WASM_SHA256}`);
  }

  const previous: Previous = existsSync(OUT_PATH) ? (JSON.parse(readFileSync(OUT_PATH, "utf8")) as Previous) : {};
  const salt = hash(Buffer.concat([Buffer.from("lumenia-spike12:"), wasmHash]));
  const contract = contractIdFor(source.publicKey(), salt);
  const rows: Row[] =
    previous.contract === contract && previous.wasmSha256 === WASM_SHA256 ? (previous.rows ?? []).filter((r) => r.op !== "verify_proof") : [];

  if (!(await entry(codeKey(wasmHash)))) {
    step(`uploading ${wasm.length} bytes of wasm (${WASM_SHA256.slice(0, 8)}...)`);
    const up = await submit(source, Operation.uploadContractWasm({ wasm }), "upload");
    const got = up.res.returnValue ? Buffer.from(scValToNative(up.res.returnValue) as Uint8Array) : null;
    if (!got || !got.equals(wasmHash)) throw new Error("the upload returned a different wasm hash");
    rows.push(up.row);
    step(`upload: ${up.row.hash}, fee charged ${up.row.feeCharged}`);
  } else {
    step("the verifier wasm is already on testnet (content-addressed): no upload");
  }
  if (!(await entry(instanceKey(contract)))) {
    step(`creating ${contract} (no constructor)`);
    const created = await submit(
      source,
      Operation.createCustomContract({ address: Address.fromString(source.publicKey()), wasmHash, salt }),
      "create",
    );
    const got = created.res.returnValue ? Address.fromScVal(created.res.returnValue).toString() : null;
    if (got !== contract) throw new Error(`createCustomContract returned ${got}, expected ${contract}`);
    rows.push(created.row);
    step(`create: ${created.row.hash}, fee charged ${created.row.feeCharged}`);
  } else {
    step(`verifier ${contract} already deployed`);
  }

  // Simulation only, never submitted: the right and the wrong public input, and the other fixtures.
  const circom = argsFor("circom");
  const simulations: SimRow[] = [];
  const reads: [Args, SimRow["variant"]][] = [
    [circom, "fixture"],
    [argsFor("circom", ["22"]), "wrong public input"],
    [argsFor("gnark"), "fixture"],
    [argsFor("arkworks"), "fixture"],
  ];
  for (const [a, variant] of reads) {
    const s = await simulateVerify(contract, a, variant);
    simulations.push(s);
    step(`simulated verify_proof(${a.fixture}, public ${JSON.stringify(a.publicInputs)}) -> ${String(s.returned)}, ${s.instructions} instructions`);
  }
  if (simulations[0]!.returned !== true) throw new Error("verify_proof(circom) did not simulate to true: nothing is submitted");
  if (simulations[1]!.returned !== false) throw new Error("verify_proof with a wrong public input did not simulate to false");

  // The one submitted call.
  const verify = await submit(source, new Contract(contract).call("verify_proof", circom.vk, circom.proof, circom.inputs), "verify_proof");
  if (verify.row.returnValue !== true) throw new Error(`verify_proof returned ${String(verify.row.returnValue)} on chain`);
  rows.push(verify.row);
  step(`verify_proof on chain: ${verify.row.hash}, ledger ${verify.row.ledger}, returned true, fee charged ${verify.row.feeCharged}`);

  const out = {
    spike: "12: one Groth16 (BLS12-381) verification on testnet, the upstream example circuit",
    label: "upstream example circuit (circom a * b = c, public c = 33), not a range proof of our own; hides no Lumenia amount",
    script: "apps/sponsor/src/spike12-groth16.ts",
    generatedAt: new Date().toISOString(),
    network: { passphrase: NET, rpc: RPC_URL, protocolVersion: latest.protocolVersion },
    upstream: UPSTREAM,
    wasmSha256: WASM_SHA256,
    wasmBytes: wasm.length,
    contract,
    contractExplorer: `${EXPLORER}/contract/${contract}`,
    payer: source.publicKey(),
    arguments: { fixture: "circom", publicInputs: circom.publicInputs, xdrBytes: circom.xdrLen, xdrSha256: circom.sha256 },
    hostModelInstructions: HOST_MODEL_INSTRUCTIONS,
    rows,
    simulations,
    notes: [
      "instructions, diskReadBytes and writeBytes are the simulated SorobanResources the transaction declared; feeCharged is TransactionResult.feeCharged; the resource fee split is SorobanTransactionMetaExtV1 from the meta.",
      "coreMetrics, when present, are stellar-core's core_metrics diagnostic events: what the host consumed when the transaction was applied.",
      "simulations were never submitted; the wrong-input row must return false, and it does.",
    ],
  };
  writeFileSync(OUT_PATH, `${JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1)}\n`);
  step(`wrote ${OUT_PATH.slice(REPO_ROOT.length)}`);
}

async function main(): Promise<void> {
  selfCheck();
  if (OFFLINE) return;
  await live();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
