/**
 * Agent MCP self-test: the tool surface an AI agent sees, driven through a real MCP client over an
 * in-memory transport, with the ledger and the sponsor replaced by stubs. Pins what the tools
 * promise (a link comes back with its id and expiry; bad amounts are refused before anything is
 * built; reclaim goes to the right drop; nothing starts without the agent's own key).
 *
 * RUN: pnpm --filter @lumenia/web test:agentmcp   (offline, no keys)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Keypair } from "@stellar/stellar-sdk";
import { buildAgentServer, depsFromEnv, type AgentDeps } from "./agent-mcp";
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
};

console.log("============================================================");
console.log(" SELF-TEST — agent-as-sender MCP (D14)");
console.log("============================================================\n");

async function main() {
  const server = buildAgentServer(deps);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "selftest", version: "0" });
  await client.connect(clientT);

  console.log("[surface] the four tools, and only those");
  {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    ok("tools are create_payment_link, list_reclaimable, reclaim_link, agent_status", names.join(",") === "agent_status,create_payment_link,list_reclaimable,reclaim_link", names.join(","));
    const create = tools.find((t) => t.name === "create_payment_link");
    ok("create_payment_link says the fragment is the bearer key", /bearer key/.test(create?.description ?? ""));
    ok("...and that reclaim is not automatic", /not automatic/.test(create?.description ?? ""));
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
    const text = (r.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";
    ok("the text names the network so the agent cannot confuse practice and real money", /testnet \(practice money\)/.test(text));
    ok("the escrow is handed a hook that keeps the link BEFORE the POST", typeof (calls.createLink[0] as { onPrepared?: unknown }).onPrepared === "function");
    ok("  ...and the structure says confirmed:true", (r.structuredContent as { confirmed?: boolean }).confirmed === true);
  }

  console.log("\n[create, undecided] the link kept before the POST comes back when the answer decides nothing");
  {
    const textOf = (r: Awaited<ReturnType<typeof client.callTool>>) => ((r.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "");
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
    const pendingText = ((pending.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "");
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

  console.log("\n[env] nothing starts without the agent's own key");
  {
    delete process.env.LUMENIA_AGENT_SECRET;
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
  }

  await client.close();
  await server.close();
  console.log(`\n${failed === 0 ? "✅" : "❌"} AGENT MCP SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

void main();
