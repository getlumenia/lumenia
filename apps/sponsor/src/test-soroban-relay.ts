/**
 * V2 RELAY GUARD TESTS: what the sponsor will and will not fee-bump on the Soroban escrow
 * (offline; every transaction is built in memory and no handler here ever reaches the network).
 *
 * This guard had no offline coverage at all: everything that imported the relay handlers was
 * network-dependent, so the only proof that /v2-deposit refuses a bad shape was a testnet run.
 * The guard itself is pure XDR parsing up to the caps check, which is exactly the part a group
 * link made load-bearing: `slots` is a multiplier on sponsored onboarding, and the sponsor is the
 * one paying for it.
 *
 * HOW "ACCEPTED" IS MEASURED: the stub signer throws a sentinel the moment it is asked to sign.
 * The fee-bump is the first thing after the guard, so reaching the sentinel means the guard let
 * the transaction through, and nothing is ever submitted.
 *
 * RUN: pnpm --filter @lumenia/sponsor test:soroban-relay
 */
import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  type Transaction,
  type FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import { FEE_BUDGET_REFUSAL, isPublicRefusal } from "./lib/caps.js";
import type { ChannelManager } from "./lib/channels.js";
import { makeConfig, type SponsorConfig } from "./lib/config.js";
import { signerFromSecret, type SponsorSigner } from "./lib/signer.js";
import {
  feeBumpBase,
  groupClaimFailureToken,
  isRelayBusy,
  relayClaimHandler,
  relayDepositHandler,
  relayReclaimHandler,
  simErrorHead,
  SIM_ERROR_HEAD_MAX,
  type RelayDeps,
  type RelayRpc,
} from "./lib/soroban-relay.js";
import { extrasDetail, isSubmitUnconfirmed } from "./lib/stellar.js";
import { resetServiceCache } from "./lib/service.js";
import { subrequestsUsed, withSubrequestMeter } from "./lib/subrequests.js";
import worker from "./worker.js";

let pass = 0,
  fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✔" : "✗"} ${n}${d ? `  (${d})` : ""}`);
  ok ? pass++ : fail++;
};

const USDC_STROOPS = 10_000_000n;
const usdc = (n: number) => BigInt(Math.round(n * Number(USDC_STROOPS)));

const sender = Keypair.random();
const sponsor = Keypair.random();
const issuer = Keypair.random();
const stranger = Keypair.random();

/** The deployed testnet escrow, and one of the superseded ones; new escrow never goes there. */
const CONTRACT = "CAMCI5VPRLQUL6H4QKLZ6X7ASLVCEYBYWS7N3QG7JVOA25HCY2TN3HP3";
const SUPERSEDED = "CDVZN53VEPNE4IFGOUBHOFDYF4N5XJXI5L7LWSN72HPB6ITJCHY4ST6S";

const SENTINEL = "stub-signer: the guard let this through";

/** Never signs. Reaching it is the assertion; it is also why no test here can submit anything. */
const stubSigner: SponsorSigner = {
  publicKey: () => sponsor.publicKey(),
  sign: (_tx: Transaction | FeeBumpTransaction) => {
    throw new Error(SENTINEL);
  },
};

function configFor(network: "testnet" | "mainnet"): SponsorConfig {
  return makeConfig({
    network,
    sponsorSecret: sponsor.secret(),
    usdcIssuer: issuer.publicKey(),
    lumendropContract: CONTRACT,
  });
}

const TESTNET = configFor("testnet");
const MAINNET = configFor("mainnet");

const link = () => xdr.ScVal.scvBytes(Buffer.from(Keypair.random().rawPublicKey()));
const i128 = (stroops: bigint) => nativeToScVal(stroops, { type: "i128" });
const u64 = (n: number) => nativeToScVal(BigInt(n), { type: "u64" });
const expiry = u64(Math.floor(Date.now() / 1000) + 86_400);

/** create_drop(from, link, amount, slots, expiry): args exactly as the contract declares them. */
function createDropArgs(amountStroops: bigint, slots: xdr.ScVal): xdr.ScVal[] {
  return [Address.fromString(sender.publicKey()).toScVal(), link(), i128(amountStroops), slots, expiry];
}

/** deposit(from, link, amount, expiry). */
function depositArgs(amountStroops: bigint): xdr.ScVal[] {
  return [Address.fromString(sender.publicKey()).toScVal(), link(), i128(amountStroops), expiry];
}

/**
 * Build a sender-sourced invoke, in memory, with a fake sequence: nothing is ever submitted. With
 * `resourceFee` the envelope carries Soroban data declaring it, and the builder adds it on top of
 * `fee` (the inclusion fee), exactly as an assembled transaction looks.
 */
function buildInvoke(
  opts: { fn: string; args: xdr.ScVal[]; contract?: string; fee?: string; network?: string; ops?: number; resourceFee?: number },
): Transaction {
  const network = opts.network ?? Networks.TESTNET;
  const b = new TransactionBuilder(new Account(sender.publicKey(), "123456789"), {
    fee: opts.fee ?? "1000000",
    networkPassphrase: network,
    ...(opts.resourceFee !== undefined ? { sorobanData: new SorobanDataBuilder().setResourceFee(opts.resourceFee).build() } : {}),
  });
  for (let i = 0; i < (opts.ops ?? 1); i++) {
    b.addOperation(new Contract(opts.contract ?? CONTRACT).call(opts.fn, ...opts.args));
  }
  return b.setTimeout(180).build();
}

interface GuardVerdict {
  /** The guard let it through (the stub signer was reached). */
  accepted: boolean;
  message: string;
  /** Refusals a caller is entitled to read verbatim, on any network (lib/caps.ts). */
  publicRefusal: boolean;
}

/* ------------------------------ the fake Soroban RPC ------------------------------
 * Every relay simulates before it pays (D3 item a), so even the pure guard tests above need an
 * RPC that answers offline. The plan says what each call answers; the counters say what was asked.
 * Shapes follow the SDK's parsed types (rpc.Api.*): `_parsed: true` keeps `assembleTransaction`
 * from re-parsing, `transactionData` carries the resource fee it adds to the classic fee, and
 * `result.auth` is what it copies onto the invoke op (lib/esm/rpc/transaction.js in the SDK). */
type SimPlan = { error: string } | { minResourceFee: number } | { noResourceFee: true };
/**
 * THROW_UNANSWERED: the send call itself throws the way a dropped connection does (an Error with no
 * HTTP response), so the RPC may have queued the transaction. THROW_REFUSED: it throws the JSON-RPC
 * error object the SDK rethrows for an answered "invalid params" (lib/rpc/jsonrpc.js), so nothing
 * was submitted. THROW_504: an HTTP 504 from a gateway, undecided.
 */
type SendPlan = "PENDING" | "DUPLICATE" | "TRY_AGAIN_LATER" | "ERROR" | "THROW_UNANSWERED" | "THROW_REFUSED" | "THROW_504";
type GetPlan = "SUCCESS" | "FAILED" | "NOT_FOUND" | "THROW";

/** The result an included transaction carries: what its fee source was charged, in stroops. */
function resultCharging(feeCharged: number): xdr.TransactionResult {
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString(String(feeCharged)),
    result: xdr.TransactionResultResult.txSuccess([]),
    ext: new xdr.TransactionResultExt(0),
  });
}

function fakeRpc(
  plan: { sim?: SimPlan; send?: SendPlan; get?: GetPlan[]; failedEvents?: xdr.DiagnosticEvent[]; charged?: number } = {},
) {
  const calls = { simulate: 0, send: 0, get: 0 };
  const factory = (_url: string): RelayRpc => ({
    async getAccount(address: string) {
      return new Account(address, "1");
    },
    async simulateTransaction() {
      calls.simulate++;
      const p = plan.sim ?? { minResourceFee: 500_000 };
      if ("error" in p) {
        return { _parsed: true, latestLedger: 1, events: [], error: p.error } as unknown as rpc.Api.SimulateTransactionResponse;
      }
      if ("noResourceFee" in p) {
        // A success that names no resource fee (an RPC or SDK parse change): the bound must refuse.
        return {
          _parsed: true,
          latestLedger: 1,
          events: [],
          transactionData: new SorobanDataBuilder().setResourceFee(0),
          result: { auth: [], retval: xdr.ScVal.scvVoid() },
        } as unknown as rpc.Api.SimulateTransactionResponse;
      }
      return {
        _parsed: true,
        latestLedger: 1,
        events: [],
        minResourceFee: String(p.minResourceFee),
        transactionData: new SorobanDataBuilder().setResourceFee(p.minResourceFee),
        result: { auth: [], retval: xdr.ScVal.scvVoid() },
      } as unknown as rpc.Api.SimulateTransactionResponse;
    },
    async sendTransaction(tx: Transaction | FeeBumpTransaction) {
      calls.send++;
      const status = plan.send ?? "PENDING";
      if (status === "THROW_UNANSWERED") throw new TypeError("fetch failed: socket hang up");
      if (status === "THROW_REFUSED") throw { code: -32602, message: "invalid params: cannot unmarshal transaction" };
      if (status === "THROW_504") throw Object.assign(new Error("Request failed with status code 504"), { response: { status: 504 } });
      return {
        status,
        hash: tx.hash().toString("hex"),
        latestLedger: 1,
        latestLedgerCloseTime: 0,
        ...(status === "ERROR" ? { errorResult: { code: "txBadSeq" } } : {}),
      } as unknown as rpc.Api.SendTransactionResponse;
    },
    async getTransaction(hash: string) {
      const i = calls.get++;
      const seq = plan.get ?? ["SUCCESS"];
      const st = seq[Math.min(i, seq.length - 1)]!;
      if (st === "THROW") throw new Error("the rpc went away");
      return {
        status: rpc.Api.GetTransactionStatus[st],
        txHash: hash,
        latestLedger: 1,
        latestLedgerCloseTime: 0,
        oldestLedger: 1,
        oldestLedgerCloseTime: 0,
        ...(st === "FAILED" && plan.failedEvents ? { diagnosticEventsXdr: plan.failedEvents } : {}),
        // An included transaction (SUCCESS or FAILED) carries its result, and with it its fee.
        ...((st === "SUCCESS" || st === "FAILED") && plan.charged !== undefined ? { resultXdr: resultCharging(plan.charged) } : {}),
      } as unknown as rpc.Api.GetTransactionResponse;
    },
  });
  return { factory, calls };
}

