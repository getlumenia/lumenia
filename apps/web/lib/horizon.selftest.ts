/**
 * Horizon read self-test — the pure seams behind "did my money show up?".
 *
 * Both bugs these cover were silent and user-visible. The first: activity matched on the asset
 * CODE alone, so any token calling itself USDC rendered as money. The second: a fresh account's
 * newest ledger effects are its CREATION effects, so filtering an 8-row window returned nothing
 * and /account said "No money in or out yet" while the balance above it said $20.
 *
 * mergeActivity carries the third: consolidating a per-link account into home debits one and
 * credits the other for the SAME money, which would read as "Sent $20" beside "Received $20".
 *
 * The claimable-balance reader carries the fourth (D2 private links): the v1 claim page no longer
 * believes an amount written in its URL, it reads the ledger, so the reader must print only the
 * dollar the claim can actually deliver, say "gone" only on a 404, and say "unknown" for anything
 * it could not finish, a read that hangs included. Driven through an injected fetch: no network.
 *
 * RUN: pnpm --filter @lumenia/web test:horizon   (offline, no network)
 */
import {
  claimableAmountFrom,
  isUsdcMovement,
  loadClaimableAmount,
  loadSubmitOutcome,
  mergeActivity,
  toActivityItem,
  type ActivityItem,
} from "./horizon";
import { LEGACY_TESTNET_USDC_ISSUER, USDC_ISSUER, testnetConfig } from "./network";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✔" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  cond ? passed++ : failed++;
}

const ISSUER = "GDO7HI2WKTMDLDG54XKAVE6BTJ5BYXE7PAYQNM5535J2SJNXR334ECYC";
const IMPOSTOR = "GBADIMPOSTORISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const credit = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "e1",
  type: "account_credited",
  asset_code: "USDC",
  asset_issuer: ISSUER,
  amount: "20.0000000",
  created_at: "2026-07-28T10:00:00Z",
  ...over,
});

console.log("============================================================");
console.log(" SELF-TEST — Horizon reads");
console.log("============================================================\n");

console.log("[filter] only the exact dollars this account holds count as money");
{
  ok("a real USDC credit counts", isUsdcMovement(credit(), ISSUER));
  ok("a real USDC debit counts", isUsdcMovement(credit({ type: "account_debited" }), ISSUER));
  ok("a LOOK-ALIKE USDC from another issuer does NOT", !isUsdcMovement(credit({ asset_issuer: IMPOSTOR }), ISSUER));
  ok("XLM does not", !isUsdcMovement(credit({ asset_code: undefined }), ISSUER));

  // The effects that used to fill an 8-row window on a brand-new account.
  for (const t of ["account_created", "trustline_created", "account_sponsorship_created", "signer_created"]) {
    ok(`a ${t} effect is not a movement`, !isUsdcMovement(credit({ type: t }), ISSUER));
  }
}

console.log("\n[map] the ledger effect becomes the row a person reads");
{
  const item = toActivityItem(credit());
  ok("credit maps to 'in'", item.direction === "in");
  ok("debit maps to 'out'", toActivityItem(credit({ type: "account_debited" })).direction === "out");
  ok("amount and time carry over", item.usd === "20.0000000" && item.at === "2026-07-28T10:00:00Z");
}

console.log("\n[merge] several accounts, one honest list");
{
  const home: ActivityItem[] = [
    { id: "h1", direction: "in", usd: "5", at: "2026-07-28T12:00:00Z" },
    { id: "h2", direction: "out", usd: "3", at: "2026-07-28T09:00:00Z" },
  ];
  const link: ActivityItem[] = [
    { id: "l1", direction: "in", usd: "20", at: "2026-07-28T11:00:00Z" },
    // the sweep's other half: the SAME money leaving the throwaway for home
    { id: "l2", direction: "out", usd: "20", at: "2026-07-28T11:00:05Z" },
  ];
  const merged = mergeActivity([{ items: home, isHome: true }, { items: link, isHome: false }], 20);

  ok("newest first", merged.map((m) => m.id).join(",") === "h1,l1,h2", merged.map((m) => m.id).join(","));
  ok("money paid to a per-link account IS shown", merged.some((m) => m.id === "l1"));
  ok(
    "the sweep's phantom 'Sent' is NOT shown (same money, counted once)",
    !merged.some((m) => m.id === "l2"),
  );
  ok("the home account's own outgoing IS shown", merged.some((m) => m.id === "h2"));
  ok("the limit is honoured", mergeActivity([{ items: home, isHome: true }], 1).length === 1);
  ok(
    "duplicate effect ids collapse",
    mergeActivity([{ items: home, isHome: true }, { items: home, isHome: true }], 20).length === 2,
  );
}

