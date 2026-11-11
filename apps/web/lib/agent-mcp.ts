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
 * TWO RAILS, ONE SERVER (NEAR HACKATHON 2026). The four Stellar tools keep their names. The seven
 * `near_*` tools are the same idea on Lumenia's second rail: USDC on NEAR testnet goes from a funder
 * account this process holds the key for into the Lumenia NEAR escrow (`@lumenia/near`, contract
 * lumenia-near.testnet), behind a fresh ed25519 link key, and the link `<origin>/c/near#<secret>`
 * is handed to a person. One `ft_transfer_call` can fund up to 30 links (`near_pay_many`). Every
 * payment writes a receipt BEFORE the deposit is broadcast (the receipt log under LUMENIA_DATA_DIR
 * is the system of record and the idempotency guard: a repeated `reference` returns the first
 * receipt instead of paying twice), a rolling 24-hour budget and a per-link cap are checked before
 * any key is touched, and every refusal that spent nothing says "Nothing was spent". The NEAR rail
 * is optional: without its env the `near_*` tools are still registered and answer with a clear
 * "NEAR rail not configured" error, so a Stellar-only operator sees nothing break.
 *
 * WHAT IT DOES NOT DO. It does not claim, does not spend from a vault, does not hold a human's
 * key, and does not talk to the A-Identity spend-policy vault (that bridge is roadmap: LumenDrop's
 * `deposit` needs the depositor's own `require_auth`). "Agents can pay anyone" is not a claim this
 * makes: the demo is one agent, one key, one link. On NEAR the funder key signs only
 * `ft_transfer_call` into the escrow, `reclaim` of its own expired drops and the one-time
 * `storage_deposit`; there is no generic "send transaction" tool.
 *
 * SAFETY OF THE LINK. The link's `#fragment` is the bearer key (on both rails). The server returns
 * it to the agent (that is the point: the agent forwards it to the person) and never logs it; the
 * agent host's own transcript is where it lives after that, which the human operating the agent
 * should know. Unclaimed money can be taken back after the expiry with `reclaim_link` (Stellar) or
 * `near_reclaim` (NEAR), never automatically. The NEAR receipt log keeps each secret link so the
 * agent can re-send one it made; the `lumenia://near/links` resource exposes exactly that and says
 * so; `near_receipts` and `lumenia://near/receipts.csv` never include a secret.
 *
 * RUN (stdio, e.g. for Claude Code):
 *   LUMENIA_AGENT_SECRET=S... pnpm --filter @lumenia/web agent-mcp                      # Stellar only
 *   LUMENIA_AGENT_SECRET=S... LUMENIA_NEAR_FUNDER_ID=you-funder.testnet \
 *     LUMENIA_NEAR_FUNDER_KEY_FILE=~/.near-credentials/testnet/you-funder.testnet.json \
 *     pnpm --filter @lumenia/web agent-mcp                                                # both rails
 *   claude mcp add lumenia -e LUMENIA_AGENT_SECRET=S... -e LUMENIA_NEAR_FUNDER_ID=... -e LUMENIA_NEAR_FUNDER_KEY_FILE=... -- pnpm --filter @lumenia/web agent-mcp
 * Env, Stellar: LUMENIA_AGENT_SECRET (required; the agent's own testnet key holding Circle USDC and
 * a trustline; the sponsor pays fees), NEXT_PUBLIC_SPONSOR_URL (testnet sponsor by default). Testnet
 * unless the deployment's network env says otherwise; the link carries `?n=public` on mainnet as
 * always.
 * Env, NEAR (all optional; the rail is on when LUMENIA_NEAR_FUNDER_ID is set, testnet only):
 *   LUMENIA_NEAR_FUNDER_ID         the NEAR testnet account that pays (e.g. lumenia-funder.testnet)
 *   LUMENIA_NEAR_FUNDER_SECRET     its key, ed25519:<base58> (read at signing time, never written)
 *   LUMENIA_NEAR_FUNDER_KEY_FILE   or a near-cli keychain JSON; default ~/.near-credentials/testnet/<funder>.json
 *   NEAR_RPC_URL, LUMENIA_CONTRACT_ID, USDC_CONTRACT_ID, DAILY_BUDGET_USDC (50), MAX_LINK_USDC (20),
 *   LUMENIA_DATA_DIR (~/.lumenia-near; holds links.json, the receipt log, shared with apps/agent-market
 *   when both point at the same directory: one writer at a time)   -- the names @lumenia/near reads
 * Shared: LUMENIA_WEB_ORIGIN (default https://getlumenia.com) is the origin of every link on both rails.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  DEFAULTS as NEAR_DEFAULTS,
  DEFAULT_EXPIRES_HOURS as NEAR_DEFAULT_EXPIRES_HOURS,
  formatUsdc,
  loadConfig as loadNearConfig,
  Lumenia,
  MAX_BATCH_DROPS,
  MAX_EXPIRES_HOURS,
  MAX_MEMO_CHARS,
  MAX_REFERENCE_CHARS,
  MIN_EXPIRES_HOURS,
  type Env as NearEnv,
  type LumeniaConfig,
  type LumeniaDeps,
  type Receipt,
} from "@lumenia/near";
import { createV2Link, DepositUncertainError, loadReclaimableV2, reclaimV2, type PreparedDeposit, type ReclaimableV2, type V2Link } from "./lumendrop";
import { activeNetwork } from "./network";
import { loadBalance } from "./horizon";
import { localSignerFromSeed, type Signer } from "./signer";

/** The world this server touches, behind one seam so the self-test can replace it. */
export interface AgentDeps {
  signer: Signer;
  sponsorUrl: string;
  webOrigin: string;
  networkLabel: string;
  createLink: (o: {
    signer: Signer;
    amount: string;
    from: string;
    webOrigin: string;
    sponsorUrl: string;
    expiry?: number;
    /** awaited after signing and before the POST, with the link; see lib/lumendrop.ts createV2Link */
    onPrepared?: (p: PreparedDeposit) => void | Promise<void>;
  }) => Promise<V2Link>;
  listReclaimable: (sender: string) => Promise<ReclaimableV2[]>;
  /** `confirmed: false` is the relay's 202: the take-back was accepted and not yet seen landing. */
  reclaim: (o: { signer: Signer; linkHex: string; sponsorUrl: string }) => Promise<{ hash: string; confirmed?: boolean }>;
  usdcBalance: (address: string) => Promise<string | null>;
  sponsorHealth: () => Promise<{ ok: boolean; network?: string } | null>;
  /** The NEAR rail behind the near_* tools, or the reason it is off (the tools answer with it). */
  near: NearSeam;
}

/**
 * The NEAR rail is the `@lumenia/near` client; the self-test hands one in over the package's
 * FakeChain and a temp store (see openNearRail). `ok: false` keeps the tools registered and refusing.
 */
export type NearSeam = { ok: true; lumenia: Lumenia } | { ok: false; reason: string };

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
/** Above this the sponsor refuses anyway (MAX_DROP_USDC, 5 on mainnet); the check here just says so first. */
const MAX_AMOUNT = 100;
const DEFAULT_EXPIRY_HOURS = 7 * 24;

/** The Lumenia claim route for a NEAR link; the package alone would build its standalone page's `/c`. */
export const NEAR_CLAIM_PATH = "/c/near";
/** The escrow contract takes 0.10 USDC as the smallest drop in a batch; one link follows the same floor here. */
export const NEAR_MIN_LINK_USDC = 0.1;
export const NEAR_NETWORK_LABEL = "NEAR testnet (practice money)";
export const NEAR_UNCONFIGURED =
  "NEAR rail not configured: set LUMENIA_NEAR_FUNDER_ID (the NEAR testnet account that pays) and its key, " +
  "LUMENIA_NEAR_FUNDER_SECRET or LUMENIA_NEAR_FUNDER_KEY_FILE, to turn the near_* tools on. " +
  "The Stellar tools work without them. Nothing was spent.";

function webOriginFromEnv(env: Record<string, string | undefined>): string {
  return (env.LUMENIA_WEB_ORIGIN ?? "https://getlumenia.com").replace(/\/$/, "");
}

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
    webOrigin: webOriginFromEnv(process.env),
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
    near: nearSeamFromEnv(process.env),
  };
}

