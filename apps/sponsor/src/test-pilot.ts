/**
 * PILOT GUARD TESTS — the mainnet-pilot allowlist + per-wallet tx budget (lib/pilot.ts).
 * Offline: a fake in-memory KV stands in for Upstash, so this runs with no network and no
 * secrets. Proves: only approved wallets are admitted, each gets exactly PILOT_MAX_TX slots,
 * a failed op releases its slot, revoke locks a wallet out, the store is fail-closed, and the
 * allowlist is namespaced per network. Also pins the shape of the one email↔wallet join this
 * service keeps: where it lives, that it expires, and that revoking erases it.
 *
 * RUN: pnpm --filter @lumenia/sponsor test:pilot
 */
import {
  enforcePilot,
  approvePilot,
  resetPilotBudget,
  revokePilot,
  pilotStatus,
  pilotEnabled,
  mintApprovalToken,
  verifyApprovalToken,
  startPilotRequest,
  getPilotEmail,
  PILOT_EMAIL_RETENTION_SECONDS,
  listPilot,
  rejectPilot,
  shortAddress,
  getPilotSrc,
  PILOT_MAILED_SECONDS,
} from "./lib/pilot.js";
import { notifyPilotApproved, notifyPilotRejected } from "./lib/pilot-request.js";
import { ipBucket, rateLimitKeys, checkRateLimit } from "./lib/rate-limit.js";
import { SubmitUnconfirmedError } from "./lib/stellar.js";
import { resetHaltCache } from "./lib/kill-switch.js";
import { resetServiceCache } from "./lib/service.js";
import { handleProofMessage, proofNonce } from "./lib/handles.js";
import { idForEmail } from "./lib/recovery-otp.js";
import { putBox } from "./lib/recovery-store.js";
import { saveContact, listContacts } from "./lib/waitlist.js";
import { pilotListLines, pilotStatusLines, waitlistLines } from "./lib/pilot-report.js";
import { Keypair } from "@stellar/stellar-sdk";
import worker, { resetHealthCache, withPilotSlot } from "./worker.js";

let pass = 0,
  fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✔" : "✗"} ${n}${d ? `  (${d})` : ""}`);
  ok ? pass++ : fail++;
};

/**
 * In-memory stand-in for the Upstash REST API the pilot, recovery and limiter modules talk to:
 * the pipeline (GET/SET/DEL/INCR/DECR/SCAN/EXPIRE/PEXPIRE/SMEMBERS/GETDEL) and the single-command
 * paths (`/get/<key>`, `/set/<key>?EX=` with the value as the body, `/del/<key>`, `/sadd/<key>/<m>`).
 * `ttls` records the `EX` seconds of a SET so a test can prove a key was written with an expiry —
 * an unbounded write and a bounded one are otherwise indistinguishable from the outside.
 *
 * It also stands in for the MAILER: every POST to api.resend.com lands in `mails`, answered with
 * `mailStatus()` (default 200), or thrown when `mailThrows()` says so.
 */
interface SentMail {
  to?: string[];
  subject?: string;
  text?: string;
  html?: string;
}
function installFakeKv(
  opts: { failGets?: () => boolean; mailStatus?: () => number; mailThrows?: () => boolean } = {},
) {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const sets = new Map<string, Set<string>>();
  const mails: SentMail[] = [];
  process.env.KV_REST_API_URL = "https://fake-kv.test";
  process.env.KV_REST_API_TOKEN = "t";
  const ok = (result: unknown) => ({ ok: true, status: 200, json: async () => result }) as unknown as Response;
  const setValue = (key: string, value: string, ex?: number) => {
    store.set(key, value);
    ttls.delete(key);
    if (ex !== undefined && Number.isFinite(ex)) ttls.set(key, ex);
  };
  globalThis.fetch = (async (_url: string | URL, init?: { body?: string; method?: string }) => {
    const url = String(_url);
    if (url.startsWith("https://api.resend.com/")) {
      if (opts.mailThrows?.()) throw new Error("mailer unreachable");
      mails.push(JSON.parse(String(init?.body ?? "{}")) as SentMail);
      const status = opts.mailStatus?.() ?? 200;
      return { ok: status >= 200 && status < 300, status, json: async () => ({}) } as unknown as Response;
    }
    // A store that stops answering (the approve-link test's outage, the 503 checks), on request.
    if (opts.failGets?.()) return { ok: false, status: 500, json: async () => [] } as unknown as Response;
    const parsed = new URL(url);
    const segs = parsed.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
    const [cmd, key, member] = segs;
    // The single-command paths: a read, a write with its value as the body, a delete, a set add.
    if (cmd === "get" && key) return ok({ result: store.has(key) ? store.get(key) : null });
    if (cmd === "set" && key) {
      const ex = parsed.searchParams.get("EX");
      setValue(key, String(init?.body ?? ""), ex === null ? undefined : Number(ex));
      return ok({ result: "OK" });
    }
    if (cmd === "del" && key) {
      const had = store.delete(key);
      ttls.delete(key);
      return ok({ result: had ? 1 : 0 });
    }
    if (cmd === "sadd" && key && member !== undefined) {
      const set = sets.get(key) ?? new Set<string>();
      const added = !set.has(member);
      set.add(member);
      sets.set(key, set);
      return ok({ result: added ? 1 : 0 });
    }
    const cmds = JSON.parse(String(init?.body ?? "[]")) as string[][];
    const results = cmds.map((c) => {
      const [op, k, arg] = c;
      switch (op) {
        case "GET":
          return { result: store.has(k!) ? store.get(k!) : null };
        case "GETDEL": {
          const v = store.has(k!) ? store.get(k!) : null;
          store.delete(k!);
          ttls.delete(k!);
          return { result: v };
        }
        case "SET": {
          if (c.includes("NX") && store.has(k!)) return { result: null };
          const ex = c.indexOf("EX");
          setValue(k!, String(arg), ex > 0 && c[ex + 1] !== undefined ? Number(c[ex + 1]) : undefined);
          return { result: "OK" };
        }
        case "DEL": {
          const had = store.delete(k!);
          ttls.delete(k!);
          return { result: had ? 1 : 0 };
        }
        case "INCR": {
          const n = Number(store.get(k!) ?? "0") + 1;
          store.set(k!, String(n));
          return { result: n };
        }
        case "DECR": {
          const n = Number(store.get(k!) ?? "0") - 1;
          store.set(k!, String(n));
          return { result: n };
        }
        case "EXPIRE":
        case "PEXPIRE":
          // The windows of the limiter and the code budgets. Time does not pass in this fake.
          return { result: store.has(k!) ? 1 : 0 };
        case "SMEMBERS":
          return { result: [...(sets.get(k!) ?? new Set<string>())] };
        case "SCAN": {
          // SCAN <cursor> MATCH <glob> COUNT <n>: one page holds everything, the cursor comes back "0".
          const at = c.indexOf("MATCH");
          const glob = at > 0 ? String(c[at + 1]) : "*";
          const re = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
          return { result: ["0", [...store.keys()].filter((key2) => re.test(key2))] };
        }
        default:
          throw new Error(`unexpected command ${op}`);
      }
    });
    return ok(results);
  }) as typeof fetch;
  return { store, ttls, sets, mails };
}
function clearKv() {
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
}

const W = "GABFQIK63R2NETJM7T673EAMZN4RJLLGP3OFUEJU5SZVTGWUKULZJNL6";
const W2 = "GBHB3NAY2ADZ3XAGJNO6UN6GWT2D3PC4DXEQ2SVBGPIX6N6RS4PRBUK2";

/* ---- The shared account contract's pilot host (sections 1, 3 and 6), driven through worker.fetch ---- */

const OWNER = "owner@example.test";
const NINETY_DAYS = 7776000;
const BOX = {
  formatVersion: 1,
  copies: [{ kind: "password", iv: "AAAA", ct: "BBBB", salt: "CCCC", argon: { memMiB: 48, time: 2, parallelism: 1 } }],
};

/** The mainnet pilot Worker's configuration, with the mailer on (it is the fake in installFakeKv). */
function mainnetEnv(): void {
  process.env.STELLAR_NETWORK = "mainnet";
  process.env.PILOT_MODE = "1";
  process.env.RESEND_API_KEY = "re_test";
  process.env.OWNER_EMAIL = OWNER;
  process.env.PILOT_APPROVE_TOKEN = "an-approve-secret";
  process.env.SPONSOR_ORIGIN = "https://sponsor-mainnet.test";
  process.env.WEB_ORIGIN = "https://getlumenia.com";
  // These sections ask far more often than a person would; the limits are not what they test.
  process.env.RATE_CAP = "1000";
  process.env.ACCOUNT_RATE_CAP = "1000";
  resetServiceCache(); // the service (and its network) is built once per isolate
  resetHaltCache();
}
function clearMainnetEnv(): void {
  for (const k of ["STELLAR_NETWORK", "PILOT_MODE", "RESEND_API_KEY", "OWNER_EMAIL", "PILOT_APPROVE_TOKEN", "SPONSOR_ORIGIN", "WEB_ORIGIN", "RATE_CAP", "ACCOUNT_RATE_CAP", "PILOT_REQUIRE_PROOF"]) {
    delete process.env[k];
  }
  resetServiceCache();
  resetHaltCache();
  clearKv();
}