/** Deps for a test: the fake RPC, and a confirm wait of two instant polls instead of sixty seconds. */
function depsFor(plan: Parameters<typeof fakeRpc>[0] = {}): { deps: RelayDeps; calls: { simulate: number; send: number; get: number } } {
  const { factory, calls } = fakeRpc(plan);
  return { deps: { rpc: factory, pollMs: 1, maxPolls: 2 }, calls };
}

/**
 * An in-memory stand-in for the Upstash pipeline the caps module talks to (the same shape as in
 * test-caps.ts), plus a log of every INCRBY so a test can count how many times the day's budget
 * was RELEASED (a negative delta on the `:day:` key) and how many times the fee budget was charged
 * (a positive delta on the `:fees:` key).
 */
function installFakeKv() {
  const store = new Map<string, bigint>();
  const log: Array<{ key: string; delta: bigint }> = [];
  process.env.KV_REST_API_URL = "https://fake-kv.test";
  process.env.KV_REST_API_TOKEN = "t";
  globalThis.fetch = (async (url: string | URL, init?: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/pipeline")) {
      const cmds = JSON.parse(String(init?.body ?? "[]")) as string[][];
      const results = cmds.map(([op, key, arg]) => {
        if (op === "EXPIRE") return { result: 1 };
        if (op !== "INCRBY") throw new Error(`unexpected command ${op}`);
        const delta = BigInt(arg!);
        const next = (store.get(key!) ?? 0n) + delta;
        store.set(key!, next);
        log.push({ key: key!, delta });
        return { result: next.toString() };
      });
      return { ok: true, status: 200, json: async () => results } as unknown as Response;
    }
    const got = u.match(/\/get\/(.+)$/);
    if (got) {
      const v = store.get(decodeURIComponent(got[1]!));
      return { ok: true, status: 200, json: async () => ({ result: v === undefined ? null : v.toString() }) } as unknown as Response;
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  // The day key alone: with a sender the caps module also moves `...:day:<d>:sender:<G>` in the
  // same pipeline, which is the per-sender cap doing its job, not a second release of the day. The
  // fee charge moves `...:fees:<d>:gross` beside the net key the same way; it is counted apart.
  const count = (part: string, sign: 1 | -1) =>
    log.filter((l) => l.key.includes(part) && !l.key.includes(":sender:") && !l.key.endsWith(":gross") && (sign > 0 ? l.delta > 0n : l.delta < 0n)).length;
  return {
    store,
    log,
    reset: () => {
      store.clear();
      log.length = 0;
    },
    dayReleases: () => count(":day:", -1),
    dayReserves: () => count(":day:", 1),
    feeCharges: () => count(":fees:", 1),
    feeRefunds: () => count(":fees:", -1),
    /** What the day's fee counter reads now, in stroops. */
    feeTotal: () => [...store].filter(([k]) => k.includes(":fees:") && !k.endsWith(":gross")).reduce((a, [, v]) => a + v, 0n),
    /** The gross key: every bid the budget accepted, never lowered by a give-back. */
    feeGross: () => [...store].filter(([k]) => k.endsWith(":fees:" + new Date().toISOString().slice(0, 10) + ":gross")).reduce((a, [, v]) => a + v, 0n),
    /** Pre-spend the fee budget (as if the day's traffic had already used it). */
    spendFees: (stroops: bigint) => {
      const day = new Date().toISOString().slice(0, 10);
      store.set(`caps:testnet:fees:${day}`, stroops);
    },
  };
}

/**
 * The real sponsor signer behind a recorder: how many times it was asked to sign, and the fee of
 * each envelope it signed. The ORDER tests use it with a pre-spent fee budget, where the right
 * answer is a refusal with zero signatures.
 */
function recordingSigner() {
  const fees: string[] = [];
  const signer: SponsorSigner = {
    publicKey: () => sponsor.publicKey(),
    sign: (tx: Transaction | FeeBumpTransaction) => {
      fees.push(tx.fee);
      return realSigner.sign(tx);
    },
  };
  return { signer, fees };
}

/** A one-channel pool stand-in that counts its releases (the relays only call `enabled` and `lease`). */
function oneChannel() {
  const channel = Keypair.random();
  const state = { leased: 0, released: 0 };
  const manager = {
    enabled: true,
    async lease() {
      state.leased++;
      return { keypair: channel, publicKey: channel.publicKey(), release: async () => void state.released++ };
    },
  } as unknown as ChannelManager;
  return { manager, state };
}
function clearKv() {
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
}

/** The sponsor that really signs, for the branches past the guard (nothing is submitted: the RPC is the fake). */
const realSigner = signerFromSecret(sponsor.secret());

async function relayDeposit(
  config: SponsorConfig,
  tx: Transaction,
  senderPublicKey = sender.publicKey(),
  deps: RelayDeps = depsFor().deps,
  signer: SponsorSigner = stubSigner,
): Promise<GuardVerdict> {
  try {
    await relayDepositHandler(config, signer, { xdr: tx.toXDR(), senderPublicKey }, deps);
    return { accepted: false, message: "the handler returned without signing anything", publicRefusal: false };
  } catch (e) {
    const message = (e as Error).message;
    return { accepted: message === SENTINEL, message, publicRefusal: isPublicRefusal(e) };
  }
}

/** What a relay call ended in: a return value, or the error it threw, with the brands read. */
interface Outcome {
  returned?: { hash: string; confirmed: boolean };
  message: string;
  publicRefusal: boolean;
  unconfirmed: boolean;
  busy: boolean;
  hash?: string;
}
async function outcomeOf(run: () => Promise<{ hash: string; confirmed: boolean }>): Promise<Outcome> {
  try {
    const returned = await run();
    return { returned, message: "", publicRefusal: false, unconfirmed: false, busy: false, hash: returned.hash };
  } catch (e) {
    return {
      message: (e as Error).message,
      publicRefusal: isPublicRefusal(e),
      unconfirmed: isSubmitUnconfirmed(e),
      busy: isRelayBusy(e),
      hash: (e as { hash?: string }).hash,
    };
  }
}

/** reclaim(sender, link): a sender-sourced reclaim invoke, in memory. */
function buildReclaim(opts: { fee?: string; fn?: string; contract?: string } = {}): Transaction {
  return buildInvoke({
    fn: opts.fn ?? "reclaim",
    args: [Address.fromString(sender.publicKey()).toScVal(), link()],
    fee: opts.fee ?? "1000000",
    contract: opts.contract,
  });
}

const claimInput = () => ({
  method: "claim",
  linkHex: Buffer.from(Keypair.random().rawPublicKey()).toString("hex"),
  payout: stranger.publicKey(),
  sigHex: "cd".repeat(64),
});

/** A diagnostic event shaped like the one the host records when a call reverts. */
function errorEvent(err: xdr.ScError): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: null,
      type: xdr.ContractEventType.diagnostic(),
      body: new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({
          topics: [xdr.ScVal.scvSymbol("error"), xdr.ScVal.scvError(err)],
          data: xdr.ScVal.scvString("escalating error to VM trap from failed host function call"),
        }),
      ),
    }),
  });
}

