/**
 * ============================================================================
 *  SPIKE #11 - The commitment escrow next to the live v2 escrow: cost and visibility (testnet)
 * ============================================================================
 *
 *  GOAL. Put numbers on the D2 commitment spike (contracts/lumen-drop-commit): what it costs per
 *  transaction to store sha256(0x03 || link || amount || salt) next to the escrowed amount and to
 *  reveal (amount, salt) at claim time, measured against the same deposit + claim on the live
 *  testnet escrow. It also records where the amount stays public, because the commitment does NOT
 *  hide it: the deposit still moves the amount through a public SAC transfer, the escrow keeps it in
 *  the clear next to the commitment (it pays out the STORED amount, never the revealed one, so a
 *  sender cannot deposit 1, reveal 5 and drain the pooled balance), and the claim reveals it.
 *  evidence/spike11/visibility.json names each place for the first commitment deposit.
 *
 *  LEGS (N runs each, env N, default 5; they alternate run by run so both see the same network):
 *    commit   the commitment contract, deployed here (constructor: token = the SAC of a USDC code
 *             issued by T, owner = T): deposit(from, link, commitment, amount, expiry), then
 *             claim(link, payout, sig, amount, salt) to R. The link key signs the bytes of the
 *             contract's claim_message view; the local layout is checked against them.
 *    control  the live escrow CAMCI5VP... on Circle testnet USDC (from the testnet sponsor's /faucet):
 *             deposit(from, link, amount, expiry), then claim(link, payout, sig), claim_message kind 1.
 *  T submits every transaction itself and pays every fee. No sponsor relay on either leg.
 *
 *  RECORDED per transaction (evidence/spike11/measurements.json, summary in measurements.md): the
 *  simulation's minResourceFee and the resources of its transactionData (instructions,
 *  diskReadBytes, writeBytes, footprint read-only / read-write entries), the transactionData
 *  resourceFee, the inclusion fee offered, feeCharged from getTransaction, the ledger, and the wall
 *  time from sendTransaction to SUCCESS (getTransaction polled every 500 ms).
 *
 *  STATE. apps/sponsor/.env.spike11.json (gitignored by apps/sponsor/.gitignore ".env*", mode 0600):
 *  throwaway keys T (sender, asset issuer, contract owner, fee payer) and R (recipient), written
 *  BEFORE the first friendbot call; the deployment; every measured row; the run in flight. A rerun
 *  resumes: setup already on the ledger is skipped, an interrupted run is settled from the ledger,
 *  and only the missing runs are made. Secrets never reach stdout or evidence/.
 *
 *  RUN:  OFFLINE=1 pnpm --filter @lumenia/sponsor spike11   # self-check: no network, no state file
 *        pnpm --filter @lumenia/sponsor spike11             # live, TESTNET ONLY (refuses otherwise)
 *        N=10 ...                 runs per leg              RESET_RUNS=1 ...  measure again, same keys
 *        WASM=<path> ...          the wasm (absolute, or relative to the repo root)
 *        COMMIT_CONTRACT=C... ... measure this deployment instead of deploying one
 *        INCLUSION_FEE=<stroops>  the inclusion fee offered per transaction (default 10000)
 *  NEEDS: `stellar contract build` in contracts/lumen-drop-commit, and internet. No sponsor key.
 * ============================================================================
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  Address,
  Asset,
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
import { USDC_ISSUERS } from "./lib/config.js";
import { FAUCET_AMOUNT } from "./lib/faucet.js";

/* ---------- network: testnet, and only testnet ---------- */
const NET = Networks.TESTNET;
const RPC_URL = "https://soroban-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const SPONSOR_URL = "https://lumenia-sponsor.avakit.workers.dev";
/** Every host this script may call. The mainnet sponsor Worker (lumenia-sponsor-mainnet) is absent on purpose. */
const TESTNET_HOSTS = ["soroban-testnet.stellar.org", "friendbot.stellar.org", "lumenia-sponsor.avakit.workers.dev"];
/** Printed into the evidence, never fetched. */
const EXPLORER = "https://stellar.expert/explorer/testnet";

/** The live testnet v2 escrow (contracts/lumen-drop), pinned to Circle testnet USDC. */
const CONTROL_CONTRACT = "CAMCI5VPRLQUL6H4QKLZ6X7ASLVCEYBYWS7N3QG7JVOA25HCY2TN3HP3";
const CIRCLE_USDC = new Asset("USDC", USDC_ISSUERS.testnet);

/* ---------- paths ---------- */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const STATE_PATH = fileURLToPath(new URL("../.env.spike11.json", import.meta.url));
const OUT_DIR = join(REPO_ROOT, "evidence", "spike11");
const WASM_PATH = (() => {
  const w = process.env.WASM;
  if (!w) return join(REPO_ROOT, "contracts/lumen-drop-commit/target/wasm32v1-none/release/lumen_drop_commit.wasm");
  return isAbsolute(w) ? w : join(REPO_ROOT, w);
})();

/* ---------- knobs ---------- */
const OFFLINE = process.env.OFFLINE === "1";
const RESET_RUNS = process.env.RESET_RUNS === "1";
const N = intEnv("N", 5, 1, 100);
const INCLUSION_FEE = String(intEnv("INCLUSION_FEE", 10_000, 100, 10_000_000));
const POLL_MS = 500;
const SETTLE_TIMEOUT_MS = 90_000;
/** Run i escrows BASE_AMOUNT + i stroops: 0.1234567 USDC, the known-answer amount, easy to find in the evidence. */
const BASE_AMOUNT = 1_234_567n;
/** A day: inside both escrows' 30-day expiry horizon. Every drop here is claimed seconds after its deposit. */
const EXPIRY_SECONDS = 24 * 60 * 60;
const FAUCET_STROOPS = BigInt(Math.round(Number(FAUCET_AMOUNT) * 1e7));
const FAUCET_MAX_CALLS = 10;
/** The testnet Worker allows 15 calls per account per minute (wrangler.toml ACCOUNT_RATE_CAP): stay well under. */
const FAUCET_SPACING_MS = 5_000;
/** A read-only simulation needs a source account, not an existing one (as in apps/web/lib/lumendrop.ts). */
const NULL_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const step = (m: string) => console.log(`[${at()}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (s: string) => `${s.slice(0, 6)}...${s.slice(-4)}`;
const assetLabel = (a: Asset) => `${a.getCode()}:${short(a.getIssuer() ?? "native")}`;
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in [${min}, ${max}], got "${raw}"`);
  return n;
}

/* ---------- the testnet-only guard ---------- */

/**
 * A refusal, not a warning: this script holds keys and submits transactions, and all of its safety
 * is that nothing it can reach holds real money. Checked before the first network call, and the RPC
 * is then asked which network it actually serves.
 */
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

function refuse(why: string): never {
  console.error(`\nREFUSED (testnet only): ${why}`);
  process.exit(2);
}

/* ---------- the commitment scheme, byte for byte (contracts/lumen-drop-commit) ---------- */

const TAG_COMMITMENT = 0x03;
const TAG_CLAIM = 0x04;

function bytes32(b: Buffer, what: string): Buffer {
  if (b.length !== 32) throw new Error(`${what} must be 32 bytes, got ${b.length}`);
  return b;
}

/** Rust's i128::to_be_bytes: 16 bytes, two's complement, big-endian. */
function i128be(x: bigint): Buffer {
  let v = BigInt.asUintN(128, x);
  const out = Buffer.alloc(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** 0x03 || link(32) || amount(16) || salt(32): 81 bytes. */
function commitmentPreimage(link: Buffer, amount: bigint, salt: Buffer): Buffer {
  return Buffer.concat([Buffer.from([TAG_COMMITMENT]), bytes32(link, "link"), i128be(amount), bytes32(salt, "salt")]);
}

function commitmentOf(link: Buffer, amount: bigint, salt: Buffer): Buffer {
  return hash(commitmentPreimage(link, amount, salt));
}

/** What the host returns for env.ledger().network_id(): sha256 of the passphrase. */
const networkIdOf = (passphrase: string): Buffer => hash(Buffer.from(passphrase));

/**
 * The bytes the link key signs: 0x04 || network_id(32) || contract.to_xdr() || link(32) ||
 * payout.to_xdr() || amount(16) || salt(32). `Address::to_xdr` is the address as an ScVal
 * (SCV_ADDRESS, then the ScAddress), which is what `Address.toScVal().toXDR()` gives here: 40 bytes
 * for a contract, 44 for an account. The live run signs the contract's own claim_message bytes, as
 * the product does; this copy is the parity check that pins the layout.
 */
function claimMessage(networkId: Buffer, contract: string, link: Buffer, payout: string, amount: bigint, salt: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([TAG_CLAIM]),
    bytes32(networkId, "network id"),
    Address.fromString(contract).toScVal().toXDR(),
    bytes32(link, "link"),
    Address.fromString(payout).toScVal().toXDR(),
    i128be(amount),
    bytes32(salt, "salt"),
  ]);
}

/* ---------- arguments: one builder per entrypoint, shared by the live run and the self-check ---------- */

const sv = {
  address: (a: string) => Address.fromString(a).toScVal(),
  bytes: (b: Buffer) => xdr.ScVal.scvBytes(b),
  i128: (n: bigint) => nativeToScVal(n, { type: "i128" }),
  u64: (n: bigint) => nativeToScVal(n, { type: "u64" }),
  u32: (n: number) => nativeToScVal(n, { type: "u32" }),
};

/** contracts/lumen-drop-commit. */
const commitArgs = {
  __constructor: (token: string, owner: string) => [sv.address(token), sv.address(owner)],
  deposit: (from: string, link: Buffer, commitment: Buffer, amount: bigint, expiry: bigint) => [
    sv.address(from),
    sv.bytes(link),
    sv.bytes(commitment),
    sv.i128(amount),
    sv.u64(expiry),
  ],
  claim: (link: Buffer, payout: string, sig: Buffer, amount: bigint, salt: Buffer) => [
    sv.bytes(link),
    sv.address(payout),
    sv.bytes(sig),
    sv.i128(amount),
    sv.bytes(salt),
  ],
  reclaim: (link: Buffer) => [sv.bytes(link)],
  get_drop: (link: Buffer) => [sv.bytes(link)],
  commitment_of: (link: Buffer, amount: bigint, salt: Buffer) => [sv.bytes(link), sv.i128(amount), sv.bytes(salt)],
  claim_message: (link: Buffer, payout: string, amount: bigint, salt: Buffer) => [
    sv.bytes(link),
    sv.address(payout),
    sv.i128(amount),
    sv.bytes(salt),
  ],
};

/** contracts/lumen-drop, the live escrow. claim_message kind 1 is TAG_SINGLE: a one-to-one drop. */
const controlArgs = {
  deposit: (from: string, link: Buffer, amount: bigint, expiry: bigint) => [
    sv.address(from),
    sv.bytes(link),
    sv.i128(amount),
    sv.u64(expiry),
  ],
  claim: (link: Buffer, payout: string, sig: Buffer) => [sv.bytes(link), sv.address(payout), sv.bytes(sig)],
  claim_message: (link: Buffer, payout: string) => [sv.u32(1), sv.bytes(link), sv.address(payout)],
  get_drop: (link: Buffer) => [sv.bytes(link)],
};

/* ---------- ledger keys ---------- */

/** DataKey::Drop(link): a #[contracttype] enum variant is the vec [Symbol(name), ...fields]. Persistent. */
function dropKey(contract: string, link: Buffer): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contract).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Drop"), xdr.ScVal.scvBytes(bytes32(link, "link"))]),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

function instanceKey(contract: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

const accountKey = (pub: string) =>
  xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(pub).xdrAccountId() }));
const trustlineKey = (pub: string, asset: Asset) =>
  xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({ accountId: Keypair.fromPublicKey(pub).xdrAccountId(), asset: asset.toTrustLineXDRObject() }),
  );
const codeKey = (wasmHash: Buffer) => xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));

/** The id createCustomContract will get: sha256 of HashIdPreimage::ContractId(network, deployer, salt). */
function contractIdFor(deployer: string, salt: Buffer, passphrase: string): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: networkIdOf(passphrase),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(deployer).toScAddress(), salt: bytes32(salt, "salt") }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

/* ---------- readable renderings: footprint labels, stellar-xdr style JSON ---------- */

