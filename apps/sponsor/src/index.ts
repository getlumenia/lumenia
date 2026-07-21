/**
 * Sponsor HTTP service (Instawards SOW, D1).
 *
 * A standalone Node service holding the hot sponsor key — its own env/IAM
 * boundary, deliberately NOT a Next API route. Endpoints:
 *
 *   GET  /health          → liveness + public sponsor identity (no secrets)
 *   POST /create-account  → sponsored 0-XLM account + USDC trustline (sponsor-signed XDR)
 *   POST /feebump         → validate (anti-drain CLAIM policy) + fee-bump + submit the claim
 *   POST /send-link       → validate (anti-drain SEND policy) + sponsor-sign + fee-bump the onward CB
 *   POST /sweep           → validate (anti-drain SWEEP policy) + fee-bump: consolidate a per-link account into home
 *   POST /v2-claim        → relay a v2 (Soroban LumenDrop) claim: submit + pay the Soroban fee (walletless/gasless)
 *   POST /v2-deposit      → relay a v2 deposit: fee-bump the sender-signed deposit so a 0-XLM sender pays no gas
 *   POST /faucet          → dispense test-USDC (separate faucet key; recipient must already hold the trustline)
 *   POST /demo-link       → faucet mints a real demo Claimable Balance + returns the bearer secret
 *   POST /waitlist        → store a notify-me email (isolated, never joined to a pubkey)
 *   POST /feedback        → store a "report a problem" entry (isolated, never joined to a pubkey)
 *   POST /events          → allowlisted funnel beacon (no PII; always 200)
 *   POST /recovery-otp    → email a single-use code proving control of the box's email
 *   POST /recovery        → store a ciphertext-only recovery box (OTP-gated; isolated; signs nothing)
 *   POST /recovery-fetch  → fetch a ciphertext-only recovery box (OTP-gated)
 *
 * The request handlers live in lib/* and are platform-agnostic, so the same core
 * runs behind this node:http server (local dev + CLI) and behind a Vercel function
 * adapter (api/*) when deployed. Per-IP + per-account rate limiting and the fee cap
 * are enforced on both paths (lib/rate-limit.ts); durable cross-instance limiting is
 * already live (checkRateLimitDurable → Upstash/KV, degrades to in-memory on error).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getService, enforceRateLimit } from "./lib/service.js";
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

const { config, signer, faucet, server } = getService();
const allowedOrigin = process.env.ALLOWED_ORIGIN ?? "*";

/* ------------------------------- helpers ---------------------------------- */
function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(json);
}

async function readJson(req: IncomingMessage, limitBytes = 4096): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