async function main() {
  console.log("============================================================");
  console.log(" V2 RELAY GUARD TESTS (offline)");
  console.log("============================================================\n");

  // Deterministic caps, and no counter store: checkCaps then enforces the per-drop bounds alone,
  // locally, which is the half this suite is about.
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.CAPS_FAIL_CLOSED;
  process.env.MIN_DROP_USDC = "0.01";
  process.env.MAX_DROP_USDC = "100";
  process.env.MAX_POOL_SLOTS = "30";

  console.log("[1] shape: one invoke, the sender's own, on the current contract");
  check(
    "create_drop with its 5 args is relayed",
    (await relayDeposit(TESTNET, buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(30), xdr.ScVal.scvU32(3)) }))).accepted,
  );
  const shortDrop = await relayDeposit(
    TESTNET,
    buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(30), xdr.ScVal.scvU32(3)).slice(0, 4) }),
  );
  check("create_drop with 4 args is refused", !shortDrop.accepted, shortDrop.message);
  check("deposit with its 4 args is relayed", (await relayDeposit(TESTNET, buildInvoke({ fn: "deposit", args: depositArgs(usdc(5)) }))).accepted);
  const longDeposit = await relayDeposit(
    TESTNET,
    buildInvoke({ fn: "deposit", args: [...depositArgs(usdc(5)), xdr.ScVal.scvU32(3)] }),
  );
  check("deposit with a 5th arg is refused", !longDeposit.accepted, longDeposit.message);
  const wrongContract = await relayDeposit(
    TESTNET,
    buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(30), xdr.ScVal.scvU32(3)), contract: SUPERSEDED }),
  );
  check("a superseded contract is refused, and new escrow only ever goes to the current one", !wrongContract.accepted, wrongContract.message);
  const wrongMethod = await relayDeposit(TESTNET, buildInvoke({ fn: "claim_share", args: depositArgs(usdc(5)) }));
  check("a method outside the deposit allowlist is refused", !wrongMethod.accepted, wrongMethod.message);
  const richFee = await relayDeposit(
    TESTNET,
    buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(30), xdr.ScVal.scvU32(3)), fee: "20000001" }),
  );
  check("an inner fee one stroop over the 2 XLM cap is refused", !richFee.accepted, richFee.message);
  const twoOps = await relayDeposit(
    TESTNET,
    buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(30), xdr.ScVal.scvU32(3)), ops: 2 }),
  );
  check("a two-op inner is refused", !twoOps.accepted, twoOps.message);
  const notMine = await relayDeposit(
    TESTNET,
    buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(30), xdr.ScVal.scvU32(3)) }),
    stranger.publicKey(),
  );
  check("an inner sourced by someone other than the named sender is refused", !notMine.accepted, notMine.message);

  /* The pot and the slot count sit next to each other in the argument list, and reading the wrong
     one would cap a $200 pool as if it were 4 dollars. */
  console.log("[2] the capped amount is args[2], never the slot count at args[3]");
  const overCap = await relayDeposit(
    TESTNET,
    buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(200), xdr.ScVal.scvU32(4)) }),
  );
  check("a 200 USDC pool of 4 shares is refused by the per-drop cap", !overCap.accepted, overCap.message);
  check("and the refusal names 200, not the 4 slots", /200 USDC exceeds/.test(overCap.message), overCap.message);
  check("the cap refusal keeps its text on any network", overCap.publicRefusal);

  console.log("[3] slots: the multiplier on sponsored onboarding, bounded here and nowhere else");
  const noSlots = await relayDeposit(TESTNET, buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(30), xdr.ScVal.scvU32(0)) }));
  check("0 shares is refused", !noSlots.accepted, noSlots.message);
  check("1 share is refused, because that is a one-to-one link, not a group", !(await relayDeposit(TESTNET, buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(30), xdr.ScVal.scvU32(1)) }))).accepted);
  check("2 shares, the smallest real group, is relayed", (await relayDeposit(TESTNET, buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(30), xdr.ScVal.scvU32(2)) }))).accepted);
  check("30 shares, exactly at MAX_POOL_SLOTS, is relayed", (await relayDeposit(TESTNET, buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(30), xdr.ScVal.scvU32(30)) }))).accepted);
  const tooMany = await relayDeposit(TESTNET, buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(60), xdr.ScVal.scvU32(31)) }));
  check("31 is refused, and the refusal names the bound", !tooMany.accepted && /between 2 and 30 shares/.test(tooMany.message), tooMany.message);
  check("the bound follows MAX_POOL_SLOTS", await (async () => {
    process.env.MAX_POOL_SLOTS = "6";
    const past = await relayDeposit(TESTNET, buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(30), xdr.ScVal.scvU32(7)) }));
    process.env.MAX_POOL_SLOTS = "30";
    return !past.accepted && /between 2 and 6 shares/.test(past.message);
  })());
  check("a malformed MAX_POOL_SLOTS falls back to 30, never to unbounded", await (async () => {
    process.env.MAX_POOL_SLOTS = "nonsense";
    const past = await relayDeposit(TESTNET, buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(60), xdr.ScVal.scvU32(31)) }));
    process.env.MAX_POOL_SLOTS = "30";
    return !past.accepted && /between 2 and 30 shares/.test(past.message);
  })());
  /* A slot count sent as some other ScVal comes back as a bigint or a string, and every comparison
     against a number is then false or NaN: the bound would be written here and would not be one. */
  const wrongType = await relayDeposit(TESTNET, buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(30), u64(3)) }));
  check("a slot count that is not a u32 is REFUSED, not compared as NaN", !wrongType.accepted, wrongType.message);
  check("and the refusal says so plainly", /whole number/.test(wrongType.message), wrongType.message);

  /* The sponsor's cost per share is a fixed reserve lock that has nothing to do with the amount,
     so the floor has to be applied where the shares are, not only to the pot. */
  console.log("[4] the minimum is PER SHARE: a one-cent pot of 30 shares is 30 sponsored accounts");
  const dustPool = await relayDeposit(TESTNET, buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(0.01), xdr.ScVal.scvU32(30)) }));
  check("0.01 USDC across 30 shares is refused", !dustPool.accepted, dustPool.message);
  check("the refusal names the minimum we will sponsor", /minimum we will sponsor \(0\.01 USDC\)/.test(dustPool.message), dustPool.message);
  check("the per-share refusal keeps its text on any network", dustPool.publicRefusal);
  check(
    "the SAME 0.01 USDC as a one-to-one deposit is still relayed, because the floor is per share, not per link",
    (await relayDeposit(TESTNET, buildInvoke({ fn: "deposit", args: depositArgs(usdc(0.01)) }))).accepted,
  );
  check(
    "0.30 USDC across 30 shares (a cent each) is relayed",
    (await relayDeposit(TESTNET, buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(0.3), xdr.ScVal.scvU32(30)) }))).accepted,
  );

  /* Mainnet is OPEN for group links since 2026-09-20, and what keeps that safe is the ceiling
     rather than a refusal. The important property is the direction of failure: [env.mainnet.vars]
     redeclares the variable block instead of inheriting it, so a MAX_POOL_SLOTS left out there is
     undefined, and undefined must mean SIX, never the testnet thirty. */
  console.log("[5] mainnet: group links are open, and bounded tightly");
  const mainnetPool = await relayDeposit(
    MAINNET,
    buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(3), xdr.ScVal.scvU32(6)), network: Networks.PUBLIC }),
  );
  check("a 6-seat $0.50-a-share pool is relayed on mainnet", mainnetPool.accepted, mainnetPool.message);
  check(
    "a 2-seat $2.50-a-share pool is relayed too: $5 is the pot cap, and the pot is what the cap binds",
    (await relayDeposit(MAINNET, buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(5), xdr.ScVal.scvU32(2)), network: Networks.PUBLIC }))).accepted,
  );
  /* With the deployed mainnet configuration (MAX_POOL_SLOTS = "6" in [env.mainnet.vars]) the
     seventh seat is the first one refused. The surrounding file leaves the variable at "30", which
     mainnet clamps to its own ceiling of 8, so this check sets what the Worker actually carries. */
  const mainnetSeven = await (async () => {
    const saved = process.env.MAX_POOL_SLOTS;
    process.env.MAX_POOL_SLOTS = "6";
    const r = await relayDeposit(
      MAINNET,
      buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(3.5), xdr.ScVal.scvU32(7)), network: Networks.PUBLIC }),
    );
    if (saved !== undefined) process.env.MAX_POOL_SLOTS = saved;
    return r;
  })();
  check("7 seats is refused under the deployed mainnet configuration", !mainnetSeven.accepted && /between 2 and 6 shares/.test(mainnetSeven.message), mainnetSeven.message);
  check("and the sender can read why", mainnetSeven.publicRefusal);
  check("an ABSENT MAX_POOL_SLOTS means 6 on mainnet, not the testnet 30", await (async () => {
    const saved = process.env.MAX_POOL_SLOTS;
    delete process.env.MAX_POOL_SLOTS;
    const past = await relayDeposit(MAINNET, buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(3.5), xdr.ScVal.scvU32(7)), network: Networks.PUBLIC }));
    if (saved !== undefined) process.env.MAX_POOL_SLOTS = saved;
    return !past.accepted && /between 2 and 6 shares/.test(past.message);
  })());
  check("and configuration can only lower the mainnet ceiling, never raise it past 8", await (async () => {
    const saved = process.env.MAX_POOL_SLOTS;
    process.env.MAX_POOL_SLOTS = "30";
    const past = await relayDeposit(MAINNET, buildInvoke({ fn: "create_drop", args: createDropArgs(usdc(4.5), xdr.ScVal.scvU32(9)), network: Networks.PUBLIC }));
    if (saved !== undefined) process.env.MAX_POOL_SLOTS = saved;
    return !past.accepted && /between 2 and 8 shares/.test(past.message);
  })());
  check(
    "a one-to-one deposit on mainnet is untouched by any of this",
    (await relayDeposit(MAINNET, buildInvoke({ fn: "deposit", args: depositArgs(usdc(1)), network: Networks.PUBLIC }))).accepted,
  );
  /* The claim half opens with the pool: what it must NOT do is refuse for the old reason. The link
     is deliberately a byte short, so it fails the local length check BEFORE any RPC call: this
     suite is part of the offline gate and must never reach the network. Reaching that message at
     all is the proof that no group gate fired above it. */
  const mainnetShare = await relayClaimHandler(MAINNET, stubSigner, {
    method: "claim_share",
    linkHex: "ab".repeat(31),
    payout: stranger.publicKey(),
    sigHex: "cd".repeat(64),
  }).then(
    () => ({ refused: false, message: "the claim relay returned", publicRefusal: false }),
    (e: Error) => ({ refused: true, message: e.message, publicRefusal: isPublicRefusal(e) }),
  );
  check(
    "claim_share on mainnet is no longer turned away for being a group claim",
    !/not available on this network/.test(mainnetShare.message) && /link must be 32 bytes/.test(mainnetShare.message),
    mainnetShare.message,
  );

  /* A short link key is rejected two lines below the group gate, so a single claim reaching THAT
     message is proof the gate did not fire for the one-to-one path the live product runs on. */
  const mainnetSingle = await relayClaimHandler(MAINNET, stubSigner, {
    method: "claim",
    linkHex: "ab".repeat(31),
    payout: stranger.publicKey(),
    sigHex: "cd".repeat(64),
  }).catch((e: Error) => e.message);
  check("a one-to-one claim on mainnet passes the gate untouched", /link must be 32 bytes/.test(String(mainnetSingle)), String(mainnetSingle));

  /* Every revert used to arrive as the literal string "v2-claim tx FAILED", which the claim screen
     filed as unknown and offered a retry for, and each retry opens another sponsored account to
     ask a question whose answer cannot change. */
  console.log("[6] naming why a group claim reverted, from the diagnostic events");
  check("DropEmpty (7) reads as drop-empty", groupClaimFailureToken([errorEvent(xdr.ScError.sceContract(7))]) === "drop-empty");
  check("AlreadyClaimedThis (8) reads as already-claimed-this", groupClaimFailureToken([errorEvent(xdr.ScError.sceContract(8))]) === "already-claimed-this");
  check("Expired (9) reads as expired", groupClaimFailureToken([errorEvent(xdr.ScError.sceContract(9))]) === "expired");
  check(
    "a failed link signature reads as bad-link-key, because ed25519_verify traps with no contract code",
    groupClaimFailureToken([errorEvent(xdr.ScError.sceCrypto(xdr.ScErrorCode.scecInvalidInput()))]) === "bad-link-key",
  );
  check("a code we have no word for reads as unknown", groupClaimFailureToken([errorEvent(xdr.ScError.sceContract(11))]) === "unknown");
  check("no diagnostic events at all reads as unknown, never as success", groupClaimFailureToken(undefined) === "unknown" && groupClaimFailureToken([]) === "unknown");
  check(
    "the reason survives base64 XDR, which is how it actually arrives",
    groupClaimFailureToken([xdr.DiagnosticEvent.fromXDR(errorEvent(xdr.ScError.sceContract(8)).toXDR("base64"), "base64")]) === "already-claimed-this",
  );

  /* ------------------------------------------------------------------------------------------
   * SOW 2, D3. Everything below drives the relays PAST the guard with the fake RPC and a fake
   * store, so the parts that used to be provable only on testnet (the fee bound after
   * simulation, the single-shot cap accounting, the 202 on an undecided submit, the fee budget)
   * are locked offline, in CI.
   * ------------------------------------------------------------------------------------------ */
  const kv = installFakeKv();
  const deposit = (fee: string) => buildInvoke({ fn: "deposit", args: depositArgs(usdc(5)), fee });

  console.log("[7] /v2-deposit simulates before it pays: the fee is bounded by what the invoke needs (item a)");
  {
    kv.reset();
    const exact = await relayDeposit(TESTNET, deposit("3000000"), undefined, depsFor({ sim: { minResourceFee: 500_000 } }).deps);
    check("a deposit whose fee is exactly the simulated resource fee + 0.25 XLM headroom is relayed", exact.accepted, exact.message);
    const over = await relayDeposit(TESTNET, deposit("3000001"), undefined, depsFor({ sim: { minResourceFee: 500_000 } }).deps);
    check("one stroop over that is refused", !over.accepted && /exceeds what the deposit needs \(3000000\)/.test(over.message), over.message);
    check("and the refusal is NOT a public one on mainnet (it is redacted to a reference)", !over.publicRefusal);
    kv.reset();
    const sim = depsFor({ sim: { error: "HostError: Error(Contract, #3)" } });
    const broken = await relayDeposit(TESTNET, deposit("1000000"), undefined, sim.deps);
    check("a deposit the contract would reject is refused by the simulation", !broken.accepted && /would fail/.test(broken.message), broken.message);
    check("before anything was signed (the signer was never reached)", broken.message !== SENTINEL);
    check("and before the day's budget was touched (no INCRBY at all)", kv.log.length === 0, `${kv.log.length} store writes`);
    check("the simulation ran exactly once and nothing was sent", sim.calls.simulate === 1 && sim.calls.send === 0);
    const still = await relayDeposit(
      TESTNET,
      buildInvoke({ fn: "deposit", args: depositArgs(usdc(5)), fee: "20000001" }),
      undefined,
      depsFor({ sim: { minResourceFee: 19_000_000 } }).deps,
    );
    check("the absolute 2 XLM cap is still the outer bound, whatever the simulation says", !still.accepted && /exceeds cap 20000000/.test(still.message), still.message);
  }

  console.log("[8] single-shot cap accounting: the day's budget goes back at most once, never once the tx is on the network (item c)");
  const dep = (plan: Parameters<typeof fakeRpc>[0]) => {
    kv.reset();
    const d = depsFor(plan);
    return outcomeOf(() => relayDepositHandler(TESTNET, realSigner, { xdr: deposit("1000000").toXDR(), senderPublicKey: sender.publicKey() }, d.deps)).then((o) => ({ o, calls: d.calls }));
  };
  {
    const { o } = await dep({ send: "ERROR" });
    check("send ERROR: the handler throws 'send failed'", /send failed/.test(o.message), o.message);
    check("send ERROR: the day's budget is released exactly once", kv.dayReleases() === 1 && kv.dayReserves() === 1, `${kv.dayReserves()} reserved, ${kv.dayReleases()} released`);
    check(
      "send ERROR: the fee bid comes back whole (core refused it while validating; it 'will not be included in the ledger')",
      kv.feeCharges() === 1 && kv.feeRefunds() === 1 && kv.feeTotal() === 0n,
      `${kv.feeCharges()} charged, ${kv.feeRefunds()} refunded, ${kv.feeTotal()} left`,
    );
    check(
      "send ERROR: the GROSS key still shows the 2,000,000-stroop bid reached the signature (a give-back never hides that)",
      kv.feeGross() === 2_000_000n,
      String(kv.feeGross()),
    );
  }
  {
    const { o } = await dep({ send: "THROW_UNANSWERED" });
    check("send THROWS unanswered (a reset after the RPC may have queued it): an unconfirmed submit with the hash, never a failure", o.unconfirmed && /^[0-9a-f]{64}$/.test(o.hash ?? ""), o.message);
    check("send THROWS unanswered: the day's budget is NOT released (the deposit may still land)", kv.dayReleases() === 0 && kv.dayReserves() === 1);
    check("send THROWS unanswered: the fee bid stays whole (undecided)", kv.feeCharges() === 1 && kv.feeRefunds() === 0);
  }
  {
    const { o } = await dep({ send: "THROW_504" });
    check("send answered by a gateway 504: undecided too, an unconfirmed submit", o.unconfirmed && !!o.hash, o.message);
    check("send 504: nothing released", kv.dayReleases() === 0 && kv.feeRefunds() === 0);
  }
  {
    const { o } = await dep({ send: "THROW_REFUSED" });
    check("send REFUSED by the RPC (JSON-RPC invalid params): a plain refusal, nothing was submitted", !o.unconfirmed && /send refused/.test(o.message), o.message);
    check("send REFUSED: the day's budget is released once and the fee bid comes back", kv.dayReleases() === 1 && kv.feeRefunds() === 1 && kv.feeTotal() === 0n);
  }
  {
    const { o } = await dep({ send: "PENDING", get: ["NOT_FOUND", "FAILED"], charged: 31_000 });
    check("on-ledger FAILED: the handler throws", /tx FAILED/.test(o.message), o.message);
    check("on-ledger FAILED: the day's budget is released exactly once (it used to be twice)", kv.dayReleases() === 1, `${kv.dayReleases()} released`);
    check("on-ledger FAILED: the fee is NOT given back whole, it is trued down to what the ledger charged", kv.feeTotal() === 31_000n, `${kv.feeTotal()} counted`);
  }
  {
    const { o, calls } = await dep({ send: "PENDING", get: ["NOT_FOUND", "NOT_FOUND", "NOT_FOUND"] });
    check("NOT_FOUND after the window: the handler RETURNS {confirmed:false} with the hash", !!o.returned && o.returned.confirmed === false && /^[0-9a-f]{64}$/.test(o.returned.hash), o.message);
    check("NOT_FOUND after the window: the budget is NOT released (the deposit may still land)", kv.dayReleases() === 0);
    check("NOT_FOUND after the window: the whole fee bid stays counted", kv.feeRefunds() === 0 && kv.feeTotal() === 2_000_000n, `${kv.feeTotal()}`);
    check("the confirm wait honoured the injected window (1 + maxPolls reads)", calls.get === 3, `${calls.get} reads`);
  }
  {
    const { o } = await dep({ send: "PENDING", get: ["NOT_FOUND", "THROW"] });
    check("an RPC that dies mid-poll AFTER the send was accepted raises an unconfirmed submit, not a failure", o.unconfirmed && !!o.hash, o.message);
    check("mid-poll death: the budget is NOT released, and the fee bid stays whole", kv.dayReleases() === 0 && kv.feeRefunds() === 0);
  }
  {
    const { o } = await dep({ send: "TRY_AGAIN_LATER" });
    check("TRY_AGAIN_LATER: the RPC declined to queue it, so the handler raises 'busy' (the worker answers 503)", o.busy && /busy; try again shortly/.test(o.message), o.message);
    check("TRY_AGAIN_LATER: the day's budget is released once and the fee bid comes back (nothing is on the network)", kv.dayReleases() === 1 && kv.feeTotal() === 0n);
  }
  {
    const { o } = await dep({ send: "DUPLICATE", get: ["SUCCESS"] });
    check("DUPLICATE: the tx IS on the network; it is watched like PENDING and confirms", !!o.returned && o.returned.confirmed === true, o.message);
    check("DUPLICATE: the budget is never released", kv.dayReleases() === 0);
  }
  {
    const { o } = await dep({ send: "PENDING", get: ["SUCCESS"], charged: 20_721 });
    check("SUCCESS returns {confirmed:true} and keeps the reservation", !!o.returned && o.returned.confirmed === true && kv.dayReleases() === 0, o.message);
    check(
      "SUCCESS: the day's fee count drops from the 2,000,000-stroop bid to the 20,721 the ledger charged",
      kv.feeTotal() === 20_721n && kv.feeRefunds() === 1,
      `${kv.feeTotal()} counted`,
    );
  }
  {
    const { o } = await dep({ send: "PENDING", get: ["SUCCESS"] });
    check("SUCCESS with no readable result: the whole bid stays counted (never guess low)", !!o.returned && kv.feeTotal() === 2_000_000n && kv.feeRefunds() === 0, `${kv.feeTotal()}`);
  }

  console.log("[9] the sponsor fee budget is charged before the signature and refuses past the day (item b)");
  {
    kv.reset();
    process.env.MAX_DAY_FEE_XLM = "0.1"; // a deposit of inner fee 0.1 XLM bids 0.2 XLM as a fee-bump
    const refused = await relayDeposit(TESTNET, deposit("1000000"), undefined, depsFor().deps);
    check("a bid past MAX_DAY_FEE_XLM is refused with the public sentence", !refused.accepted && refused.message === FEE_BUDGET_REFUSAL, refused.message);
    check("the refusal keeps its text on every network", refused.publicRefusal);
    check("nothing was signed (the signer was never reached)", refused.message !== SENTINEL);
    check("the refused fee increment was undone and the day's escrow budget released", kv.feeCharges() === 1 && kv.feeRefunds() === 1 && kv.dayReleases() === 1, kv.log.filter((l) => !l.key.includes(":sender:")).map((l) => `${l.key.split(":").slice(2, 3).join("")}${l.delta > 0n ? "+" : "-"}`).join(" "));
    delete process.env.MAX_DAY_FEE_XLM;
    kv.reset();
    const fine = await relayDeposit(TESTNET, deposit("1000000"), undefined, depsFor().deps);
    check("under the budget the bid is charged once and the deposit reaches the signer", fine.accepted && kv.feeCharges() === 1, fine.message);
    check(
      "a signer that THROWS signed nothing, so the bid comes back (a KMS outage must not spend the day on retries)",
      kv.feeRefunds() === 1 && kv.feeTotal() === 0n,
      `${kv.feeRefunds()} refunded, ${kv.feeTotal()} left`,
    );
  }

  console.log("[10] /v2-claim: the assembled fee is bounded, and an undecided submit is reported as one (items a, g)");
  {
    kv.reset();
    const rich = await outcomeOf(() => relayClaimHandler(TESTNET, realSigner, claimInput(), undefined, depsFor({ sim: { minResourceFee: 19_500_000 } }).deps));
    check("a claim whose assembled fee lands over 2 XLM is refused", /exceeds cap 20000000/.test(rich.message), rich.message);
    check("and nothing was charged or sent", kv.feeCharges() === 0);
    kv.reset();
    const ok = await outcomeOf(() => relayClaimHandler(TESTNET, realSigner, claimInput(), undefined, depsFor({ get: ["SUCCESS"] }).deps));
    check("a claim that lands returns {confirmed:true}", !!ok.returned && ok.returned.confirmed === true, ok.message);
    check("and its fee bid was charged once", kv.feeCharges() === 1);
    {
      // ORDER: with the day's fee budget already spent, the charge refuses BEFORE the sponsor's key
      // is asked for anything. A refactor that signs first would show a signature here.
      kv.reset();
      kv.spendFees(20_000_000_000n); // the whole 2,000 XLM testnet day
      const rec = recordingSigner();
      const spent = await outcomeOf(() => relayClaimHandler(TESTNET, rec.signer, claimInput(), undefined, depsFor({ get: ["SUCCESS"] }).deps));
      check("ORDER: a spent fee budget refuses the claim with the public sentence", spent.message === FEE_BUDGET_REFUSAL && spent.publicRefusal, spent.message);
      check("ORDER: and the sponsor's key signed NOTHING (charge before signature)", rec.fees.length === 0, `${rec.fees.length} signatures`);
    }
    {
      // The channel path: the fee-bump bids base x 2 + resource fee at the smallest valid base,
      // the inner's own inclusion fee (1,000,000), never the inner's total fee.
      kv.reset();
      const rec = recordingSigner();
      const pool = oneChannel();
      const viaChannel = await outcomeOf(() =>
        relayClaimHandler(TESTNET, rec.signer, claimInput(), pool.manager, depsFor({ sim: { minResourceFee: 500_000 }, get: ["SUCCESS"] }).deps),
      );
      check("a channel-sourced claim lands and frees its lease", !!viaChannel.returned && pool.state.released === 1, viaChannel.message);
      check(
        "its fee-bump bids 2 x 1,000,000 + 500,000 = 2,500,000 (was 2 x 1,500,000 + 500,000)",
        rec.fees[0] === "2500000",
        rec.fees.join(","),
      );
    }
    {
      kv.reset();
      const pool = oneChannel();
      const unanswered = await outcomeOf(() =>
        relayClaimHandler(TESTNET, realSigner, claimInput(), pool.manager, depsFor({ send: "THROW_UNANSWERED" }).deps),
      );
      check("a claim whose send went unanswered is an unconfirmed submit carrying the hash", unanswered.unconfirmed && !!unanswered.hash, unanswered.message);
      check(
        "and its channel lease is KEPT (left to lapse), because the claim may still land on that sequence",
        pool.state.leased === 1 && pool.state.released === 0,
        `${pool.state.released} released`,
      );
      const poolB = oneChannel();
      await outcomeOf(() => relayClaimHandler(TESTNET, realSigner, claimInput(), poolB.manager, depsFor({ get: ["NOT_FOUND", "THROW"] }).deps));
      check("the same for an RPC that died mid-poll: the lease is kept", poolB.state.released === 0);
      const poolC = oneChannel();
      await outcomeOf(() => relayClaimHandler(TESTNET, realSigner, claimInput(), poolC.manager, depsFor({ send: "ERROR" }).deps));
      check("a DECIDED refusal (send ERROR) frees the lease at once", poolC.state.released === 1);
    }
    const late = await outcomeOf(() => relayClaimHandler(TESTNET, realSigner, claimInput(), undefined, depsFor({ get: ["NOT_FOUND", "NOT_FOUND", "NOT_FOUND"] }).deps));
    check("NOT_FOUND after the window RETURNS {confirmed:false} instead of throwing 'v2-claim tx NOT_FOUND'", !!late.returned && late.returned.confirmed === false, late.message);
    const gone = await outcomeOf(() => relayClaimHandler(TESTNET, realSigner, claimInput(), undefined, depsFor({ get: ["NOT_FOUND", "THROW"] }).deps));
    check("an RPC that dies mid-poll raises an unconfirmed submit carrying the hash", gone.unconfirmed && !!gone.hash, gone.message);
    const busy = await outcomeOf(() => relayClaimHandler(TESTNET, realSigner, claimInput(), undefined, depsFor({ send: "TRY_AGAIN_LATER" }).deps));
    check("TRY_AGAIN_LATER raises 'busy'", busy.busy, busy.message);
    const refusedSim = await outcomeOf(() => relayClaimHandler(TESTNET, realSigner, claimInput(), undefined, depsFor({ sim: { error: "bad signature" } }).deps));
    check("a claim whose simulation fails (a bad link signature) is refused before any fee", /simulation failed/.test(refusedSim.message), refusedSim.message);
    const share = await outcomeOf(() =>
      relayClaimHandler(TESTNET, realSigner, { ...claimInput(), method: "claim_share" }, undefined, depsFor({ get: ["FAILED"], failedEvents: [errorEvent(xdr.ScError.sceContract(7))] }).deps),
    );
    check("a group claim the ledger refused still comes back as its named public token", share.publicRefusal && /group-claim-failed: drop-empty/.test(share.message), share.message);
  }

  console.log("[11] /v2-reclaim: simulated, fee-bounded, and reported honestly when undecided (items a, g)");
  {
    const reclaim = (fee: string, plan: Parameters<typeof fakeRpc>[0] = {}) =>
      outcomeOf(() => relayReclaimHandler(TESTNET, realSigner, { xdr: buildReclaim({ fee }).toXDR(), senderPublicKey: sender.publicKey() }, depsFor(plan).deps));
    const over = await reclaim("3000001", { sim: { minResourceFee: 500_000 } });
    check("a reclaim fee one stroop over sim + 0.25 XLM is refused", /exceeds what the reclaim needs \(3000000\)/.test(over.message), over.message);
    const broken = await reclaim("1000000", { sim: { error: "not expired" } });
    check("a reclaim the contract would reject is refused by the simulation, no fee spent", /would fail/.test(broken.message), broken.message);
    kv.reset();
    const ok = await reclaim("3000000", { get: ["SUCCESS"] });
    check("a reclaim at exactly the bound is relayed and returns {confirmed:true}", !!ok.returned && ok.returned.confirmed === true, ok.message);
    check("and its fee bid was charged once", kv.feeCharges() === 1);
    {
      kv.reset();
      kv.spendFees(20_000_000_000n);
      const rec = recordingSigner();
      const spent = await outcomeOf(() =>
        relayReclaimHandler(TESTNET, rec.signer, { xdr: buildReclaim({ fee: "1000000" }).toXDR(), senderPublicKey: sender.publicKey() }, depsFor({ get: ["SUCCESS"] }).deps),
      );
      check("ORDER: a spent fee budget refuses the reclaim with the public sentence", spent.message === FEE_BUDGET_REFUSAL, spent.message);
      check("ORDER: and the sponsor's key signed NOTHING", rec.fees.length === 0, `${rec.fees.length} signatures`);
      kv.reset(); // the rest of this section runs on an unspent day
    }
    const unanswered = await reclaim("1000000", { send: "THROW_UNANSWERED" });
    check("a reclaim whose send went unanswered is an unconfirmed submit, never 'failed'", unanswered.unconfirmed && !!unanswered.hash, unanswered.message);
    const noFee = await reclaim("1000000", { sim: { noResourceFee: true } });
    check("a reclaim simulation that names no resource fee is REFUSED (the bound must not fail open on NaN)", /named no resource fee/.test(noFee.message), noFee.message);
    const late = await reclaim("1000000", { get: ["NOT_FOUND", "NOT_FOUND", "NOT_FOUND"] });
    check("NOT_FOUND after the window RETURNS {confirmed:false}", !!late.returned && late.returned.confirmed === false, late.message);
    const busy = await reclaim("1000000", { send: "TRY_AGAIN_LATER" });
    check("TRY_AGAIN_LATER raises 'busy'", busy.busy, busy.message);
    const wrong = await outcomeOf(() => relayReclaimHandler(TESTNET, realSigner, { xdr: buildReclaim({ fn: "deposit" }).toXDR(), senderPublicKey: sender.publicKey() }, depsFor().deps));
    check("a non-reclaim method is still refused before any simulation", /only reclaim\/reclaim_pool/.test(wrong.message), wrong.message);
  }

  console.log("[12] /v2-deposit moves only the sender's own USDC, and its bound never fails open");
  {
    kv.reset();
    // deposit(from = stranger), sourced and named by the sender: the per-sender cap and the pilot
    // slot would land on the sender while the stranger's USDC moved.
    const theirs = buildInvoke({
      fn: "deposit",
      args: [Address.fromString(stranger.publicKey()).toScVal(), link(), i128(usdc(5)), expiry],
    });
    const notFrom = await relayDeposit(TESTNET, theirs, undefined, depsFor().deps);
    check("a deposit whose 'from' is not the sender is refused", !notFrom.accepted && /sender's own USDC/.test(notFrom.message), notFrom.message);
    check("before anything is reserved or charged", kv.log.length === 0, `${kv.log.length} store writes`);
    const poolTheirs = buildInvoke({
      fn: "create_drop",
      args: [Address.fromString(stranger.publicKey()).toScVal(), link(), i128(usdc(30)), xdr.ScVal.scvU32(3), expiry],
    });
    check("the same for a group pool's 'from'", !(await relayDeposit(TESTNET, poolTheirs, undefined, depsFor().deps)).accepted);
    const noFee = await relayDeposit(TESTNET, deposit("1000000"), undefined, depsFor({ sim: { noResourceFee: true } }).deps);
    check("a simulation that names no resource fee is REFUSED, not compared as NaN", !noFee.accepted && /named no resource fee/.test(noFee.message), noFee.message);
  }

  console.log("[13] the fee-bump bids the smallest valid base: the inner's own inclusion fee, never its total");
  {
    // An assembled-looking deposit: 2,000,000 inclusion + 224,320 declared resource fee = 2,224,320.
    const assembled = buildInvoke({ fn: "deposit", args: depositArgs(usdc(5)), fee: "2000000", resourceFee: 224_320 });
    check("feeBumpBase reads the inclusion fee out of the envelope (2,224,320 - 224,320)", feeBumpBase(assembled) === "2000000", feeBumpBase(assembled));
    check("a classic transaction's base is its fee per op, and never below 100", feeBumpBase(deposit("100")) === "100" && feeBumpBase(deposit("50")) === "100");
    /* A sender-signed inner may DECLARE a resource fee larger than its own fee. Core refuses such an
       inner, but the base used to floor at 100 and the sponsor signed a bid of 200 + R, R being the
       client's number: a review declared 14 XLM and got a 14 XLM fee-bump signed. */
    const declaring = (fn: "deposit" | "reclaim", fee: number, resourceFee: number): Transaction => {
      const args = fn === "deposit" ? depositArgs(usdc(5)) : [Address.fromString(sender.publicKey()).toScVal(), link()];
      const env = buildInvoke({ fn, args, fee: "100", resourceFee: 1 }).toEnvelope();
      // The builder adds R on top of the fee and needs it non-negative; a hand-made envelope need not.
      (env.v1().tx().ext().value() as xdr.SorobanTransactionData).resourceFee(xdr.Int64.fromString(String(resourceFee)));
      env.v1().tx().fee(fee);
      return TransactionBuilder.fromXDR(env.toXDR("base64"), Networks.TESTNET) as Transaction;
    };
    let threw = "";
    try {
      feeBumpBase(declaring("deposit", 2_000_000, 140_000_000));
    } catch (e) {
      threw = (e as Error).message;
    }
    check("feeBumpBase REFUSES a Soroban inner whose declared resource fee its fee cannot cover (no floor at 100)", /cannot cover/.test(threw), threw || "returned a base");
    check("an inner that leaves exactly the 100-stroop minimum still gets base 100", feeBumpBase(declaring("deposit", 2_000_000, 1_999_900)) === "100");
    let threwNegative = "";
    try {
      feeBumpBase(declaring("deposit", 2_000_000, -140_000_000));
    } catch (e) {
      threwNegative = (e as Error).message;
    }
    check("feeBumpBase REFUSES a negative declared resource fee (the field is a signed int64)", /negative/.test(threwNegative), threwNegative || "returned a base");
    for (const route of ["deposit", "reclaim"] as const) {
      kv.reset();
      const rec = recordingSigner();
      const sim = depsFor({ sim: { minResourceFee: 500_000 }, get: ["SUCCESS"] });
      const input = { xdr: declaring(route, 2_000_000, -140_000_000).toXDR(), senderPublicKey: sender.publicKey() };
      const o = await outcomeOf(() =>
        route === "deposit" ? relayDepositHandler(TESTNET, rec.signer, input, sim.deps) : relayReclaimHandler(TESTNET, rec.signer, input, sim.deps),
      );
      check(`/v2-${route}: a NEGATIVE declared resource fee (-14 XLM) is refused, nothing signed, nothing reserved`, !o.returned && /negative resource fee/.test(o.message) && rec.fees.length === 0 && kv.log.length === 0, `${o.message} ${rec.fees.join(",")}`);
    }
    for (const route of ["deposit", "reclaim"] as const) {
      kv.reset();
      const rec = recordingSigner();
      const sim = depsFor({ sim: { minResourceFee: 500_000 }, get: ["SUCCESS"] });
      const inner = declaring(route, 2_000_000, 140_000_000); // a fee inside the bound, R of 14 XLM
      const input = { xdr: inner.toXDR(), senderPublicKey: sender.publicKey() };
      const o = await outcomeOf(() =>
        route === "deposit" ? relayDepositHandler(TESTNET, rec.signer, input, sim.deps) : relayReclaimHandler(TESTNET, rec.signer, input, sim.deps),
      );
      check(`/v2-${route}: an inner declaring a 14 XLM resource fee inside a 0.2 XLM fee is refused`, !o.returned && /resource fee its own fee cannot cover/.test(o.message), o.message);
      check(`/v2-${route}: and the sponsor's key signed NOTHING`, rec.fees.length === 0, rec.fees.join(","));
      check(`/v2-${route}: before any reservation or fee charge (no store write)`, kv.log.length === 0 && kv.feeCharges() === 0, `${kv.log.length} writes`);
      check(`/v2-${route}: and nothing was sent`, sim.calls.send === 0);
      kv.reset();
      const edge = depsFor({ sim: { minResourceFee: 500_000 }, get: ["SUCCESS"] });
      const rec2 = recordingSigner();
      const fine = declaring(route, 2_000_000, 1_999_900);
      const ok = await outcomeOf(() =>
        route === "deposit"
          ? relayDepositHandler(TESTNET, rec2.signer, { xdr: fine.toXDR(), senderPublicKey: sender.publicKey() }, edge.deps)
          : relayReclaimHandler(TESTNET, rec2.signer, { xdr: fine.toXDR(), senderPublicKey: sender.publicKey() }, edge.deps),
      );
      check(`/v2-${route}: R = fee - 100 (the minimum inclusion fee left) is still relayed, bid = fee + 100`, !!ok.returned && rec2.fees.at(-1) === "2000100", `${ok.message} ${rec2.fees.join(",")}`);
    }
    kv.reset();
    const rec = recordingSigner();
    const d = await outcomeOf(() =>
      relayDepositHandler(TESTNET, rec.signer, { xdr: assembled.toXDR(), senderPublicKey: sender.publicKey() }, depsFor({ sim: { minResourceFee: 224_320 }, get: ["SUCCESS"] }).deps),
    );
    check("the relayed deposit lands", !!d.returned, d.message);
    check(
      "and its fee-bump bid is 2 x 2,000,000 + 224,320 = 4,224,320 (the old base bid 4,672,960)",
      rec.fees[0] === "4224320",
      rec.fees.join(","),
    );
  }
  clearKv();

  /* The HTTP half of item g: what the Worker itself ANSWERS, through worker.fetch, with the Soroban
     RPC client's prototype stubbed (the Worker builds its own `new rpc.Server`), so a revert of the
     route's 202 or of the catch's 202/503 mapping fails here and not only in a browser. */
  console.log("[14] the Worker's own answers: 202 for an undecided relay, 503 for a busy RPC, 200 for a landed one");
  {
    const proto = rpc.Server.prototype as unknown as Record<string, unknown>;
    const saved = { ...Object.fromEntries(["getAccount", "simulateTransaction", "sendTransaction", "getTransaction"].map((k) => [k, proto[k]])) };
    const stub = (send: "THROW" | "TRY_AGAIN_LATER" | "PENDING", get: "SUCCESS" | "THROW") => {
      const f = fakeRpc({ get: [get === "THROW" ? "THROW" : "SUCCESS"] }).factory("x");
      proto.getAccount = f.getAccount;
      proto.simulateTransaction = f.simulateTransaction;
      proto.getTransaction = f.getTransaction;
      proto.sendTransaction = async (tx: Transaction | FeeBumpTransaction) => {
        if (send === "THROW") throw new TypeError("fetch failed: socket hang up");
        return { status: send, hash: tx.hash().toString("hex"), latestLedger: 1, latestLedgerCloseTime: 0 };
      };
    };
    const ENV = {
      STELLAR_NETWORK: "testnet",
      SPONSOR_SECRET: sponsor.secret(),
      USDC_ISSUER: issuer.publicKey(),
      LUMENDROP_CONTRACT: CONTRACT,
    };
    const post = async (route: string, body: unknown) => {
      const res = await worker.fetch(
        new Request(`https://sponsor.test${route}`, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${10 + Math.floor(Math.random() * 200)}` },
          body: JSON.stringify(body),
        }),
        ENV,
      );
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    const depositBody = () => ({ xdr: deposit("1000000").toXDR(), senderPublicKey: sender.publicKey() });
    try {
      stub("THROW", "SUCCESS");
      const unanswered = await post("/v2-deposit", depositBody());
      check(
        "/v2-deposit whose send went unanswered: 202 {error:'submit unconfirmed', hash}",
        unanswered.status === 202 && unanswered.body.error === "submit unconfirmed" && /^[0-9a-f]{64}$/.test(String(unanswered.body.hash)),
        `${unanswered.status} ${JSON.stringify(unanswered.body)}`,
      );
      stub("TRY_AGAIN_LATER", "SUCCESS");
      const busy = await post("/v2-deposit", depositBody());
      check("/v2-deposit when the RPC declines to queue: 503 with the busy sentence", busy.status === 503 && /network is busy/.test(String(busy.body.error)), `${busy.status} ${JSON.stringify(busy.body)}`);
      stub("PENDING", "THROW");
      const midPoll = await post("/v2-deposit", depositBody());
      check("/v2-deposit whose RPC died while watching: 202 with the hash", midPoll.status === 202 && /^[0-9a-f]{64}$/.test(String(midPoll.body.hash)), `${midPoll.status} ${JSON.stringify(midPoll.body)}`);
      stub("PENDING", "SUCCESS");
      const landed = await post("/v2-deposit", depositBody());
      check("/v2-deposit that lands: 200 {hash, confirmed:true}", landed.status === 200 && landed.body.confirmed === true, `${landed.status} ${JSON.stringify(landed.body)}`);
      stub("THROW", "SUCCESS");
      const claimUnanswered = await post("/v2-claim", claimInput());
      check("/v2-claim whose send went unanswered: 202, never a 400 the screen would retry", claimUnanswered.status === 202 && /^[0-9a-f]{64}$/.test(String(claimUnanswered.body.hash)), `${claimUnanswered.status} ${JSON.stringify(claimUnanswered.body)}`);
      stub("PENDING", "SUCCESS");
      const claimed = await post("/v2-claim", claimInput());
      check("/v2-claim that lands: 200 {hash, confirmed:true}", claimed.status === 200 && claimed.body.confirmed === true, `${claimed.status} ${JSON.stringify(claimed.body)}`);
      stub("TRY_AGAIN_LATER", "SUCCESS");
      const reclaimBusy = await post("/v2-reclaim", { xdr: buildReclaim({ fee: "1000000" }).toXDR(), senderPublicKey: sender.publicKey() });
      check("/v2-reclaim when the RPC declines to queue: 503 busy", reclaimBusy.status === 503 && /network is busy/.test(String(reclaimBusy.body.error)), `${reclaimBusy.status} ${JSON.stringify(reclaimBusy.body)}`);
    } finally {
      Object.assign(proto, saved);
    }
  }

  /* ------------------------------------------------------------------------------------------
   * SOW 2, D2 (no amounts or full addresses in server logs). The RPC's simulation error is the
   * HostError's first line and then its diagnostic event log, which replays the call's arguments:
   * a read-only deposit simulation on testnet and mainnet returned the sender's full address four
   * times, the link id and the amount. On mainnet that text was the error log's line.
   * ------------------------------------------------------------------------------------------ */
  const FULL_ADDRESS = /\b(?:[GC][A-Z2-7]{55}|M[A-Z2-7]{68})\b/;
  const AMOUNT = "12345678";
  const linkId = Buffer.from(Keypair.random().rawPublicKey()).toString("hex");
  /** The shape of the RPC's error text for a refused deposit, with the address and the amount in it. */
  const eventLogError = (who: string) =>
    "HostError: Error(Contract, #13)\n\nEvent log (newest first):\n" +
    `   0: [Diagnostic Event] contract:${CONTRACT}, topics:[error, Error(Contract, #13)], data:"escalating Ok(ScErrorType::Contract) frame-exit to Err"\n` +
    `   1: [Diagnostic Event] topics:[fn_call, ${CONTRACT}, deposit], data:[${who}, Bytes(${linkId}), ${AMOUNT}, 1791746027]\n` +
    `   2: [Diagnostic Event] topics:[fn_call, CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA, transfer], data:[${who}, ${CONTRACT}, ${AMOUNT}]`;
  const oneLineNoMoney = (msg: string, who: string) =>
    !/[\r\n]/.test(msg) && !msg.includes("Event log") && !msg.includes(who) && !FULL_ADDRESS.test(msg) && !msg.includes(AMOUNT) && !msg.includes(linkId);

  console.log("[15] a refused simulation carries one line: no event log, no full address, no link id, no amount");
  {
    const dep = await relayDeposit(TESTNET, deposit("1000000"), undefined, depsFor({ sim: { error: eventLogError(sender.publicKey()) } }).deps);
    check("/v2-deposit: refused with the HostError's first line", /^v2-deposit would fail: HostError: Error\(Contract, #13\)$/.test(dep.message), dep.message);
    check("/v2-deposit: one line, nothing of the event log", oneLineNoMoney(dep.message, sender.publicKey()), dep.message);
    const claim = await outcomeOf(() =>
      relayClaimHandler(TESTNET, realSigner, claimInput(), undefined, depsFor({ sim: { error: eventLogError(stranger.publicKey()) } }).deps),
    );
    check("/v2-claim: refused with the first line only (the payout address stays out)", /^v2-claim simulation failed: HostError: Error\(Contract, #13\)$/.test(claim.message) && oneLineNoMoney(claim.message, stranger.publicKey()), claim.message);
    const rec = await outcomeOf(() =>
      relayReclaimHandler(TESTNET, realSigner, { xdr: buildReclaim({ fee: "1000000" }).toXDR(), senderPublicKey: sender.publicKey() }, depsFor({ sim: { error: eventLogError(sender.publicKey()) } }).deps),
    );
    check("/v2-reclaim: refused with the first line only", /^v2-reclaim would fail: HostError: Error\(Contract, #13\)$/.test(rec.message) && oneLineNoMoney(rec.message, sender.publicKey()), rec.message);
    check("simErrorHead: Windows line ends cut the same way", simErrorHead("HostError: Error(Auth, InvalidAction)\r\nEvent log ...") === "HostError: Error(Auth, InvalidAction)");
    const long = simErrorHead(`HostError: ${"x".repeat(1000)}`);
    check(`simErrorHead: one long line is cut to ${SIM_ERROR_HEAD_MAX} characters`, long.length === SIM_ERROR_HEAD_MAX + 3 && long.endsWith("..."), String(long.length));
    const inline = simErrorHead(`account not found: ${sender.publicKey()} (amount ${AMOUNT}?)`);
    check("simErrorHead: a full address on the first line itself is cut to four characters", !inline.includes(sender.publicKey()) && inline.includes(`${sender.publicKey().slice(0, 4)}...`), inline);
    check("simErrorHead: an empty or missing error stays empty", simErrorHead(undefined) === "" && simErrorHead("") === "");
    const extras = { envelope_xdr: "AAAAAgAAAAD...", result_xdr: "AAAAAAAAAGT/////", result_codes: { transaction: "tx_failed", operations: ["op_underfunded"] } };
    const detail = extrasDetail(extras);
    check(
      "a Horizon refusal keeps its result codes and drops the envelope and result XDR (the transaction, base64: every address and the amount)",
      detail.includes("op_underfunded") && detail.includes("tx_failed") && !detail.includes("envelope_xdr") && !detail.includes("AAAAAgAAAAD") && !detail.includes("result_xdr"),
      detail,
    );
  }

  /* ------------------------------------------------------------------------------------------
   * The poll window and the invocation's subrequest budget (lib/subrequests.ts). Each fake RPC call
   * here makes one counted fetch, like the real client, and the store is the counting fake.
   * ------------------------------------------------------------------------------------------ */
  console.log("[16] the poll window stops inside the subrequest budget, with room for what follows it");
  {
    const store = installFakeKv();
    const kvFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: { body?: string }) =>
      String(url).startsWith("https://rpc.counted.test/")
        ? ({ ok: true, status: 200, json: async () => ({}) } as unknown as Response)
        : kvFetch(url as string, init as RequestInit)) as typeof fetch;
    /** The fake RPC of the plan, every call one fetch, as the real client makes. */
    const counted = (plan: Parameters<typeof fakeRpc>[0]) => {
      const { factory, calls } = fakeRpc(plan);
      const inner = factory("x");
      const hop = (m: string) => fetch(`https://rpc.counted.test/${m}`);
      const rpcFor = (_url: string): RelayRpc => ({
        async getAccount(a) {
          await hop("getAccount");
          return inner.getAccount(a);
        },
        async simulateTransaction(t) {
          await hop("simulateTransaction");
          return inner.simulateTransaction(t);
        },
        async sendTransaction(t) {
          await hop("sendTransaction");
          return inner.sendTransaction(t);
        },
        async getTransaction(h) {
          await hop("getTransaction");
          return inner.getTransaction(h);
        },
      });
      return { deps: { rpc: rpcFor, pollMs: 0, maxPolls: 40 } as RelayDeps, calls };
    };
    const LIMIT = 20;
    const metered = <T>(run: () => Promise<T>) =>
      withSubrequestMeter(async () => {
        const out = await outcomeOf(run as () => Promise<{ hash: string; confirmed: boolean }>);
        return { out, used: subrequestsUsed() };
      }, LIMIT);

    store.reset();
    const never = counted({ get: ["NOT_FOUND"] });
    const cut = await metered(() => relayDepositHandler(TESTNET, realSigner, { xdr: deposit("1000000").toXDR(), senderPublicKey: sender.publicKey() }, never.deps));
    check(
      `a deposit the RPC never shows stops polling with three subrequests still free (${LIMIT} allowed, ${cut.used} used, ${never.calls.get} polls)`,
      cut.used === LIMIT - 3 && never.calls.get > 0 && never.calls.get < 41,
      `${cut.used} used, ${never.calls.get} polls`,
    );
    check("and answers what a closed window answers: {confirmed:false} with the hash (the Worker's 202)", !!cut.out.returned && cut.out.returned.confirmed === false && /^[0-9a-f]{64}$/.test(cut.out.returned.hash), cut.out.message);
    check("the day's budget stays reserved and the fee bid stays whole (undecided, as before)", store.dayReleases() === 0 && store.feeRefunds() === 0);

    store.reset();
    const polls = never.calls.get;
    const lastPoll = counted({ get: [...Array.from({ length: polls - 1 }, () => "NOT_FOUND" as const), "FAILED"], charged: 31_000 });
    const decided = await metered(() => relayDepositHandler(TESTNET, realSigner, { xdr: deposit("1000000").toXDR(), senderPublicKey: sender.publicKey() }, lastPoll.deps));
    check(
      "decided on the last poll the budget allowed: the fee settle and the cap release still fit inside it",
      /tx FAILED/.test(decided.out.message) && decided.used <= LIMIT && store.dayReleases() === 1 && store.feeTotal() === 31_000n,
      `${decided.used} used, ${decided.out.message}, ${store.dayReleases()} released, ${store.feeTotal()} counted`,
    );

    const pool = oneChannel();
    const claimCut = counted({ get: ["NOT_FOUND"] });
    const c = await metered(() => relayClaimHandler(TESTNET, realSigner, claimInput(), pool.manager, claimCut.deps));
    check(
      "a claim whose window the budget closed keeps its channel lease (it may still land before its 60 s timebound)",
      !!c.out.returned && c.out.returned.confirmed === false && pool.state.leased === 1 && pool.state.released === 0 && c.used <= LIMIT - 2,
      `${c.used} used, ${pool.state.released} released`,
    );
    const clockPool = oneChannel();
    const clock = await outcomeOf(() => relayClaimHandler(TESTNET, realSigner, claimInput(), clockPool.manager, depsFor({ get: ["NOT_FOUND"] }).deps));
    check("while a window the clock closed (no meter) frees it as before", !!clock.returned && clock.returned.confirmed === false && clockPool.state.released === 1);

    store.reset();
    const unmetered = counted({ get: ["NOT_FOUND"] });
    await outcomeOf(() => relayDepositHandler(TESTNET, realSigner, { xdr: deposit("1000000").toXDR(), senderPublicKey: sender.publicKey() }, unmetered.deps));
    check("outside a metered request the window is the relay's own: 1 + 40 polls", unmetered.calls.get === 41, `${unmetered.calls.get} polls`);
    clearKv();
  }

  /* ------------------------------------------------------------------------------------------
   * The mainnet error log itself, through worker.fetch: one line per refusal, no full address, no
   * link id, no amount (the relays above, and the payout and sweep reasons from lib/anti-drain.ts).
   * ------------------------------------------------------------------------------------------ */
  console.log("[17] the mainnet error log: one line, no full address, no link id, no amount");
  {
    const proto = rpc.Server.prototype as unknown as Record<string, unknown>;
    const saved = { ...Object.fromEntries(["getAccount", "simulateTransaction", "sendTransaction", "getTransaction"].map((k) => [k, proto[k]])) };
    const restore = { network: process.env.STELLAR_NETWORK, issuer: process.env.USDC_ISSUER };
    process.env.STELLAR_NETWORK = "mainnet";
    process.env.USDC_ISSUER = issuer.publicKey();
    resetServiceCache();
    const lines: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    const post = async (route: string, body: unknown) => {
      lines.length = 0;
      const res = await worker.fetch(
        new Request(`https://sponsor.test${route}`, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${10 + Math.floor(Math.random() * 200)}` },
          body: JSON.stringify(body),
        }),
        {},
      );
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, logged: lines.join("\n") };
    };
    const clean = (logged: string, who: string[]) =>
      lines.length === 1 && !/[\r\n]/.test(logged) && !FULL_ADDRESS.test(logged) && who.every((w) => !logged.includes(w)) && !logged.includes(AMOUNT) && !logged.includes(linkId);
    try {
      // Fresh keys: the per-account rate limit has seen `sender` many times in this minute already.
      const from = Keypair.random();
      const payee = Keypair.random().publicKey();
      const refusing = fakeRpc({ sim: { error: eventLogError(from.publicKey()) } }).factory("x");
      proto.getAccount = refusing.getAccount;
      proto.simulateTransaction = refusing.simulateTransaction;
      const depTx = new TransactionBuilder(new Account(from.publicKey(), "1"), { fee: "1000000", networkPassphrase: Networks.PUBLIC })
        .addOperation(new Contract(CONTRACT).call("deposit", Address.fromString(from.publicKey()).toScVal(), link(), i128(usdc(5)), expiry))
        .setTimeout(180)
        .build();
      const dep = await post("/v2-deposit", { xdr: depTx.toXDR(), senderPublicKey: from.publicKey() });
      check("/v2-deposit refused at simulation: the caller gets a reference only", dep.status === 400 && dep.body.error === "request failed" && typeof dep.body.ref === "string", JSON.stringify(dep.body));
      check("and the log line is one line with the first line of the HostError, nothing of its event log", clean(dep.logged, [from.publicKey()]) && /\/v2-deposit: v2-deposit would fail: HostError: Error\(Contract, #13\)$/.test(dep.logged), dep.logged);
      const refusingClaim = fakeRpc({ sim: { error: eventLogError(payee) } }).factory("x");
      proto.simulateTransaction = refusingClaim.simulateTransaction;
      const claim = await post("/v2-claim", { ...claimInput(), payout: payee });
      check("/v2-claim refused at simulation: one clean line (no payout address)", claim.status === 400 && clean(claim.logged, [payee]), claim.logged);

      // /payout and /sweep: anti-drain refusals, logged before any network call.
      const payoutTx = new TransactionBuilder(new Account(from.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.PUBLIC })
        .addOperation(Operation.payment({ destination: payee, asset: new Asset("USDC", issuer.publicKey()), amount: "4.9876543", source: from.publicKey() }))
        .setTimeout(180)
        .build();
      const payout = await post("/payout", { xdr: payoutTx.toXDR(), senderPublicKey: from.publicKey(), destination: payee, amount: "1.2345678" });
      check(
        "/payout with an amount that is not the declared one: one line naming the rule, neither amount, no full address",
        payout.status === 400 && clean(payout.logged, [from.publicKey(), payee, "4.9876543", "1.2345678"]) && /payout amount != the declared amount/.test(payout.logged),
        payout.logged,
      );
      const thief = Keypair.random().publicKey();
      const elsewhere = await post("/payout", { xdr: payoutTx.toXDR(), senderPublicKey: from.publicKey(), destination: thief, amount: "4.9876543" });
      check("/payout to another destination: one line, the address cut to four characters", elsewhere.status === 400 && clean(elsewhere.logged, [payee, thief, "4.9876543"]) && elsewhere.logged.includes(`${payee.slice(0, 4)}...`), elsewhere.logged);
      const home = Keypair.random().publicKey();
      const throwaway = Keypair.random();
      const usdcMain = new Asset("USDC", issuer.publicKey());
      const sweepTx = new TransactionBuilder(new Account(throwaway.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.PUBLIC })
        .addOperation(Operation.payment({ destination: home, asset: usdcMain, amount: "3.3333333", source: throwaway.publicKey() }))
        .addOperation(Operation.changeTrust({ asset: usdcMain, limit: "0", source: throwaway.publicKey() }))
        .addOperation(Operation.accountMerge({ destination: home, source: throwaway.publicKey() }))
        .setTimeout(180)
        .build();
      const sweep = await post("/sweep", { xdr: sweepTx.toXDR(), throwawayPublicKey: throwaway.publicKey(), homePublicKey: home, amount: "2.2222222" });
      check(
        "/sweep with an amount that is not the expected one: one line naming the rule, neither amount, no full address",
        sweep.status === 400 && clean(sweep.logged, [throwaway.publicKey(), home, "3.3333333", "2.2222222"]) && /sweep payment amount != the expected amount/.test(sweep.logged),
        sweep.logged,
      );
    } finally {
      console.error = realError;
      Object.assign(proto, saved);
      for (const [k, v] of [["STELLAR_NETWORK", restore.network], ["USDC_ISSUER", restore.issuer]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetServiceCache();
    }
  }

  console.log("\n============================================================");
  console.log(fail === 0 ? ` ✅ V2 RELAY GUARD TESTS PASS (${pass}/${pass})` : ` ❌ ${fail} FAILURES (${pass} passed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("💥", e);
  process.exit(1);
});
