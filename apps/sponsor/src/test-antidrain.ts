/**
 * ============================================================================
 *  TEST — anti-drain validator (the canonical validator now lives at
 *  apps/sponsor/src/lib/anti-drain.ts — moved out of packages/shared for the
 *  Vercel deploy boundary; this test imports ./lib/anti-drain.js directly)
 * ============================================================================
 *
 *  Addresses the code-review finding: op-type allowlisting is
 *  not enough; the validator must check op SOURCE and sensitive PARAMETERS.
 *  These cases prove the hardened validator accepts the legit claim + send + sweep
 *  shapes and rejects every reserve/principal drain vector we could think of
 *  (57/57 = 18 claim + 7 send + 12 sweep + 12 payout + 4 op-sequence + 4 golden-policy). The sweep policy (validateSweepTransaction)
 *  is a SEPARATE tight allowlist — the claim/send allowlists are never widened.
 *
 *  RUN:
 *    pnpm --filter @lumenia/sponsor test:antidrain
 *
 *  No network required — txs are built in memory and validated.
 * ============================================================================
 */

import assert from "node:assert/strict";
import {
  Account,
  Asset,
  Claimant,
  Keypair,
  Memo,
  MuxedAccount,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  type FeeBumpTransaction,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";
// the deployed validator (same module the live /feebump imports)
import {
  validateInnerTransaction,
  validatePayoutTransaction,
  validateSweepTransaction,
  ALLOWED_INNER_OP_TYPES,
  ALLOWED_SEND_OP_TYPES,
  ALLOWED_PAYOUT_OP_TYPES,
  ALLOWED_SWEEP_OP_TYPES,
  type InnerTxPolicy,
  type PayoutPolicy,
  type SweepPolicy,
} from "./lib/anti-drain.js";

const NETWORK = Networks.TESTNET;

const recipient = Keypair.random();
const sponsor = Keypair.random();
const issuer = Keypair.random();
const attacker = Keypair.random();
const anchor = Keypair.random(); // an allow-listed payment destination
const bearer = Keypair.random(); // the /send onward-recipient (CB claimant)

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

/* ---- STRICT-MODE FAIL-CLOSED VECTORS (a forgotten policy field must reject) ---- */

check(
  "S1 changeTrust with no expectedAsset set (strict mode rejects)",
  validateInnerTransaction(
    buildTx(recipient.publicKey(), [
      Operation.changeTrust({ asset: USDC, source: recipient.publicKey() }),
      Operation.claimClaimableBalance({ balanceId: BALANCE_ID }),
    ]),
    { expectedSource: recipient.publicKey(), sponsor: sponsor.publicKey(), expectedBalanceId: BALANCE_ID }, // expectedAsset omitted
  ),
  false,
  "strict mode",
);

check(
  "S2 claim with no expectedBalanceId set (strict mode rejects)",
  validateInnerTransaction(
    buildTx(recipient.publicKey(), [Operation.claimClaimableBalance({ balanceId: BALANCE_ID })]),
    { expectedSource: recipient.publicKey(), sponsor: sponsor.publicKey(), expectedAsset: USDC }, // expectedBalanceId omitted
  ),
  false,
  "strict mode",
);

check(
  "S3 op sourced by a third party (neither sponsor nor recipient) fails closed",
  validateInnerTransaction(
    buildTx(recipient.publicKey(), [Operation.claimClaimableBalance({ balanceId: BALANCE_ID, source: attacker.publicKey() })]),
    basePolicy,
  ),
  false,
  "must be sourced by the recipient",
);

/* ---- ESCAPE HATCH: explicit opt-out re-enables the permissive behavior ---- */

check(
  "S4 explicit allowUncheckedAsset re-permits an unconstrained changeTrust",
  validateInnerTransaction(
    buildTx(recipient.publicKey(), [
      Operation.changeTrust({ asset: USDC, source: recipient.publicKey() }),
      Operation.claimClaimableBalance({ balanceId: BALANCE_ID }),
    ]),
    { expectedSource: recipient.publicKey(), sponsor: sponsor.publicKey(), expectedBalanceId: BALANCE_ID, allowUncheckedAsset: true },
  ),
  true,
);

/* ---- /send SHAPE: a 0-XLM sender creates a sponsor-reserved Claimable Balance ---- */

const RECLAIM = "604800"; // 7 days
const goodClaimants = [
  new Claimant(bearer.publicKey(), Claimant.predicateUnconditional()),
  new Claimant(recipient.publicKey(), Claimant.predicateNot(Claimant.predicateBeforeRelativeTime(RECLAIM))),
];
function sendOps(claimants: Claimant[], asset: Asset = USDC, cbSource: string = recipient.publicKey()): xdr.Operation[] {
  return [
    Operation.beginSponsoringFutureReserves({ sponsoredId: recipient.publicKey(), source: sponsor.publicKey() }),
    Operation.createClaimableBalance({ asset, amount: "20", claimants, source: cbSource }),
    Operation.endSponsoringFutureReserves({ source: recipient.publicKey() }),
  ];
}
const sendPolicy: InnerTxPolicy = {
  expectedSource: recipient.publicKey(), // the sender sources the tx + the CB
  sponsor: sponsor.publicKey(),
  expectedAsset: USDC,
  allowedOpTypes: ALLOWED_SEND_OP_TYPES,
  expectedClaimantCount: 2,
  maxOps: 3,
};

check(
  "SEND-G valid send shape (begin/createCB[bearer-uncond + sender-reclaim]/end)",
  validateInnerTransaction(buildTx(recipient.publicKey(), sendOps(goodClaimants)), sendPolicy),
  true,
);
check(
  "SEND-R1 createClaimableBalance sourced by the sponsor (spends sponsor USDC)",
  validateInnerTransaction(buildTx(recipient.publicKey(), sendOps(goodClaimants, USDC, sponsor.publicKey())), sendPolicy),
  false,
  "sponsor",
);
check(
  "SEND-R2 createClaimableBalance wrong asset",
  validateInnerTransaction(buildTx(recipient.publicKey(), sendOps(goodClaimants, WRONG)), sendPolicy),
  false,
  "expected asset",
);
check(
  "SEND-R3 too many claimants (reserve-lock griefing)",
  validateInnerTransaction(
    buildTx(
      recipient.publicKey(),
      sendOps([...goodClaimants, new Claimant(attacker.publicKey(), Claimant.predicateUnconditional())]),
    ),
    sendPolicy,
  ),
  false,
  "claimants",
);
check(
  "SEND-R4 no unconditional claimant (reserve could lock forever)",
  validateInnerTransaction(
    buildTx(
      recipient.publicKey(),
      sendOps([
        new Claimant(bearer.publicKey(), Claimant.predicateBeforeRelativeTime("100")),
        new Claimant(recipient.publicKey(), Claimant.predicateNot(Claimant.predicateBeforeRelativeTime(RECLAIM))),
      ]),
    ),
    sendPolicy,
  ),
  false,
  "unconditional",
);
check(
  "SEND-R5 sender is not a claimant (no reclaim path)",
  validateInnerTransaction(
    buildTx(
      recipient.publicKey(),
      sendOps([
        new Claimant(bearer.publicKey(), Claimant.predicateUnconditional()),
        new Claimant(attacker.publicKey(), Claimant.predicateUnconditional()),
      ]),
    ),
    sendPolicy,
  ),
  false,
  "reclaim claimant",
);
check(
  "SEND-R6 the CLAIM policy rejects createClaimableBalance (allowlist never widened)",
  validateInnerTransaction(buildTx(recipient.publicKey(), sendOps(goodClaimants)), basePolicy),
  false,
  "disallowed op type",
);

/* ---- /sweep SHAPE: consolidate a per-link throwaway account into ONE home account ----
 * A SEPARATE tight policy (validateSweepTransaction). Order-pinned:
 *   [claim, payment(→home), changeTrust(limit 0), accountMerge(→home)], all throwaway-sourced.
 * The sponsor sources nothing + reclaims the throwaway's reserves on merge (Spike #7). */

const home = Keypair.random();
const throwaway = Keypair.random();
const SWEEP_AMOUNT = "12";

function sweepOps(opts: {
  balanceId?: string;
  payDest?: string;
  payAsset?: Asset;
  payAmount?: string;
  ctAsset?: Asset;
  ctLimit?: string;
  mergeDest?: string;
  sponsorSourcesPayment?: boolean;
} = {}): xdr.Operation[] {
  return [
    Operation.claimClaimableBalance({ balanceId: opts.balanceId ?? BALANCE_ID, source: throwaway.publicKey() }),
    Operation.payment({
      destination: opts.payDest ?? home.publicKey(),
      asset: opts.payAsset ?? USDC,
      amount: opts.payAmount ?? SWEEP_AMOUNT,
      source: opts.sponsorSourcesPayment ? sponsor.publicKey() : throwaway.publicKey(),
    }),
    Operation.changeTrust({ asset: opts.ctAsset ?? USDC, limit: opts.ctLimit ?? "0", source: throwaway.publicKey() }),
    Operation.accountMerge({ destination: opts.mergeDest ?? home.publicKey(), source: throwaway.publicKey() }),
  ];
}
const sweepPolicy: SweepPolicy = {
  throwaway: throwaway.publicKey(),
  sponsor: sponsor.publicKey(),
  home: home.publicKey(),
  usdc: USDC,
  expectedBalanceId: BALANCE_ID,
  expectedAmount: SWEEP_AMOUNT,
};
function checkSweep(name: string, ops: xdr.Operation[], wantOk: boolean, reasonIncludes?: string) {
  check(name, validateSweepTransaction(buildTx(throwaway.publicKey(), ops), sweepPolicy), wantOk, reasonIncludes);
}

checkSweep("SWEEP-G valid consolidation (claim/pay→home/changeTrust0/merge→home)", sweepOps(), true);
checkSweep("SWEEP-R1 payment to a non-home destination (fund exfil attempt)", sweepOps({ payDest: attacker.publicKey() }), false, "destination");
checkSweep("SWEEP-R2 changeTrust that ADDS trust (limit != 0)", sweepOps({ ctLimit: "1000" }), false, "limit 0");
checkSweep("SWEEP-R3 accountMerge to a non-home destination", sweepOps({ mergeDest: attacker.publicKey() }), false, "destination");
checkSweep("SWEEP-R4 wrong claim balanceId", sweepOps({ balanceId: OTHER_BALANCE_ID }), false, "balanceid");
checkSweep("SWEEP-R5 an op sourced by the sponsor (sponsor sources nothing here)", sweepOps({ sponsorSourcesPayment: true }), false, "sponsor");
checkSweep("SWEEP-R6 wrong asset on the payment", sweepOps({ payAsset: WRONG }), false, "usdc");
check(
  "SWEEP-R7 wrong op order (payment before claim)",
  validateSweepTransaction(
    buildTx(throwaway.publicKey(), [
      Operation.payment({ destination: home.publicKey(), asset: USDC, amount: SWEEP_AMOUNT, source: throwaway.publicKey() }),
      Operation.claimClaimableBalance({ balanceId: BALANCE_ID, source: throwaway.publicKey() }),
      Operation.changeTrust({ asset: USDC, limit: "0", source: throwaway.publicKey() }),
      Operation.accountMerge({ destination: home.publicKey(), source: throwaway.publicKey() }),
    ]),
    sweepPolicy,
  ),
  false,
  "must be",
);
check(
  "SWEEP-R8 the CLAIM policy never allows accountMerge (allowlist not widened)",
  validateInnerTransaction(
    buildTx(throwaway.publicKey(), [
      Operation.claimClaimableBalance({ balanceId: BALANCE_ID, source: throwaway.publicKey() }),
      Operation.accountMerge({ destination: home.publicKey(), source: throwaway.publicKey() }),
    ]),
    { ...basePolicy, expectedSource: throwaway.publicKey() },
  ),
  false,
  "disallowed op type",
);

// The 3-op "already-claimed" shape — the PRODUCTION shape: the frozen /c/[id] route
// claims the CB at claim time, so consolidation sweeps plain USDC with NO claim op.
const sweepPolicyClaimless: SweepPolicy = {
  throwaway: throwaway.publicKey(),
  sponsor: sponsor.publicKey(),
  home: home.publicKey(),
  usdc: USDC,
  expectedAmount: SWEEP_AMOUNT,
};
function sweepTail(payDest: string = home.publicKey()): xdr.Operation[] {
  return [
    Operation.payment({ destination: payDest, asset: USDC, amount: SWEEP_AMOUNT, source: throwaway.publicKey() }),
    Operation.changeTrust({ asset: USDC, limit: "0", source: throwaway.publicKey() }),
    Operation.accountMerge({ destination: home.publicKey(), source: throwaway.publicKey() }),
  ];
}
check(
  "SWEEP-G2 valid already-claimed 3-op (payment→home/changeTrust0/merge→home, no claim)",
  validateSweepTransaction(buildTx(throwaway.publicKey(), sweepTail()), sweepPolicyClaimless),
  true,
);
check(
  "SWEEP-R9 a claim op present but no expectedBalanceId (strict fail-closed)",
  validateSweepTransaction(buildTx(throwaway.publicKey(), sweepOps()), sweepPolicyClaimless),
  false,
  "expectedbalanceid",
);
check(
  "SWEEP-R10 claimless sweep still pins the payment destination to home",
  validateSweepTransaction(buildTx(throwaway.publicKey(), sweepTail(attacker.publicKey())), sweepPolicyClaimless),
  false,
  "destination",
);

/* ---- /payout SHAPE: the user sends their OWN dollars out to an address they name ----
 * A SEPARATE tight policy (validatePayoutTransaction): exactly ONE sender-sourced
 * `payment` in the configured USDC, to the declared destination, for the declared
 * amount. This is the cash-out leg — an exchange credits a deposit from a payment
 * op carrying a MEMO, so a Claimable Balance (the /send-link shape) is useless here
 * and the memo must survive the sponsor's fee-bump. */

const exchange = Keypair.random(); // an exchange deposit address (G…)
// A muxed M… deposit address: the memo is carried INSIDE the address (SEP-23), so
// there is no memo field to get wrong — the safest shape an exchange can hand out.
const exchangeMuxed = new MuxedAccount(new Account(exchange.publicKey(), "0"), "42").accountId();
const PAYOUT_AMOUNT = "25.50";

function payoutOps(opts: { dest?: string; asset?: Asset; amount?: string; source?: string } = {}): xdr.Operation[] {
  return [
    Operation.payment({
      destination: opts.dest ?? exchange.publicKey(),
      asset: opts.asset ?? USDC,
      amount: opts.amount ?? PAYOUT_AMOUNT,
      source: opts.source ?? recipient.publicKey(),
    }),
  ];
}
const payoutPolicy: PayoutPolicy = {
  sender: recipient.publicKey(),
  sponsor: sponsor.publicKey(),
  usdc: USDC,
  expectedDestination: exchange.publicKey(),
  expectedAmount: PAYOUT_AMOUNT,
};
function checkPayout(
  name: string,
  ops: xdr.Operation[],
  wantOk: boolean,
  reasonIncludes?: string,
  policy: PayoutPolicy = payoutPolicy,
  source: string = recipient.publicKey(),
) {
  check(name, validatePayoutTransaction(buildTx(source, ops), policy), wantOk, reasonIncludes);
}

checkPayout("PAYOUT-G1 valid payout (sender-sourced USDC payment, declared dest + amount)", payoutOps(), true);
checkPayout(
  "PAYOUT-G2 valid payout to a muxed M… deposit address (memo embedded in the address)",
  payoutOps({ dest: exchangeMuxed }),
  true,
  undefined,
  { ...payoutPolicy, expectedDestination: exchangeMuxed },
);
// The invariant an exchange deposit lives or dies on: a fee-bump wraps the inner tx
// WHOLE, so the memo the user typed is the memo that lands. If this ever breaks,
// every memo-required deposit through /payout silently goes to the omnibus.
{
  const inner = new TransactionBuilder(new Account(recipient.publicKey(), "123456789"), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK,
  })
    .addOperation(Operation.payment({ destination: exchange.publicKey(), asset: USDC, amount: PAYOUT_AMOUNT, source: recipient.publicKey() }))
    .addMemo(Memo.text("EXCHANGE-DEPOSIT-9137"))
    .setTimeout(180)
    .build();
  const bumped = TransactionBuilder.fromXDR(
    TransactionBuilder.buildFeeBumpTransaction(sponsor.publicKey(), "1000", inner, NETWORK).toXDR(),
    NETWORK,
  ) as FeeBumpTransaction;
  const carried = bumped.innerTransaction.memo;
  check(
    "PAYOUT-G3 the memo survives the sponsor's fee-bump (deposit-credit invariant)",
    {
      ok: carried.type === "text" && carried.value?.toString() === "EXCHANGE-DEPOSIT-9137",
      reason: `fee-bumped inner memo is ${carried.type}:${String(carried.value)} — the deposit would land with no/wrong memo`,
    },
    true,
  );
}
checkPayout("PAYOUT-R1 destination differs from the declared one (swap attack)", payoutOps({ dest: attacker.publicKey() }), false, "destination");
checkPayout("PAYOUT-R2 wrong asset", payoutOps({ asset: WRONG }), false, "usdc");
checkPayout("PAYOUT-R3 amount differs from the declared one", payoutOps({ amount: "999" }), false, "declared");
checkPayout("PAYOUT-R4 payment sourced by the sponsor (spends the sponsor's USDC)", payoutOps({ source: sponsor.publicKey() }), false, "sponsor");
checkPayout("PAYOUT-R5 tx sourced by someone other than the sender", payoutOps(), false, "tx source", payoutPolicy, attacker.publicKey());
checkPayout("PAYOUT-R6 two payment ops (only one is ever allowed)", [...payoutOps(), ...payoutOps()], false, "exactly one");
checkPayout(
  "PAYOUT-R7 a non-payment op (accountMerge) in the payout slot",
  [Operation.accountMerge({ destination: attacker.publicKey(), source: recipient.publicKey() })],
  false,
  "disallowed op type",
);
// The SDK refuses to BUILD a zero-amount payment, so a zero can only arrive as
// hand-rolled XDR. Simulate that by overwriting the parsed op — the validator must
// still fail closed rather than trust that the client used the SDK.
{
  const tx = buildTx(recipient.publicKey(), payoutOps());
  (tx.operations[0] as { amount?: string }).amount = "0";
  check(
    "PAYOUT-R8 zero amount (hand-rolled XDR the SDK would never build)",
    validatePayoutTransaction(tx, { ...payoutPolicy, expectedAmount: "0" }),
    false,
    "greater than zero",
  );
}
check(
  "PAYOUT-R9 the CLAIM policy still rejects this payout (allowlist not widened)",
  validateInnerTransaction(buildTx(recipient.publicKey(), payoutOps()), basePolicy),
  false,
  "non-allowlisted destination",
);

