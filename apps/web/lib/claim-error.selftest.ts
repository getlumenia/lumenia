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
 *   - an unrecognised error falls back to retryable (safe advice when we do not know)
 *   - the classifier never throws, whatever it is handed
 *   - the detail string never leaks a bearer key
 *
 * RUN: pnpm --filter @lumenia/web test:claimerr   (offline, no keys, no network)
 */
import { classifyClaimError } from "./claim-error";

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
