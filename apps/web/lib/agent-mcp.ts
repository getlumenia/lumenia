/**
 * Agent-as-sender MCP server (decision D14, HACKATHON_DURING.md 2.6; "MCP, not x402").
 *
 * THE SHAPE. An AI agent is simply a sender with its own Stellar key and its own USDC. Through
 * this server it can do the one thing a sender does: put dollars in the on-ledger escrow behind a
 * fresh link key and hand the link to a person who has no wallet. The recipient's side is
 * unchanged (no wallet, no app, no XLM; the sponsor pays the claim's fees). The agent needs no XLM
 * either: `/v2-deposit` fee-bumps the deposit exactly as it does for a human sender, and every cap,
 * floor, allowlist and reclaim rule applies to the agent as to anyone (on mainnet its key must be
 * on the pilot allowlist; on testnet it is open).
 *
 * WHAT IT DOES NOT DO. It does not claim, does not spend from a vault, does not hold a human's
 * key, and does not talk to the A-Identity spend-policy vault (that bridge is roadmap: LumenDrop's
 * `deposit` needs the depositor's own `require_auth`). "Agents can pay anyone" is not a claim this
 * makes: the demo is one agent, one key, one link.
 *
 * SAFETY OF THE LINK. The link's `#fragment` is the bearer key. The server returns it to the agent
 * (that is the point: the agent forwards it to the person) and never logs it; the agent host's own
 * transcript is where it lives after that, which the human operating the agent should know.
 * Unclaimed money can be taken back after the expiry with `reclaim_link` (not automatic).
 *
 * RUN (stdio, e.g. for Claude Code):
 *   LUMENIA_AGENT_SECRET=S... pnpm --filter @lumenia/web agent-mcp
 *   claude mcp add lumenia -e LUMENIA_AGENT_SECRET=S... -- pnpm --filter @lumenia/web agent-mcp
 * Env: LUMENIA_AGENT_SECRET (required; the agent's own testnet key holding Circle USDC and a
 * trustline; the sponsor pays fees), NEXT_PUBLIC_SPONSOR_URL (testnet sponsor by default),
 * LUMENIA_WEB_ORIGIN (default https://getlumenia.com). Testnet unless the deployment's network env
 * says otherwise; the link carries `?n=public` on mainnet as always.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { createV2Link, loadReclaimableV2, reclaimV2, type ReclaimableV2, type V2Link } from "./lumendrop";
import { activeNetwork } from "./network";
import { loadBalance } from "./horizon";
import { localSignerFromSeed, type Signer } from "./signer";

/** The world this server touches, behind one seam so the self-test can replace it. */
export interface AgentDeps {
  signer: Signer;
  sponsorUrl: string;
  webOrigin: string;
  networkLabel: string;
  createLink: (o: { signer: Signer; amount: string; from: string; webOrigin: string; sponsorUrl: string; expiry?: number }) => Promise<V2Link>;
  listReclaimable: (sender: string) => Promise<ReclaimableV2[]>;
  reclaim: (o: { signer: Signer; linkHex: string; sponsorUrl: string }) => Promise<{ hash: string }>;
  usdcBalance: (address: string) => Promise<string | null>;
  sponsorHealth: () => Promise<{ ok: boolean; network?: string } | null>;
}

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
/** Above this the sponsor refuses anyway (MAX_DROP_USDC, 5 on mainnet); the check here just says so first. */
const MAX_AMOUNT = 100;
const DEFAULT_EXPIRY_HOURS = 7 * 24;

export function depsFromEnv(): AgentDeps {
  const secret = process.env.LUMENIA_AGENT_SECRET?.trim();
  if (!secret || !StrKey.isValidEd25519SecretSeed(secret)) {
    throw new Error("LUMENIA_AGENT_SECRET must be the agent's own Stellar secret key (S...)");
  }
  const kp = Keypair.fromSecret(secret);
  const net = activeNetwork();
  const sponsorUrl = (process.env.NEXT_PUBLIC_SPONSOR_URL ?? net.sponsorUrl ?? "https://lumenia-sponsor.avakit.workers.dev").replace(/\/$/, "");
  return {
    signer: localSignerFromSeed(kp.rawSecretKey()),
    sponsorUrl,
    webOrigin: (process.env.LUMENIA_WEB_ORIGIN ?? "https://getlumenia.com").replace(/\/$/, ""),
    networkLabel: net.isMainnet ? "mainnet (real money, capped pilot)" : "testnet (practice money)",
    createLink: createV2Link,
    listReclaimable: loadReclaimableV2,
    reclaim: reclaimV2,
    usdcBalance: async (address) => (await loadBalance(address))?.usd ?? null,
    sponsorHealth: async () => {
      try {
        const r = await fetch(`${sponsorUrl}/health`);
        return r.ok ? ((await r.json()) as { ok: boolean; network?: string }) : null;
      } catch {
        return null;
      }
    },
  };
}

