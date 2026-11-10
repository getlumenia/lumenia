/**
 * Receive self-test — the invariants of /add-money, checked against the app's OWN parser.
 *
 * The screen makes two promises that a comment cannot enforce:
 *   1. the code you show somebody NEVER asks for a memo (the whole correction the page teaches);
 *   2. we never claim to hold real money when we are holding practice money.
 *
 * The round-trip runs buildReceiveUri's output back through parsePaymentUri from lib/payout.ts —
 * the same parser /send-out uses on a pasted deposit link. So this proves the two halves of the
 * product agree, rather than proving a regex agrees with itself.
 *
 * RUN: pnpm --filter @lumenia/web test:receive   (offline, no keys)
 */
import { buildReceiveUri, getTestMoney, moneyOrigin, NETWORK_LABEL, shortAddress } from "./receive";
import { parsePaymentUri, payoutMemo } from "./payout";
import { USDC_ISSUER } from "./network";
import { Account, MuxedAccount, type Memo } from "@stellar/stellar-sdk";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✔" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  cond ? passed++ : failed++;
}

const ADDRESS = "GDQFGINJ4PMEX4GN53OHFFO657P5APN5BYEEDKRTNYC74FXUBCQTXDLL";
const TEST_ISSUER = "GDO7HI2WKTMDLDG54XKAVE6BTJ5BYXE7PAYQNM5535J2SJNXR334ECYC";

console.log("============================================================");
console.log(" SELF-TEST — receiving money (/add-money)");
console.log("============================================================\n");

console.log("[uri] SEP-7 round-trip through the app's own parser");
{
  const uri = buildReceiveUri({ address: ADDRESS, assetCode: "USDC", assetIssuer: TEST_ISSUER });
  const parsed = parsePaymentUri(uri);
  ok("the URI parses at all (it is a real web+stellar:pay)", parsed !== null, uri.slice(0, 40) + "…");
  ok("destination survives the round-trip", parsed?.destination === ADDRESS);
  ok("asset code survives", parsed?.assetCode === "USDC");
  ok("ISSUER survives — a scanning wallet cannot send a look-alike token", parsed?.assetIssuer === TEST_ISSUER);

  // The invariant of the whole screen.
  ok("NO memo is ever set (an account of your own needs none)", !uri.includes("memo") && parsed?.memo === undefined);

  const withAmount = buildReceiveUri({ address: ADDRESS, assetCode: "USDC", assetIssuer: TEST_ISSUER, amount: "12.50" });
  ok("an optional amount round-trips", parsePaymentUri(withAmount)?.amount === "12.50");
  ok("...and still carries no memo", !withAmount.includes("memo"));
}

console.log("\n[origin] practice money vs real money");
{
  ok("our test issuer reads as practice money", moneyOrigin(TEST_ISSUER) === "test");
  ok("Circle's mainnet issuer reads as real money", moneyOrigin(USDC_ISSUER.public) === "real");
  ok("an UNKNOWN issuer fails safe to practice money", moneyOrigin("GSOMETHINGELSE") === "test");
  ok("a missing issuer fails safe to practice money", moneyOrigin(undefined) === "test" && moneyOrigin(null) === "test");
  ok("each state has a network name an exchange would recognise", NETWORK_LABEL.real.includes("Stellar") && NETWORK_LABEL.test.includes("Stellar"));
}

console.log("\n[display] the short form is never the thing you copy");
{
  const short = shortAddress(ADDRESS);
  ok("shortened for display", short.length < ADDRESS.length && short.includes("…"));
  ok("a non-address passes through untouched", shortAddress("not-an-address") === "not-an-address");
}