function dataLabel(contract: xdr.ScAddress, key: xdr.ScVal): string {
  const kind = key.switch().name;
  const first = kind === "scvVec" ? key.vec()?.[0] : undefined;
  const name =
    kind === "scvLedgerKeyContractInstance"
      ? "instance"
      : first && first.switch().name === "scvSymbol"
        ? first.sym().toString()
        : kind;
  return `contractData:${short(Address.fromScAddress(contract).toString())}:${name}`;
}

/** e.g. contractData:CAMCI5...3HP3:Drop, trustline:USDC:GBXYZ1...ABCD. Makes each footprint readable entry by entry. */
function keyLabel(k: xdr.LedgerKey): string {
  switch (k.switch().name) {
    case "account":
      return `account:${short(StrKey.encodeEd25519PublicKey(k.account().accountId().ed25519()))}`;
    case "trustline": {
      const tl = k.trustLine();
      const a = tl.asset();
      const code =
        a.switch().name === "assetTypeCreditAlphanum4"
          ? a.alphaNum4().assetCode().toString("latin1").replace(/\0+$/, "")
          : a.switch().name;
      return `trustline:${code}:${short(StrKey.encodeEd25519PublicKey(tl.accountId().ed25519()))}`;
    }
    case "contractCode":
      return "contractCode";
    case "contractData":
      return dataLabel(k.contractData().contract(), k.contractData().key());
    default:
      return k.switch().name;
  }
}

/** An ScVal in the stellar-xdr JSON style ({"i128":"..."}, {"address":"..."}, {"bytes":"<hex>"}, ...). */
function scvJson(v: xdr.ScVal): unknown {
  switch (v.switch().name) {
    case "scvBool":
      return { bool: v.b() };
    case "scvVoid":
      return "void";
    case "scvU32":
      return { u32: v.u32() };
    case "scvI32":
      return { i32: v.i32() };
    case "scvU64":
      return { u64: v.u64().toString() };
    case "scvI64":
      return { i64: v.i64().toString() };
    case "scvU128":
      return { u128: String(scValToNative(v)) };
    case "scvI128":
      return { i128: String(scValToNative(v)) };
    case "scvBytes":
      return { bytes: v.bytes().toString("hex") };
    case "scvString":
      return { string: v.str().toString() };
    case "scvSymbol":
      return { symbol: v.sym().toString() };
    case "scvAddress":
      return { address: Address.fromScVal(v).toString() };
    case "scvVec":
      return { vec: (v.vec() ?? []).map(scvJson) };
    case "scvMap":
      return { map: (v.map() ?? []).map((e) => ({ key: scvJson(e.key()), val: scvJson(e.val()) })) };
    case "scvLedgerKeyContractInstance":
      return "ledger_key_contract_instance";
    default:
      return { type: v.switch().name, xdr: v.toXDR("base64") };
  }
}

function invokeJson(c: xdr.InvokeContractArgs) {
  return {
    contractAddress: Address.fromScAddress(c.contractAddress()).toString(),
    functionName: c.functionName().toString(),
    args: c.args().map(scvJson),
  };
}

function eventJson(e: xdr.ContractEvent) {
  const body = e.body().v0();
  const id = e.contractId();
  return {
    contractId: id ? Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(id)).toString() : null,
    type: e.type().name,
    topics: body.topics().map(scvJson),
    data: scvJson(body.data()),
  };
}

/** DropEntry::V1(Drop) as stored: vec [Symbol("V1"), map {...}]. JSON-safe (hex bytes, decimal integers). */
function dropFields(val: xdr.ScVal): Record<string, string | boolean> {
  const native = scValToNative(val) as unknown;
  if (!Array.isArray(native) || native[0] !== "V1" || typeof native[1] !== "object" || native[1] === null) {
    throw new Error("not a DropEntry::V1 record");
  }
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(native[1] as Record<string, unknown>)) {
    out[k] = typeof v === "boolean" ? v : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : String(v);
  }
  return out;
}

/* ---------- state (gitignored: it holds the throwaway secrets) ---------- */

type Leg = "commit" | "control";
type Op = "upload" | "create" | "deposit" | "claim";

/** The simulation half of a row, kept in the state before sending so a restart can still record the result. */
interface SimNumbers {
  minResourceFee: string;
  resourceFee: string;
  instructions: number;
  diskReadBytes: number;
  writeBytes: number;
  footprintReadOnly: number;
  footprintReadWrite: number;
  archivedEntries: number;
  footprint: { readOnly: string[]; readWrite: string[] };
  inclusionFee: string;
  feeOffered: string;
}

interface RowBase {
  leg: Leg;
  /** -1 for the one-time deployment (upload, create) */
  run: number;
  op: Op;
  contract: string;
  /** the drop id: the link key's raw public key, hex */
  link?: string;
  /** stroops */
  amount?: string;
  /** deposits only: true when the sender issues the asset, so the SAC leg is a mint (no sender trustline) */
  senderIsIssuer?: boolean;
}

interface Row extends RowBase, SimNumbers {
  hash: string;
  feeCharged: string;
  ledger: number;
  createdAt: number;
  /** sendTransaction until getTransaction first says SUCCESS. null when a restart recovered the row. */
  wallMs: number | null;
  polls: number | null;
  sendStatus: string | null;
  submittedAt: string;
  recovered?: true;
}

interface PendingRun {
  run: number;
  /** S...: the drop id is its raw public key. Never printed. */
  linkSecret: string;
  amount: string;
  /** hex, commitment leg only */
  salt?: string;
  expiry: string;
  deposited: boolean;
  inflight?: { op: Op; hash: string; sim: SimNumbers; submittedAt: string };
}

interface VisItem {
  item: string;
  source: "getTransaction" | "getLedgerEntries";
  /** the raw base64 XDR field of the RPC result that holds this node */
  rpcField: string;
  xdrType: string;
  /** JSON path inside the decoded field, in XDR field names (the stellar-sdk accessor names) */
  path: string;
  /** the same node inside resultMetaXdr, for events and ledger changes */
  metaPath?: string;
  nodeXdr: string;
  value: unknown;
  showsAmount: boolean;
}

interface Visibility {
  note: string;
  contract: string;
  sac: string;
  asset: string;
  link: string;
  amount: string;
  commitment: string;
  depositTx: string;
  depositLedger: number;
  claimTx?: string;
  explorer: { depositTx: string; contract: string; claimTx?: string };
  /** "k of n items": how many of the recorded places carry the amount */
  shownIn: string;
  notes?: string[];
  items: VisItem[];
  claimItems?: VisItem[];
  raw: {
    deposit: { envelopeXdr: string; resultMetaXdr: string; contractEventsXdr: string[][] };
    /* The ledger key travels as `ledgerKeyXdr`, not `key`: it is public chain data, and a field named
       `key` holding a long base64 string reads as a credential to the repo's secret scanner. */
    dropEntry: { ledgerKeyXdr: string; xdr: string; lastModifiedLedgerSeq?: number; liveUntilLedgerSeq?: number };
    claim?: { envelopeXdr: string };
  };
}

interface State {
  purpose: string;
  network: string;
  created: string;
  T: { publicKey: string; secret: string };
  R: { publicKey: string; secret: string };
  sac?: string;
  wasmHash?: string;
  contract?: string;
  rows: Row[];
  /** rows measured against an earlier deployment or before RESET_RUNS: kept, never summarised */
  setAside?: Row[];
  pending: Partial<Record<Leg, PendingRun>>;
  visibility?: Visibility;
  parity?: Parity;
}

let state!: State;

function save(): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

function loadOrCreateState(): State {
  if (existsSync(STATE_PATH)) {
    const s = JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
    if (s.network !== NET) refuse(`${STATE_PATH} belongs to "${s.network}"`);
    s.rows ??= [];
    s.pending ??= {};
    return s;
  }
  const T = Keypair.random();
  const R = Keypair.random();
  state = {
    purpose: "spike11 commitment measurement, TESTNET ONLY throwaway keys",
    network: NET,
    created: new Date().toISOString(),
    T: { publicKey: T.publicKey(), secret: T.secret() },
    R: { publicKey: R.publicKey(), secret: R.secret() },
    rows: [],
    pending: {},
  };
  // Written before any friendbot call: a crash after funding must never lose the keys.
  save();
  return state;
}

/* ---------- RPC ---------- */

const RPC = new rpc.Server(RPC_URL);

/** One ledger entry, or null when the RPC answered and has none. A failed request throws: absent and unknown stay apart. */
async function entry(key: xdr.LedgerKey): Promise<rpc.Api.LedgerEntryResult | null> {
  const res = await RPC.getLedgerEntries(key);
  return res.entries[0] ?? null;
}

async function ensureAccount(kp: Keypair, name: string): Promise<void> {
  const pub = kp.publicKey();
  if (await entry(accountKey(pub))) return;
  step(`friendbot -> ${name} ${pub}`);
  const r = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(pub)}`);
  // 400 = already funded (a rerun racing a slow RPC). Anything else is a real failure.
  if (!r.ok && r.status !== 400) throw new Error(`friendbot ${name}: HTTP ${r.status}`);
  for (let i = 0; i < 30; i++) {
    if (await entry(accountKey(pub))) return;
    await sleep(POLL_MS);
  }
  throw new Error(`friendbot answered but ${name} is still not on the ledger after 15 s`);
}

function failureCode(r: xdr.TransactionResult): string {
  const outer = r.result().switch().name;
  try {
    const inner = r.result().results()[0]?.tr().invokeHostFunctionResult().switch().name;
    return inner ? `${outer}/${inner}` : outer;
  } catch {
    return outer;
  }
}

interface Landed {
  res: rpc.Api.GetSuccessfulTransactionResponse;
  wallMs: number;
  polls: number;
  sendStatus: string;
}

/** Send, then poll getTransaction every POLL_MS. The wall time runs from the first send to the first SUCCESS seen. */
async function sendAndPoll(tx: Transaction): Promise<Landed> {
  const start = performance.now();
  let sent = await RPC.sendTransaction(tx);
  for (let i = 0; sent.status === "TRY_AGAIN_LATER" && i < 5; i++) {
    await sleep(1_000);
    sent = await RPC.sendTransaction(tx);
  }
  if (sent.status === "ERROR") {
    throw new Error(`sendTransaction ERROR for ${sent.hash}: ${sent.errorResult ? failureCode(sent.errorResult) : "no result"}`);
  }
  if (sent.status === "TRY_AGAIN_LATER") throw new Error(`sendTransaction kept answering TRY_AGAIN_LATER for ${sent.hash}`);
  let polls = 0;
  for (;;) {
    const g = await RPC.getTransaction(sent.hash);
    polls++;
    if (g.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { res: g, wallMs: Math.round(performance.now() - start), polls, sendStatus: sent.status };
    }
    if (g.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`transaction FAILED on chain: ${sent.hash} (${failureCode(g.resultXdr)})`);
    }
    if (performance.now() - start > SETTLE_TIMEOUT_MS) throw new Error(`not settled after ${SETTLE_TIMEOUT_MS / 1000} s: ${sent.hash}`);
    await sleep(POLL_MS);
  }
}

async function classic(source: Keypair, op: xdr.Operation): Promise<void> {
  const acc = await RPC.getAccount(source.publicKey());
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET }).addOperation(op).setTimeout(120).build();
  tx.sign(source);
  await sendAndPoll(tx);
}

async function ensureTrustline(kp: Keypair, name: string, asset: Asset): Promise<void> {
  if (await entry(trustlineKey(kp.publicKey(), asset))) return;
  step(`${name}: trustline to ${assetLabel(asset)}`);
  await classic(kp, Operation.changeTrust({ asset }));
}

async function trustlineStroops(pub: string, asset: Asset): Promise<bigint> {
  const e = await entry(trustlineKey(pub, asset));
  return e ? BigInt(e.val.trustLine().balance().toString()) : 0n;
}

interface Prepared {
  tx: Transaction;
  sim: SimNumbers;
}

/**
 * Simulate, assemble, sign. The resource numbers come from the SIMULATED transactionData, named as
 * stellar-sdk 16.3.0 names them: SorobanResources.instructions() / diskReadBytes() / writeBytes(),
 * LedgerFootprint.readOnly() / readWrite(), SorobanTransactionData.resourceFee().
 */
async function prepare(source: Keypair, op: xdr.Operation): Promise<Prepared> {
  const acc = await RPC.getAccount(source.publicKey());
  const raw = new TransactionBuilder(acc, { fee: INCLUSION_FEE, networkPassphrase: NET }).addOperation(op).setTimeout(120).build();
  const sim = await RPC.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error.slice(0, 600)}`);
  if (rpc.Api.isSimulationRestore(sim)) throw new Error("simulation asks for a state restore first (archived entries)");
  const tx = rpc.assembleTransaction(raw, sim).build();
  tx.sign(source);
  const data = sim.transactionData.build();
  const res = data.resources();
  const fp = res.footprint();
  const ext = data.ext();
  return {
    tx,
    sim: {
      minResourceFee: sim.minResourceFee,
      resourceFee: data.resourceFee().toString(),
      instructions: res.instructions(),
      diskReadBytes: res.diskReadBytes(),
      writeBytes: res.writeBytes(),
      footprintReadOnly: fp.readOnly().length,
      footprintReadWrite: fp.readWrite().length,
      archivedEntries: ext.switch() === 1 ? ext.resourceExt().archivedSorobanEntries().length : 0,
      footprint: { readOnly: fp.readOnly().map(keyLabel), readWrite: fp.readWrite().map(keyLabel) },
      inclusionFee: INCLUSION_FEE,
      feeOffered: tx.fee,
    },
  };
}