/**
 * The NEAR rail from the environment. Never throws: a Stellar-only operator has none of these
 * variables and gets `ok: false` with the sentence the tools will answer with; a wrong value (a
 * malformed account id, NEAR_NETWORK=mainnet, which the package refuses) is reported the same way
 * instead of taking the Stellar tools down with it. The funder key is resolved by the package at
 * signing time, so the read-only tools work before any key exists.
 */
export function nearSeamFromEnv(env: Record<string, string | undefined> = process.env): NearSeam {
  const funderId = env.LUMENIA_NEAR_FUNDER_ID?.trim();
  if (!funderId) return { ok: false, reason: NEAR_UNCONFIGURED };
  const nearEnv: NearEnv = {
    NEAR_NETWORK: env.NEAR_NETWORK,
    NEAR_RPC_URL: env.NEAR_RPC_URL,
    LUMENIA_CONTRACT_ID: env.LUMENIA_CONTRACT_ID,
    USDC_CONTRACT_ID: env.USDC_CONTRACT_ID,
    FUNDER_ACCOUNT_ID: funderId,
    FUNDER_PRIVATE_KEY: env.LUMENIA_NEAR_FUNDER_SECRET,
    FUNDER_KEY_FILE: env.LUMENIA_NEAR_FUNDER_KEY_FILE,
    WEB_ORIGIN: webOriginFromEnv(env),
    DAILY_BUDGET_USDC: env.DAILY_BUDGET_USDC,
    MAX_LINK_USDC: env.MAX_LINK_USDC,
    LUMENIA_DATA_DIR: env.LUMENIA_DATA_DIR,
    ONECLICK_URL: env.ONECLICK_URL,
  };
  try {
    return { ok: true, lumenia: openNearRail(loadNearConfig(nearEnv)) };
  } catch (e) {
    return { ok: false, reason: `NEAR rail not configured: ${e instanceof Error ? e.message : String(e)} The Stellar tools work without it. Nothing was spent.` };
  }
}

