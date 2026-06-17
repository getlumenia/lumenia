/**
 * ============================================================================
 *  TEST — anti-drain validator (canonical, packages/shared)
 * ============================================================================
 *
 *  Addresses the code-review finding (Tyler + Elliot): op-type allowlisting is
 *  not enough; the validator must check op SOURCE and sensitive PARAMETERS.
 *  These cases prove the hardened validator accepts the legit claim shape and
 *  rejects every reserve/principal drain vector we could think of.
 *
 *  RUN (CJS context, avoids the stellar-sdk@16 ESM/tsx issue):
 *    pnpm --filter @lumenia/sponsor exec tsx src/test-antidrain.ts
 *
 *  No network required — txs are built in memory and validated.
 * ============================================================================
 */

import assert from "node:assert/strict";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";
// canonical validator (relative import — no workspace symlink needed)
import { validateInnerTransaction, type InnerTxPolicy } from "../../../packages/shared/src/index";

const NETWORK = Networks.TESTNET;

const recipient = Keypair.random();
const sponsor = Keypair.random();
const issuer = Keypair.random();
const attacker = Keypair.random();
const anchor = Keypair.random(); // an allow-listed payment destination

const USDC = new Asset("USDC", issuer.publicKey());
const WRONG = new Asset("DAI", issuer.publicKey());
const BALANCE_ID = "00000000" + "ab".repeat(32); // valid CB id shape (8 + 64 hex)
const OTHER_BALANCE_ID = "00000000" + "cd".repeat(32);

const basePolicy: InnerTxPolicy = {
  expectedSource: recipient.publicKey(),
  sponsor: sponsor.publicKey(),
  expectedAsset: USDC,
  expectedBalanceId: BALANCE_ID,
  maxOps: 6,
};

/** Build a Transaction with the given ops, sourced by `source`. (in-memory, no network) */
function buildTx(sourcePub: string, ops: xdr.Operation[]): Transaction {
  const acc = new Account(sourcePub, "123456789"); // fake sequence; we never submit
  const b = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK });
  for (const op of ops) b.addOperation(op);
  return b.setTimeout(180).build();
}

let passed = 0;
let failed = 0;