/** A read-only call: simulated, never submitted. */
async function view(contract: string, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
  const tx = new TransactionBuilder(new Account(NULL_SOURCE, "0"), { fee: BASE_FEE, networkPassphrase: NET })
    .addOperation(new Contract(contract).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await RPC.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method} on ${short(contract)}: ${sim.error.slice(0, 600)}`);
  const v = sim.result?.retval;
  if (!v) throw new Error(`${method} on ${short(contract)} returned nothing`);
  return v;
}

/** get_drop, the same view name on both escrows. null = the escrow answered and holds nothing for this link. */
async function getDrop(contract: string, link: Buffer): Promise<Record<string, unknown> | null> {
  const v = await view(contract, "get_drop", [sv.bytes(link)]);
  return (scValToNative(v) as Record<string, unknown> | null) ?? null;
}

/* ---------- rows ---------- */

function toRow(
  base: RowBase,
  txHash: string,
  sim: SimNumbers,
  submittedAt: string,
  res: rpc.Api.GetSuccessfulTransactionResponse,
  landed: Landed | null,
): Row {
  return {
    ...base,
    hash: txHash,
    ...sim,
    feeCharged: res.resultXdr.feeCharged().toString(),
    ledger: res.ledger,
    createdAt: res.createdAt,
    wallMs: landed ? landed.wallMs : null,
    polls: landed ? landed.polls : null,
    sendStatus: landed ? landed.sendStatus : null,
    submittedAt,
    ...(landed ? {} : { recovered: true as const }),
  };
}

/** Prepare, record the hash as in flight, send, poll, record the row. Throws on any failed transaction. */
async function measure(
  source: Keypair,
  operation: xdr.Operation,
  base: RowBase,
  p?: PendingRun,
): Promise<{ row: Row; res: rpc.Api.GetSuccessfulTransactionResponse }> {
  const prepared = await prepare(source, operation);
  const txHash = prepared.tx.hash().toString("hex");
  const submittedAt = new Date().toISOString();
  if (p) {
    p.inflight = { op: base.op, hash: txHash, sim: prepared.sim, submittedAt };
    save();
  }
  const landed = await sendAndPoll(prepared.tx);
  const row = toRow(base, txHash, prepared.sim, submittedAt, landed.res, landed);
  state.rows.push(row);
  if (p) {
    delete p.inflight;
    if (base.op === "deposit") p.deposited = true;
  }
  save();
  const label = base.run >= 0 ? `${base.leg} #${base.run} ${base.op}` : `${base.leg} ${base.op}`;
  step(`${label}: ledger ${row.ledger}, ${row.wallMs} ms, ${row.instructions} instructions, fee charged ${row.feeCharged}`);
  return { row, res: landed.res };
}

function completedRuns(leg: Leg): number {
  const ops = new Map<number, Set<Op>>();
  for (const r of state.rows) {
    if (r.leg !== leg || r.run < 0) continue;
    const s = ops.get(r.run) ?? new Set<Op>();
    s.add(r.op);
    ops.set(r.run, s);
  }
  return [...ops.values()].filter((s) => s.has("deposit") && s.has("claim")).length;
}

function nextRunIndex(leg: Leg): number {
  let max = -1;
  for (const r of state.rows) if (r.leg === leg && r.run > max) max = r.run;
  const p = state.pending[leg];
  if (p && p.run > max) max = p.run;
  return max + 1;
}

const amountFor = (run: number) => BASE_AMOUNT + BigInt(run);

/** How many 1-USDC faucet calls cover the next `runs` control deposits, given what T already holds. */
function faucetCallsNeeded(firstRun: number, runs: number, held: bigint): number {
  let need = 0n;
  for (let i = 0; i < runs; i++) need += amountFor(firstRun + i);
  if (need <= held) return 0;
  return Number((need - held + FAUCET_STROOPS - 1n) / FAUCET_STROOPS);
}

/* ---------- setup ---------- */

async function ensureSac(T: Keypair, asset: Asset): Promise<string> {
  const id = asset.contractId(NET);
  if (await entry(instanceKey(id))) return id;
  step(`deploying the SAC of ${assetLabel(asset)} -> ${id}`);
  await sendAndPoll((await prepare(T, Operation.createStellarAssetContract({ asset }))).tx);
  return id;
}

async function instanceOf(contract: string): Promise<xdr.ScContractInstance | null> {
  const e = await entry(instanceKey(contract));
  return e ? e.val.contractData().val().instance() : null;
}

/** The escrow's pinned token as its instance storage holds it (DataKey::Token), or null when it is not there. */
function tokenIn(instance: xdr.ScContractInstance): string | null {
  for (const e of instance.storage() ?? []) {
    const k = e.key();
    if (k.switch().name !== "scvVec") continue;
    const v = k.vec() ?? [];
    if (v.length === 1 && v[0]!.switch().name === "scvSymbol" && v[0]!.sym().toString() === "Token") {
      return Address.fromScVal(e.val()).toString();
    }
  }
  return null;
}

/** Sanity, not measurement: the deployment pins this run's asset and is owned by T. */
async function checkDeployment(contract: string, sac: string, owner: string): Promise<string | null> {
  const instance = await instanceOf(contract);
  if (!instance) throw new Error(`${contract} has no instance on testnet`);
  const token = tokenIn(instance);
  if (token === null) step(`WARNING: could not confirm ${short(contract)}'s token (no DataKey::Token in its instance storage)`);
  else if (token !== sac) throw new Error(`${contract} escrows ${token}, not this run's asset ${sac}`);
  try {
    const got = scValToNative(await view(contract, "get_owner", [])) as string | null;
    if (got !== owner) throw new Error(`${contract} is owned by ${got}, not T`);
  } catch (e) {
    if ((e as Error).message.includes("is owned by")) throw e;
    step(`WARNING: could not read ${short(contract)}'s owner: ${(e as Error).message.split("\n")[0]}`);
  }
  const exe = instance.executable();
  return exe.switch().name === "contractExecutableWasm" ? exe.wasmHash().toString("hex") : null;
}

/**
 * The commitment deployment changed: its rows and visibility leave the summaries (kept in setAside),
 * and a run still pending there is dropped rather than settled against the new contract. Its drop
 * holds only T's own self-issued test asset.
 */
