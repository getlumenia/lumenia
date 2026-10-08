/**
 * Claim-error self-test — the classifier the claim screen uses to decide what to TELL someone
 * whose claim just failed (lib/claim-error.ts).
 *
 * Why this is tested rather than assumed: the screen previously caught every failure without
 * binding it and printed one sentence — "your money is still safe, try again". For the commonest
 * failure, a link that was already claimed, both halves are false: the money is not waiting, it is
 * already in their account, and no number of retries can change that. Two people reported the
 * product as broken when it had in fact already paid them. So the mapping from a raw error to the
 * words a recipient reads is now a tested contract.
 *
 * The fixtures below are the real error shapes: the SDK's Horizon errors nest result codes under
 * `response.data.extras`, while our own `postJson` throws a formatted string. If either shape
 * changes and this file goes green anyway, the classifier has stopped reading reality.
 *
 * Invariants covered:
 *   - an already-claimed balance is recognised from BOTH ends of runClaim, and is never retryable
 *   - a rate limit and an outage are retryable; a pause and a broken link are not
 *   - a tx-guard refusal is terminal — a retry gets refused identically, forever
 *   - EVERY group-claim refusal is terminal, and each token gets its own answer (a retry on any of
 *     them mints another sponsored account for a reply that cannot change)
 *   - a claim the relayer stopped watching is uncertain, not a failure and not a success: no button,
 *     and no sentence about where the money is
 *   - a 202 from a Horizon route is uncertain THROUGH THE REAL CODE: runClaim (/feebump),
 *     collectIncoming (/feebump), payToAddress (/send-link) and sweepIntoHome (/sweep) are driven
 *     with a fetch stub answering 202 and Horizon stubbed in memory, and each throws the typed
 *     unconfirmed error (lib/unconfirmed.ts) instead of reading the 202 as done. A message nothing
 *     throws is not a test, so the old hand-written "/feebump -> 202" cases are gone.
 *   - the /try page's mint reply (lib/demo-link.ts): a 202 is a sentence, never a TypeError
 *   - three waits, three kinds: a busy network (retry soon), a spent day limit (tomorrow, no
 *     button) and the operator's halt are told apart by the sponsor's sentence
 *   - an unrecognised error falls back to retryable (safe advice when we do not know)
 *   - the classifier never throws, whatever it is handed
 *   - the detail string never leaks a bearer key
 *
 * RUN: pnpm --filter @lumenia/web test:claimerr   (offline, no keys, no network)
 */
import {
  Account,
  Asset,
  BASE_FEE,
  Claimant,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { classifyClaimError } from "./claim-error";
import { assertSponsoredOnboarding, pinnedUsdcIssuer } from "./tx-guard";
import { runClaim } from "./sponsor";
import { collectIncoming } from "./claim";
import { payToAddress, SendUnconfirmedError } from "./send";
import { pendingSweep, sweepIntoHome } from "./sweep";
import { isUnconfirmedSubmit, UnconfirmedSubmitError } from "./unconfirmed";
import { readDemoLinkReply } from "./demo-link";
import { localSignerFromSeed } from "./signer";
import { testnetConfig } from "./network";

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✔ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

/** How the stellar-sdk surfaces a failed submitTransaction. */
function horizonError(opCodes: string[]): unknown {
  const e = new Error("Request failed with status code 400") as Error & { response: unknown };
  e.response = {
    status: 400,
    data: {
      type: "https://stellar.org/horizon-errors/transaction_failed",
      status: 400,
      extras: { result_codes: { transaction: "tx_failed", operations: opCodes } },
    },
  };
  return e;
}

/** How lib/sponsor.ts postJson reports a non-2xx from the sponsor. */
function sponsorError(path: string, status: number, body: string): unknown {
  return new Error(`${path} → ${status}: ${body}`);
}

/**
 * A REAL tx-guard refusal, not a restatement of one: a hostile transaction goes through XDR the way
 * the browser receives it, and what comes back is whatever lib/tx-guard.ts actually threw. If the
 * two files ever drift apart on the wording, this is what notices.
 */
function guardRefusal(): unknown {
  const me = Keypair.random().publicKey();
  const attacker = Keypair.random().publicKey();
  const built = new TransactionBuilder(new Account(attacker, "1"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: attacker,
        asset: new Asset("USDC", attacker),
        amount: "100",
        source: me,
      }),
    )
    .setTimeout(180)
    .build();
  const parsed = TransactionBuilder.fromXDR(built.toXDR(), Networks.TESTNET) as Transaction;
  try {
    assertSponsoredOnboarding(parsed, me, "testnet");
  } catch (e) {
    return e;
  }
  throw new Error("the guard accepted a hostile transaction — this test is no longer testing anything");
}