console.log("\n[claimable] the v1 claim page prints only what the ledger holds for this link");
const PINNED = USDC_ISSUER.testnet;
const BEARER = "GCLAIMBEARERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const SENDER = "GSENDERRECLAIMXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const BALANCE_ID = "00000000" + "ab".repeat(32);
const record = (over: Partial<Record<string, unknown>> = {}) => ({
  id: BALANCE_ID,
  asset: `USDC:${PINNED}`,
  amount: "0.5000000",
  claimants: [
    { destination: BEARER, predicate: { unconditional: true } },
    { destination: SENDER, predicate: { not: { rel_before: "3600" } } },
  ],
  ...over,
});
{
  const got = claimableAmountFrom(record(), PINNED, BEARER);
  ok("the pinned dollar, claimable by this link's key, is the amount", got.state === "amount" && got.usd === "0.5000000");
  ok("read without a key, the same balance is still the amount", claimableAmountFrom(record(), PINNED).state === "amount");
  ok(
    "a LOOK-ALIKE USDC from another issuer is NOT money",
    claimableAmountFrom(record({ asset: `USDC:${IMPOSTOR}` }), PINNED, BEARER).state === "unknown",
  );
  ok(
    "the RETIRED practice issuer is not money the claim can deliver",
    claimableAmountFrom(record({ asset: `USDC:${LEGACY_TESTNET_USDC_ISSUER}` }), PINNED, BEARER).state === "unknown",
  );
  ok("XLM is not the dollar", claimableAmountFrom(record({ asset: "native" }), PINNED, BEARER).state === "unknown");
  ok(
    "a balance this link's key cannot claim is not 'verified' (somebody else's id, our key)",
    claimableAmountFrom(record(), PINNED, "GSOMEONEELSEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX").state === "unknown",
  );
  ok(
    "the sender's time-locked RECLAIM claim does not count as the link's claim",
    claimableAmountFrom(record(), PINNED, SENDER).state === "unknown",
  );
  for (const amount of ["0.0000000", "-1.0000000", "1e3", "abc", "", "0.12345678", 5]) {
    ok(`amount ${JSON.stringify(amount)} is never printed`, claimableAmountFrom(record({ amount }), PINNED).state === "unknown");
  }
  ok("no record at all is unknown", claimableAmountFrom(null, PINNED).state === "unknown");
}