/* -------------------------------- router ---------------------------------- */
const httpServer = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = (req.url ?? "/").split("?")[0];

  if (method === "OPTIONS") return send(res, 204, {});

  if (method === "GET" && url === "/health") {
    return send(res, 200, {
      ok: true,
      service: "lumenia-sponsor",
      network: config.network,
      sponsorPublicKey: signer.publicKey(),
      usdcCode: config.usdc.getCode(),
      usdcIssuer: config.usdc.getIssuer(),
    });
  }

  try {
    if (method === "POST" && url === "/create-account") {
      const body = (await readJson(req)) as { recipientPublicKey?: string };
      if (!body.recipientPublicKey) return send(res, 400, { error: "recipientPublicKey is required" });
      const rl = await enforceRateLimit(clientIp(req), body.recipientPublicKey);
      if (rl.limited) return send(res, 429, { error: rl.reason });
      const result = await createAccountHandler(server, config, signer, {
        recipientPublicKey: body.recipientPublicKey,
      });
      return send(res, 200, result);
    }

    if (method === "POST" && url === "/feebump") {
      const body = (await readJson(req)) as { xdr?: string; recipientPublicKey?: string; balanceId?: string };
      if (!body.xdr || !body.recipientPublicKey || !body.balanceId) {
        return send(res, 400, { error: "xdr, recipientPublicKey and balanceId are required" });
      }
      const rl = await enforceRateLimit(clientIp(req), body.recipientPublicKey);
      if (rl.limited) return send(res, 429, { error: rl.reason });
      const result = await feebumpHandler(server, config, signer, {
        xdr: body.xdr,
        recipientPublicKey: body.recipientPublicKey,
        balanceId: body.balanceId,
      });
      return send(res, 200, result);
    }

    if (method === "POST" && url === "/send-link") {
      const body = (await readJson(req)) as { xdr?: string; senderPublicKey?: string };
      if (!body.xdr || !body.senderPublicKey) {
        return send(res, 400, { error: "xdr and senderPublicKey are required" });
      }
      const rl = await enforceRateLimit(clientIp(req), body.senderPublicKey);
      if (rl.limited) return send(res, 429, { error: rl.reason });
      const result = await sendLinkHandler(server, config, signer, {
        xdr: body.xdr,
        senderPublicKey: body.senderPublicKey,
      });
      return send(res, 200, result);
    }

    if (method === "POST" && url === "/sweep") {
      const body = (await readJson(req)) as {
        xdr?: string;
        throwawayPublicKey?: string;
        homePublicKey?: string;
        balanceId?: string;
        amount?: string;
      };
      if (!body.xdr || !body.throwawayPublicKey || !body.homePublicKey || !body.amount) {
        return send(res, 400, {
          error: "xdr, throwawayPublicKey, homePublicKey and amount are required (balanceId optional)",
        });
      }
      const rl = await enforceRateLimit(clientIp(req), body.throwawayPublicKey);
      if (rl.limited) return send(res, 429, { error: rl.reason });
      const result = await sweepHandler(server, config, signer, {
        xdr: body.xdr,
        throwawayPublicKey: body.throwawayPublicKey,
        homePublicKey: body.homePublicKey,
        balanceId: body.balanceId,
        amount: body.amount,
      });
      return send(res, 200, result);
    }

    if (method === "POST" && url === "/v2-claim") {
      const body = (await readJson(req)) as { method?: string; linkHex?: string; payout?: string; sigHex?: string };
      if (!body.method || !body.linkHex || !body.payout || !body.sigHex) {
        return send(res, 400, { error: "method, linkHex, payout and sigHex are required" });
      }
      const rl = await enforceRateLimit(clientIp(req), body.payout);
      if (rl.limited) return send(res, 429, { error: rl.reason });
      const result = await relayClaimHandler(config, signer, {
        method: body.method,
        linkHex: body.linkHex,
        payout: body.payout,
        sigHex: body.sigHex,
      });
      return send(res, 200, result);
    }

    if (method === "POST" && url === "/v2-deposit") {
      const body = (await readJson(req)) as { xdr?: string; senderPublicKey?: string };
      if (!body.xdr || !body.senderPublicKey) return send(res, 400, { error: "xdr and senderPublicKey are required" });
      const rl = await enforceRateLimit(clientIp(req), body.senderPublicKey);
      if (rl.limited) return send(res, 429, { error: rl.reason });
      const result = await relayDepositHandler(config, signer, { xdr: body.xdr, senderPublicKey: body.senderPublicKey });
      return send(res, 200, result);
    }

    if (method === "POST" && url === "/faucet") {
      if (!faucet) return send(res, 503, { error: "faucet not configured" });
      const body = (await readJson(req)) as { recipientPublicKey?: string };
      if (!body.recipientPublicKey) return send(res, 400, { error: "recipientPublicKey is required" });
      const rl = await enforceRateLimit(clientIp(req), body.recipientPublicKey);
      if (rl.limited) return send(res, 429, { error: rl.reason });
      const result = await faucetHandler(server, config, faucet, { recipientPublicKey: body.recipientPublicKey });
      return send(res, 200, result);
    }

    if (method === "POST" && url === "/demo-link") {
      if (!faucet) return send(res, 503, { error: "demo not configured" });
      const rl = await enforceRateLimit(clientIp(req));
      if (rl.limited) return send(res, 429, { error: rl.reason });
      const result = await demoLinkHandler(server, config, faucet);
      return send(res, 200, result);
    }

    if (method === "POST" && url === "/waitlist") {
      const rl = await enforceRateLimit(clientIp(req));
      if (rl.limited) return send(res, 429, { error: rl.reason });
      const body = (await readJson(req)) as { list?: string; email?: string };
      if (!body.list || !body.email) return send(res, 400, { error: "list and email are required" });
      await saveContact(body.list, body.email);
      return send(res, 200, { ok: true });
    }

    if (method === "POST" && url === "/feedback") {
      // Its OWN limiter bucket ("fb:" prefix): the dialog mounts on error states whose
      // plausible cause IS the shared per-IP window — the problem-report channel must
      // not be closed by the very throttling being reported. Spam here also cannot
      // consume the money-path window.
      const rl = await enforceRateLimit(`fb:${clientIp(req)}`);
      if (rl.limited) return send(res, 429, { error: rl.reason });
      const body = (await readJson(req)) as { category?: string; message?: string; contact?: string };
      await saveFeedback(body);
      return send(res, 200, { ok: true });
    }

    if (method === "POST" && url === "/events") {
      const rl = await enforceRateLimit(clientIp(req));
      if (rl.limited) return send(res, 429, { error: rl.reason });
      try {
        handleEvent((await readJson(req)) as { event?: string; cid?: string });
      } catch {
        /* ignore an unknown/bad event — the beacon is fire-and-forget */
      }
      return send(res, 200, { ok: true });
    }

    if (method === "POST" && url === "/recovery-otp") {
      // Email a single-use code (proves control of the email that keys the box).
      const rl = await enforceRateLimit(`rec:${clientIp(req)}`);
      if (rl.limited) return send(res, 429, { error: rl.reason });
      const body = (await readJson(req)) as { email?: unknown };
      await requestOtp(body.email);
      return send(res, 200, { ok: true });
    }

    if (method === "POST" && url === "/recovery") {
      // Store a ciphertext-only box AFTER verifying the emailed code. Its OWN limiter
      // bucket ("rec:"); signs nothing and touches no anti-drain policy.
      const rl = await enforceRateLimit(`rec:${clientIp(req)}`);
      if (rl.limited) return send(res, 429, { error: rl.reason });
      const body = (await readJson(req)) as { id?: unknown; box?: unknown; code?: unknown };
      if (!(await verifyOtp(body.id, body.code))) return send(res, 401, { error: "invalid or expired code" });
      await putBox(body.id, body.box);
      return send(res, 200, { ok: true });
    }

    if (method === "POST" && url === "/recovery-fetch") {
      const rl = await enforceRateLimit(`rec:${clientIp(req)}`);
      if (rl.limited) return send(res, 429, { error: rl.reason });
      const body = (await readJson(req)) as { id?: unknown; code?: unknown };
      if (!(await verifyOtp(body.id, body.code))) return send(res, 401, { error: "invalid or expired code" });
      const box = await getBox(body.id);
      if (!box) return send(res, 404, { error: "not found" });
      return send(res, 200, { box });
    }

    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 400, { error: (e as Error).message });
  }
});

httpServer.listen(config.port, () => {
  console.log(`lumenia-sponsor listening on :${config.port} (${config.network}, sponsor ${signer.publicKey()})`);
});
