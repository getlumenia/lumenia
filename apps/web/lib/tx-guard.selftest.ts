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
import {
  assertSponsoredOnboarding,
  assertSponsoredTrustline,
  assertHealthMatchesPin,
  pinnedUsdcIssuer,
} from "./tx-guard";

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
  beginSource?: string;
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

console.log("\n[6] the 3-op trustline, for an account that already exists");

/** The same sandwich minus createAccount, round-tripped through XDR like everything else here. */
function trustlineOnly(shape: Shape = {}): Transaction {
  const source = new Account(shape.txSource ?? channel, "1");
  const b = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        sponsoredId: shape.sponsoredId ?? me,
        source: shape.beginSource ?? sponsor,
      }),
    )
    .addOperation(
      Operation.changeTrust({
        asset: shape.trustAsset ?? USDC,
        ...(shape.trustLimit !== undefined ? { limit: shape.trustLimit } : {}),
        source: shape.trustSource ?? me,
      }),
    )
    .addOperation(Operation.endSponsoringFutureReserves({ source: shape.endSource ?? me }));
  if (shape.extraOp) {
    b.addOperation(Operation.payment({ destination: sponsor, asset: USDC, amount: "1", source: me }));
  }
  const tx = b.setTimeout(180).build();
  return TransactionBuilder.fromXDR(tx.toXDR(), Networks.TESTNET) as Transaction;
}

function acceptsTrustline(tx: Transaction): boolean {
  try {
    assertSponsoredTrustline(tx, me, NET);
    return true;
  } catch {
    return false;
  }
}

ok("accepts the three-op trustline", acceptsTrustline(trustlineOnly()));
ok("refuses a tx sourced by us", !acceptsTrustline(trustlineOnly({ txSource: me })));
ok("refuses sponsorship of another account", !acceptsTrustline(trustlineOnly({ sponsoredId: sponsor })));
ok("refuses changeTrust sourced by somebody else", !acceptsTrustline(trustlineOnly({ trustSource: sponsor })));
ok("refuses another issuer", !acceptsTrustline(trustlineOnly({ trustAsset: new Asset("USDC", Keypair.random().publicKey()) })));
ok("refuses a zero limit (that deletes a trustline)", !acceptsTrustline(trustlineOnly({ trustLimit: "0" })));
ok("refuses a fourth operation", !acceptsTrustline(trustlineOnly({ extraOp: true })));
/* The two shapes must not be interchangeable. Each caller establishes the precondition for the
   shape it expects — the account is on-ledger, or it is not — and then gets that whole contract
   enforced; neither guard may stand in for the other. */
ok("the onboarding guard rejects the three-op shape", !accepts(trustlineOnly()));
ok("the trustline guard rejects the four-op shape", !acceptsTrustline(sandwich()));

/* The claim path reaches this shape on any retry after the account was already onboarded, so
   "three ops" is no longer a shape only one screen can see. Everything a hostile server could put
   in three ops has to bounce off the same wall the four-op sandwich has. */
ok("refuses beginSponsoring sourced by us", !acceptsTrustline(trustlineOnly({ beginSource: me })));
ok("refuses endSponsoring sourced by somebody else", !acceptsTrustline(trustlineOnly({ endSource: sponsor })));
// The same round-trip trap as startingBalance: the default limit is not the string it was built as.
ok(
  "accepts a default limit that came back as 922337203685.4775807",
  (trustlineOnly().operations[1] as { limit?: string }).limit === "922337203685.4775807",
  "compared by value, never as a string",
);

/** Three ops that are NOT the trustline sandwich — same length, entirely different intent. */
function threeHostileOps(middle: Parameters<TransactionBuilder["addOperation"]>[0]): Transaction {
  const b = new TransactionBuilder(new Account(channel, "1"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: me, source: sponsor }))
    .addOperation(middle)
    .addOperation(Operation.endSponsoringFutureReserves({ source: me }));
  const tx = b.setTimeout(180).build();
  return TransactionBuilder.fromXDR(tx.toXDR(), Networks.TESTNET) as Transaction;
}

ok(
  "refuses three ops whose middle one drains us",
  !acceptsTrustline(
    threeHostileOps(Operation.payment({ destination: sponsor, asset: USDC, amount: "100", source: me })),
  ),
);
ok(
  "refuses three ops that hand our account to somebody else",
  !acceptsTrustline(
    threeHostileOps(Operation.setOptions({ signer: { ed25519PublicKey: sponsor, weight: 255 }, source: me })),
  ),
);
ok("refuses a two-op shape", !acceptsTrustline(
  (() => {
    const tx = new TransactionBuilder(new Account(channel, "1"), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: me, source: sponsor }))
      .addOperation(Operation.changeTrust({ asset: USDC, source: me }))
      .setTimeout(180)
      .build();
    return TransactionBuilder.fromXDR(tx.toXDR(), Networks.TESTNET) as Transaction;
  })(),
));

console.log("\n[7] the /health canary");
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
