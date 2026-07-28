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
import { buildReceiveUri, moneyOrigin, NETWORK_LABEL, shortAddress } from "./receive";
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

console.log(`\n${failed === 0 ? "✅" : "❌"} RECEIVE SELF-TEST ${passed}/${passed + failed}`);
if (failed > 0) process.exit(1);
