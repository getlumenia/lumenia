/**
 * Cloudflare Workers entry for the sponsor service (the Vercel Hobby plan caps a
 * deployment at 12 serverless functions; the sponsor is really ONE service, so it moves
 * to a single Worker with no function limit — proven: @stellar/stellar-sdk@16 runs on
 * workerd + nodejs_compat, Horizon/axios included). This is the front door only — it
 * routes to the SAME platform-agnostic lib/* handlers the node:http server (index.ts)
 * and the Vercel adapters use. Nothing about the money logic, anti-drain, or signing
 * changes.
 *
 * Env: Cloudflare vars/secrets arrive as the `env` param, NOT process.env. We hydrate
 * process.env from it at the top of each request so the existing config/rate-limit/
 * mailer code (which reads process.env) works unchanged. getService() is called lazily
 * (inside fetch), never at module top level — env isn't available at isolate startup.
 */
import { getServiceAsync, enforceRateLimit, corsHeaders } from "./lib/service.js";
import { isHalted } from "./lib/kill-switch.js";
import { runWatchdog } from "./lib/watchdog.js";
import { createAccountHandler } from "./lib/create-account.js";
import { feebumpHandler } from "./lib/feebump.js";
import { sendLinkHandler } from "./lib/send.js";
import { payoutHandler } from "./lib/payout.js";
import { sweepHandler } from "./lib/sweep.js";
import { relayClaimHandler, relayDepositHandler, relayReclaimHandler } from "./lib/soroban-relay.js";
import { faucetHandler } from "./lib/faucet.js";
import { demoLinkHandler } from "./lib/demo-link.js";
import { takeDemoLink, refillDemoPool } from "./lib/demo-pool.js";
import { saveContact } from "./lib/waitlist.js";
import { saveFeedback } from "./lib/feedback.js";
import { handleEvent, recordEvent, eventsSummary } from "./lib/events.js";
import { putBox, getBox, putAliasBox, getAliasBox, type OwnerProof } from "./lib/recovery-store.js";
import { requestOtp, verifyOtp, idForEmail } from "./lib/recovery-otp.js";
import { pilotEnabled, enforcePilot, pilotStatus, approvePilot, rejectPilot, getPilotEmail, getPilotState, verifyApprovalToken } from "./lib/pilot.js";
import { notifyPilotRequest, notifyPilotApproved, notifyPilotRejected, notifyPilotInterest } from "./lib/pilot-request.js";
import { isPublicRefusal, PublicRefusal, checkOnboardingBudget, onboardingBudgetFromEnv } from "./lib/caps.js";
import {
  resolveProof,
  checkIdentity,
  attachIdentity,
  fetchByIdentity,
  detachIdentity,
  detachProviderByAccount,
  listLinks,
  startOAuth,
  finishOAuth,
  availableOAuthProviders,
  OAUTH_PROVIDERS,
  PROVIDERS,
  type Provider,
  type IdentityProof,
  type OAuthProvider,
  type AccountProof,
} from "./lib/identity-links.js";
import {
  claimHandle,
  releaseHandle,
  lookupHandle,
  handleOf,
  federationLookup,
  verifyHandleProof,
  handleAvailability,
} from "./lib/handles.js";
import { StrKey } from "@stellar/stellar-sdk";

type Env = Record<string, unknown>;

let hydrated = false;
function hydrateEnv(env: Env): void {
  // Copy the Worker's vars/secrets into process.env once, so all downstream lib code
  // (loadConfig, kvConfigFromEnv, Resend, ALLOWED_ORIGIN, …) reads them unchanged.
  if (hydrated) return;
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") process.env[k] = v;
  }
  hydrated = true;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}

/** A tiny HTML page — for the one-tap approve link the owner opens from their email. */
function html(status: number, inner: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lumenia pilot</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:14vh auto;padding:0 1.5rem;color:#1a1a2e;line-height:1.6">${inner}</body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", ...corsHeaders() } },
  );
}

function clientIp(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const fwd = request.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0]!.trim() : "unknown";
}

/** A body over MAX_BODY_BYTES. Carried to the top-level catch, which answers 413. */
class BodyTooLarge extends Error {}

/**
 * Read the body with the cap enforced on the bytes ACTUALLY READ. `content-length` is a claim,
 * not a measurement — a chunked request carries none at all — so the header check in `fetch` is
 * only an early-out, and this is what bounds what workerd ends up buffering.
 */