/* ---- OP-SEQUENCE MATCHER: pin the exact ORDERED shape (defense-in-depth) ----
 * A reordering of individually-allowed ops (each passing source/param checks) must
 * still be rejected. The live claim policy pins [claim]; the send policy pins
 * [begin, createClaimableBalance, end]. */
const claimSeqPolicy: InnerTxPolicy = { ...basePolicy, maxOps: 6, expectedOpSequence: ["claimClaimableBalance"] };
check(
  "SEQ-G1 claim matches the pinned sequence [claim]",
  validateInnerTransaction(buildTx(recipient.publicKey(), [Operation.claimClaimableBalance({ balanceId: BALANCE_ID })]), claimSeqPolicy),
  true,
);
check(
  "SEQ-R1 claim + extra changeTrust rejected by the pinned [claim] sequence (order/shape)",
  validateInnerTransaction(
    buildTx(recipient.publicKey(), [
      Operation.claimClaimableBalance({ balanceId: BALANCE_ID }),
      Operation.changeTrust({ asset: USDC, source: recipient.publicKey() }),
    ]),
    claimSeqPolicy,
  ),
  false,
  "sequence",
);
const sendSeqPolicy: InnerTxPolicy = {
  ...sendPolicy,
  expectedOpSequence: ["beginSponsoringFutureReserves", "createClaimableBalance", "endSponsoringFutureReserves"],
};
check(
  "SEQ-G2 send matches the pinned sequence [begin,createCB,end]",
  validateInnerTransaction(buildTx(recipient.publicKey(), sendOps(goodClaimants)), sendSeqPolicy),
  true,
);
check(
  "SEQ-R2 reordered send [createCB,begin,end] rejected (every op valid, ORDER wrong)",
  validateInnerTransaction(
    buildTx(recipient.publicKey(), [
      Operation.createClaimableBalance({ asset: USDC, amount: "20", claimants: goodClaimants, source: recipient.publicKey() }),
      Operation.beginSponsoringFutureReserves({ sponsoredId: recipient.publicKey(), source: sponsor.publicKey() }),
      Operation.endSponsoringFutureReserves({ source: recipient.publicKey() }),
    ]),
    sendSeqPolicy,
  ),
  false,
  "sequence",
);

