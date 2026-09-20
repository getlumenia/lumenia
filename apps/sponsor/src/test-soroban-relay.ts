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
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type Transaction,
  type FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import { isPublicRefusal } from "./lib/caps.js";
import { makeConfig, type SponsorConfig } from "./lib/config.js";
import type { SponsorSigner } from "./lib/signer.js";
import { groupClaimFailureToken, relayClaimHandler, relayDepositHandler } from "./lib/soroban-relay.js";

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

/** Build a sender-sourced invoke, in memory, with a fake sequence: nothing is ever submitted. */
function buildInvoke(
  opts: { fn: string; args: xdr.ScVal[]; contract?: string; fee?: string; network?: string; ops?: number },
): Transaction {
  const network = opts.network ?? Networks.TESTNET;
  const b = new TransactionBuilder(new Account(sender.publicKey(), "123456789"), {
    fee: opts.fee ?? "1000000",
    networkPassphrase: network,
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

async function relayDeposit(
  config: SponsorConfig,
  tx: Transaction,
  senderPublicKey = sender.publicKey(),
): Promise<GuardVerdict> {
  try {
    await relayDepositHandler(config, stubSigner, { xdr: tx.toXDR(), senderPublicKey });
    return { accepted: false, message: "the handler returned without signing anything", publicRefusal: false };
  } catch (e) {
    const message = (e as Error).message;
    return { accepted: message === SENTINEL, message, publicRefusal: isPublicRefusal(e) };
  }
}

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

  console.log("\n============================================================");
  console.log(fail === 0 ? ` ✅ V2 RELAY GUARD TESTS PASS (${pass}/${pass})` : ` ❌ ${fail} FAILURES (${pass} passed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("💥", e);
  process.exit(1);
});