function check(name: string, got: { ok: boolean; reason?: string }, wantOk: boolean, reasonIncludes?: string) {
  try {
    assert.equal(got.ok, wantOk, `${name}: expected ok=${wantOk}, got ok=${got.ok} (${got.reason ?? ""})`);
    if (!wantOk && reasonIncludes) {
      assert.ok(
        (got.reason ?? "").toLowerCase().includes(reasonIncludes.toLowerCase()),
        `${name}: reason "${got.reason}" should include "${reasonIncludes}"`,
      );
    }
    console.log(`  ✔ ${name}${wantOk ? "" : `  → rejected: "${got.reason}"`}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

console.log("============================================================");
console.log(" TEST — anti-drain validator (hardened)");
console.log("============================================================\n");

/* ---- POSITIVE: the real claim inner tx (recipient-sourced) ---- */
check(
  "G1 legit claim (recipient source, correct balanceId)",
  validateInnerTransaction(buildTx(recipient.publicKey(), [Operation.claimClaimableBalance({ balanceId: BALANCE_ID })]), basePolicy),
  true,
);

/* ---- POSITIVE: combined onboarding+claim defense shape ---- */
check(
  "G2 combined sponsored shape (begin/create0/changeTrust/end/claim)",
  validateInnerTransaction(
    buildTx(recipient.publicKey(), [
      Operation.beginSponsoringFutureReserves({ sponsoredId: recipient.publicKey(), source: sponsor.publicKey() }),
      Operation.createAccount({ destination: recipient.publicKey(), startingBalance: "0", source: sponsor.publicKey() }),
      Operation.changeTrust({ asset: USDC, source: recipient.publicKey() }),
      Operation.endSponsoringFutureReserves({ source: recipient.publicKey() }),
      Operation.claimClaimableBalance({ balanceId: BALANCE_ID }),
    ]),
    basePolicy,
  ),
  true,
);

/* ---- POSITIVE: claim + payment to an allow-listed destination ---- */
check(
  "G3 claim + payment to allow-listed anchor",
  validateInnerTransaction(
    buildTx(recipient.publicKey(), [
      Operation.claimClaimableBalance({ balanceId: BALANCE_ID }),
      Operation.payment({ destination: anchor.publicKey(), asset: USDC, amount: "5" }),
    ]),
    { ...basePolicy, allowedPaymentDestinations: new Set([anchor.publicKey()]) },
  ),
  true,
);

/* ---- DRAIN VECTORS (must all be rejected) ---- */

check(
  "R1 wrong tx source (sponsor builds the inner tx)",
  validateInnerTransaction(buildTx(sponsor.publicKey(), [Operation.claimClaimableBalance({ balanceId: BALANCE_ID })]), basePolicy),
  false,
  "unexpected tx source",
);

check(
  "R2 disallowed op type (bumpSequence)",
  validateInnerTransaction(buildTx(recipient.publicKey(), [Operation.bumpSequence({ bumpTo: "999" })]), basePolicy),
  false,
  "disallowed op type",
);

check(
  "R3 claim with wrong balanceId",
  validateInnerTransaction(buildTx(recipient.publicKey(), [Operation.claimClaimableBalance({ balanceId: OTHER_BALANCE_ID })]), basePolicy),
  false,
  "balanceid",
);

check(
  "R4 payment sourced from sponsor (classic drain)",
  validateInnerTransaction(
    buildTx(recipient.publicKey(), [
      Operation.claimClaimableBalance({ balanceId: BALANCE_ID }),
      Operation.payment({ destination: attacker.publicKey(), asset: Asset.native(), amount: "5", source: sponsor.publicKey() }),
    ]),
    basePolicy,
  ),
  false,
  "sponsor",
);

check(
  "R5 payment to non-allow-listed destination (no allowlist set)",
  validateInnerTransaction(
    buildTx(recipient.publicKey(), [
      Operation.claimClaimableBalance({ balanceId: BALANCE_ID }),
      Operation.payment({ destination: attacker.publicKey(), asset: USDC, amount: "5" }),
    ]),
    basePolicy,
  ),
  false,
  "non-allowlisted",
);

check(
  "R6 createAccount with startingBalance > 0 (XLM drain)",
  validateInnerTransaction(
    buildTx(recipient.publicKey(), [
      Operation.beginSponsoringFutureReserves({ sponsoredId: recipient.publicKey(), source: sponsor.publicKey() }),
      Operation.createAccount({ destination: recipient.publicKey(), startingBalance: "100", source: sponsor.publicKey() }),
      Operation.endSponsoringFutureReserves({ source: recipient.publicKey() }),
      Operation.claimClaimableBalance({ balanceId: BALANCE_ID }),
    ]),
    basePolicy,
  ),
  false,
  "startingbalance",
);

check(
  "R7 changeTrust sourced from sponsor (reserve drain)",
  validateInnerTransaction(
    buildTx(recipient.publicKey(), [
      Operation.changeTrust({ asset: USDC, source: sponsor.publicKey() }),
      Operation.claimClaimableBalance({ balanceId: BALANCE_ID }),
    ]),
    basePolicy,
  ),
  false,
  "sponsor",
);

check(
  "R8 changeTrust with wrong asset",
  validateInnerTransaction(
    buildTx(recipient.publicKey(), [
      Operation.changeTrust({ asset: WRONG, source: recipient.publicKey() }),
      Operation.claimClaimableBalance({ balanceId: BALANCE_ID }),
    ]),
    basePolicy,
  ),
  false,
  "expected asset",
);

check(
  "R9 too many ops",
  validateInnerTransaction(
    buildTx(
      recipient.publicKey(),
      Array.from({ length: 7 }, () => Operation.claimClaimableBalance({ balanceId: BALANCE_ID })),
    ),
    basePolicy,
  ),
  false,
  "too many ops",
);

check(
  "R10 createAccount destination != recipient",
  validateInnerTransaction(
    buildTx(recipient.publicKey(), [
      Operation.beginSponsoringFutureReserves({ sponsoredId: recipient.publicKey(), source: sponsor.publicKey() }),
      Operation.createAccount({ destination: attacker.publicKey(), startingBalance: "0", source: sponsor.publicKey() }),
      Operation.endSponsoringFutureReserves({ source: recipient.publicKey() }),
    ]),
    basePolicy,
  ),
  false,
  "destination",
);

check(
  "R11 beginSponsoring sponsoredId != recipient",
  validateInnerTransaction(
    buildTx(recipient.publicKey(), [
      Operation.beginSponsoringFutureReserves({ sponsoredId: attacker.publicKey(), source: sponsor.publicKey() }),
      Operation.endSponsoringFutureReserves({ source: recipient.publicKey() }),
    ]),
    basePolicy,
  ),
  false,
  "sponsoredid",
);

console.log("\n============================================================");
console.log(failed === 0 ? ` ✅ ANTI-DRAIN TESTS PASS (${passed}/${passed + failed})` : ` ❌ ANTI-DRAIN TESTS FAIL (${failed} failed)`);
console.log("============================================================");
if (failed > 0) process.exit(1);