/* ---- GOLDEN POLICY SNAPSHOT: the exported allowlists must NEVER silently widen ----
 * If a future change adds an op type to any allowlist, this fails LOUDLY — widening the
 * claim/send/sweep allowlist is exactly the accidental weakening this snapshot guards
 * against. Changing an allowlist is a DELIBERATE act: update the golden list here too. */
function goldenSet(name: string, got: Set<string>, golden: string[]) {
  const g = [...got].sort();
  const w = [...golden].sort();
  const equal = g.length === w.length && g.every((x, i) => x === w[i]);
  check(
    `GOLDEN ${name} allowlist unchanged`,
    { ok: equal, reason: `got [${g.join(",")}] want [${w.join(",")}] — allowlist changed; update deliberately` },
    true,
  );
}
goldenSet("claim (ALLOWED_INNER_OP_TYPES)", ALLOWED_INNER_OP_TYPES, [
  "beginSponsoringFutureReserves",
  "createAccount",
  "changeTrust",
  "endSponsoringFutureReserves",
  "claimClaimableBalance",
  "payment",
]);
goldenSet("send (ALLOWED_SEND_OP_TYPES)", ALLOWED_SEND_OP_TYPES, [
  "beginSponsoringFutureReserves",
  "createClaimableBalance",
  "endSponsoringFutureReserves",
]);
goldenSet("payout (ALLOWED_PAYOUT_OP_TYPES)", ALLOWED_PAYOUT_OP_TYPES, ["payment"]);
goldenSet("sweep (ALLOWED_SWEEP_OP_TYPES)", ALLOWED_SWEEP_OP_TYPES, [
  "claimClaimableBalance",
  "payment",
  "changeTrust",
  "accountMerge",
]);