/* ------------------------------ the real code, with a 202 ------------------------------
 * Every Horizon route that submits answers 202 `{error:"submit unconfirmed", hash}` when the network
 * took the transaction and the sponsor stopped watching (apps/sponsor/src/worker.ts). Each consumer
 * below is driven through its real code with fetch answering that 202 and Horizon replaced in
 * memory, so what is asserted is what the screens actually receive. */
const SPONSOR = "https://sponsor.invalid";
const SPONSOR_KEY = Keypair.random();
const HASH = "ab".repeat(32);
const ISSUER = pinnedUsdcIssuer("testnet");

const reply = (status: number, body: unknown): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** fetch, answered by `route`; every call is recorded. */
function stubFetch(route: (url: string, init?: RequestInit) => Response | Promise<Response>): { calls: string[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return route(url, init);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

/** The sponsor's /health canary, matching this build's pinned dollar. */
const health = () => reply(200, { sponsorPublicKey: SPONSOR_KEY.publicKey(), usdcIssuer: ISSUER, usdcCode: "USDC" });

/** Horizon in memory: every account exists, at sequence 100, and trusts this build's dollar. */
function stubHorizon(): () => void {
  const proto = Horizon.Server.prototype as unknown as { loadAccount: (id: string) => Promise<unknown> };
  const real = proto.loadAccount;
  proto.loadAccount = async (id: string) =>
    Object.assign(new Account(id, "100"), {
      balances: [{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "5.0000000" }],
    });
  return () => void (proto.loadAccount = real);
}

/** A rejection's value, so each case can be asserted on without a try/catch of its own. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
}

/** A minimal localStorage, so the sweep's remembered state can be read back (node has none). */
function installLocalStorage(): void {
  const map = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

async function realPaths(): Promise<void> {
  const unhorizon = stubHorizon();
  installLocalStorage();
  try {
    // --- runClaim: the v1 claim's /feebump --------------------------------------------------
    console.log("\n[202] the v1 claim (runClaim, /feebump)");
    const bearer = Keypair.random();
    // The three-op shape the sponsor sends for an account that already exists; the stub says it
    // exists and trusts the dollar, so runClaim skips onboarding and goes straight to the claim.
    const threeOps = new TransactionBuilder(new Account(SPONSOR_KEY.publicKey(), "1"), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: bearer.publicKey() }))
      .addOperation(Operation.changeTrust({ asset: new Asset("USDC", ISSUER), source: bearer.publicKey() }))
      .addOperation(Operation.endSponsoringFutureReserves({ source: bearer.publicKey() }))
      .setTimeout(180)
      .build();
    let net = stubFetch((url) =>
      url.endsWith("/create-account")
        ? reply(200, { xdr: threeOps.toXDR() })
        : reply(202, { error: "submit unconfirmed", hash: HASH }),
    );
    const claimErr = await rejection(
      runClaim({ sponsorUrl: SPONSOR, bearerSecret: bearer.secret(), balanceId: `00000000${"cd".repeat(32)}`, network: testnetConfig() }),
    );
    net.restore();
    ok("a 202 from /feebump is NOT a landed claim: runClaim throws the typed unconfirmed error", isUnconfirmedSubmit(claimErr));
    const typed = claimErr as UnconfirmedSubmitError;
    ok("  ...carrying the sponsor's hash and the facts of the claim this device signed", typed?.hash === HASH && typed?.signed?.source === bearer.publicKey() && /^[0-9a-f]{64}$/.test(typed?.signed?.innerHash ?? "") && (typed?.signed?.maxTime ?? 0) > 0);
    const claimInfo = classifyClaimError(claimErr);
    ok("  ...and the claim screen reads it as uncertain, with no button", claimInfo.kind === "uncertain" && claimInfo.retryable === false);
    ok("  ...and nothing past it was asked: one onboarding read, one claim post", net.calls.length === 2);

    net = stubFetch((url) => (url.endsWith("/create-account") ? reply(200, { xdr: threeOps.toXDR() }) : reply(200, { hash: HASH })));
    const landed = await runClaim({ sponsorUrl: SPONSOR, bearerSecret: bearer.secret(), balanceId: `00000000${"cd".repeat(32)}`, network: testnetConfig() });
    net.restore();
    ok("a 200 from /feebump is still the landed claim, with its hash", landed.hash === HASH);

    // --- collectIncoming: money waiting for this account ----------------------------------------
    console.log("\n[202] collecting money waiting for this account (collectIncoming, /feebump)");
    const me = Keypair.random();
    net = stubFetch(() => reply(202, { error: "submit unconfirmed", hash: HASH }));
    const collectErr = await rejection(
      collectIncoming({ sponsorUrl: SPONSOR, signer: localSignerFromSeed(me.rawSecretKey()), balanceId: `00000000${"ef".repeat(32)}` }),
    );
    net.restore();
    ok("a 202 is NOT a collected balance: collectIncoming throws the typed unconfirmed error", isUnconfirmedSubmit(collectErr) && (collectErr as UnconfirmedSubmitError).signed?.source === me.publicKey());
    ok("  ...which reads as uncertain", classifyClaimError(collectErr).kind === "uncertain");
    net = stubFetch(() => reply(400, { error: "tx_failed: CLAIMABLE_BALANCE_DOES_NOT_EXIST" }));
    const goneErr = await rejection(
      collectIncoming({ sponsorUrl: SPONSOR, signer: localSignerFromSeed(me.rawSecretKey()), balanceId: `00000000${"ef".repeat(32)}` }),
    );
    net.restore();
    ok("a refusal is still a plain refusal, read as already claimed", !isUnconfirmedSubmit(goneErr) && classifyClaimError(goneErr).kind === "already-claimed");

    // --- payToAddress: the direct payment ----------------------------------------------------------
    console.log("\n[202] paying a request straight to an address (payToAddress, /send-link)");
    const payer = Keypair.random();
    const asker = Keypair.random().publicKey();
    // The id the payment's claimable balance gets if it lands: source, sequence 101, operation 1.
    const expectedId = new TransactionBuilder(new Account(payer.publicKey(), "100"), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
      .addOperation(
        Operation.createClaimableBalance({ asset: new Asset("USDC", ISSUER), amount: "1", claimants: [new Claimant(asker, Claimant.predicateUnconditional())] }),
      )
      .setTimeout(180)
      .build()
      .getClaimableBalanceId(1);
    net = stubFetch((url) => (url.endsWith("/health") ? health() : reply(202, { error: "submit unconfirmed", hash: HASH })));
    const payErr = await rejection(
      payToAddress({ sponsorUrl: SPONSOR, signer: localSignerFromSeed(payer.rawSecretKey()), amount: "1.00", to: asker }),
    );
    net.restore();
    ok("a 202 is NOT a payment with a balance id: payToAddress throws SendUnconfirmedError", payErr instanceof SendUnconfirmedError);
    ok("  ...naming the balance the payment creates if it lands", (payErr as SendUnconfirmedError)?.balanceId === expectedId);
    ok("  ...with the sponsor's hash and the payment's own sequence and time bound", (payErr as SendUnconfirmedError)?.hash === HASH && (payErr as SendUnconfirmedError)?.signed?.sequence === "101" && ((payErr as SendUnconfirmedError)?.signed?.maxTime ?? 0) > 0);
    net = stubFetch((url) => {
      if (url.endsWith("/health")) return health();
      throw new TypeError("Failed to fetch");
    });
    const droppedErr = await rejection(
      payToAddress({ sponsorUrl: SPONSOR, signer: localSignerFromSeed(payer.rawSecretKey()), amount: "1.00", to: asker }),
    );
    net.restore();
    ok("a payment whose reply never came is undecided too, never 'nothing moved'", droppedErr instanceof SendUnconfirmedError && (droppedErr as SendUnconfirmedError).hash === "" && (droppedErr as SendUnconfirmedError).signed?.source === payer.publicKey());
    net = stubFetch((url) => (url.endsWith("/health") ? health() : reply(403, { error: "this wallet is not on the pilot allowlist yet" })));
    const refusedErr = await rejection(
      payToAddress({ sponsorUrl: SPONSOR, signer: localSignerFromSeed(payer.rawSecretKey()), amount: "1.00", to: asker }),
    );
    net.restore();
    ok("a refusal stays the plain error the send screen reads its sentence from", !isUnconfirmedSubmit(refusedErr) && /403: .*pilot allowlist/.test((refusedErr as Error)?.message ?? ""));

    // --- sweepIntoHome: gathering a per-link account into home -----------------------------------
    console.log("\n[202] gathering a per-link account into home (sweepIntoHome, /sweep)");
    const throwaway = Keypair.random();
    net = stubFetch((url) => (url.endsWith("/health") ? health() : reply(202, { error: "submit unconfirmed", hash: HASH })));
    const sweepErr = await rejection(
      sweepIntoHome({ sponsorUrl: SPONSOR, throwawaySeed: new Uint8Array(throwaway.rawSecretKey()), homePublicKey: Keypair.random().publicKey(), amount: "1.0000000" }),
    );
    net.restore();
    ok("a 202 is NOT a finished sweep: sweepIntoHome throws the typed unconfirmed error", isUnconfirmedSubmit(sweepErr));
    const remembered = pendingSweep(throwaway.publicKey());
    ok("  ...and remembers it on this device, so /home keeps the key and settles it later", remembered !== null && remembered.hashes.includes(HASH) && remembered.sequence === "101");

    // --- the /try page's mint (lib/demo-link.ts) ----------------------------------------------
    console.log("\n[202] the /try page's mint (readDemoLinkReply)");
    const mint202 = readDemoLinkReply(202, JSON.stringify({ error: "submit unconfirmed", hash: HASH }));
    ok("a 202 is a sentence, not a crash and not a link", !mint202.ok && !/undefined|TypeError|reading/.test(mint202.message));
    const good = readDemoLinkReply(
      200,
      JSON.stringify({ balanceId: `00000000${"12".repeat(32)}`, bearerSecret: bearer.secret(), amount: "1", issuer: ISSUER, from: "Lumenia" }),
    );
    ok("a 200 is the claim link: the last 8 of the id, the full id in b, the key after the '#'", good.ok && good.link.startsWith(`/c/${"12".repeat(4)}?b=00000000`) && good.link.includes(`#${bearer.secret()}`));
    ok("a 200 missing its key is a sentence, not a link with a hole in it", !readDemoLinkReply(200, JSON.stringify({ balanceId: `00000000${"12".repeat(32)}`, issuer: ISSUER })).ok);
    const limitedMint = readDemoLinkReply(429, JSON.stringify({ error: "too many demo links from this connection" }));
    ok("a refusal keeps the sponsor's sentence", !limitedMint.ok && /too many demo links/.test(limitedMint.message));
    ok("a page that is not JSON is a sentence too", !readDemoLinkReply(502, "<html>Bad gateway</html>").ok);
    // The event board is the second caller: its links carry seeded=1 and are signed "Lumenia team".
    const board = readDemoLinkReply(
      200,
      JSON.stringify({ balanceId: `00000000${"12".repeat(32)}`, bearerSecret: bearer.secret(), amount: "1", issuer: ISSUER, from: "Lumenia" }),
      { seeded: true, from: "Lumenia team" },
    );
    ok("the event board's link keeps its seeded=1 marker and its own signature", board.ok && board.link.includes("&seeded=1#") && /Lumenia(%20|\+)team/.test(board.link));
    ok("and its 202 is a sentence too, never the TypeError the board used to show", !readDemoLinkReply(202, JSON.stringify({ error: "submit unconfirmed", hash: HASH }), { seeded: true }).ok);
  } finally {
    unhorizon();
  }
}

async function main() {
  console.log("============================================================");
  console.log(" SELF-TEST — claim failure classifier");
  console.log("============================================================\n");

  // --- already claimed, from both ends of runClaim -------------------------------------------
  // Step 1: the account already exists, because this same bearer key claimed once before.
  const existing = classifyClaimError(horizonError(["op_already_exists"]));
  ok("createAccount on an existing account reads as already-claimed", existing.kind === "already-claimed");
  ok("  …and is NOT offered a retry", existing.retryable === false);

  // Step 2: the account was created, but the balance is gone.
  const gone = classifyClaimError(horizonError(["op_does_not_exist"]));
  ok("a claimed-away balance reads as already-claimed", gone.kind === "already-claimed");

  // The same condition seen through the sponsor's /feebump rather than direct submission.
  const viaSponsor = classifyClaimError(
    sponsorError("/feebump", 400, '{"error":"tx_failed: CLAIMABLE_BALANCE_DOES_NOT_EXIST"}'),
  );
  ok("the sponsor reporting the same thing reads as already-claimed", viaSponsor.kind === "already-claimed");

  // --- temporary conditions ------------------------------------------------------------------
  const limited = classifyClaimError(sponsorError("/create-account", 429, "rate limit exceeded"));
  ok("a 429 reads as busy", limited.kind === "busy");
  ok("  …and IS retryable (waiting genuinely works)", limited.retryable === true);

  const halted = classifyClaimError(sponsorError("/feebump", 503, '{"error":"halted"}'));
  ok("a 503 reads as paused", halted.kind === "paused");
  ok("  …and is not retryable right now", halted.retryable === false);

  const offline = classifyClaimError(new TypeError("Failed to fetch"));
  ok("a fetch that never reached a server reads as offline", offline.kind === "offline");
  ok("  …and IS retryable", offline.retryable === true);

  // --- the link itself -----------------------------------------------------------------------
  const noKey = classifyClaimError(new Error("This link is invalid (missing key)."));
  ok("a link with no bearer key reads as link-invalid", noKey.kind === "link-invalid");
  ok("  …and is not retryable", noKey.retryable === false);

  // --- the device refused to sign --------------------------------------------------------------
  // Nothing was signed and nothing moved, so a retry gets the same answer for as long as the
  // server keeps sending it. Landing in "unknown" here handed the recipient a button that could
  // only fail again.
  const refused = classifyClaimError(guardRefusal());
  ok("a tx-guard refusal reads as refused", refused.kind === "refused");
  ok("  …and is NOT offered a retry", refused.retryable === false);

  const wrongAsset = classifyClaimError(
    new Error("This sponsor reports a different dollar asset than this app is built for. Nothing was signed."),
  );
  ok("the /health canary refusal reads as refused too", wrongAsset.kind === "refused");

  // lib/sponsor.ts refuses the 3-op shape when the ledger does not agree the account is there.
  const notOnLedger = classifyClaimError(
    new Error("The server described an account that is not on the ledger, so nothing was signed."),
  );
  ok("a shape whose precondition failed reads as refused", notOnLedger.kind === "refused");
  ok("  …and is NOT offered a retry", notOnLedger.retryable === false);

  // --- a missing trustline is not a claimed balance ---------------------------------------------
  // `op_no_trust` says the destination cannot hold the asset yet — it says nothing about the
  // balance. It was bucketed with already-claimed, which told people they had money they did not.
  const noTrust = classifyClaimError(horizonError(["op_no_trust"]));
  ok("op_no_trust is NOT reported as already-claimed", noTrust.kind !== "already-claimed");
  ok("  …and IS retryable — the retry re-opens the missing trustline", noTrust.retryable === true);

  // --- a group claim the escrow refused ----------------------------------------------------------
  // The relayer reads the contract error out of the result meta and sends a stable token. Before
  // that existed every one of these arrived as the literal string "v2-claim tx FAILED", landed in
  // the fallback as unknown/retryable, and handed a room full of students a retry button that mints
  // a fresh sponsored account per tap for an answer that cannot change.
  const shareTaken = classifyClaimError(
    sponsorError("/v2-claim", 400, '{"error":"group-claim-failed: already-claimed-this"}'),
  );
  ok("a payout that already holds a share reads as already-yours", shareTaken.kind === "already-yours");
  ok("  ...and is NOT offered a retry", shareTaken.retryable === false);

  const empty = classifyClaimError(sponsorError("/v2-claim", 400, '{"error":"group-claim-failed: drop-empty"}'));
  ok("an exhausted pool reads as pool-empty", empty.kind === "pool-empty");
  ok("  ...and is NOT offered a retry", empty.retryable === false);
  ok("  ...and is not misread as the single-link already-claimed", empty.kind !== "already-claimed");

  const closed = classifyClaimError(sponsorError("/v2-claim", 400, '{"error":"group-claim-failed: expired"}'));
  ok("a closed link reads as expired", closed.kind === "expired");
  ok("  ...and is NOT offered a retry", closed.retryable === false);

  const mismatch = classifyClaimError(sponsorError("/v2-claim", 400, '{"error":"group-claim-failed: bad-link-key"}'));
  ok("a signature the escrow would not accept reads as link-mismatch", mismatch.kind === "link-mismatch");
  ok("  ...and is NOT offered a retry", mismatch.retryable === false);

  // The token the relayer falls back to when it cannot read the contract code out of the XDR. It
  // still reached the escrow and was still refused, so it is still final.
  const unnamed = classifyClaimError(sponsorError("/v2-claim", 400, '{"error":"group-claim-failed: unknown"}'));
  ok("a refusal we cannot name still reads as a group failure", unnamed.kind === "group-failed");
  ok("  ...and is STILL terminal - the blanket rule", unnamed.retryable === false);

  // Matched by token, not by the prefix: the relayer may send either shape and a missed token is a
  // retry loop.
  const bare = classifyClaimError(sponsorError("/v2-claim", 400, '{"error":"already-claimed-this"}'));
  ok("a bare token, with no prefix, classifies the same", bare.kind === "already-yours");

  // The one rule the demo depends on: not one of them may be retryable.
  const everyGroupToken = [
    "group-claim-failed: drop-empty",
    "group-claim-failed: already-claimed-this",
    "group-claim-failed: expired",
    "group-claim-failed: bad-link-key",
    "group-claim-failed: unknown",
  ].map((t) => classifyClaimError(sponsorError("/v2-claim", 400, `{"error":"${t}"}`)));
  ok("NO group-claim refusal is retryable", everyGroupToken.every((i) => i.retryable === false));
  ok("  ...and each one gets its own answer", new Set(everyGroupToken.map((i) => i.kind)).size === 5);
  ok("  ...and each one has words to show", everyGroupToken.every((i) => i.detail.length > 0));

  // A single-link failure must not be swept into the group rule - the single path's unknown errors
  // stay retryable, because there nothing was created before the escrow was asked.
  const singleUnknown = classifyClaimError(sponsorError("/v2-claim", 400, "v2-claim tx FAILED"));
  ok("a single-link failure is not classified as a group refusal", singleUnknown.retryable === true);

  // --- the claim nobody can answer yet -------------------------------------------------------
  // The relayer gives up watching after about a minute while the transaction keeps its full validity
  // window. That is neither a refusal nor a success, and the tap it used to invite presented a fresh
  // payout address the contract's per-payout dedupe could not recognise.
  const unconfirmed = classifyClaimError(sponsorError("/v2-claim", 500, "v2-claim tx NOT_FOUND"));
  ok("a claim the relayer stopped watching reads as uncertain", unconfirmed.kind === "uncertain");
  ok("  ...and is NOT offered a retry", unconfirmed.retryable === false);
  ok("  ...and never says the money arrived", unconfirmed.kind !== "already-claimed" && unconfirmed.kind !== "already-yours");
  ok("  ...and tells the person what to do instead", /open the link again/i.test(unconfirmed.detail));

  // The settle's other verdict (lib/lumendrop.ts settleUnconfirmedClaim): the claim transaction
  // itself was refused, or can no longer land. Nothing left the escrow for it, and a retry asks the
  // escrow first with the same payout, so this one IS offered a button.
  const notLanded = classifyClaimError(
    new Error(`v2-claim did not go through (tx ${"ab".repeat(32)}): the network refused it or its window closed`),
  );
  ok("a claim the ledger refused, or that can no longer land, is retryable", notLanded.retryable === true);
  ok("  ...and is not read as uncertain or as already claimed", notLanded.kind !== "uncertain" && notLanded.kind !== "already-claimed");

  // --- three waits, three kinds (they all used to read "We've paused claiming for a short while") ---
  // The sponsor's day limits (D3 item b): a published rule, forwarded in its own words, and nothing
  // to retry until tomorrow.
  const feeBudget = classifyClaimError(
    sponsorError("/v2-claim", 400, '{"error":"today\'s sponsor fee budget is spent; try again tomorrow"}'),
  );
  ok("the fee budget refusal reads as a day limit", feeBudget.kind === "day-limit");
  ok("  ...in the sponsor's own words", /fee budget is spent/.test(feeBudget.detail));
  ok("  ...and is NOT retryable (tomorrow is not a button)", feeBudget.retryable === false);
  const onboardingBudget = classifyClaimError(
    sponsorError("/create-account", 400, '{"error":"new accounts are paused for today - the limit of 40 a day is reached; try again tomorrow"}'),
  );
  ok("the day's new-account limit is a day limit too, not a pause", onboardingBudget.kind === "day-limit" && onboardingBudget.retryable === false);
  // The relay's 503 when the RPC declined to queue: a short wait that IS worth a button.
  const busyRelay = classifyClaimError(sponsorError("/v2-claim", 503, '{"error":"the network is busy; try again shortly"}'));
  ok("a busy network (the relay's 503) reads as network-busy, and IS retryable", busyRelay.kind === "network-busy" && busyRelay.retryable === true);
  // The operator's halt, in the Worker's own words (apps/sponsor/src/worker.ts).
  const operatorHalt = classifyClaimError(sponsorError("/v2-claim", 503, '{"error":"sponsor temporarily halted"}'));
  ok("the operator's halt reads as paused, with no button", operatorHalt.kind === "paused" && operatorHalt.retryable === false);
  ok("  ...and the three waits are three different kinds", new Set([feeBudget.kind, busyRelay.kind, operatorHalt.kind]).size === 3);

  // --- the fallback --------------------------------------------------------------------------
  const weird = classifyClaimError(new Error("something nobody has seen before"));
  ok("an unrecognised error falls back to unknown", weird.kind === "unknown");
  ok("  …and stays RETRYABLE — 'try again' is safe advice when we don't know", weird.retryable === true);

  // A 500 carries no code we recognise, so it must not be mistaken for a known cause.
  const server500 = classifyClaimError(sponsorError("/feebump", 500, "internal error"));
  ok("a bare 500 is not misread as already-claimed", server500.kind !== "already-claimed");

  // --- it must never throw, whatever it is handed --------------------------------------------
  let survived = true;
  const nasty: unknown[] = [
    null,
    undefined,
    "just a string",
    42,
    { response: { data: { get extras(): never { throw new Error("boom"); } } } },
    (() => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      return { response: { status: 400, data: circular } };
    })(),
  ];
  for (const value of nasty) {
    try {
      classifyClaimError(value);
    } catch {
      survived = false;
    }
  }
  ok("never throws — it runs inside the claim's own catch block", survived);

  // --- the detail is safe to put on screen ---------------------------------------------------
  // A bearer key is an S-prefixed StrKey. If one ever reached the error path, the detail we render
  // (and log) must not carry it onward.
  const withSecret = classifyClaimError(
    new Error("/feebump → 400: signing failed for SBUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJ"),
  );
  ok("the shown detail carries no S… bearer key", !/\bS[A-Z2-7]{55}\b/.test(withSecret.detail));

  await realPaths();

  console.log(`\n${failed === 0 ? "✅" : "❌"} CLAIM-ERROR SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
