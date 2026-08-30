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
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { classifyClaimError } from "./claim-error";
import { assertSponsoredOnboarding } from "./tx-guard";

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

function main() {
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

  console.log(`\n${failed === 0 ? "✅" : "❌"} CLAIM-ERROR SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

main();