/* ---- MUXED ADDRESSES: every source check in the validator is a string ===, and a muxed M…
   wrapping the sponsor's own key is a DIFFERENT string, so the "sponsor may not source this op"
   drain check would never fire. The validator refuses the ambiguity outright rather than relying
   on the accident that today's op shapes happen not to allow it. ---- */
const MUXED_SPONSOR = new MuxedAccount(new Account(sponsor.publicKey(), "0"), "1").accountId();

check(
  "MUX-1 a muxed tx source is rejected (no === comparison against a G… is meaningful)",
  validateInnerTransaction(
    buildTx(recipient.publicKey(), [Operation.claimClaimableBalance({ balanceId: BALANCE_ID })]),
    { ...basePolicy, expectedSource: MUXED_SPONSOR },
  ),
  false,
);
check(
  "MUX-2 a muxed SPONSOR in the policy is rejected before any drain check runs",
  validateInnerTransaction(
    buildTx(recipient.publicKey(), [Operation.claimClaimableBalance({ balanceId: BALANCE_ID })]),
    { ...basePolicy, sponsor: MUXED_SPONSOR },
  ),
  false,
);
check(
  "MUX-3 a muxed OP source is rejected",
  validateInnerTransaction(
    buildTx(recipient.publicKey(), [
      Operation.claimClaimableBalance({ balanceId: BALANCE_ID, source: MUXED_SPONSOR }),
    ]),
    basePolicy,
  ),
  false,
);

console.log("\n============================================================");
console.log(failed === 0 ? ` ✅ ANTI-DRAIN TESTS PASS (${passed}/${passed + failed})` : ` ❌ ANTI-DRAIN TESTS FAIL (${failed} failed)`);
console.log("============================================================");
if (failed > 0) process.exit(1);