/**
 * The `@lumenia/near` client with Lumenia's claim path on every receipt it writes. The package
 * builds `<origin>/c#<secret>` (the path of its standalone claim page); inside Lumenia the NEAR
 * claim screen is `/c/near`, so the link is re-pathed as the receipt is written, before the deposit
 * is broadcast. The receipt log on disk, the tool result and the links resource therefore all carry
 * the link that works. `deps` replaces the chain, the store and the clock in the self-test. (The
 * package does not export its LinkStore, so the store to wrap comes from a first construction.)
 */
export function openNearRail(config: LumeniaConfig, deps: LumeniaDeps = {}): Lumenia {
  const probe = new Lumenia(config, deps);
  return new Lumenia(config, { ...deps, chain: probe.chain, store: nearClaimStore(probe.store, config.webOrigin) });
}

type NearStore = Lumenia["store"];

/** A receipt store that re-paths the package's `/c#` link to Lumenia's `/c/near#` as it is written. */
export function nearClaimStore(base: NearStore, webOrigin: string): NearStore {
  const origin = webOrigin.replace(/\/+$/, "");
  const packaged = `${origin}/c#`;
  const repath = (r: Receipt) => {
    if (r.link && r.link.startsWith(packaged)) r.link = `${origin}${NEAR_CLAIM_PATH}#${r.link.slice(packaged.length)}`;
  };
  return {
    path: base.path,
    load: () => base.load(),
    save: (file) => base.save(file),
    upsert: (receipt) => {
      repath(receipt);
      base.upsert(receipt);
    },
    upsertMany: (receipts) => {
      for (const r of receipts) repath(r);
      base.upsertMany(receipts);
    },
    findByBatchId: (batchId) => base.findByBatchId(batchId),
    all: () => base.all(),
    findByPublicKey: (publicKey) => base.findByPublicKey(publicKey),
    findByReference: (reference) => base.findByReference(reference),
  };
}

