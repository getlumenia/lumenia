/**
 * Agent MCP self-test: the tool surface an AI agent sees, driven through a real MCP client over an
 * in-memory transport, with the ledger and the sponsor replaced by stubs. Pins what the tools
 * promise (a link comes back with its id and expiry; bad amounts are refused before anything is
 * built; reclaim goes to the right drop; nothing starts without the agent's own key).
 *
 * The NEAR half runs the real `@lumenia/near` client over the package's own FakeChain (an in-memory
 * escrow + USDC contract) and a temp receipt store: links come back on Lumenia's `/claim#` path,
 * receipts carry no secret, the budget and the reclaim rules refuse before anything is signed, and
 * a server without the NEAR env keeps the tools registered and refusing while Stellar still works.
 *
 * RUN: pnpm --filter @lumenia/web test:agentmcp   (offline, no keys)
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Keypair } from "@stellar/stellar-sdk";
import { BATCH_TRANSFER_CALL_GAS, newLinkKey, parseLinkOrKey, RECEIPT_CSV_COLUMNS } from "@lumenia/near";
import { FakeChain, tempStore, testConfig } from "../../../packages/near/test/helpers";
import { buildAgentServer, depsFromEnv, NEAR_CLAIM_PATH, NEAR_UNCONFIGURED, nearSeamFromEnv, openNearRail, type AgentDeps } from "./agent-mcp";
import { DepositUncertainError } from "./lumendrop";
import { localSignerFromSeed } from "./signer";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✔" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  cond ? passed++ : failed++;
}

const kp = Keypair.random();
const calls: { createLink: unknown[]; reclaim: unknown[] } = { createLink: [], reclaim: [] };
/** When true, the stub answers a take-back the way /v2-reclaim's 202 reaches reclaimV2. */
let unconfirmedReclaim = false;
/** When set, the stub fails the way lumendrop fails AFTER the POST: the hook has run, then this is thrown. */
let afterPrepared: (() => Error) | null = null;
const LINK_HEX = "ab".repeat(32);
const DEADLINE = 1_800_000_000_000;

