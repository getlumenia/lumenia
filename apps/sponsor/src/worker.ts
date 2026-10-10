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
import { getServiceAsync, serviceConfigFromEnv, enforceRateLimit, corsHeaders, type Service } from "./lib/service.js";
import { ChannelManager } from "./lib/channels.js";
import { horizon } from "./lib/stellar.js";
import { isHalted, haltStatus } from "./lib/kill-switch.js";
import { runWatchdog, alertingStatus, watchdogStamps, watchdogAge } from "./lib/watchdog.js";
import { createAccountHandler } from "./lib/create-account.js";
import { feebumpHandler } from "./lib/feebump.js";
import { sendLinkHandler } from "./lib/send.js";
import { payoutHandler } from "./lib/payout.js";
import { sweepHandler } from "./lib/sweep.js";
import { relayClaimHandler, relayDepositHandler, relayReclaimHandler, isRelayBusy, oneLogLine } from "./lib/soroban-relay.js";
import { relayCctpHandler } from "./lib/cctp-relay.js";
import { withSubrequestMeter } from "./lib/subrequests.js";
import { faucetHandler } from "./lib/faucet.js";
import { demoLinkHandler } from "./lib/demo-link.js";
import { takeDemoLink, refillDemoPool } from "./lib/demo-pool.js";
import { saveContact } from "./lib/waitlist.js";
import { saveFeedback } from "./lib/feedback.js";
import { handleEvent, recordEvent, eventsSummary } from "./lib/events.js";
import {
  putBox,
  getBoxState,
  putAliasBox,
  getAliasBox,
  assertAliasWritable,
  BackupConflict,
  mintRecoveryTicket,
  consumeRecoveryTicket,
  checkMine,
  releaseBox,
  rowState,
  isBoundTo,
  ownerHashOf,
  ACCOUNT_NOT_CONFIRMED_ERROR,
  NOT_YOURS_ERROR,
  type OwnerProof,
} from "./lib/recovery-store.js";
import {
  requestOtp,
  verifyOtp,
  verifyOtpDetailed,
  idForEmail,
  isOtpBudgetExceeded,
  OTP_BUDGET_BODY,
} from "./lib/recovery-otp.js";
import {
  pilotEnabled,
  enforcePilot,
  pilotStatus,
  approvePilot,
  rejectPilot,
  getPilotEmail,
  isPilotApproved,
  verifyApprovalToken,
  shortAddress,
  type PilotSource,
} from "./lib/pilot.js";
import {
  notifyPilotRequest,
  answerSignedPilotRequest,
  normalizePilotEmail,
  notifyPilotApproved,
  notifyPilotRejected,
  notifyPilotInterest,
} from "./lib/pilot-request.js";
import {
  isPublicRefusal,
  PublicRefusal,
  checkOnboardingBudget,
  onboardingBudgetFromEnv,
  readDayCounters,
  readSponsorFeeDay,
  stroopsToXlm,
} from "./lib/caps.js";
import { isSubmitUnconfirmed } from "./lib/stellar.js";
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

/** Escape text for the owner pages: an applicant's email is user input, and they run on this origin. */
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The fields of a signed approve/decline link: from the query string on GET (the link the owner
 * tapped), from the form body on POST (the confirmation page's button).
 */
async function ownerLinkFields(request: Request, method: string): Promise<{ pubkey: string; token: string; exp: string }> {
  const params = method === "POST" ? new URLSearchParams(await readCapped(request)) : new URL(request.url).searchParams;
  return { pubkey: params.get("pubkey") ?? "", token: params.get("token") ?? "", exp: params.get("exp") ?? "" };
}

/** The confirmation page's button: the link's own three fields, posted back to the same path. */
function ownerConfirmForm(path: string, f: { pubkey: string; token: string; exp: string }, label: string): string {
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escHtml(value)}">`;
  return `<form method="post" action="${path}">${hidden("pubkey", f.pubkey)}${hidden("exp", f.exp)}${hidden("token", f.token)}<button type="submit" style="font:inherit;font-weight:600;padding:.7rem 1.4rem;border:0;border-radius:12px;background:#6E5FCE;color:#fff;cursor:pointer">${escHtml(label)}</button></form>`;
}