function setAsideCommitRows(why: string): void {
  const moved = state.rows.filter((r) => r.leg === "commit");
  const pending = state.pending.commit;
  if (moved.length === 0 && !state.visibility && !pending) return;
  state.setAside = [...(state.setAside ?? []), ...moved];
  state.rows = state.rows.filter((r) => r.leg !== "commit");
  delete state.visibility;
  delete state.pending.commit;
  delete state.parity;
  step(`${moved.length} commitment rows set aside${pending ? `, pending run #${pending.run} dropped` : ""}: ${why}`);
}

async function ensureCommitContract(T: Keypair, sac: string): Promise<string> {
  const owner = T.publicKey();
  const override = process.env.COMMIT_CONTRACT;
  if (override) {
    if (!StrKey.isValidContract(override)) refuse(`COMMIT_CONTRACT is not a contract id: ${override}`);
    if (state.contract && state.contract !== override) setAsideCommitRows(`COMMIT_CONTRACT replaces ${state.contract}`);
    const wasmHash = await checkDeployment(override, sac, owner);
    state.contract = override;
    if (wasmHash) state.wasmHash = wasmHash;
    save();
    step(`commitment contract (COMMIT_CONTRACT): ${override}`);
    return override;
  }
  if (!existsSync(WASM_PATH)) {
    if (state.contract && (await instanceOf(state.contract))) {
      step(`WARNING: no wasm at ${WASM_PATH}; measuring the recorded deployment ${state.contract}`);
      await checkDeployment(state.contract, sac, owner);
      return state.contract;
    }
    throw new Error(`no wasm at ${WASM_PATH}: run \`stellar contract build\` in contracts/lumen-drop-commit, or set WASM / COMMIT_CONTRACT`);
  }
  const wasm = readFileSync(WASM_PATH);
  const wasmHash = hash(wasm);
  // Deterministic per (T, wasm): a rerun that crashed after the create finds the same id and reuses it.
  const salt = hash(Buffer.concat([Buffer.from("lumenia-spike11:"), wasmHash]));
  const id = contractIdFor(owner, salt, NET);
  if (state.contract && state.contract !== id) setAsideCommitRows(`the wasm changed, new deployment ${id}`);
  state.contract = id;
  state.wasmHash = wasmHash.toString("hex");
  save();
  if (await instanceOf(id)) {
    step(`commitment contract ${id} already deployed (wasm ${short(state.wasmHash)})`);
  } else {
    if (!(await entry(codeKey(wasmHash)))) {
      step(`uploading ${wasm.length} bytes of wasm (${short(state.wasmHash)})`);
      const up = await measure(T, Operation.uploadContractWasm({ wasm }), { leg: "commit", run: -1, op: "upload", contract: id });
      const uploaded = up.res.returnValue ? Buffer.from(scValToNative(up.res.returnValue) as Uint8Array) : null;
      if (!uploaded || !uploaded.equals(wasmHash)) throw new Error("the upload returned a different wasm hash");
    }
    step(`creating ${id}: constructor(token = ${short(sac)}, owner = T)`);
    const created = await measure(
      T,
      Operation.createCustomContract({
        address: Address.fromString(owner),
        wasmHash,
        salt,
        constructorArgs: commitArgs.__constructor(sac, owner),
      }),
      { leg: "commit", run: -1, op: "create", contract: id },
    );
    const got = created.res.returnValue ? Address.fromScVal(created.res.returnValue).toString() : null;
    if (got !== id) throw new Error(`createCustomContract returned ${got}, expected ${id}`);
  }
  await checkDeployment(id, sac, owner);
  return id;
}

/** Circle testnet USDC for the control leg, from the testnet sponsor's /faucet. Returns why the leg is skipped, or null. */
async function prepareControl(T: Keypair, R: Keypair): Promise<string | null> {
  try {
    if (scValToNative(await view(CONTROL_CONTRACT, "paused", [])) === true) return "the live escrow is paused (deposit is pause-gated)";
  } catch (e) {
    // Not fatal: a paused escrow still refuses the first deposit loudly.
    step(`WARNING: could not read the live escrow's paused flag: ${(e as Error).message.split("\n")[0]}`);
  }
  await ensureTrustline(T, "T", CIRCLE_USDC);
  await ensureTrustline(R, "R", CIRCLE_USDC);
  const todo = N - completedRuns("control");
  if (todo <= 0) return null;
  let held = await trustlineStroops(T.publicKey(), CIRCLE_USDC);
  if (faucetCallsNeeded(nextRunIndex("control"), todo, held) === 0) return null;

  let health: { network?: string; usdcIssuer?: string };
  try {
    const r = await fetch(`${SPONSOR_URL}/health`);
    if (!r.ok) return `the sponsor /health answered HTTP ${r.status}`;
    health = (await r.json()) as { network?: string; usdcIssuer?: string };
  } catch (e) {
    return `the sponsor /health could not be reached: ${(e as Error).message}`;
  }
  if (health.network !== "testnet" || health.usdcIssuer !== USDC_ISSUERS.testnet) {
    refuse(`${SPONSOR_URL} reports network "${health.network}", USDC issuer ${health.usdcIssuer}`);
  }

  let calls = 0;
  let retries = 0;
  while (faucetCallsNeeded(nextRunIndex("control"), todo, held) > 0) {
    if (calls >= FAUCET_MAX_CALLS) return `the faucet paid ${calls} times and T is still short`;
    step(`faucet: 1 USDC -> T (call ${calls + 1})`);
    const r = await fetch(`${SPONSOR_URL}/faucet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipientPublicKey: T.publicKey() }),
    });
    const text = (await r.text()).slice(0, 300);
    if (r.status === 429) {
      if (++retries > 3) return `the faucet kept rate-limiting: ${text}`;
      step("faucet rate limit: waiting 61 s");
      await sleep(61_000);
      continue;
    }
    // The faucet checks the trustline on Horizon, which can trail the RPC by a ledger.
    if (r.status === 400 && text.includes("no USDC trustline")) {
      if (++retries > 3) return `the faucet does not see T's trustline: ${text}`;
      await sleep(3_000);
      continue;
    }
    if (!r.ok) return `the faucet refused: HTTP ${r.status} ${text}`;
    calls++;
    const before = held;
    for (let i = 0; i < 30 && held <= before; i++) {
      await sleep(POLL_MS);
      held = await trustlineStroops(T.publicKey(), CIRCLE_USDC);
    }
    if (held <= before) return "the faucet answered 200 but T's balance did not move";
    await sleep(FAUCET_SPACING_MS);
  }
  return null;
}

/* ---------- the two legs ---------- */

interface LegSpec {
  leg: Leg;
  contract: string;
  senderIsIssuer: boolean;
  deposit(p: PendingRun, link: Buffer): xdr.Operation;
  messageArgs(p: PendingRun, link: Buffer): xdr.ScVal[];
  /** the locally built message for the parity check; null when the leg has none */
  localMessage(p: PendingRun, link: Buffer): Buffer | null;
  claim(p: PendingRun, link: Buffer, sig: Buffer): xdr.Operation;
}

function saltOf(p: PendingRun): Buffer {
  if (!p.salt) throw new Error(`run #${p.run} has no salt`);
  return Buffer.from(p.salt, "hex");
}

function commitLeg(contract: string, T: string, R: string): LegSpec {
  const c = new Contract(contract);
  return {
    leg: "commit",
    contract,
    senderIsIssuer: true,
    deposit: (p, link) =>
      c.call("deposit", ...commitArgs.deposit(T, link, commitmentOf(link, BigInt(p.amount), saltOf(p)), BigInt(p.amount), BigInt(p.expiry))),
    messageArgs: (p, link) => commitArgs.claim_message(link, R, BigInt(p.amount), saltOf(p)),
    localMessage: (p, link) => claimMessage(networkIdOf(NET), contract, link, R, BigInt(p.amount), saltOf(p)),
    claim: (p, link, sig) => c.call("claim", ...commitArgs.claim(link, R, sig, BigInt(p.amount), saltOf(p))),
  };
}

function controlLeg(T: string, R: string): LegSpec {
  const c = new Contract(CONTROL_CONTRACT);
  return {
    leg: "control",
    contract: CONTROL_CONTRACT,
    senderIsIssuer: false,
    deposit: (p, link) => c.call("deposit", ...controlArgs.deposit(T, link, BigInt(p.amount), BigInt(p.expiry))),
    messageArgs: (_p, link) => controlArgs.claim_message(link, R),
    localMessage: () => null,
    claim: (_p, link, sig) => c.call("claim", ...controlArgs.claim(link, R, sig)),
  };
}

/** Client/contract agreement. Kept in the state next to the rows it covers, so a resumed run still reports it. */
interface Parity {
  /** commitment_of(the known-answer inputs) on chain */
  knownAnswer: string;
  /** commitment_of(a run's own inputs) on chain vs the local sha256, before each invocation's first deposit */
  commitmentOf: string;
  claimMessage: { checked: number; mismatches: number };
}

const parity = (): Parity =>
  (state.parity ??= { knownAnswer: "not checked", commitmentOf: "not checked", claimMessage: { checked: 0, mismatches: 0 } });

const KAT = {
  link: Buffer.alloc(32, 0x11),
  amount: 1_234_567n,
  salt: Buffer.alloc(32, 0x22),
  commitment: "ea3424656bc0651d6bfc1f35d020dd77fd5c906fae5e81a443ecd58228a3f8d5",
};

/** Before any money moves into the commitment escrow: the contract hashes exactly as this client does. */
async function checkCommitmentParity(contract: string, link: Buffer, p: PendingRun): Promise<void> {
  const kat = Buffer.from(
    scValToNative(await view(contract, "commitment_of", commitArgs.commitment_of(KAT.link, KAT.amount, KAT.salt))) as Uint8Array,
  ).toString("hex");
  parity().knownAnswer = kat === KAT.commitment ? "match" : `MISMATCH (${kat})`;
  const local = commitmentOf(link, BigInt(p.amount), saltOf(p));
  const onChain = Buffer.from(scValToNative(await view(contract, "commitment_of", commitArgs.commitment_of(link, BigInt(p.amount), saltOf(p)))) as Uint8Array);
  parity().commitmentOf = local.equals(onChain) ? "match" : "MISMATCH";
  save();
  if (kat !== KAT.commitment || !local.equals(onChain)) {
    throw new Error(`commitment_of parity failed before any deposit: known answer ${parity().knownAnswer}, this run ${parity().commitmentOf}`);
  }
  step("commitment_of parity: the contract's view matches the local sha256 (known answer and this run)");
}

async function claimStep(spec: LegSpec, p: PendingRun, linkKp: Keypair, T: Keypair): Promise<void> {
  const link = Buffer.from(linkKp.rawPublicKey());
  const msg = Buffer.from((await view(spec.contract, "claim_message", spec.messageArgs(p, link))).bytes());
  const local = spec.localMessage(p, link);
  if (local) {
    parity().claimMessage.checked++;
    if (!local.equals(msg)) {
      parity().claimMessage.mismatches++;
      console.error(`  claim_message MISMATCH on ${spec.leg} #${p.run}: local ${local.length} bytes, contract ${msg.length} bytes`);
    }
  }
  // Sign the contract's own bytes, as the product does: a layout mismatch fails the run at the end
  // but never strands the drop.
  const sig = linkKp.sign(msg);
  const base: RowBase = { leg: spec.leg, run: p.run, op: "claim", contract: spec.contract, link: link.toString("hex"), amount: p.amount };
  await measure(T, spec.claim(p, link, sig), base, p);
  const drop = await getDrop(spec.contract, link);
  if (drop?.claimed !== true) throw new Error(`${spec.leg} #${p.run}: the claim landed but get_drop does not say claimed`);
}

let commitmentParityChecked = false;

async function doRun(spec: LegSpec, run: number, T: Keypair): Promise<void> {
  const linkKp = Keypair.random();
  const p: PendingRun = {
    run,
    linkSecret: linkKp.secret(),
    amount: amountFor(run).toString(),
    ...(spec.leg === "commit" ? { salt: randomBytes(32).toString("hex") } : {}),
    expiry: (nowSec() + BigInt(EXPIRY_SECONDS)).toString(),
    deposited: false,
  };
  state.pending[spec.leg] = p;
  save();
  const link = Buffer.from(linkKp.rawPublicKey());
  if (spec.leg === "commit" && !commitmentParityChecked) {
    await checkCommitmentParity(spec.contract, link, p);
    commitmentParityChecked = true;
  }
  const base: RowBase = {
    leg: spec.leg,
    run,
    op: "deposit",
    contract: spec.contract,
    link: link.toString("hex"),
    amount: p.amount,
    senderIsIssuer: spec.senderIsIssuer,
  };
  await measure(T, spec.deposit(p, link), base, p);
  if (spec.leg === "commit" && !state.visibility) await captureDeposit(spec.contract, p, link);
  await claimStep(spec, p, linkKp, T);
  delete state.pending[spec.leg];
  save();
}

/** A run an earlier invocation left in flight: settle it from the ledger, never guess. */
async function settlePending(spec: LegSpec, T: Keypair): Promise<void> {
  const p = state.pending[spec.leg];
  if (!p) return;
  const linkKp = Keypair.fromSecret(p.linkSecret);
  const link = Buffer.from(linkKp.rawPublicKey());
  step(`${spec.leg} #${p.run}: settling a run an earlier invocation left in flight`);
  if (p.inflight) {
    const g = await RPC.getTransaction(p.inflight.hash);
    if (g.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const base: RowBase = { leg: spec.leg, run: p.run, op: p.inflight.op, contract: spec.contract, link: link.toString("hex"), amount: p.amount };
      if (p.inflight.op === "deposit") base.senderIsIssuer = spec.senderIsIssuer;
      state.rows.push(toRow(base, p.inflight.hash, p.inflight.sim, p.inflight.submittedAt, g, null));
      if (p.inflight.op === "deposit") p.deposited = true;
      step(`  its ${p.inflight.op} landed in ledger ${g.ledger}: recorded, without a wall time`);
    } else {
      step(`  its ${p.inflight.op} ${g.status === rpc.Api.GetTransactionStatus.FAILED ? "failed on chain" : "never landed"}`);
    }
    delete p.inflight;
    save();
  }
  const drop = await getDrop(spec.contract, link);
  if (!drop || drop.claimed === true) {
    const done = state.rows.some((r) => r.leg === spec.leg && r.run === p.run && r.op === "claim");
    step(`  ${drop ? "already claimed" : "no drop on the escrow"}: run #${p.run} ${done ? "is complete" : "is closed incomplete, a new run takes its place"}`);
    delete state.pending[spec.leg];
    save();
    return;
  }
  if (spec.leg === "commit" && !state.visibility) await captureDeposit(spec.contract, p, link);
  await claimStep(spec, p, linkKp, T);
  delete state.pending[spec.leg];
  save();
}

/* ---------- visibility: where the amount of the first commitment deposit is public ---------- */

const amountShown = (value: unknown, amount: string) => JSON.stringify(value).includes(`{"i128":"${amount}"}`);

/** Every contract-fn invocation in an auth tree, with its path. */
function walkAuth(inv: xdr.SorobanAuthorizedInvocation, path: string, out: { path: string; fn: xdr.InvokeContractArgs }[]): void {
  const f = inv.function();
  if (f.switch().name === "sorobanAuthorizedFunctionTypeContractFn") out.push({ path: `${path}.function.contractFn`, fn: f.contractFn() });
  inv.subInvocations().forEach((s, i) => walkAuth(s, `${path}.subInvocations[${i}]`, out));
}

/** The raw RPC fields one visibility record is built from, so the builder runs offline on synthetic XDR too. */
interface VisibilityInput {
  contract: string;
  sac: string;
  /** the commitment leg's asset issuer, T */
  issuer: string;
  link: Buffer;
  amount: string;
  commitment: string;
  depositTx: string;
  depositLedger: number;
  /** getTransaction: envelopeXdr, resultMetaXdr, events.contractEventsXdr (absent on an RPC without the field) */
  tx: { envelopeXdr: string; resultMetaXdr: string; contractEventsXdr: string[][] };
  /** getLedgerEntries: entries[0] for DataKey::Drop(link) */
  entry: { key: string; xdr: string; lastModifiedLedgerSeq?: number; liveUntilLedgerSeq?: number };
}

function buildVisibility(v: VisibilityInput): Visibility {
  const items: VisItem[] = [];
  const notes: string[] = [];
  const push = (it: Omit<VisItem, "showsAmount">) => items.push({ ...it, showsAmount: amountShown(it.value, v.amount) });

  const env = xdr.TransactionEnvelope.fromXDR(v.tx.envelopeXdr, "base64");
  if (env.switch().name !== "envelopeTypeTx") throw new Error(`unexpected envelope ${env.switch().name}`);
  const ihf = env.v1().tx().operations()[0]!.body().invokeHostFunctionOp();
  const ic = ihf.hostFunction().invokeContract();
  const opPath = "v1.tx.operations[0].body.invokeHostFunctionOp";
  const fromEnvelope = { source: "getTransaction" as const, rpcField: "envelopeXdr", xdrType: "TransactionEnvelope" };
  push({
    ...fromEnvelope,
    item: "deposit call: (from, link, commitment, amount, expiry)",
    path: `${opPath}.hostFunction.invokeContract`,
    nodeXdr: ic.toXDR("base64"),
    value: invokeJson(ic),
  });
  push({
    ...fromEnvelope,
    item: "the amount argument",
    path: `${opPath}.hostFunction.invokeContract.args[3]`,
    nodeXdr: ic.args()[3]!.toXDR("base64"),
    value: scvJson(ic.args()[3]!),
  });
  ihf.auth().forEach((a, ai) => {
    const found: { path: string; fn: xdr.InvokeContractArgs }[] = [];
    walkAuth(a.rootInvocation(), `${opPath}.auth[${ai}].rootInvocation`, found);
    for (const { path, fn } of found) {
      const name = fn.functionName().toString();
      const what = path.includes("subInvocations")
        ? `auth[${ai}] sub-invocation: ${name}${name === "transfer" ? " (from, to, amount)" : ""}`
        : `auth[${ai}] root invocation: ${name} (credentials ${a.credentials().switch().name})`;
      push({ ...fromEnvelope, item: what, path, nodeXdr: fn.toXDR("base64"), value: invokeJson(fn) });
    }
  });

  // Labels name the emitter and topic only; whether each one carries the amount is read from its data (showsAmount).
  const meta = xdr.TransactionMeta.fromXDR(v.tx.resultMetaXdr, "base64");
  const eventItem = (e: xdr.ContractEvent, at: { rpcField: string; xdrType: string; path: string; metaPath?: string }) => {
    const j = eventJson(e);
    const topic = (j.topics[0] as { symbol?: string } | undefined)?.symbol ?? "?";
    const who = j.contractId === v.sac ? "SAC" : j.contractId === v.contract ? "escrow" : "contract";
    const why = who === "SAC" && topic === "mint" ? " (mint, not transfer: the sender issues the asset, CAP-67)" : "";
    push({ source: "getTransaction", ...at, item: `${who} "${topic}" event${why}`, nodeXdr: e.toXDR("base64"), value: j });
  };
  const events = v.tx.contractEventsXdr;
  if ((events[0] ?? []).length > 0) {
    events[0]!.forEach((b64, k) =>
      eventItem(xdr.ContractEvent.fromXDR(b64, "base64"), {
        rpcField: `events.contractEventsXdr[0][${k}]`,
        xdrType: "ContractEvent",
        path: "",
        metaPath: `v4.operations[0].events[${k}]`,
      }),
    );
  } else if (meta.switch() === 4) {
    // An RPC without the `events` field: the same events live in the v4 meta.
    meta.v4().operations()[0]?.events().forEach((e, k) =>
      eventItem(e, { rpcField: "resultMetaXdr", xdrType: "TransactionMeta", path: `v4.operations[0].events[${k}]` }),
    );
  }

  if (meta.switch() === 4) {
    meta.v4().operations()[0]?.changes().forEach((c, k) => {
      const arm = c.switch().name;
      const post = arm === "ledgerEntryCreated" ? c.created() : arm === "ledgerEntryUpdated" ? c.updated() : null;
      if (!post || post.data().switch().name !== "contractData") return;
      const cd = post.data().contractData();
      const field = arm === "ledgerEntryCreated" ? "created" : "updated";
      push({
        source: "getTransaction",
        rpcField: "resultMetaXdr",
        xdrType: "TransactionMeta",
        item: `ledger change in the meta (${field}): ${dataLabel(cd.contract(), cd.key())}`,
        path: `v4.operations[0].changes[${k}].${field}.data.contractData`,
        nodeXdr: cd.toXDR("base64"),
        value: { key: scvJson(cd.key()), val: scvJson(cd.val()) },
      });
    });
  } else {
    notes.push(`resultMetaXdr is v${meta.switch()}, not v4: its ledger changes are not itemised`);
  }

  const val = xdr.LedgerEntryData.fromXDR(v.entry.xdr, "base64").contractData().val();
  const fromEntry = { source: "getLedgerEntries" as const, rpcField: "entries[0].xdr", xdrType: "LedgerEntryData" };
  push({
    ...fromEntry,
    item: "the escrow's Drop entry (DropEntry::V1), decoded",
    path: "contractData.val",
    nodeXdr: val.toXDR("base64"),
    value: { decoded: dropFields(val), xdrJson: scvJson(val) },
  });
  const fields = val.switch().name === "scvVec" ? (val.vec()?.[1]?.map() ?? []) : [];
  for (const name of ["commitment", "escrowed"]) {
    const i = fields.findIndex((e) => e.key().switch().name === "scvSymbol" && e.key().sym().toString() === name);
    if (i < 0) {
      notes.push(`the Drop entry has no "${name}" field`);
      continue;
    }
    push({
      ...fromEntry,
      item: `Drop.${name}`,
      path: `contractData.val.vec[1].map[${i}].val`,
      nodeXdr: fields[i]!.val().toXDR("base64"),
      value: scvJson(fields[i]!.val()),
    });
  }

  return {
    note:
      "Where the amount of the FIRST commitment deposit is public on chain. The commitment does not hide it. " +
      "rpcField is the raw base64 XDR field of the RPC result and xdrType its type; path is relative to that field " +
      "(empty = the field itself), in XDR field names as @stellar/stellar-sdk 16.3.0 exposes them; nodeXdr is the " +
      "base64 XDR of the node at path. showsAmount is computed from the decoded value, not asserted.",
    contract: v.contract,
    sac: v.sac,
    asset: `USDC:${v.issuer}`,
    link: v.link.toString("hex"),
    amount: v.amount,
    commitment: v.commitment,
    depositTx: v.depositTx,
    depositLedger: v.depositLedger,
    explorer: { depositTx: `${EXPLORER}/tx/${v.depositTx}`, contract: `${EXPLORER}/contract/${v.contract}` },
    shownIn: `${items.filter((i) => i.showsAmount).length} of ${items.length} items`,
    ...(notes.length > 0 ? { notes } : {}),
    items,
    raw: {
      deposit: v.tx,
      dropEntry: {
        ledgerKeyXdr: v.entry.key,
        xdr: v.entry.xdr,
        lastModifiedLedgerSeq: v.entry.lastModifiedLedgerSeq,
        liveUntilLedgerSeq: v.entry.liveUntilLedgerSeq,
      },
    },
  };
}

/** Read the escrow's record while the drop is live (before the claim), then the deposit itself; build the record. */
async function captureDeposit(contract: string, p: PendingRun, link: Buffer): Promise<void> {
  const depositRow = state.rows.find((r) => r.leg === "commit" && r.run === p.run && r.op === "deposit");
  if (!depositRow) return; // nothing to point at: a later run captures it
  const le = await RPC._getLedgerEntries(dropKey(contract, link));
  const entry = le.entries?.[0];
  if (!entry) throw new Error("the Drop entry is not on the ledger right after its deposit");
  const tx = await RPC._getTransaction(depositRow.hash);
  if (tx.status !== rpc.Api.GetTransactionStatus.SUCCESS || !tx.envelopeXdr || !tx.resultMetaXdr) {
    throw new Error(`getTransaction(${depositRow.hash}) did not return the deposit (status ${tx.status})`);
  }
  state.visibility = buildVisibility({
    contract,
    sac: state.sac ?? "",
    issuer: state.T.publicKey,
    link,
    amount: p.amount,
    commitment: commitmentOf(link, BigInt(p.amount), saltOf(p)).toString("hex"),
    depositTx: depositRow.hash,
    depositLedger: depositRow.ledger,
    tx: { envelopeXdr: tx.envelopeXdr, resultMetaXdr: tx.resultMetaXdr, contractEventsXdr: tx.events?.contractEventsXdr ?? [] },
    entry: { key: entry.key, xdr: entry.xdr, lastModifiedLedgerSeq: entry.lastModifiedLedgerSeq, liveUntilLedgerSeq: entry.liveUntilLedgerSeq },
  });
  save();
  step(`visibility: the amount is public in ${state.visibility.shownIn} recorded`);
}

/** The claim of that drop reveals (amount, salt) in its arguments: anyone can then recompute the commitment. */
function claimRevealItems(envelopeXdr: string, amount: string): VisItem[] {
  const ic = xdr.TransactionEnvelope.fromXDR(envelopeXdr, "base64")
    .v1()
    .tx()
    .operations()[0]!
    .body()
    .invokeHostFunctionOp()
    .hostFunction()
    .invokeContract();
  const path = "v1.tx.operations[0].body.invokeHostFunctionOp.hostFunction.invokeContract";
  const item = (what: string, p: string, node: xdr.ScVal | xdr.InvokeContractArgs, value: unknown): VisItem => ({
    item: what,
    source: "getTransaction",
    rpcField: "envelopeXdr",
    xdrType: "TransactionEnvelope",
    path: p,
    nodeXdr: node.toXDR("base64"),
    value,
    showsAmount: amountShown(value, amount),
  });
  return [
    item("claim call: (link, payout, sig, amount, salt), the reveal is public", path, ic, invokeJson(ic)),
    item("the revealed amount", `${path}.args[3]`, ic.args()[3]!, scvJson(ic.args()[3]!)),
    item("the revealed salt: with the amount, anyone can recompute the stored commitment", `${path}.args[4]`, ic.args()[4]!, scvJson(ic.args()[4]!)),
  ];
}

/** Read after the fact, so it survives a restart between the first claim and the end of the run. */
async function captureClaim(): Promise<void> {
  const v = state.visibility;
  if (!v || v.claimItems) return;
  const row = state.rows.find((r) => r.leg === "commit" && r.op === "claim" && r.link === v.link);
  if (!row) return;
  const tx = await RPC._getTransaction(row.hash);
  if (tx.status !== rpc.Api.GetTransactionStatus.SUCCESS || !tx.envelopeXdr) {
    step(`note: the first claim (${row.hash}) is no longer on the RPC; its reveal items are left out`);
    return;
  }
  v.claimTx = row.hash;
  v.explorer.claimTx = `${EXPLORER}/tx/${row.hash}`;
  v.claimItems = claimRevealItems(tx.envelopeXdr, v.amount);
  v.raw.claim = { envelopeXdr: tx.envelopeXdr };
  save();
}

/* ---------- outputs ---------- */

const COLUMNS: { key: keyof Row; label: string }[] = [
  { key: "instructions", label: "instructions" },
  { key: "diskReadBytes", label: "diskReadBytes" },
  { key: "writeBytes", label: "writeBytes" },
  { key: "footprintReadOnly", label: "footprint read-only entries" },
  { key: "footprintReadWrite", label: "footprint read-write entries" },
  { key: "minResourceFee", label: "minResourceFee (stroops)" },
  { key: "resourceFee", label: "transactionData resourceFee (stroops)" },
  { key: "inclusionFee", label: "inclusion fee offered (stroops)" },
  { key: "feeOffered", label: "fee offered (stroops)" },
  { key: "feeCharged", label: "feeCharged (stroops)" },
  { key: "wallMs", label: "wall ms, send to SUCCESS" },
];

interface Stat {
  n: number;
  median: number | null;
  max: number | null;
}

/** Median: the middle value; for an even n, the mean of the two middle values. */
function stats(xs: number[]): Stat {
  if (xs.length === 0) return { n: 0, median: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return { n: s.length, median, max: s[s.length - 1]! };
}

interface Group {
  leg: Leg;
  contract: string;
  op: Op;
  n: number;
  columns: Record<string, Stat>;
}

function summarise(rows: Row[]): Group[] {
  const order: Op[] = ["deposit", "claim", "upload", "create"];
  const groups: Group[] = [];
  for (const leg of ["commit", "control"] as Leg[]) {
    for (const op of order) {
      const contracts = [...new Set(rows.filter((r) => r.leg === leg && r.op === op).map((r) => r.contract))];
      for (const contract of contracts) {
        const rs = rows.filter((r) => r.leg === leg && r.op === op && r.contract === contract);
        const columns: Record<string, Stat> = {};
        for (const c of COLUMNS) {
          columns[c.key] = stats(rs.map((r) => r[c.key]).filter((x) => x !== null && x !== undefined).map((x) => Number(x)));
        }
        groups.push({ leg, contract, op, n: rs.length, columns });
      }
    }
  }
  return groups;
}

const fmt = (x: number | null) => (x === null ? "-" : Number.isInteger(x) ? String(x) : x.toFixed(1));

function markdown(m: {
  generatedAt: string;
  protocolVersion: string | number;
  sdk: string;
  groups: Group[];
  commit: { contract: string; wasmHash?: string; asset: string };
  controlSkipped: string | null;
  rows: Row[];
}): string {
  const L: string[] = [];
  const main = m.groups.filter((g) => g.op === "deposit" || g.op === "claim");
  const order = (["deposit", "claim"] as Op[]).flatMap((op) => main.filter((g) => g.op === op));
  L.push("# Spike 11: the commitment escrow next to the live v2 escrow (testnet)");
  L.push("");
  L.push(`Generated ${m.generatedAt} by \`apps/sponsor/src/spike11-commitment.ts\`. Testnet, protocol ${m.protocolVersion}, RPC ${RPC_URL}.`);
  L.push(`Node ${process.version}, @stellar/stellar-sdk ${m.sdk}. Every row is in \`measurements.json\`; where the amount stays public is in \`visibility.json\`.`);
  L.push("");
  L.push(`- commit: \`${m.commit.contract}\` (contracts/lumen-drop-commit${m.commit.wasmHash ? `, wasm ${m.commit.wasmHash}` : ""}), asset ${m.commit.asset}`);
  L.push(`- control: \`${CONTROL_CONTRACT}\` (the live testnet v2 escrow), asset USDC:${USDC_ISSUERS.testnet}${m.controlSkipped ? ` - NOT MEASURED in the last invocation: ${m.controlSkipped}` : ""}`);
  L.push("");
  L.push("Each cell is median / max over the rows of that contract and operation.");
  L.push("");
  L.push(`| metric | ${order.map((g) => `${g.leg} ${g.op}`).join(" | ")} |`);
  L.push(`|---|${order.map(() => "---:").join("|")}|`);
  L.push(`| n | ${order.map((g) => g.n).join(" | ")} |`);
  for (const c of COLUMNS) {
    L.push(`| ${c.label} | ${order.map((g) => { const s = g.columns[c.key]!; return `${fmt(s.median)} / ${fmt(s.max)}${s.n !== g.n ? ` (n=${s.n})` : ""}`; }).join(" | ")} |`);
  }
  const pair = (op: Op) => [main.find((g) => g.leg === "commit" && g.op === op), main.find((g) => g.leg === "control" && g.op === op)];
  const [cd, xd] = pair("deposit");
  const [cc, xc] = pair("claim");
  if ((cd && xd) || (cc && xc)) {
    L.push("");
    L.push("Difference of medians, commit minus control (see note 2 before reading the deposit column):");
    L.push("");
    L.push("| metric | deposit | claim |");
    L.push("|---|---:|---:|");
    const diff = (a: Group | undefined, b: Group | undefined, k: string) => {
      const x = a?.columns[k]?.median;
      const y = b?.columns[k]?.median;
      return x === null || x === undefined || y === null || y === undefined ? "-" : fmt(x - y);
    };
    for (const c of COLUMNS) L.push(`| ${c.label} | ${diff(cd, xd, c.key)} | ${diff(cc, xc, c.key)} |`);
  }
  const deploy = m.rows.filter((r) => r.op === "upload" || r.op === "create");
  if (deploy.length > 0) {
    L.push("");
    L.push("One-time deployment of the commitment contract:");
    L.push("");
    L.push("| op | tx | instructions | diskReadBytes | writeBytes | resourceFee | feeCharged |");
    L.push("|---|---|---:|---:|---:|---:|---:|");
    for (const r of deploy) L.push(`| ${r.op} | \`${r.hash}\` | ${r.instructions} | ${r.diskReadBytes} | ${r.writeBytes} | ${r.resourceFee} | ${r.feeCharged} |`);
  }
  L.push("");
  L.push("Notes");
  L.push("");
  L.push("1. The sender T submitted and paid for every transaction directly; no sponsor relay is in any number here.");
  L.push(
    "2. The commitment deposit is sent by the asset's issuer (T issues the USDC code the commitment escrow pins), so its SAC leg is a mint: " +
      "no sender trustline is read or written, and the SAC emits `mint` rather than `transfer` (CAP-67). The control deposit spends T's " +
      "Circle USDC trustline. Deposit rows are therefore not like-for-like; the per-row footprint labels in measurements.json show the " +
      "difference entry by entry. Claim rows are like-for-like (escrow balance to R's trustline on both legs).",
  );
  L.push(
    "3. The commitment does not hide the amount. The deposit moves it through a public SAC `transfer` call (emitted as `mint` here, see " +
      "note 2), the escrow stores it in the clear as `escrowed` (it pays out the stored amount, never the revealed one), and the claim " +
      "reveals amount and salt. visibility.json lists each place.",
  );
  L.push(
    `4. wall ms runs from sendTransaction to the first getTransaction SUCCESS, polled every ${POLL_MS} ms: it is dominated by ledger close ` +
      "time and carries up to one poll interval of granularity. Max columns include first-time effects, such as the first commitment " +
      "deposit creating the escrow's SAC balance entry.",
  );
  L.push(
    "5. Field names (stellar-sdk 16.3.0): minResourceFee is the simulateTransaction result; instructions, diskReadBytes, writeBytes are " +
      "SorobanResources accessors of the simulated transactionData; footprint entries are LedgerFootprint.readOnly() / readWrite() lengths; " +
      "resourceFee is SorobanTransactionData.resourceFee(); fee offered is Transaction.fee after assembleTransaction (inclusion fee + " +
      "resourceFee); feeCharged is TransactionResult.feeCharged() from getTransaction.",
  );
  L.push("");
  return L.join("\n");
}

function sdkVersion(): string {
  try {
    let dir = dirname(createRequire(import.meta.url).resolve("@stellar/stellar-sdk"));
    for (let i = 0; i < 6; i++) {
      const p = join(dir, "package.json");
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, "utf8")) as { name?: string; version?: string };
        if (j.name === "@stellar/stellar-sdk" && j.version) return j.version;
      }
      dir = dirname(dir);
    }
  } catch {
    // fall through
  }
  return "unknown";
}

