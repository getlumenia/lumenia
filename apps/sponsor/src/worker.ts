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
import { getService, enforceRateLimit, corsHeaders } from "./lib/service.js";
import { createAccountHandler } from "./lib/create-account.js";
import { feebumpHandler } from "./lib/feebump.js";
import { sendLinkHandler } from "./lib/send.js";
import { sweepHandler } from "./lib/sweep.js";
import { relayClaimHandler, relayDepositHandler } from "./lib/soroban-relay.js";
import { faucetHandler } from "./lib/faucet.js";
import { demoLinkHandler } from "./lib/demo-link.js";
import { saveContact } from "./lib/waitlist.js";
import { saveFeedback } from "./lib/feedback.js";
import { handleEvent } from "./lib/events.js";
import { putBox, getBox } from "./lib/recovery-store.js";
import { requestOtp, verifyOtp } from "./lib/recovery-otp.js";

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    hydrateEnv(env);

    const method = request.method;
    const url = new URL(request.url).pathname;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    try {
      const { config, signer, faucet, server } = getService();

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
        return json(200, await createAccountHandler(server, config, signer, { recipientPublicKey: body.recipientPublicKey }));
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
        return json(200, await sendLinkHandler(server, config, signer, { xdr: body.xdr, senderPublicKey: body.senderPublicKey }));
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
        const body = (await readJson(request)) as { method?: string; linkHex?: string; payout?: string; sigHex?: string };
        if (!body.method || !body.linkHex || !body.payout || !body.sigHex) {
          return json(400, { error: "method, linkHex, payout and sigHex are required" });
        }
        const rl = await enforceRateLimit(clientIp(request), body.payout);
        if (rl.limited) return json(429, { error: rl.reason });
        return json(200, await relayClaimHandler(config, signer, {
          method: body.method, linkHex: body.linkHex, payout: body.payout, sigHex: body.sigHex,
        }));
      }

      if (method === "POST" && url === "/v2-deposit") {
        const body = (await readJson(request)) as { xdr?: string; senderPublicKey?: string };
        if (!body.xdr || !body.senderPublicKey) return json(400, { error: "xdr and senderPublicKey are required" });
        const rl = await enforceRateLimit(clientIp(request), body.senderPublicKey);
        if (rl.limited) return json(429, { error: rl.reason });
        return json(200, await relayDepositHandler(config, signer, { xdr: body.xdr, senderPublicKey: body.senderPublicKey }));
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
        const body = (await readJson(request)) as { id?: unknown; box?: unknown; code?: unknown };
        if (!(await verifyOtp(body.id, body.code))) return json(401, { error: "invalid or expired code" });
        await putBox(body.id, body.box);
        return json(200, { ok: true });
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
};
