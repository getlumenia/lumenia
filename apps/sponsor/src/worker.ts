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
import { saveContact } from "./lib/waitlist.js";
import { saveFeedback } from "./lib/feedback.js";
import { handleEvent } from "./lib/events.js";
import { putBox, getBox, putAliasBox, getAliasBox } from "./lib/recovery-store.js";
import { requestOtp, verifyOtp } from "./lib/recovery-otp.js";
import { pilotEnabled, enforcePilot, pilotStatus, approvePilot, getPilotEmail } from "./lib/pilot.js";
import { notifyPilotRequest, notifyPilotApproved } from "./lib/pilot-request.js";
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

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await request.json();
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
 * wallet's deposit. A no-op everywhere off the pilot Worker. Returns a 403 body, or null to
 * proceed. Fail-closed: a store outage rejects rather than admits.
 */
async function pilotGate(pubkey: string): Promise<{ error: string } | null> {
  if (!pilotEnabled()) return null;
  const p = await enforcePilot(pubkey);
  return p.ok ? null : { error: p.reason ?? "not admitted to the pilot" };
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    hydrateEnv(env);

    const method = request.method;
    const url = new URL(request.url).pathname;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    try {
      // KMS-aware bootstrap: with KMS_KEY_ID set the sponsor signs via AWS KMS (no hot key).
      const { config, signer, faucet, server, channels } = await getServiceAsync();

      // Kill-switch: one flip halts every value-moving route (see lib/kill-switch.ts).
      if (method === "POST" && VALUE_ROUTES.has(url) && (await isHalted())) {
        return json(503, { error: "sponsor temporarily halted" });
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
        return json(200, await createAccountHandler(server, config, signer, { recipientPublicKey: body.recipientPublicKey }, channels));
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
        const pg = await pilotGate(body.senderPublicKey);
        if (pg) return json(403, pg);
        return json(200, await sendLinkHandler(server, config, signer, { xdr: body.xdr, senderPublicKey: body.senderPublicKey }));
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
        const pg = await pilotGate(body.senderPublicKey);
        if (pg) return json(403, pg);
        return json(200, await relayDepositHandler(config, signer, { xdr: body.xdr, senderPublicKey: body.senderPublicKey }));
      }

      if (method === "POST" && url === "/v2-reclaim") {
        const body = (await readJson(request)) as { xdr?: string; senderPublicKey?: string };
        if (!body.xdr || !body.senderPublicKey) return json(400, { error: "xdr and senderPublicKey are required" });
        const rl = await enforceRateLimit(clientIp(request), body.senderPublicKey);
        if (rl.limited) return json(429, { error: rl.reason });
        return json(200, await relayReclaimHandler(config, signer, { xdr: body.xdr, senderPublicKey: body.senderPublicKey }));
      }

      if (method === "POST" && url === "/faucet") {
        if (!faucet) return json(503, { error: "faucet not configured" });
        const body = (await readJson(request)) as { recipientPublicKey?: string };
        if (!body.recipientPublicKey) return json(400, { error: "recipientPublicKey is required" });
        const rl = await enforceRateLimit(clientIp(request), body.recipientPublicKey);
        if (rl.limited) return json(429, { error: rl.reason });
        return json(200, await faucetHandler(server, config, faucet, { recipientPublicKey: body.recipientPublicKey }));
      }

      if (method === "POST" && url === "/demo-link") {
        if (!faucet) return json(503, { error: "demo not configured" });
        const rl = await enforceRateLimit(clientIp(request));
        if (rl.limited) return json(429, { error: rl.reason });
        return json(200, await demoLinkHandler(server, config, faucet));
      }

      if (method === "POST" && url === "/waitlist") {
        const rl = await enforceRateLimit(clientIp(request));
        if (rl.limited) return json(429, { error: rl.reason });
        const body = (await readJson(request)) as { list?: string; email?: string };
        if (!body.list || !body.email) return json(400, { error: "list and email are required" });
        await saveContact(body.list, body.email);
        return json(200, { ok: true });
      }

      // A wallet asking into the mainnet pilot. NOT a value route (moves no money) — it just
      // emails the owner, who approves with the pilot CLI. Rate-limited by pubkey to stop spam.
      // Client asks "is this account approved for mainnet?" — read-only, moves nothing. When the
      // pilot is off (every testnet deployment) it answers a plain "not a pilot", so the client
      // simply stays on testnet. The real gate is still the allowlist enforced on value routes.
      if (method === "GET" && url === "/pilot-status") {
        const pubkey = new URL(request.url).searchParams.get("pubkey");
        if (!pubkey) return json(400, { error: "pubkey is required" });
        if (!pilotEnabled()) return json(200, { pilot: false, approved: false });
        try {
          return json(200, { pilot: true, ...(await pilotStatus(pubkey)) });
        } catch {
          return json(200, { pilot: true, approved: false });
        }
      }

      // One-tap approve from the owner's email. Guarded by a shared secret in the link
      // (PILOT_APPROVE_TOKEN) so ONLY the owner's mail can trigger it: it adds the wallet to the
      // allowlist and sends the "you're in" mail — no terminal needed.
      if (method === "GET" && url === "/pilot-approve") {
        const u = new URL(request.url);
        const pubkey = u.searchParams.get("pubkey") ?? "";
        const token = u.searchParams.get("token") ?? "";
        const expected = process.env.PILOT_APPROVE_TOKEN;
        if (!expected) return html(503, "<h2>Approve-by-link isn’t set up</h2><p>Set <code>PILOT_APPROVE_TOKEN</code> on the worker.</p>");
        if (token !== expected) return html(403, "<h2>Not authorized</h2><p>This approval link is invalid.</p>");
        if (!StrKey.isValidEd25519PublicKey(pubkey)) return html(400, "<h2>Invalid wallet address</h2>");
        try {
          await approvePilot(pubkey);
          const email = await getPilotEmail(pubkey);
          if (email) await notifyPilotApproved(pubkey, email).catch(() => {});
          return html(200, `<h2>✓ Approved</h2><p><code>${pubkey.slice(0, 8)}…${pubkey.slice(-6)}</code> is now in the mainnet pilot.</p><p>${email ? `We emailed <b>${email}</b>.` : "No stored email — they’ll see it on their account."}</p>`);
        } catch (e) {
          return html(500, `<h2>Couldn’t approve</h2><p>${(e as Error).message}</p>`);
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
          handleEvent((await readJson(request)) as { event?: string; cid?: string });
        } catch {
          /* ignore — the beacon is fire-and-forget */
        }
        return json(200, { ok: true });
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
        const body = (await readJson(request)) as { id?: unknown; box?: unknown; code?: unknown; aliasId?: unknown };
        if (!(await verifyOtp(body.id, body.code))) return json(401, { error: "invalid or expired code" });
        await putBox(body.id, body.box);
        // Optional PRF alias, written behind the SAME verified code. Refusing aliasId === id is not
        // defensive noise: it would drop an email-derived (low-entropy) id into the namespace whose
        // fetch route has no OTP, which is exactly the bypass the two namespaces exist to prevent.
        if (body.aliasId !== undefined) {
          if (body.aliasId === body.id) return json(400, { error: "aliasId must differ from id" });
          await putAliasBox(body.aliasId, body.box);
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

      return json(404, { error: "not found" });
    } catch (e) {
      return json(400, { error: (e as Error).message });
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