function writeOutputs(m: {
  network: rpc.Api.GetNetworkResponse;
  atStart: rpc.Api.GetLatestLedgerResponse;
  atEnd: rpc.Api.GetLatestLedgerResponse;
  controlSkipped: string | null;
}): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const sdk = sdkVersion();
  const ledger = (l: rpc.Api.GetLatestLedgerResponse) => ({ sequence: l.sequence, protocolVersion: l.protocolVersion, closeTime: l.closeTime, id: l.id });
  const groups = summarise(state.rows);
  const commit = { contract: state.contract ?? "", wasmHash: state.wasmHash, asset: `USDC:${state.T.publicKey}` };
  const out = {
    spike: "spike11-commitment",
    script: "apps/sponsor/src/spike11-commitment.ts",
    generatedAt,
    network: { name: "testnet", passphrase: m.network.passphrase, protocolVersion: m.network.protocolVersion, rpc: RPC_URL },
    latestLedger: { atStart: ledger(m.atStart), atEnd: ledger(m.atEnd) },
    toolchain: { node: process.version, stellarSdk: sdk, protocolVersion: m.network.protocolVersion },
    method: {
      runsPerLeg: N,
      pollIntervalMs: POLL_MS,
      inclusionFeeOffered: INCLUSION_FEE,
      amountStroops: `${BASE_AMOUNT} + run index`,
      expirySeconds: EXPIRY_SECONDS,
      submitter: "T submits and pays for every transaction; no sponsor relay",
      fieldNames: {
        minResourceFee: "simulateTransaction result: minResourceFee",
        resourceFee: "simulated transactionData: SorobanTransactionData.resourceFee()",
        instructions: "SorobanTransactionData.resources().instructions()",
        diskReadBytes: "SorobanTransactionData.resources().diskReadBytes()",
        writeBytes: "SorobanTransactionData.resources().writeBytes()",
        footprintReadOnly: "SorobanTransactionData.resources().footprint().readOnly().length",
        footprintReadWrite: "SorobanTransactionData.resources().footprint().readWrite().length",
        archivedEntries: "SorobanTransactionData.ext() v1: resourceExt().archivedSorobanEntries().length",
        inclusionFee: "the TransactionBuilder fee (one operation)",
        feeOffered: "Transaction.fee after assembleTransaction: inclusion fee + resourceFee",
        feeCharged: "getTransaction: resultXdr TransactionResult.feeCharged()",
        ledger: "getTransaction: ledger",
        wallMs: `performance.now() from the first sendTransaction to the first getTransaction SUCCESS, polled every ${POLL_MS} ms`,
      },
    },
    accounts: { T: state.T.publicKey, R: state.R.publicKey },
    legs: {
      commit: { ...commit, sac: state.sac, senderIsIssuer: true },
      control: { contract: CONTROL_CONTRACT, asset: `USDC:${USDC_ISSUERS.testnet}`, senderIsIssuer: false, skippedLastInvocation: m.controlSkipped },
    },
    parity: parity(),
    summary: groups,
    rows: state.rows,
  };
  writeFileSync(join(OUT_DIR, "measurements.json"), JSON.stringify(out, null, 2) + "\n");
  writeFileSync(
    join(OUT_DIR, "measurements.md"),
    markdown({ generatedAt, protocolVersion: m.network.protocolVersion, sdk, groups, commit, controlSkipped: m.controlSkipped, rows: state.rows }),
  );
  if (state.visibility) writeFileSync(join(OUT_DIR, "visibility.json"), JSON.stringify(state.visibility, null, 2) + "\n");
  step(`wrote ${join("evidence", "spike11")}/measurements.json, measurements.md${state.visibility ? ", visibility.json" : ""}`);
}

