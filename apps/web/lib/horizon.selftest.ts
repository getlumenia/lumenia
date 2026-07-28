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
 * RUN: pnpm --filter @lumenia/web test:horizon   (offline, no network)
 */
import { isUsdcMovement, toActivityItem, mergeActivity, type ActivityItem } from "./horizon";

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

console.log(`\n${failed === 0 ? "✅" : "❌"} HORIZON SELF-TEST ${passed}/${passed + failed}`);
if (failed > 0) process.exit(1);