console.log("\n[memo] the reference tag a cash-out carries, decided before anything is signed (lib/payout.ts)");
{
  const MUXED = new MuxedAccount(new Account(ADDRESS, "0"), "104882913").accountId();
  const carried = (m: Memo | null) => (m ? `${m.type}:${String(m.value)}` : "no memo");
  const refusal = (input: Parameters<typeof payoutMemo>[0]): string | null => {
    try {
      payoutMemo(input);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  const plain = /^[A-Z][^{}<>]{6,200}[.!?]$/;
  ok("a typed tag, letters and numbers: a text memo", carried(payoutMemo({ destination: ADDRESS, memo: "104882913", memoKind: "text" })) === "text:104882913");
  ok("a typed tag, numbers only: an id memo", carried(payoutMemo({ destination: ADDRESS, memo: "104882913", memoKind: "id" })) === "id:104882913");
  const none = refusal({ destination: ADDRESS, memo: "104882913", memoKind: "none" });
  ok("a typed tag with kind none is REFUSED, never dropped (the saved-muxed-destination bug)", none !== null);
  ok("  ...with a plain sentence that says nothing left", none !== null && plain.test(none) && /Nothing left/.test(none), none ?? "");
  ok("a typed tag with no kind at all is refused the same way", refusal({ destination: ADDRESS, memo: "104882913" }) !== null);
  ok("no tag on a plain address: no memo (whether one was required is the screen's check)", payoutMemo({ destination: ADDRESS, memoKind: "text" }) === null);
  ok("an empty tag with kind none is no memo, not a refusal", payoutMemo({ destination: ADDRESS, memo: "", memoKind: "none" }) === null);
  ok("a muxed address with no tag: no memo, the address carries its own", payoutMemo({ destination: MUXED, memoKind: "none" }) === null);
  const second = refusal({ destination: MUXED, memo: "104882913", memoKind: "text" });
  ok("a muxed address WITH a typed tag is refused: never a second tag, never a silent drop", second !== null && plain.test(second), second ?? "");
  ok("a numbers-only tag that is not a number is refused, not sent as text", refusal({ destination: ADDRESS, memo: "abc", memoKind: "id" }) !== null);
  ok("a text tag over 28 bytes is refused", refusal({ destination: ADDRESS, memo: "x".repeat(29), memoKind: "text" }) !== null);
  ok("a text tag of exactly 28 bytes is sent", carried(payoutMemo({ destination: ADDRESS, memo: "x".repeat(28), memoKind: "text" })) === `text:${"x".repeat(28)}`);
}

/* The faucet's answers, scripted: a 202 is only "added" once the ledger shows the payment. */
async function faucetCases(): Promise<void> {
  console.log("\n[faucet] a 202 is not 'added' until the testnet ledger shows the payment");
  const HASH = "a".repeat(64);
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const run = async (faucet: Response, ledger: Array<Response | "down">) => {
    const calls: string[] = [];
    const fetchFake = async (input: string) => {
      calls.push(input);
      if (input.endsWith("/faucet")) return faucet;
      const next = ledger.shift() ?? reply(404, {});
      if (next === "down") throw new Error("offline");
      return next;
    };
    try {
      await getTestMoney("https://sponsor.test/", ADDRESS, { fetch: fetchFake, sleep: async () => {}, horizonUrl: "https://horizon.test", waitMs: 9_000 });
      return { ok: true as const, calls };
    } catch (e) {
      return { ok: false as const, message: (e as Error).message, calls };
    }
  };
  const plain = /^[A-Z][^{}<>]{6,200}[.!?]$/;
  const a = await run(reply(200, { hash: HASH, ledger: 1, amount: "1" }), []);
  ok("a 200 is added, with no ledger lookup", a.ok && a.calls.length === 1);
  const b = await run(reply(202, { error: "submit unconfirmed", hash: HASH }), [reply(404, {}), reply(200, { successful: true })]);
  ok("a 202 whose payment lands a moment later is added", b.ok && b.calls.some((c) => c.endsWith(`/transactions/${HASH}`)));
  const c = await run(reply(202, { error: "submit unconfirmed", hash: HASH }), []);
  ok("a 202 whose payment never shows up is a failure, never 'added'", !c.ok);
  ok("its message is a plain sentence the screens can show", !c.ok && plain.test(c.message), c.ok ? "" : c.message);
  ok("it looks for a bounded time (4 looks in 9 s at one every 3 s)", c.calls.filter((x) => x.includes("/transactions/")).length === 4, String(c.calls.length));
  const d = await run(reply(202, { error: "submit unconfirmed", hash: HASH }), [reply(200, { successful: false })]);
  ok("a 202 whose payment failed on the ledger is a failure", !d.ok);
  const e = await run(reply(202, { error: "submit unconfirmed" }), []);
  ok("a 202 with no hash to look up is a failure", !e.ok && e.calls.length === 1);
  const f = await run(reply(202, { error: "submit unconfirmed", hash: HASH }), ["down", reply(200, { successful: true })]);
  ok("a ledger lookup that cannot connect is asked again", f.ok);
  const g = await run(reply(500, { error: "recipient has no USDC trustline (create the account first)" }), []);
  ok("a refusal still carries the sponsor's own reason", !g.ok && /trustline/.test(g.message));
}

void (async () => {
  await faucetCases();
  console.log(`\n${failed === 0 ? "✅" : "❌"} RECEIVE SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
})();
