/**
 * KMS SIGNER TESTS — KmsSponsorSigner against a LOCAL raw-Ed25519 stand-in (no network,
 * no AWS). Mirrors Spike #1b: the fake KMS signs with a stellar-sdk Keypair, so we can
 * assert BYTE-PARITY between the KMS-path DecoratedSignature and `kp.signDecorated()`
 * (Ed25519 is deterministic — identical bytes = the KMS path is a drop-in for tx.sign()).
 *
 * Also pins the exact KMS request contract (MessageType=RAW + ED25519_SHA_512 + the tx hash
 * as the message) and the fail-closed behavior. RUN: pnpm --filter @lumenia/sponsor test:kms
 *
 * Sections [8] to [12] (SOW 2, D3 item h, and the cutover tools): the account/signer split through
 * every value handler and through /health, KMS mode refusing to start without SPONSOR_ACCOUNT_ID,
 * the real aws4fetch transport against a stubbed KMS endpoint (one retry, one deadline, no error
 * body in an answer), and add-signer's unsigned dry run and exact-file submit, end to end against
 * a Horizon on this machine. `fetch` is stubbed wherever it could be reached: nothing leaves it.
 *
 * Section [13]: the Workers Free plan's 50 subrequests per invocation, counted with a stubbed fetch
 * through worker.fetch for every route that signs, at its worst case with KMS signing (each Sign one
 * fetch plus its retry): the relays stop polling inside SUBREQUEST_BUDGET (lib/subrequests.ts) and
 * answer 202, exactly as an unanswered poll window does.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Claimant,
  Contract,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TimeoutInfinite,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  type FeeBumpTransaction,
  type Horizon,
  type Transaction,
} from "@stellar/stellar-sdk";
import { KmsSponsorSigner, kmsErrorType, kmsSignerFromEnv, type KmsFetch } from "./lib/kms-signer.js";
import { loadConfig, makeConfig, resolveSponsorAccountId } from "./lib/config.js";
import { getService, getServiceAsync, resetServiceCache, serviceConfigFromEnv, withAccount } from "./lib/service.js";
import type { SponsorSigner } from "./lib/signer.js";
import { createAccountHandler } from "./lib/create-account.js";
import { feebumpHandler } from "./lib/feebump.js";
import { payoutHandler } from "./lib/payout.js";
import { sweepHandler } from "./lib/sweep.js";
import { sendLinkHandler } from "./lib/send.js";
import { relayClaimHandler, relayDepositHandler, relayReclaimHandler, setRelayPollMsForTests, type RelayRpc } from "./lib/soroban-relay.js";
import { CCTP_TESTNET_FORWARDER } from "./lib/cctp-relay.js";
import { ChannelManager } from "./lib/channels.js";
import { resetHaltCache } from "./lib/kill-switch.js";
import { SUBREQUEST_BUDGET, WORKER_SUBREQUEST_LIMIT } from "./lib/subrequests.js";
import worker from "./worker.js";
import {
  buildSetOptionsRecord,
  checkLiveAccount,
  checkRecordForSubmit,
  isGitignored,
  resolveCliPath,
  shownPath,
  suggestedRecordPath,
  type SetOptionsRecord,
} from "./cli/add-signer.js";

let pass = 0,
  fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✔" : "✗"} ${n}${d ? `  (${d})` : ""}`);
  ok ? pass++ : fail++;
};

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** A fake KMS backed by a stellar Keypair; records every Sign request body it sees. */
function fakeKms(kp: Keypair, log: Array<Record<string, unknown>>): KmsFetch {
  return async (target, body) => {
    if (target === "TrentService.GetPublicKey") {
      return { PublicKey: Buffer.concat([ED25519_SPKI_PREFIX, kp.rawPublicKey()]).toString("base64") };
    }
    log.push(body);
    const msg = Buffer.from(String(body.Message), "base64");
    return { Signature: kp.sign(msg).toString("base64") };
  };
}

function sampleTx(sourcePub: string) {
  // A fully offline tx: local Account (no Horizon), one payment, testnet passphrase.
  const source = new Account(sourcePub, "0");
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.payment({
        destination: "GDASCEEDNNHMJPYPTWXG65NFDSJKSEUIWSEV7EKRIEL67F4XN3HMSSKI",
        asset: Asset.native(),
        amount: "1",
      }),
    )
    .setTimeout(60)
    .build();
}

/* ---------------------------------------------------------------------------------------------
 * Helpers for sections [8] to [12].
 * --------------------------------------------------------------------------------------------- */

/** The v2 escrow contract id the relays are configured with (any valid C address works offline). */
const CONTRACT = "CAMCI5VPRLQUL6H4QKLZ6X7ASLVCEYBYWS7N3QG7JVOA25HCY2TN3HP3";
const TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
/** apps/sponsor/ and the repository root, from this file's own location. */
const SPONSOR_DIR = resolve(fileURLToPath(new URL("../", import.meta.url)));
const REPO_DIR = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const ADD_SIGNER_CLI = fileURLToPath(new URL("./cli/add-signer.ts", import.meta.url));

/** Set (a string) or delete (undefined) env vars; the returned function puts the old values back. */
function setEnv(vars: Record<string, string | undefined>): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** No store, no pilot, no halt, no KMS: the state every section starts from. */
const OFFLINE_BASE: Record<string, string | undefined> = {
  KV_REST_API_URL: undefined,
  KV_REST_API_TOKEN: undefined,
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,
  PILOT_MODE: undefined,
  SPONSOR_HALT: undefined,
  CAPS_FAIL_CLOSED: undefined,
  KMS_KEY_ID: undefined,
  KMS_REGION: undefined,
  AWS_REGION: undefined,
  AWS_ACCESS_KEY_ID: undefined,
  AWS_SECRET_ACCESS_KEY: undefined,
  SPONSOR_ACCOUNT_ID: undefined,
  SPONSOR_SECRET: undefined,
  STELLAR_NETWORK: "testnet",
  USDC_ISSUER: TESTNET_USDC_ISSUER,
};

/** One request as the stubbed `fetch` saw it. */
interface Seen {
  url: string;
  method: string;
  target: string | null;
  auth: string | null;
  contentType: string | null;
  body: Record<string, unknown> | null;
  signal: AbortSignal;
}

/**
 * Replace the global fetch: every request is recorded and answered by `route`, nothing leaves the
 * machine. aws4fetch calls the global `fetch` with a Request it built, so this is the REAL KMS
 * transport (SigV4, retries, the deadline) talking to a stand-in endpoint.
 */
function stubFetch(route: (s: Seen) => Response | Promise<Response>): { seen: Seen[]; restore: () => void } {
  const real = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const text = await req.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    const s: Seen = {
      url: req.url,
      method: req.method,
      target: req.headers.get("x-amz-target"),
      auth: req.headers.get("authorization"),
      contentType: req.headers.get("content-type"),
      body,
      signal: req.signal,
    };
    seen.push(s);
    return route(s);
  }) as typeof fetch;
  return { seen, restore: () => void (globalThis.fetch = real) };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/x-amz-json-1.1", ...headers } });
}

/** A stand-in KMS endpoint for `kp`: GetPublicKey and Sign, or `onSign` deciding each Sign answer. */
function kmsRoute(kp: Keypair, onSign?: (s: Seen, n: number) => Response | Promise<Response>) {
  let signs = 0;
  return async (s: Seen): Promise<Response> => {
    if (!s.url.startsWith("https://kms.")) throw new TypeError(`offline test: unexpected request to ${s.url}`);
    if (s.target === "TrentService.GetPublicKey") {
      return jsonResponse(200, {
        KeyId: s.body?.KeyId,
        KeySpec: "ECC_NIST_EDWARDS25519",
        KeyUsage: "SIGN_VERIFY",
        PublicKey: Buffer.concat([ED25519_SPKI_PREFIX, kp.rawPublicKey()]).toString("base64"),
      });
    }
    if (s.target === "TrentService.Sign") {
      signs++;
      if (onSign) return onSign(s, signs);
      const msg = Buffer.from(String(s.body?.Message), "base64");
      return jsonResponse(200, { KeyId: s.body?.KeyId, Signature: kp.sign(msg).toString("base64"), SigningAlgorithm: "ED25519_SHA_512" });
    }
    return jsonResponse(400, { __type: "com.amazonaws.kms#UnknownOperationException" });
  };
}

/** Keeps every transaction the sponsor was asked to sign: what a handler BUILT, whatever it does next. */
class Capture implements SponsorSigner {
  readonly signed: Array<Transaction | FeeBumpTransaction> = [];
  constructor(private readonly inner: SponsorSigner) {}
  publicKey(): string {
    return this.inner.publicKey();
  }
  async sign(tx: Transaction | FeeBumpTransaction): Promise<void> {
    await this.inner.sign(tx);
    this.signed.push(tx);
  }
}

/** "" when the promise resolves, else its error message: a refusal after the signature is fine here. */
const settle = (p: Promise<unknown>): Promise<string> => p.then(() => "", (e: Error) => e.message);

const isBump = (tx: Transaction | FeeBumpTransaction | undefined): tx is FeeBumpTransaction => !!tx && "innerTransaction" in tx;

/** How many of `tx`'s signatures are `pub`'s (hint AND signature check), or -1 with no tx at all. */
function sigsBy(tx: Transaction | FeeBumpTransaction | undefined, pub: string): number {
  if (!tx) return -1;
  const kp = Keypair.fromPublicKey(pub);
  const hint = kp.rawPublicKey().subarray(28);
  return tx.signatures.filter((s) => s.hint().equals(hint) && kp.verify(tx.hash(), s.signature())).length;
}

const sourceOf = (op: { source?: string } | undefined, txSource: string) => op?.source ?? txSource;

/** A Horizon stand-in: records every loadAccount, and the submit stops there (nothing is sent). */
function fakeHorizon(missing: string[] = []) {
  const loaded: string[] = [];
  const server = {
    loadAccount: async (pub: string) => {
      loaded.push(pub);
      if (missing.includes(pub)) throw Object.assign(new Error("Not Found"), { response: { status: 404 } });
      return new Account(pub, "7");
    },
    submitTransaction: async () => {
      throw new Error("offline test: captured, not submitted");
    },
  };
  return { server: server as unknown as Horizon.Server, loaded };
}

/** A Soroban RPC stand-in for the relays' `deps`: records getAccount, simulates, "lands" everything. */
function fakeRpc() {
  const asked: string[] = [];
  const rpcFor = (_url: string): RelayRpc => ({
    getAccount: async (a: string) => {
      asked.push(a);
      return new Account(a, "1");
    },
    simulateTransaction: async () =>
      ({
        _parsed: true,
        latestLedger: 1,
        events: [],
        minResourceFee: "500000",
        transactionData: new SorobanDataBuilder().setResourceFee(500000),
        result: { auth: [], retval: xdr.ScVal.scvVoid() },
      }) as unknown as rpc.Api.SimulateTransactionResponse,
    sendTransaction: async (tx) =>
      ({ status: "PENDING", hash: tx.hash().toString("hex"), latestLedger: 1, latestLedgerCloseTime: 0 }) as unknown as rpc.Api.SendTransactionResponse,
    getTransaction: async (hash: string) =>
      ({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        txHash: hash,
        latestLedger: 1,
        latestLedgerCloseTime: 0,
        oldestLedger: 1,
        oldestLedgerCloseTime: 0,
      }) as unknown as rpc.Api.GetTransactionResponse,
  });
  return { deps: { rpc: rpcFor, pollMs: 1, maxPolls: 2 }, asked };
}

