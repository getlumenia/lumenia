/**
 * NEAR rail self-test: the pure half of apps/web/lib/near, held to the cases the standalone
 * hackathon build shipped with (external/lumenia-near/web/test, 70 cases) plus the invariants this
 * port added. Offline: no RPC, no keys, no relayer. near-api-js runs for key derivation only.
 *
 *   [1]  implicit account derivation (golden key -> hex, agreement with near-api-js)
 *   [2]  link fragment codec, the /c/near claim URL, pasted links
 *   [3]  USDC amounts in and out
 *   [4]  expiry math
 *   [5]  1Click quote body, address shapes, quote responses
 *   [6]  CSV export (RFC 4180, formula guard, the label column)
 *   [7]  chain results: ft_transfer_call msg, outcomes, refusals, reclaim rule, config shape
 *   [8]  named accounts and availability
 *   [9]  batch msg builder and row parser
 *   [10] ledger paging and privacy
 *   [11] pay-forward: POST /relay shape, relayer error mapping, record-before-sign order
 *   [12] the demo sender gate and per-link limits
 *   [13] account id rules
 *   [14] the password-protected key file round-trips
 *   [15] the store never writes a secret into the plain record
 *
 * RUN: pnpm --filter @lumenia/web test:near
 */
import { KeyPair, keyToImplicitAddress } from "near-api-js";
import { RelayRequestError, relay, type RelayOk } from "@lumenia/near/relayer/client";
import { isImplicitAccountId, isValidAccountId, namedAccountId } from "./account-id";
import { formatNear, formatUnits, formatUsd, formatUsdc, parseUsdcAmount } from "./amount";
import { MAX_BATCH_DROPS, batchTotal, buildBatchMsg, parseBatchRows, splitCsvLine } from "./batch";
import { decryptWithPassword, encryptWithPassword } from "./crypto";
import { LINK_CSV_COLUMNS, csvField, csvLine, csvTextField, linkCsvLine, linksCsv } from "./csv";
import { DEMO_MAX_LINK_UNITS, demoSenderAvailable, linkLimits } from "./demo";
import { buildDropMsg, isConfigView, isDropView, isStatsView, isTerminal, memoBytes, reclaimable } from "./drops";
import { EXPIRY_OPTIONS, expiresAtMs, formatRemaining, isExpired, nsToMs, toIso } from "./expiry";
import {
  INTENTS_ASSETS,
  buildQuoteRequest,
  describeTimeEstimate,
  isBaseAddress,
  isStellarAddress,
  parseQuoteResponse,
  quoteDeadline,
  requestQuote,
} from "./intents";
import { claimUrl, decodeLinkFragment, encodeLinkFragment, implicitAccountId, newLinkKey, publicKeyOf, secretFromPastedLink } from "./keys";
import { LEDGER_PAGE_SIZE, ledgerPage, shortAccount, toLedgerRows } from "./ledger";
import { NAME_RULES, availabilityFromLookup, checkName } from "./names";
import { chainResult, ftTransferCallUsedAmount, receiptFailure, refusalReason, successValue, txFailure } from "./outcome";
import type { RpcTransactionResponse } from "./chain";
import { describeRelayError, interpretOutcome, isRelayerExpiry, runPayForward } from "./pay-forward";
import { rpcUrls } from "./rpc";
import type { StoredLink } from "./store";

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`);
  }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function eq(label: string, a: unknown, b: unknown) {
  ok(label, same(a, b), `got ${JSON.stringify(a)}`);
}
/** Every key of `partial` matches `obj` (vitest's toMatchObject, one level deep). */
function matches(label: string, obj: unknown, partial: Record<string, unknown>) {
  const o = (obj ?? {}) as Record<string, unknown>;
  const bad = Object.entries(partial).filter(([k, v]) => !same(o[k], v));
  ok(label, bad.length === 0, bad.map(([k]) => `${k}=${JSON.stringify(o[k])}`).join(", "));
}
function throws(label: string, fn: () => unknown, re: RegExp) {
  try {
    fn();
    ok(label, false, "did not throw");
  } catch (e) {
    ok(label, re.test(e instanceof Error ? e.message : String(e)), String(e));
  }
}
const section = (n: number, title: string) => console.log(`\n[${n}] ${title}`);

// The full-access key of lumenia-near.testnet and the implicit account id NEAR derives from it
// (verified against the credentials file's implicit_account_id and by an independent base58 decode).
const GOLDEN_PUBLIC_KEY = "ed25519:5bC2PGuJRnH2GGjQtHai5pujyVoUGpYpfFz4R7RgffjD";
const GOLDEN_IMPLICIT_ID = "4430f5be515b07c8611ca60af54c3d2ea374922ae3b6d32cca4d18688785e9c8";

function outcome(status: unknown, receipts: unknown[] = []): RpcTransactionResponse {
  return { status, receipts_outcome: receipts, transaction_outcome: { outcome: { logs: [] } } } as unknown as RpcTransactionResponse;
}
const withLogs = (status: unknown, logs: string[]) =>
  ({ status, receipts_outcome: [{ outcome: { status: { SuccessValue: "" }, logs } }], transaction_outcome: { outcome: { logs: [] } } }) as unknown as RpcTransactionResponse;

async function main() {
  console.log("============================================================");
  console.log(" SELF-TEST - the NEAR rail (lib/near)");
  console.log("============================================================");

  section(1, "implicit account derivation");
  eq("the golden public key derives the golden implicit id", implicitAccountId(GOLDEN_PUBLIC_KEY), GOLDEN_IMPLICIT_ID);
  let agree = true;
  for (let i = 0; i < 5; i++) {
    const pk = KeyPair.fromRandom("ed25519").getPublicKey();
    if (implicitAccountId(pk) !== keyToImplicitAddress(pk) || !/^[0-9a-f]{64}$/.test(implicitAccountId(pk))) agree = false;
  }
  ok("agrees with near-api-js keyToImplicitAddress for 5 random keys", agree);
  throws("rejects a key that is not 32 bytes", () => implicitAccountId("ed25519:11111111"), /32/);

  section(2, "link fragment codec and the claim URL");
  {
    const key = newLinkKey();
    const url = claimUrl("https://example.test/", key.secret);
    ok("a link is <origin>/c/near#ed25519:<base58>", /^https:\/\/example\.test\/c\/near#ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(url), url);
    const hash = url.slice(url.indexOf("#"));
    eq("the fragment decodes back to the secret", decodeLinkFragment(hash), key.secret);
    eq("and derives the drop's public key", publicKeyOf(decodeLinkFragment(hash)!), key.publicKey);
    eq("the fragment is the secret itself (no encoding)", encodeLinkFragment(key.secret), key.secret);
    eq("a pasted whole link is accepted", secretFromPastedLink(`  https://host/c/near#${key.secret} `), key.secret);
    eq("a bare secret is accepted", secretFromPastedLink(key.secret), key.secret);
    eq("a percent-encoded copy is accepted", secretFromPastedLink(`#${encodeURIComponent(key.secret)}`), key.secret);
  }
  eq("an empty fragment is refused", decodeLinkFragment("#"), null);
  eq("garbage is refused", decodeLinkFragment("#hello"), null);
  eq("a PUBLIC key is refused (too short to be a secret)", decodeLinkFragment(`#${GOLDEN_PUBLIC_KEY}`), null);
  eq("a secp256k1 key is refused", decodeLinkFragment("#secp256k1:" + "1".repeat(88)), null);
  eq("88 zeros are not base58", decodeLinkFragment("#ed25519:" + "0".repeat(88)), null);
  eq("a link with no fragment yields nothing", secretFromPastedLink("https://host/c/near"), null);

  section(3, "USDC amounts");
  eq('"5" -> 5000000', parseUsdcAmount("5"), { ok: true, units: "5000000" });
  eq('"0.1" -> 100000', parseUsdcAmount("0.1"), { ok: true, units: "100000" });
  eq('"0.10" -> 100000', parseUsdcAmount("0.10"), { ok: true, units: "100000" });
  eq('"12.34" -> 12340000', parseUsdcAmount("12.34"), { ok: true, units: "12340000" });
  eq('".5" -> 500000', parseUsdcAmount(".5"), { ok: true, units: "500000" });
  eq('"5." -> 5000000', parseUsdcAmount("5."), { ok: true, units: "5000000" });
  eq('" 100 " -> 100000000', parseUsdcAmount(" 100 "), { ok: true, units: "100000000" });
  eq('a decimal comma "1,5" -> 1500000', parseUsdcAmount("1,5"), { ok: true, units: "1500000" });
  ok("more than 2 decimals is refused", !parseUsdcAmount("1.234").ok && !parseUsdcAmount("0.001").ok);
  ok("zero, negatives, text, exponent and empty are refused", ["0", "0.00", "-1", "abc", "1e3", ""].every((s) => !parseUsdcAmount(s).ok));
  ok("the testnet maximum holds", parseUsdcAmount("100", { maxUnits: "100000000" }).ok && !parseUsdcAmount("100.01", { maxUnits: "100000000" }).ok);
  eq("5000000 formats as 5.00", formatUsdc("5000000"), "5.00");
  eq("100000 formats as 0.10", formatUsdc("100000"), "0.10");
  eq("5123456 keeps its 6 decimals", formatUsdc("5123456"), "5.123456");
  eq("5100000 formats as 5.10", formatUsdc("5100000"), "5.10");
  eq("100 formats as 0.0001", formatUsdc("100"), "0.0001");
  eq("0 formats as 0.00", formatUsdc("0"), "0.00");
  eq("250000000 formats as $250.00", formatUsd("250000000"), "$250.00");
  eq("7-decimal Stellar units format", formatUnits("49970040", 7), "4.997004");
  eq("  ...with at least two decimals", formatUnits("50000000", 7), "5.00");
  eq("one NEAR", formatNear(10n ** 24n), "1");
  eq("1.2345 NEAR", formatNear(1_234_500_000_000_000_000_000_000n), "1.2345");

  section(4, "expiry math");
  eq("the four options: 10 min demo, 1 h, 24 h, 7 d", EXPIRY_OPTIONS.map((o) => o.seconds), [600, 3600, 86400, 604800]);
  ok("all above the contract minimum of 60 s", EXPIRY_OPTIONS.every((o) => o.seconds >= 60));
  {
    const created = Date.UTC(2026, 10, 11, 12, 0, 0);
    eq("7 days later", expiresAtMs(created, 604800), Date.UTC(2026, 10, 18, 12, 0, 0));
    eq("an hour later, as ISO", toIso(expiresAtMs(created, 3600)), "2026-11-11T13:00:00.000Z");
  }
  eq("ns string -> ms", nsToMs("1762862400000000000"), 1762862400000);
  eq("ns number -> ms", nsToMs(1762862400000000000), 1762862400000);
  eq("0n -> 0", nsToMs(0n), 0);
  ok("expired exactly at the boundary, not before", !isExpired(1000, 999) && isExpired(1000, 1000));
  eq("under a minute", formatRemaining(30_000), "under a minute");
  eq("12 minutes", formatRemaining(12 * 60_000), "12 minutes");
  eq("1 hour", formatRemaining(60 * 60_000), "1 hour");
  eq("3 hours 10 minutes", formatRemaining(3 * 3_600_000 + 10 * 60_000), "3 hours 10 minutes");
  eq("6 days 23 hours", formatRemaining(6 * 86_400_000 + 23 * 3_600_000 + 59 * 60_000), "6 days 23 hours");
  eq("7 days", formatRemaining(7 * 86_400_000), "7 days");

  section(5, "1Click quote body");
  {
    const now = Date.UTC(2026, 10, 11, 12, 0, 0);
    const body = buildQuoteRequest({
      destination: "stellar",
      amountUnits: "5000000",
      recipient: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
      refundTo: "lumenia-funder.testnet",
      nowMs: now,
    });
    eq("the documented shape for a dry Stellar quote", body, {
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      depositType: "ORIGIN_CHAIN",
      destinationAsset: "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu",
      amount: "5000000",
      refundTo: "lumenia-funder.testnet",
      refundType: "ORIGIN_CHAIN",
      recipient: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
      recipientType: "DESTINATION_CHAIN",
      deadline: "2026-11-11T12:03:00.000Z",
    });
    eq(
      "exactly the twelve documented keys",
      Object.keys(body).sort(),
      ["amount", "deadline", "depositType", "destinationAsset", "dry", "originAsset", "recipient", "recipientType", "refundTo", "refundType", "slippageTolerance", "swapType"].sort(),
    );
    const base = buildQuoteRequest({ destination: "base", amountUnits: "1", recipient: "0x4200000000000000000000000000000000000006", refundTo: "a.testnet", nowMs: 0 });
    eq("base targets Base USDC", base.destinationAsset, INTENTS_ASSETS.baseUsdc);
    eq("the origin is NEAR USDC", base.originAsset, INTENTS_ASSETS.nearUsdc);
  }
  eq("the deadline is an ISO instant with zeroed milliseconds", quoteDeadline(Date.UTC(2026, 0, 1, 0, 0, 0, 500)), "2026-01-01T00:03:00.000Z");
  ok("a Stellar G address is recognised by shape", isStellarAddress("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"));
  ok("55 characters is not one", !isStellarAddress("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2"));
  ok("an S secret seed is not one", !isStellarAddress("S" + "BRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"));
  ok("a Base 0x address is recognised by shape", isBaseAddress("0x4200000000000000000000000000000000000006"));
  ok("short and unprefixed are refused", !isBaseAddress("0x42") && !isBaseAddress("4200000000000000000000000000000000000006"));
  {
    const sample = {
      quote: { amountIn: "5000000", amountInFormatted: "5.0", amountOut: "4997004", amountOutFormatted: "4.997004", minAmountOut: "4947033", timeEstimate: 22 },
      quoteRequest: {},
    };
    const r = parseQuoteResponse(200, sample);
    ok("a successful quote parses", r.ok);
    if (r.ok) {
      eq("  amountOutFormatted", r.quote.amountOutFormatted, "4.997004");
      eq("  timeEstimate", r.quote.timeEstimate, 22);
      eq("  no deposit address on a dry quote", r.quote.depositAddress, undefined);
    }
    eq(
      "a refusal surfaces the service message",
      parseQuoteResponse(400, { message: "Destination address does not have a trustline for this asset." }),
      { ok: false, message: "Destination address does not have a trustline for this asset.", status: 400 },
    );
    let seen: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      seen = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify(sample), { status: 200, headers: { "content-type": "application/json" } });
    };
    const body = buildQuoteRequest({ destination: "base", amountUnits: "5000000", recipient: "0x4200000000000000000000000000000000000006", refundTo: "a.testnet", nowMs: 0 });
    const quoted = await requestQuote(body, fakeFetch);
    ok("requestQuote answers ok", quoted.ok);
    const s = seen as { url: string; init: RequestInit } | null;
    eq("posts to /v0/quote", s?.url, "https://1click.chaindefuser.com/v0/quote");
    eq("  as POST", s?.init.method, "POST");
    ok("  without an API key", !new Headers(s?.init.headers).has("authorization"));
    eq("  with the body as JSON", JSON.parse(String(s?.init.body)), body);
  }
  eq("22 s in words", describeTimeEstimate(22), "about 22 seconds");
  eq("180 s in words", describeTimeEstimate(180), "about 3 minutes");

  section(6, "CSV export (RFC 4180)");
  {
    const row = {
      created_at: "2026-11-11T12:00:00.000Z",
      public_key: "ed25519:5bC2PGuJRnH2GGjQtHai5pujyVoUGpYpfFz4R7RgffjD",
      amount_usdc: "5.00",
      memo: 'Tickets, row 4, "front"',
      expires_at: "2026-11-18T12:00:00.000Z",
      status: "Open",
      claimed_to: "",
      create_tx_hash: "abc",
      explorer_url: "https://testnet.nearblocks.io/txns/abc",
      label: "Row 1, Ada",
    };
    eq("a comma is quoted", csvField("Tickets, row 4"), '"Tickets, row 4"');
    eq("inner quotes are doubled", csvField('say "hi"'), '"say ""hi"""');
    eq("plain stays plain", csvField("plain"), "plain");
    eq("empty and null are empty", [csvField(""), csvField(null)], ["", ""]);
    eq("a line break is quoted", csvField("line\nbreak"), '"line\nbreak"');
    eq("every line ends with CRLF", csvLine(["a", "b"]), "a,b\r\n");
    eq(
      "a whole row",
      linkCsvLine(row),
      '2026-11-11T12:00:00.000Z,ed25519:5bC2PGuJRnH2GGjQtHai5pujyVoUGpYpfFz4R7RgffjD,5.00,"Tickets, row 4, ""front""",2026-11-18T12:00:00.000Z,Open,,abc,https://testnet.nearblocks.io/txns/abc,"Row 1, Ada"\r\n',
    );
    eq("the agreed column order", LINK_CSV_COLUMNS, ["created_at", "public_key", "amount_usdc", "memo", "expires_at", "status", "claimed_to", "create_tx_hash", "explorer_url", "label"]);
    const csv = linksCsv([row]);
    eq("the header line", csv.split("\r\n")[0], "created_at,public_key,amount_usdc,memo,expires_at,status,claimed_to,create_tx_hash,explorer_url,label");
    ok("the file ends with CRLF and holds header + row", csv.endsWith("\r\n") && csv.split("\r\n").length === 3);
    ok("a single link leaves the label empty", linkCsvLine({ ...row, label: "" }).endsWith(",\r\n"));
    ok("a batch label with a comma is quoted", linkCsvLine(row).endsWith(',"Row 1, Ada"\r\n'));
    ok("a label that looks like a formula is guarded", linkCsvLine({ ...row, label: "=cmd" }).endsWith(",'=cmd\r\n"));
    eq("=1+1 is guarded", csvTextField("=1+1"), "'=1+1");
    eq("@cmd is guarded", csvTextField("@cmd"), "'@cmd");
    eq("ordinary text is untouched", csvTextField("ordinary memo"), "ordinary memo");
  }

  section(7, "chain results");
  eq("the drop msg with a memo", buildDropMsg("ed25519:abc", 604800, "rent"), '{"public_key":"ed25519:abc","expires_in_s":604800,"memo":"rent"}');
  eq("the drop msg without one", buildDropMsg("ed25519:abc", 3600), '{"public_key":"ed25519:abc","expires_in_s":3600}');
  eq("a blank memo is dropped", buildDropMsg("ed25519:abc", 3600, "   "), '{"public_key":"ed25519:abc","expires_in_s":3600}');
  ok("the contract's drop shape is recognised", isDropView({ status: "Open", amount: "5000000", funder: "a", created_at_ns: 1, expires_at_ns: 2, claimed_to: null, memo: null }));
  ok("an unknown status is not a drop", !isDropView({ status: "Weird", amount: "1" }) && !isDropView(null));
  ok("Claimed is terminal, Open is not", isTerminal("Claimed") && !isTerminal("Open"));
  ok("get_stats shape is recognised", isStatsView({ drops_created: 9, drops_claimed: 3, drops_reclaimed: 0, open_drops: 6, pool_balance: "1" }) && !isStatsView({ drops_created: "9" }));
  eq("the amount ft_transfer_call kept", ftTransferCallUsedAmount(outcome({ SuccessValue: btoa(JSON.stringify("5000000")) })), "5000000");
  eq("an empty SuccessValue is null", successValue(outcome({ SuccessValue: "" })), null);
  eq("a string status carries no amount", ftTransferCallUsedAmount(outcome("NotStarted")), null);
  {
    const failure = { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: drop expired" } } } };
    eq("a panic message is extracted", txFailure(outcome({ Failure: failure })), "drop expired");
    const noBalance = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: The account doesn't have enough balance" } } } };
    eq("  with its apostrophes intact", txFailure(outcome({ Failure: noBalance })), "The account doesn't have enough balance");
    ok("a kind without a message is named", /^LackBalanceForState:/.test(txFailure(outcome({ Failure: { ActionError: { index: 0, kind: { LackBalanceForState: { amount: "1" } } } } })) ?? ""));
    eq("success is not a failure", txFailure(outcome({ SuccessValue: "" })), null);
    const panic = { ActionError: { kind: { FunctionCallError: { HostError: { GuestPanic: { panic_msg: "not enough pool" } } } } } };
    eq("a receipt panic is read", receiptFailure(outcome({ SuccessValue: "" }, [{ outcome: { status: { Failure: panic }, logs: [] } }])), "not enough pool");
    eq("a clean receipt is null", receiptFailure(outcome({ SuccessValue: "" }, [{ outcome: { status: { SuccessValue: "" }, logs: [] } }])), null);
  }
  eq("true means paid", chainResult(withLogs({ SuccessValue: btoa("true") }, [])), { ok: true });
  eq("false means rolled back, with the contract's reason", chainResult(withLogs({ SuccessValue: btoa("false") }, ["drop reopened: ft_transfer to the recipient failed"])), { ok: false, reason: "ft_transfer to the recipient failed" });
  eq("false without a log has no reason", chainResult(withLogs({ SuccessValue: btoa("false") }, [])), { ok: false, reason: null });
  eq("a failed transaction has no chain result", chainResult(withLogs({ Failure: {} }, [])), null);
  eq("a batch refusal reason", refusalReason(withLogs({ SuccessValue: "" }, ["batch refused: amounts sum to 5 but 6 was transferred; tokens returned"])), "batch refused: amounts sum to 5 but 6 was transferred");
  eq("no refusal in other logs", refusalReason(withLogs({ SuccessValue: "" }, ["something else"])), null);
  {
    const base = { status: "Open" as const, amount: "1", funder: "f", created_at_ns: "0", expires_at_ns: "2000000000", claimed_to: null, memo: null };
    ok("no reclaim before expiry", !reclaimable(base, 1999));
    ok("reclaim at expiry", reclaimable(base, 2000));
    const claiming = { ...base, status: "Claiming" as const, status_changed_at_ns: "3000000000" };
    ok("a stuck claim waits the full 10 minutes", !reclaimable(claiming, 3000 + 10 * 60 * 1000 - 1) && reclaimable(claiming, 3000 + 10 * 60 * 1000));
    ok("a claimed drop is never reclaimable", !reclaimable({ ...base, status: "Claimed" }, 10 ** 12));
  }
  ok("memo bytes, not characters", memoBytes("abc") === 3 && memoBytes("çay") === 4);
  ok("get_config shape", isConfigView({ owner_id: "o", token_id: "t", root_account_id: "testnet", paused: false, key_allowance: "1", registration_deposit: "1", max_expiry_s: 604800 }) && !isConfigView({ paused: false }));

  section(8, "named accounts");
  eq("alice -> alice.testnet", checkName("alice", "testnet"), { ok: true, name: "alice", accountId: "alice.testnet" });
  eq("trimmed and lowercased", checkName("  Alice-01_x ", "testnet"), { ok: true, name: "alice-01_x", accountId: "alice-01_x.testnet" });
  ok("2 and 32 characters pass", checkName("ab", "testnet").ok && checkName("a".repeat(32), "testnet").ok);
  ok(
    "empty, short, long, dotted and badly shaped names are refused with a reason",
    ["", " ", "a", "a".repeat(33), "al.ice", "-alice", "alice-", "al ice", "al/ice", "Al!ce"].every((bad) => {
      const r = checkName(bad, "testnet");
      return !r.ok && r.reason.length > 0;
    }),
  );
  eq("the rules in one line", NAME_RULES, "2 to 32 characters: a-z, 0-9, - and _");
  eq("an existing account is taken", availabilityFromLookup({ exists: true }), "taken");
  eq("UnknownAccount is free", availabilityFromLookup({ exists: false }), "free");
  eq("anything else is an error, never free", availabilityFromLookup({ error: "RPC did not answer" }), "error");

  section(9, "batch msg builder and row parser");
  {
    const keys = (n: number) => Array.from({ length: n }, (_, i) => `ed25519:key${i}`);
    const msg = buildBatchMsg(
      [
        { publicKey: "ed25519:a", amountUnits: "5000000", memo: "rent" },
        { publicKey: "ed25519:b", amountUnits: "100000", memo: "" },
      ],
      3600,
      "5100000",
    );
    eq("the contract shape, empty memos omitted", JSON.parse(msg), {
      drops: [
        { public_key: "ed25519:a", amount: "5000000", memo: "rent" },
        { public_key: "ed25519:b", amount: "100000" },
      ],
      expires_in_s: 3600,
    });
    throws("a sum that differs from the transfer is refused", () => buildBatchMsg([{ publicKey: "ed25519:a", amountUnits: "5000000" }], 3600, "5000001"), /sum to 5000000/);
    const thirty = keys(30).map((publicKey) => ({ publicKey, amountUnits: "100000" }));
    let thirtyOk = true;
    try {
      buildBatchMsg(thirty, 3600, batchTotal(thirty.map((d) => d.amountUnits)));
    } catch {
      thirtyOk = false;
    }
    ok("thirty drops are accepted", thirtyOk);
    throws("thirty-one are not", () => buildBatchMsg(keys(31).map((publicKey) => ({ publicKey, amountUnits: "100000" })), 3600, "3100000"), /at most 30/);
    throws("zero drops are not", () => buildBatchMsg([], 3600, "0"), /at least one/);
    eq("MAX_BATCH_DROPS is 30", MAX_BATCH_DROPS, 30);
    throws("below min_amount", () => buildBatchMsg([{ publicKey: "ed25519:a", amountUnits: "99999" }], 3600, "99999"), /below min_amount/);
    throws("a non-unit string", () => buildBatchMsg([{ publicKey: "ed25519:a", amountUnits: "0.5" }], 3600, "0.5"), /not a unit string/);
    throws("a duplicate key", () => buildBatchMsg([{ publicKey: "ed25519:a", amountUnits: "100000" }, { publicKey: "ed25519:a", amountUnits: "100000" }], 3600, "200000"), /twice/);

    const r = parseBatchRows('label,amount,memo\nAda, 5, rent\n\nBob,0.10\n"Cy, Jr.",1.25,"thanks, again"\n');
    eq("rows parse with no errors", r.errors, []);
    eq("label, amount[, memo] rows, header and blank lines skipped", r.rows, [
      { line: 2, label: "Ada", amountUnits: "5000000", memo: "rent" },
      { line: 4, label: "Bob", amountUnits: "100000", memo: "" },
      { line: 5, label: "Cy, Jr.", amountUnits: "1250000", memo: "thanks, again" },
    ]);
    eq("the units sum", r.totalUnits, "6350000");
    const bad = parseBatchRows("Ada,0.05\nBob\n,3\nCy,abc\nDi,1.234");
    eq("every bad line is reported, none guessed", bad.rows, []);
    eq("  with its line number", bad.errors.map((e) => e.line), [1, 2, 3, 4, 5]);
    ok("  and the minimum named", /minimum of 0.10/.test(bad.errors[0]?.reason ?? ""));
    const many = Array.from({ length: 31 }, (_, i) => `p${i},1`).join("\n");
    ok("31 rows are refused", parseBatchRows(many).errors.some((e) => /at most 30/.test(e.reason)));
    eq("an empty paste says so", parseBatchRows("").errors, [{ line: 0, reason: "no rows" }]);
    eq("quoted CSV fields split", splitCsvLine('a, "b, c" ,"say ""hi"""'), ["a", "b, c", 'say "hi"']);
  }

  section(10, "ledger paging and privacy");
  eq("an empty ledger is one page", ledgerPage(0, 0), { from_index: 0, limit: 25, page: 0, pages: 1, hasNewer: false, hasOlder: false });
  matches("page 0 of 60", ledgerPage(60, 0), { from_index: 0, limit: 25, pages: 3, hasNewer: false, hasOlder: true });
  matches("page 1 of 60", ledgerPage(60, 1), { from_index: 25, limit: 25, hasNewer: true, hasOlder: true });
  matches("page 2 of 60", ledgerPage(60, 2), { from_index: 50, limit: 25, hasNewer: true, hasOlder: false });
  eq("a page past the end clamps", ledgerPage(60, 9).page, 2);
  eq("a negative page clamps", ledgerPage(60, -1).page, 0);
  eq("LEDGER_PAGE_SIZE is 25", LEDGER_PAGE_SIZE, 25);
  eq("never more than the contract's max limit", ledgerPage(1000, 0, 500).limit, 100);
  {
    const drop = (key: string, memo: string | null) => ({
      public_key: key,
      status: "Open" as const,
      amount: "5000000",
      funder: "lumenia-funder.testnet",
      created_at_ns: "1762862400000000000",
      expires_at_ns: "1763467200000000000",
      claimed_to: "4430f5be515b07c8611ca60af54c3d2ea374922ae3b6d32cca4d18688785e9c8",
      memo,
    });
    eq("named accounts stay whole", shortAccount("alice.testnet"), "alice.testnet");
    eq("implicit ids are shortened", shortAccount("4430f5be515b07c8611ca60af54c3d2ea374922ae3b6d32cca4d18688785e9c8"), "4430f5be...85e9c8");
    eq("null is empty", shortAccount(null), "");
    const rows = toLedgerRows([drop("ed25519:mine", "secret memo"), drop("ed25519:theirs", "their memo")], new Map([["ed25519:mine", { createTxHash: "tx1" }]]));
    matches("my own drop keeps its memo and tx", rows[0], { mine: true, memo: "secret memo", createTxHash: "tx1", claimedToShort: "4430f5be...85e9c8" });
    matches("someone else's drop loses its memo", rows[1], { mine: false, memo: null, createTxHash: null, funderShort: "lumenia-funder.testnet" });
    ok("  and the memo text is nowhere in the row", !JSON.stringify(rows[1]).includes("their memo"));
  }

  section(11, "pay it forward");
  const okOutcome: RelayOk["outcome"] = {
    status: "success",
    kind: "create_link",
    summary: "link opened",
    linkCreated: true,
    usedAmount: "500000",
    failures: [],
    events: [],
    logs: [],
    finalStatus: {},
  };
  {
    let seen: { url: string; init: RequestInit } | null = null;
    const fakeFetch: typeof fetch = async (url, init) => {
      seen = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ txHash: "tx1", explorerUrl: "https://testnet.nearblocks.io/txns/tx1", outcome: okOutcome }), { status: 200 });
    };
    const r = await relay("https://relayer.example/", "QUJD", fakeFetch);
    const s = seen as { url: string; init: RequestInit } | null;
    eq("POST goes to <base>/relay", s?.url, "https://relayer.example/relay");
    eq("  as POST", s?.init.method, "POST");
    eq("  as JSON", new Headers(s?.init.headers).get("content-type"), "application/json");
    eq("  with {signedDelegate: base64}", JSON.parse(String(s?.init.body)), { signedDelegate: "QUJD" });
    eq("  and the answer is parsed", [r.txHash, r.outcome.linkCreated], ["tx1", true]);
    const mounted = { url: "" };
    await relay("https://lumenia-sponsor.example/near", "QUJD", async (url) => {
      mounted.url = String(url);
      return new Response(JSON.stringify({ txHash: "t", explorerUrl: "u", outcome: okOutcome }), { status: 200 });
    });
    eq("a sponsor-mounted base posts to /near/relay", mounted.url, "https://lumenia-sponsor.example/near/relay");
  }
  {
    const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
    const e403 = await relay("https://r", "x", answer(403, { reason: "receiver not allowed", code: "receiver" })).catch((err: unknown) => err);
    ok("403 is a RelayRequestError", e403 instanceof RelayRequestError);
    matches("  with status, code and reason", e403, { status: 403, code: "receiver", reason: "receiver not allowed" });
    eq("  described as a refusal", describeRelayError(e403), "The relayer refused this request: receiver not allowed");
    const e429 = await relay("https://r", "x", answer(429, { reason: "sender cooldown", code: "sender_cooldown", retryAfterS: 7 })).catch((err: unknown) => err);
    matches("429 carries retryAfterS", e429, { status: 429, code: "sender_cooldown", retryAfterS: 7 });
    eq("  and says how long to wait", describeRelayError(e429), "The relayer is at its limit (sender_cooldown). Try again in 7 s.");
    const e502 = await relay("https://r", "x", answer(502, { reason: "rpc down", code: "rpc" })).catch((err: unknown) => err);
    eq("5xx is relayer trouble", describeRelayError(e502), "The relayer had trouble (HTTP 502, rpc): rpc down");
    eq("a network error is unreachable", describeRelayError(new TypeError("Failed to fetch")), "Could not reach the relayer (Failed to fetch).");
    const noJson = await relay("https://r", "x", async () => new Response("gateway timeout", { status: 504 })).catch((err: unknown) => err);
    matches("a non-JSON answer keeps its text", noJson, { status: 504, code: "http_error", reason: "gateway timeout" });
  }
  {
    const input = { senderId: "alice.testnet", amountUnits: "500000", memo: "coffee", expiresInS: 86400, network: "testnet", usdcId: "usdc", escrowId: "escrow" };
    function fakes(relayAnswer: () => Promise<RelayOk>) {
      const order: string[] = [];
      const store = new Map<string, StoredLink>();
      let msgSeen: unknown = null;
      let amountSeen = "";
      const deps = {
        newKey: () => ({ secret: "ed25519:secret" as const, publicKey: "ed25519:pub" }),
        saveLink: async (l: StoredLink) => {
          order.push("save");
          store.set(l.publicKey, l);
        },
        updateLink: (p: Partial<StoredLink> & { publicKey: string }) => {
          order.push("update");
          store.set(p.publicKey, { ...(store.get(p.publicKey) as StoredLink), ...p });
        },
        buildDelegate: async (a: { msg: string; amountUnits: string }) => {
          order.push("build");
          msgSeen = JSON.parse(a.msg);
          amountSeen = a.amountUnits;
          return { base64: "QkFTRTY0" };
        },
        relay: async (b64: string) => {
          order.push("relay:" + b64);
          return relayAnswer();
        },
        now: () => Date.UTC(2026, 10, 11, 12, 0, 0),
      };
      return { order, store, deps, msg: () => msgSeen, amount: () => amountSeen };
    }
    const happy = fakes(async () => ({ txHash: "tx1", explorerUrl: "https://x/tx1", outcome: okOutcome }));
    const r = await runPayForward(input, happy.deps);
    eq("the record is saved BEFORE the delegate is built or relayed", happy.order, ["save", "build", "relay:QkFTRTY0", "update"]);
    eq("the delegate carries the drop msg", happy.msg(), { public_key: "ed25519:pub", expires_in_s: 86400, memo: "coffee" });
    eq("  and the amount", happy.amount(), "500000");
    matches("the stored record", happy.store.get("ed25519:pub"), {
      secret: "ed25519:secret",
      amountUnits: "500000",
      memo: "coffee",
      expiresInS: 86400,
      funder: "alice.testnet",
      relayed: true,
      createdAt: "2026-11-11T12:00:00.000Z",
      createTxHash: "tx1",
    });
    ok("the link was created", r.created && r.txHash === "tx1");
    const refused = { ...okOutcome, linkCreated: false, usedAmount: "0", logs: ["drop refused: amount 50000 is below min_amount 100000; tokens returned"] };
    const sad = fakes(async () => ({ txHash: "tx2", explorerUrl: "https://x/tx2", outcome: refused }));
    const r2 = await runPayForward(input, sad.deps);
    ok("a returned transfer is reported with the escrow reason", !r2.created && r2.reason === "drop refused: amount 50000 is below min_amount 100000");
    ok("  and the record keeps its error", /below min_amount/.test(sad.store.get("ed25519:pub")?.createError ?? ""));
    const early = fakes(async () => ({ txHash: "t", explorerUrl: "u", outcome: okOutcome }));
    const rejected = await runPayForward({ ...input, expiresInS: 600 }, early.deps).then(() => null, (e: unknown) => e);
    ok("a life outside the relayer policy is refused before anything is touched", rejected instanceof Error && /1 hour to 7 days/.test(rejected.message) && early.order.length === 0);
    ok("1 h is a relayer expiry, 7 d + 1 s is not", isRelayerExpiry(3600) && !isRelayerExpiry(604_801));
    eq("a clean outcome is created", interpretOutcome(okOutcome, "500000"), { created: true, reason: "" });
    eq("a failed outcome carries its first failure", interpretOutcome({ ...okOutcome, status: "failure", failures: ["Smart contract panicked: paused"] }, "500000").reason, "Smart contract panicked: paused");
    ok("a zero usedAmount is not created", !interpretOutcome({ ...okOutcome, usedAmount: "0" }, "500000").created);
  }

  section(12, "the demo sender gate");
  {
    const KEY = "ed25519:" + "2".repeat(88);
    ok("offered when the id and a well-formed key are both set", demoSenderAvailable("lumenia-demo.testnet", KEY));
    ok("not without an id", !demoSenderAvailable("", KEY));
    ok("not without a key", !demoSenderAvailable("lumenia-demo.testnet", ""));
    ok("not when both are undefined", !demoSenderAvailable(undefined, undefined));
    ok("not with a malformed key", !demoSenderAvailable("lumenia-demo.testnet", "not-a-key"));
    ok("not with a PUBLIC key (too short)", !demoSenderAvailable("lumenia-demo.testnet", "ed25519:5bC2PGuJRnH2GGjQtHai5pujyVoUGpYpfFz4R7RgffjD"));
    eq("demo: $5.00 cap, 1.00 default", linkLimits(true, "100000000"), { maxUnits: DEMO_MAX_LINK_UNITS, defaultAmount: "1.00" });
    eq("otherwise: the testnet cap, 1 default", linkLimits(false, "100000000"), { maxUnits: "100000000", defaultAmount: "1" });
    ok("5 passes the demo cap, 5.01 does not", parseUsdcAmount("5", { maxUnits: linkLimits(true, "100000000").maxUnits }).ok && !parseUsdcAmount("5.01", { maxUnits: linkLimits(true, "100000000").maxUnits }).ok);
    ok("5.01 passes the testnet cap, 100.01 does not", parseUsdcAmount("5.01", { maxUnits: linkLimits(false, "100000000").maxUnits }).ok && !parseUsdcAmount("100.01", { maxUnits: linkLimits(false, "100000000").maxUnits }).ok);
  }

  section(13, "account ids");
  ok("named, sub and implicit accounts are valid", isValidAccountId("alice.testnet") && isValidAccountId("sub-1_x.alice.testnet") && isValidAccountId(GOLDEN_IMPLICIT_ID));
  ok("an implicit id is recognised, a named one is not", isImplicitAccountId(GOLDEN_IMPLICIT_ID) && !isImplicitAccountId("alice.testnet"));
  ok("bad shapes are refused", ["Alice.testnet", "a", ".testnet", "alice..testnet", "-alice.testnet", "alice-.testnet", "a".repeat(65)].every((s) => !isValidAccountId(s)));
  eq("Alice -> alice.testnet", namedAccountId("Alice", "testnet"), "alice.testnet");
  eq("al -> al.testnet", namedAccountId("al", "testnet"), "al.testnet");
  ok("a, -bad and bad.name are refused", namedAccountId("a", "testnet") === null && namedAccountId("-bad", "testnet") === null && namedAccountId("bad.name", "testnet") === null);
  eq("the RPC list splits on commas", rpcUrls("https://a.example, https://b.example ,"), ["https://a.example", "https://b.example"]);

  section(14, "the password-protected key file");
  {
    const plain = JSON.stringify({ account_id: "x", private_key: "ed25519:secret" });
    const box = await encryptWithPassword("correct horse", plain, 1000);
    eq("AES-256-GCM", box.cipher, "AES-256-GCM");
    eq("PBKDF2-SHA256", box.kdf, "PBKDF2-SHA256");
    ok("the ciphertext does not carry the secret", !box.ciphertext.includes("secret"));
    eq("the right password opens it", await decryptWithPassword("correct horse", box), plain);
    const wrong = await decryptWithPassword("wrong", box).then(() => null, (e: unknown) => e);
    ok("the wrong password is refused", wrong !== null);
  }

  section(15, "the store never writes a secret into the plain record");
  {
    const mem = new Map<string, string>();
    const fakeStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: (i: number) => [...mem.keys()][i] ?? null,
      get length() {
        return mem.size;
      },
    } as Storage;
    (globalThis as unknown as { localStorage: Storage }).localStorage = fakeStorage;
    const store = await import("./store");
    const link: StoredLink = {
      publicKey: "ed25519:pub",
      secret: "ed25519:" + "3".repeat(88),
      amountUnits: "1000000",
      memo: "hi",
      expiresInS: 3600,
      createdAt: "2026-11-11T12:00:00.000Z",
      funder: "f.testnet",
      network: "testnet",
    };
    const kept = await store.saveLink(link);
    ok("without IndexedDB the secret is held for the session only, and the caller is told", kept === false);
    const raw = mem.get("lumenia.near.links.v1") ?? "";
    ok("the plain record exists", raw.includes('"publicKey":"ed25519:pub"'));
    ok("  and carries no secret", !raw.includes("3".repeat(88)) && !raw.includes('"secret"'));
    eq("loadLinks returns the record without a secret", store.loadLinks()[0]?.secret, undefined);
    store.upsertLink({ publicKey: "ed25519:pub", secret: "ed25519:leak", createTxHash: "tx" } as Partial<StoredLink> & { publicKey: string });
    ok("upsertLink strips a secret too", !(mem.get("lumenia.near.links.v1") ?? "").includes("leak"));
    eq("the secret is still recallable this session", await store.linkSecret("ed25519:pub"), link.secret);
    eq("a claim record is kept, its key separately", (store.upsertClaim({ accountId: "a.testnet", publicKey: "pk", dropPublicKey: "ed25519:pub", kind: "named", createdAt: "x" }), store.claimForDrop("ed25519:pub")?.accountId), "a.testnet");
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} NEAR SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\nnear self-test crashed:", e);
  process.exit(1);
});
