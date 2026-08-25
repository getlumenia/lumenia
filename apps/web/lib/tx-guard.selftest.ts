/**
 * ============================================================================
 *  SELF-TEST — what this device is willing to sign
 * ============================================================================
 *
 *  THE BUG THIS FILE EXISTS BECAUSE OF. The guard checked `startingBalance !== "0"`. A transaction
 *  is built with the string "0", serialised to XDR as stroops, and parsed back as "0.0000000" — so
 *  that comparison was never equal on the wire, and from the day the guard shipped (2026-08-08) it
 *  refused every honest claim with "the server sent back something this app did not ask for". The
 *  identical mistake sat one check below with the sign reversed (`limit === "0"`), where instead of
 *  breaking the product it quietly disabled the trustline-deletion refusal.
 *
 *  Neither was catchable by inspection, and neither is catchable by a test that builds a
 *  Transaction in memory and passes the object straight to the guard: in memory the amounts are
 *  still the strings you typed. So EVERY case below goes through XDR first — `toXDR()` then
 *  `fromXDR()` — because that is the only form the browser ever sees.
 *
 *  RUN: pnpm --filter @lumenia/web test:txguard   (no network)
 * ============================================================================
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
import { assertSponsoredOnboarding, assertHealthMatchesPin, pinnedUsdcIssuer } from "./tx-guard";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "✔" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  cond ? passed++ : failed++;
}

const NET = "testnet" as const;
const ISSUER = pinnedUsdcIssuer(NET);
const USDC = new Asset("USDC", ISSUER);

const me = Keypair.random().publicKey();
const sponsor = Keypair.random().publicKey();
const channel = Keypair.random().publicKey();

interface Shape {
  /** Who sources the transaction — the sponsor, a leased channel, or (hostile) us. */
  txSource?: string;
  sponsoredId?: string;
  destination?: string;
  startingBalance?: string;
  trustAsset?: Asset;
  trustLimit?: string;
  trustSource?: string;
  endSource?: string;
  extraOp?: boolean;
  dropOp?: boolean;
}

/**
 * Build the onboarding sandwich exactly the way apps/sponsor/src/lib/create-account.ts does, then
 * put it through XDR — which is where the amounts stop being the strings we typed.
 */
function sandwich(shape: Shape = {}): Transaction {
  const source = new Account(shape.txSource ?? channel, "1");
  const builder = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.beginSponsoringFutureReserves({ sponsoredId: shape.sponsoredId ?? me, source: sponsor }),
    )
    .addOperation(
      Operation.createAccount({
        destination: shape.destination ?? me,
        startingBalance: shape.startingBalance ?? "0",
        source: sponsor,
      }),
    );
  if (!shape.dropOp) {
    builder.addOperation(
      Operation.changeTrust({
        asset: shape.trustAsset ?? USDC,
        ...(shape.trustLimit !== undefined ? { limit: shape.trustLimit } : {}),
        source: shape.trustSource ?? me,
      }),
    );
  }
  builder.addOperation(Operation.endSponsoringFutureReserves({ source: shape.endSource ?? me }));
  if (shape.extraOp) {
    builder.addOperation(Operation.payment({ destination: sponsor, asset: USDC, amount: "1", source: me }));
  }
  const tx = builder.setTimeout(180).build();
  // THE STEP THAT MATTERS: only the round-tripped form is what the browser is asked to sign.
  return TransactionBuilder.fromXDR(tx.toXDR(), Networks.TESTNET) as Transaction;
}

function accepts(tx: Transaction): boolean {
  try {
    assertSponsoredOnboarding(tx, me, NET);
    return true;
  } catch {
    return false;
  }
}

console.log("============================================================");
console.log(" TX-GUARD SELF-TEST — every case parsed from real XDR");
console.log("============================================================\n");

console.log("[1] the honest sandwich");
ok("accepts what /create-account actually sends", accepts(sandwich()));
ok("accepts it when the sponsor itself sources the tx", accepts(sandwich({ txSource: sponsor })));
// The regression in one line: "0" arrives as "0.0000000", and the guard used to compare strings.
ok(
  "accepts a startingBalance that came back as 0.0000000",
  (sandwich().operations[1] as { startingBalance?: string }).startingBalance === "0.0000000",
  "this is the exact value the old check refused",
);

console.log("\n[2] the sponsor may not spend what is ours");
ok("refuses a tx sourced by us (our sequence, our fee)", !accepts(sandwich({ txSource: me })));
ok("refuses changeTrust sourced by somebody else", !accepts(sandwich({ trustSource: sponsor })));
ok("refuses endSponsoring sourced by somebody else", !accepts(sandwich({ endSource: sponsor })));

console.log("\n[3] the sandwich must be for US, and empty");
ok("refuses sponsorship of another account", !accepts(sandwich({ sponsoredId: sponsor })));
ok("refuses an account created for somebody else", !accepts(sandwich({ destination: sponsor })));
ok("refuses a funded createAccount", !accepts(sandwich({ startingBalance: "10" })));
ok("refuses even a dusty one", !accepts(sandwich({ startingBalance: "0.0000001" })));

console.log("\n[4] the trustline must be the dollar this build escrows");
ok("refuses another issuer's USDC", !accepts(sandwich({ trustAsset: new Asset("USDC", Keypair.random().publicKey()) })));
ok("refuses a different asset entirely", !accepts(sandwich({ trustAsset: new Asset("EURC", ISSUER) })));
// The twin of the headline bug: written as `limit === "0"` this refusal could never fire, so the
// one hostile shape it names was the one shape it let through.
ok("refuses a limit of zero, which DELETES a trustline", !accepts(sandwich({ trustLimit: "0" })));

console.log("\n[5] nothing else may ride along");
ok("refuses a fifth operation", !accepts(sandwich({ extraOp: true })));
ok("refuses a missing operation", !accepts(sandwich({ dropOp: true })));

console.log("\n[6] the /health canary");
ok("accepts the pinned asset", (() => {
  try {
    assertHealthMatchesPin({ usdcCode: "USDC", usdcIssuer: ISSUER }, NET);
    return true;
  } catch {
    return false;
  }
})());
ok("refuses a sponsor reporting another issuer", (() => {
  try {
    assertHealthMatchesPin({ usdcCode: "USDC", usdcIssuer: Keypair.random().publicKey() }, NET);
    return false;
  } catch {
    return true;
  }
})());

console.log(`\n${failed === 0 ? "✅" : "❌"} TX-GUARD SELF-TEST ${passed}/${passed + failed}`);
if (failed > 0) process.exit(1);
