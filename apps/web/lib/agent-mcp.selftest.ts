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
import { localSignerFromSeed } from "./signer";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✔" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  cond ? passed++ : failed++;
}

const kp = Keypair.random();
const calls: { createLink: unknown[]; reclaim: unknown[] } = { createLink: [], reclaim: [] };
const deps: AgentDeps = {
  signer: localSignerFromSeed(kp.rawSecretKey()),
  sponsorUrl: "https://sponsor.invalid",
  webOrigin: "https://getlumenia.com",
  networkLabel: "testnet (practice money)",
  createLink: async (o) => {
    calls.createLink.push(o);
    return { link: `${o.webOrigin}/v2/c/${"ab".repeat(32)}?a=${o.amount}&s=${encodeURIComponent(o.from)}#SECRETFRAGMENT`, linkHex: "ab".repeat(32), hash: "deadbeef" };
  },
  listReclaimable: async () => [{ linkHex: "cd".repeat(32), usd: "2.00", expiry: 1_700_000_000 }],
  reclaim: async (o) => {
    calls.reclaim.push(o);
    return { hash: "feedface" };
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
