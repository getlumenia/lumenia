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
import { parsePaymentUri } from "./payout";
import { USDC_ISSUER } from "./network";

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