const PILOT_STORE_UNAVAILABLE = { error: "We couldn't record that just now. Try again in a minute.", code: "store-unavailable" } as const;

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
export async function withPilotSlot<T>(pubkey: string, run: () => Promise<T>): Promise<T | { error: string }> {
  if (!pilotEnabled()) return run();
  const p = await enforcePilot(pubkey);
  if (!p.ok) return { error: p.reason ?? "not admitted to the pilot" };
  try {
    return await run();
  } catch (e) {
    /* Only a transaction that definitely did not happen gives the slot back. A submission the
     * network never ruled on (SubmitUnconfirmedError: a Horizon timeout, an RPC that stopped
     * answering mid-poll) may still land, and handing the slot back for it let one approved wallet
     * spend the same slot twice: once for the deposit that landed, once for the retry. The handler's
     * own `{confirmed:false}` return takes the same line, by not throwing at all. */
    if (!isSubmitUnconfirmed(e)) await p.release?.();
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
  "/cctp-relay",
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

/**
 * /health's store readings (watchdog stamps, fee day, day counters), cached per isolate for a few
 * seconds. The cache holds the READ IN FLIGHT, not just its result, so a burst of requests on a cold
 * or expired cache shares one refresh: at most five store requests per isolate per window (two stamp
 * GETs, two fee GETs, one counters pipeline), whatever the request rate. Before D3 /health read no
 * store at all, and an anonymous amplifier is the class of hole the /pilot-status comment warns
 * about. A rate limiter would not do this job, because the limiter itself writes to the store on
 * every request. The halt is NOT in this cache: `haltStatus` keeps its own 5 s verdict, and caching
 * that again here let /health show a halt or a resume up to about ten seconds late.
 */
const HEALTH_CACHE_MS = 5_000;
type HealthReadings = {
  stamps: Awaited<ReturnType<typeof watchdogStamps>>;
  fees: Awaited<ReturnType<typeof readSponsorFeeDay>>;
  counters: Awaited<ReturnType<typeof readDayCounters>>;
};
let healthCache: { at: number; network: string; value: Promise<HealthReadings> } | null = null;

function healthReadings(network: string, now: number): Promise<HealthReadings> {
  if (healthCache && healthCache.network === network && now - healthCache.at >= 0 && now - healthCache.at < HEALTH_CACHE_MS) {
    return healthCache.value;
  }
  const value = Promise.all([
    watchdogStamps(network as "testnet" | "mainnet"),
    readSponsorFeeDay(undefined, now),
    readDayCounters(now),
  ]).then(([stamps, fees, counters]) => ({ stamps, fees, counters }));
  const entry = { at: now, network, value };
  healthCache = entry;
  // A refresh that fails is not kept: the next request tries again.
  value.catch(() => {
    if (healthCache === entry) healthCache = null;
  });
  return value;
}

/**
 * The service for the READ routes while the signer cannot be built. In KMS mode the signer starts
 * with one GetPublicKey, and while KMS is unreachable that throws; every route used to answer 400,
 * /health and the recovery routes included. Only the routes that sign need the signer, so the others
 * run on the config alone (built with no KMS call) and /health says the signer is unavailable. A
 * value or grant route still fails, as it must: there is no fallback signer.
 */
function degradedService(): Service & { degraded: true } {
  const { config, accountSource, kms } = serviceConfigFromEnv();
  return {
    config,
    signer: {
      publicKey: () => "",
      sign: () => {
        throw new Error("the signer is unavailable");
      },
    },
    signerKind: kms ? "kms" : "env",
    accountSource,
    faucet: null,
    server: horizon(config),
    channels: new ChannelManager([]),
    degraded: true,
  };
}

/** Tests only: forget the cached /health readings so a suite can see a store change at once. */
export function resetHealthCache(): void {
  healthCache = null;
}

/**
 * Which deployed version is answering, from Cloudflare's version metadata binding (wrangler.toml,
 * `[version_metadata]`, on both Workers): the version id, its tag and when it was created. It ties
 * /health to a version an operator can match against `wrangler deployments list` with nothing to
 * pass on each deploy. Undefined without the binding (a local run, a suite): /health then omits it.
 */
function deployedVersion(env: Env): { id: string | null; tag: string | null; timestamp: string | null } | undefined {
  const meta = env.CF_VERSION_METADATA;
  if (!meta || typeof meta !== "object") return undefined;
  const field = (k: "id" | "tag" | "timestamp"): string | null => {
    const v = (meta as Record<string, unknown>)[k];
    return typeof v === "string" && v !== "" ? v : null;
  };
  return { id: field("id"), tag: field("tag"), timestamp: field("timestamp") };
}

/** The longest reason the mainnet error log keeps (one line; see the catch in `fetch`). */
const LOG_REASON_MAX = 300;

const handlers = {
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
      // KMS-aware bootstrap: with KMS_KEY_ID set the sponsor signs via AWS KMS (no hot key). Only the
      // routes that sign need the signer; a failed bootstrap leaves the read routes up (degradedService).
      let svc: Service & { degraded?: true };
      try {
        svc = await getServiceAsync();
      } catch (e) {
        if (VALUE_ROUTES.has(url) || GRANT_ROUTES.has(url)) throw e;
        console.error(`[service] the signer could not be built, read routes only: ${(e as Error).message}`);
        svc = degradedService();
      }
      const { config, signer, signerKind, faucet, server, channels } = svc;

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

      /* /health is the one page an operator (and the dead-man workflow) reads from outside: which
       * key signs and for which account, whether the sponsor is halted and why, when the watchdog
       * last completed a run, whether a page can leave the Worker at all, and how much of today's
       * budgets is spent. Nothing here is a secret: no token, no key id, only public addresses and
       * counters a funding report already publishes. Unmetered, and its store readings are cached
       * per isolate (`healthReadings`): wait more than 5 s to see a store change here. */
      if (method === "GET" && url === "/health") {
        const now = Date.now();
        const [halt, { stamps, fees, counters }] = await Promise.all([haltStatus(now), healthReadings(config.network, now)]);
        const version = deployedVersion(env);
        return json(200, {
          // False only while the signer cannot be built (a KMS outage): every value route then fails.
          ok: !svc.degraded,
          service: "lumenia-sponsor",
          network: config.network,
          // The deployed version (id, tag, created at), present when the Worker has the binding.
          ...(version ? { version } : {}),
          sponsorPublicKey: config.sponsorAccountId,
          account: config.sponsorAccountId,
          // Where the account address came from: an explicit SPONSOR_ACCOUNT_ID (the KMS split), or
          // the signer's own key (the env hot key, account and signer one and the same).
          accountSource: svc.accountSource,
          signer: svc.degraded
            ? { kind: signerKind, publicKey: null, available: false }
            : { kind: signerKind, publicKey: signer.publicKey(), available: true },
          pilotMode: pilotEnabled(),
          usdcCode: config.usdc.getCode(),
          usdcIssuer: config.usdc.getIssuer(),
          contract: config.lumendropContract ?? null,
          halt,
          /* `lastRun` is written by every scheduled run, `lastFullRun` only by one in which every check
             completed (lib/watchdog.ts). The heartbeat workflow needs both keys present, null or not.
             An age is NEGATIVE for a stamp from the future, which the workflow reads as a failure. */
          watchdog: {
            lastRun: stamps.lastRun,
            ageSeconds: watchdogAge(stamps.lastRun, now),
            lastFullRun: stamps.lastFullRun,
            fullAgeSeconds: watchdogAge(stamps.lastFullRun, now),
          },
          alerting: alertingStatus(),
          fees: {
            day: fees.day,
            spentXlm: fees.spentStroops === null ? null : stroopsToXlm(fees.spentStroops),
            // Every bid accepted today, never lowered by a give-back (lib/caps.ts, feeGrossDayKey).
            grossXlm: fees.grossStroops === null ? null : stroopsToXlm(fees.grossStroops),
            maxXlm: stroopsToXlm(fees.maxStroops),
            used: fees.used === null ? null : Math.round(fees.used * 1000) / 1000,
          },
          counters: { ...counters, maxDaySourceAccounts: onboardingBudgetFromEnv().maxDaySourceAccounts },
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
        const budget = await checkOnboardingBudget(onboardingBudgetFromEnv(), clientIp(request), Date.now(), body.recipientPublicKey);
        if (!budget.ok) throw new PublicRefusal(budget.reason!);
        try {
          /* A REPEAT (this key already holds today's slot) is served on the sponsor path, never on
             a channel. A lease is held for its whole 150 s TTL because the client submits later, so
             leased repeats (up to 11 holds per admitted key a day) let one address empty the pool
             for minutes and push EVERY fresh claim onto the sponsor's single sequence, which a
             review measured. On the sponsor path the cost stays with repeats: two in flight share
             the sponsor's next sequence, and one a client submits (an account that exists makes it
             fail, but it is included) moves that sequence under the other sponsor-path handouts in
             flight, which then fail with a bad sequence and are retried. Disclosed in the report. */
          const pool = budget.repeat ? undefined : channels;
          return json(200, await createAccountHandler(server, config, signer, { recipientPublicKey: body.recipientPublicKey }, pool));
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

      /* Circle CCTP inbound (hackathon build, 2026-09-19): the sponsor pays the Soroban fee to mint
       * an attested Base burn into the Lumenia account the burn named (lib/cctp-relay.ts). The body
       * is a burn hash only; the sponsor fetches the message and attestation from Circle itself.
       * 202 while Circle has not attested yet: the caller polls, no Worker waits for minutes. */
      if (method === "POST" && url === "/cctp-relay") {
        if (config.network !== "testnet") return json(403, { error: "the CCTP relay is testnet-only" });
        if (!process.env.CCTP_FORWARDER) return json(503, { error: "cctp relay not configured" });
        const body = (await readJson(request)) as { burnTxHash?: string; sourceDomain?: number };
        if (!body.burnTxHash || !/^0x[0-9a-fA-F]{64}$/.test(body.burnTxHash)) {
          return json(400, { error: "burnTxHash (0x + 64 hex) is required" });
        }
        const rl = await enforceRateLimit(clientIp(request));
        if (rl.limited) return json(429, { error: rl.reason });
        const r = await relayCctpHandler(config, signer, { burnTxHash: body.burnTxHash, sourceDomain: body.sourceDomain }, {
          forwarder: process.env.CCTP_FORWARDER,
          irisUrl: process.env.CCTP_IRIS_URL,
          channels,
        });
        // 202 both while Circle has not attested yet AND when the mint was accepted but not yet
        // observed to land (the same "accepted, undecided" answer every relay gives, D3 item g).
        const undecided = r.status === "pending" || r.confirmed === false;
        return json(undecided ? 202 : 200, r);
      }

      if (method === "POST" && url === "/v2-claim") {
        const body = (await readJson(request)) as { method?: string; linkHex?: string; payout?: string; sigHex?: string; contract?: string };
        if (!body.method || !body.linkHex || !body.payout || !body.sigHex) {
          return json(400, { error: "method, linkHex, payout and sigHex are required" });
        }
        const rl = await enforceRateLimit(clientIp(request), body.payout);
        if (rl.limited) return json(429, { error: rl.reason });
        const out = await relayClaimHandler(config, signer, {
          method: body.method, linkHex: body.linkHex, payout: body.payout, sigHex: body.sigHex,
          contract: body.contract, // optional: a superseded escrow, for links minted pre-upgrade
        }, channels);
        /* 202 when the claim is on the network but the RPC had not shown it landing before the
         * window closed, exactly as /v2-deposit answers (below). A 400 here used to be redacted on
         * mainnet to "request failed", which the claim screen could only read as "nothing moved",
         * and its retry minted another sponsored payout account for a claim that then landed. A
         * returned 202 is not a thrown error, so the redaction never touches it. */
        return json(out.confirmed === false ? 202 : 200, out);
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
        const out = await relayReclaimHandler(config, signer, { xdr: body.xdr, senderPublicKey: body.senderPublicKey });
        // Same 202 contract as /v2-deposit and /v2-claim: accepted, undecided, here is the hash.
        return json(out.confirmed === false ? 202 : 200, out);
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

      // Client asks "is this account approved for mainnet?" — read-only, moves nothing. When the
      // pilot is off (every testnet deployment) it answers a plain "not a pilot", so the client
      // simply stays on testnet. The real gate is still the allowlist enforced on value routes.
      if (method === "GET" && url === "/pilot-status") {
        /* The retirement switch (SOW 2, D3 item i): with PILOT_MODE unset this Worker admits every
         * wallet to its value routes, so the honest answer is "open", to anyone, with or without a
         * key (a device with no account yet has none to send). It is answered BEFORE the rate
         * limiter on purpose: it reads no store, so there is nothing to amplify, and a bucket the
         * sender's own sends had spent must never turn "open" into a 429 the client could take
         * for "not approved".
         *
         * `approved: true` does NOT open real money for a web build from before this switch: that
         * build reads state "open" as "none" and keys every switch button on "approved". The web
         * from this change has to be live before the flip (evidence/SOW2_OPS_NOTE.md, section 1.2,
         * step 0). */
        if (!pilotEnabled()) return json(200, { pilot: false, approved: true, state: "open" });
        const pubkey = new URL(request.url).searchParams.get("pubkey");
        // Validated + metered: it reaches the store, and unmetered it is both an allowlist
        // enumeration oracle and a free amplifier turning one GET into a KV pipeline.
        if (!pubkey || !StrKey.isValidEd25519PublicKey(pubkey)) {
          return json(400, { error: "a valid pubkey is required" });
        }
        /* Its own buckets (`ps:`): a status check must never spend the per-IP or per-account windows
         * the value routes count, or a client polling for its approval 429s its own next send. */
        const rl = await enforceRateLimit(clientIp(request), pubkey, { ipPrefix: "ps:", accountPrefix: "ps:" });
        if (rl.limited) return json(429, { error: rl.reason });
        try {
          return json(200, { pilot: true, ...(await pilotStatus(pubkey)) });
        } catch {
          /* A store that did not answer is not a "no". This used to be 200 {pilot:true, approved:false},
           * which every client read as "not approved" and some showed as "ask to join" to a wallet
           * that was approved all along. 503 is what it is: we could not check. */
          return json(503, { error: "pilot store unavailable" });
        }
      }

      /* One-tap approve from the owner's email. The link carries a per-wallet, expiring signature
       * (lib/pilot.ts) rather than the shared secret, so a leaked link approves one wallet for one
       * week instead of everything forever. Rate-limited because this is the route that grants the
       * right to move real money, and an unmetered guessing loop against it is the worst hole in
       * the service.
       *
       * Opening the link (GET) only shows what it would do; the page's button (POST, the same three
       * fields) does it. Mail scanners and link previews open links on their own, and a GET that
       * granted real money let one of them approve a wallet nobody had looked at. */
      if ((method === "GET" || method === "POST") && url === "/pilot-approve") {
        const rl = await enforceRateLimit(clientIp(request), undefined, { ipPrefix: "pilot:" });
        if (rl.limited) return html(429, "<h2>Too many attempts</h2><p>Wait a minute and try again.</p>");
        const link = await ownerLinkFields(request, method);
        const { pubkey } = link;
        if (!process.env.PILOT_APPROVE_TOKEN) return html(503, "<h2>Approve-by-link isn't set up</h2><p>Set <code>PILOT_APPROVE_TOKEN</code> on the worker.</p>");
        if (!StrKey.isValidEd25519PublicKey(pubkey)) return html(400, "<h2>Invalid wallet address</h2>");
        if (!(await verifyApprovalToken("approve", pubkey, link.token, link.exp, Date.now()))) {
          return html(403, "<h2>Not authorized</h2><p>This approval link is invalid or has expired.</p>");
        }
        /* Idempotent: tapping the emailed Approve link twice must not re-send "you're in". Decided
         * from the allowlist flag itself, the one thing the value routes admit on, read with a call
         * that throws: the status key is not the allowlist (a revoked wallet kept "approved" and was
         * never re-admitted by its link), and a failed read must not fall through to approving.
         * `approvePilot` no longer resets spent slots either way (lib/pilot.ts). */
        let alreadyIn: boolean;
        try {
          alreadyIn = await isPilotApproved(pubkey);
        } catch {
          return html(503, "<h2>Could not check</h2><p>The pilot store did not answer, so nothing was changed. Try the link again in a minute.</p>");
        }
        const who = `<code>${escHtml(shortAddress(pubkey))}</code>`;
        if (alreadyIn) {
          return html(200, `<h2>Already approved</h2><p>${who} is already in the mainnet pilot. No second email sent.</p>`);
        }
        if (method === "GET") {
          return html(200, `<h2>Approve this wallet?</h2><p>${who} asked to join the mainnet pilot. Approving lets it move real money.</p>${ownerConfirmForm("/pilot-approve", link, "Approve")}`);
        }
        try {
          await approvePilot(pubkey);
          const email = await getPilotEmail(pubkey);
          const mailed = email ? await notifyPilotApproved(pubkey, email).catch(() => false) : false;
          const told = !email
            ? "No email on file, so nobody was told. Tell them yourself."
            : mailed
              ? `We emailed <b>${escHtml(email)}</b>.`
              : `The email to <b>${escHtml(email)}</b> did not go out (see the [pilot:approved] log line). Send it again with <code>pilot notify</code>.`;
          return html(200, `<h2>Approved</h2><p>${who} is now in the mainnet pilot.</p><p>${told}</p>`);
        } catch (e) {
          return html(500, `<h2>Couldn't approve</h2><p>${escHtml((e as Error).message)}</p>`);
        }
      }

      /* One-tap DECLINE from the owner's email: the same token guard and the same confirm-then-act
       * shape as approve. Marks the wallet rejected and sends the gentle "not approved for now" mail
       * (TASK 2). Declining an approved wallet asks first, with what it has used; declining a wallet
       * that is already declined changes nothing and mails nobody a second time. */
      if ((method === "GET" || method === "POST") && url === "/pilot-reject") {
        const rl = await enforceRateLimit(clientIp(request), undefined, { ipPrefix: "pilot:" });
        if (rl.limited) return html(429, "<h2>Too many attempts</h2><p>Wait a minute and try again.</p>");
        const link = await ownerLinkFields(request, method);
        const { pubkey } = link;
        if (!process.env.PILOT_APPROVE_TOKEN) return html(503, "<h2>Decline-by-link isn't set up</h2><p>Set <code>PILOT_APPROVE_TOKEN</code> on the worker.</p>");
        if (!StrKey.isValidEd25519PublicKey(pubkey)) return html(400, "<h2>Invalid wallet address</h2>");
        if (!(await verifyApprovalToken("reject", pubkey, link.token, link.exp, Date.now()))) {
          return html(403, "<h2>Not authorized</h2><p>This link is invalid or has expired.</p>");
        }
        let status: Awaited<ReturnType<typeof pilotStatus>>;
        try {
          status = await pilotStatus(pubkey);
        } catch {
          return html(503, "<h2>Could not check</h2><p>The pilot store did not answer, so nothing was changed. Try the link again in a minute.</p>");
        }
        const who = `<code>${escHtml(shortAddress(pubkey))}</code>`;
        if (status.state === "rejected") {
          return html(200, `<h2>Already declined</h2><p>${who}: Already declined. No second email sent.</p>`);
        }
        if (method === "GET") {
          return status.approved
            ? html(200, `<h2>Decline an approved wallet?</h2><p>${who}: This wallet is approved for real money and has used ${status.used} of ${status.limit} sends. Decline it anyway?</p>${ownerConfirmForm("/pilot-reject", link, "Decline anyway")}`)
            : html(200, `<h2>Decline this wallet?</h2><p>${who} asked to join the mainnet pilot. Declining keeps it in practice mode.</p>${ownerConfirmForm("/pilot-reject", link, "Decline")}`);
        }
        try {
          await rejectPilot(pubkey);
          const email = await getPilotEmail(pubkey);
          const mailed = email ? await notifyPilotRejected(pubkey, email).catch(() => false) : false;
          const told = !email
            ? "No email on file, so nobody was told. Tell them yourself."
            : mailed
              ? `We emailed <b>${escHtml(email)}</b>.`
              : `The email to <b>${escHtml(email)}</b> did not go out (see the [pilot:rejected] log line).`;
          return html(200, `<h2>Declined</h2><p>${who} was declined.</p><p>${told}</p>`);
        } catch (e) {
          return html(500, `<h2>Couldn't decline</h2><p>${escHtml((e as Error).message)}</p>`);
        }
      }

      /* A wallet asking into the mainnet pilot (contract 3.2). It moves no money; it files the ask
       * and mails the owner, who approves from the mail or the pilot CLI.
       *
       * SIGNED (an `owner` proof): the account signs `pilot` over the hash of the email, so nobody
       * can file for a key they do not hold, and the email is proven by a code from /recovery-otp
       * (purpose "pilot", on this same host) or, with no code, by this email's backup row being bound
       * to this key. "No row", "an unbound row" and "another key's row" all answer code-required, so
       * an ask without a code says nothing about whose email it is. Only a caller that proved the
       * inbox hears that the email backs up another account.
       *
       * LEGACY (no `owner`): the old unsigned ask, answered as before, until PILOT_REQUIRE_PROOF=1.
       * Its own rate-limit buckets (`pr:`), like /pilot-status. */
      if (method === "POST" && url === "/pilot-request") {
        const body = (await readJson(request)) as { pubkey?: unknown; email?: unknown; owner?: unknown; code?: unknown; src?: unknown };
        const pubkey = typeof body.pubkey === "string" ? body.pubkey : "";
        const rawEmail = typeof body.email === "string" ? body.email : "";
        if (!pubkey || !rawEmail) return json(400, { error: "pubkey and email are required" });
        if (!StrKey.isValidEd25519PublicKey(pubkey)) return json(400, { error: "invalid pubkey" });
        const email = normalizePilotEmail(rawEmail);
        if (!email) return json(400, { error: "invalid email" });
        const rl = await enforceRateLimit(clientIp(request), pubkey, { ipPrefix: "pr:", accountPrefix: "pr:" });
        if (rl.limited) return json(429, { error: rl.reason });
        const origin = new URL(request.url).origin;

        if (body.owner === undefined || body.owner === null) {
          if (process.env.PILOT_REQUIRE_PROOF === "1") {
            return json(400, { error: "Reload the page and ask again.", code: "proof-required" });
          }
          try {
            return json(200, await notifyPilotRequest(pubkey, email, origin));
          } catch (e) {
            console.error(`[pilot:request] ${config.network} store error: ${oneLogLine((e as Error).message, LOG_REASON_MAX)}`);
            return json(503, PILOT_STORE_UNAVAILABLE);
          }
        }

        const owner = typeof body.owner === "object" ? (body.owner as Partial<OwnerProof>) : {};
        const badProof = { error: ACCOUNT_NOT_CONFIRMED_ERROR, code: "bad-proof" };
        if (String(owner.pubkey ?? "") !== pubkey) return json(401, badProof);
        try {
          const id = await idForEmail(email);
          const signed = await verifyHandleProof({
            action: "pilot",
            name: id,
            pubkey,
            ts: Number(owner.ts),
            nonce: String(owner.nonce ?? ""),
            network: config.network,
            proof: String(owner.proof ?? ""),
          });
          if (signed.ok !== true) return json(401, badProof);

          let inboxProof: "code" | "backup";
          const hasCode = body.code !== undefined && body.code !== null && body.code !== "";
          if (hasCode) {
            const verdict = await verifyOtpDetailed(id, body.code);
            if (verdict === "budget") return json(429, OTP_BUDGET_BODY);
            if (verdict !== "ok") return json(401, { error: "That code is wrong or has expired.", code: "bad-code" });
            inboxProof = "code";
            // The inbox is proven, so the caller may hear whose email it is. Only when this host can
            // read the row: a read that fails here is the store's problem, and the filing reports it.
            const row = await rowState(id).catch(() => null);
            if (row?.ownerHash !== undefined && row.ownerHash !== (await ownerHashOf(pubkey))) {
              return json(409, {
                error: "That email backs up another Lumenia account. Ask with the email that backs up this one.",
                code: "email-taken",
              });
            }
          } else {
            if (!(await isBoundTo(id, pubkey))) {
              return json(401, { error: "Confirm your email with a code first.", code: "code-required" });
            }
            inboxProof = "backup";
          }
          const src: PilotSource | undefined = body.src === "web" || body.src === "ext" ? body.src : undefined;
          return json(200, await answerSignedPilotRequest(pubkey, email, src, inboxProof, origin));
        } catch (e) {
          console.error(`[pilot:request] ${config.network} store error: ${oneLogLine((e as Error).message, LOG_REASON_MAX)}`);
          return json(503, PILOT_STORE_UNAVAILABLE);
        }
      }

      if (method === "POST" && url === "/feedback") {
        // Its OWN limiter bucket ("fb:") — see index.ts.
        const rl = await enforceRateLimit(clientIp(request), undefined, { ipPrefix: "fb:" });
        if (rl.limited) return json(429, { error: rl.reason });
        await saveFeedback((await readJson(request)) as { category?: string; message?: string; contact?: string });
        return json(200, { ok: true });
      }

      if (method === "POST" && url === "/events") {
        // Its OWN limiter bucket ("ev:"), like /feedback. Beacons used to share the per-IP bucket
        // with claims, so on one venue Wi-Fi the room's analytics could 429 the room's claims.
        const rl = await enforceRateLimit(clientIp(request), undefined, { ipPrefix: "ev:" });
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
        const rl = await enforceRateLimit(clientIp(request), undefined, { ipPrefix: "rec:" });
        if (rl.limited) return json(429, { error: rl.reason });
        const body = (await readJson(request)) as { email?: unknown; purpose?: unknown };
        try {
          // "pilot" changes the words of the mail only: the code that confirms an email for /pilot-request.
          await requestOtp(body.email, body.purpose === "pilot" ? "pilot" : "recovery");
        } catch (e) {
          if (isOtpBudgetExceeded(e)) return json(429, OTP_BUDGET_BODY);
          throw e;
        }
        return json(200, { ok: true });
      }

      /* Store the email-keyed box (contract 2.2). The gate is an emailed code, or the single-use
       * ticket a 409 or a fetch handed to whoever just passed one; never both, never neither. Who may
       * replace what is lib/recovery-store.ts `putBox`: one email backs up one account, and a write
       * that would take over a row it may not is a 409 carrying what the row holds. */
      if (method === "POST" && url === "/recovery") {
        const rl = await enforceRateLimit(clientIp(request), undefined, { ipPrefix: "rec:" });
        if (rl.limited) return json(429, { error: rl.reason });
        const body = (await readJson(request)) as {
          id?: unknown; box?: unknown; code?: unknown; ticket?: unknown; owner?: unknown; replace?: unknown;
          aliasId?: unknown; aliasProof?: unknown;
        };
        const present = (v: unknown) => v !== undefined && v !== null && v !== "";
        if (present(body.code) === present(body.ticket)) return json(401, { error: "invalid or expired code" });
        if (present(body.ticket)) {
          if (!(await consumeRecoveryTicket(body.ticket, body.id))) return json(401, { error: "invalid or expired code" });
        } else {
          const verdict = await verifyOtpDetailed(body.id, body.code);
          if (verdict === "budget") return json(429, OTP_BUDGET_BODY);
          if (verdict !== "ok") return json(401, { error: "invalid or expired code" });
        }
        /* Optional PRF alias, written behind the SAME verified code, and checked BEFORE the email row
         * is touched, so a refused alias cannot leave a new email row behind it. Refusing aliasId ===
         * id is not defensive noise: it would drop an email-derived (low-entropy) id into the
         * namespace whose fetch route has no OTP, which is exactly the bypass the two namespaces
         * exist to prevent. The code proves control of `id` only, so the alias write carries its own
         * passkey-derived proof of ownership (see putAliasBox). */
        if (body.aliasId !== undefined) {
          if (body.aliasId === body.id) return json(400, { error: "aliasId must differ from id" });
          await assertAliasWritable(body.aliasId, body.aliasProof);
        }
        // The code proves control of an INBOX. `owner` is the account's own signature over this
        // box's id, and it is what binds the row (see putBox).
        let stored: { ok: true; bound: boolean };
        try {
          stored = await putBox(
            body.id,
            body.box,
            body.owner && typeof body.owner === "object" ? (body.owner as OwnerProof) : undefined,
            { replace: body.replace === true },
          );
        } catch (e) {
          if (e instanceof BackupConflict) {
            /* A fresh ticket only for a write an emailed CODE let in. A ticket stands in for a code
             * exactly once: a write it let in that is refused again (no `replace`, no signature) gets
             * no new one, or a single code would buy an endless chain of tickets, each re-reading the
             * box and keeping the row open to a takeover without the inbox ever being asked again.
             * Every client sends a ticket with `replace` and a signature, which an unbound row takes. */
            const ticket = e.unbound && !present(body.ticket) ? await mintRecoveryTicket(body.id) : undefined;
            return json(409, { error: e.message, code: "email-taken", unbound: e.unbound, box: e.box, ...(ticket ? { ticket } : {}) });
          }
          throw e;
        }
        if (body.aliasId !== undefined) await putAliasBox(body.aliasId, body.box, body.aliasProof);
        return json(200, { ok: true, bound: stored.bound });
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
        const rl = await enforceRateLimit(clientIp(request), typeof body.id === "string" ? body.id : undefined, { ipPrefix: "recpk:" });
        if (rl.limited) return json(429, { error: rl.reason });
        const box = await getAliasBox(body.id);
        if (!box) return json(404, { error: "not found" });
        return json(200, { box });
      }

      /* `bound` says whether the row is tied to an account yet; an unbound one comes with a ticket,
       * so the person who just restored it can bind it to the key it opens without a second code. */
      if (method === "POST" && url === "/recovery-fetch") {
        const rl = await enforceRateLimit(clientIp(request), undefined, { ipPrefix: "rec:" });
        if (rl.limited) return json(429, { error: rl.reason });
        const body = (await readJson(request)) as { id?: unknown; code?: unknown };
        const verdict = await verifyOtpDetailed(body.id, body.code);
        if (verdict === "budget") return json(429, OTP_BUDGET_BODY);
        if (verdict !== "ok") return json(401, { error: "invalid or expired code" });
        const found = await getBoxState(body.id);
        if (!found) return json(404, { error: "not found" });
        const ticket = found.bound ? undefined : await mintRecoveryTicket(body.id);
        return json(200, { box: found.box, bound: found.bound, ...(ticket ? { ticket } : {}) });
      }

      /* Does this email back up the account that signs? (contract 2.4) No code: the account's own
       * `links` proof over "check:" + id. `mine` is true only for a row bound to the signer; no row,
       * an unbound row and another account's row all answer false, so it says nothing about anyone
       * else. Its own buckets (`rc:`). */
      if (method === "POST" && (url === "/recovery-check" || url === "/recovery-release")) {
        const body = (await readJson(request)) as { id?: unknown; owner?: unknown };
        const owner = body.owner && typeof body.owner === "object" ? (body.owner as OwnerProof) : undefined;
        const signer = owner && typeof owner.pubkey === "string" && StrKey.isValidEd25519PublicKey(owner.pubkey) ? owner.pubkey : undefined;
        const rl = await enforceRateLimit(clientIp(request), signer, { ipPrefix: "rc:", accountPrefix: "rc:" });
        if (rl.limited) return json(429, { error: rl.reason });
        if (typeof body.id !== "string" || !/^[0-9a-f]{64}$/.test(body.id) || !owner) {
          return json(400, { error: "id and owner are required" });
        }
        if (url === "/recovery-check") {
          const checked = await checkMine(body.id, owner);
          if (!checked.ok) return json(401, { error: ACCOUNT_NOT_CONFIRMED_ERROR });
          return json(200, { mine: checked.mine });
        }
        /* Let go of a backup email (contract 2.5), so it can back up another account: a `links` proof
         * over "release:" + id. Deletes only a row bound to the signer. */
        const released = await releaseBox(body.id, owner);
        if (!released.ok) return json(401, { error: ACCOUNT_NOT_CONFIRMED_ERROR });
        if (!released.released) return json(409, { error: NOT_YOURS_ERROR, code: "not-yours" });
        return json(200, { ok: true });
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
        const rl = await enforceRateLimit(clientIp(request), typeof b.pubkey === "string" ? b.pubkey : undefined, { ipPrefix: "handle:" });
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
        const rl = await enforceRateLimit(clientIp(request), typeof b.pubkey === "string" ? b.pubkey : undefined, { ipPrefix: "handle:" });
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
        const rl = await enforceRateLimit(clientIp(request), undefined, { ipPrefix: "idlink:" });
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
        const rl = await enforceRateLimit(clientIp(request), undefined, { ipPrefix: "idlink:" });
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
        const accountProof = b.accountProof && typeof b.accountProof === "object" ? (b.accountProof as AccountProof) : undefined;
        if (url === "/identity-detach") {
          // The identity alone (an inbox code, say) is not standing to cut a link off an account:
          // the account it leads to has to sign too, exactly as it does to attach one.
          const done = await detachIdentity(resolved, config.network, accountProof);
          if (done.ok) return json(200, done);
          return done.unauthorized ? json(401, { error: done.reason }) : json(404, { error: done.reason });
        }
        /* One email, one account, in both registries. An email that backs up one account must not
         * become a way back in to another: "find my account" and "restore my backup" would then
         * open two different keys for the same address. The inbox code was just verified above, so
         * saying the email is taken tells the caller nothing they may not know. */
        const address = String(b.address ?? "");
        if (resolved.provider === "email" && resolved.label && StrKey.isValidEd25519PublicKey(address)) {
          const row = await rowState(await idForEmail(resolved.label));
          if (row.ownerHash !== undefined && row.ownerHash !== (await ownerHashOf(address))) {
            return json(409, { error: "That email already backs up another account." });
          }
        }
        // Two different proofs, so two different keys: `proof` above is the identity's, and
        // `accountProof` is the account agreeing to be what that identity opens. attachIdentity
        // refuses without the second, so a route that never forwarded it could never attach.
        const attached = await attachIdentity(
          resolved,
          address,
          config.network,
          b.box,
          typeof b.passkeyProof === "string" ? b.passkeyProof : undefined,
          accountProof,
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
        const rl = await enforceRateLimit(clientIp(request), pubkey, { ipPrefix: "idlink:" });
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
        const rl = await enforceRateLimit(clientIp(request), pubkey, { ipPrefix: "idlink:" });
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
      if (isPublicRefusal(e)) {
        const code = (e as { code?: unknown }).code;
        return json(400, { error: message, ...(typeof code === "string" ? { code } : {}) });
      }
      /* A submission Horizon never ruled on is not a failure and must not be reported as one, on
       * any network. The mainnet redaction below used to turn it into a bare "request failed",
       * which the client could only read as "nothing moved" — and on /payout a retry on that
       * reading is a second payment to an exchange. 202 says what is true: accepted, undecided,
       * here is the hash to settle it against the ledger. The web client already treats 202 and
       * the words "submit unconfirmed" as exactly that. */
      if (isSubmitUnconfirmed(e)) {
        const hash = (e as { hash?: string }).hash;
        return json(202, { error: "submit unconfirmed", ...(hash ? { hash } : {}) });
      }
      /* The RPC declined to queue a relayed transaction (TRY_AGAIN_LATER): nothing is on the
       * network and the budget was given back. 503 with a public sentence, on every network: the
       * claim screen reads "shortly" as a short wait worth a retry, never as a failure. */
      if (isRelayBusy(e)) return json(503, { error: message });
      if (process.env.STELLAR_NETWORK === "mainnet") {
        const ref = crypto.randomUUID().slice(0, 8);
        /* The log keeps the reason, as ONE line: every full address in it cut to four characters,
           nothing past the first line or LOG_REASON_MAX. The refusals that could carry an address,
           a link id or an amount are trimmed where they are thrown (a simulation's event log in
           lib/soroban-relay.ts and lib/cctp-relay.ts, the payout and sweep reasons in
           lib/anti-drain.ts, Horizon's envelope in lib/stellar.ts); this is the belt behind them. */
        console.error(`[error ${ref}] ${new URL(request.url).pathname}: ${oneLogLine(message, LOG_REASON_MAX)}`);
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
    /* The watchdog needs the ACCOUNT, never the signer: built without a signer and without a single
       KMS call, so a KMS outage cannot stop the one stop that needs no store (lib/service.ts). This
       is the Worker's own scheduled run, the only caller that may halt and write the heartbeat:
       `runWatchdog` is read-only without both flags (lib/watchdog.ts, contract 5). The run is both
       handed to waitUntil and awaited, so it is covered by the cron's own duration either way. */
    const { config } = serviceConfigFromEnv();
    const run = runWatchdog(config, config.sponsorAccountId, { autoHalt: true, heartbeat: true }).then((r) => {
      console.log(`[watchdog] checked ${r.checked.join(", ")}: ${r.alerts.length} alert(s); heartbeat ${r.lastRun}; full run ${r.lastFullRun}`);
      if (r.autoHalted) console.error("[watchdog] AUTO-HALT written: every value route answers 503 until an operator clears it");
    });
    ctx.waitUntil(run);
    await run;
  },
};

export default {
  /**
   * Every request runs under the subrequest meter (lib/subrequests.ts): each fetch it makes is
   * counted, and a relay stops polling while it still has room for what follows the poll, five
   * under the 50 a Worker invocation may make on the Free plan.
   */
  fetch(request: Request, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    return withSubrequestMeter(() => handlers.fetch(request, env, ctx));
  },
  scheduled: handlers.scheduled,
};
