/**
 * Conversion self-test - the arithmetic and the refusals behind "turn this XLM into dollars".
 *
 * Every case here is about one of three ways this feature could quietly cost somebody money:
 *
 *  1. A BOUND THAT IS NOT THERE, or is there in a shape the ledger reads differently. A path
 *     payment without a bound fills at whatever a thin testnet book offers. `buildSwapTx` throws
 *     rather than build one, and the bound must be a 7dp string because the submit-time guard
 *     compares it byte for byte against what the XDR carries.
 *  2. A DESTINATION THAT IS NOT US. A conversion pays the account it spends from. The signer hands
 *     a transaction BACK (an external wallet signs a copy), so the destination is checked on the
 *     returned bytes, not only on the operation we built.
 *  3. A FAILURE READ AS A SUCCESS. An answer with no result code is not a failure and is not a
 *     success; it is a question for the balance, and it is never rendered as either.
 *
 * Offline: no network, no keys that hold anything, no signing of anything that exists. The quote
 * readers are driven through their own `fetchImpl` seam with recorded Horizon bodies.
 *
 * RUN: pnpm --filter @lumenia/web test:swap
 */
import { Account, Asset, Keypair, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { sanitizeAmountInput } from "./money";
import { testnetConfig, USDC_ISSUER } from "./network";
import {
  assertIsOwnConversion,
  buildSwapTx,
  ceilingFor,
  classifySwapFailure,
  defaultSlippageBps,
  engineLabel,
  floorFor,
  formatXlm,
  fromStroops,
  isStale,
  MIN_CONVERT_XLM,
  quoteStrictReceive,
  quoteStrictSend,
  repriceDecision,
  retryAllowed,
  shouldOfferConversion,
  spendableXlm,
  SWAP_FEE_STROOPS,
  toStroops,
  watchUntil,
  type SwapQuote,
} from "./swap";

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✔ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? `  (${detail})` : ""}`);
  }
}
function throws(label: string, fn: () => unknown, naming?: RegExp) {
  try {
    fn();
    ok(label, false, "it did not throw");
  } catch (e) {
    const msg = (e as Error).message ?? "";
    ok(label, naming ? naming.test(msg) : true, msg);
  }
}

const NET = testnetConfig();
const PINNED = USDC_ISSUER.testnet;
const IMPOSTOR = "GDO7HI2WKTMDLDG54XKAVE6BTJ5BYXE7PAYQNM5535J2SJNXR334ECYC";
const ME = Keypair.random();
const STRANGER = Keypair.random().publicKey();

/** The live testnet answer for 10 XLM on 2026-09-20, used as the shape the readers must parse. */
const sendRecord = (over: Record<string, unknown> = {}) => ({
  source_asset_type: "native",
  source_amount: "10.0000000",
  destination_asset_type: "credit_alphanum4",
  destination_asset_code: "USDC",
  destination_asset_issuer: PINNED,
  destination_amount: "10.5145923",
  path: [],
  ...over,
});

const stubFetch =
  (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const quoteOf = (over: Partial<SwapQuote> = {}): SwapQuote => ({
  engine: "sdex",
  sendAsset: Asset.native(),
  sendAmount: "10.0000000",
  destAsset: new Asset("USDC", PINNED),
  destAmount: "10.5145923",
  path: [],
  quotedAt: 1_000_000,
  ...over,
});

async function main() {
  console.log("============================================================");
  console.log(" SELF-TEST - turning XLM into dollars");
  console.log("============================================================\n");

  console.log("[1] amounts cross this module as decimal strings, never floats");
  {
    ok("7dp round trip", fromStroops(toStroops("10.5145923")) === "10.5145923");
    ok("a whole number gains its places", fromStroops(toStroops("41")) === "41.0000000");
    throws("a comma is not an amount this module reads", () => toStroops("1,50"), /not an amount/);
    throws("eight decimal places are refused", () => toStroops("1.12345678"), /not an amount/);
    ok("display trims the zeros without rounding the value", formatXlm("41.0500000") === "41.05");
    ok("display of a whole number has no point", formatXlm("41.0000000") === "41");
  }

  console.log("\n[2] the floor, truncated DOWN, because a raised floor turns a fill into a failure");
  {
    // 10.5145923 * 0.98 = 10.304300454 exactly; the seventh place is 4 and stays 4.
    ok("200 bps under the live quote", floorFor(quoteOf(), 200) === "10.3043004", floorFor(quoteOf(), 200));
    ok("0 bps is the quote itself", floorFor(quoteOf(), 0) === "10.5145923");
    ok(
      "the floor is never above quote * (1 - bps)",
      toStroops(floorFor(quoteOf(), 200)) * 10_000n <= toStroops("10.5145923") * 9_800n,
    );
    throws("a negative slippage is refused", () => floorFor(quoteOf(), -1), /basis points/);
    throws("a fractional slippage is refused", () => floorFor(quoteOf(), 12.5), /basis points/);
  }

  console.log("\n[3] the ceiling, rounded UP, because a lowered ceiling refuses what someone can afford");
  {
    const q = quoteOf({ sendAmount: "4.7552958" });
    ok("200 bps over the live strict-receive quote", ceilingFor(q, 200) === "4.8504018", ceilingFor(q, 200));
    ok("the ceiling is above the quote", toStroops(ceilingFor(q, 200)) > toStroops(q.sendAmount));
    ok("0 bps is the quote itself", ceilingFor(q, 0) === "4.7552958");
    ok(
      "the ceiling is never below quote * (1 + bps)",
      toStroops(ceilingFor(q, 200)) * 10_000n >= toStroops("4.7552958") * 10_200n,
    );
    ok("testnet books are thinner, so the bound is wider", defaultSlippageBps({ isMainnet: false }) === 200);
    ok("mainnet is 100 bps", defaultSlippageBps({ isMainnet: true }) === 100);
  }

  console.log("\n[4] reading a price: the asset is ours or the record is not a price");
  {
    const best = await quoteStrictSend(NET, "10", {
      now: 5,
      fetchImpl: stubFetch({
        _embedded: {
          records: [sendRecord(), sendRecord({ destination_amount: "10.9000000" }), sendRecord({ destination_amount: "9.1000000" })],
        },
      }),
    });
    ok("strict-send picks the most dollars", best?.destAmount === "10.9000000", best?.destAmount);
    ok("the engine is named by the reader, not by the screen", best?.engine === "sdex");
    ok("the quote carries the moment it was read", best?.quotedAt === 5);

    const impostor = await quoteStrictSend(NET, "10", {
      fetchImpl: stubFetch({ _embedded: { records: [sendRecord({ destination_asset_issuer: IMPOSTOR })] } }),
    });
    ok("a look-alike dollar is not a price we accept", impostor === null);

    const empty = await quoteStrictSend(NET, "10", { fetchImpl: stubFetch({ _embedded: { records: [] } }) });
    ok("no path is an honest empty, not an error", empty === null);

    let threw = false;
    await quoteStrictSend(NET, "10", { fetchImpl: stubFetch({}, 503) }).catch(() => (threw = true));
    ok("a Horizon that will not answer throws rather than reading as 'no market'", threw);

    const cheapest = await quoteStrictReceive(NET, "5", {
      fetchImpl: stubFetch({
        _embedded: {
          records: [
            sendRecord({ source_amount: "4.7552958", destination_amount: "5.0000000" }),
            sendRecord({ source_amount: "5.9000000", destination_amount: "5.0000000" }),
          ],
        },
      }),
    });
    ok("strict-receive picks the fewest lumens", cheapest?.sendAmount === "4.7552958", cheapest?.sendAmount);
  }

  console.log("\n[5] the path is the route, so its order is the route's order");
  {
    const hopped = await quoteStrictSend(NET, "10", {
      fetchImpl: stubFetch({
        _embedded: {
          records: [
            sendRecord({
              path: [
                { asset_type: "native" },
                { asset_type: "credit_alphanum4", asset_code: "EURC", asset_issuer: IMPOSTOR },
              ],
            }),
          ],
        },
      }),
    });
    ok("two hops map in order", hopped?.path.length === 2 && hopped.path[0]!.isNative() && hopped.path[1]!.getCode() === "EURC");
    ok("the hop's issuer carries over", hopped?.path[1]!.getIssuer() === IMPOSTOR);
    const direct = await quoteStrictSend(NET, "10", { fetchImpl: stubFetch({ _embedded: { records: [sendRecord()] } }) });
    ok("the direct case is an empty path", direct?.path.length === 0);
  }

  console.log("\n[6] what is spendable comes from the reserves the LEDGER holds, not a flat buffer");
  {
    // A Lumenia account: its account entry and its USDC trustline are both sponsored (the real
    // shape on testnet is subentries 1, sponsored 3), so it owes the ledger nothing of its own.
    const sponsored = { xlm: "5.0000000", subentryCount: 1, numSponsoring: 0, numSponsored: 3 };
    ok("a sponsored account keeps only the fee headroom", spendableXlm(sponsored) === "4.5000000", spendableXlm(sponsored));
    // The same balance in an account funded from an outside wallet owes 1.5 XLM for the same two
    // things. This is the case a flat 1.0 buffer would have offered a conversion it cannot pay for.
    const external = { xlm: "5.0000000", subentryCount: 1, numSponsoring: 0, numSponsored: 0 };
    ok("an external-wallet account owes its own reserves", spendableXlm(external) === "3.0000000", spendableXlm(external));
    const thin = { xlm: "2.2000000", subentryCount: 1, numSponsoring: 0, numSponsored: 0 };
    ok("2.2 XLM outside our sponsorship is 0.2 spendable", spendableXlm(thin) === "0.2000000", spendableXlm(thin));
    ok("and is therefore not offered a conversion", !shouldOfferConversion(spendableXlm(thin)));
    ok("an empty account is 0, never negative", spendableXlm({ xlm: "0", subentryCount: 1, numSponsoring: 0, numSponsored: 0 }) === "0.0000000");
    ok("a sponsor of other accounts owes more", spendableXlm({ xlm: "5.0000000", subentryCount: 1, numSponsoring: 2, numSponsored: 3 }) === "3.5000000");
    ok(`below ${MIN_CONVERT_XLM} XLM there is nothing worth a transaction`, !shouldOfferConversion("0.9999999"));
    ok("at the floor it is offered", shouldOfferConversion("1.0000000"));
  }

  console.log("\n[7] a conversion is never built without a bound, and never to anybody else");
  {
    const source = () => new Account(ME.publicKey(), "1");
    throws(
      "no bound, no transaction",
      () => buildSwapTx({ net: NET, source: source(), destination: ME.publicKey(), quote: quoteOf(), kind: "strict-send" }),
      /destMin/,
    );
    throws(
      "the missing bound is named for the operation it belongs to",
      () => buildSwapTx({ net: NET, source: source(), destination: ME.publicKey(), quote: quoteOf(), kind: "strict-receive" }),
      /sendMax/,
    );
    throws(
      "a bound that is not 7dp is refused, because the guard compares it byte for byte",
      () => buildSwapTx({ net: NET, source: source(), destination: ME.publicKey(), quote: quoteOf(), kind: "strict-send", bound: "10.30" }),
      /7 decimal places/,
    );
    throws(
      "a destination that is not this account is refused",
      () => buildSwapTx({ net: NET, source: source(), destination: STRANGER, quote: quoteOf(), kind: "strict-send", bound: "10.3043004" }),
      /same account/,
    );
    throws(
      "a price for a different dollar is refused",
      () =>
        buildSwapTx({
          net: NET,
          source: source(),
          destination: ME.publicKey(),
          quote: quoteOf({ destAsset: new Asset("USDC", IMPOSTOR) }),
          kind: "strict-send",
          bound: "10.3043004",
        }),
      /different dollar/,
    );

    const built = buildSwapTx({
      net: NET,
      source: source(),
      destination: ME.publicKey(),
      quote: quoteOf(),
      kind: "strict-send",
      bound: "10.3043004",
    });
    const op = built.tx.operations[0] as unknown as { type: string; destination: string; destMin: string; sendAmount: string };
    ok("one operation, and it is a strict-send path payment", built.tx.operations.length === 1 && op.type === "pathPaymentStrictSend");
    ok("it pays this same account", op.destination === ME.publicKey());
    ok("the floor rides in the operation", op.destMin === "10.3043004");
    ok("the exact quoted lumens are spent", op.sendAmount === "10.0000000");
    ok("the fee is the fixed one, not BASE_FEE", built.tx.fee === SWAP_FEE_STROOPS);
    ok("there is a timebound, so silence can become proof", Number(built.tx.timeBounds?.maxTime ?? 0) > 0);
    ok("and that is what retrySafeAfter is", built.retrySafeAfter === Number(built.tx.timeBounds!.maxTime) * 1000);
  }

  console.log("\n[8] the guard on what comes BACK from the signer");
  {
    const built = buildSwapTx({
      net: NET,
      source: new Account(ME.publicKey(), "1"),
      destination: ME.publicKey(),
      quote: quoteOf(),
      kind: "strict-send",
      bound: "10.3043004",
    });
    const expect = { self: ME.publicKey(), net: "testnet" as const, bound: "10.3043004", kind: "strict-send" as const };
    built.tx.sign(ME);
    let accepted = true;
    try {
      assertIsOwnConversion(built.tx, expect);
    } catch {
      accepted = false;
    }
    ok("the conversion we built and signed is accepted", accepted);

    throws("a bound that does not match what we computed is refused", () => assertIsOwnConversion(built.tx, { ...expect, bound: "10.0000000" }));
    throws("the wrong operation kind is refused", () => assertIsOwnConversion(built.tx, { ...expect, kind: "strict-receive" }));
    throws("a transaction sourced by somebody else is refused", () => assertIsOwnConversion(built.tx, { ...expect, self: STRANGER }));

    /** A hostile answer: same shape, their address. */
    const foreign = new TransactionBuilder(new Account(ME.publicKey(), "1"), { fee: SWAP_FEE_STROOPS, networkPassphrase: NET.passphrase })
      .addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: Asset.native(),
          sendAmount: "10.0000000",
          destination: STRANGER,
          destAsset: new Asset("USDC", PINNED),
          destMin: "10.3043004",
          path: [],
          source: ME.publicKey(),
        }),
      )
      .setTimeout(45)
      .build();
    foreign.sign(ME);
    throws("a returned transaction paying a stranger is refused", () => assertIsOwnConversion(foreign, expect));

    const impostorAsset = new TransactionBuilder(new Account(ME.publicKey(), "1"), { fee: SWAP_FEE_STROOPS, networkPassphrase: NET.passphrase })
      .addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: Asset.native(),
          sendAmount: "10.0000000",
          destination: ME.publicKey(),
          destAsset: new Asset("USDC", IMPOSTOR),
          destMin: "10.3043004",
          path: [],
          source: ME.publicKey(),
        }),
      )
      .setTimeout(45)
      .build();
    impostorAsset.sign(ME);
    throws("a returned transaction buying an unpinned dollar is refused", () => assertIsOwnConversion(impostorAsset, expect));

    const twoOps = new TransactionBuilder(new Account(ME.publicKey(), "1"), { fee: SWAP_FEE_STROOPS, networkPassphrase: NET.passphrase })
      .addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: Asset.native(),
          sendAmount: "10.0000000",
          destination: ME.publicKey(),
          destAsset: new Asset("USDC", PINNED),
          destMin: "10.3043004",
          path: [],
          source: ME.publicKey(),
        }),
      )
      .addOperation(Operation.payment({ destination: STRANGER, asset: new Asset("USDC", PINNED), amount: "10", source: ME.publicKey() }))
      .setTimeout(45)
      .build();
    twoOps.sign(ME);
    throws("a second operation smuggled alongside it is refused", () => assertIsOwnConversion(twoOps, expect));

    const memoed = new TransactionBuilder(new Account(ME.publicKey(), "1"), { fee: SWAP_FEE_STROOPS, networkPassphrase: NET.passphrase })
      .addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: Asset.native(),
          sendAmount: "10.0000000",
          destination: ME.publicKey(),
          destAsset: new Asset("USDC", PINNED),
          destMin: "10.3043004",
          path: [],
          source: ME.publicKey(),
        }),
      )
      .addMemo(Memo.text("exchange-1234"))
      .setTimeout(45)
      .build();
    memoed.sign(ME);
    throws("a memo has no business on a conversion to self", () => assertIsOwnConversion(memoed, expect));

    const unsigned = buildSwapTx({
      net: NET,
      source: new Account(ME.publicKey(), "1"),
      destination: ME.publicKey(),
      quote: quoteOf(),
      kind: "strict-send",
      bound: "10.3043004",
    });
    throws("a transaction nobody signed is refused", () => assertIsOwnConversion(unsigned.tx, expect));
  }

  console.log("\n[9] a price on screen is a fact about a moment");
  {
    const q = quoteOf({ quotedAt: 100_000 });
    ok("19 s old is still the price", !isStale(q, 100_000 + 19_000));
    ok("21 s old is read again", isStale(q, 100_000 + 21_000));
    ok("a 1 percent move submits what was shown", repriceDecision("10.0000000", "10.1000000") === "submit");
    ok("a 3 percent move asks for a second tap", repriceDecision("10.0000000", "10.3000000") === "reprice");
    ok("a 3 percent move DOWN asks too", repriceDecision("10.0000000", "9.7000000") === "reprice");
    ok("an unchanged bound submits", repriceDecision("10.3043004", "10.3043004") === "submit");
    ok("a bound of zero is never submitted against", repriceDecision("0.0000000", "0.0000000") === "reprice");
  }

  console.log("\n[10] a second attempt waits for the first one to die");
  {
    const dies = 1_700_000_000_000;
    ok("no retry while the signed conversion can still land", !retryAllowed(dies, dies - 1));
    ok("no retry at the exact moment either", !retryAllowed(dies, dies));
    ok("a retry once it can no longer be included", retryAllowed(dies, dies + 1));
    ok("the watch outlives the transaction", watchUntil(dies, dies - 45_000) === dies + 5_000);
    ok("and is never shorter than fifty seconds", watchUntil(dies, dies) === dies + 50_000);
  }

  console.log("\n[11] every failure named, and an unknown one never reads as success");
  {
    const horizon = (codes: { transaction?: string; operations?: string[] }) => ({
      message: "Request failed with status code 400",
      response: { status: 400, data: { extras: { result_codes: codes } } },
    });
    const c = (codes: { transaction?: string; operations?: string[] }) => classifySwapFailure(horizon(codes));

    const moved = c({ transaction: "tx_failed", operations: ["op_under_dest_min"] });
    ok("op_under_dest_min is the price moving, and is worth another tap", moved.kind === "price-moved" && !moved.terminal);
    ok("the protocol spelling is read too", c({ operations: ["op_under_destmin"] }).kind === "price-moved");
    ok("op_over_source_max is the same story", c({ operations: ["op_over_source_max"] }).kind === "price-moved");
    const market = c({ operations: ["op_too_few_offers"] });
    ok("op_too_few_offers is no market, and final", market.kind === "no-market" && market.terminal);
    ok("op_no_destination is final", c({ operations: ["op_no_destination"] }).terminal);
    const trust = c({ operations: ["op_no_trust"] });
    ok("op_no_trust names the repair", trust.kind === "no-trustline" && trust.action === "repair-trustline");
    ok("op_src_no_trust lands on the same repair", c({ operations: ["op_src_no_trust"] }).kind === "no-trustline");
    ok("op_line_full is final", c({ operations: ["op_line_full"] }).kind === "line-full");
    const cross = c({ operations: ["op_cross_self"] });
    ok("op_cross_self is worth another tap", cross.kind === "crossed-self" && !cross.terminal);
    ok("op_underfunded is about the fee, and final", c({ operations: ["op_underfunded"] }).kind === "not-enough-xlm");
    ok("tx_insufficient_balance too", c({ transaction: "tx_insufficient_balance" }).kind === "not-enough-xlm");
    const auth = c({ transaction: "tx_bad_auth" });
    ok("tx_bad_auth sends them to unlock", auth.kind === "needs-unlock" && auth.action === "unlock");
    const late = c({ transaction: "tx_too_late" });
    ok("tx_too_late expired, nothing moved", late.kind === "expired" && !late.terminal);
    const odd = c({ operations: ["op_something_new"] });
    ok("a code we do not know is terminal and is not a success", odd.kind === "unknown" && odd.terminal);
    const dropped = classifySwapFailure(new TypeError("Failed to fetch"));
    ok("no result code at all is undecided, not failed", dropped.kind === "undecided" && dropped.action === "check-balance");
    ok("and the undecided sentence never says where the money is", !/nothing moved/i.test(dropped.message));
  }

  console.log("\n[12] the engine can only be named by the quote that produced it");
  {
    ok("the built-in exchange is called what it is", engineLabel({ engine: "sdex" }) === "Stellar DEX");
  }

  console.log("\n[13] the amount field, still reading a decimal comma as a decimal point");
  {
    // The 100x bug money.selftest.ts exists to prevent, re-asserted here because this feature adds
    // a new amount field and the default it starts with is a 7dp ledger figure.
    ok('"41,05" is forty one lumens, not four thousand', sanitizeAmountInput("41,05") === "41.05");
    ok("and it parses to the stroops we would send", toStroops(sanitizeAmountInput("41,05")) === 410_500_000n);
    const spendable = "41.0512345";
    ok(
      "the field's default is truncated, so it can never exceed what is spendable",
      toStroops(sanitizeAmountInput(spendable)) <= toStroops(spendable),
    );
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} CONVERSION SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

void main();