// The NEAR rail: the package's in-memory chain, a temp receipt store, a clock this test moves.
const T0 = Date.parse("2026-11-11T12:00:00.000Z");
let nearNowMs = T0;
const nearNow = () => new Date(nearNowMs);
const chain = new FakeChain();
chain.now = nearNow;
chain.usdc = 100_000_000n; // 100 USDC
const quoteCalls: { url: string; body: Record<string, unknown> }[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  quoteCalls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
  const body = {
    correlationId: "corr-1",
    quote: { amountIn: "10000000", amountInFormatted: "10", amountOut: "99832499", amountOutFormatted: "9.9832499", minAmountOut: "98834174", amountOutUsd: "9.978", timeEstimate: 35, withdrawFee: "146891" },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};
const nearRail = openNearRail(testConfig({ webOrigin: "https://getlumenia.com", dailyBudgetUnits: 50_000_000n, maxLinkUnits: 20_000_000n }), {
  chain,
  store: tempStore(),
  now: nearNow,
  fetch: fakeFetch,
});

const deps: AgentDeps = {
  signer: localSignerFromSeed(kp.rawSecretKey()),
  sponsorUrl: "https://sponsor.invalid",
  webOrigin: "https://getlumenia.com",
  networkLabel: "testnet (practice money)",
  createLink: async (o) => {
    calls.createLink.push(o);
    // The private shape (lib/lumendrop.ts v2LinkUrl): no amount in the link, the name after the key.
    const link = `${o.webOrigin}/v2/c/${LINK_HEX}#SECRETFRAGMENT&s=${encodeURIComponent(o.from)}`;
    // As createV2Link does: the hook, with the link, before anything is posted.
    await o.onPrepared?.({ link, linkHex: LINK_HEX, retrySafeAfter: DEADLINE, innerHash: "cd".repeat(32), expiry: o.expiry ?? 0, group: false, amount: o.amount });
    if (afterPrepared) throw afterPrepared();
    return { link, linkHex: LINK_HEX, hash: "deadbeef" };
  },
  listReclaimable: async () => [{ linkHex: "cd".repeat(32), usd: "2.00", expiry: 1_700_000_000 }],
  reclaim: async (o) => {
    calls.reclaim.push(o);
    return unconfirmedReclaim ? { hash: "feedface", confirmed: false } : { hash: "feedface", confirmed: true };
  },
  usdcBalance: async () => "12.34",
  sponsorHealth: async () => ({ ok: true, network: "testnet" }),
  near: { ok: true, lumenia: nearRail },
};

const ALL_TOOLS = "agent_status,create_payment_link,list_reclaimable,near_balances,near_cross_chain_quote,near_link_status,near_pay_link,near_pay_many,near_receipts,near_reclaim,reclaim_link";
const NEAR_LINK_RE = /^https:\/\/getlumenia\.com\/claim#ed25519:[1-9A-HJ-NP-Za-km-z]{80,}$/;
const SECRET_KEY_RE = /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/;
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (r: ToolResult) => ((((r as { content?: unknown }).content ?? []) as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "");
const resourceText = (r: { contents: unknown[] }) => (r.contents[0] as { text?: string } | undefined)?.text ?? "";
const transfers = () => chain.calls.filter((c) => c === "ft_transfer_call").length;

console.log("============================================================");
console.log(" SELF-TEST — agent-as-sender MCP (D14) + NEAR rail");
console.log("============================================================\n");

async function main() {
  const server = buildAgentServer(deps);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "selftest", version: "0" });
  await client.connect(clientT);

  console.log("[surface] the four Stellar tools and the seven NEAR tools, and only those");
  {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    ok("tools are the four Stellar ones plus near_pay_link, near_pay_many, near_link_status, near_reclaim, near_balances, near_cross_chain_quote, near_receipts", names.join(",") === ALL_TOOLS, names.join(","));
    const create = tools.find((t) => t.name === "create_payment_link");
    ok("create_payment_link says the fragment is the bearer key", /bearer key/.test(create?.description ?? ""));
    ok("...and that reclaim is not automatic", /not automatic/.test(create?.description ?? ""));
    const nearPay = tools.find((t) => t.name === "near_pay_link");
    ok("near_pay_link says the fragment is the bearer key, names the /claim path, NEAR testnet and near_reclaim", /bearer key/.test(nearPay?.description ?? "") && (nearPay?.description ?? "").includes(`${NEAR_CLAIM_PATH}#`) && /NEAR testnet/.test(nearPay?.description ?? "") && /near_reclaim/.test(nearPay?.description ?? ""));
    ok("  ...and states the per-link cap and the daily budget from the configured rail", /20\.00 USDC per link/.test(nearPay?.description ?? "") && /50\.00 USDC per rolling 24 hours/.test(nearPay?.description ?? ""));
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri).sort().join(",");
    ok("resources are lumenia://near/links and lumenia://near/receipts.csv", uris === "lumenia://near/links,lumenia://near/receipts.csv", uris);
  }

  console.log("\n[create] a link comes back with its id, amount, sender and expiry");
  {
    const r = await client.callTool({ name: "create_payment_link", arguments: { amount: "2", note: "Ayse's translation" } });
    const sc = r.structuredContent as { link: string; linkHex: string; amount: string; from: string; sender: string; expiresAt: string } | undefined;
    ok("not an error", r.isError !== true);
    ok("the link is returned to the agent, fragment included", typeof sc?.link === "string" && sc.link.includes("#SECRETFRAGMENT"));
    ok("the amount is normalised to two decimals", sc?.amount === "2.00" && (calls.createLink[0] as { amount: string }).amount === "2.00");
    ok("the note becomes the sender name", sc?.from === "Ayse's translation");
    ok("the sender is the agent's own key", sc?.sender === kp.publicKey());
    const exp = Date.parse(sc?.expiresAt ?? "");
    ok("expiry defaults to about 7 days", Math.abs(exp - Date.now() - 7 * 24 * 3600 * 1000) < 60_000, sc?.expiresAt);
    ok("the escrow was asked with the sponsor and origin configured", (calls.createLink[0] as { sponsorUrl: string; webOrigin: string }).sponsorUrl === deps.sponsorUrl && (calls.createLink[0] as { webOrigin: string }).webOrigin === deps.webOrigin);
    const text = textOf(r);
    ok("the text names the network so the agent cannot confuse practice and real money", /testnet \(practice money\)/.test(text));
    ok("the escrow is handed a hook that keeps the link BEFORE the POST", typeof (calls.createLink[0] as { onPrepared?: unknown }).onPrepared === "function");
    ok("  ...and the structure says confirmed:true", (r.structuredContent as { confirmed?: boolean }).confirmed === true);
  }

  console.log("\n[create, undecided] the link kept before the POST comes back when the answer decides nothing");
  {
    const link = `https://getlumenia.com/v2/c/${LINK_HEX}#SECRETFRAGMENT`;
    // The relay's 202, settled by the escrow as "not yet": lumendrop throws the uncertain error.
    afterPrepared = () => new DepositUncertainError(LINK_HEX, link, DEADLINE);
    const r = await client.callTool({ name: "create_payment_link", arguments: { amount: "2", note: "Ayse's translation" } });
    const sc = r.structuredContent as { link?: string; linkHex?: string; confirmed?: boolean; retrySafeAfter?: number | null; amount?: string; expiresAt?: string } | undefined;
    ok("a deposit the escrow has not shown yet is not an error", r.isError !== true);
    ok("  ...it carries the link, fragment included, its id and confirmed:false", sc?.link === link && sc?.linkHex === LINK_HEX && sc?.confirmed === false && sc?.amount === "2.00" && typeof sc?.expiresAt === "string");
    ok("  ...and the deadline after which an empty escrow means nothing moved", sc?.retrySafeAfter === DEADLINE);
    const text = textOf(r);
    ok("  ...the text says accepted and not yet confirmed, carries the link, and says not to make another", /not yet confirmed/.test(text) && text.includes(link) && /Do not create another link/.test(text) && /reclaim_link/.test(text));
    ok("  ...and never 'Link ready'", !/Link ready/.test(text));

    // An escrow read empty at the bare deadline by this machine's clock, after the hook ran: the
    // link is kept, so it goes back with confirmed:false rather than being lost with the throw.
    afterPrepared = () => new Error("/v2-deposit -> not submitted: {}");
    const empty = await client.callTool({ name: "create_payment_link", arguments: { amount: "2" } });
    const emptySc = empty.structuredContent as { link?: string; confirmed?: boolean; retrySafeAfter?: number | null } | undefined;
    ok("an escrow read empty at the deadline, after the hook ran, hands back the kept link as confirmed:false", empty.isError !== true && emptySc?.confirmed === false && emptySc?.link?.includes("#SECRETFRAGMENT") === true && emptySc?.retrySafeAfter === DEADLINE);
    ok("  ...and says so", /not yet confirmed/.test(textOf(empty)));

    // A stated refusal after the hook ran: nothing was submitted, so it is a refusal and no link.
    afterPrepared = () => new Error('/v2-deposit -> 403: {"error":"this wallet is not on the pilot allowlist yet"}');
    const refused = await client.callTool({ name: "create_payment_link", arguments: { amount: "2" } });
    ok("a stated refusal after the hook ran is a refusal carrying the sponsor's words, with no link", refused.isError === true && /pilot allowlist/.test(textOf(refused)) && refused.structuredContent === undefined && !textOf(refused).includes("SECRETFRAGMENT"));
    afterPrepared = () => new Error('/v2-deposit -> 400: {"error":"amount above the cap"}');
    const capped = await client.callTool({ name: "create_payment_link", arguments: { amount: "2" } });
    ok("  ...a 400 too", capped.isError === true && /above the cap/.test(textOf(capped)));
    afterPrepared = null;
  }

  console.log("\n[refuse] bad amounts never reach the escrow");
  {
    const before = calls.createLink.length;
    for (const [amount, why] of [["abc", "not a number"], ["2.005", "three decimals"], ["0", "zero"], ["0.001", "below a cent"], ["101", "above the local ceiling"]] as const) {
      const r = await client.callTool({ name: "create_payment_link", arguments: { amount } });
      ok(`"${amount}" (${why}) is refused`, r.isError === true, ((r.content as { text?: string }[])[0]?.text ?? "").slice(0, 60));
    }
    ok("...and nothing was built for any of them", calls.createLink.length === before);
    const r = await client.callTool({ name: "create_payment_link", arguments: { amount: "2", expiryHours: 0 } });
    ok("an expiry of 0 hours is refused by the schema", r.isError === true);
  }

  console.log("\n[reclaim] the window list and the take-back");
  {
    const list = await client.callTool({ name: "list_reclaimable", arguments: {} });
    const rows = (list.structuredContent as { reclaimable: { linkHex: string }[] }).reclaimable;
    ok("expired, unclaimed links are listed", rows.length === 1 && rows[0]!.linkHex === "cd".repeat(32));
    const r = await client.callTool({ name: "reclaim_link", arguments: { linkHex: "cd".repeat(32) } });
    ok("reclaim returns the hash", (r.structuredContent as { hash: string }).hash === "feedface");
    ok("...for that drop, signed by the agent's key, through the sponsor", (calls.reclaim[0] as { linkHex: string; sponsorUrl: string; signer: { publicKey(): string } }).linkHex === "cd".repeat(32) && (calls.reclaim[0] as { signer: { publicKey(): string } }).signer.publicKey() === kp.publicKey());
    const bad = await client.callTool({ name: "reclaim_link", arguments: { linkHex: "nope" } });
    ok("a malformed link id is refused by the schema", bad.isError === true);

    // The relay's 202: the take-back is on the network and not yet seen landing. Not "Reclaimed".
    unconfirmedReclaim = true;
    const pending = await client.callTool({ name: "reclaim_link", arguments: { linkHex: "cd".repeat(32) } });
    unconfirmedReclaim = false;
    const pendingText = textOf(pending);
    ok("a 202 take-back says 'accepted, not yet confirmed (tx ...)'", /accepted, not yet confirmed \(tx feedface\)/.test(pendingText), pendingText.slice(0, 80));
    ok("  ...and never 'Reclaimed'", !/Reclaimed/.test(pendingText));
    ok("  ...and carries confirmed:false for an agent that reads the structure", (pending.structuredContent as { confirmed?: boolean }).confirmed === false);
    const done = await client.callTool({ name: "reclaim_link", arguments: { linkHex: "cd".repeat(32) } });
    ok("a 200 take-back is reported as reclaimed, confirmed:true", (done.structuredContent as { confirmed?: boolean }).confirmed === true);
  }

  console.log("\n[status] the agent can see where it stands");
  {
    const r = await client.callTool({ name: "agent_status", arguments: {} });
    const sc = r.structuredContent as { address: string; usdc: string; sponsorOk: boolean };
    ok("address, balance and sponsor reachability", sc.address === kp.publicKey() && sc.usdc === "12.34" && sc.sponsorOk === true);
  }

  // ------------------------------------------------------------------ NEAR

  type NearReceipt = { receipt_id: string; amount_usdc: string; status: string; memo: string; label: string | null; batch_id: string | null; reference: string | null; create_tx_hash: string | null; explorer_url: string | null; funder_account: string; network: string; link?: string; created_at: string };
  type PayLinkSc = { link: string; publicKey: string; txHash: string | null; expiresAt: string; instruction: string; receipt: NearReceipt; note?: string; network: string; returnTimer?: { armed: boolean; txHash?: string } };
  let firstLink: PayLinkSc | null = null;

  console.log("\n[near pay] one link on NEAR, through the package's fake chain");
  {
    const r = await client.callTool({ name: "near_pay_link", arguments: { amountUsdc: 2.5, memo: "logo round 2", reference: "inv-1" } });
    const sc = r.structuredContent as PayLinkSc | undefined;
    firstLink = sc ?? null;
    ok("not an error", r.isError !== true, textOf(r).slice(0, 100));
    ok("the link is on Lumenia's NEAR claim path: https://getlumenia.com/claim#ed25519:<secret>", typeof sc?.link === "string" && NEAR_LINK_RE.test(sc.link), sc?.link?.slice(0, 40));
    ok("  ...and its fragment is the secret whose public key the escrow knows the drop by", !!sc && parseLinkOrKey(sc.link).publicKey === sc.publicKey && sc.publicKey.startsWith("ed25519:"));
    ok("the receipt carries amount, memo, reference, funder, tx and explorer url, status Open, network testnet", sc?.receipt.amount_usdc === "2.50" && sc?.receipt.memo === "logo round 2" && sc?.receipt.reference === "inv-1" && sc?.receipt.funder_account === "lumenia-funder.testnet" && sc?.receipt.create_tx_hash === "FAKETX1" && sc?.receipt.explorer_url === "https://testnet.nearblocks.io/txns/FAKETX1" && sc?.receipt.status === "Open" && sc?.receipt.network === "testnet");
    ok("  ...and the receipt never holds the secret link", !!sc && !("link" in sc.receipt));
    ok("expiry defaults to 8 hours from the rail's clock, a life one return timer covers", sc?.expiresAt === new Date(T0 + 8 * 3_600_000).toISOString(), sc?.expiresAt);
    ok("the deposit is one ft_transfer_call with the drop's public key, expiry and memo", transfers() === 1 && chain.lastMsg?.public_key === sc?.publicKey && chain.lastMsg?.expires_in_s === 8 * 3600 && chain.lastMsg?.memo === "logo round 2");
    ok(
      "then the link's return timer is armed, for that link: the result and the text say so",
      chain.arms.length === 1 && chain.arms[0]?.publicKeys.join() === sc?.publicKey && sc?.returnTimer?.armed === true && /Return timer armed \(tx FAKETX\d+\)/.test(textOf(r)) && /comes back to this account by itself/.test(sc.instruction),
    );
    ok("the USDC left the funder on the fake chain", chain.usdc === 97_500_000n);
    const text = textOf(r);
    ok("the text names NEAR testnet, carries the link and points at near_reclaim, never the package's own tool name", /NEAR testnet/.test(text) && !!sc && text.includes(sc.link) && /near_reclaim/.test(text) && !/lumenia_reclaim/.test(text) && !/lumenia_reclaim/.test(sc.instruction));
    ok("the structure says which network", sc?.network === "NEAR testnet (practice money)");
    const stored = nearRail.store.findByPublicKey(sc?.publicKey ?? "");
    ok("the receipt log on disk holds the same /claim# link (re-pathed before the broadcast, not after)", !!stored && stored.link === sc?.link && stored.status === "Open");

    nearNowMs += 1000;
    const again = await client.callTool({ name: "near_pay_link", arguments: { amountUsdc: 2.5, memo: "logo round 2", reference: "inv-1" } });
    const againSc = again.structuredContent as PayLinkSc | undefined;
    ok("the same reference again pays nothing and returns the first receipt", again.isError !== true && /No new payment/.test(againSc?.note ?? "") && againSc?.publicKey === sc?.publicKey && transfers() === 1);
    ok("  ...and the text says so first", /^No new payment/.test(textOf(again)));

    // The duplicate guard is for calls WITHOUT a reference: the same amount and memo twice inside two minutes.
    const coffee = await client.callTool({ name: "near_pay_link", arguments: { amountUsdc: 1, memo: "coffee" } });
    ok("a payment without a reference goes through", coffee.isError !== true && transfers() === 2);
    const dup = await client.callTool({ name: "near_pay_link", arguments: { amountUsdc: 1, memo: "coffee" } });
    ok("the identical payment again inside two minutes is refused and spent nothing", dup.isError === true && /identical payment/.test(textOf(dup)) && /Nothing was spent/.test(textOf(dup)) && transfers() === 2);
    nearNowMs += 1000;
    const allowed = await client.callTool({ name: "near_pay_link", arguments: { amountUsdc: 1, memo: "coffee", allowDuplicate: true } });
    ok("  ...allowDuplicate:true makes the second payment", allowed.isError !== true && transfers() === 3 && (allowed.structuredContent as PayLinkSc).publicKey !== (coffee.structuredContent as PayLinkSc).publicKey);
  }

  console.log("\n[near pay_many] up to 30 people in one transaction");
  {
    nearNowMs += 1000;
    const payouts = [
      { label: "Ali, courier", amountUsdc: 1, memo: "rent" },
      { label: "Bea", amountUsdc: 0.1 },
      { label: "Can", amountUsdc: 7, memo: "logo" },
    ];
    const r = await client.callTool({ name: "near_pay_many", arguments: { payouts, expiresHours: 48, reference: "payroll-11" } });
    type ManySc = { batchId: string; count: number; totalUsdc: string; txHash: string | null; expiresAt: string; payouts: { label: string; link: string; publicKey: string; receipt: NearReceipt }[]; note?: string };
    const sc = r.structuredContent as ManySc | undefined;
    ok("not an error", r.isError !== true, textOf(r).slice(0, 100));
    ok("three links, 8.10 USDC, one transaction hash shared by every receipt", sc?.count === 3 && sc?.totalUsdc === "8.10" && typeof sc?.txHash === "string" && sc.payouts.every((p) => p.receipt.create_tx_hash === sc.txHash));
    ok("every link is on /claim# and every public key is distinct", !!sc && sc.payouts.every((p) => NEAR_LINK_RE.test(p.link) && parseLinkOrKey(p.link).publicKey === p.publicKey) && new Set(sc.payouts.map((p) => p.publicKey)).size === 3);
    ok("labels, amounts and memos ride on the receipts with one shared batch_id", !!sc && sc.payouts.map((p) => [p.label, p.receipt.amount_usdc, p.receipt.memo, p.receipt.label].join("|")).join(";") === "Ali, courier|1.00|rent|Ali, courier;Bea|0.10||Bea;Can|7.00|logo|Can" && sc.payouts.every((p) => p.receipt.batch_id === sc.batchId && sc.batchId.startsWith("batch_")));
    ok("it was ONE ft_transfer_call asking for the batch gas", transfers() === 4 && chain.lastGas === BATCH_TRANSFER_CALL_GAS && Array.isArray(chain.lastMsg?.drops) && (chain.lastMsg?.drops as unknown[]).length === 3);
    ok("expiry is 48 hours from the rail's clock", sc?.expiresAt === new Date(nearNowMs + 48 * 3_600_000).toISOString());
    const text = textOf(r);
    ok("the text lists each person with their link", !!sc && sc.payouts.every((p) => text.includes(`- ${p.label}: ${p.receipt.amount_usdc} USDC ${p.link}`)));
    const again = await client.callTool({ name: "near_pay_many", arguments: { payouts, expiresHours: 48, reference: "payroll-11" } });
    ok("the same batch reference again pays nothing", again.isError !== true && /No new payment/.test((again.structuredContent as ManySc).note ?? "") && transfers() === 4);

    const before = transfers();
    const twice = await client.callTool({ name: "near_pay_many", arguments: { payouts: [{ label: "Ali", amountUsdc: 1 }, { label: "Ali", amountUsdc: 2 }] } });
    ok("a repeated label is refused by the package before anything is signed", twice.isError === true && /repeats the label/.test(textOf(twice)));
    const tooMany = await client.callTool({ name: "near_pay_many", arguments: { payouts: Array.from({ length: 31 }, (_, i) => ({ label: `p${i}`, amountUsdc: 0.1 })) } });
    ok("31 payouts are refused by the schema", tooMany.isError === true);
    const tiny = await client.callTool({ name: "near_pay_many", arguments: { payouts: [{ label: "Bea", amountUsdc: 0.05 }] } });
    ok("a 0.05 payout is refused by the schema (the escrow's 0.10 floor)", tiny.isError === true);
    const empty = await client.callTool({ name: "near_pay_many", arguments: { payouts: [] } });
    ok("an empty batch is refused by the schema", empty.isError === true);
    ok("...and none of them reached the chain", transfers() === before);
  }

  console.log("\n[near budget] the funder gets a budget, not the keys to everything");
  {
    // Spent so far in the rolling 24 h: 2.50 + 1.00 + 1.00 + 8.10 = 12.60 of 50.
    nearNowMs += 1000;
    const big = await client.callTool({ name: "near_pay_link", arguments: { amountUsdc: 20, memo: "first" } });
    ok("20 USDC (the per-link maximum) goes through while the budget allows", big.isError !== true && transfers() === 5);
    const over = await client.callTool({ name: "near_pay_link", arguments: { amountUsdc: 20, memo: "second" } });
    ok("the next 20 is refused: it would exceed the daily budget, with the numbers, and nothing was spent", over.isError === true && /exceed the daily budget of 50\.00 USDC/.test(textOf(over)) && /17\.40 USDC left/.test(textOf(over)) && /Nothing was spent/.test(textOf(over)) && transfers() === 5);
    const above = await client.callTool({ name: "near_pay_link", arguments: { amountUsdc: 20.01 } });
    ok("20.01 is refused by the schema (above MAX_LINK_USDC)", above.isError === true && transfers() === 5);
    const b = await client.callTool({ name: "near_balances", arguments: {} });
    const bsc = b.structuredContent as { network: string; funder: string; usdc: { balance: string; registered: boolean }; near: { available: string } | null; budget: { dailyBudgetUsdc: string; spentLast24hUsdc: string; remainingUsdc: string; maxLinkUsdc: string } };
    ok("near_balances shows the funder, its USDC, the registration and the budget left", bsc.funder === "lumenia-funder.testnet" && bsc.network === "testnet" && bsc.usdc.balance === "67.40" && bsc.usdc.registered === true && bsc.near?.available === "9.0000" && bsc.budget.spentLast24hUsdc === "32.60" && bsc.budget.remainingUsdc === "17.40" && bsc.budget.dailyBudgetUsdc === "50.00" && bsc.budget.maxLinkUsdc === "20.00");
    ok("  ...in one readable sentence", /67\.40 USDC/.test(textOf(b)) && /17\.40 of 50\.00 USDC left/.test(textOf(b)));
  }

  console.log("\n[near refuse] bad inputs never reach the chain");
  {
    const before = transfers();
    const cases: [Record<string, unknown>, string][] = [
      [{ amountUsdc: 0.05 }, "below 0.10"],
      [{ amountUsdc: 2.005 }, "three decimals"],
      [{ amountUsdc: "2" }, "a string where a number is due"],
      [{ amountUsdc: 1, expiresHours: 0 }, "expiry 0 h"],
      [{ amountUsdc: 1, expiresHours: 169 }, "expiry 169 h"],
      [{ amountUsdc: 1, expiresHours: 1.5 }, "a fractional hour"],
      [{ amountUsdc: 1, memo: "m".repeat(65) }, "a 65-character memo"],
      [{ amountUsdc: 1, reference: "r".repeat(65) }, "a 65-character reference"],
    ];
    for (const [args, why] of cases) {
      const r = await client.callTool({ name: "near_pay_link", arguments: args });
      ok(`${why} is refused`, r.isError === true, textOf(r).slice(0, 70));
    }
    ok("...and nothing was built for any of them", transfers() === before);
  }

  console.log("\n[near status] what the escrow says about a link");
  {
    const byLink = await client.callTool({ name: "near_link_status", arguments: { linkOrPublicKey: firstLink!.link } });
    const sc = byLink.structuredContent as { publicKey: string; status: string; drop: { kind: string; amountUsdc: string | null }; receipt: NearReceipt | null };
    ok("the full link reads Open, with the drop and the local receipt", byLink.isError !== true && sc.status === "Open" && sc.drop.kind === "Open" && sc.drop.amountUsdc === "2.50" && sc.publicKey === firstLink!.publicKey && sc.receipt?.receipt_id === firstLink!.receipt.receipt_id);
    const byKey = await client.callTool({ name: "near_link_status", arguments: { linkOrPublicKey: firstLink!.publicKey } });
    ok("the public key alone reads the same", (byKey.structuredContent as { status: string }).status === "Open");
    ok("  ...and the text opens with the status", /^Open on NEAR testnet/.test(textOf(byKey)));
    const unknown = await client.callTool({ name: "near_link_status", arguments: { linkOrPublicKey: "ed25519:11111111111111111111111111111111" } });
    const usc = unknown.structuredContent as { status: string; receipt: unknown };
    ok("an unknown key reads NotFound with no receipt", unknown.isError !== true && usc.status === "NotFound" && usc.receipt === null);
    const garbage = await client.callTool({ name: "near_link_status", arguments: { linkOrPublicKey: "not-a-link-at-all" } });
    ok("garbage is refused with the package's explanation", garbage.isError === true && /expected a Lumenia link/.test(textOf(garbage)));
  }

  console.log("\n[near receipts] the log an accountant can read, newest first, no secrets");
  {
    const r = await client.callTool({ name: "near_receipts", arguments: {} });
    const sc = r.structuredContent as { count: number; receipts: NearReceipt[] };
    ok("seven receipts: three single links, three of the batch, the 20 USDC one; refusals wrote none", sc.count === 7 && sc.receipts.length === 7, String(sc.count));
    ok("newest first", sc.receipts[0]?.amount_usdc === "20.00" && sc.receipts[6]?.reference === "inv-1");
    ok("no receipt carries a secret link", sc.receipts.every((x) => !("link" in x)) && !SECRET_KEY_RE.test(JSON.stringify(sc)));
    const since = await client.callTool({ name: "near_receipts", arguments: { since: new Date(T0 + 2500).toISOString() } });
    ok("since filters by creation time", (since.structuredContent as { count: number }).count === 4);
    const limited = await client.callTool({ name: "near_receipts", arguments: { limit: 2, refresh: true } });
    ok("limit caps the list and refresh is accepted", limited.isError !== true && (limited.structuredContent as { count: number }).count === 2);
    const badSince = await client.callTool({ name: "near_receipts", arguments: { since: "yesterday" } });
    ok("a since that is not a date is refused", badSince.isError === true && /not a date/.test(textOf(badSince)));
  }

  console.log("\n[near quote] a dry 1Click quote, informational");
  {
    const r = await client.callTool({ name: "near_cross_chain_quote", arguments: { amountUsdc: 10, destination: "stellar" } });
    const sc = r.structuredContent as { dry: boolean; destination: string; amountInUsdc: string; amountOutFormatted: string | null; recipientIsPlaceholder: boolean; note: string; correlationId: string | null };
    ok("the quote is dry, for 10.00 USDC, with 1Click's numbers and the no-testnet note", r.isError !== true && sc.dry === true && sc.destination === "stellar" && sc.amountInUsdc === "10.00" && sc.amountOutFormatted === "9.9832499" && sc.recipientIsPlaceholder === true && /no testnet/.test(sc.note) && sc.correlationId === "corr-1");
    const call = quoteCalls.at(-1);
    ok("1Click was asked with dry:true for 10000000 units at the configured URL", call?.url === "https://1click.invalid/v0/quote" && call?.body.dry === true && call?.body.amount === "10000000");
    const named = await client.callTool({ name: "near_cross_chain_quote", arguments: { amountUsdc: 2.5, destination: "base", recipient: "0x2527D02599Ba641c19FEa793cD0F167589a0f10E" } });
    ok("a recipient of your own is not a placeholder", (named.structuredContent as { recipientIsPlaceholder: boolean }).recipientIsPlaceholder === false);
    const bad = await client.callTool({ name: "near_cross_chain_quote", arguments: { amountUsdc: 10, destination: "solana" } });
    ok("an unknown destination is refused by the schema", bad.isError === true);
    ok("the text says dry and informational", /Dry quote/.test(textOf(r)) && /Nothing was executed/.test(textOf(r)));
  }

  console.log("\n[near resources] the links (secrets, by design) and the CSV (no secrets)");
  {
    const links = await client.readResource({ uri: "lumenia://near/links" });
    const list = JSON.parse(resourceText(links)) as { link: string | null; status: string }[];
    ok("lumenia://near/links lists every link this installation made, secrets included, on /claim#", list.length === 7 && list.every((l) => typeof l.link === "string" && NEAR_LINK_RE.test(l.link)));
    const csv = await client.readResource({ uri: "lumenia://near/receipts.csv" });
    const csvText = resourceText(csv);
    const lines = csvText.split("\r\n").filter(Boolean);
    ok("lumenia://near/receipts.csv has the package's header and seven rows", lines[0] === RECEIPT_CSV_COLUMNS.join(",") && lines.length === 8);
    ok("  ...and no secret key anywhere in it", !SECRET_KEY_RE.test(csvText));
  }

  console.log("\n[near reclaim] refused before expiry, money back after it");
  {
    const early = await client.callTool({ name: "near_reclaim", arguments: { publicKey: firstLink!.publicKey } });
    ok("before the expiry the take-back is refused, says when, and spent nothing", early.isError === true && /Not expired yet/.test(textOf(early)) && /Nothing was spent/.test(textOf(early)) && !chain.calls.some((c) => c.startsWith("reclaim ")));
    const usdcBefore = chain.usdc;
    nearNowMs = T0 + 25 * 3_600_000;
    const r = await client.callTool({ name: "near_reclaim", arguments: { publicKey: firstLink!.publicKey } });
    const sc = r.structuredContent as { txHash: string; explorerUrl: string; receipt: NearReceipt };
    ok("after the expiry the funder gets the USDC back with a transaction hash", r.isError !== true && typeof sc.txHash === "string" && sc.explorerUrl === `https://testnet.nearblocks.io/txns/${sc.txHash}` && chain.usdc === usdcBefore + 2_500_000n);
    ok("  ...and the receipt turns Reclaimed", sc.receipt.status === "Reclaimed" && sc.receipt.receipt_id === firstLink!.receipt.receipt_id && nearRail.store.findByPublicKey(firstLink!.publicKey)?.status === "Reclaimed");
    ok("  ...the text says Reclaimed with the amount and the tx", /^Reclaimed 2\.50 USDC to lumenia-funder\.testnet/.test(textOf(r)));
    const twice = await client.callTool({ name: "near_reclaim", arguments: { publicKey: firstLink!.publicKey } });
    ok("a second take-back of the same drop is refused", twice.isError === true && /Nothing to reclaim/.test(textOf(twice)));
    const unknown = await client.callTool({ name: "near_reclaim", arguments: { publicKey: "ed25519:11111111111111111111111111111111" } });
    ok("an unknown drop is refused", unknown.isError === true && /nothing to reclaim/i.test(textOf(unknown)));
    const byLink = await client.callTool({ name: "near_link_status", arguments: { linkOrPublicKey: firstLink!.link } });
    ok("and the status now reads Reclaimed", (byLink.structuredContent as { status: string }).status === "Reclaimed");
    const stillOpen = await client.callTool({ name: "near_link_status", arguments: { linkOrPublicKey: (await (async () => (await client.callTool({ name: "near_receipts", arguments: { limit: 6 } })).structuredContent as { receipts: { link_public_key: string; batch_id: string | null }[] })()).receipts.find((x) => x.batch_id)!.link_public_key } });
    ok("the 48-hour batch links are still Open at +25 h", (stillOpen.structuredContent as { status: string }).status === "Open");
  }

  console.log("\n[near off] without the NEAR env the tools stay registered and refuse; Stellar is untouched");
  {
    const off = buildAgentServer({ ...deps, near: { ok: false, reason: NEAR_UNCONFIGURED } });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await off.connect(st);
    const c2 = new Client({ name: "selftest-off", version: "0" });
    await c2.connect(ct);
    const { tools } = await c2.listTools();
    ok("all eleven tools are listed", tools.map((t) => t.name).sort().join(",") === ALL_TOOLS);
    const nearPay = tools.find((t) => t.name === "near_pay_link");
    ok("the schema still states the package defaults (20.00 per link, 50.00 a day)", /20\.00 USDC per link/.test(nearPay?.description ?? "") && /50\.00 USDC per rolling 24 hours/.test(nearPay?.description ?? ""));
    const pay = await c2.callTool({ name: "near_pay_link", arguments: { amountUsdc: 1 } });
    ok("near_pay_link answers 'NEAR rail not configured' naming the env to set, and nothing happened", pay.isError === true && /NEAR rail not configured/.test(textOf(pay)) && /LUMENIA_NEAR_FUNDER_ID/.test(textOf(pay)) && /Nothing was spent/.test(textOf(pay)) && transfers() === 5);
    const bal = await c2.callTool({ name: "near_balances", arguments: {} });
    ok("so does a read-only tool", bal.isError === true && /NEAR rail not configured/.test(textOf(bal)));
    let resourceErr = "";
    try {
      await c2.readResource({ uri: "lumenia://near/links" });
    } catch (e) {
      resourceErr = (e as Error).message;
    }
    ok("and the links resource", /NEAR rail not configured/.test(resourceErr));
    const stellar = await c2.callTool({ name: "create_payment_link", arguments: { amount: "2" } });
    ok("create_payment_link still works on the same server", stellar.isError !== true && (stellar.structuredContent as { confirmed?: boolean }).confirmed === true);
    await c2.close();
    await off.close();
  }

  console.log("\n[env] nothing starts without the agent's own key; the NEAR rail is opt-in and never takes Stellar down");
  {
    delete process.env.LUMENIA_AGENT_SECRET;
    delete process.env.LUMENIA_NEAR_FUNDER_ID;
    let threw = "";
    try {
      depsFromEnv();
    } catch (e) {
      threw = (e as Error).message;
    }
    ok("no secret -> refused", /LUMENIA_AGENT_SECRET/.test(threw));
    process.env.LUMENIA_AGENT_SECRET = "not-a-secret";
    threw = "";
    try {
      depsFromEnv();
    } catch (e) {
      threw = (e as Error).message;
    }
    ok("a malformed secret -> refused", /LUMENIA_AGENT_SECRET/.test(threw));
    process.env.LUMENIA_AGENT_SECRET = kp.secret();
    const d = depsFromEnv();
    ok("a real secret -> the agent's address, on the testnet sponsor by default", d.signer.publicKey() === kp.publicKey() && /testnet/.test(d.networkLabel) && d.sponsorUrl.startsWith("https://"));
    ok("  ...and with no NEAR env the rail is off with the sentence the tools answer", d.near.ok === false && d.near.reason === NEAR_UNCONFIGURED);

    const dataDir = mkdtempSync(join(tmpdir(), "lumenia-mcp-selftest-"));
    const nearKey = newLinkKey();
    const on = nearSeamFromEnv({ LUMENIA_NEAR_FUNDER_ID: "you-funder.testnet", LUMENIA_NEAR_FUNDER_SECRET: nearKey.secretKey, LUMENIA_DATA_DIR: dataDir, LUMENIA_WEB_ORIGIN: "https://staging.getlumenia.com/" });
    ok("LUMENIA_NEAR_FUNDER_ID + LUMENIA_NEAR_FUNDER_SECRET -> the rail is on for that funder, testnet, links on the shared web origin", on.ok && on.lumenia.config.funderAccountId === "you-funder.testnet" && on.lumenia.config.network === "testnet" && on.lumenia.config.webOrigin === "https://staging.getlumenia.com" && on.lumenia.config.dataDir === dataDir);
    ok("  ...with the package defaults for the contract, the budget and the cap", on.ok && on.lumenia.config.contractId === "lumenia-near.testnet" && on.lumenia.config.dailyBudgetUnits === 50_000_000n && on.lumenia.config.maxLinkUnits === 20_000_000n);
    const file = nearSeamFromEnv({ LUMENIA_NEAR_FUNDER_ID: "you-funder.testnet", LUMENIA_NEAR_FUNDER_KEY_FILE: "~/.near-credentials/testnet/you-funder.testnet.json", LUMENIA_DATA_DIR: dataDir });
    ok("LUMENIA_NEAR_FUNDER_KEY_FILE is the other way to name the key (resolved only when something is signed)", file.ok && file.lumenia.config.funderPrivateKey === null && /\/.near-credentials\/testnet\/you-funder\.testnet\.json$/.test(file.lumenia.config.funderKeyFile) && !file.lumenia.config.funderKeyFile.startsWith("~"));
    const mainnet = nearSeamFromEnv({ LUMENIA_NEAR_FUNDER_ID: "you-funder.near", NEAR_NETWORK: "mainnet", LUMENIA_DATA_DIR: dataDir });
    ok("NEAR_NETWORK=mainnet -> off, with the package's refusal, not a crash", !mainnet.ok && /testnet-only/.test(mainnet.reason) && /NEAR rail not configured/.test(mainnet.reason));
    const badId = nearSeamFromEnv({ LUMENIA_NEAR_FUNDER_ID: "Not Valid!!", LUMENIA_DATA_DIR: dataDir });
    ok("a malformed funder id -> off, with the reason", !badId.ok && /not a valid NEAR account id/.test(badId.reason));
    const keyless = nearSeamFromEnv({ LUMENIA_NEAR_FUNDER_ID: "you-funder.testnet", LUMENIA_DATA_DIR: dataDir, LUMENIA_NEAR_FUNDER_SECRET: "ed25519:notakey" });
    ok("a malformed secret is not checked until signing: the read-only tools must work first", keyless.ok);
    process.env.LUMENIA_NEAR_FUNDER_ID = "you-funder.testnet";
    process.env.LUMENIA_DATA_DIR = dataDir;
    const both = depsFromEnv();
    ok("depsFromEnv carries the NEAR rail when LUMENIA_NEAR_FUNDER_ID is set", both.near.ok && both.near.lumenia.config.funderAccountId === "you-funder.testnet");
    delete process.env.LUMENIA_NEAR_FUNDER_ID;
    delete process.env.LUMENIA_DATA_DIR;
  }

  await client.close();
  await server.close();
  console.log(`\n${failed === 0 ? "✅" : "❌"} AGENT MCP SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

void main();
