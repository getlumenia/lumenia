/**
 * Agent MCP LIVE test: a real MCP client spawns the real server over stdio, the server holds a
 * throwaway agent key with one faucet dollar, and `create_payment_link` puts that dollar into the
 * testnet escrow through the testnet sponsor. The drop is then read back from the chain.
 * Network-dependent, not in the offline gate. Spends one practice dollar.
 *
 * RUN: pnpm --filter @lumenia/web test:agentmcp-live
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { loadV2DropStatus } from "./lumendrop";
import { activeNetwork, USDC_ISSUER } from "./network";

const SPONSOR = (process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev").replace(/\/$/, "");
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const step = (m: string) => console.log(`[${at()}] ${m}`);

async function main() {
  const net = activeNetwork();
  if (net.isMainnet || net.passphrase !== Networks.TESTNET) throw new Error("testnet only");
  const horizon = new Horizon.Server(net.horizonUrl);

  // The agent's own key: funded, trustlined, holding one practice dollar. It never holds XLM it
  // needs for fees; the sponsor fee-bumps the deposit.
  const kp = Keypair.random();
  const fb = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(kp.publicKey())}`);
  if (!fb.ok) throw new Error(`friendbot ${fb.status}`);
  const acc = await horizon.loadAccount(kp.publicKey());
  const trust = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: net.passphrase })
    .addOperation(Operation.changeTrust({ asset: new Asset("USDC", USDC_ISSUER.testnet) }))
    .setTimeout(120)
    .build();
  trust.sign(kp);
  await horizon.submitTransaction(trust);
  const faucet = await fetch(`${SPONSOR}/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recipientPublicKey: kp.publicKey() }) });
  const f = (await faucet.json()) as { hash?: string };
  if (!faucet.ok || !f.hash) throw new Error(`faucet ${faucet.status}`);
  step(`agent key ${kp.publicKey()} holds 1 practice dollar (faucet ${f.hash})`);

  // The real server, the real transport: what an agent host does.
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "lib/agent-mcp.ts"],
    env: { ...process.env, LUMENIA_AGENT_SECRET: kp.secret(), NEXT_PUBLIC_SPONSOR_URL: SPONSOR } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-mcp-livetest", version: "0" });
  await client.connect(transport);
  step(`connected over stdio; tools: ${(await client.listTools()).tools.map((t) => t.name).join(", ")}`);

  const status = await client.callTool({ name: "agent_status", arguments: {} });
  step(`agent_status: ${(status.content as { text?: string }[])[0]?.text}`);

  const created = await client.callTool({ name: "create_payment_link", arguments: { amount: "1.00", note: "Lumenia agent spike" } });
  if (created.isError) throw new Error(`create_payment_link refused: ${(created.content as { text?: string }[])[0]?.text}`);
  const sc = created.structuredContent as { link: string; linkHex: string; depositHash: string; expiresAt: string };
  const masked = sc.link.replace(/#.*$/, "#<fragment withheld from this log>");
  step(`link created: ${masked}`);
  step(`linkHex ${sc.linkHex}, deposit tx ${sc.depositHash}, reclaim window opens ${sc.expiresAt}`);

  // Read-only simulation sourced from the agent's own account (any funded account would do).
  const drop = await loadV2DropStatus(sc.linkHex, kp.publicKey());
  step(`escrow says: ${JSON.stringify(drop)}`);

  await client.close();
  console.log("\nRESULT");
  console.log(`  agent            ${kp.publicKey()}`);
  console.log(`  faucet tx        ${f.hash}`);
  console.log(`  deposit tx       ${sc.depositHash}`);
  console.log(`  link id          ${sc.linkHex}`);
  console.log(`  escrow status    ${JSON.stringify(drop)}`);
  console.log(`  total            ${at()}`);
  console.log("\nAGENT MCP LIVE TEST PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nAGENT MCP LIVE TEST FAIL at ${at()}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