export function buildAgentServer(deps: AgentDeps): McpServer {
  const server = new McpServer({ name: "lumenia", version: "0.1.0" });
  const address = deps.signer.publicKey();

  server.registerTool(
    "create_payment_link",
    {
      title: "Create a Lumenia payment link",
      description:
        "Put USDC from this agent's own Stellar account into Lumenia's on-ledger escrow behind a fresh link and return the link. " +
        "Send the link to the person you are paying; they need no wallet, no app and no XLM to claim it, and they pay no network fee. " +
        "The link's #fragment is the bearer key: whoever holds the link can claim. Unclaimed money can be taken back after the expiry with reclaim_link (not automatic). " +
        "Amounts are USD with at most two decimals; the sponsor's caps apply (5 per link on mainnet).",
      inputSchema: {
        amount: z.string().describe('Dollars to send, e.g. "2.00"'),
        note: z.string().max(40).optional().describe("Who the link is from, shown to the recipient (default: the agent's name)"),
        expiryHours: z.number().int().min(1).max(30 * 24).optional().describe("Hours until the sender may take unclaimed money back (default 168 = 7 days)"),
      },
    },
    async ({ amount, note, expiryHours }) => {
      if (!AMOUNT_RE.test(amount)) return refuse("amount must be dollars with at most two decimals, like 2.00");
      const amt = Number.parseFloat(amount);
      if (!(amt >= 0.01)) return refuse("amount must be at least 0.01");
      if (amt > MAX_AMOUNT) return refuse(`amount above ${MAX_AMOUNT} is refused here; the sponsor's per-link cap is lower still`);
      const hours = expiryHours ?? DEFAULT_EXPIRY_HOURS;
      const expiry = Math.floor(Date.now() / 1000) + hours * 3600;
      const from = (note?.trim() || "An agent").slice(0, 40);
      const link = await deps.createLink({ signer: deps.signer, amount: amt.toFixed(2), from, webOrigin: deps.webOrigin, sponsorUrl: deps.sponsorUrl, expiry });
      const expiresAt = new Date(expiry * 1000).toISOString();
      return {
        content: [
          {
            type: "text",
            text:
              `Link ready on ${deps.networkLabel}: ${link.link}\n` +
              `Amount ${amt.toFixed(2)} USDC from ${address}. Deposit tx ${link.hash || "(unconfirmed, see the escrow)"}. ` +
              `Whoever opens the link can claim; if nobody does, call reclaim_link with linkHex ${link.linkHex} after ${expiresAt}.`,
          },
        ],
        structuredContent: { link: link.link, linkHex: link.linkHex, amount: amt.toFixed(2), from, sender: address, depositHash: link.hash, expiresAt, network: deps.networkLabel },
      };
    },
  );

  server.registerTool(
    "list_reclaimable",
    {
      title: "List links whose reclaim window has opened",
      description: "Links this agent funded that were not claimed before their expiry. Each can be taken back with reclaim_link.",
      inputSchema: {},
    },
    async () => {
      const rows = await deps.listReclaimable(address);
      const text = rows.length === 0 ? "Nothing to take back." : rows.map((r) => `${r.linkHex}: ${r.usd} USDC, window opened ${new Date(r.expiry * 1000).toISOString()}`).join("\n");
      return { content: [{ type: "text", text }], structuredContent: { reclaimable: rows } };
    },
  );

  server.registerTool(
    "reclaim_link",
    {
      title: "Take unclaimed money back",
      description: "Return the escrowed USDC of an expired, unclaimed link to this agent's account. Refused by the escrow before the expiry.",
      inputSchema: { linkHex: z.string().regex(/^[0-9a-f]{64}$/).describe("The link id from create_payment_link or list_reclaimable") },
    },
    async ({ linkHex }) => {
      const { hash } = await deps.reclaim({ signer: deps.signer, linkHex, sponsorUrl: deps.sponsorUrl });
      return { content: [{ type: "text", text: `Reclaimed ${linkHex}: tx ${hash}` }], structuredContent: { linkHex, hash } };
    },
  );

  server.registerTool(
    "agent_status",
    {
      title: "This agent's Lumenia standing",
      description: "The agent's Stellar address, network, USDC balance and whether the sponsor that pays fees is reachable.",
      inputSchema: {},
    },
    async () => {
      const [usd, health] = await Promise.all([deps.usdcBalance(address), deps.sponsorHealth()]);
      const text = `Address ${address} on ${deps.networkLabel}. USDC ${usd ?? "unknown"}. Sponsor ${health?.ok ? `reachable (${health.network ?? "?"})` : "unreachable"}: it pays the fees, never moves the money.`;
      return { content: [{ type: "text", text }], structuredContent: { address, network: deps.networkLabel, usdc: usd, sponsorOk: Boolean(health?.ok) } };
    },
  );

  return server;
}

function refuse(reason: string) {
  return { content: [{ type: "text" as const, text: `Refused: ${reason}` }], isError: true };
}

async function main() {
  const server = buildAgentServer(depsFromEnv());
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel; anything human goes to stderr.
  console.error("[lumenia-mcp] ready: create_payment_link, list_reclaimable, reclaim_link, agent_status");
}

if (process.argv[1] && /agent-mcp\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`[lumenia-mcp] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