export function buildAgentServer(deps: AgentDeps): McpServer {
  const server = new McpServer({ name: "lumenia", version: "0.2.0" });
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
        expiryHours: z.number().int().min(1).max(7 * 24).optional().describe("Hours until the sender may take unclaimed money back (default and maximum 168 = 7 days, the escrow's expiry horizon)"),
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
      const expiresAt = new Date(expiry * 1000).toISOString();
      /* The link is kept HERE, before the POST (onPrepared), in this call's own memory: the sponsor
         can submit the deposit and the reply be lost, and until now that lost the link, its id and
         the agent's money with it. Never logged (see the header); it is returned to the agent. */
      const kept: { prepared: { link: string; linkHex: string; retrySafeAfter: number } | null } = { prepared: null };
      let link: V2Link;
      try {
        link = await deps.createLink({
          signer: deps.signer,
          amount: amt.toFixed(2),
          from,
          webOrigin: deps.webOrigin,
          sponsorUrl: deps.sponsorUrl,
          expiry,
          onPrepared: (p) => {
            kept.prepared = { link: p.link, linkHex: p.linkHex, retrySafeAfter: p.retrySafeAfter };
          },
        });
      } catch (e) {
        const p = kept.prepared;
        /* Nothing kept: the failure came before anything was signed, so nothing moved. A stated
           refusal after it (a status and the sponsor's words) never reached the ledger either. */
        if (!p || refusedBySponsor(e)) return refuse(e instanceof Error ? e.message : String(e));
        /* Anything else after the POST is undecided: the relay's 202 settled as "not yet", an escrow
           that could not be read, or one read empty at the bare deadline by this machine's clock.
           The link goes back with confirmed:false. A second create_payment_link for the same payment
           is what escrows the money twice, so the text says not to. */
        const u = e instanceof DepositUncertainError ? { link: e.link, linkHex: e.linkHex, retrySafeAfter: e.retrySafeAfter } : p;
        const retrySafeAfter = Number.isFinite(u.retrySafeAfter) ? u.retrySafeAfter : null;
        return {
          content: [
            {
              type: "text",
              text:
                `Link accepted, not yet confirmed, on ${deps.networkLabel}: ${u.link}\n` +
                `Amount ${amt.toFixed(2)} USDC from ${address}. The deposit was handed to the network and the escrow has not shown it yet. ` +
                `Do not create another link for the same payment: send this one, and if nobody claims it call reclaim_link with linkHex ${u.linkHex} after ${expiresAt}. ` +
                (retrySafeAfter !== null
                  ? `Only after ${new Date(retrySafeAfter).toISOString()} does an empty escrow mean nothing moved.`
                  : "The deposit carried no deadline, so an empty escrow is never proof that nothing moved."),
            },
          ],
          structuredContent: { link: u.link, linkHex: u.linkHex, amount: amt.toFixed(2), from, sender: address, confirmed: false, retrySafeAfter, expiresAt, network: deps.networkLabel },
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Link ready on ${deps.networkLabel}: ${link.link}\n` +
              `Amount ${amt.toFixed(2)} USDC from ${address}. Deposit tx ${link.hash || "(confirmed by the escrow; the answer named no transaction)"}. ` +
              `Whoever opens the link can claim; if nobody does, call reclaim_link with linkHex ${link.linkHex} after ${expiresAt}.`,
          },
        ],
        structuredContent: { link: link.link, linkHex: link.linkHex, amount: amt.toFixed(2), from, sender: address, depositHash: link.hash, confirmed: true, expiresAt, network: deps.networkLabel },
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
      const { hash, confirmed } = await deps.reclaim({ signer: deps.signer, linkHex, sponsorUrl: deps.sponsorUrl });
      /* The relay's 202 is not money back: the take-back was accepted and the ledger had not shown
         it landing when the relay stopped watching. Saying "Reclaimed" on it told the agent, and
         whoever it reports to, that the money was back when the take-back might not land. Asking
         again is safe: the escrow releases a drop once, so a second take-back of one that landed is
         refused by its own simulation with nothing moved. */
      if (confirmed === false) {
        return {
          content: [
            {
              type: "text",
              text:
                `Take-back of ${linkHex} accepted, not yet confirmed (tx ${hash || "unknown"}). ` +
                "It may still land; check list_reclaimable in a minute, and call reclaim_link again only if the link is still listed.",
            },
          ],
          structuredContent: { linkHex, hash, confirmed: false },
        };
      }
      return { content: [{ type: "text", text: `Reclaimed ${linkHex}: tx ${hash}` }], structuredContent: { linkHex, hash, confirmed: true } };
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

  registerNearTools(server, deps.near);

  return server;
}

type ToolReply = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/** A result the agent can read as text and as structure (the package's own result object). */
function done(text: string, structured: object): ToolReply {
  return { content: [{ type: "text", text }], structuredContent: structured as Record<string, unknown> };
}

/** A refusal or failure in the package's words; the ones that spent nothing say so. */
function fail(e: unknown): ToolReply {
  return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
}

/** The package's instruction names its own MCP tool; here the take-back tool is near_reclaim. */
const nearInstruction = (text: string) => text.replace(/\blumenia_reclaim\b/g, "near_reclaim");

/**
 * The seven NEAR tools and two resources, mirroring external/lumenia-near/mcp (the standalone
 * server this folds in) under `near_` names. Registered whether or not the rail is configured:
 * an unconfigured rail answers every call with its reason and nothing else happens.
 */
function registerNearTools(server: McpServer, seam: NearSeam): void {
  const cfg = seam.ok ? seam.lumenia.config : null;
  const maxLink = cfg ? formatUsdc(cfg.maxLinkUnits) : formatUsdc(BigInt(NEAR_DEFAULTS.maxLinkUsdc) * 1_000_000n);
  const dailyBudget = cfg ? formatUsdc(cfg.dailyBudgetUnits) : formatUsdc(BigInt(NEAR_DEFAULTS.dailyBudgetUsdc) * 1_000_000n);
  const funder = cfg?.funderAccountId ?? "(the funder account, once LUMENIA_NEAR_FUNDER_ID is set)";
  const rail = (): Lumenia => {
    if (!seam.ok) throw new Error(seam.reason);
    return seam.lumenia;
  };
  const twoDecimals = (n: number) => /^\d+(\.\d{1,2})?$/.test(String(n));
  const amountSchema = (what: string) =>
    z.number().min(NEAR_MIN_LINK_USDC).max(Number(maxLink)).refine(twoDecimals, { message: "at most two decimals (whole cents)" }).describe(what);
  const expiresSchema = z
    .number()
    .int()
    .min(MIN_EXPIRES_HOURS)
    .max(MAX_EXPIRES_HOURS)
    .optional()
    .describe(`Hours the link stays claimable, ${MIN_EXPIRES_HOURS} to ${MAX_EXPIRES_HOURS} (default ${NEAR_DEFAULT_EXPIRES_HOURS}); after that the funder may take unclaimed money back`);
  const referenceSchema = z
    .string()
    .min(1)
    .max(MAX_REFERENCE_CHARS)
    .optional()
    .describe("Idempotency key such as an invoice or payroll run id: a repeat call with the same reference returns the existing receipt(s) instead of paying again");

  server.registerTool(
    "near_pay_link",
    {
      title: "Pay a person by link on NEAR",
      description:
        `Pay a PERSON who has no wallet, on ${NEAR_NETWORK_LABEL}: escrows USDC from the funder account ${funder} in Lumenia's NEAR escrow and returns a claim link ` +
        `(${NEAR_CLAIM_PATH}#<secret>). The recipient opens it in any browser and claims with no wallet, no seed phrase and no gas, into a NEAR account created at claim time. ` +
        "The link's #fragment is the bearer key: whoever holds the link can claim, so forward it over a private channel and never post it. " +
        "Unclaimed money comes back to the funder with near_reclaim after the expiry (not automatic). " +
        `Limits: ${NEAR_MIN_LINK_USDC} to ${maxLink} USDC per link and ${dailyBudget} USDC per rolling 24 hours (the funder's daily budget); every refusal spends nothing. ` +
        "Pass reference (an order id) so a retry can never pay twice. Testnet only.",
      inputSchema: {
        amountUsdc: amountSchema(`USDC to pay, a number with at most two decimals, e.g. 2.5 (${NEAR_MIN_LINK_USDC} to ${maxLink})`),
        expiresHours: expiresSchema,
        memo: z.string().max(MAX_MEMO_CHARS).optional().describe(`Short note stored with the drop and the receipt (max ${MAX_MEMO_CHARS} characters, one line)`),
        reference: referenceSchema,
        allowDuplicate: z.boolean().optional().describe("Set true to knowingly create a second identical payment (same amount and memo) within 2 minutes of the first"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ amountUsdc, expiresHours, memo, reference, allowDuplicate }) => {
      try {
        const r = await rail().createPayLink({ amountUsdc, expiresHours, memo, reference, allowDuplicate });
        const instruction = nearInstruction(r.instruction);
        const text =
          (r.note ? `${r.note}\n` : "") +
          `NEAR link ready on ${NEAR_NETWORK_LABEL}: ${r.link}\n` +
          `Amount ${r.receipt.amount_usdc} USDC from ${r.receipt.funder_account}; deposit tx ${r.txHash ?? "unknown"}; receipt ${r.receipt.receipt_id}, status ${r.receipt.status}; expires ${r.expiresAt}. ` +
          instruction;
        return done(text, { ...r, instruction, network: NEAR_NETWORK_LABEL });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "near_pay_many",
    {
      title: "Pay several people by link on NEAR",
      description:
        `Pay up to ${MAX_BATCH_DROPS} PEOPLE in one transaction on ${NEAR_NETWORK_LABEL}: one claim link per payout, funded by a single ft_transfer_call to the escrow ` +
        "(the contract keeps all or nothing; any failure refunds the whole batch and spends nothing). Each payout has a label (who it is for), " +
        `an amount between ${NEAR_MIN_LINK_USDC} and ${maxLink} USDC and an optional memo; every payout gets its own receipt carrying the label and a shared batch_id, ` +
        `and the batch total counts against the ${dailyBudget} USDC daily budget. Each link's #fragment is a bearer key: forward every link to its own person privately. ` +
        "Pass reference (a payroll run id) so a retry can never pay the batch twice.",
      inputSchema: {
        payouts: z
          .array(
            z.object({
              label: z.string().min(1).max(MAX_MEMO_CHARS).describe('Who this payout is for, e.g. "Ali, courier" (stored on the receipt, not on chain)'),
              amountUsdc: amountSchema(`USDC for this person, ${NEAR_MIN_LINK_USDC} to ${maxLink}`),
              memo: z.string().max(MAX_MEMO_CHARS).optional().describe(`Optional note stored with this drop (max ${MAX_MEMO_CHARS} characters)`),
            }),
          )
          .min(1)
          .max(MAX_BATCH_DROPS)
          .describe(`1 to ${MAX_BATCH_DROPS} payouts; labels must be distinct`),
        expiresHours: expiresSchema,
        reference: referenceSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ payouts, expiresHours, reference }) => {
      try {
        const r = await rail().createPayLinks({
          payouts: payouts.map((p) => ({ label: p.label, amountUsdc: p.amountUsdc, memo: p.memo })),
          expiresHours,
          reference,
        });
        const instruction = nearInstruction(r.instruction);
        const text =
          (r.note ? `${r.note}\n` : "") +
          `${r.count} NEAR links ready on ${NEAR_NETWORK_LABEL}: ${r.totalUsdc} USDC in one transaction (tx ${r.txHash ?? "unknown"}), batch ${r.batchId}, expiry ${r.expiresAt}.\n` +
          r.payouts.map((p) => `- ${p.label}: ${p.receipt.amount_usdc} USDC ${p.link}`).join("\n") +
          `\n${instruction}`;
        return done(text, { ...r, instruction, network: NEAR_NETWORK_LABEL });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "near_link_status",
    {
      title: "Status of a NEAR link",
      description:
        "Read what the NEAR escrow says about a Lumenia NEAR link: Open, Expired (reclaimable), Claiming, Claimed to <account>, Reclaimed or NotFound. " +
        "Accepts the full link or its public key. Updates and returns the local receipt when this server created the link. Read-only.",
      inputSchema: {
        linkOrPublicKey: z.string().min(8).describe(`The link (https://.../c/near#ed25519:...) or the drop's public key (ed25519:...)`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ linkOrPublicKey }) => {
      try {
        const r = await rail().linkStatus(linkOrPublicKey);
        return done(`${r.status} on ${NEAR_NETWORK_LABEL}: drop ${r.publicKey}${r.drop.amountUsdc ? `, ${r.drop.amountUsdc} USDC` : ""}${r.drop.expiresAt ? `, expires ${r.drop.expiresAt}` : ""}${r.receipt ? `, receipt ${r.receipt.receipt_id}` : ""}.\n${JSON.stringify(r, null, 2)}`, { ...r, network: NEAR_NETWORK_LABEL });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "near_reclaim",
    {
      title: "Take an expired NEAR link's money back",
      description:
        `Return the USDC of an unclaimed NEAR link to the funder ${funder} once the link has expired. Refuses (spending nothing) while the link is still ` +
        "claimable, when it was already claimed or reclaimed, when the escrow has no such drop, and when another account funded it. Returns the updated receipt with the reclaim transaction hash.",
      inputSchema: {
        publicKey: z.string().min(8).describe("The drop's public key (ed25519:...) from near_pay_link, near_pay_many or near_receipts, or the full link"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ publicKey }) => {
      try {
        const r = await rail().reclaim(publicKey);
        return done(`Reclaimed ${r.receipt.amount_usdc} USDC to ${r.receipt.funder_account} on ${NEAR_NETWORK_LABEL}: tx ${r.txHash} (${r.explorerUrl}); receipt ${r.receipt.receipt_id} is now ${r.receipt.status}.`, { ...r, network: NEAR_NETWORK_LABEL });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "near_balances",
    {
      title: "NEAR funder balances and budget",
      description:
        `The NEAR funder account's NEAR and USDC balances on testnet, whether it is registered on the USDC contract, and how much of the ` +
        `${dailyBudget} USDC daily budget is left (per-link cap ${maxLink} USDC). Read-only.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const r = await rail().balances();
        return done(
          `Funder ${r.funder} on ${NEAR_NETWORK_LABEL}: ${r.usdc.balance} USDC (${r.usdc.registered ? "registered" : "NOT registered"} on the USDC contract), ` +
            `${r.near ? `${r.near.available} NEAR available` : "account not found"}; budget ${r.budget.remainingUsdc} of ${r.budget.dailyBudgetUsdc} USDC left in the rolling 24 hours ` +
            `(${r.budget.spentLast24hUsdc} spent), ${r.budget.maxLinkUsdc} USDC per link at most.`,
          r,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "near_cross_chain_quote",
    {
      title: "Cross-chain quote for NEAR USDC (dry)",
      description:
        "What an amount of USDC on NEAR would be worth as USDC on Stellar or Base right now, via a DRY quote from the NEAR Intents 1Click API. " +
        "Informational only: 1Click knows mainnet assets and there is no Intents testnet, so nothing is executed and no deposit address is issued. " +
        "Pass recipient to quote for a real destination wallet (Stellar recipients need a USDC trustline).",
      inputSchema: {
        amountUsdc: z.number().positive().refine(twoDecimals, { message: "at most two decimals" }).describe("USDC amount on NEAR to quote"),
        destination: z.enum(["stellar", "base"]).describe("Destination chain for the USDC"),
        recipient: z.string().min(8).optional().describe("Optional destination address; a documented placeholder is used otherwise"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ amountUsdc, destination, recipient }) => {
      try {
        const r = await rail().crossChainQuote({ amountUsdc, destination, recipient });
        return done(
          `Dry quote: ${r.amountInUsdc} USDC on NEAR -> ${r.amountOutFormatted ?? "?"} USDC on ${r.destination}` +
            `${r.timeEstimateSeconds !== null ? ` in about ${r.timeEstimateSeconds} s` : ""}${r.recipientIsPlaceholder ? " (placeholder recipient)" : ` to ${r.recipient}`}. ${r.note}`,
          r,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "near_receipts",
    {
      title: "NEAR payment receipts",
      description:
        "List the receipts of every NEAR payment this server made, newest first: receipt_id, created_at, amount_usdc, memo, label, batch_id, reference, link_public_key, " +
        "funder_account, create_tx_hash, explorer_url, expires_at, status, claimed_to, reclaim_tx_hash. since filters by creation time; " +
        "refresh re-reads unsettled receipts from the chain. The secret links are never in it (the lumenia://near/links resource has those).",
      inputSchema: {
        since: z.string().optional().describe("Only receipts created at or after this ISO 8601 date, e.g. 2026-11-01"),
        refresh: z.boolean().optional().describe("Re-read Open/Expired/Submitting receipts from the chain before listing"),
        limit: z.number().int().min(1).max(1000).optional().describe("Return at most this many receipts"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ since, refresh, limit }) => {
      try {
        const receipts = await rail().listReceipts({ since, refresh, limit });
        const text =
          receipts.length === 0
            ? "No NEAR receipts yet."
            : `${receipts.length} NEAR receipt(s), newest first:\n` + receipts.map((r) => `${r.created_at} ${r.receipt_id} ${r.amount_usdc} USDC ${r.status}${r.label ? ` (${r.label})` : ""}${r.memo ? ` "${r.memo}"` : ""}`).join("\n");
        return done(text, { count: receipts.length, receipts, network: NEAR_NETWORK_LABEL });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerResource(
    "near-links",
    "lumenia://near/links",
    {
      title: "NEAR links created by this server",
      description:
        "Every NEAR claim link this installation created, with its status. The links contain the secret keys: whoever holds a link can claim its USDC.",
      mimeType: "application/json",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(rail().links(), null, 2) }] }),
  );

  server.registerResource(
    "near-receipts-csv",
    "lumenia://near/receipts.csv",
    {
      title: "NEAR receipts as CSV",
      description: "The same receipts as near_receipts, as an RFC 4180 CSV an accountant can open. No secrets.",
      mimeType: "text/csv",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/csv", text: await rail().receiptsCsv() }] }),
  );
}

function refuse(reason: string) {
  return { content: [{ type: "text" as const, text: `Refused: ${reason}` }], isError: true };
}

/** A refusal with a status and the sponsor's words ("/v2-deposit -> 403: ..."), answered before anything was submitted. */
function refusedBySponsor(e: unknown): boolean {
  return e instanceof Error && /^\/v2-deposit \S+ \d{3}: /.test(e.message);
}

async function main() {
  const deps = depsFromEnv();
  const server = buildAgentServer(deps);
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel; anything human goes to stderr. Never a key, never a link.
  console.error(
    "[lumenia-mcp] ready: create_payment_link, list_reclaimable, reclaim_link, agent_status (Stellar); " +
      "near_pay_link, near_pay_many, near_link_status, near_reclaim, near_balances, near_cross_chain_quote, near_receipts " +
      `(NEAR rail ${deps.near.ok ? `on: funder ${deps.near.lumenia.config.funderAccountId}, receipts in ${deps.near.lumenia.config.dataDir}` : "off: " + deps.near.reason})`,
  );
}

if (process.argv[1] && /agent-mcp\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`[lumenia-mcp] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