async function readCapped(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new BodyTooLarge("request body too large");
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await readCapped(request);
  if (!text) return {};
  try {
    const b = JSON.parse(text) as unknown;
    return (b ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Pilot gate. On the mainnet pilot Worker (PILOT_MODE=1) only owner-approved wallets, each with
 * a per-wallet tx budget, may DEPOSIT pilot money — the value-IN routes (/send-link, /v2-deposit).
 * The recipient side is deliberately OPEN: claiming and cashing out that money (create-account,
 * feebump, v2-claim, payout, reclaim, sweep) need NO approval, because a friend receiving the
 * money is not a pilot user, and no NEW money can enter the pilot except through an approved
 * wallet's deposit. A no-op everywhere off the pilot Worker. Fail-closed: a store outage rejects
 * rather than admits.
 *
 * Run a value handler under that gate, giving the wallet's slot BACK when the transaction
 * does not happen.
 *
 * `enforcePilot` reserves a slot with an INCR and hands back a `release()` for the failure case.
 * Dropping that release turned the budget into a weapon: `senderPublicKey` is an unauthenticated
 * body field, so five junk requests naming an approved wallet permanently consumed that wallet's
 * entire pilot allowance — and a genuine send that failed on a bad sequence or a Horizon blip cost
 * the user a slot too. Only a transaction that actually went through should spend one.
 */
async function withPilotSlot<T>(pubkey: string, run: () => Promise<T>): Promise<T | { error: string }> {
  if (!pilotEnabled()) return run();
  const p = await enforcePilot(pubkey);
  if (!p.ok) return { error: p.reason ?? "not admitted to the pilot" };
  try {
    return await run();
  } catch (e) {
    await p.release?.();
    throw e;
  }
}

/**
 * Every endpoint where the sponsor SPENDS (fees, reserves, faucet funds). All of them 503
 * behind the kill-switch; read-only + recovery + feedback endpoints stay up during an incident.
 */
const VALUE_ROUTES = new Set([
  "/create-account",
  "/feebump",
  "/send-link",
  "/payout",
  "/sweep",
  "/v2-claim",
  "/v2-deposit",
  "/v2-reclaim",
  "/faucet",
  "/demo-link",
]);

/**
 * Routes that don't move money themselves but hand out the RIGHT to move it. The halt switch is
 * flipped when something is wrong with the sponsor key — admitting new wallets to the mainnet
 * allowlist during exactly that window is the last thing an operator wants, and these being GET
 * requests is not a reason to leave them running.
 */
const GRANT_ROUTES = new Set(["/pilot-approve", "/pilot-reject"]);

/** Anything larger than this is not one of our requests; reject before parsing (F8). */
const MAX_BODY_BYTES = 16 * 1024;

export default {
  async fetch(
    request: Request,
    env: Env,
    /** Optional so the offline route suite can drive this handler with just (request, env). */
    ctx?: { waitUntil(p: Promise<unknown>): void },
  ): Promise<Response> {
    hydrateEnv(env);

    const method = request.method;
    const url = new URL(request.url).pathname;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    try {
      // KMS-aware bootstrap: with KMS_KEY_ID set the sponsor signs via AWS KMS (no hot key).
      const { config, signer, faucet, server, channels } = await getServiceAsync();

      // Kill-switch: one flip halts every value-moving route AND the two routes that grant the
      // right to move value (see lib/kill-switch.ts). Method-agnostic on purpose — the grant
      // routes are GETs, and "it's a GET" has never been a security boundary.
      if ((VALUE_ROUTES.has(url) || GRANT_ROUTES.has(url)) && (await isHalted())) {
        return GRANT_ROUTES.has(url)
          ? html(503, "<h2>Paused</h2><p>Approvals are paused right now. Try again later.</p>")
          : json(503, { error: "sponsor temporarily halted" });
      }

      // Body cap before any parse: workerd will happily buffer a very large body, and every
      // route's own validation runs only after JSON.parse has already paid for it. This is the
      // free half — a sender that declares its size. `readCapped` enforces the same ceiling on
      // what is actually read, which is the half that a chunked or header-less body reaches.
      if (method === "POST") {
        const len = Number(request.headers.get("content-length") ?? "0");
        if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
          return json(413, { error: "request body too large" });
        }
      }

      if (method === "GET" && url === "/health") {
        return json(200, {
          ok: true,
          service: "lumenia-sponsor",
          network: config.network,
          sponsorPublicKey: signer.publicKey(),
          usdcCode: config.usdc.getCode(),
          usdcIssuer: config.usdc.getIssuer(),
        });
      }

      if (method === "POST" && url === "/create-account") {
        const body = (await readJson(request)) as { recipientPublicKey?: string };
        if (!body.recipientPublicKey) return json(400, { error: "recipientPublicKey is required" });
        const rl = await enforceRateLimit(clientIp(request), body.recipientPublicKey);
        if (rl.limited) return json(429, { error: rl.reason });
        /* The per-account limiter above cannot fire here: `recipientPublicKey` is a key the caller
           mints fresh for every request, so the per-IP window is the whole of what is left — and
           each account it admits locks ~1 XLM of sponsor reserve that nothing ever returns. Two
           budgets are the ceiling on that (lib/caps.ts): the day's total, and this caller's share
           of it, so exhausting one connection cannot refuse everybody else's claim for the rest of
           the day. The caller is keyed from the same address the rate limiter just used. The route
           itself stays open by design. */
        const budget = await checkOnboardingBudget(onboardingBudgetFromEnv(), clientIp(request));
        if (!budget.ok) throw new PublicRefusal(budget.reason!);
        try {
          return json(200, await createAccountHandler(server, config, signer, { recipientPublicKey: body.recipientPublicKey }, channels));
        } catch (e) {
          // The handler threw, so no sandwich was handed out — the only outcome this service can
          // see. A sandwich that IS handed out and then abandoned keeps its slot (lib/caps.ts).
          await budget.release?.();
          throw e;
        }
      }

      if (method === "POST" && url === "/feebump") {
        const body = (await readJson(request)) as { xdr?: string; recipientPublicKey?: string; balanceId?: string };
        if (!body.xdr || !body.recipientPublicKey || !body.balanceId) {
          return json(400, { error: "xdr, recipientPublicKey and balanceId are required" });
        }
        const rl = await enforceRateLimit(clientIp(request), body.recipientPublicKey);
        if (rl.limited) return json(429, { error: rl.reason });
        return json(200, await feebumpHandler(server, config, signer, {
          xdr: body.xdr,
          recipientPublicKey: body.recipientPublicKey,
          balanceId: body.balanceId,
        }));
      }

      if (method === "POST" && url === "/send-link") {
        const body = (await readJson(request)) as { xdr?: string; senderPublicKey?: string };
        if (!body.xdr || !body.senderPublicKey) return json(400, { error: "xdr and senderPublicKey are required" });
        const rl = await enforceRateLimit(clientIp(request), body.senderPublicKey);
        if (rl.limited) return json(429, { error: rl.reason });
        const out = await withPilotSlot(body.senderPublicKey, () =>
          sendLinkHandler(server, config, signer, { xdr: body.xdr!, senderPublicKey: body.senderPublicKey! }),
        );
        if (out && typeof out === "object" && "error" in out) return json(403, out);
        return json(200, out);
      }

      if (method === "POST" && url === "/payout") {
        const body = (await readJson(request)) as {
          xdr?: string; senderPublicKey?: string; destination?: string; amount?: string;
        };
        if (!body.xdr || !body.senderPublicKey || !body.destination || !body.amount) {
          return json(400, { error: "xdr, senderPublicKey, destination and amount are required" });
        }
        const rl = await enforceRateLimit(clientIp(request), body.senderPublicKey);
        if (rl.limited) return json(429, { error: rl.reason });
        return json(200, await payoutHandler(server, config, signer, {
          xdr: body.xdr,
          senderPublicKey: body.senderPublicKey,
          destination: body.destination,
          amount: body.amount,
        }));
      }

      if (method === "POST" && url === "/sweep") {
        const body = (await readJson(request)) as {
          xdr?: string; throwawayPublicKey?: string; homePublicKey?: string; balanceId?: string; amount?: string;
        };
        if (!body.xdr || !body.throwawayPublicKey || !body.homePublicKey || !body.amount) {
          return json(400, { error: "xdr, throwawayPublicKey, homePublicKey and amount are required (balanceId optional)" });
        }
        const rl = await enforceRateLimit(clientIp(request), body.throwawayPublicKey);
        if (rl.limited) return json(429, { error: rl.reason });
        return json(200, await sweepHandler(server, config, signer, {
          xdr: body.xdr,
          throwawayPublicKey: body.throwawayPublicKey,
          homePublicKey: body.homePublicKey,
          balanceId: body.balanceId,
          amount: body.amount,
        }));
      }

      if (method === "POST" && url === "/v2-claim") {
        const body = (await readJson(request)) as { method?: string; linkHex?: string; payout?: string; sigHex?: string; contract?: string };
        if (!body.method || !body.linkHex || !body.payout || !body.sigHex) {
          return json(400, { error: "method, linkHex, payout and sigHex are required" });
        }
        const rl = await enforceRateLimit(clientIp(request), body.payout);
        if (rl.limited) return json(429, { error: rl.reason });
        return json(200, await relayClaimHandler(config, signer, {
          method: body.method, linkHex: body.linkHex, payout: body.payout, sigHex: body.sigHex,
          contract: body.contract, // optional: a superseded escrow, for links minted pre-upgrade
        }, channels));
      }

      if (method === "POST" && url === "/v2-deposit") {
        const body = (await readJson(request)) as { xdr?: string; senderPublicKey?: string };
        if (!body.xdr || !body.senderPublicKey) return json(400, { error: "xdr and senderPublicKey are required" });
        const rl = await enforceRateLimit(clientIp(request), body.senderPublicKey);
        if (rl.limited) return json(429, { error: rl.reason });
        const out = await withPilotSlot(body.senderPublicKey, () =>
          relayDepositHandler(config, signer, { xdr: body.xdr!, senderPublicKey: body.senderPublicKey! }),
        );
        if (out && typeof out === "object" && "error" in out) return json(403, out);
        /* 202, not 200, when the transaction is on the network but we could not observe it land.
         * 200 asserts the deposit happened, and the client turned anything else into "your money
         * hasn't moved. Try again." — the one sentence that must never be guessed, because a retry
         * mints a second drop under a fresh link key. 202 says exactly what is true: accepted,
         * outcome unknown, here is the hash. The client settles it against the escrow.
         *
         * The pilot slot is NOT released here: an unconfirmed deposit may still land, and handing
         * the budget back would let the same wallet spend it twice. */
        const unconfirmed = out && typeof out === "object" && "confirmed" in out && out.confirmed === false;
        return json(unconfirmed ? 202 : 200, out);
      }

      if (method === "POST" && url === "/v2-reclaim") {
        const body = (await readJson(request)) as { xdr?: string; senderPublicKey?: string };
        if (!body.xdr || !body.senderPublicKey) return json(400, { error: "xdr and senderPublicKey are required" });
        const rl = await enforceRateLimit(clientIp(request), body.senderPublicKey);
        if (rl.limited) return json(429, { error: rl.reason });
        return json(200, await relayReclaimHandler(config, signer, { xdr: body.xdr, senderPublicKey: body.senderPublicKey }));
      }

      if (method === "POST" && url === "/faucet") {
        // Testnet in CODE, not merely by leaving FAUCET_SECRET unset. The faucet hands out free
        // asset to anyone who asks; a mainnet deployment that inherited that secret would be
        // giving away real dollars, and one forgotten variable should not be what stands between.
        if (config.network !== "testnet") return json(403, { error: "the faucet is testnet-only" });
        if (!faucet) return json(503, { error: "faucet not configured" });
        const body = (await readJson(request)) as { recipientPublicKey?: string };
        if (!body.recipientPublicKey) return json(400, { error: "recipientPublicKey is required" });
        const rl = await enforceRateLimit(clientIp(request), body.recipientPublicKey);
        if (rl.limited) return json(429, { error: rl.reason });
        return json(200, await faucetHandler(server, config, faucet, { recipientPublicKey: body.recipientPublicKey }));
      }

      /**
       * The demo link, from stock where possible.
       *
       * Minting one creates a Claimable Balance, and a transaction is not real until a ledger
       * closes — ~5s on Stellar, measured 4.9–7.3s end to end. That was the whole of the wait
       * behind "Making your link…", and it is the network's heartbeat rather than our latency, so
       * it cannot be optimised away. It CAN be moved off the visitor's tap: hand out a link minted
       * earlier, then spend the ledger wait refilling the stock for the next person.
       *
       * An empty pool mints inline, exactly as before — a slow link beats an error.
       */
      if (method === "POST" && url === "/demo-link") {
        // Same refusal as /faucet, and it has to be HERE: lib/demo-pool.ts already refuses to
        // operate off testnet, but the inline-mint fallback below never asked, so an empty pool
        // was a path straight to a real Claimable Balance funded from a real faucet.
        if (config.network !== "testnet") return json(403, { error: "the demo link is testnet-only" });
        if (!faucet) return json(503, { error: "demo not configured" });
        const rl = await enforceRateLimit(clientIp(request));
        if (rl.limited) return json(429, { error: rl.reason });
        const mint = () => demoLinkHandler(server, config, faucet);
        const ready = await takeDemoLink(config.network);
        const link = ready ?? (await mint());
        // Refilling AFTER the response is the entire point; without waitUntil the isolate can be
        // torn down mid-mint and the stock never recovers.
        const refill = refillDemoPool(config.network, mint).catch(() => 0);
        if (ctx?.waitUntil) ctx.waitUntil(refill);
        return json(200, { ...link, ...(ready ? { fromPool: true } : {}) });
      }

      if (method === "POST" && url === "/waitlist") {
        const rl = await enforceRateLimit(clientIp(request));
        if (rl.limited) return json(429, { error: rl.reason });
        const body = (await readJson(request)) as { list?: string; email?: string };
        if (!body.list || !body.email) return json(400, { error: "list and email are required" });
        const saved = await saveContact(body.list, body.email);
        // Asking for real money is a request TO somebody. The other two lists are notify-me
        // captures with nobody waiting on them, but this one had a person on the other end who
        // was never told — the ask reached a database and stopped there. Only for a NEW address,
        // so a second attempt is not a second email, and after the response, so the mail never
        // slows the person down.
        if (body.list === "pilot" && saved.added) {
          const notify = notifyPilotInterest(body.email, new URL(request.url).origin).catch(() => undefined);
          if (ctx?.waitUntil) ctx.waitUntil(notify);
          else await notify;
        }
        return json(200, { ok: true });
      }

      // A wallet asking into the mainnet pilot. NOT a value route (moves no money) — it just
      // emails the owner, who approves with the pilot CLI. Rate-limited by pubkey to stop spam.
      // Client asks "is this account approved for mainnet?" — read-only, moves nothing. When the
      // pilot is off (every testnet deployment) it answers a plain "not a pilot", so the client
      // simply stays on testnet. The real gate is still the allowlist enforced on value routes.
      if (method === "GET" && url === "/pilot-status") {
        const pubkey = new URL(request.url).searchParams.get("pubkey");
        // Validated + metered: it reaches the store, and unmetered it is both an allowlist
        // enumeration oracle and a free amplifier turning one GET into a KV pipeline.
        if (!pubkey || !StrKey.isValidEd25519PublicKey(pubkey)) {
          return json(400, { error: "a valid pubkey is required" });
        }
        const rl = await enforceRateLimit(clientIp(request), pubkey);
        if (rl.limited) return json(429, { error: rl.reason });
        if (!pilotEnabled()) return json(200, { pilot: false, approved: false });
        try {
          return json(200, { pilot: true, ...(await pilotStatus(pubkey)) });
        } catch {
          return json(200, { pilot: true, approved: false });
        }
      }

      // One-tap approve from the owner's email. The link carries a per-wallet, expiring signature
      // (lib/pilot.ts) rather than the shared secret, so a leaked link approves one wallet for one
      // week instead of everything forever. Rate-limited because this is the route that grants the
      // right to move real money, and an unmetered guessing loop against it is the worst hole in
      // the service.
      if (method === "GET" && url === "/pilot-approve") {
        const u = new URL(request.url);
        const pubkey = u.searchParams.get("pubkey") ?? "";
        const token = u.searchParams.get("token") ?? "";
        const exp = u.searchParams.get("exp") ?? "";
        const rl = await enforceRateLimit(`pilot:${clientIp(request)}`);
        if (rl.limited) return html(429, "<h2>Too many attempts</h2><p>Wait a minute and try again.</p>");
        if (!process.env.PILOT_APPROVE_TOKEN) return html(503, "<h2>Approve-by-link isn’t set up</h2><p>Set <code>PILOT_APPROVE_TOKEN</code> on the worker.</p>");
        if (!StrKey.isValidEd25519PublicKey(pubkey)) return html(400, "<h2>Invalid wallet address</h2>");
        if (!(await verifyApprovalToken("approve", pubkey, token, exp, Date.now()))) {
          return html(403, "<h2>Not authorized</h2><p>This approval link is invalid or has expired.</p>");
        }
        try {
          // Idempotent: tapping the emailed Approve link twice must not re-send "you're in".
          const prev = await getPilotState(pubkey);
          await approvePilot(pubkey); // SET is idempotent — safe to re-run.
          if (prev === "approved") {
            return html(200, `<h2>✓ Already approved</h2><p><code>${pubkey.slice(0, 8)}…${pubkey.slice(-6)}</code> is already in the mainnet pilot — no second email sent.</p>`);
          }
          const email = await getPilotEmail(pubkey);
          if (email) await notifyPilotApproved(pubkey, email).catch(() => {});
          return html(200, `<h2>✓ Approved</h2><p><code>${pubkey.slice(0, 8)}…${pubkey.slice(-6)}</code> is now in the mainnet pilot.</p><p>${email ? `We emailed <b>${email}</b>.` : "No stored email — they’ll see it on their account."}</p>`);
        } catch (e) {
          return html(500, `<h2>Couldn’t approve</h2><p>${(e as Error).message}</p>`);
        }
      }

      // One-tap DECLINE from the owner's email — same token guard as approve. Marks the wallet
      // rejected and sends the gentle "not yet" mail (TASK 2).
      if (method === "GET" && url === "/pilot-reject") {
        const u = new URL(request.url);
        const pubkey = u.searchParams.get("pubkey") ?? "";
        const token = u.searchParams.get("token") ?? "";
        const exp = u.searchParams.get("exp") ?? "";
        const rl = await enforceRateLimit(`pilot:${clientIp(request)}`);
        if (rl.limited) return html(429, "<h2>Too many attempts</h2><p>Wait a minute and try again.</p>");
        if (!process.env.PILOT_APPROVE_TOKEN) return html(503, "<h2>Decline-by-link isn’t set up</h2><p>Set <code>PILOT_APPROVE_TOKEN</code> on the worker.</p>");
        if (!StrKey.isValidEd25519PublicKey(pubkey)) return html(400, "<h2>Invalid wallet address</h2>");
        if (!(await verifyApprovalToken("reject", pubkey, token, exp, Date.now()))) {
          return html(403, "<h2>Not authorized</h2><p>This link is invalid or has expired.</p>");
        }
        try {
          await rejectPilot(pubkey);
          const email = await getPilotEmail(pubkey);
          if (email) await notifyPilotRejected(pubkey, email).catch(() => {});
          return html(200, `<h2>Declined</h2><p><code>${pubkey.slice(0, 8)}…${pubkey.slice(-6)}</code> was declined${email ? `, and we emailed <b>${email}</b> gently` : ""}.</p>`);
        } catch (e) {
          return html(500, `<h2>Couldn’t decline</h2><p>${(e as Error).message}</p>`);
        }
      }

      if (method === "POST" && url === "/pilot-request") {
        const body = (await readJson(request)) as { pubkey?: string; email?: string };
        if (!body.pubkey || !body.email) return json(400, { error: "pubkey and email are required" });
        const rl = await enforceRateLimit(clientIp(request), body.pubkey);
        if (rl.limited) return json(429, { error: rl.reason });
        try {
          return json(200, await notifyPilotRequest(body.pubkey, body.email, new URL(request.url).origin));
        } catch (e) {
          return json(400, { error: (e as Error).message });
        }
      }

      if (method === "POST" && url === "/feedback") {
        // Its OWN limiter bucket ("fb:") — see index.ts.
        const rl = await enforceRateLimit(`fb:${clientIp(request)}`);
        if (rl.limited) return json(429, { error: rl.reason });
        await saveFeedback((await readJson(request)) as { category?: string; message?: string; contact?: string });
        return json(200, { ok: true });
      }

      if (method === "POST" && url === "/events") {
        const rl = await enforceRateLimit(clientIp(request));
        if (rl.limited) return json(429, { error: rl.reason });
        try {
          const input = (await readJson(request)) as { event?: string; cid?: string; aid?: string };
          handleEvent(input);
          // Counted AFTER the response, so the store's latency is never on a claim's path. An
          // event that fails to be written is a missing number, not a failed claim.
          const counted = recordEvent(input);
          if (ctx?.waitUntil) ctx.waitUntil(counted);
        } catch {
          /* ignore — the beacon is fire-and-forget */
        }
        return json(200, { ok: true });
      }

      /* The tallies, aggregate-only. There is nothing per-person to return here by construction:
         the store holds counters and two sets of hashed account ids, never an event log. Left
         readable without a token for the same reason /health is — it discloses no more than a
         funding report already publishes, and gating it behind a secret would mean the numbers get
         copied by hand into documents instead of read from the thing that produced them. */
      if (method === "GET" && url === "/events/summary") {
        // Metered like every other read route: one anonymous GET costs a pipeline that SMEMBERS
        // and SINTERs the funnel sets, and those grow with the funnel rather than staying still.
        const rl = await enforceRateLimit(clientIp(request));
        if (rl.limited) return json(429, { error: rl.reason });
        const summary = await eventsSummary();
        if (!summary) return json(503, { error: "no event store configured" });
        return json(200, summary);
      }

      if (method === "POST" && url === "/recovery-otp") {
        const rl = await enforceRateLimit(`rec:${clientIp(request)}`);
        if (rl.limited) return json(429, { error: rl.reason });
        await requestOtp(((await readJson(request)) as { email?: unknown }).email);
        return json(200, { ok: true });
      }

      if (method === "POST" && url === "/recovery") {
        const rl = await enforceRateLimit(`rec:${clientIp(request)}`);
        if (rl.limited) return json(429, { error: rl.reason });
        const body = (await readJson(request)) as {
          id?: unknown; box?: unknown; code?: unknown; owner?: unknown; aliasId?: unknown; aliasProof?: unknown;
        };
        if (!(await verifyOtp(body.id, body.code))) return json(401, { error: "invalid or expired code" });
        // The code proves control of an INBOX. `owner` is the account's own signature over this
        // box's id, and it is what binds the row so a later write from a stolen inbox is refused
        // (see putBox) — a row only ever carries one if the write that made it carried one.
        await putBox(
          body.id,
          body.box,
          body.owner && typeof body.owner === "object" ? (body.owner as OwnerProof) : undefined,
        );
        // Optional PRF alias, written behind the SAME verified code. Refusing aliasId === id is not
        // defensive noise: it would drop an email-derived (low-entropy) id into the namespace whose
        // fetch route has no OTP, which is exactly the bypass the two namespaces exist to prevent.
        // The code proves control of `id` only, so the alias write carries its own passkey-derived
        // proof of ownership (see putAliasBox).
        if (body.aliasId !== undefined) {
          if (body.aliasId === body.id) return json(400, { error: "aliasId must differ from id" });
          await putAliasBox(body.aliasId, body.box, body.aliasProof);
        }
        return json(200, { ok: true });
      }

      /**
       * Find-my-account: fetch a box by its PRF-derived alias id. NEVER OTP-gated, and reads ONLY
       * the alias namespace. The id is 256 bits that only a user-verified passkey ceremony on this
       * origin can produce, so possessing it already proves what a mailed code would prove; the box
       * is ciphertext-only and useless without the same passkey. Its own limiter bucket so a
       * restore storm can never eat the email-OTP budget.
       */
      if (method === "POST" && url === "/recovery-alias-fetch") {
        const body = (await readJson(request)) as { id?: unknown };
        const rl = await enforceRateLimit(`recpk:${clientIp(request)}`, typeof body.id === "string" ? body.id : undefined);
        if (rl.limited) return json(429, { error: rl.reason });
        const box = await getAliasBox(body.id);
        if (!box) return json(404, { error: "not found" });
        return json(200, { box });
      }

      if (method === "POST" && url === "/recovery-fetch") {
        const rl = await enforceRateLimit(`rec:${clientIp(request)}`);
        if (rl.limited) return json(429, { error: rl.reason });
        const body = (await readJson(request)) as { id?: unknown; code?: unknown };
        if (!(await verifyOtp(body.id, body.code))) return json(401, { error: "invalid or expired code" });
        const box = await getBox(body.id);
        if (!box) return json(404, { error: "not found" });
        return json(200, { box });
      }

      /* ------------------------------------------------------------------------------
       * NAMES (@handle) + SEP-0002 federation — docs/IDENTITY_AND_ACCOUNTS.md §3.
       *
       * Every write is an Ed25519 signature from the account itself; this service issues no
       * session and holds no secret of the user's, so it can refuse a name but never move one.
       * The NETWORK is taken from this Worker's own config, never from the request — a proof
       * signed for testnet must not be replayable against the mainnet registry.
       * ---------------------------------------------------------------------------- */

      if (method === "GET" && url === "/handle") {
        const name = new URL(request.url).searchParams.get("name");
        const found = await lookupHandle(name);
        if (!found) {
          // Not resolving is not the same as free: a name can be cooling down after a release, or
          // be a lookalike of one that exists. handleAvailability knows about both.
          const availability = await handleAvailability(name);
          return json(404, {
            available: availability.available,
            ...(availability.reason ? { error: availability.reason } : {}),
          });
        }
        return json(200, { name: found.name, address: found.pubkey, network: found.network });
      }

      if (method === "GET" && url === "/handle-of") {
        const pubkey = new URL(request.url).searchParams.get("pubkey");
        const name = await handleOf(pubkey);
        return name ? json(200, { name }) : json(404, { error: "not found" });
      }

      if (method === "POST" && url === "/handle-claim") {
        const b = (await readJson(request)) as { name?: unknown; pubkey?: unknown; ts?: unknown; nonce?: unknown; proof?: unknown };
        const rl = await enforceRateLimit(`handle:${clientIp(request)}`, typeof b.pubkey === "string" ? b.pubkey : undefined);
        if (rl.limited) return json(429, { error: rl.reason });
        const result = await claimHandle({
          action: "claim",
          name: String(b.name ?? ""),
          pubkey: String(b.pubkey ?? ""),
          ts: Number(b.ts),
          nonce: String(b.nonce ?? ""),
          network: config.network,
          proof: String(b.proof ?? ""),
        });
        return result.ok ? json(200, result) : json(409, { error: result.reason });
      }

      if (method === "POST" && url === "/handle-release") {
        const b = (await readJson(request)) as { name?: unknown; pubkey?: unknown; ts?: unknown; nonce?: unknown; proof?: unknown };
        const rl = await enforceRateLimit(`handle:${clientIp(request)}`, typeof b.pubkey === "string" ? b.pubkey : undefined);
        if (rl.limited) return json(429, { error: rl.reason });
        const result = await releaseHandle({
          action: "release",
          name: String(b.name ?? ""),
          pubkey: String(b.pubkey ?? ""),
          ts: Number(b.ts),
          nonce: String(b.nonce ?? ""),
          network: config.network,
          proof: String(b.proof ?? ""),
        });
        return result.ok ? json(200, result) : json(409, { error: result.reason });
      }

      /** SEP-0002. Answers `name` and `id`; says so plainly for the two types it does not serve. */
      if (method === "GET" && url === "/federation") {
        const params = new URL(request.url).searchParams;
        const answer = await federationLookup(
          params.get("q") ?? "",
          params.get("type") ?? "",
          config.network,
        );
        return "ok" in answer ? json(404, { detail: answer.reason }) : json(200, answer);
      }

      /* ------------------------------------------------------------------------------
       * WAYS BACK IN — docs/IDENTITY_AND_ACCOUNTS.md §5.
       *
       * These endpoints connect an identity somebody controls (a passkey, an email address, a
       * Google/GitHub/X account) to an account, and file the account's ALREADY-ENCRYPTED box
       * under it. None of them can decrypt anything, none of them issues a session, and none of
       * them is a sign-in: what opens the money is still the password or the passkey.
       * ---------------------------------------------------------------------------- */

      /** Which connections this deployment can actually offer (an unregistered app is not offered). */
      if (method === "GET" && url === "/identity-providers") {
        return json(200, { providers: ["passkey", "email", ...availableOAuthProviders()] });
      }

      /** Begin an OAuth round trip. Returns the URL to send the browser to; state lives server-side. */
      if (method === "POST" && url === "/identity-start") {
        const b = (await readJson(request)) as { provider?: unknown; address?: unknown };
        const provider = String(b.provider ?? "");
        if (!OAUTH_PROVIDERS.includes(provider as OAuthProvider)) {
          return json(400, { error: "unknown provider" });
        }
        const rl = await enforceRateLimit(`idlink:${clientIp(request)}`);
        if (rl.limited) return json(429, { error: rl.reason });
        const started = await startOAuth(
          provider as OAuthProvider,
          typeof b.address === "string" ? b.address : undefined,
          config.network,
        );
        return started.ok ? json(200, { authUrl: started.authUrl }) : json(400, { error: started.reason });
      }

      /**
       * The provider redirects the browser here. The code is exchanged server-side (the client
       * secret never reaches a browser), and what goes back to the app is a one-time ticket —
       * never a provider token, which is used once here and dropped.
       */
      if (method === "GET" && url.startsWith("/oauth/") && url.endsWith("/callback")) {
        const provider = url.slice("/oauth/".length, -"/callback".length);
        const params = new URL(request.url).searchParams;
        const done = await finishOAuth(provider, params.get("code"), params.get("state"));
        if (!done.ok) {
          return html(400, `<h2>That didn't connect</h2><p>${done.reason}</p><p><a href="/">Back</a></p>`);
        }
        return new Response(null, { status: 302, headers: { location: done.redirectTo, ...corsHeaders() } });
      }

      /**
       * The four operations over a proved identity. `readProof` turns the request into an identity
       * or into nothing — and everything below refuses on nothing, so no route can be reached
       * without control of the identity it names.
       */
      if (
        method === "POST" &&
        (url === "/identity-check" || url === "/identity-attach" || url === "/identity-fetch" || url === "/identity-detach")
      ) {
        const rl = await enforceRateLimit(`idlink:${clientIp(request)}`);
        if (rl.limited) return json(429, { error: rl.reason });
        const b = (await readJson(request)) as Record<string, unknown>;
        const proof = b.proof as IdentityProof | undefined;
        if (!proof || typeof proof !== "object" || typeof (proof as { kind?: unknown }).kind !== "string") {
          return json(400, { error: "proof is required" });
        }
        const resolved = await resolveProof(proof, {
          verifyEmailOtp: async (email, code) => verifyOtp(await idForEmail(email), code),
        });
        if (!resolved) return json(401, { error: "we could not confirm that is yours" });

        if (url === "/identity-check") {
          return json(200, await checkIdentity(resolved, config.network));
        }
        if (url === "/identity-fetch") {
          const found = await fetchByIdentity(resolved);
          return found ? json(200, found) : json(404, { error: "not found" });
        }
        if (url === "/identity-detach") {
          const done = await detachIdentity(resolved);
          return done.ok ? json(200, done) : json(404, { error: done.reason });
        }
        // Two different proofs, so two different keys: `proof` above is the identity's, and
        // `accountProof` is the account agreeing to be what that identity opens. attachIdentity
        // refuses without the second, so a route that never forwarded it could never attach.
        const attached = await attachIdentity(
          resolved,
          String(b.address ?? ""),
          config.network,
          b.box,
          typeof b.passkeyProof === "string" ? b.passkeyProof : undefined,
          b.accountProof && typeof b.accountProof === "object" ? (b.accountProof as AccountProof) : undefined,
        );
        return attached.ok ? json(200, attached) : json(409, { error: attached.reason, conflict: attached.conflict });
      }

      /**
       * Disconnect a provider from an account, authorized by the ACCOUNT's own signature. The
       * identity-proof route above still exists for the other direction ("take my passkey off
       * whatever it opens"); this one is what a settings screen needs, because re-proving a Google
       * account just to remove it — or a passkey you have lost — is either friction or impossible.
       */
      if (method === "POST" && url === "/identity-detach-mine") {
        const b = (await readJson(request)) as {
          pubkey?: unknown;
          ts?: unknown;
          nonce?: unknown;
          proof?: unknown;
          provider?: unknown;
        };
        const pubkey = String(b.pubkey ?? "");
        const provider = String(b.provider ?? "");
        const rl = await enforceRateLimit(`idlink:${clientIp(request)}`, pubkey);
        if (rl.limited) return json(429, { error: rl.reason });
        if (!PROVIDERS.includes(provider as Provider)) return json(400, { error: "unknown provider" });
        const okProof = await verifyHandleProof({
          action: "links",
          name: "",
          pubkey,
          ts: Number(b.ts),
          nonce: String(b.nonce ?? ""),
          network: config.network,
          proof: String(b.proof ?? ""),
        });
        if (okProof.ok !== true) return json(401, { error: okProof.reason });
        return json(200, await detachProviderByAccount(pubkey, config.network, provider as Provider));
      }

      /**
       * Which connections does THIS account have? Signed by the account, because a list of
       * somebody's ways back in is not public information about an address.
       */
      if (method === "POST" && url === "/identity-links") {
        const b = (await readJson(request)) as { pubkey?: unknown; ts?: unknown; nonce?: unknown; proof?: unknown };
        const pubkey = String(b.pubkey ?? "");
        const rl = await enforceRateLimit(`idlink:${clientIp(request)}`, pubkey);
        if (rl.limited) return json(429, { error: rl.reason });
        const okProof = await verifyHandleProof({
          action: "links",
          name: "",
          pubkey,
          ts: Number(b.ts),
          nonce: String(b.nonce ?? ""),
          network: config.network,
          proof: String(b.proof ?? ""),
        });
        if (okProof.ok !== true) return json(401, { error: okProof.reason });
        return json(200, { links: await listLinks(pubkey, config.network) });
      }

      return json(404, { error: "not found" });
    } catch (e) {
      if (e instanceof BodyTooLarge) return json(413, { error: "request body too large" });
      // The reason text is genuinely useful while building against testnet — anti-drain says
      // exactly which rule rejected a transaction. On mainnet the same channel hands an attacker a
      // precise oracle (config state, Horizon internals, the sponsor's own address, which policy
      // clause tripped), so there it becomes a reference the operator can look up in the log.
      const message = (e as Error).message;
      // A refusal the caller is entitled to understand — a cap or a floor — keeps its text on
      // every network. Only the reasons that would help someone map the validator get hidden.
      if (isPublicRefusal(e)) return json(400, { error: message });
      if (process.env.STELLAR_NETWORK === "mainnet") {
        const ref = crypto.randomUUID().slice(0, 8);
        console.error(`[error ${ref}] ${new URL(request.url).pathname}: ${message}`);
        return json(400, { error: "request failed", ref });
      }
      return json(400, { error: message });
    }
  },

  /**
   * Cron Trigger — the watchdog (lib/watchdog.ts): sponsor float, sponsor sourcing value, and
   * escrow governance calls. Alerts land in `wrangler tail` and, with RESEND_API_KEY +
   * ALERT_NOTIFY_TO, by email. Schedule lives in wrangler.toml.
   */
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    hydrateEnv(env);
    const { config, signer } = await getServiceAsync();
    ctx.waitUntil(
      runWatchdog(config, signer.publicKey()).then((r) => {
        console.log(`[watchdog] checked ${r.checked.join(", ")} — ${r.alerts.length} alert(s)`);
      }),
    );
  },
};