type Answer = { status: number; json: Record<string, any> };
async function asJson(res: Response): Promise<Answer> {
  const text = await res.text();
  try {
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : {} };
  } catch {
    return { status: res.status, json: { raw: text.slice(0, 120) } };
  }
}
function get(path: string, ip = "198.51.100.20"): Promise<Response> {
  return worker.fetch(new Request(`https://sponsor.test${path}`, { headers: { "cf-connecting-ip": ip } }), {});
}
async function post(path: string, body: unknown, ip = "198.51.100.20"): Promise<Answer> {
  return asJson(
    await worker.fetch(
      new Request(`https://sponsor.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify(body),
      }),
      {},
    ),
  );
}
/** Flat objects with the same keys and values, in any order. */
function flatEq(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/** The account's own `pilot` proof over the hash of `email` (contract 1). Overrides make the bad ones. */
async function pilotProof(
  kp: Keypair,
  email: string,
  over: { pubkey?: string; action?: "pilot" | "links"; network?: "testnet" | "mainnet" } = {},
) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = proofNonce();
  const pubkey = over.pubkey ?? kp.publicKey();
  const message = handleProofMessage(over.action ?? "pilot", await idForEmail(email), pubkey, ts, nonce, over.network ?? "mainnet");
  return { pubkey, ts, nonce, proof: kp.sign(Buffer.from(message, "utf8")).toString("base64") };
}

/** A backup write's owner proof (the `links` proof over the box id), on this host's network. */
function writeProof(kp: Keypair, id: string) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = proofNonce();
  const message = handleProofMessage("links", id, kp.publicKey(), ts, nonce, "mainnet");
  return { pubkey: kp.publicKey(), ts, nonce, proof: kp.sign(Buffer.from(message, "utf8")).toString("base64") };
}

/** Ask this host for a real-money code (purpose "pilot") and read it out of the mail it sent. */
async function pilotCode(mails: SentMail[], email: string): Promise<string> {
  const before = mails.length;
  const res = await post("/recovery-otp", { email, purpose: "pilot" });
  const mail = mails.slice(before).find((m) => m.to?.[0] === email);
  const code = /^Your Lumenia code: (\d{6})$/.exec(mail?.subject ?? "")?.[1];
  if (res.status !== 200 || !code) throw new Error(`no code for ${email}: ${res.status} ${JSON.stringify(res.json)}`);
  return code;
}

/** Run `fn` with console.log captured. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = real;
  }
}

/** The confirmation page's button: the link's three fields, form-encoded, POSTed to the same path. */
function ownerPost(path: string, pubkey: string, t: { token: string; exp: number }, ip?: string): Request {
  return new Request(`https://sponsor.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(ip ? { "cf-connecting-ip": ip } : {}) },
    body: new URLSearchParams({ pubkey, exp: String(t.exp), token: t.token }).toString(),
  });
}

async function main() {
  console.log("============================================================");
  console.log(" PILOT GUARD TESTS (offline)");
  console.log("============================================================\n");

  console.log("[1] the mode flag");
  delete process.env.PILOT_MODE;
  check("pilot is OFF by default (a no-op on the open product)", pilotEnabled() === false);
  process.env.PILOT_MODE = "1";
  check("PILOT_MODE=1 turns the gate on", pilotEnabled() === true);
  delete process.env.STELLAR_NETWORK; // → testnet namespace
  delete process.env.PILOT_MAX_TX; // → default 5

  console.log("[2] an un-approved wallet is refused");
  installFakeKv();
  const na = await enforcePilot(W);
  check("un-approved wallet rejected", !na.ok);
  check("the reason says it's not on the allowlist", /allowlist/.test(na.reason ?? ""), na.reason);

  console.log("[3] owner approval");
  await approvePilot(W);
  const st = await pilotStatus(W);
  check("after approve: approved, 0 used, limit 5", st.approved && st.used === 0 && st.limit === 5);

  console.log("[4] a hard budget of 5 value ops");
  let admitted = 0;
  for (let i = 0; i < 5; i++) if ((await enforcePilot(W)).ok) admitted++;
  check("the first 5 ops are admitted", admitted === 5, `${admitted}/5`);
  const sixth = await enforcePilot(W);
  check("the 6th is rejected", !sixth.ok);
  check("the reason names the limit", /5 transactions/.test(sixth.reason ?? ""), sixth.reason);
  check("a rejected op did NOT consume a slot (still 5 used)", (await pilotStatus(W)).used === 5);

  console.log("[5] a failed op releases its slot");
  installFakeKv();
  await approvePilot(W2);
  const r = await enforcePilot(W2);
  check("op admitted, exposes release()", r.ok && typeof r.release === "function");
  check("one slot used", (await pilotStatus(W2)).used === 1);
  await r.release!(); // pretend the transaction failed
  check("release() hands the slot back (0 used)", (await pilotStatus(W2)).used === 0);

  console.log("[6] revoke locks a wallet out again");
  await revokePilot(W2);
  check("a revoked wallet is rejected", !(await enforcePilot(W2)).ok);
  check("and its status follows the allowlist: declined, never 'approved' with no flag behind it", (await pilotStatus(W2)).state === "rejected");
  check("and it says it was revoked, not declined (revoked:true)", (await pilotStatus(W2)).revoked === true);

  console.log("[7] fail-closed: no store, no admission");
  clearKv();
  check("with no KV configured, admission is refused", !(await enforcePilot(W)).ok);

  console.log("[8] the allowlist is namespaced per network");
  installFakeKv();
  await approvePilot(W); // approved on testnet (default)
  check("approved on testnet", (await pilotStatus(W)).approved);
  process.env.STELLAR_NETWORK = "mainnet";
  check("the SAME wallet is NOT approved on mainnet", !(await pilotStatus(W)).approved);
  check("and is rejected there", !(await enforcePilot(W)).ok);
  delete process.env.STELLAR_NETWORK;
  delete process.env.PILOT_MODE;
  clearKv();

  console.log("[9] the one email↔wallet join is bounded, and it is the only one");
  {
    const { store, ttls } = installFakeKv();
    const APPLICANT = "someone@example.test";
    await startPilotRequest(W, APPLICANT);
    check("the outcome mail still has an address to go to", (await getPilotEmail(W)) === APPLICANT);
    check(
      "it is written with a retention TTL, not forever",
      ttls.get(`pilot:testnet:email:${W}`) === PILOT_EMAIL_RETENTION_SECONDS,
      String(ttls.get(`pilot:testnet:email:${W}`)),
    );
    check(
      "no KEY NAME carries the address (the 'already applied' marker is hashed)",
      [...store.keys()].every((k) => !k.includes(APPLICANT) && !k.includes("@")),
    );
    check(
      "exactly ONE stored value is the address",
      [...store.values()].filter((v) => v === APPLICANT).length === 1,
    );
    await approvePilot(W);
    check("approval does not disturb it", (await getPilotEmail(W)) === APPLICANT);
    await revokePilot(W);
    check("revoking erases it", (await getPilotEmail(W)) === null);
    clearKv();
  }

  console.log("[10] the owner can list who is waiting without an inbox");
  {
    const kv = installFakeKv();
    process.env.STELLAR_NETWORK = "mainnet";
    await startPilotRequest(W, "one@example.com");
    await startPilotRequest(W2, "two@example.com");
    await approvePilot(W2);
    kv.store.set("pilot:testnet:status:GTESTNETONLY", "pending"); // the other network's queue
    const pending = await listPilot("pending");
    check("a pending wallet is listed with its contact flag", pending.length === 1 && pending[0]!.pubkey === W && pending[0]!.hasEmail);
    const approved = await listPilot("approved");
    check("an approved wallet is listed under approved", approved.length === 1 && approved[0]!.pubkey === W2);
    const all = await listPilot();
    check("the default lists every state on THIS network only", all.length === 2 && all.every((r) => r.pubkey !== "GTESTNETONLY"));
    kv.store.delete(`pilot:mainnet:email:${W}`);
    check("a contact that expired shows as unreachable", (await listPilot("pending"))[0]!.hasEmail === false);
    installFakeKv();
    check("an empty store lists nothing", (await listPilot()).length === 0);
    delete process.env.STELLAR_NETWORK;
    clearKv();
  }

  console.log("[11] the welcome mail says whether Resend took it, carries the warning word for word, and quotes the caps it is given");
  {
    const sent: string[] = [];
    let status = 200;
    globalThis.fetch = (async (_url: string | URL, init?: { body?: string }) => {
      sent.push(String(init?.body ?? ""));
      return { ok: status >= 200 && status < 300, status } as Response;
    }) as typeof fetch;
    delete process.env.RESEND_API_KEY;
    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    let notSent: boolean;
    let notSentDecline: boolean;
    try {
      notSent = (await notifyPilotApproved(W, "one@example.com")) === false;
      notSentDecline = (await notifyPilotRejected(W, "one@example.com")) === false;
    } finally {
      console.log = realLog;
    }
    check("no RESEND_API_KEY -> reported as not sent, nothing posted", notSent && notSentDecline && sent.length === 0);
    check(
      "and the log line names the wallet only, as /privacy says of a failed answer mail (never the email)",
      logged.length === 2 && logged.every((l) => l.includes(W) && !l.includes("one@example.com")),
      logged.join(" | "),
    );
    process.env.RESEND_API_KEY = "re_test";
    // The mainnet Worker's own numbers (wrangler.toml [env.mainnet.vars]).
    process.env.STELLAR_NETWORK = "mainnet";
    process.env.MAX_DROP_USDC = "5";
    process.env.MAX_DAY_USDC = "50";
    process.env.MAX_DAY_USDC_PER_SENDER = "25";
    check("Resend accepts -> reported as sent", (await notifyPilotApproved(W, "one@example.com")) === true);
    const mail = JSON.parse(sent[0] ?? "{}") as { subject?: string; text?: string; html?: string };
    // Written out here, not imported: the test pins the agreed wording, not whatever the module says.
    const WARNING = "Real money on Lumenia is an early pilot. It has not been reviewed by an outside security firm yet. You can lose money, so keep amounts small.";
    const CAPS = "$5 a link and up to $25 a day from you ($50 a day across the whole pilot)";
    check("the text and the HTML both carry the real-money warning word for word", !!mail.text?.includes(WARNING) && !!mail.html?.includes(WARNING), mail.text?.slice(0, 160));
    check(
      "the caps follow it in a sentence of their own, from MAX_DROP_USDC, MAX_DAY_USDC_PER_SENDER and MAX_DAY_USDC",
      !!mail.text?.includes(`Pilot limits: ${CAPS}.`) && mail.text!.indexOf(WARNING) < mail.text!.indexOf("Pilot limits:") && !!mail.html?.includes(CAPS),
      mail.text,
    );
    check("the preheader carries the short form", !!mail.html?.includes("Pilot limits: $5 a link, $25 a day."));
    check("no testnet default leaks into it ($100 a transfer, $1000 a day)", !sent[0]!.includes("$100") && !sent[0]!.includes("$1000"));
    check(
      "plain ASCII: no em or en dash and no curly quote in the subject, the text or the visible copy",
      [mail.subject ?? "", mail.text ?? "", WARNING, CAPS].every((s) => !/[\u2013\u2014\u2018\u2019\u201C\u201D]/.test(s)) && !/[\u2013\u2014\u2018\u2019\u201C\u201D]/.test(mail.html ?? ""),
      mail.subject,
    );
    // Without a per-sender cap tighter than the day's (testnet leaves it unset), the day cap is the one a sender meets.
    delete process.env.STELLAR_NETWORK;
    delete process.env.MAX_DAY_USDC;
    delete process.env.MAX_DAY_USDC_PER_SENDER;
    sent.length = 0;
    await notifyPilotApproved(W, "one@example.com");
    const plain = JSON.parse(sent[0] ?? "{}") as { text?: string };
    check("with no per-sender cap the mail quotes the link cap and the day's", !!plain.text?.includes("Pilot limits: $5 a link and up to $1000 a day across the whole pilot."), plain.text);
    status = 403; // e.g. an unverified RESEND_FROM sending to a real inbox
    check("Resend refuses -> reported as NOT sent (the CLI must not print \"emailed\")", (await notifyPilotApproved(W, "one@example.com")) === false);
    check("the decline mail follows the same contract", (await notifyPilotRejected(W, "one@example.com")) === false);
    const decline = JSON.parse(sent[sent.length - 1] ?? "{}") as { subject?: string; text?: string; html?: string };
    check("the decline mail is plain ASCII too", !/[\u2013\u2014\u2018\u2019\u201C\u201D]/.test(`${decline.subject}${decline.text}${decline.html}`), decline.text?.slice(0, 60));
    delete process.env.RESEND_API_KEY;
    delete process.env.MAX_DROP_USDC;
  }

  console.log("[approval links] a signed, per-wallet, expiring token — not the shared secret");
  process.env.PILOT_APPROVE_TOKEN = "test-owner-secret";
  const NOW = Date.parse("2026-08-08T12:00:00Z");
  const OTHER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
  const minted = (await mintApprovalToken("approve", W, NOW))!;
  check("a token is minted when a secret is configured", Boolean(minted?.token));
  check(
    "the minted token verifies for its own wallet + action",
    await verifyApprovalToken("approve", W, minted.token, String(minted.exp), NOW),
  );
  check(
    "it does NOT approve a DIFFERENT wallet (a leaked link is not a master key)",
    !(await verifyApprovalToken("approve", OTHER, minted.token, String(minted.exp), NOW)),
  );
  check(
    "it does NOT work for the other action (approve link cannot decline)",
    !(await verifyApprovalToken("reject", W, minted.token, String(minted.exp), NOW)),
  );
  check(
    "it expires",
    !(await verifyApprovalToken("approve", W, minted.token, String(minted.exp), NOW + 8 * 24 * 3600 * 1000)),
  );
  check(
    "an attacker cannot extend it by editing the exp in the URL",
    !(await verifyApprovalToken("approve", W, minted.token, String(minted.exp + 3600), NOW)),
  );
  check("a garbage token is refused", !(await verifyApprovalToken("approve", W, "nope", String(minted.exp), NOW)));
  check(
    "the raw shared secret is NOT itself a valid token (the old scheme is gone)",
    !(await verifyApprovalToken("approve", W, "test-owner-secret", String(minted.exp), NOW)),
  );
  delete process.env.PILOT_APPROVE_TOKEN;
  check("no secret configured → no token minted", (await mintApprovalToken("approve", W, NOW)) === null);

  console.log("[rate-limit keying] IPv6 collapses to its /64, so a caller cannot mint fresh IPs");
  check(
    "two addresses in one /64 share a bucket",
    ipBucket("2a02:0db8:1234:5678:0000:0000:0000:0001") === ipBucket("2a02:0db8:1234:5678:ffff:ffff:ffff:ffff"),
  );
  check(
    "a different /64 is a different bucket",
    ipBucket("2a02:0db8:1234:5678::1") !== ipBucket("2a02:0db8:1234:9999::1"),
  );
  check("the elided :: form collapses the same as the expanded one",
    ipBucket("2a02:db8:1234:5678::1") === ipBucket("2a02:db8:1234:5678:0:0:0:2"));
  check("IPv4 is untouched", ipBucket("203.0.113.9") === "203.0.113.9");
  // A route's own buckets are named AFTER the address is bucketed. Prepended to the address, the
  // prefix used to parse as the first IPv6 group, so "rec:" kept a /48 instead of a /64.
  check(
    "a route prefix goes after ipBucket: ip:<prefix><the /64>",
    rateLimitKeys("2a02:db8:1234:5678::1", undefined, { ipPrefix: "rec:" }).ip === "ip:rec:2a02:db8:1234:5678::/64",
    rateLimitKeys("2a02:db8:1234:5678::1", undefined, { ipPrefix: "rec:" }).ip,
  );
  check(
    "and the account side gets its own prefix: acct:<prefix><account>",
    rateLimitKeys("203.0.113.9", "GABC", { ipPrefix: "ps:", accountPrefix: "ps:" }).account === "acct:ps:GABC",
  );
  {
    const cfg = { ipCap: 2, ipWindowMs: 60_000, accountCap: 5, accountWindowMs: 60_000 };
    const t = Date.now();
    const v6 = (ip: string) => checkRateLimit(ip, undefined, cfg, t, { ipPrefix: "v6test:" }).limited;
    const firstTwo = [v6("2a02:db8:1:2::1"), v6("2a02:db8:1:2:ffff:ffff:ffff:ffff")];
    check("with a prefix, two addresses in one /64 share one bucket (the third ask is limited)", firstTwo.every((l) => !l) && v6("2a02:db8:1:2:aaaa::7"));
    check("and the next /64 is a bucket of its own", !v6("2a02:db8:1:3::1"));
  }

  /* ------------------------------------------------------------------------------------------
   * SOW 2, D3 (item c residuals, item i): the slot guard around a value handler, the approve link
   * tapped twice, the open answer when the pilot is retired, and the /health page.
   * ------------------------------------------------------------------------------------------ */
  console.log("[12] the pilot slot goes back only for a transaction that definitely did not happen");
  {
    const { store } = installFakeKv();
    process.env.PILOT_MODE = "1";
    process.env.STELLAR_NETWORK = "testnet";
    const used = () => Number(store.get(`pilot:testnet:tx:${W}`) ?? "0");
    await approvePilot(W);
    const plain = await withPilotSlot(W, async () => {
      throw new Error("anti-drain rejected the inner tx");
    }).then(() => "returned", (e: Error) => e.message);
    check("a handler that throws a plain error gives the slot back (the transaction never happened)", plain !== "returned" && used() === 0, `used ${used()}`);
    const undecided = await withPilotSlot(W, async () => {
      throw new SubmitUnconfirmedError("Horizon answered 504", "ab".repeat(32));
    }).then(() => "returned", (e: Error) => e.message);
    check("a handler that throws an UNCONFIRMED submit keeps the slot (the transaction may still land)", /submit unconfirmed/.test(undecided) && used() === 1, `used ${used()}`);
    const accepted = await withPilotSlot(W, async () => ({ hash: "cd".repeat(32), confirmed: false }));
    check("a handler that RETURNS {confirmed:false} keeps the slot too (nothing threw, nothing is released)", !!accepted && "confirmed" in accepted && used() === 2, `used ${used()}`);
    const landed = await withPilotSlot(W, async () => ({ hash: "ef".repeat(32), confirmed: true }));
    check("a confirmed transaction keeps its slot, as before", !!landed && used() === 3, `used ${used()}`);
    const notApproved = await withPilotSlot(W2, async () => "ran");
    check("an un-approved wallet is refused before the handler runs", typeof notApproved === "object" && "error" in notApproved);
    delete process.env.PILOT_MODE;
    const off = await withPilotSlot(W2, async () => "ran");
    check("with PILOT_MODE unset the guard is a no-op: the handler simply runs (the retirement switch, item i)", off === "ran");
    clearKv();
  }

  console.log("[13] the emailed Approve link, tapped twice, does not refill a wallet's budget");
  {
    const kvState = { failing: false };
    const { store } = installFakeKv({ failGets: () => kvState.failing });
    process.env.PILOT_MODE = "1";
    process.env.STELLAR_NETWORK = "testnet";
    process.env.PILOT_APPROVE_TOKEN = "an-approve-secret";
    process.env.SPONSOR_SECRET = Keypair.random().secret();
    process.env.USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    delete process.env.RESEND_API_KEY;
    const used = () => Number(store.get(`pilot:testnet:tx:${W}`) ?? "0");
    const minted = await mintApprovalToken("approve", W, Date.now());
    // Opening the emailed link only shows what it would do; the page's button POSTs the same fields.
    const openLink = () =>
      worker.fetch(new Request(`https://sponsor.test/pilot-approve?pubkey=${W}&token=${minted!.token}&exp=${minted!.exp}`), {});
    const tap = () => worker.fetch(ownerPost("/pilot-approve", W, minted!), {});
    const opened = await openLink();
    const page = await opened.text();
    check(
      "opening the link (GET) approves nothing: it shows a confirmation with a POST button",
      opened.status === 200 && /method="post"/.test(page) && /Approve this wallet\?/.test(page) && store.get(`pilot:testnet:appr:${W}`) !== "1",
      page.slice(0, 60),
    );
    const first = await tap();
    check("the first tap approves (200)", first.status === 200 && store.get(`pilot:testnet:appr:${W}`) === "1", String(first.status));
    for (let i = 0; i < 3; i++) await enforcePilot(W);
    check("the wallet then spends three of its slots", used() === 3, `used ${used()}`);
    const second = await tap();
    const body = await second.text();
    check("the second tap answers 'Already approved'", second.status === 200 && /Already approved/.test(body), body.slice(0, 80));
    check("and the three spent slots are still spent (approvePilot was not re-run)", used() === 3, `used ${used()}`);
    check("the wallet stays approved", store.get(`pilot:testnet:appr:${W}`) === "1");
    // A REVOKED wallet's still-valid link re-admits it: the check reads the allowlist flag, not
    // the status (a revoke used to leave status 'approved' and the link answered "Already approved").
    await revokePilot(W);
    const third = await tap();
    check("after a revoke, the same link re-admits the wallet", third.status === 200 && store.get(`pilot:testnet:appr:${W}`) === "1", String(third.status));
    check("and re-approval does NOT refill the slots it had spent (the counter is written with SET NX)", used() === 3, `used ${used()}`);
    const was = await resetPilotBudget(W);
    check("the owner's explicit reset is the one way to refill them, and says what was spent", was === 3 && used() === 0, `was ${was}, now ${used()}`);
    for (let i = 0; i < 3; i++) await enforcePilot(W);
    // A store that cannot answer the allowlist read: nothing is approved, and the page says so.
    await revokePilot(W);
    kvState.failing = true;
    const outage = await tap();
    kvState.failing = false;
    check("a failed allowlist read answers 503 and approves nothing", outage.status === 503 && store.get(`pilot:testnet:appr:${W}`) !== "1", String(outage.status));
    check("and the spent slots are untouched", used() === 3, `used ${used()}`);
    await approvePilot(W);
    const status = await worker.fetch(new Request(`https://sponsor.test/pilot-status?pubkey=${W}`), {});
    const st = (await status.json()) as { pilot: boolean; approved: boolean; state?: string };
    check("/pilot-status in pilot mode answers pilot:true for the approved wallet", st.pilot === true && st.approved === true, JSON.stringify(st));
    delete process.env.PILOT_MODE;
    const open = (await (await worker.fetch(new Request(`https://sponsor.test/pilot-status?pubkey=${W2}`), {})).json()) as { pilot: boolean; approved: boolean; state?: string };
    check("with PILOT_MODE unset /pilot-status answers {pilot:false, approved:true, state:'open'} for ANY wallet", open.pilot === false && open.approved === true && open.state === "open", JSON.stringify(open));
    const noKey = await worker.fetch(new Request("https://sponsor.test/pilot-status"), {});
    const noKeyBody = (await noKey.json()) as { pilot?: boolean; state?: string };
    check("and to a request with NO pubkey at all (a device with no account yet)", noKey.status === 200 && noKeyBody.pilot === false && noKeyBody.state === "open", JSON.stringify(noKeyBody));
    const burst: number[] = [];
    for (let i = 0; i < 40; i++) burst.push((await worker.fetch(new Request("https://sponsor.test/pilot-status"), {})).status);
    check("answered BEFORE the rate limiter: 40 asks in a row from one address are all 200 (the IP cap is 30)", burst.every((s) => s === 200), burst.filter((s) => s !== 200).join(","));
    process.env.PILOT_MODE = "1";
    const pilotNoKey = await worker.fetch(new Request("https://sponsor.test/pilot-status"), {});
    check("in pilot mode a missing pubkey is still a 400", pilotNoKey.status === 400);
    delete process.env.PILOT_MODE;
    delete process.env.PILOT_APPROVE_TOKEN;
    clearKv();
  }

  console.log("[14] /health names the signer, the account, the halt, the heartbeat and the day's budgets");
  {
    const { store } = installFakeKv();
    process.env.STELLAR_NETWORK = "testnet";
    process.env.PILOT_MODE = "1";
    store.set("watchdog:testnet:lastrun", new Date(Date.now() - 120_000).toISOString());
    store.set("sponsor:halt:testnet", "1");
    store.set("sponsor:halt:testnet:reason", "2026-10-07T18:00:00.000Z watchdog auto-halt: test");
    resetHaltCache(); // the kill switch caches its verdict for 5 s per isolate; [13] read it a moment ago
    resetHealthCache(); // and /health caches its store readings for 5 s the same way
    const res = await worker.fetch(new Request("https://sponsor.test/health"), {});
    const h = (await res.json()) as Record<string, any>;
    check("200 with ok:true", res.status === 200 && h.ok === true);
    check("signer.kind is 'env' here, and the public key is the account (no SPONSOR_ACCOUNT_ID set)", h.signer?.kind === "env" && h.signer?.publicKey === h.account && h.sponsorPublicKey === h.account, JSON.stringify(h.signer));
    check("pilotMode reflects PILOT_MODE", h.pilotMode === true);
    check("halt reports the store flag and its stored reason", h.halt?.halted === true && h.halt?.source === "store" && /auto-halt/.test(h.halt?.reason ?? ""), JSON.stringify(h.halt));
    check("watchdog.lastRun is the stamp and ageSeconds is about two minutes", typeof h.watchdog?.lastRun === "string" && h.watchdog?.ageSeconds >= 119 && h.watchdog?.ageSeconds <= 125, JSON.stringify(h.watchdog));
    check("alerting says what is missing", h.alerting?.configured === false && Array.isArray(h.alerting?.missing));
    check("fees carries the day, the spend, the budget and the fraction", typeof h.fees?.day === "string" && typeof h.fees?.maxXlm === "string" && "spentXlm" in h.fees && "used" in h.fees, JSON.stringify(h.fees));
    check("and the gross (every bid accepted today, never lowered by a give-back)", "grossXlm" in h.fees, JSON.stringify(h.fees));
    check("counters carries the day's escrow and account totals and their ceilings", typeof h.counters?.maxDayUsdc === "string" && typeof h.counters?.maxDayAccounts === "number" && "escrowUsdc" in h.counters && "accounts" in h.counters, JSON.stringify(h.counters));
    const text = JSON.stringify(h);
    check("no secret-shaped value anywhere in the page", !/S[A-Z2-7]{55}/.test(text) && !/Bearer|token|KEY_ID|arn:/i.test(text));
    // The readings are cached per isolate: a store change shows after the window, not per request,
    // so a GET loop on /health cannot turn into one store read per request.
    store.set("watchdog:testnet:lastrun", "2026-10-08T00:00:00.000Z");
    const cached = (await (await worker.fetch(new Request("https://sponsor.test/health"), {})).json()) as Record<string, any>;
    check("a second read inside 5 s serves the cached readings (the store change is not visible yet)", cached.watchdog?.lastRun === h.watchdog?.lastRun, String(cached.watchdog?.lastRun));
    resetHealthCache();
    const fresh = (await (await worker.fetch(new Request("https://sponsor.test/health"), {})).json()) as Record<string, any>;
    check("and a read after the window sees it", fresh.watchdog?.lastRun === "2026-10-08T00:00:00.000Z", String(fresh.watchdog?.lastRun));
    // The deployed version, from Cloudflare's version metadata binding (wrangler.toml [version_metadata]).
    check("without the version binding (a local run) /health has no version key", !("version" in h) && !("version" in fresh));
    const META = { id: "7bfebe3e-5c2f-4d0e-9a54-3d7a0c2e8f11", tag: "", timestamp: "2026-10-09T10:00:00.000Z", extra: "dropped" };
    const withVersion = (await (await worker.fetch(new Request("https://sponsor.test/health"), { CF_VERSION_METADATA: META })).json()) as Record<string, any>;
    check(
      "with the binding it reports exactly {id, tag, timestamp} (an empty tag as null, nothing else from the binding)",
      JSON.stringify(withVersion.version) === JSON.stringify({ id: META.id, tag: null, timestamp: META.timestamp }),
      JSON.stringify(withVersion.version),
    );
    const tagged = (await (await worker.fetch(new Request("https://sponsor.test/health"), { CF_VERSION_METADATA: { ...META, tag: "6b6b98c" } })).json()) as Record<string, any>;
    check("a deploy tagged with its commit shows the tag", tagged.version?.tag === "6b6b98c", JSON.stringify(tagged.version));
    delete process.env.PILOT_MODE;
    clearKv();
  }

  await pilotStatusChecks();
  await signedProofChecks();
  await signedOutcomeChecks();
  await legacyPathChecks();
  await answerMailChecks();
  await ownerCliChecks();

  console.log("\n============================================================");
  console.log(fail === 0 ? ` ✅ PILOT GUARD TESTS PASS (${pass}/${pass})` : ` ❌ ${fail} FAILURES (${pass} passed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}

/* ------------------------------------------------------------------------------------------
 * [15] /pilot-status (contract 3.1): revoked, an honest 503, and buckets of its own.
 * ------------------------------------------------------------------------------------------ */
async function pilotStatusChecks(): Promise<void> {
  console.log("[15] /pilot-status says revoked, answers 503 when it cannot check, and spends only its own buckets");
  const kvState = { failing: false };
  const { store } = installFakeKv({ failGets: () => kvState.failing });
  mainnetEnv();
  const status = async (pk: string, ip?: string) => asJson(await get(`/pilot-status?pubkey=${pk}`, ip));

  const A = Keypair.random().publicKey();
  await approvePilot(A);
  await revokePilot(A);
  const revoked = await status(A);
  check(
    "a revoked wallet reads {state:'rejected', approved:false, revoked:true}",
    revoked.status === 200 && revoked.json.pilot === true && revoked.json.state === "rejected" && revoked.json.approved === false && revoked.json.revoked === true,
    JSON.stringify(revoked.json),
  );
  const B = Keypair.random().publicKey();
  await approvePilot(B);
  await rejectPilot(B);
  const declined = await status(B);
  check("a declined wallet reads rejected with revoked:false", declined.json.state === "rejected" && declined.json.revoked === false, JSON.stringify(declined.json));
  await approvePilot(A);
  const back = await status(A);
  check("re-approving a revoked wallet clears revoked", back.json.state === "approved" && back.json.approved === true && back.json.revoked === false, JSON.stringify(back.json));
  await revokePilot(A);
  await rejectPilot(A);
  check("declining a revoked wallet leaves it plainly declined", (await status(A)).json.revoked === false);
  // A row from before revokePilot also wrote the status: "approved", with no allowlist flag behind it.
  const C = Keypair.random().publicKey();
  store.set(`pilot:mainnet:status:${C}`, "approved");
  const legacy = await status(C);
  check(
    "a legacy 'approved' status with no allowlist flag reads rejected and revoked, never approved",
    legacy.json.state === "rejected" && legacy.json.revoked === true && legacy.json.approved === false,
    JSON.stringify(legacy.json),
  );
  const none = await status(Keypair.random().publicKey());
  check(
    "a wallet that never asked reads {state:'none', approved:false, used:0, limit:5, revoked:false}",
    none.json.state === "none" && none.json.approved === false && none.json.used === 0 && none.json.limit === 5 && none.json.revoked === false,
    JSON.stringify(none.json),
  );
  kvState.failing = true;
  const down = await status(B);
  kvState.failing = false;
  check(
    "a store that does not answer is 503 'pilot store unavailable', never a 200 'not approved'",
    down.status === 503 && flatEq(down.json, { error: "pilot store unavailable" }),
    `${down.status} ${JSON.stringify(down.json)}`,
  );

  // The value routes' windows are not the status route's. Default limits from here (30 per IP, 5 per account).
  delete process.env.RATE_CAP;
  delete process.env.ACCOUNT_RATE_CAP;
  const IP = "203.0.113.60";
  const answers: number[] = [];
  for (let i = 0; i < 40; i++) answers.push((await status(Keypair.random().publicKey(), IP)).status);
  check(
    "40 status asks from one address are counted in their own bucket (rl:ip:ps:...)",
    [...store.keys()].some((k) => k.startsWith(`rl:ip:ps:${IP}:`)),
    `${answers.filter((s) => s === 429).length} of 40 were 429`,
  );
  check("and none of them in the value routes' per-IP bucket", ![...store.keys()].some((k) => k.startsWith(`rl:ip:${IP}:`)));
  const claim = await post("/v2-claim", { method: "nope", linkHex: "00", payout: Keypair.random().publicKey(), sigHex: "00" }, IP);
  check("so /v2-claim from that address is not a 429", claim.status !== 429, `${claim.status} ${JSON.stringify(claim.json)}`);
  const Wx = Keypair.random().publicKey();
  const IP2 = "203.0.113.61";
  for (let i = 0; i < 5; i++) await status(Wx, IP2);
  const counted = [...store.entries()].filter(([k]) => k.startsWith(`rl:acct:ps:${Wx}:`)).reduce((n, [, v]) => n + Number(v), 0);
  check("5 status asks for one wallet are counted under acct:ps:<wallet>", counted === 5, `counted ${counted}`);
  const deposit = await post("/v2-deposit", { xdr: "AAAA", senderPublicKey: Wx }, IP2);
  check("so /v2-deposit naming that wallet does not get the per-account 429", deposit.status !== 429, `${deposit.status} ${JSON.stringify(deposit.json)}`);
  clearMainnetEnv();
}

/* ------------------------------------------------------------------------------------------
 * [16] /pilot-request, SIGNED (contract 1 and 3.2): the proof and the inbox, before anything is written.
 * ------------------------------------------------------------------------------------------ */
async function signedProofChecks(): Promise<void> {
  console.log("[16] /pilot-request, signed: the account signs it, and the inbox is proven, before anything is written");
  const { store, mails } = installFakeKv();
  mainnetEnv();
  const ONES = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
  const GOLDEN =
    "lumenia-handle-pilot:v1:fb72704240c3527ba45904a8705865922f70a9c4f3c11bfa93c839f939945884:GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR:1760000000:0123456789abcdef:mainnet";
  const GOLDEN_SIG = "kZuq86B7rr9BIoSE0Mb2wqfQ2dgxLoRRVLRbT5JHnAvZuizmWtof0me3rY80wPHUfwA0XYWChj4FA8vtTEGnDg==";
  const built = handleProofMessage("pilot", await idForEmail("  Founder@Example.com "), ONES.publicKey(), 1760000000, "0123456789abcdef", "mainnet");
  check("the pilot message is the contract's golden string", built === GOLDEN, built.slice(0, 50));
  check(
    "and the golden signature verifies over it (and is what the test seed signs)",
    ONES.verify(Buffer.from(GOLDEN, "utf8"), Buffer.from(GOLDEN_SIG, "base64")) && ONES.sign(Buffer.from(GOLDEN, "utf8")).toString("base64") === GOLDEN_SIG,
  );

  const w1 = Keypair.random();
  const W1 = w1.publicKey();
  const w2 = Keypair.random();
  const stranger = Keypair.random();
  const E1 = "first@example.test";
  const BAD_PROOF = { error: "We couldn't confirm this account signed the request. Check your device clock and try again.", code: "bad-proof" };
  const nothingFor = (pk: string) => ![...store.keys()].some((k) => k.startsWith("pilot:mainnet:") && k.endsWith(pk));

  const flagged = await post("/pilot-request", { pubkey: W1, email: E1, owner: { pubkey: W1 } });
  check("an owner object with no signature in it is 401 bad-proof", flagged.status === 401 && flatEq(flagged.json, BAD_PROOF), JSON.stringify(flagged.json));
  const forged = await post("/pilot-request", { pubkey: W1, email: E1, owner: await pilotProof(stranger, E1, { pubkey: W1 }) });
  check("another key's signature over this wallet's message is 401 bad-proof (forged)", forged.status === 401 && flatEq(forged.json, BAD_PROOF));
  const otherKey = await post("/pilot-request", { pubkey: W1, email: E1, owner: await pilotProof(w2, E1) });
  check("a valid proof by ANOTHER account (owner.pubkey is not the asking wallet) is 401 bad-proof", otherKey.status === 401 && flatEq(otherKey.json, BAD_PROOF));
  const links = await post("/pilot-request", { pubkey: W1, email: E1, owner: await pilotProof(w1, E1, { action: "links" }) });
  check("a backup-write (`links`) proof is not a pilot proof", links.status === 401 && links.json.code === "bad-proof");
  const testnet = await post("/pilot-request", { pubkey: W1, email: E1, owner: await pilotProof(w1, E1, { network: "testnet" }) });
  check("a proof for the other network is refused", testnet.status === 401 && testnet.json.code === "bad-proof");
  const otherEmail = await post("/pilot-request", { pubkey: W1, email: E1, owner: await pilotProof(w1, "other@example.test") });
  check("a proof over a different email is refused", otherEmail.status === 401 && otherEmail.json.code === "bad-proof");
  const valid = await pilotProof(w1, E1);
  const noCode = await post("/pilot-request", { pubkey: W1, email: E1, owner: valid });
  check(
    "a good proof with no code and no backup row is 401 code-required",
    noCode.status === 401 && flatEq(noCode.json, { error: "Confirm your email with a code first.", code: "code-required" }),
    JSON.stringify(noCode.json),
  );
  const replayed = await post("/pilot-request", { pubkey: W1, email: E1, owner: valid, code: "123456" });
  check("the same proof a second time is 401 bad-proof (replayed)", replayed.status === 401 && replayed.json.code === "bad-proof");
  check(
    "none of that wrote anything for the wallet, or mailed the owner",
    nothingFor(W1) && !mails.some((m) => m.to?.[0] === OWNER),
    [...store.keys()].filter((k) => k.startsWith("pilot:")).join(","),
  );

  // The email is proven by the backup it protects: a row bound to this account, on this host's store.
  const w3 = Keypair.random();
  const W3 = w3.publicKey();
  const E3 = "backup@example.test";
  const e3Id = await idForEmail(E3);
  await putBox(e3Id, BOX, writeProof(w3, e3Id));
  const byBackup = await post("/pilot-request", { pubkey: W3, email: E3, owner: await pilotProof(w3, E3), src: "web" });
  check(
    "a backup row bound to this account proves the email: filed with no code",
    byBackup.status === 200 && flatEq(byBackup.json, { ok: true, state: "pending", filed: true }),
    JSON.stringify(byBackup.json),
  );
  const mail = mails.filter((m) => m.to?.[0] === OWNER).at(-1);
  check(
    "and the owner mail says so, and where it came from",
    !!mail?.text?.includes("Email confirmed by the backup it protects") && !!mail?.text?.includes("Asked from: the website"),
    mail?.text?.slice(0, 120),
  );

  const E2 = "second@example.test";
  const real = await pilotCode(mails, E2);
  const wrong = real === "000000" ? "111111" : "000000";
  const badCode = await post("/pilot-request", { pubkey: w2.publicKey(), email: E2, owner: await pilotProof(w2, E2), code: wrong });
  check(
    "a wrong code is 401 bad-code",
    badCode.status === 401 && flatEq(badCode.json, { error: "That code is wrong or has expired.", code: "bad-code" }),
    JSON.stringify(badCode.json),
  );
  check("and nothing was filed", nothingFor(w2.publicKey()));

  // The verify budget is the same per-email budget the backup codes spend: past it, the answer says so.
  const E4 = "budget@example.test";
  const w4 = Keypair.random();
  const realCode = await pilotCode(mails, E4);
  const miss = realCode === "000000" ? "111111" : "000000";
  for (let i = 0; i < 12; i++) await post("/pilot-request", { pubkey: w4.publicKey(), email: E4, owner: await pilotProof(w4, E4), code: miss });
  const spent = await post("/pilot-request", { pubkey: w4.publicKey(), email: E4, owner: await pilotProof(w4, E4), code: realCode });
  check("past the per-email verify budget even the right code is a 429 otp-budget", spent.status === 429 && spent.json.code === "otp-budget", JSON.stringify(spent.json));
  clearMainnetEnv();
}

/* ------------------------------------------------------------------------------------------
 * [17] /pilot-request, SIGNED: what each state answers, and which owner mails go out (contract 3.2).
 * ------------------------------------------------------------------------------------------ */
async function signedOutcomeChecks(): Promise<void> {
  console.log("[17] /pilot-request, signed: the answer per state, the owner mails, and the 409 and 503");
  const mailState = { status: 200, throws: false };
  const kvState = { failing: false };
  const { store, ttls, mails } = installFakeKv({
    failGets: () => kvState.failing,
    mailStatus: () => mailState.status,
    mailThrows: () => mailState.throws,
  });
  mainnetEnv();
  const ownerMails = () => mails.filter((m) => m.to?.[0] === OWNER);
  const ask = async (kp: Keypair, email: string, extra: Record<string, unknown> = {}) =>
    post("/pilot-request", { pubkey: kp.publicKey(), email, owner: await pilotProof(kp, email), ...extra });
  const askWithCode = async (kp: Keypair, email: string, src?: string) =>
    ask(kp, email, { code: await pilotCode(mails, email), ...(src ? { src } : {}) });

  const w1 = Keypair.random();
  const W1 = w1.publicKey();
  const w2 = Keypair.random();
  const W2 = w2.publicKey();
  const SHARED = "shared@example.test";
  const seenKey = `pilot:mainnet:seen:${await idForEmail(SHARED)}`;

  const first = await askWithCode(w1, SHARED, "ext");
  check("a first ask with a proven code: 200 {ok, state:'pending', filed:true}", first.status === 200 && flatEq(first.json, { ok: true, state: "pending", filed: true }), JSON.stringify(first.json));
  check(
    "the wallet is pending and its contact is kept 90 days",
    store.get(`pilot:mainnet:status:${W1}`) === "pending" && store.get(`pilot:mainnet:email:${W1}`) === SHARED && ttls.get(`pilot:mainnet:email:${W1}`) === NINETY_DAYS,
  );
  check("where it asked from is kept 90 days too", store.get(`pilot:mainnet:src:${W1}`) === "ext" && ttls.get(`pilot:mainnet:src:${W1}`) === NINETY_DAYS);
  check("the email's latest-wallet marker names it, for 90 days", store.get(seenKey) === W1 && ttls.get(seenKey) === NINETY_DAYS);
  const m1 = ownerMails().at(-1);
  check(
    "one owner mail: asked from the extension, email confirmed by a code",
    ownerMails().length === 1 && !!m1?.text?.includes("Asked from: the extension") && !!m1?.text?.includes("Email confirmed by a code"),
    m1?.text?.slice(0, 160),
  );
  check(
    "and the owner-mailed marker is set for 7 days",
    store.get(`pilot:mainnet:mailed:${W1}`) === "1" && ttls.get(`pilot:mainnet:mailed:${W1}`) === PILOT_MAILED_SECONDS && PILOT_MAILED_SECONDS === 604800,
  );
  check("the request mail's subject is plain ASCII", /^Pilot request - shared@example\.test \(mainnet\)$/.test(m1?.subject ?? ""), m1?.subject);

  // A second wallet with the same email, its inbox proven: filed, and nobody is left in the dark.
  const second = await askWithCode(w2, SHARED, "web");
  check(
    "another wallet asking with that email, code proven, is filed too (W2 pending)",
    second.status === 200 && second.json.state === "pending" && second.json.filed === true && store.get(`pilot:mainnet:status:${W2}`) === "pending",
    JSON.stringify(second.json),
  );
  check(
    "and hears which wallet asked with it before: emailAlsoFor = short(W1)",
    second.json.emailAlsoFor === shortAddress(W1) && shortAddress(W1) === `${W1.slice(0, 6)}...${W1.slice(-6)}`,
    String(second.json.emailAlsoFor),
  );
  const m2 = ownerMails().at(-1);
  check(
    "exactly one more owner mail, naming the first wallet and where it stands",
    ownerMails().length === 2 && !!m2?.text?.includes(`This email also asked for ${shortAddress(W1)} (pending).`),
    m2?.text?.slice(0, 200),
  );
  check("the marker now names the latest wallet", store.get(seenKey) === W2);

  // Proving your own inbox is not a way to file for somebody else's key.
  const victim = Keypair.random();
  const stranger = Keypair.random();
  const SE = "stranger@example.test";
  const forVictim = await post("/pilot-request", { pubkey: victim.publicKey(), email: SE, owner: await pilotProof(stranger, SE), code: await pilotCode(mails, SE) });
  check("a stranger with a proven inbox still cannot file for a victim's key (401 bad-proof)", forVictim.status === 401 && forVictim.json.code === "bad-proof");
  check("nothing was filed for the victim", !store.has(`pilot:mainnet:status:${victim.publicKey()}`) && ownerMails().length === 2);

  // A pending re-ask: the contact follows the ask, the owner is not mailed twice in a week.
  const RENAMED = "renamed@example.test";
  const reask = await askWithCode(w1, RENAMED);
  check(
    "a pending re-ask inside 7 days: {state:'pending', filed:false, already:true}",
    flatEq(reask.json, { ok: true, state: "pending", filed: false, already: true }),
    JSON.stringify(reask.json),
  );
  check("no new owner mail", ownerMails().length === 2);
  check("and the contact is now the email it asked with", (await getPilotEmail(W1)) === RENAMED && ttls.get(`pilot:mainnet:email:${W1}`) === NINETY_DAYS);
  store.delete(`pilot:mainnet:mailed:${W1}`); // seven days on
  const weekOn = await askWithCode(w1, RENAMED);
  check("a week on, the re-ask mails the owner again (filed:true, already:true)", weekOn.json.filed === true && weekOn.json.already === true && ownerMails().length === 3, JSON.stringify(weekOn.json));

  // A mail that did not go out is not counted: the next ask mails again at once.
  const w3 = Keypair.random();
  const FAILED = "failed-mail@example.test";
  const failedCode = await pilotCode(mails, FAILED);
  mailState.status = 500;
  const failed = await ask(w3, FAILED, { code: failedCode });
  mailState.status = 200;
  check("an ask whose owner mail was refused is still filed (200, pending, filed)", failed.status === 200 && failed.json.state === "pending" && failed.json.filed === true);
  check("and no marker records a mail that did not go out", !store.has(`pilot:mainnet:mailed:${w3.publicKey()}`));
  const retried = await askWithCode(w3, FAILED);
  check("so the next ask mails the owner at once (filed:true)", retried.json.filed === true && store.get(`pilot:mainnet:mailed:${w3.publicKey()}`) === "1", JSON.stringify(retried.json));

  // A mailer that throws: still 200, and exactly one log line with the wallet and the contact.
  const w4 = Keypair.random();
  const THROWS = "throws@example.test";
  const throwsCode = await pilotCode(mails, THROWS);
  mailState.throws = true;
  const thrown = await captureLogs(() => ask(w4, THROWS, { code: throwsCode }));
  mailState.throws = false;
  const requestLines = thrown.lines.filter((l) => l.startsWith("[pilot:request]"));
  check("a mailer that throws: the ask still answers 200, pending", thrown.result.status === 200 && thrown.result.json.state === "pending", JSON.stringify(thrown.result.json));
  check(
    "with exactly one log line naming the wallet and the contact",
    requestLines.length === 1 && requestLines[0] === `[pilot:request] mainnet wallet ${w4.publicKey()} ${THROWS} (mail failed)`,
    requestLines.join(" | "),
  );

  // Approved with every send used: the ask is for more sends, once a week.
  await approvePilot(W1);
  store.set(`pilot:mainnet:tx:${W1}`, "5");
  const before = ownerMails().length;
  const more = await askWithCode(w1, RENAMED);
  check("approved, 5 of 5 used: {state:'approved', filed:true, already:true}", flatEq(more.json, { ok: true, state: "approved", filed: true, already: true }), JSON.stringify(more.json));
  const mm = ownerMails().at(-1);
  check(
    "the owner mail asks for more sends, with what was used and the reset command",
    ownerMails().length === before + 1 && /^Pilot: more sends asked - /.test(mm?.subject ?? "") && !!mm?.text?.includes("Used: 5 of 5 sends") && !!mm?.text?.includes(`pilot reset ${W1}`),
    mm?.subject,
  );
  const moreAgain = await askWithCode(w1, RENAMED);
  check("a second ask that week mails nobody (filed:false)", moreAgain.json.filed === false && ownerMails().length === before + 1, JSON.stringify(moreAgain.json));
  await approvePilot(W2);
  const left = await askWithCode(w2, SHARED);
  check("approved with sends left: {state:'approved', filed:false, already:true}, no mail", flatEq(left.json, { ok: true, state: "approved", filed: false, already: true }) && ownerMails().length === before + 1, JSON.stringify(left.json));

  // A declined wallet's re-ask reopens nothing.
  await rejectPilot(w3.publicKey());
  const declined = await askWithCode(w3, FAILED);
  check(
    "a declined wallet's re-ask: {state:'rejected', filed:false, already:true}, no mail, still declined",
    flatEq(declined.json, { ok: true, state: "rejected", filed: false, already: true }) && ownerMails().length === before + 1 && store.get(`pilot:mainnet:status:${w3.publicKey()}`) === "rejected",
    JSON.stringify(declined.json),
  );

  // An email that backs up ANOTHER account: said only to a caller that proved the inbox.
  const w5 = Keypair.random();
  const BOUND = "bound-elsewhere@example.test";
  const boundId = await idForEmail(BOUND);
  await putBox(boundId, BOX, writeProof(w5, boundId));
  const taken = await askWithCode(w2, BOUND);
  check(
    "a proven code for an email whose backup is bound to another account: 409 email-taken",
    taken.status === 409 && flatEq(taken.json, { error: "That email backs up another Lumenia account. Ask with the email that backs up this one.", code: "email-taken" }),
    JSON.stringify(taken.json),
  );
  const unproven = await ask(w2, BOUND);
  check("without a code the same ask hears only code-required (nothing about whose it is)", unproven.status === 401 && unproven.json.code === "code-required");

  // A store that does not answer is not a refusal.
  const w6 = Keypair.random();
  const DOWN = "down@example.test";
  const downCode = await pilotCode(mails, DOWN);
  const signedProof = await pilotProof(w6, DOWN);
  kvState.failing = true;
  const down = await post("/pilot-request", { pubkey: w6.publicKey(), email: DOWN, owner: signedProof, code: downCode });
  const downLegacy = await post("/pilot-request", { pubkey: w6.publicKey(), email: DOWN });
  kvState.failing = false;
  const STORE_DOWN = { error: "We couldn't record that just now. Try again in a minute.", code: "store-unavailable" };
  check("a store that does not answer: 503 store-unavailable (signed)", down.status === 503 && flatEq(down.json, STORE_DOWN), `${down.status} ${JSON.stringify(down.json)}`);
  check("and on the legacy path too, instead of the old raw 400", downLegacy.status === 503 && flatEq(downLegacy.json, STORE_DOWN), `${downLegacy.status} ${JSON.stringify(downLegacy.json)}`);
  clearMainnetEnv();
}

/* ------------------------------------------------------------------------------------------
 * [18] /pilot-request, LEGACY (unsigned): the same answers, a collision no longer silent, the switch.
 * ------------------------------------------------------------------------------------------ */
async function legacyPathChecks(): Promise<void> {
  console.log("[18] /pilot-request, legacy: the same answers, a collision logged and mailed, PILOT_REQUIRE_PROOF");
  const { store, ttls, mails } = installFakeKv();
  mainnetEnv();
  const ownerMails = () => mails.filter((m) => m.to?.[0] === OWNER);
  const L1 = Keypair.random().publicKey();
  const L2 = Keypair.random().publicKey();
  const LEGACY = "legacy@example.test";
  const seenKey = `pilot:mainnet:seen:${await idForEmail(LEGACY)}`;

  const firstAsk = await post("/pilot-request", { pubkey: L1, email: LEGACY });
  check("a legacy first ask answers exactly {ok:true}", firstAsk.status === 200 && flatEq(firstAsk.json, { ok: true }), JSON.stringify(firstAsk.json));
  check("it is filed pending, and the marker is written with a 90-day expiry", store.get(`pilot:mainnet:status:${L1}`) === "pending" && store.get(seenKey) === L1 && ttls.get(seenKey) === NINETY_DAYS);
  const om = ownerMails().at(-1);
  check(
    "the owner mail says it came from an older page that confirms no email",
    !!om?.text?.includes("Asked from: an older page") && !!om?.text?.includes("Email not confirmed"),
    om?.text?.slice(0, 160),
  );
  const again = await post("/pilot-request", { pubkey: L1, email: LEGACY });
  check("a legacy re-ask answers exactly {ok:true, already:true}", flatEq(again.json, { ok: true, already: true }), JSON.stringify(again.json));

  const mailsBefore = ownerMails().length;
  const collision = await captureLogs(() => post("/pilot-request", { pubkey: L2, email: LEGACY }));
  const collisionLines = collision.lines.filter((l) => l.startsWith("[pilot:collision]"));
  check("a collision answers the ordinary {ok:true}: nothing to probe", flatEq(collision.result.json, { ok: true }), JSON.stringify(collision.result.json));
  check("it is still not recorded (an unsigned ask proves no inbox)", !store.has(`pilot:mainnet:status:${L2}`) && store.get(seenKey) === L1);
  check(
    "but it is exactly one log line naming both wallets",
    collisionLines.length === 1 && collisionLines[0] === `[pilot:collision] mainnet wallet ${L2} asked with an email already used by ${L1}; not recorded`,
    collisionLines.join(" | "),
  );
  const cm = ownerMails().at(-1);
  check(
    "and exactly one owner mail, naming the other wallet",
    ownerMails().length === mailsBefore + 1 && /^Pilot request not recorded - /.test(cm?.subject ?? "") && !!cm?.text?.includes(`This email also asked for ${shortAddress(L1)} (pending).`),
    cm?.subject,
  );
  const collisionAgain = await captureLogs(() => post("/pilot-request", { pubkey: L2, email: LEGACY }));
  check(
    "asking again logs again, but mails the owner no second time that week",
    collisionAgain.lines.filter((l) => l.startsWith("[pilot:collision]")).length === 1 && ownerMails().length === mailsBefore + 1,
  );

  check("missing fields: the unchanged 400", flatEq((await post("/pilot-request", { pubkey: L1 })).json, { error: "pubkey and email are required" }));
  check("a bad pubkey: the unchanged 400", flatEq((await post("/pilot-request", { pubkey: "GNOPE", email: LEGACY })).json, { error: "invalid pubkey" }));
  check("a bad email: the unchanged 400", flatEq((await post("/pilot-request", { pubkey: L1, email: "not-an-email" })).json, { error: "invalid email" }));

  process.env.PILOT_REQUIRE_PROOF = "1";
  const closed = await post("/pilot-request", { pubkey: Keypair.random().publicKey(), email: "closed@example.test" });
  delete process.env.PILOT_REQUIRE_PROOF;
  check(
    "with PILOT_REQUIRE_PROOF=1 an unsigned ask is 400 proof-required",
    closed.status === 400 && flatEq(closed.json, { error: "Reload the page and ask again.", code: "proof-required" }),
    JSON.stringify(closed.json),
  );

  // Revoking the wallet a marker names deletes the marker; another wallet's marker stays.
  const L3 = Keypair.random().publicKey();
  const KEEP = "keep@example.test";
  await post("/pilot-request", { pubkey: L3, email: KEEP });
  const keepKey = `pilot:mainnet:seen:${await idForEmail(KEEP)}`;
  await approvePilot(L1);
  await revokePilot(L1);
  check("revoking a wallet deletes the email marker that names it", !store.has(seenKey));
  await revokePilot(Keypair.random().publicKey());
  check("and a revoke of some other wallet leaves another email's marker alone", store.get(keepKey) === L3);
  clearMainnetEnv();
}

/* ------------------------------------------------------------------------------------------
 * [19] The answer mails name the account, and the owner's links confirm before they act (3.3, 3.4).
 * ------------------------------------------------------------------------------------------ */
async function answerMailChecks(): Promise<void> {
  console.log("[19] the approval and decline mails name the account; the owner links confirm before acting");
  const { store, mails } = installFakeKv();
  mainnetEnv();
  const ext = Keypair.random();
  const EXT = ext.publicKey();
  const web = Keypair.random();
  const WEB = web.publicKey();
  const EXT_MAIL = "ext-user@example.test";
  const WEB_MAIL = "web-user@example.test";
  for (const [kp, email, src] of [[ext, EXT_MAIL, "ext"], [web, WEB_MAIL, "web"]] as const) {
    const filed = await post("/pilot-request", { pubkey: kp.publicKey(), email, owner: await pilotProof(kp, email), code: await pilotCode(mails, email), src });
    if (filed.status !== 200) throw new Error(`could not file ${src}: ${JSON.stringify(filed.json)}`);
  }
  const to = (email: string) => mails.filter((m) => m.to?.[0] === email && !/^Your Lumenia code/.test(m.subject ?? ""));

  const approveExt = (await mintApprovalToken("approve", EXT, Date.now()))!;
  const opened = await get(`/pilot-approve?pubkey=${EXT}&exp=${approveExt.exp}&token=${approveExt.token}`);
  const page = await opened.text();
  check(
    "GET on the approve link changes nothing: a confirmation page with a POST form",
    opened.status === 200 && /<form method="post" action="\/pilot-approve">/.test(page) && store.get(`pilot:mainnet:appr:${EXT}`) !== "1" && to(EXT_MAIL).length === 0,
    page.slice(0, 80),
  );
  const approved = await worker.fetch(ownerPost("/pilot-approve", EXT, approveExt), {});
  check("POST from that page approves", approved.status === 200 && store.get(`pilot:mainnet:appr:${EXT}`) === "1");
  const am = to(EXT_MAIL).at(-1);
  const short = shortAddress(EXT);
  check(
    "the approval mail names the account, in the text and the HTML",
    !!am?.text?.includes(`This approval is for account ${short}.`) && !!am?.html?.includes(`This approval is for account ${short}.`),
    am?.text?.slice(0, 160),
  );
  check(
    "and says how many real-money links it can make",
    !!am?.text?.includes("You can make 5 real-money links from this account.") && !!am?.html?.includes("You can make 5 real-money links from this account."),
  );
  check("an extension ask gets the extension line", !!am?.text?.includes("Open the Lumenia extension and choose Real money."));
  check(
    "the button opens /account for THIS account (#for=<G>)",
    !!am?.text?.includes(`Switch to real money: https://getlumenia.com/account?switch=mainnet#for=${EXT}\n`) &&
      !!am?.html?.includes(`href="https://getlumenia.com/account?switch=mainnet#for=${EXT}"`),
  );
  const approveWeb = (await mintApprovalToken("approve", WEB, Date.now()))!;
  await worker.fetch(ownerPost("/pilot-approve", WEB, approveWeb), {});
  const wm = to(WEB_MAIL).at(-1);
  check(
    "a website ask's approval mail has no extension line",
    !!wm?.text?.includes(`This approval is for account ${shortAddress(WEB)}.`) && !wm?.text?.includes("Open the Lumenia extension"),
  );

  const rejectExt = (await mintApprovalToken("reject", EXT, Date.now()))!;
  const ask = await get(`/pilot-reject?pubkey=${EXT}&exp=${rejectExt.exp}&token=${rejectExt.token}`);
  const askPage = await ask.text();
  check(
    "GET on the decline link of an APPROVED wallet asks first, with what it has used",
    ask.status === 200 && askPage.includes("This wallet is approved for real money and has used 0 of 5 sends. Decline it anyway?") && askPage.includes("Decline anyway"),
    askPage.slice(0, 120),
  );
  check("and changes nothing", store.get(`pilot:mainnet:appr:${EXT}`) === "1" && store.get(`pilot:mainnet:status:${EXT}`) === "approved");
  const declined = await worker.fetch(ownerPost("/pilot-reject", EXT, rejectExt), {});
  check("POST declines it", declined.status === 200 && store.get(`pilot:mainnet:status:${EXT}`) === "rejected" && store.get(`pilot:mainnet:appr:${EXT}`) !== "1");
  const dm = to(EXT_MAIL).at(-1);
  check(
    "the decline mail's heading is 'Not approved for now' and it names the account",
    !!dm?.html?.includes(">Not approved for now</td>") && !!dm?.text?.includes(`This answer is for account ${short}.`),
    dm?.text?.slice(0, 120),
  );
  check(
    "its second paragraph is the contract's, and it never says 'still on the list'",
    !!dm?.text?.includes(
      "This isn't a no forever. If you'd like us to look again, reply to this email. In the meantime, practice mode is open: it's the exact same Lumenia with no real money and no wait.",
    ) && !/still on the list/i.test(`${dm?.text}${dm?.html}`),
  );
  const declineMails = to(EXT_MAIL).length;
  const twice = await worker.fetch(ownerPost("/pilot-reject", EXT, rejectExt), {});
  const twicePage = await twice.text();
  check(
    "declining it again: 'Already declined. No second email sent.', and no second mail",
    twice.status === 200 && twicePage.includes("Already declined. No second email sent.") && to(EXT_MAIL).length === declineMails,
  );

  process.env.SPONSOR_HALT = "1";
  resetHaltCache();
  const halted = [
    (await get(`/pilot-approve?pubkey=${WEB}&exp=${approveWeb.exp}&token=${approveWeb.token}`)).status,
    (await worker.fetch(ownerPost("/pilot-approve", WEB, approveWeb), {})).status,
    (await get(`/pilot-reject?pubkey=${EXT}&exp=${rejectExt.exp}&token=${rejectExt.token}`)).status,
    (await worker.fetch(ownerPost("/pilot-reject", EXT, rejectExt), {})).status,
  ];
  delete process.env.SPONSOR_HALT;
  resetHaltCache();
  check("the halt switch stops both links on both methods (503)", halted.every((s) => s === 503), halted.join(","));
  clearMainnetEnv();
}

/* ------------------------------------------------------------------------------------------
 * [20] The owner CLI's lines (cli/pilot.ts through lib/pilot-report.ts).
 * ------------------------------------------------------------------------------------------ */
async function ownerCliChecks(): Promise<void> {
  console.log("[20] the owner CLI: counts per state, where each asked from, and the no-account waitlist");
  const { store } = installFakeKv();
  process.env.STELLAR_NETWORK = "mainnet";
  const [P, A, D, R] = [0, 1, 2, 3].map(() => Keypair.random().publicKey()) as [string, string, string, string];
  store.set(`pilot:mainnet:status:${P}`, "pending");
  store.set(`pilot:mainnet:email:${P}`, "p@example.test");
  store.set(`pilot:mainnet:src:${P}`, "web");
  await approvePilot(A);
  store.set(`pilot:mainnet:src:${A}`, "ext");
  await approvePilot(D);
  await rejectPilot(D);
  await approvePilot(R);
  await revokePilot(R);
  const all = await listPilot("all");
  const lines = pilotListLines(all, "all", "mainnet");
  check(
    "the first line counts every state, a revoked wallet apart from a declined one",
    lines[0] === "mainnet pilot: 4 wallet(s): pending 1, approved 1, rejected 1, revoked 1, none 0",
    lines[0],
  );
  check(
    "each wallet's line says whether there is a contact and where it asked from",
    lines.some((l) => l.includes(P) && l.includes("email:yes") && l.includes("src:web")) && lines.some((l) => l.includes(A) && l.includes("src:ext")),
    lines.slice(2).join(" | "),
  );
  const revokedOnly = pilotListLines(all, "revoked", "mainnet");
  check(
    "'pilot list revoked' keeps only the revoked wallet",
    revokedOnly.length === 3 && revokedOnly[1] === '1 wallet(s) with state "revoked"' && !!revokedOnly[2]?.includes(R) && !!revokedOnly[2]?.includes("revoked"),
    revokedOnly.join(" | "),
  );
  await saveContact("pilot", "Zed@Example.test");
  await saveContact("pilot", "amy@example.test");
  await saveContact("waitlist", "someone-else@example.test");
  const wl = waitlistLines(await listContacts("pilot"));
  check(
    "'pilot waitlist' lists the no-account askers, sorted, and only them",
    wl.length === 3 && wl[0]!.startsWith("waitlist: 2 address(es)") && wl[1] === "  amy@example.test" && wl[2] === "  zed@example.test",
    wl.join(" | "),
  );
  const st = pilotStatusLines("mainnet", R, await pilotStatus(R), await getPilotSrc(R));
  check("'pilot status' prints revoked and src", st.includes("  revoked:  true") && st.includes("  src:      -"), st.join(" | "));
  const sa = pilotStatusLines("mainnet", A, await pilotStatus(A), await getPilotSrc(A));
  check("and an approved extension wallet reads revoked false, src ext", sa.includes("  revoked:  false") && sa.includes("  src:      ext"), sa.join(" | "));
  delete process.env.STELLAR_NETWORK;
  clearKv();
}

main().catch((e) => {
  console.error("💥", e);
  process.exit(1);
});