/* ---------- live ---------- */

async function live(): Promise<void> {
  const refusal = testnetRefusal(NET, [RPC_URL, FRIENDBOT_URL, SPONSOR_URL]);
  if (refusal) refuse(refusal);
  if (commitmentOf(KAT.link, KAT.amount, KAT.salt).toString("hex") !== KAT.commitment) {
    throw new Error("the known-answer commitment does not reproduce locally; nothing was sent");
  }
  const network = await RPC.getNetwork();
  if (network.passphrase !== NET) refuse(`${RPC_URL} serves "${network.passphrase}"`);
  // After the network is confirmed, before any friendbot call.
  state = loadOrCreateState();
  const atStart = await RPC.getLatestLedger();
  console.log("============================================================");
  console.log(` SPIKE #11: commitment escrow vs ${short(CONTROL_CONTRACT)} (testnet, protocol ${network.protocolVersion}, ledger ${atStart.sequence})`);
  console.log("============================================================");
  const T = Keypair.fromSecret(state.T.secret);
  const R = Keypair.fromSecret(state.R.secret);
  step(`T (sender, issuer, owner, fee payer): ${T.publicKey()}`);
  step(`R (recipient): ${R.publicKey()}`);
  await ensureAccount(T, "T");
  await ensureAccount(R, "R");

  const asset = new Asset("USDC", T.publicKey());
  state.sac = await ensureSac(T, asset);
  save();
  await ensureTrustline(R, "R", asset);
  const contract = await ensureCommitContract(T, state.sac);
  const commit = commitLeg(contract, T.publicKey(), R.publicKey());
  const control = controlLeg(T.publicKey(), R.publicKey());

  // Settle first: a pending drop holds funds, and claiming it needs neither the faucet nor a reset.
  await settlePending(commit, T);
  await settlePending(control, T);
  if (RESET_RUNS) {
    state.setAside = [...(state.setAside ?? []), ...state.rows.filter((r) => r.run >= 0)];
    state.rows = state.rows.filter((r) => r.run < 0);
    delete state.visibility;
    parity().claimMessage = { checked: 0, mismatches: 0 };
    save();
    step("RESET_RUNS: earlier runs set aside; measuring again");
  }

  const controlSkipped = await prepareControl(T, R);
  if (controlSkipped) step(`CONTROL LEG SKIPPED: ${controlSkipped}`);
  const legs = controlSkipped ? [commit] : [commit, control];
  for (;;) {
    let progressed = false;
    for (const spec of legs) {
      if (completedRuns(spec.leg) >= N) continue;
      await doRun(spec, nextRunIndex(spec.leg), T);
      progressed = true;
    }
    if (!progressed) break;
  }
  await captureClaim();

  writeOutputs({ network, atStart, atEnd: await RPC.getLatestLedger(), controlSkipped });
  console.log("\n============================================================");
  console.log(` commit runs ${completedRuns("commit")}/${N}, control runs ${completedRuns("control")}/${N}${controlSkipped ? " (control skipped)" : ""}`);
  const pr = parity();
  const cm = pr.claimMessage;
  console.log(` parity: known answer ${pr.knownAnswer}; commitment_of ${pr.commitmentOf}; claim_message ${cm.checked - cm.mismatches}/${cm.checked} match`);
  console.log("============================================================");
  if (cm.mismatches > 0) {
    console.error(" claim_message parity FAILED: the contract signs a different layout than the one specified");
    process.exit(1);
  }
}