/** A client-built transaction: `ops` from `source`, testnet. */
function build(source: string, ops: xdr.Operation[], fee: string = BASE_FEE): Transaction {
  const b = new TransactionBuilder(new Account(source, "123456789"), { fee, networkPassphrase: Networks.TESTNET });
  for (const op of ops) b.addOperation(op);
  return b.setTimeout(180).build();
}

/** Run the add-signer CLI the way pnpm would (its own cwd apps/sponsor, INIT_CWD where it was typed). */
async function runAddSigner(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [...process.execArgv, ADD_SIGNER_CLI, ...args], {
      cwd: SPONSOR_DIR,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      timeout: 60_000,
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (e) {
    const x = e as { code?: unknown; stdout?: string; stderr?: string };
    return { code: typeof x.code === "number" ? x.code : 1, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
  }
}

async function main() {
  console.log("============================================================");
  console.log(" KMS SIGNER TESTS (offline; Spike #1b mechanics)");
  console.log("============================================================\n");

  const kp = Keypair.random();
  const signLog: Array<Record<string, unknown>> = [];
  const signer = await KmsSponsorSigner.create({
    keyId: "arn:aws:kms:test:000000000000:key/fake",
    region: "eu-central-1",
    accessKeyId: "x",
    secretAccessKey: "x",
    kmsFetch: fakeKms(kp, signLog),
  });

  console.log("[1] identity — GetPublicKey DER → Stellar address");
  check("publicKey() derives the G... address from the DER SPKI tail", signer.publicKey() === kp.publicKey());

  console.log("[2] signing a normal tx");
  const tx = sampleTx(kp.publicKey());
  await signer.sign(tx);
  check("exactly one signature attached", tx.signatures.length === 1);
  const sig = tx.signatures[0]!;
  check("hint = LAST 4 bytes of the raw public key", sig.hint().equals(kp.rawPublicKey().subarray(28)));
  check("the network math verifies the signature over the tx hash", kp.verify(tx.hash(), sig.signature()));
  check(
    "BYTE-PARITY with stellar-sdk signDecorated (drop-in proof)",
    sig.toXDR().equals(kp.signDecorated(tx.hash()).toXDR()),
  );
  check("envelope XDR round-trips with the KMS signature", (() => {
    const xdr64 = tx.toEnvelope().toXDR("base64");
    return TransactionBuilder.fromXDR(xdr64, Networks.TESTNET).toEnvelope().toXDR("base64") === xdr64;
  })());

  console.log("[3] the KMS request contract (what the wire must carry)");
  const req = signLog[0]!;
  check("MessageType = RAW (pure Ed25519, not the PH/prehash variant)", req.MessageType === "RAW");
  check("SigningAlgorithm = ED25519_SHA_512", req.SigningAlgorithm === "ED25519_SHA_512");
  check("Message = base64(tx hash), 32 bytes", Buffer.from(String(req.Message), "base64").equals(tx.hash()));

  console.log("[4] fee-bump signing (the sponsor's main move)");
  const inner = sampleTx(kp.publicKey());
  inner.sign(Keypair.random()); // an unrelated inner signature; the fee-bump wraps it
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(kp.publicKey(), "1000", inner, Networks.TESTNET);
  await signer.sign(feeBump);
  check(
    "fee-bump signature verifies over the OUTER hash",
    kp.verify(feeBump.hash(), feeBump.signatures[0]!.signature()),
  );

  console.log("[5] fail-closed behavior");
  const broken = await KmsSponsorSigner.create({
    keyId: "k", region: "r", accessKeyId: "x", secretAccessKey: "x",
    kmsFetch: async (target) =>
      target === "TrentService.GetPublicKey"
        ? { PublicKey: Buffer.concat([ED25519_SPKI_PREFIX, kp.rawPublicKey()]).toString("base64") }
        : Promise.reject(new Error("KMS unreachable")),
  });
  check("a KMS Sign failure THROWS (no silent fallback)", await broken.sign(sampleTx(kp.publicKey())).then(() => false, () => true));

  const badLen = await KmsSponsorSigner.create({
    keyId: "k", region: "r", accessKeyId: "x", secretAccessKey: "x",
    kmsFetch: async (target) =>
      target === "TrentService.GetPublicKey"
        ? { PublicKey: Buffer.concat([ED25519_SPKI_PREFIX, kp.rawPublicKey()]).toString("base64") }
        : { Signature: Buffer.alloc(63).toString("base64") },
  });
  check("a non-64-byte signature is rejected", await badLen.sign(sampleTx(kp.publicKey())).then(() => false, () => true));

  check("a non-Ed25519 KMS key is rejected at create()", await KmsSponsorSigner.create({
    keyId: "k", region: "r", accessKeyId: "x", secretAccessKey: "x",
    kmsFetch: async () => ({ PublicKey: Buffer.alloc(91).toString("base64") }), // RSA-sized SPKI
  }).then(() => false, () => true));

  /* ------------------------------------------------------------------------------------------
   * SOW 2, D3 (item h): the environment contract of the KMS signer, and the ACCOUNT / SIGNER split
   * that lets the KMS key be added as a signer of the EXISTING sponsor account instead of becoming
   * a brand-new, unfunded sponsor.
   * ------------------------------------------------------------------------------------------ */
  console.log("[6] kmsSignerFromEnv: the four variables, and nothing silent");
  {
    for (const k of ["KMS_KEY_ID", "KMS_REGION", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) delete process.env[k];
    check("no KMS_KEY_ID: null (the env hot key is the explicit default)", (await kmsSignerFromEnv(fakeKms(kp, []))) === null);
    process.env.KMS_KEY_ID = "arn:aws:kms:eu-central-1:000000000000:key/fake";
    check("KMS_KEY_ID without the Region and the access pair THROWS rather than falling back", await kmsSignerFromEnv(fakeKms(kp, [])).then(() => false, () => true));
    process.env.AWS_ACCESS_KEY_ID = "AKIAFAKE";
    process.env.AWS_SECRET_ACCESS_KEY = "fake";
    check("still throws with the access pair but no Region", await kmsSignerFromEnv(fakeKms(kp, [])).then(() => false, () => true));
    process.env.AWS_REGION = "us-east-1";
    const viaAws = await kmsSignerFromEnv(fakeKms(kp, []));
    check("AWS_REGION is accepted when KMS_REGION is unset", viaAws?.describe().region === "us-east-1");
    process.env.KMS_REGION = "eu-central-1";
    const viaKms = await kmsSignerFromEnv(fakeKms(kp, []));
    check("KMS_REGION wins over AWS_REGION", viaKms?.describe().region === "eu-central-1");
    check("the signer's address is the key's, and describe() carries no credential", viaKms?.publicKey() === kp.publicKey() && !JSON.stringify(viaKms?.describe()).includes("AKIA"));
    for (const k of ["KMS_KEY_ID", "KMS_REGION", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) delete process.env[k];
  }

  console.log("[7] the account is not the signer: SPONSOR_ACCOUNT_ID names the existing sponsor account");
  {
    const account = Keypair.random(); // the existing, funded sponsor account (hot key today)
    check("an explicit G address is accepted as is", resolveSponsorAccountId(account.publicKey(), undefined) === account.publicKey());
    check("a malformed SPONSOR_ACCOUNT_ID throws (a typo must not source every operation from a non-account)", (() => {
      try { resolveSponsorAccountId("GNOTANADDRESS", undefined); return false; } catch { return true; }
    })());
    check("with no explicit id the hot secret's own address is the account (the pre-cutover shape)", resolveSponsorAccountId(undefined, account.secret()) === account.publicKey());
    check("with neither it is empty, for the service to fill from the live signer", resolveSponsorAccountId(undefined, undefined) === "");
    const cfg = makeConfig({ network: "testnet", sponsorSecret: account.secret(), usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" });
    check("makeConfig derives sponsorAccountId from the secret", cfg.sponsorAccountId === account.publicKey());
    const kmsOnly = { ...cfg, sponsorAccountId: "" };
    check("withAccount fills an empty id from the signer it is given (env-key mode only: KMS mode never calls it, see [9])", withAccount(kmsOnly, signer).sponsorAccountId === kp.publicKey());
    check("withAccount keeps an explicit id even when the signer differs (the cutover shape)", withAccount(cfg, signer).sponsorAccountId === account.publicKey() && signer.publicKey() !== account.publicKey());
    process.env.STELLAR_NETWORK = "testnet";
    process.env.USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    process.env.SPONSOR_SECRET = account.secret();
    process.env.SPONSOR_ACCOUNT_ID = kp.publicKey();
    check("loadConfig reads SPONSOR_ACCOUNT_ID", loadConfig().sponsorAccountId === kp.publicKey());
    delete process.env.SPONSOR_ACCOUNT_ID;
    check("and defaults to the secret's address without it", loadConfig().sponsorAccountId === account.publicKey());
    process.env.SPONSOR_ACCOUNT_ID = "not-an-address";
    check("loadConfig throws on a malformed SPONSOR_ACCOUNT_ID", (() => { try { loadConfig(); return false; } catch { return true; } })());
    delete process.env.SPONSOR_ACCOUNT_ID;
    delete process.env.SPONSOR_SECRET;
    delete process.env.USDC_ISSUER;

    // The shape the chain sees after the cutover: a fee-bump whose FEE SOURCE is the existing
    // account, signed by the KMS key. The hint and the signature belong to the KMS key; the
    // network accepts it only because SetOptions made that key a weight-1 signer of the account.
    const inner = sampleTx(account.publicKey());
    inner.sign(account);
    const bump = TransactionBuilder.buildFeeBumpTransaction(account.publicKey(), "1000", inner, Networks.TESTNET);
    await signer.sign(bump);
    const sig = bump.signatures[0]!;
    check("the fee-bump is sourced by the ACCOUNT", bump.feeSource === account.publicKey());
    check("its signature hint is the KMS key's (last 4 bytes of the KMS raw pubkey), not the account's", sig.hint().equals(kp.rawPublicKey().subarray(28)) && !sig.hint().equals(account.rawPublicKey().subarray(28)));
    check("the signature verifies under the KMS key over the fee-bump hash", kp.verify(bump.hash(), sig.signature()));
    check("and does NOT verify under the account's master key (which is why the SetOptions is required)", !account.verify(bump.hash(), sig.signature()));
  }

  /* ------------------------------------------------------------------------------------------
   * [8] Item h where it can actually break: every value handler, run with the post-cutover
   * shape (config.sponsorAccountId = the existing account, the signer = a KMS key that is NOT that
   * account). A handler reverted to `signer.publicKey()` anywhere would source operations or pay
   * fees from the KMS key's own, unfunded address; every other suite's stub signer IS the account,
   * so only this section can see it. The signer is wrapped so the transaction each handler BUILT
   * is kept even when the handler refuses afterwards (the fake submit always does).
   * ------------------------------------------------------------------------------------------ */
  console.log("[8] item h through every handler: fee source and op sources are the ACCOUNT, the signature is the KMS key's");
  {
    const restoreEnv = setEnv({
      ...OFFLINE_BASE,
      // Ample budgets, so a refusal can only be a guard on what the handler built.
      MAX_DAY_FEE_XLM: "100000",
      MAX_DROP_USDC: "1000",
      MAX_DAY_USDC: "100000",
      MAX_DAY_USDC_PER_SENDER: "100000",
    });
    const net = stubFetch((s) => {
      throw new TypeError(`offline test: unexpected request to ${s.url}`);
    });
    const accountKp = Keypair.random(); // the existing, funded sponsor account (its master is the hot key)
    const kmsKey = Keypair.random(); // stands in for the key inside KMS
    const ACCOUNT = accountKp.publicKey();
    const kms = await KmsSponsorSigner.create({
      keyId: "arn:aws:kms:eu-central-1:000000000000:key/split",
      region: "eu-central-1",
      accessKeyId: "x",
      secretAccessKey: "x",
      kmsFetch: fakeKms(kmsKey, []),
    });
    const G_KMS = kms.publicKey();
    const issuer = Keypair.random();
    const USDC = new Asset("USDC", issuer.publicKey());
    const config = makeConfig({ network: "testnet", sponsorSecret: "", sponsorAccountId: ACCOUNT, usdcIssuer: issuer.publicKey(), lumendropContract: CONTRACT });
    check("the shape under test: config.sponsorAccountId is the account, and the signer is another key", config.sponsorAccountId === ACCOUNT && G_KMS === kmsKey.publicKey() && G_KMS !== ACCOUNT);

    {
      const recipient = Keypair.random();
      const balanceId = `00000000${"ab".repeat(32)}`;
      const inner = build(recipient.publicKey(), [Operation.claimClaimableBalance({ balanceId })]);
      inner.sign(recipient);
      const cap = new Capture(kms);
      const h = fakeHorizon();
      const err = await settle(feebumpHandler(h.server, config, cap, { xdr: inner.toXDR(), recipientPublicKey: recipient.publicKey(), balanceId }));
      const fb = cap.signed[0];
      check("/feebump: the one transaction signed is a fee-bump whose FEE SOURCE is the account", cap.signed.length === 1 && isBump(fb) && fb.feeSource === ACCOUNT, err);
      check("/feebump: one signature, the KMS key's; none by the account's master key", sigsBy(fb, G_KMS) === 1 && sigsBy(fb, ACCOUNT) === 0 && !h.loaded.includes(G_KMS));
    }
    {
      const sender = Keypair.random();
      const exchange = Keypair.random();
      const inner = build(sender.publicKey(), [Operation.payment({ destination: exchange.publicKey(), asset: USDC, amount: "5", source: sender.publicKey() })]);
      inner.sign(sender);
      const cap = new Capture(kms);
      const h = fakeHorizon();
      const err = await settle(payoutHandler(h.server, config, cap, { xdr: inner.toXDR(), senderPublicKey: sender.publicKey(), destination: exchange.publicKey(), amount: "5" }));
      const fb = cap.signed[0];
      check("/payout: fee-bump fee source is the account, signed once by the KMS key, never by the account master", cap.signed.length === 1 && isBump(fb) && fb.feeSource === ACCOUNT && sigsBy(fb, G_KMS) === 1 && sigsBy(fb, ACCOUNT) === 0, err);
    }
    {
      const throwaway = Keypair.random();
      const home = Keypair.random();
      const inner = build(throwaway.publicKey(), [
        Operation.payment({ destination: home.publicKey(), asset: USDC, amount: "3", source: throwaway.publicKey() }),
        Operation.changeTrust({ asset: USDC, limit: "0", source: throwaway.publicKey() }),
        Operation.accountMerge({ destination: home.publicKey(), source: throwaway.publicKey() }),
      ]);
      inner.sign(throwaway);
      const cap = new Capture(kms);
      const h = fakeHorizon();
      const err = await settle(sweepHandler(h.server, config, cap, { xdr: inner.toXDR(), throwawayPublicKey: throwaway.publicKey(), homePublicKey: home.publicKey(), amount: "3" }));
      const fb = cap.signed[0];
      check("/sweep: fee-bump fee source is the account, signed once by the KMS key, never by the account master", cap.signed.length === 1 && isBump(fb) && fb.feeSource === ACCOUNT && sigsBy(fb, G_KMS) === 1 && sigsBy(fb, ACCOUNT) === 0, err);
    }
    {
      const sender = Keypair.random();
      const bearer = Keypair.random();
      const sendTx = (beginSource: string) => {
        const t = build(sender.publicKey(), [
          Operation.beginSponsoringFutureReserves({ sponsoredId: sender.publicKey(), source: beginSource }),
          Operation.createClaimableBalance({
            asset: USDC,
            amount: "2",
            claimants: [
              new Claimant(bearer.publicKey(), Claimant.predicateUnconditional()),
              new Claimant(sender.publicKey(), Claimant.predicateNot(Claimant.predicateBeforeRelativeTime("604800"))),
            ],
            source: sender.publicKey(),
          }),
          Operation.endSponsoringFutureReserves({ source: sender.publicKey() }),
        ]);
        t.sign(sender);
        return t;
      };
      const cap = new Capture(kms);
      const h = fakeHorizon();
      const err = await settle(sendLinkHandler(h.server, config, cap, { xdr: sendTx(ACCOUNT).toXDR(), senderPublicKey: sender.publicKey() }));
      const [signedInner, bump] = cap.signed;
      check(
        "/send-link: the begin-sponsoring op is sourced by the ACCOUNT, and the sponsor's inner signature is the KMS key's",
        !!signedInner && !isBump(signedInner) && sourceOf(signedInner.operations[0], signedInner.source) === ACCOUNT && sigsBy(signedInner, G_KMS) === 1 && sigsBy(signedInner, sender.publicKey()) === 1 && sigsBy(signedInner, ACCOUNT) === 0,
        err,
      );
      check("/send-link: then a fee-bump with the ACCOUNT as fee source, KMS-signed", cap.signed.length === 2 && isBump(bump) && bump.feeSource === ACCOUNT && sigsBy(bump, G_KMS) === 1 && sigsBy(bump, ACCOUNT) === 0, err);
      const cap2 = new Capture(kms);
      const err2 = await settle(sendLinkHandler(fakeHorizon().server, config, cap2, { xdr: sendTx(G_KMS).toXDR(), senderPublicKey: sender.publicKey() }));
      check("/send-link: a begin sourced by the SIGNER's own address is refused before anything is signed (the policy names the account)", cap2.signed.length === 0 && err2 !== "", err2);
    }
    {
      const recipient = Keypair.random();
      const cap = new Capture(kms);
      const h = fakeHorizon([recipient.publicKey()]);
      let out: { via?: string; sponsorPublicKey?: string } = {};
      const err = await settle(createAccountHandler(h.server, config, cap, { recipientPublicKey: recipient.publicKey() }).then((o) => void (out = o)));
      const tx = cap.signed[0];
      check(
        "/create-account (sponsor path): tx source is the ACCOUNT, and begin + createAccount are sourced by it",
        cap.signed.length === 1 && !!tx && !isBump(tx) && tx.source === ACCOUNT && sourceOf(tx.operations[0], tx.source) === ACCOUNT && sourceOf(tx.operations[1], tx.source) === ACCOUNT,
        err,
      );
      check("/create-account (sponsor path): Horizon was asked for the ACCOUNT's sequence, never for the signer's address", h.loaded.includes(ACCOUNT) && !h.loaded.includes(G_KMS), h.loaded.map((a) => a.slice(0, 6)).join(","));
      check("/create-account (sponsor path): one signature, the KMS key's, and the answer names the account as the sponsor", sigsBy(tx, G_KMS) === 1 && sigsBy(tx, ACCOUNT) === 0 && out.via === "sponsor" && out.sponsorPublicKey === ACCOUNT);
    }
    {
      const channel = Keypair.random();
      const recipient = Keypair.random();
      const cap = new Capture(kms);
      const h = fakeHorizon([recipient.publicKey()]);
      let out: { via?: string; sponsorPublicKey?: string } = {};
      const err = await settle(createAccountHandler(h.server, config, cap, { recipientPublicKey: recipient.publicKey() }, new ChannelManager([channel.secret()])).then((o) => void (out = o)));
      const tx = cap.signed[0];
      check(
        "/create-account (channel path): the channel is the tx source, begin + createAccount are sourced by the ACCOUNT",
        out.via === "channel" && cap.signed.length === 1 && !!tx && !isBump(tx) && tx.source === channel.publicKey() && sourceOf(tx.operations[0], tx.source) === ACCOUNT && sourceOf(tx.operations[1], tx.source) === ACCOUNT,
        err || `via ${out.via}`,
      );
      check("/create-account (channel path): one signature each by the channel and the KMS key, none by the account master", sigsBy(tx, channel.publicKey()) === 1 && sigsBy(tx, G_KMS) === 1 && sigsBy(tx, ACCOUNT) === 0 && !h.loaded.includes(G_KMS));
    }
    {
      const claim = { method: "claim", linkHex: "11".repeat(32), payout: Keypair.random().publicKey(), sigHex: "22".repeat(64) };
      const f = fakeRpc();
      const cap = new Capture(kms);
      const err = await settle(relayClaimHandler(config, cap, claim, undefined, f.deps));
      const tx = cap.signed[0];
      check(
        "/v2-claim (sponsor-sourced fallback): the RPC is asked for the ACCOUNT, which sources the transaction the KMS key signs",
        f.asked[0] === ACCOUNT && !f.asked.includes(G_KMS) && cap.signed.length === 1 && !isBump(tx) && tx?.source === ACCOUNT && sigsBy(tx, G_KMS) === 1 && sigsBy(tx, ACCOUNT) === 0,
        err || `asked ${f.asked.map((a) => a.slice(0, 6)).join(",")}`,
      );
      const channel = Keypair.random();
      const f2 = fakeRpc();
      const cap2 = new Capture(kms);
      const err2 = await settle(relayClaimHandler(config, cap2, claim, new ChannelManager([channel.secret()]), f2.deps));
      const fb = cap2.signed[0];
      check(
        "/v2-claim (channel path): the inner is the channel's, the fee-bump's fee source is the ACCOUNT, KMS-signed",
        isBump(fb) && fb.feeSource === ACCOUNT && sigsBy(fb, G_KMS) === 1 && sigsBy(fb, ACCOUNT) === 0 && fb.innerTransaction.source === channel.publicKey() && sigsBy(fb.innerTransaction, channel.publicKey()) === 1 && !f2.asked.includes(G_KMS),
        err2,
      );
    }
    {
      const sender = Keypair.random();
      const dep = new TransactionBuilder(new Account(sender.publicKey(), "5"), { fee: "1000000", networkPassphrase: Networks.TESTNET })
        .addOperation(
          new Contract(CONTRACT).call(
            "deposit",
            Address.fromString(sender.publicKey()).toScVal(),
            xdr.ScVal.scvBytes(Buffer.alloc(32, 7)),
            nativeToScVal(10_000_000n, { type: "i128" }),
            nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 86_400), { type: "u64" }),
          ),
        )
        .setTimeout(180)
        .build();
      dep.sign(sender);
      const f = fakeRpc();
      const cap = new Capture(kms);
      const err = await settle(relayDepositHandler(config, cap, { xdr: dep.toXDR(), senderPublicKey: sender.publicKey() }, f.deps));
      const fb = cap.signed[0];
      check("/v2-deposit: fee-bump fee source is the ACCOUNT, KMS-signed, around the sender's own inner", isBump(fb) && fb.feeSource === ACCOUNT && sigsBy(fb, G_KMS) === 1 && sigsBy(fb, ACCOUNT) === 0 && fb.innerTransaction.source === sender.publicKey(), err);
      const rec = new TransactionBuilder(new Account(sender.publicKey(), "6"), { fee: "1000000", networkPassphrase: Networks.TESTNET })
        .addOperation(new Contract(CONTRACT).call("reclaim", xdr.ScVal.scvBytes(Buffer.alloc(32, 7))))
        .setTimeout(180)
        .build();
      rec.sign(sender);
      const f2 = fakeRpc();
      const cap2 = new Capture(kms);
      const err2 = await settle(relayReclaimHandler(config, cap2, { xdr: rec.toXDR(), senderPublicKey: sender.publicKey() }, f2.deps));
      const fb2 = cap2.signed[0];
      check("/v2-reclaim: fee-bump fee source is the ACCOUNT, KMS-signed, around the sender's own inner", isBump(fb2) && fb2.feeSource === ACCOUNT && sigsBy(fb2, G_KMS) === 1 && sigsBy(fb2, ACCOUNT) === 0 && fb2.innerTransaction.source === sender.publicKey(), err2);
    }
    {
      /* The reverse case: the KMS key's OWN address is sponsor-controlled too. It is public after the
       * cutover (/health, the account's signer list), and the KMS signature is also that address's
       * master signature, so a request naming it must be refused before anything is signed. */
      const h = fakeHorizon([G_KMS]);
      const cap = new Capture(kms);
      const err = await settle(createAccountHandler(h.server, config, cap, { recipientPublicKey: G_KMS }));
      check("/create-account refuses the SIGNER's own address as the recipient (it is sponsor-controlled too)", cap.signed.length === 0 && /recipient must differ from the sponsor/.test(err), err);
      const thief = Keypair.random();
      const inner = build(G_KMS, [
        Operation.beginSponsoringFutureReserves({ sponsoredId: G_KMS, source: ACCOUNT }),
        Operation.createClaimableBalance({
          asset: USDC,
          amount: "4",
          claimants: [
            new Claimant(thief.publicKey(), Claimant.predicateUnconditional()),
            new Claimant(G_KMS, Claimant.predicateNot(Claimant.predicateBeforeRelativeTime("604800"))),
          ],
          source: G_KMS,
        }),
        Operation.endSponsoringFutureReserves({ source: G_KMS }),
      ]);
      const cap2 = new Capture(kms);
      const err2 = await settle(sendLinkHandler(fakeHorizon().server, config, cap2, { xdr: inner.toXDR(), senderPublicKey: G_KMS }));
      check("/send-link refuses the SIGNER's own address as the sender before anything is signed", cap2.signed.length === 0 && /sponsor's signing key/.test(err2), err2);
    }
    check("no handler reached the network (every request would have been recorded)", net.seen.length === 0, net.seen.map((s) => s.url).join(", "));
    net.restore();

    /* /health through the real Worker entry point, in KMS mode, between runbook steps 4 and 7 (the
     * hot secret is still a Worker secret): exactly what runbook step 5 reads. The KMS signer is
     * built by the real aws4fetch transport against the stubbed endpoint. */
    console.log("[8] /health through worker.fetch in KMS mode: the account and the signer are two addresses");
    const hot = Keypair.random();
    const restoreKmsEnv = setEnv({
      KMS_KEY_ID: "arn:aws:kms:eu-central-1:123456789012:key/health-check",
      KMS_REGION: "eu-central-1",
      AWS_ACCESS_KEY_ID: "AKIAHEALTHCHECK0000X",
      AWS_SECRET_ACCESS_KEY: "health-check-secret",
      SPONSOR_ACCOUNT_ID: ACCOUNT,
      SPONSOR_SECRET: hot.secret(),
    });
    resetServiceCache();
    const awsKms = stubFetch(kmsRoute(kmsKey));
    const res = await worker.fetch(new Request("https://sponsor.test/health"), {});
    const h = (await res.json()) as Record<string, any>;
    check("200 with ok:true", res.status === 200 && h.ok === true, `${res.status} ${JSON.stringify(h).slice(0, 160)}`);
    check("signer.kind is 'kms' and signer.publicKey is the KMS key's address", h.signer?.kind === "kms" && h.signer?.publicKey === G_KMS, JSON.stringify(h.signer));
    check("account and sponsorPublicKey are SPONSOR_ACCOUNT_ID, not the signer's address", h.account === ACCOUNT && h.sponsorPublicKey === ACCOUNT && h.account !== h.signer?.publicKey);
    check("the hot secret still in the environment does not become the account", h.account !== hot.publicKey());
    const page = JSON.stringify(h);
    check("the page carries neither the key ARN nor the AWS account id nor any credential", !/arn:|123456789012|AKIA|health-check-secret/.test(page) && !/S[A-Z2-7]{55}/.test(page));
    const svc = await getServiceAsync(); // the service the Worker built (or builds now, if /health did not need it)
    check(
      "the service came up on one GetPublicKey through the real SigV4 transport, and nothing else was fetched",
      awsKms.seen.length === 1 && awsKms.seen[0]!.target === "TrentService.GetPublicKey" && awsKms.seen[0]!.url === "https://kms.eu-central-1.amazonaws.com/" && /^AWS4-HMAC-SHA256 Credential=AKIAHEALTHCHECK0000X\/\d{8}\/eu-central-1\/kms\/aws4_request/.test(awsKms.seen[0]!.auth ?? ""),
      awsKms.seen.map((s) => `${s.target} ${s.url}`).join(", "),
    );
    check("the service the Worker built reports where its account came from (accountSource SPONSOR_ACCOUNT_ID)", svc.accountSource === "SPONSOR_ACCOUNT_ID" && svc.signerKind === "kms" && svc.config.sponsorSecret === "");
    check("/health shows the same accountSource (runbook step 5 reads exactly this field)", h.accountSource === "SPONSOR_ACCOUNT_ID", String(h.accountSource));
    resetServiceCache();
    awsKms.seen.length = 0;
    delete process.env.SPONSOR_ACCOUNT_ID;
    const bad = await worker.fetch(new Request("https://sponsor.test/health"), {});
    const badBody = (await bad.json()) as { error?: string };
    check("KMS mode WITHOUT SPONSOR_ACCOUNT_ID: /health is refused, naming the variable (testnet keeps the text)", bad.status >= 400 && /SPONSOR_ACCOUNT_ID/.test(String(badBody.error)), `${bad.status} ${JSON.stringify(badBody)}`);
    check("and KMS was not asked anything for it", awsKms.seen.length === 0);
    awsKms.restore();
    resetServiceCache();
    restoreKmsEnv();
    restoreEnv();
  }

  /* [8b] Env mode reports where its account came from too (runbook step 4a reads it to see the
   * variable landed), and a KMS outage takes down only the routes that sign. */
  console.log("[8b] /health in env mode, and the read routes during a KMS outage");
  {
    const hotKp = Keypair.random();
    const restoreEnv = setEnv({ ...OFFLINE_BASE, SPONSOR_SECRET: hotKp.secret() });
    resetServiceCache();
    const h1 = (await (await worker.fetch(new Request("https://sponsor.test/health"), {})).json()) as Record<string, any>;
    check("env mode, no SPONSOR_ACCOUNT_ID: accountSource 'signer', the account is the hot key's address", h1.accountSource === "signer" && h1.account === hotKp.publicKey(), `${h1.accountSource} ${h1.account}`);
    const named = Keypair.random().publicKey();
    process.env.SPONSOR_ACCOUNT_ID = named;
    resetServiceCache();
    const h2 = (await (await worker.fetch(new Request("https://sponsor.test/health"), {})).json()) as Record<string, any>;
    check(
      "env mode with SPONSOR_ACCOUNT_ID (runbook step 4a): accountSource 'SPONSOR_ACCOUNT_ID', the account it names, the hot key still signing",
      h2.accountSource === "SPONSOR_ACCOUNT_ID" && h2.account === named && h2.signer?.publicKey === hotKp.publicKey(),
      `${h2.accountSource} ${h2.account} ${h2.signer?.publicKey}`,
    );
    restoreEnv();
    // KMS mode, KMS down: GetPublicKey answers 500 every time.
    const restoreKms = setEnv({
      ...OFFLINE_BASE,
      KMS_KEY_ID: "arn:aws:kms:eu-central-1:000000000000:key/outage",
      KMS_REGION: "eu-central-1",
      AWS_ACCESS_KEY_ID: "AKIAOUTAGECHECK0000X",
      AWS_SECRET_ACCESS_KEY: "outage-secret",
      SPONSOR_ACCOUNT_ID: named,
    });
    const down = stubFetch(() => jsonResponse(500, { __type: "KMSInternalException" }));
    resetServiceCache();
    const hRes = await worker.fetch(new Request("https://sponsor.test/health"), {});
    const h3 = (await hRes.json()) as Record<string, any>;
    check(
      "KMS down: /health still answers 200, says ok:false and the signer unavailable, and names the account",
      hRes.status === 200 && h3.ok === false && h3.signer?.available === false && h3.signer?.publicKey === null && h3.account === named,
      `${hRes.status} ${JSON.stringify({ ok: h3.ok, signer: h3.signer, account: h3.account })}`,
    );
    const ps = await worker.fetch(new Request("https://sponsor.test/pilot-status"), {});
    check("KMS down: a read route (/pilot-status) still answers 200", ps.status === 200, String(ps.status));
    const claim = await worker.fetch(
      new Request("https://sponsor.test/v2-claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "claim", linkHex: "ab".repeat(32), payout: named, sigHex: "cd".repeat(64) }) }),
      {},
    );
    check("KMS down: a value route still fails (no fallback signer exists)", claim.status >= 400, String(claim.status));
    down.restore();
    resetServiceCache();
    restoreKms();
  }

  /* ------------------------------------------------------------------------------------------
   * [9] KMS mode REQUIRES SPONSOR_ACCOUNT_ID. Every fallback is the wrong account at some step of
   * the cutover: derived from the hot secret it looks right on /health until runbook step 7 deletes
   * that secret, and then every new isolate acts as the KMS key's own, unfunded address.
   * ------------------------------------------------------------------------------------------ */
  console.log("[9] KMS mode needs SPONSOR_ACCOUNT_ID: the account is never derived from the hot secret or the KMS key");
  {
    const accountKp = Keypair.random();
    const hot = Keypair.random();
    const kmsKey = Keypair.random();
    const restoreEnv = setEnv({
      ...OFFLINE_BASE,
      KMS_KEY_ID: "arn:aws:kms:eu-central-1:000000000000:key/mode",
      KMS_REGION: "eu-central-1",
      AWS_ACCESS_KEY_ID: "AKIAMODECHECK000000X",
      AWS_SECRET_ACCESS_KEY: "mode-secret",
      SPONSOR_SECRET: hot.secret(), // runbook steps 4-6: still a Worker secret
    });
    const aws = stubFetch(kmsRoute(kmsKey));
    const message = (f: () => unknown) => {
      try {
        f();
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    };
    resetServiceCache();
    const e1 = await settle(getServiceAsync());
    check("hot secret set, SPONSOR_ACCOUNT_ID forgotten (runbook steps 4-6): the service refuses to start, naming the variable", /SPONSOR_ACCOUNT_ID/.test(e1), e1);
    check("serviceConfigFromEnv refuses the same way instead of deriving the account from the secret", /SPONSOR_ACCOUNT_ID/.test(message(() => serviceConfigFromEnv())));
    delete process.env.SPONSOR_SECRET; // runbook step 7
    resetServiceCache();
    const e2 = await settle(getServiceAsync());
    check("after the hot secret is deleted (step 7) it still refuses, rather than act as the KMS key's own address", /SPONSOR_ACCOUNT_ID/.test(e2), e2);
    check("neither refusal asked KMS anything (the config is checked first)", aws.seen.length === 0);

    process.env.SPONSOR_ACCOUNT_ID = accountKp.publicKey();
    process.env.SPONSOR_SECRET = hot.secret();
    resetServiceCache();
    check("the sync getService() refuses KMS mode: it could only ever sign with the hot key", /getServiceAsync/.test(message(() => getService())));
    const cfg = serviceConfigFromEnv();
    check(
      "serviceConfigFromEnv: the account is SPONSOR_ACCOUNT_ID, the source says so, and the hot secret is dropped from the config",
      cfg.kms && cfg.config.sponsorAccountId === accountKp.publicKey() && cfg.accountSource === "SPONSOR_ACCOUNT_ID" && cfg.config.sponsorSecret === "",
    );
    check("and it makes no KMS call: a reader that needs only the account (the watchdog) keeps working while KMS is down", aws.seen.length === 0);
    const [a, b] = await Promise.all([getServiceAsync(), getServiceAsync()]);
    check(
      "getServiceAsync: kind kms, the signer is the KMS key, the account is SPONSOR_ACCOUNT_ID",
      a.signerKind === "kms" && a.signer.publicKey() === kmsKey.publicKey() && a.config.sponsorAccountId === accountKp.publicKey() && a.accountSource === "SPONSOR_ACCOUNT_ID",
    );
    check("two concurrent first requests share one bootstrap: one GetPublicKey", a === b && aws.seen.filter((s) => s.target === "TrentService.GetPublicKey").length === 1, String(aws.seen.length));
    aws.restore();

    resetServiceCache();
    let down = true;
    const flaky = stubFetch((s) => (down ? jsonResponse(500, { __type: "KMSInternalException" }) : kmsRoute(kmsKey)(s)));
    const e3 = await settle(getServiceAsync());
    down = false;
    const again = await getServiceAsync().then((s) => s.signerKind, () => "failed");
    check("a failed KMS bootstrap is not cached: the next request builds the service", /HTTP 500 KMSInternalException/.test(e3) && again === "kms", `${e3} / ${again}`);
    flaky.restore();

    for (const k of ["KMS_KEY_ID", "KMS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "SPONSOR_ACCOUNT_ID"]) delete process.env[k];
    resetServiceCache();
    const envOnly = getService();
    check("env mode, no SPONSOR_ACCOUNT_ID: accountSource 'signer', the account is the hot key's own address", envOnly.signerKind === "env" && envOnly.accountSource === "signer" && envOnly.config.sponsorAccountId === hot.publicKey());
    process.env.SPONSOR_ACCOUNT_ID = accountKp.publicKey();
    resetServiceCache();
    const envNamed = await getServiceAsync();
    check(
      "env mode with SPONSOR_ACCOUNT_ID: accountSource 'SPONSOR_ACCOUNT_ID', the account is that, the signer the hot key",
      envNamed.signerKind === "env" && envNamed.accountSource === "SPONSOR_ACCOUNT_ID" && envNamed.config.sponsorAccountId === accountKp.publicKey() && envNamed.signer.publicKey() === hot.publicKey(),
    );
    resetServiceCache();
    restoreEnv();
  }

  /* ------------------------------------------------------------------------------------------
   * [10] The real KMS transport (aws4fetch) against a stubbed endpoint. A testnet 400 echoes the
   * thrown message verbatim, so the message may carry the status and the AWS error type and
   * nothing else: an AccessDenied body names the IAM principal and the AWS account id.
   * ------------------------------------------------------------------------------------------ */
  console.log("[10] the KMS transport: SigV4 to the regional endpoint, one retry, one deadline, no error body in an error");
  {
    const kmsKey = Keypair.random();
    const make = (timeoutMs = 2_000) =>
      KmsSponsorSigner.create({
        keyId: "arn:aws:kms:eu-central-1:123456789012:key/transport",
        region: "eu-central-1",
        accessKeyId: "AKIATRANSPORT000000X",
        secretAccessKey: "transport-secret",
        timeoutMs,
      });
    const signError = async (onSign: (s: Seen, n: number) => Response | Promise<Response>, timeoutMs?: number) => {
      const aws = stubFetch(kmsRoute(kmsKey, onSign));
      try {
        const s = await make(timeoutMs);
        const t0 = Date.now();
        const err = await settle(s.sign(sampleTx(kmsKey.publicKey())));
        return { err, ms: Date.now() - t0, signs: aws.seen.filter((x) => x.target === "TrentService.Sign"), seen: aws.seen };
      } finally {
        aws.restore();
      }
    };

    {
      const aws = stubFetch(kmsRoute(kmsKey));
      const s = await make();
      const tx = sampleTx(kmsKey.publicKey());
      await s.sign(tx);
      aws.restore();
      check(
        "GetPublicKey then Sign, POSTed to https://kms.<region>.amazonaws.com/ as JSON 1.1 with a SigV4 signature for service kms",
        aws.seen.length === 2 &&
          aws.seen[0]!.target === "TrentService.GetPublicKey" &&
          aws.seen[1]!.target === "TrentService.Sign" &&
          aws.seen.every(
            (r) =>
              r.url === "https://kms.eu-central-1.amazonaws.com/" &&
              r.method === "POST" &&
              r.contentType === "application/x-amz-json-1.1" &&
              /^AWS4-HMAC-SHA256 Credential=AKIATRANSPORT000000X\/\d{8}\/eu-central-1\/kms\/aws4_request/.test(r.auth ?? ""),
          ),
      );
      check("the Sign body is RAW + ED25519_SHA_512 over the tx hash, and the signature that came back verifies", aws.seen[1]!.body?.MessageType === "RAW" && aws.seen[1]!.body?.SigningAlgorithm === "ED25519_SHA_512" && kmsKey.verify(tx.hash(), tx.signatures[0]!.signature()));
    }
    {
      const r = await signError(() => jsonResponse(500, { __type: "com.amazonaws.kms#KMSInternalException", message: "internal" }));
      check("a 5xx is retried exactly once (two attempts), not aws4fetch's default ten", r.signs.length === 2, String(r.signs.length));
      check("and the error is the status plus the sanitized type", r.err === "KMS TrentService.Sign failed: HTTP 500 KMSInternalException", r.err);
    }
    {
      const r = await signError((s, n) => (n === 1 ? jsonResponse(500, { __type: "KMSInternalException" }) : kmsRoute(kmsKey)(s)));
      check("one transient 5xx is absorbed by the single retry", r.err === "" && r.signs.length === 2, r.err);
    }
    {
      const r = await signError(() => jsonResponse(400, { __type: "ThrottlingException" }, { "x-amzn-errortype": "ThrottlingException:http://internal.amazon.com/coral/com.amazon.coral.availability/" }));
      check("a 4xx is not retried, and the X-Amzn-Errortype header is read and cut at ':'", r.signs.length === 1 && r.err === "KMS TrentService.Sign failed: HTTP 400 ThrottlingException", r.err);
    }
    {
      const logged: string[] = [];
      const realError = console.error;
      console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
      const denied = "User: arn:aws:iam::123456789012:user/lumenia-sponsor-worker-testnet is not authorized to perform: kms:Sign on resource: arn:aws:kms:eu-central-1:123456789012:key/transport";
      let r: Awaited<ReturnType<typeof signError>>;
      try {
        r = await signError(() => jsonResponse(400, { __type: "AccessDeniedException", Message: denied }));
      } finally {
        console.error = realError;
      }
      check("AccessDenied: the error names the status and the type only (no principal, no ARN, no account id)", r.err === "KMS TrentService.Sign failed: HTTP 400 AccessDeniedException" && !/arn:|123456789012|not authorized/.test(r.err), r.err);
      check("and the body goes to the Worker's own log instead", logged.some((l) => /AccessDeniedException/.test(l) && /not authorized/.test(l)));
    }
    {
      let aborted = false;
      const r = await signError(
        (s) =>
          new Promise<Response>((_, reject) => {
            s.signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
        150,
      );
      check("a KMS call that never answers fails at the deadline, not after aws4fetch's backoff", /no answer within 150 ms/.test(r.err) && r.ms < 1_500, `${r.err} after ${r.ms} ms`);
      check("and the abort reached the request itself", aborted);
    }
    {
      const r = await signError(() => {
        throw new TypeError("fetch failed: getaddrinfo ENOTFOUND kms.eu-central-1.amazonaws.com");
      });
      check("a transport failure surfaces as 'network error' and nothing more", r.err === "KMS TrentService.Sign failed: network error", r.err);
    }
    {
      const r = await signError(() => new Response("<html>gateway</html>", { status: 200 }));
      check("an unreadable 200 is refused without being echoed", r.err === "KMS TrentService.Sign failed: unreadable response (HTTP 200)", r.err);
    }
    {
      const aws = stubFetch(() => jsonResponse(400, { __type: "com.amazonaws.kms#NotFoundException", message: "Key 'arn:aws:kms:eu-central-1:123456789012:key/transport' does not exist" }));
      const err = await settle(make());
      aws.restore();
      check("a failing GetPublicKey fails create() the same way", err === "KMS TrentService.GetPublicKey failed: HTTP 400 NotFoundException", err);
    }
    check("kmsErrorType: a namespaced __type keeps what follows '#'", kmsErrorType(null, '{"__type":"com.amazonaws.kms#KMSInvalidStateException","message":"x"}') === "KMSInvalidStateException");
    check("kmsErrorType: the header wins over the body", kmsErrorType("DisabledException", '{"__type":"Other"}') === "DisabledException");
    check("kmsErrorType: `code` is read when `__type` is absent", kmsErrorType(null, '{"code":"KeyUnavailableException"}') === "KeyUnavailableException");
    check(
      "kmsErrorType: anything that is not a plain identifier is 'unknown'",
      kmsErrorType(null, '{"__type":"<img src=x onerror=1>"}') === "unknown" && kmsErrorType(null, "<html>") === "unknown" && kmsErrorType(null, "") === "unknown" && kmsErrorType("", '{"__type":"a b"}') === "unknown",
    );
  }

  /* ------------------------------------------------------------------------------------------
   * [11] add-signer's checks, pure: the dry run writes an UNSIGNED transaction and its hash, and
   * --submit refuses anything but exactly that transaction.
   * ------------------------------------------------------------------------------------------ */
  console.log("[11] add-signer: an unsigned dry run, and a submit that takes exactly the reviewed transaction");
  {
    const accountKp = Keypair.random();
    const ACCOUNT = accountKp.publicKey();
    const KMS_G = Keypair.random().publicKey();
    const now = new Date("2026-10-08T12:00:00.000Z");
    const soon = new Date(now.getTime() + 10 * 60_000);
    const horizonAccount = {
      id: ACCOUNT,
      sequence: "1000",
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      signers: [{ key: ACCOUNT, weight: 1, type: "ed25519_public_key" }],
    };
    const { record, tx } = buildSetOptionsRecord({ network: "testnet", account: horizonAccount, signer: KMS_G, weight: 1, now });
    const op = tx.operations[0] as unknown as { type: string; signer?: { ed25519PublicKey?: string; weight?: number }; lowThreshold?: number; medThreshold?: number; highThreshold?: number; masterWeight?: number };
    check("the dry run's transaction is unsigned, and the recorded hash is its hash", tx.signatures.length === 0 && record.hash === tx.hash().toString("hex") && TransactionBuilder.fromXDR(record.unsignedXdr, Networks.TESTNET).signatures.length === 0);
    const signedLater = TransactionBuilder.fromXDR(record.unsignedXdr, Networks.TESTNET) as Transaction;
    signedLater.sign(accountKp);
    check("signing it later leaves that hash unchanged (a hash never covers signatures): the recorded hash is the one that lands", signedLater.hash().toString("hex") === record.hash);
    // A freshly built transaction reports an unset field as null (undefined after an XDR round trip).
    check("one SetOptions on the account: the signer at weight 1, thresholds 1/1/1, the master weight untouched", tx.source === ACCOUNT && tx.operations.length === 1 && op.type === "setOptions" && op.signer?.ed25519PublicKey === KMS_G && op.signer?.weight === 1 && op.lowThreshold === 1 && op.medThreshold === 1 && op.highThreshold === 1 && op.masterWeight == null);
    const reparsed = (TransactionBuilder.fromXDR(record.unsignedXdr, Networks.TESTNET) as Transaction).operations[0] as unknown as { masterWeight?: number | null };
    check("and the same after the XDR round trip the submit reads", reparsed.masterWeight == null);
    check("the record keeps the signers and thresholds BEFORE the change", record.before.sequence === "1000" && record.before.signers.length === 1 && record.before.signers[0]!.key === ACCOUNT && record.before.thresholds.high === 0);
    check("valid for one hour from the dry run, at the account's next sequence", record.validUntil === "2026-10-08T13:00:00.000Z" && Number(tx.timeBounds?.maxTime) === now.getTime() / 1000 + 3600 && record.sequence === "1001" && tx.sequence === "1001");
    const accepted = checkRecordForSubmit(JSON.parse(JSON.stringify(record)), { network: "testnet", hash: record.hash.toUpperCase(), now: soon });
    check("--submit accepts the untouched file with its hash (any case)", accepted.tx.hash().toString("hex") === record.hash && accepted.tx.signatures.length === 0);

    /** A record whose transaction was swapped for `swap`, with the record's hash updated to match. */
    const swapped = (swap: Transaction): SetOptionsRecord => ({ ...record, unsignedXdr: swap.toXDR(), hash: swap.hash().toString("hex") });
    const variant = (ops: xdr.Operation[], opts: { source?: string; fee?: string; noTimebound?: boolean } = {}): Transaction => {
      const b = new TransactionBuilder(new Account(opts.source ?? ACCOUNT, "1000"), { fee: opts.fee ?? BASE_FEE, networkPassphrase: Networks.TESTNET });
      for (const o of ops) b.addOperation(o);
      return opts.noTimebound ? b.setTimeout(TimeoutInfinite).build() : b.setTimebounds(0, now.getTime() / 1000 + 3600).build();
    };
    const addKms = (extra: Record<string, unknown> = {}) =>
      Operation.setOptions({ signer: { ed25519PublicKey: KMS_G, weight: 1 }, lowThreshold: 1, medThreshold: 1, highThreshold: 1, ...extra });
    const presigned = TransactionBuilder.fromXDR(record.unsignedXdr, Networks.TESTNET) as Transaction;
    presigned.sign(accountKp);
    const refusals: Array<[string, () => unknown, RegExp]> = [
      ["a --hash that is not the file's", () => checkRecordForSubmit(record, { network: "testnet", hash: "00".repeat(32), now: soon }), /not to the --hash given/],
      ["the other network", () => checkRecordForSubmit(record, { network: "mainnet", hash: record.hash, now: soon }), /for testnet, not mainnet/],
      ["an expired dry run", () => checkRecordForSubmit(record, { network: "testnet", hash: record.hash, now: new Date(now.getTime() + 3_590_000) }), /expired/],
      ["the old record format, which held a SIGNED envelope", () => checkRecordForSubmit({ tool: "add-signer", xdr: record.unsignedXdr, hash: record.hash, submitted: false }, { network: "testnet", hash: record.hash, now: soon }), /not a dry-run record/],
      ["a record that already landed", () => checkRecordForSubmit({ ...record, outcome: "submitted" }, { network: "testnet", hash: record.hash, now: soon }), /already landed/],
      ["a file whose recorded hash was edited", () => checkRecordForSubmit({ ...record, hash: "ff".repeat(32) }, { network: "testnet", hash: record.hash, now: soon }), /recorded hash is not/],
      ["an envelope that already carries a signature", () => checkRecordForSubmit({ ...record, unsignedXdr: presigned.toXDR() }, { network: "testnet", hash: record.hash, now: soon }), /already carries a signature/],
      ["a swap that also zeroes the master weight", () => { const r = swapped(variant([addKms({ masterWeight: 0 })])); return checkRecordForSubmit(r, { network: "testnet", hash: r.hash, now: soon }); }, /changes more than/],
      ["a swap that adds another signer", () => { const r = swapped(variant([Operation.setOptions({ signer: { ed25519PublicKey: Keypair.random().publicKey(), weight: 1 }, lowThreshold: 1, medThreshold: 1, highThreshold: 1 })])); return checkRecordForSubmit(r, { network: "testnet", hash: r.hash, now: soon }); }, /does not add the record's signer/],
      ["a swap with a second operation", () => { const r = swapped(variant([addKms(), Operation.setOptions({ homeDomain: "example.com" })])); return checkRecordForSubmit(r, { network: "testnet", hash: r.hash, now: soon }); }, /holds 2 operations/],
      ["a swap sourced by another account", () => { const r = swapped(variant([addKms()], { source: Keypair.random().publicKey() })); return checkRecordForSubmit(r, { network: "testnet", hash: r.hash, now: soon }); }, /not sourced by the record's account/],
      ["a swap with other thresholds", () => { const r = swapped(variant([Operation.setOptions({ signer: { ed25519PublicKey: KMS_G, weight: 1 }, lowThreshold: 2, medThreshold: 2, highThreshold: 2 })])); return checkRecordForSubmit(r, { network: "testnet", hash: r.hash, now: soon }); }, /1\/1\/1/],
      ["a swap that is a payment", () => { const r = swapped(variant([Operation.payment({ destination: KMS_G, asset: Asset.native(), amount: "1" })])); return checkRecordForSubmit(r, { network: "testnet", hash: r.hash, now: soon }); }, /is payment, not setOptions/],
      ["a swap with an inflated fee", () => { const r = swapped(variant([addKms()], { fee: "1000000" })); return checkRecordForSubmit(r, { network: "testnet", hash: r.hash, now: soon }); }, /bids 1000000/],
      ["a swap with no timebound", () => { const r = swapped(variant([addKms()], { noTimebound: true })); return checkRecordForSubmit(r, { network: "testnet", hash: r.hash, now: soon }); }, /no timebound/],
    ];
    for (const [name, f, re] of refusals) {
      let msg = "";
      try {
        f();
      } catch (e) {
        msg = (e as Error).message;
      }
      check(`--submit refuses ${name}`, re.test(msg), msg || "accepted");
    }
    const live = (patch: Partial<typeof record.before>) => {
      try {
        checkLiveAccount(record, tx, { ...record.before, ...patch });
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    };
    check("the live account must not have moved: a sequence change since the dry run is refused", /sequence moved/.test(live({ sequence: "1001" })));
    check("an unchanged account is accepted", live({}) === "");
    check("a signer already on the account at that weight is refused (nothing to submit)", /already on the account/.test(live({ signers: [...record.before.signers, { key: KMS_G, weight: 1, type: "ed25519_public_key" }] })));
    check("a master key at weight 0 cannot authorize it, and the refusal points at section 3", /section 3/.test(live({ signers: [{ key: ACCOUNT, weight: 0, type: "ed25519_public_key" }] })));

    check(
      "a relative --out means what it means where it was typed (INIT_CWD), not inside apps/sponsor",
      resolveCliPath(".cutover/testnet-setoptions.json", { INIT_CWD: SPONSOR_DIR }, "/elsewhere") === resolve(SPONSOR_DIR, ".cutover/testnet-setoptions.json") &&
        resolveCliPath("apps/sponsor/.cutover/testnet-setoptions.json", { INIT_CWD: REPO_DIR }, SPONSOR_DIR) === resolve(SPONSOR_DIR, ".cutover/testnet-setoptions.json"),
    );
    check("without INIT_CWD the process's own directory is the base, and an absolute path stays as it is", resolveCliPath("x.json", {}, "/tmp/a") === "/tmp/a/x.json" && resolveCliPath("/abs/x.json", { INIT_CWD: "/y" }) === "/abs/x.json");
    check("the runbook's record path (.cutover/<network>-setoptions.json in apps/sponsor) is gitignored", isGitignored(resolve(SPONSOR_DIR, ".cutover/testnet-setoptions.json")) && isGitignored(suggestedRecordPath("mainnet")));
    check("a path outside .cutover is not, so the tool refuses it", !isGitignored(resolve(SPONSOR_DIR, "src/kms-not-ignored.json")));
    check(
      "the refusal's hint prints the record path as it is typed from where the command ran",
      shownPath(suggestedRecordPath("testnet"), { INIT_CWD: REPO_DIR }) === "apps/sponsor/.cutover/testnet-setoptions.json" && shownPath(suggestedRecordPath("testnet"), { INIT_CWD: SPONSOR_DIR }) === ".cutover/testnet-setoptions.json",
    );
  }

  /* ------------------------------------------------------------------------------------------
   * [12] add-signer end to end, run as the operator runs it (apps/sponsor as its cwd, INIT_CWD
   * where the command was typed), against a Horizon stand-in on 127.0.0.1. Nothing leaves the
   * machine: the stand-in checks the master signature and applies the SetOptions itself.
   * ------------------------------------------------------------------------------------------ */
  console.log("[12] add-signer end to end against a Horizon on this machine: dry run, review, submit");
  {
    const accountKp = Keypair.random();
    const ACCOUNT = accountKp.publicKey();
    const KMS_G = Keypair.random().publicKey();
    const state = {
      sequence: "5000",
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      signers: [{ key: ACCOUNT, weight: 1, type: "ed25519_public_key" }],
    };
    const posted: string[] = [];
    let refuseNext = false;
    /** The next submit lands but its answer is lost (a 504): the case an "unconfirmed" record is for. */
    let landButTimeout = false;
    const landedHashes = new Set<string>();
    const horizon = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        if (req.method === "GET" && path.startsWith("/transactions/")) {
          const h = path.slice("/transactions/".length);
          return landedHashes.has(h) ? send(200, { id: h, hash: h, ledger: 4242, successful: true }) : send(404, { status: 404, title: "Resource Missing" });
        }
        if (req.method === "GET" && path === `/accounts/${ACCOUNT}`) {
          return send(200, { id: ACCOUNT, account_id: ACCOUNT, sequence: state.sequence, subentry_count: 0, thresholds: state.thresholds, signers: state.signers, balances: [{ asset_type: "native", balance: "100.0000000" }], flags: {}, num_sponsoring: 0, num_sponsored: 0, last_modified_ledger: 1, last_modified_time: "2026-10-08T12:00:00Z", paging_token: ACCOUNT, data: {} });
        }
        if (req.method === "POST" && path === "/transactions") {
          const envelope = new URLSearchParams(Buffer.concat(chunks).toString()).get("tx") ?? "";
          posted.push(envelope);
          const t = TransactionBuilder.fromXDR(envelope, Networks.TESTNET) as Transaction;
          const signedByMaster = t.signatures.some((s) => accountKp.verify(t.hash(), s.signature()));
          const fault = refuseNext ? "tx_insufficient_fee" : !signedByMaster ? "tx_bad_auth" : BigInt(t.sequence) !== BigInt(state.sequence) + 1n ? "tx_bad_seq" : null;
          refuseNext = false;
          if (fault) {
            return send(400, { type: "https://stellar.org/horizon-errors/transaction_failed", title: "Transaction Failed", status: 400, extras: { envelope_xdr: envelope, result_codes: { transaction: fault } } });
          }
          const o = t.operations[0] as unknown as { signer: { ed25519PublicKey: string; weight: number } };
          state.sequence = t.sequence;
          state.signers = [...state.signers, { key: o.signer.ed25519PublicKey, weight: o.signer.weight, type: "ed25519_public_key" }];
          state.thresholds = { low_threshold: 1, med_threshold: 1, high_threshold: 1 };
          landedHashes.add(t.hash().toString("hex"));
          if (landButTimeout) {
            landButTimeout = false;
            return send(504, { status: 504, title: "Timeout" });
          }
          return send(200, { hash: t.hash().toString("hex"), ledger: 4242, successful: true, envelope_xdr: envelope });
        }
        return send(404, { status: 404, title: "Resource Missing" });
      });
    });
    await new Promise<void>((r) => horizon.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(horizon.address() as AddressInfo).port}`;
    const cutoverDir = resolve(SPONSOR_DIR, ".cutover");
    const hadDir = existsSync(cutoverDir);
    const name = `kms-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`;
    const recordPath = resolve(cutoverDir, name);
    const typed = `.cutover/${name}`;
    const env = { INIT_CWD: SPONSOR_DIR };
    const secret = accountKp.secret();
    try {
      const dry = await runAddSigner(["--network", "testnet", "--account", ACCOUNT, "--signer", KMS_G, "--out", typed, "--horizon", url], env);
      const written = existsSync(recordPath) ? (JSON.parse(readFileSync(recordPath, "utf8")) as SetOptionsRecord) : null;
      check("the dry run needs no secret, writes the record and submits nothing", dry.code === 0 && !!written && written.outcome === "dry-run" && posted.length === 0, dry.out.trim().split("\n").slice(-3).join(" | "));
      check("the record is readable by its owner only", existsSync(recordPath) && (statSync(recordPath).mode & 0o777) === 0o600);
      check("its output prints the submit command with a path that works from where it was typed", !!written && dry.out.includes(`--submit --in ${typed} --hash ${written.hash}`));
      const hash = written?.hash ?? "";

      const wrongHash = await runAddSigner(["--network", "testnet", "--submit", "--in", typed, "--hash", "ab".repeat(32), "--horizon", url], { ...env, SPONSOR_SECRET: secret });
      check("--submit with a hash that is not the file's is refused, and nothing is posted", wrongHash.code !== 0 && /not the transaction that was reviewed/.test(wrongHash.out) && posted.length === 0, wrongHash.out.trim());
      const noSecret = await runAddSigner(["--network", "testnet", "--submit", "--in", typed, "--hash", hash, "--horizon", url], env);
      check("--submit without SPONSOR_SECRET is refused before anything is posted", noSecret.code !== 0 && /SPONSOR_SECRET is not set/.test(noSecret.out) && posted.length === 0, noSecret.out.trim());

      refuseNext = true;
      const refused = await runAddSigner(["--network", "testnet", "--submit", "--in", typed, "--hash", hash, "--horizon", url], { ...env, SPONSOR_SECRET: secret });
      const afterRefusal = readFileSync(recordPath, "utf8");
      check("a refused submit is recorded as failed with Horizon's result codes", refused.code !== 0 && /"outcome": "failed"/.test(afterRefusal) && /tx_insufficient_fee/.test(afterRefusal), refused.out.trim());
      check("and the SIGNED envelope it was refused with is written nowhere", posted.length === 1 && !afterRefusal.includes(posted[0]!));

      // The submit lands but Horizon's answer is a 504: recorded as unconfirmed, as it must be.
      landButTimeout = true;
      const timedOut = await runAddSigner(["--network", "testnet", "--submit", "--in", typed, "--hash", hash, "--horizon", url], { ...env, SPONSOR_SECRET: secret });
      const afterTimeout = JSON.parse(readFileSync(recordPath, "utf8")) as SetOptionsRecord;
      check("a submit answered 504 is recorded as unconfirmed (it may still land)", timedOut.code !== 0 && afterTimeout.outcome === "unconfirmed", timedOut.out.trim().split("\n").slice(-1).join(""));
      // The re-submit the tool recommends finds the SetOptions already on the ledger and records it,
      // instead of refusing as if another transaction had moved the sequence (a review hit exactly that).
      const sent = await runAddSigner(["--network", "testnet", "--submit", "--in", typed, "--hash", hash, "--horizon", url], { ...env, SPONSOR_SECRET: secret });
      check("the re-submit sees it landed: nothing new is posted, and it says so", sent.code === 0 && posted.length === 2 && /already landed/.test(sent.out), sent.out.trim().split("\n").slice(-2).join(" | "));
      const final = JSON.parse(readFileSync(recordPath, "utf8")) as SetOptionsRecord;
      const landed = posted[1] ? (TransactionBuilder.fromXDR(posted[1], Networks.TESTNET) as Transaction) : null;
      check("the submit lands exactly the reviewed transaction: same hash, signed once by the master key", sent.code === 0 && !!landed && landed.hash().toString("hex") === hash && landed.signatures.length === 1 && sigsBy(landed, ACCOUNT) === 1, sent.out.trim().split("\n").slice(-2).join(" | "));
      check(
        "the record becomes the cutover log: submitted, the ledger, and the signers and thresholds after the change",
        final.outcome === "submitted" && final.ledger === 4242 && final.after?.signers.some((s) => s.key === KMS_G && s.weight === 1) === true && final.after?.thresholds.high === 1 && final.before.thresholds.high === 0,
      );
      const everything = `${dry.out}${wrongHash.out}${noSecret.out}${refused.out}${sent.out}${readFileSync(recordPath, "utf8")}`;
      check("the secret is in no output and not in the file", !everything.includes(secret));

      const overwrite = await runAddSigner(["--network", "testnet", "--account", ACCOUNT, "--signer", KMS_G, "--out", typed, "--horizon", url], env);
      check("a dry run will not overwrite the record of a submitted SetOptions", overwrite.code !== 0 && /cutover log/.test(overwrite.out) && JSON.parse(readFileSync(recordPath, "utf8")).outcome === "submitted", overwrite.out.trim());
      const tracked = await runAddSigner(["--network", "testnet", "--account", ACCOUNT, "--signer", KMS_G, "--out", "src/kms-not-ignored.json", "--horizon", url], env);
      check(
        "an --out git would track is refused, with a hint that works from where the command was typed",
        tracked.code !== 0 && tracked.out.includes("not gitignored") && tracked.out.includes(".cutover/testnet-setoptions.json") && !existsSync(resolve(SPONSOR_DIR, "src/kms-not-ignored.json")),
        tracked.out.trim(),
      );
    } finally {
      horizon.close();
      rmSync(recordPath, { force: true });
      if (!hadDir) {
        try {
          rmdirSync(cutoverDir);
        } catch {
          /* not empty: someone's real record is there; leave it */
        }
      }
    }
  }

  /* ------------------------------------------------------------------------------------------
   * [13] The subrequest limit of ONE Worker invocation: 50 on the Workers Free plan, and a live
   * testnet run already hit "Too many subrequests". Every route that signs runs through worker.fetch
   * at its worst case with KMS signing: a cold isolate whose GetPublicKey needs its retry, every Sign
   * answered 500 once (one fetch plus its retry), a stale halt cache, both rate-limit windows, the
   * pilot slot, a channel lease found on the sixth try, and a transaction the RPC never shows
   * (NOT_FOUND on every poll). The real aws4fetch transport, the real Soroban RPC and Horizon
   * clients and the store all reach the stubbed fetch, which counts every request.
   * ------------------------------------------------------------------------------------------ */
  console.log(`[13] the ${WORKER_SUBREQUEST_LIMIT}-subrequest limit: every signing route stays at or under ${SUBREQUEST_BUDGET} with KMS, worst case`);
  {
    const accountKp = Keypair.random();
    const ACCOUNT = accountKp.publicKey();
    const kmsKey = Keypair.random();
    const channel = Keypair.random();
    const sender = Keypair.random();
    const kv = new Map<string, string>();
    /** Per route: the KMS answers still to come (500 = a failed attempt), and what was asked. */
    const st = { gpk: [] as number[], sign: [] as number[], leaseTries: 0, leaseReleases: 0, polls: 0 };
    const rpcJson = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
    const plainJson = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const accountEntry = (accountId: xdr.AccountId) =>
      xdr.LedgerEntryData.account(
        new xdr.AccountEntry({
          accountId,
          balance: xdr.Int64.fromString("1000000000"),
          seqNum: xdr.Int64.fromString("7"),
          numSubEntries: 0,
          inflationDest: null,
          flags: 0,
          homeDomain: "",
          thresholds: Buffer.from([1, 0, 0, 0]),
          signers: [],
          ext: new xdr.AccountEntryExt(0),
        }),
      ).toXDR("base64");
    /* A CCTP V2 message the relay accepts: Base (6) to Stellar (27), the forwarder as its caller. */
    const header = Buffer.alloc(148);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(6, 4);
    header.writeUInt32BE(27, 8);
    Buffer.alloc(32, 9).copy(header, 12);
    Buffer.from(StrKey.decodeContract(CCTP_TESTNET_FORWARDER)).copy(header, 108);
    header.writeUInt32BE(1000, 140);
    header.writeUInt32BE(1000, 144);
    const cctpMessage = `0x${Buffer.concat([header, Buffer.alloc(120, 3)]).toString("hex")}`;
    const cctpAttestation = `0x${Buffer.alloc(130, 1).toString("hex")}`;

    const route = async (s: Seen): Promise<Response> => {
      const u = new URL(s.url);
      if (u.hostname === "kms.eu-central-1.amazonaws.com") {
        const status = (s.target === "TrentService.GetPublicKey" ? st.gpk : st.sign).shift() ?? 200;
        if (status !== 200) return jsonResponse(status, { __type: "KMSInternalException" });
        if (s.target === "TrentService.GetPublicKey") {
          return jsonResponse(200, { KeySpec: "ECC_NIST_EDWARDS25519", PublicKey: Buffer.concat([ED25519_SPKI_PREFIX, kmsKey.rawPublicKey()]).toString("base64") });
        }
        return jsonResponse(200, { Signature: kmsKey.sign(Buffer.from(String(s.body?.Message), "base64")).toString("base64"), SigningAlgorithm: "ED25519_SHA_512" });
      }
      if (u.hostname === "kv.budget.test" && u.pathname === "/pipeline") {
        const cmds = s.body as unknown as string[][];
        return plainJson(
          200,
          cmds.map((cmd) => {
            const [op, key, ...rest] = cmd as [string, string, ...string[]];
            switch (op) {
              case "GET":
                return { result: kv.get(key) ?? null };
              case "SET": {
                if ((rest.includes("NX") && kv.has(key)) || (rest.includes("XX") && !kv.has(key))) return { result: null };
                kv.set(key, String(rest[0]));
                return { result: "OK" };
              }
              case "INCR":
              case "INCRBY":
              case "DECR": {
                const delta = op === "INCR" ? 1n : op === "DECR" ? -1n : BigInt(rest[0]!);
                const next = BigInt(kv.get(key) ?? "0") + delta;
                kv.set(key, next.toString());
                return { result: next.toString() };
              }
              case "EXPIRE":
              case "PEXPIRE":
                return { result: 1 };
              case "DEL":
                return { result: kv.delete(key) ? 1 : 0 };
              case "EVAL": {
                // `key` is the script here. The channel pool's one-round-trip lease takes on the 6th try.
                if (key.includes("#KEYS")) return { result: ++st.leaseTries % 6 === 0 ? 1 : 0 };
                if (key.includes("'del'")) st.leaseReleases++;
                return { result: 1 };
              }
              default:
                throw new TypeError(`budget store: unexpected command ${op}`);
            }
          }),
        );
      }
      if (u.hostname === "rpc.budget.test") {
        const call = s.body as { method?: string; params?: Record<string, unknown> } | null;
        if (call?.method === "getLedgerEntries") {
          const keyB64 = (call.params?.keys as string[])[0]!;
          const accountId = xdr.LedgerKey.fromXDR(keyB64, "base64").account().accountId();
          return rpcJson({ latestLedger: 100, entries: [{ key: keyB64, xdr: accountEntry(accountId), lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 1000 }] });
        }
        if (call?.method === "simulateTransaction") {
          return rpcJson({
            latestLedger: 100,
            minResourceFee: "500000",
            transactionData: new SorobanDataBuilder().setResourceFee(500_000).build().toXDR("base64"),
            results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR("base64") }],
            events: [],
          });
        }
        if (call?.method === "sendTransaction") {
          const sent = TransactionBuilder.fromXDR(String(call.params?.transaction), Networks.TESTNET);
          return rpcJson({ status: "PENDING", hash: sent.hash().toString("hex"), latestLedger: 100, latestLedgerCloseTime: "0" });
        }
        if (call?.method === "getTransaction") {
          st.polls++;
          return rpcJson({ status: "NOT_FOUND", latestLedger: 100, latestLedgerCloseTime: "0", oldestLedger: 1, oldestLedgerCloseTime: "0" });
        }
      }
      if (u.hostname === "horizon.budget.test" && u.pathname.startsWith("/accounts/")) {
        const id = u.pathname.slice("/accounts/".length);
        if (id !== ACCOUNT && id !== channel.publicKey()) {
          return plainJson(404, { type: "https://stellar.org/horizon-errors/not_found", title: "Resource Missing", status: 404 });
        }
        return plainJson(200, { id, account_id: id, sequence: "7", subentry_count: 0, balances: [], signers: [], thresholds: {}, flags: {}, data: {}, paging_token: id });
      }
      if (u.hostname === "iris.budget.test") {
        return plainJson(200, { messages: [{ status: "complete", message: cctpMessage, attestation: cctpAttestation }] });
      }
      throw new TypeError(`offline test: unexpected request to ${s.url}`);
    };

    const KMS_ENV: Record<string, string | undefined> = {
      ...OFFLINE_BASE,
      KV_REST_API_URL: "https://kv.budget.test",
      KV_REST_API_TOKEN: "t",
      KMS_KEY_ID: "arn:aws:kms:eu-central-1:000000000000:key/budget",
      KMS_REGION: "eu-central-1",
      AWS_ACCESS_KEY_ID: "AKIABUDGETCHECK0000X",
      AWS_SECRET_ACCESS_KEY: "budget-secret",
      SPONSOR_ACCOUNT_ID: ACCOUNT,
      SOROBAN_RPC_URL: "https://rpc.budget.test",
      HORIZON_URL: "https://horizon.budget.test",
      LUMENDROP_CONTRACT: CONTRACT,
      CHANNEL_SECRETS: channel.secret(),
      PILOT_MODE: "1",
      CCTP_FORWARDER: CCTP_TESTNET_FORWARDER,
      CCTP_IRIS_URL: "https://iris.budget.test",
      MAX_DAY_FEE_XLM: "100000",
      MAX_DROP_USDC: "1000",
      MAX_DAY_USDC: "100000",
      MAX_DAY_USDC_PER_SENDER: "100000",
    };
    const restoreEnv = setEnv(KMS_ENV);
    kv.set(`pilot:testnet:appr:${sender.publicKey()}`, "1");
    setRelayPollMsForTests(1);
    const net = stubFetch(route);

    /** One request on a cold isolate with a stale halt cache; how many fetches it made, and its answer. */
    const call = async (path: string, body: unknown, plan: { gpk: number[]; sign: number[] }) => {
      resetServiceCache();
      resetHaltCache();
      st.gpk = [...plan.gpk];
      st.sign = [...plan.sign];
      st.leaseTries = 0;
      st.leaseReleases = 0;
      st.polls = 0;
      net.seen.length = 0;
      const res = await worker.fetch(
        new Request(`https://sponsor.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": `203.0.113.${Math.floor(Math.random() * 200) + 1}` },
          body: JSON.stringify(body),
        }),
        {},
      );
      const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, answer, fetches: net.seen.length, polls: st.polls, leaseTries: st.leaseTries, leaseReleases: st.leaseReleases };
    };
    /** Cold KMS: GetPublicKey fails once, then every Sign fails once before its retry succeeds. */
    const WORST = { gpk: [500, 200], sign: [500, 200, 500, 200] };

    const depositTx = () => {
      const t = new TransactionBuilder(new Account(sender.publicKey(), "11"), { fee: "1000000", networkPassphrase: Networks.TESTNET })
        .addOperation(
          new Contract(CONTRACT).call(
            "deposit",
            Address.fromString(sender.publicKey()).toScVal(),
            xdr.ScVal.scvBytes(Buffer.from(Keypair.random().rawPublicKey())),
            nativeToScVal(10_000_000n, { type: "i128" }),
            nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 86_400), { type: "u64" }),
          ),
        )
        .setTimeout(180)
        .build();
      t.sign(sender);
      return t;
    };
    const reclaimTx = () => {
      const t = new TransactionBuilder(new Account(sender.publicKey(), "12"), { fee: "1000000", networkPassphrase: Networks.TESTNET })
        .addOperation(new Contract(CONTRACT).call("reclaim", xdr.ScVal.scvBytes(Buffer.alloc(32, 5))))
        .setTimeout(180)
        .build();
      t.sign(sender);
      return t;
    };

    try {
      const dep = await call("/v2-deposit", { xdr: depositTx().toXDR(), senderPublicKey: sender.publicKey() }, WORST);
      check(
        `/v2-deposit, KMS, worst case: ${dep.fetches} subrequests (at most ${SUBREQUEST_BUDGET}; 41 polls on top of the same start made 54 before the budget)`,
        dep.fetches <= SUBREQUEST_BUDGET && dep.fetches >= 40,
        `${dep.fetches} fetches, ${dep.polls} polls`,
      );
      check(
        "/v2-deposit: the budget, not the 40-poll window, ended the wait, and the answer is the undecided 202 with the hash",
        dep.status === 202 && dep.answer.confirmed === false && /^[0-9a-f]{64}$/.test(String(dep.answer.hash)) && dep.polls > 0 && dep.polls < 41,
        `${dep.status} ${JSON.stringify(dep.answer)} after ${dep.polls} polls`,
      );
      check(
        "/v2-deposit: and three subrequests stayed free for what an on-ledger FAILED would still need (settle, cap, pilot slot)",
        dep.fetches + 3 <= SUBREQUEST_BUDGET,
        `${dep.fetches} + 3`,
      );

      const claim = await call("/v2-claim", { method: "claim", linkHex: "ab".repeat(32), payout: Keypair.random().publicKey(), sigHex: "cd".repeat(64) }, WORST);
      check(
        `/v2-claim, KMS, worst case (a channel found on the sixth try): ${claim.fetches} subrequests, at most ${SUBREQUEST_BUDGET}`,
        claim.fetches <= SUBREQUEST_BUDGET && claim.leaseTries === 6,
        `${claim.fetches} fetches, ${claim.leaseTries} lease tries, ${claim.polls} polls`,
      );
      check(
        "/v2-claim: 202 with the hash after a poll window the budget closed",
        claim.status === 202 && claim.answer.confirmed === false && claim.polls > 0 && claim.polls < 41,
        `${claim.status} ${JSON.stringify(claim.answer)} after ${claim.polls} polls`,
      );
      check(
        "/v2-claim: the channel lease is KEPT (the claim may still land before its 60 s timebound), never released early",
        claim.leaseReleases === 0,
        `${claim.leaseReleases} releases`,
      );

      const rec = await call("/v2-reclaim", { xdr: reclaimTx().toXDR(), senderPublicKey: sender.publicKey() }, WORST);
      check(
        `/v2-reclaim, KMS, worst case: ${rec.fetches} subrequests, at most ${SUBREQUEST_BUDGET}, and an undecided 202`,
        rec.fetches <= SUBREQUEST_BUDGET && rec.status === 202 && rec.answer.confirmed === false && rec.polls < 41,
        `${rec.fetches} fetches, ${rec.status} after ${rec.polls} polls`,
      );

      const mint = await call("/cctp-relay", { burnTxHash: `0x${"ef".repeat(32)}` }, WORST);
      check(
        `/cctp-relay, KMS, worst case: ${mint.fetches} subrequests, at most ${SUBREQUEST_BUDGET}, answered 202 {status:'minted', confirmed:false}`,
        mint.fetches <= SUBREQUEST_BUDGET && mint.status === 202 && mint.answer.status === "minted" && mint.answer.confirmed === false && mint.leaseReleases === 0,
        `${mint.fetches} fetches, ${mint.status} ${JSON.stringify(mint.answer)}, ${mint.leaseReleases} releases`,
      );

      /* /create-account has no poll, so its worst case is the channel path failing at its KMS Sign
         (both attempts 500) and the sponsor path signing after one retry. */
      const onboard = await call("/create-account", { recipientPublicKey: Keypair.random().publicKey() }, { gpk: [500, 200], sign: [500, 500, 500, 200] });
      check(
        `/create-account, KMS, worst case (the channel path's Sign fails twice, the sponsor path retries once): ${onboard.fetches} subrequests, at most ${SUBREQUEST_BUDGET}`,
        onboard.fetches <= SUBREQUEST_BUDGET && onboard.status === 200 && onboard.answer.via === "sponsor" && onboard.leaseTries === 6,
        `${onboard.fetches} fetches, ${onboard.status} via ${String(onboard.answer.via)}`,
      );

      /* The env signer makes no KMS call, so the same meter leaves its deposit more polls: the bound
         takes from each signer only what its own spend requires. */
      setEnv({ KMS_KEY_ID: undefined, KMS_REGION: undefined, AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, SPONSOR_ACCOUNT_ID: undefined, SPONSOR_SECRET: accountKp.secret() });
      const envDep = await call("/v2-deposit", { xdr: depositTx().toXDR(), senderPublicKey: sender.publicKey() }, { gpk: [], sign: [] });
      check(
        "/v2-deposit with the env signer: also at most the budget, with more polls than under KMS (no KMS fetch to pay for)",
        envDep.fetches <= SUBREQUEST_BUDGET && envDep.status === 202 && envDep.polls > dep.polls,
        `${envDep.fetches} fetches, ${envDep.polls} polls (KMS ${dep.polls})`,
      );
      check("nothing outside the stand-ins was reached", net.seen.every((s) => s.url.includes(".budget.test") || s.url.startsWith("https://kms.")));
    } finally {
      net.restore();
      setRelayPollMsForTests(null);
      resetServiceCache();
      resetHaltCache();
      restoreEnv();
    }
  }

  console.log("\n============================================================");
  console.log(fail === 0 ? ` ✅ KMS SIGNER TESTS PASS (${pass}/${pass})` : ` ❌ ${fail} FAILURES (${pass} passed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("💥", e);
  process.exit(1);
});