/** A fetch that answers once with `status` and `body`, and remembers what it was asked. */
function fakeFetch(status: number, body: unknown, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

/* ------------------------------ an unconfirmed submission ------------------------------
 * loadSubmitOutcome is what decides whether a payment the sponsor answered 202 for may be made
 * again ("failed") or must not be ("pending", "unknown"). A wrong "failed" is a second payment, so
 * every path to it is pinned here, against a Horizon played by a fake fetch. */
async function submitOutcomes(): Promise<void> {
  console.log("\n[unconfirmed] what the ledger did with a submission nobody saw decided");
  const SOURCE = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const OUTER = "ab".repeat(32);
  const INNER = "cd".repeat(32);
  const MAX_TIME = 1_800_000_000; // the transaction's own upper time bound, unix seconds
  const iso = (unix: number) => new Date(unix * 1000).toISOString();

  /** Horizon, answered per path: the latest ledger's close time, each hash, the source account. */
  const horizon = (o: {
    closedAt?: number | "error";
    tx?: Record<string, { status: number; successful?: boolean } | "throw">;
    account?: { status: number; sequence?: string } | "throw";
  }) => {
    const seen: string[] = [];
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("/ledgers?")) {
        if (o.closedAt === "error" || o.closedAt === undefined) return new Response("down", { status: 503 });
        return new Response(JSON.stringify({ _embedded: { records: [{ closed_at: iso(o.closedAt) }] } }), { status: 200 });
      }
      const tx = url.match(/\/transactions\/([0-9a-f]+)$/);
      if (tx) {
        const a = o.tx?.[tx[1]!];
        if (a === "throw") throw new TypeError("Failed to fetch");
        if (!a) return new Response(JSON.stringify({ status: 404 }), { status: 404 });
        return new Response(JSON.stringify({ successful: a.successful }), { status: a.status });
      }
      if (url.includes("/accounts/")) {
        const a = o.account;
        if (a === "throw") throw new TypeError("Failed to fetch");
        if (!a) return new Response("{}", { status: 500 });
        return new Response(JSON.stringify(a.sequence !== undefined ? { sequence: a.sequence } : {}), { status: a.status });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    return { impl, seen };
  };
  const check = { hashes: [OUTER, INNER], source: SOURCE, sequence: "101", maxTime: MAX_TIME };
  const NET = { horizonUrl: "https://horizon.invalid/" };
  const outcome = (h: ReturnType<typeof horizon>, c: Partial<typeof check> & { closesSource?: boolean } = {}) =>
    loadSubmitOutcome({ ...check, ...c }, NET, { fetchImpl: h.impl });

  ok("in a ledger and successful: landed", (await outcome(horizon({ closedAt: MAX_TIME, tx: { [OUTER]: { status: 200, successful: true } } }))) === "landed");
  ok("found by OUR hash when the sponsor's is unknown: landed", (await outcome(horizon({ closedAt: MAX_TIME, tx: { [INNER]: { status: 200, successful: true } } }), { hashes: [INNER] })) === "landed");
  ok("in a ledger and failed: failed (nothing it carried moved)", (await outcome(horizon({ tx: { [OUTER]: { status: 200, successful: false } } }))) === "failed");
  ok(
    "not seen, sequence unused, and the ledger is past the time bound plus the margin: failed (it can never land)",
    (await outcome(horizon({ closedAt: MAX_TIME + 61, account: { status: 200, sequence: "100" } }))) === "failed",
  );
  ok(
    "...but NOT inside the margin: a lagging Horizon instance may not have it yet",
    (await outcome(horizon({ closedAt: MAX_TIME + 30, account: { status: 200, sequence: "100" } }))) === "pending",
  );
  ok("not seen and still inside its time bound: pending", (await outcome(horizon({ closedAt: MAX_TIME - 100, account: { status: 200, sequence: "100" } }))) === "pending");
  ok(
    "no ledger time at all: never 'failed' on a guess",
    (await outcome(horizon({ closedAt: "error", account: { status: 200, sequence: "100" } }))) === "pending",
  );
  ok(
    "no upper time bound: never 'failed' by time",
    (await outcome(horizon({ closedAt: MAX_TIME * 2, account: { status: 200, sequence: "100" } }), { maxTime: 0 })) === "pending",
  );
  ok(
    "its sequence number was used and neither hash is known: unknown, never a guess about whose it was",
    (await outcome(horizon({ closedAt: MAX_TIME + 999, account: { status: 200, sequence: "101" } }))) === "unknown",
  );
  ok("the source account unreadable: unknown", (await outcome(horizon({ closedAt: MAX_TIME + 999, account: "throw" }))) === "unknown");
  ok("the source account answering 500: unknown", (await outcome(horizon({ closedAt: MAX_TIME + 999, account: { status: 500 } }))) === "unknown");
  ok("a payer's account that is gone: unknown (a payment does not close its source)", (await outcome(horizon({ closedAt: MAX_TIME + 999, account: { status: 404 } }))) === "unknown");
  ok(
    "a transaction read that fails does not stop the account from answering",
    (await outcome(horizon({ closedAt: MAX_TIME + 61, tx: { [OUTER]: "throw" }, account: { status: 200, sequence: "100" } }))) === "failed",
  );
  // The sweep merges its own source away (closesSource).
  ok("a sweep whose account is gone: landed (that is the merge)", (await outcome(horizon({ account: { status: 404 } }), { closesSource: true })) === "landed");
  ok(
    "a sweep whose account is still there with its sequence used: failed (it did not land)",
    (await outcome(horizon({ closedAt: MAX_TIME - 100, account: { status: 200, sequence: "101" } }), { closesSource: true })) === "failed",
  );
  {
    const h = horizon({ closedAt: MAX_TIME, account: { status: 200, sequence: "100" } });
    await outcome(h);
    ok("the ledger is read FIRST, then the hashes, then the account", h.seen[0]?.includes("/ledgers?order=desc&limit=1") === true && h.seen[h.seen.length - 1]?.includes(`/accounts/${SOURCE}`) === true, h.seen.join(" | "));
    ok("...against the network it was given, with no double slash", h.seen.every((u) => u.startsWith("https://horizon.invalid/") && !u.includes(".invalid//")));
  }
}

async function main() {
  console.log("\n[claimable] the read itself: amount | gone (404 only) | unknown (everything else)");
  const NET = testnetConfig();
  {
    const seen: string[] = [];
    const got = await loadClaimableAmount(BALANCE_ID, NET, { claimant: BEARER, fetchImpl: fakeFetch(200, record(), seen) });
    ok("200 with the pinned dollar is the amount", got.state === "amount" && got.usd === "0.5000000");
    ok(
      "it asks the TEST network's Horizon for exactly this balance",
      seen.length === 1 && seen[0] === `${NET.horizonUrl.replace(/\/$/, "")}/claimable_balances/${BALANCE_ID}`,
      seen[0],
    );
  }
  ok("404 is gone", (await loadClaimableAmount(BALANCE_ID, NET, { fetchImpl: fakeFetch(404, { status: 404 }) })).state === "gone");
  for (const status of [400, 429, 500, 503]) {
    ok(
      `${status} is unknown, never gone`,
      (await loadClaimableAmount(BALANCE_ID, NET, { fetchImpl: fakeFetch(status, { status }) })).state === "unknown",
    );
  }
  ok(
    "a look-alike asset over the wire is unknown",
    (await loadClaimableAmount(BALANCE_ID, NET, { fetchImpl: fakeFetch(200, record({ asset: `USDC:${IMPOSTOR}` })) }))
      .state === "unknown",
  );
  ok(
    "a body that is not JSON is unknown",
    (await loadClaimableAmount(BALANCE_ID, NET, { fetchImpl: fakeFetch(200, "<html>oops</html>") })).state === "unknown",
  );
  {
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    ok("offline (fetch rejects) is unknown", (await loadClaimableAmount(BALANCE_ID, NET, { fetchImpl: offline })).state === "unknown");
  }
  {
    // A Horizon that never answers: the read must give up and say unknown, not spin forever.
    const hang = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const t0 = Date.now();
    const got = await loadClaimableAmount(BALANCE_ID, NET, { fetchImpl: hang, timeoutMs: 50 });
    const ms = Date.now() - t0;
    ok("a read that hangs is abandoned as unknown", got.state === "unknown" && ms < 2_000, `${ms} ms`);
  }
  {
    const seen: string[] = [];
    const got = await loadClaimableAmount("", NET, { fetchImpl: fakeFetch(200, record(), seen) });
    ok("no balance id is unknown, and nothing is asked", got.state === "unknown" && seen.length === 0);
  }
  {
    const seen: string[] = [];
    await loadClaimableAmount("../accounts/x?y", NET, { fetchImpl: fakeFetch(404, {}, seen) });
    ok(
      "a hostile id stays one path segment",
      seen[0]?.endsWith("/claimable_balances/..%2Faccounts%2Fx%3Fy") === true,
      seen[0],
    );
  }

  await submitOutcomes();

  console.log(`\n${failed === 0 ? "✅" : "❌"} HORIZON SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