/* ---------- OFFLINE=1: the self-check (no network, no state file) ---------- */

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (ok) pass++;
  else fail++;
};

function selfCheck(): void {
  const H = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");
  const fill = (n: number, b: number) => Buffer.alloc(n, b);
  const hex = (b: Buffer) => b.toString("hex");
  // XDR prefixes written out from the definitions, and checked against `stellar xdr encode` (stellar-xdr 27.0.0).
  const SCV_ADDRESS_CONTRACT = H("00000012 00000001"); // SCV_ADDRESS, SC_ADDRESS_TYPE_CONTRACT
  const SCV_ADDRESS_ACCOUNT = H("00000012 00000000 00000000"); // SCV_ADDRESS, SC_ADDRESS_TYPE_ACCOUNT, PUBLIC_KEY_TYPE_ED25519
  const scvBytes = (b: Buffer) => Buffer.concat([H("0000000d"), H(b.length.toString(16).padStart(8, "0")), b]); // SCV_BYTES, length
  const scvI128 = (x: bigint) => Buffer.concat([H("0000000a"), i128be(x)]); // SCV_I128: hi then lo, i.e. big-endian
  const scvU64 = (x: bigint) => Buffer.concat([H("00000005"), H(x.toString(16).padStart(16, "0"))]); // SCV_U64
  const scvU32 = (x: number) => Buffer.concat([H("00000003"), H(x.toString(16).padStart(8, "0"))]); // SCV_U32

  const NETWORK_ID = fill(32, 0x33);
  const C = StrKey.encodeContract(fill(32, 0x44));
  const G = StrKey.encodeEd25519PublicKey(fill(32, 0x55));
  const C_PAYOUT = StrKey.encodeContract(fill(32, 0x66));
  const LINK = KAT.link;
  const SALT = KAT.salt;
  const AMOUNT = KAT.amount;
  const SIG = fill(64, 0x99);
  const EXPIRY = 1_700_000_000n;

  console.log("============================================================");
  console.log(" SPIKE #11 OFFLINE self-check (no network)");
  console.log("============================================================");

  console.log("\n[a] the commitment known-answer vector (the one the contract's own tests are specified to assert)");
  const pre = commitmentPreimage(LINK, AMOUNT, SALT);
  check("preimage is 81 bytes", pre.length === 81, String(pre.length));
  check("commitment = ea3424...f8d5", hex(commitmentOf(LINK, AMOUNT, SALT)) === KAT.commitment, hex(commitmentOf(LINK, AMOUNT, SALT)));
  check("amount 1234567 as i128 big-endian", hex(i128be(AMOUNT)) === "0000000000000000000000000012d687");
  // i128::to_be_bytes(-2), printed by soroban-sdk 26.1.1 in a scratch harness: pins two's complement.
  check("amount -2 as i128 big-endian (two's complement)", hex(i128be(-2n)) === "ff".repeat(15) + "fe");

  console.log("\n[b] claim-message layout, fake contract 0x44.., fake network id 0x33..");
  const expectG = Buffer.concat([H("04"), NETWORK_ID, SCV_ADDRESS_CONTRACT, fill(32, 0x44), LINK, SCV_ADDRESS_ACCOUNT, fill(32, 0x55), i128be(AMOUNT), SALT]);
  const msgG = claimMessage(NETWORK_ID, C, LINK, G, AMOUNT, SALT);
  check("account payout: equals the hand-built bytes", msgG.equals(expectG));
  check("account payout: 197 bytes (1+32+40+32+44+16+32)", msgG.length === 197, String(msgG.length));
  check("account payout: tag at 0, link at 73, amount at 149, salt at 165",
    msgG[0] === 0x04 && msgG.subarray(73, 105).equals(LINK) && msgG.subarray(149, 165).equals(i128be(AMOUNT)) && msgG.subarray(165).equals(SALT));
  // sha256 of the same message built with soroban-sdk 26.1.1 (Address::to_xdr, env.ledger().network_id(),
  // inside a contract registered at the fake id) in a scratch harness: the host agrees with this layout.
  check("account payout: sha256 matches the soroban-sdk 26.1.1 golden", hex(hash(msgG)) === "57c5f64dc8c836cc972adb14550524d5e9b1c4c6b61f3a9ecd9d75a796301650");
  const expectC = Buffer.concat([H("04"), NETWORK_ID, SCV_ADDRESS_CONTRACT, fill(32, 0x44), LINK, SCV_ADDRESS_CONTRACT, fill(32, 0x66), i128be(AMOUNT), SALT]);
  const msgC = claimMessage(NETWORK_ID, C, LINK, C_PAYOUT, AMOUNT, SALT);
  check("contract payout: equals the hand-built bytes, 193 bytes", msgC.equals(expectC) && msgC.length === 193, String(msgC.length));
  check("contract payout: sha256 matches the soroban-sdk 26.1.1 golden", hex(hash(msgC)) === "1e9cb950a3d4256e9512bad51d05ec3249246d718c856191066eac17c87ab270");
  check("the live run's network id is sha256(testnet passphrase)", hex(networkIdOf(NET)) === "cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472");

  console.log("\n[c] ScVal encodings of every argument");
  const COMMITMENT = commitmentOf(LINK, AMOUNT, SALT);
  const A_C = Buffer.concat([SCV_ADDRESS_CONTRACT, fill(32, 0x44)]);
  const A_G = Buffer.concat([SCV_ADDRESS_ACCOUNT, fill(32, 0x55)]);
  const cases: [string, xdr.ScVal[], Buffer[]][] = [
    ["commit __constructor(token, owner)", commitArgs.__constructor(C, G), [A_C, A_G]],
    ["commit deposit(from, link, commitment, amount, expiry)", commitArgs.deposit(G, LINK, COMMITMENT, AMOUNT, EXPIRY), [A_G, scvBytes(LINK), scvBytes(COMMITMENT), scvI128(AMOUNT), scvU64(EXPIRY)]],
    ["commit claim(link, payout, sig, amount, salt)", commitArgs.claim(LINK, G, SIG, AMOUNT, SALT), [scvBytes(LINK), A_G, scvBytes(SIG), scvI128(AMOUNT), scvBytes(SALT)]],
    ["commit reclaim(link)", commitArgs.reclaim(LINK), [scvBytes(LINK)]],
    ["commit get_drop(link)", commitArgs.get_drop(LINK), [scvBytes(LINK)]],
    ["commit commitment_of(link, amount, salt)", commitArgs.commitment_of(LINK, AMOUNT, SALT), [scvBytes(LINK), scvI128(AMOUNT), scvBytes(SALT)]],
    ["commit claim_message(link, payout, amount, salt)", commitArgs.claim_message(LINK, G, AMOUNT, SALT), [scvBytes(LINK), A_G, scvI128(AMOUNT), scvBytes(SALT)]],
    ["control deposit(from, link, amount, expiry)", controlArgs.deposit(G, LINK, AMOUNT, EXPIRY), [A_G, scvBytes(LINK), scvI128(AMOUNT), scvU64(EXPIRY)]],
    ["control claim(link, payout, sig)", controlArgs.claim(LINK, G, SIG), [scvBytes(LINK), A_G, scvBytes(SIG)]],
    ["control claim_message(kind 1, link, payout)", controlArgs.claim_message(LINK, G), [scvU32(1), scvBytes(LINK), A_G]],
    ["control get_drop(link)", controlArgs.get_drop(LINK), [scvBytes(LINK)]],
  ];
  for (const [name, got, want] of cases) {
    check(`${name}: ${want.length} arguments`, got.length === want.length, `${got.length}`);
    got.forEach((v, i) => check(`  ${name.split("(")[0]} arg ${i}`, i < want.length && v.toXDR().equals(want[i]!), v.toXDR("hex").slice(0, 24)));
  }
  // The whole invocation as it travels: contract address, function name and arguments survive the XDR round trip.
  const roundTrip = (name: string, contract: string, fn: string, args: xdr.ScVal[]) => {
    const op = new Contract(contract).call(fn, ...args);
    const back = xdr.Operation.fromXDR(op.toXDR()).body().invokeHostFunctionOp().hostFunction().invokeContract();
    check(`${name}: invocation round-trips`,
      Address.fromScAddress(back.contractAddress()).toString() === contract &&
        back.functionName().toString() === fn &&
        back.args().length === args.length &&
        back.args().every((a, i) => a.toXDR().equals(args[i]!.toXDR())));
  };
  roundTrip("commit deposit", C, "deposit", commitArgs.deposit(G, LINK, COMMITMENT, AMOUNT, EXPIRY));
  roundTrip("commit claim", C, "claim", commitArgs.claim(LINK, G, SIG, AMOUNT, SALT));
  roundTrip("control deposit", CONTROL_CONTRACT, "deposit", controlArgs.deposit(G, LINK, AMOUNT, EXPIRY));
  roundTrip("control claim", CONTROL_CONTRACT, "claim", controlArgs.claim(LINK, G, SIG));

  console.log("\n[d] ledger keys");
  // LedgerKey CONTRACT_DATA (6) | ScAddress contract | key ScVal | durability PERSISTENT (1). The key is
  // SCV_VEC (16), present (1), length 2, SCV_SYMBOL (15) "Drop", SCV_BYTES (13) of 32 bytes. Identical to
  // `stellar xdr encode --type LedgerKey` of {"contract_data":{..., "key":{"vec":[{"symbol":"Drop"},{"bytes":..}]}}}.
  const expectDrop = Buffer.concat([
    H("00000006 00000001"), fill(32, 0x44),
    H("00000010 00000001 00000002"), H("0000000f 00000004"), Buffer.from("Drop"), scvBytes(LINK),
    H("00000001"),
  ]);
  check("DataKey::Drop(link) ledger key, persistent", dropKey(C, LINK).toXDR().equals(expectDrop), hex(dropKey(C, LINK).toXDR()).slice(0, 40));
  const expectInstance = Buffer.concat([H("00000006 00000001"), fill(32, 0x44), H("00000014"), H("00000001")]);
  check("contract instance ledger key", instanceKey(C).toXDR().equals(expectInstance));
  check("the Drop key's footprint label", keyLabel(dropKey(C, LINK)) === `contractData:${short(C)}:Drop`, keyLabel(dropKey(C, LINK)));

  console.log("\n[e] deterministic deployment id");
  // `stellar contract id wasm --salt 88.. --source-account <seed 77..>` (stellar 27.1.0, testnet passphrase, no network).
  const deployer = Keypair.fromRawEd25519Seed(fill(32, 0x77)).publicKey();
  const cid = contractIdFor(deployer, fill(32, 0x88), Networks.TESTNET);
  check("contract id from (deployer, salt) matches the stellar CLI", cid === "CBAI2X3BSGBXY2O2C4HA27EUYVTTANZU24FIWDXEEGRIS3I52VCZXDWW", cid);

  console.log("\n[f] decoders used for visibility.json");
  const entryVal = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("V1"),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("claimed"), val: xdr.ScVal.scvBool(false) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("commitment"), val: xdr.ScVal.scvBytes(COMMITMENT) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("escrowed"), val: sv.i128(AMOUNT) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("expiry"), val: sv.u64(EXPIRY) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("sender"), val: sv.address(G) }),
    ]),
  ]);
  const d = dropFields(entryVal);
  check("DropEntry::V1 decodes: commitment, escrowed, claimed, sender",
    d.commitment === KAT.commitment && d.escrowed === "1234567" && d.claimed === false && d.sender === G && d.expiry === String(EXPIRY));
  check("an i128 node is reported as showing the amount", amountShown(scvJson(sv.i128(AMOUNT)), "1234567"));
  check("a commitment node is not", !amountShown(scvJson(xdr.ScVal.scvBytes(COMMITMENT)), "1234567"));
  const contractEvent = (contract: string, topics: xdr.ScVal[], data: xdr.ScVal) =>
    new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: Address.fromString(contract).toScAddress().contractId(),
      type: xdr.ContractEventType.contract(),
      body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data })),
    });
  const ev = contractEvent(C, [xdr.ScVal.scvSymbol("mint"), sv.address(C)], sv.i128(AMOUNT));
  const evj = eventJson(xdr.ContractEvent.fromXDR(ev.toXDR()));
  check("a SAC mint event decodes with its amount", evj.contractId === C && amountShown(evj.data, "1234567") && (evj.topics[0] as { symbol: string }).symbol === "mint");

  console.log("\n[g] the testnet-only guard");
  check("the configured endpoints pass", testnetRefusal(NET, [RPC_URL, FRIENDBOT_URL, SPONSOR_URL]) === null);
  check("the public network passphrase is refused", testnetRefusal(Networks.PUBLIC, [RPC_URL]) !== null);
  check("the mainnet sponsor Worker is refused", testnetRefusal(NET, ["https://lumenia-sponsor-mainnet.avakit.workers.dev"]) !== null);
  check("a mainnet RPC is refused", testnetRefusal(NET, ["https://mainnet.sorobanrpc.com"]) !== null);
  check("plain http is refused", testnetRefusal(NET, ["http://soroban-testnet.stellar.org"]) !== null);

  console.log("\n[h] arithmetic");
  const s3 = stats([3, 1, 2]);
  const s4 = stats([4, 1, 3, 2]);
  check("median and max (odd and even n)", s3.median === 2 && s3.max === 3 && s4.median === 2.5 && s4.max === 4);
  check("N=5 control deposits need one 1-USDC faucet call", faucetCallsNeeded(0, 5, 0n) === 1, String(faucetCallsNeeded(0, 5, 0n)));
  check("none when T already holds enough", faucetCallsNeeded(0, 5, 10_000_000n) === 0);

  console.log("\n[i] visibility.json from a locally built deposit (envelope with auth, v4 meta, Drop entry)");
  const SAC = StrKey.encodeContract(fill(32, 0xaa));
  const fn = (contract: string, name: string, args: xdr.ScVal[]) =>
    new xdr.InvokeContractArgs({ contractAddress: Address.fromString(contract).toScAddress(), functionName: name, args });
  const depositArgs = commitArgs.deposit(G, LINK, COMMITMENT, AMOUNT, EXPIRY);
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(fn(C, "deposit", depositArgs)),
      subInvocations: [
        new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            fn(SAC, "transfer", [sv.address(G), sv.address(C), sv.i128(AMOUNT)]),
          ),
          subInvocations: [],
        }),
      ],
    }),
  });
  const envelopeOf = (name: string, args: xdr.ScVal[], authEntries: xdr.SorobanAuthorizationEntry[]) =>
    new TransactionBuilder(new Account(G, "1"), { fee: BASE_FEE, networkPassphrase: NET })
      .addOperation(Operation.invokeContractFunction({ contract: C, function: name, args, auth: authEntries }))
      .setTimeout(0)
      .build()
      .toEnvelope()
      .toXDR("base64");
  const mintEv = contractEvent(SAC, [xdr.ScVal.scvSymbol("mint"), sv.address(C), xdr.ScVal.scvString(`USDC:${G}`)], sv.i128(AMOUNT));
  const depositEv = contractEvent(
    C,
    [xdr.ScVal.scvSymbol("deposit"), sv.bytes(LINK)],
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("commitment"), val: sv.bytes(COMMITMENT) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("expiry"), val: sv.u64(EXPIRY) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("sender"), val: sv.address(G) }),
    ]),
  );
  const dataEntry = (contract: string, key: xdr.ScVal, val: xdr.ScVal) =>
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: Address.fromString(contract).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
      val,
    });
  const createdChange = (cd: xdr.ContractDataEntry) =>
    xdr.LedgerEntryChange.ledgerEntryCreated(
      new xdr.LedgerEntry({ lastModifiedLedgerSeq: 7, data: xdr.LedgerEntryData.contractData(cd), ext: new xdr.LedgerEntryExt(0) }),
    );
  const dropData = dataEntry(C, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Drop"), sv.bytes(LINK)]), entryVal);
  const balanceData = dataEntry(
    SAC,
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), sv.address(C)]),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: sv.i128(AMOUNT) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("authorized"), val: xdr.ScVal.scvBool(true) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("clawback"), val: xdr.ScVal.scvBool(false) }),
    ]),
  );
  const metaXdr = new xdr.TransactionMeta(
    4,
    new xdr.TransactionMetaV4({
      ext: new xdr.ExtensionPoint(0),
      txChangesBefore: [],
      operations: [
        new xdr.OperationMetaV2({ ext: new xdr.ExtensionPoint(0), changes: [createdChange(dropData), createdChange(balanceData)], events: [mintEv, depositEv] }),
      ],
      txChangesAfter: [],
      sorobanMeta: null,
      events: [],
      diagnosticEvents: [],
    }),
  ).toXDR("base64");
  const visInput: VisibilityInput = {
    contract: C,
    sac: SAC,
    issuer: G,
    link: LINK,
    amount: "1234567",
    commitment: KAT.commitment,
    depositTx: "00".repeat(32),
    depositLedger: 7,
    tx: { envelopeXdr: envelopeOf("deposit", depositArgs, [auth]), resultMetaXdr: metaXdr, contractEventsXdr: [[mintEv.toXDR("base64"), depositEv.toXDR("base64")]] },
    entry: { key: dropKey(C, LINK).toXDR("base64"), xdr: xdr.LedgerEntryData.contractData(dropData).toXDR("base64") },
  };
  const vis = buildVisibility(visInput);
  const item = (prefix: string) => vis.items.find((i) => i.item.startsWith(prefix));
  const amountArg = item("the amount argument");
  check("the amount argument: path, decoded node, shows the amount",
    amountArg?.path === "v1.tx.operations[0].body.invokeHostFunctionOp.hostFunction.invokeContract.args[3]" &&
      scValToNative(xdr.ScVal.fromXDR(amountArg.nodeXdr, "base64")) === AMOUNT &&
      amountArg.showsAmount);
  check("auth root invocation (deposit) shows the amount", item("auth[0] root invocation: deposit (credentials sorobanCredentialsSourceAccount)")?.showsAmount === true);
  const sub = item("auth[0] sub-invocation: transfer (from, to, amount)");
  check("auth sub-invocation SAC transfer: path and amount",
    sub?.path === "v1.tx.operations[0].body.invokeHostFunctionOp.auth[0].rootInvocation.subInvocations[0].function.contractFn" && sub.showsAmount);
  const mintItem = item('SAC "mint" event');
  check("SAC mint event: found by emitter and topic, shows the amount", mintItem?.rpcField === "events.contractEventsXdr[0][0]" && mintItem.showsAmount);
  check('escrow "deposit" event: no amount in its data', item('escrow "deposit" event')?.showsAmount === false);
  const metaDrop = item("ledger change in the meta (created): contractData:");
  check("meta ledger changes: the created Drop and the escrow's SAC balance both show the amount",
    metaDrop?.path === "v4.operations[0].changes[0].created.data.contractData" &&
      vis.items.filter((i) => i.item.startsWith("ledger change in the meta") && i.showsAmount).length === 2);
  check("Drop.escrowed: path and amount", item("Drop.escrowed")?.path === "contractData.val.vec[1].map[2].val" && item("Drop.escrowed")?.showsAmount === true);
  check("Drop.commitment: no amount", item("Drop.commitment")?.path === "contractData.val.vec[1].map[1].val" && item("Drop.commitment")?.showsAmount === false);
  check('shownIn counts what was found: "9 of 11 items"', vis.shownIn === "9 of 11 items", vis.shownIn);
  const visFallback = buildVisibility({ ...visInput, tx: { ...visInput.tx, contractEventsXdr: [] } });
  check("an RPC without the events field: events come from the v4 meta",
    visFallback.items.filter((i) => i.rpcField === "resultMetaXdr" && i.path.startsWith("v4.operations[0].events[")).length === 2);
  check("the record is JSON-safe", JSON.parse(JSON.stringify(vis)).items.length === vis.items.length);
  const reveal = claimRevealItems(envelopeOf("claim", commitArgs.claim(LINK, G, SIG, AMOUNT, SALT), []), "1234567");
  check("the claim reveals the amount and the salt",
    reveal.length === 3 && reveal[1]!.showsAmount &&
      Buffer.from(scValToNative(xdr.ScVal.fromXDR(reveal[2]!.nodeXdr, "base64")) as Uint8Array).equals(SALT));

  console.log("\n[j] the summary and measurements.md from synthetic rows (nothing is written)");
  const simRow: SimNumbers = {
    minResourceFee: "100",
    resourceFee: "120",
    instructions: 0,
    diskReadBytes: 10,
    writeBytes: 20,
    footprintReadOnly: 3,
    footprintReadWrite: 2,
    archivedEntries: 0,
    footprint: { readOnly: [], readWrite: [] },
    inclusionFee: INCLUSION_FEE,
    feeOffered: "10120",
  };
  const row = (leg: Leg, run: number, op: Op, instructions: number, wallMs: number | null): Row => ({
    leg,
    run,
    op,
    contract: leg === "commit" ? C : CONTROL_CONTRACT,
    hash: "00".repeat(32),
    ...simRow,
    instructions,
    feeCharged: "200",
    ledger: 1,
    createdAt: 0,
    wallMs,
    polls: wallMs === null ? null : 2,
    sendStatus: wallMs === null ? null : "PENDING",
    submittedAt: "",
    ...(wallMs === null ? { recovered: true as const } : {}),
  });
  const rows = [
    row("commit", -1, "upload", 5000, 4000),
    row("commit", -1, "create", 6000, 4100),
    row("commit", 0, "deposit", 100, 5000),
    row("commit", 1, "deposit", 300, 6000),
    row("commit", 0, "claim", 200, 5500),
    row("commit", 1, "claim", 400, null),
    row("control", 0, "deposit", 50, 5100),
    row("control", 1, "deposit", 70, 5300),
    row("control", 0, "claim", 60, 5200),
    row("control", 1, "claim", 80, 5400),
  ];
  const groups = summarise(rows);
  const g = (leg: Leg, op: Op) => groups.find((x) => x.leg === leg && x.op === op)!;
  check("one group per leg x op x contract", groups.length === 6, String(groups.length));
  check("median and max per column", g("commit", "deposit").columns.instructions!.median === 200 && g("commit", "deposit").columns.instructions!.max === 300);
  check("a recovered row leaves only the wall-time column",
    g("commit", "claim").n === 2 && g("commit", "claim").columns.wallMs!.n === 1 && g("commit", "claim").columns.instructions!.n === 2);
  const md = markdown({ generatedAt: "2026-01-01T00:00:00.000Z", protocolVersion: 29, sdk: "16.3.0", groups, commit: { contract: C, wasmHash: "ab".repeat(32), asset: `USDC:${G}` }, controlSkipped: null, rows });
  check("measurements.md: the four operation columns", md.includes("| metric | commit deposit | control deposit | commit claim | control claim |"));
  check("measurements.md: commit minus control medians (140 deposit, 230 claim)", md.includes("| instructions | 140 | 230 |"));
  check("measurements.md: a column with fewer rows says so", md.includes("5500 / 5500 (n=1)"));
  check("measurements.md: the one-time deployment table", md.includes("One-time deployment") && md.includes("| upload |") && md.includes("| create |"));
  check("measurements.md: plain ASCII", [...md].every((ch) => ch.charCodeAt(0) < 128));

  console.log("\n============================================================");
  console.log(fail === 0 ? ` SPIKE #11 OFFLINE SELF-CHECK PASS (${pass}/${pass})` : ` SPIKE #11 OFFLINE SELF-CHECK: ${fail} FAILED (${pass} passed)`);
  console.log(" Not exercised offline: every network call, the deployed contract's own views, and the file writes.");
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}

async function main(): Promise<void> {
  if (OFFLINE) return selfCheck();
  await live();
}

main().catch((e) => {
  console.error(`\nFAILED: ${(e as Error).message}`);
  if (!OFFLINE) console.error(`State is in ${STATE_PATH} (gitignored); rerun to resume.`);
  process.exit(1);
});
