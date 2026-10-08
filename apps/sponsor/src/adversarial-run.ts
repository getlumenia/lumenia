/**
 * adversarial-run: the scripted adversarial run against a sponsor Worker (SOW 2, D3 item j).
 *
 * It asks the sponsor for the things an open-internet caller would ask for and records whether
 * each one was refused, contained, or served: inflated fees on the Soroban relays, budget
 * exhaustion (per source, per day, the fee budget), junk claims and junk transactions against the
 * Horizon routes, the rate limits, and the halt switch. Every probe is a row in a JSON and a
 * markdown report, with the sponsor's XLM and USDC balance and the target's /health before and
 * after as the containment artifact.
 *
 * Two modes, and the rules are in code rather than in a checklist:
 *   --mode full          testnet, or a local `wrangler dev`: funds one throwaway sender from the
 *                        testnet faucet, makes one real deposit and one real reclaim, exhausts the
 *                        per-source onboarding share for real (handouts are never submitted, so no
 *                        reserve is locked), and, with --kv, pre-seeds the counters and flips the halt.
 *   --mode refusal-only  the live MAINNET Worker: nothing is funded, nothing that could land is
 *                        submitted, no counter is seeded; only refusals are asked for, and they cost
 *                        nothing. `--mode full` against a non-local mainnet target is refused here.
 *
 * A refusal is not proof by itself. Mainnet redacts its 400s to "request failed", which the Worker
 * also answers after the sponsor signed and the network said no, and a pilot Worker's allowlist
 * answers 403 before the guard a probe is named after ever runs. So every refusal probe sits inside
 * a fee window: /health's fees.spentXlm is read before the probes and 6 s after the last one (its
 * store readings are cached for 5 s), and because the sponsor charges the fee budget before every
 * signature, an unchanged total is what shows that nothing was signed. That total is net of the
 * bids the sponsor gives back when the network refuses a signed transaction while validating it,
 * so with --kv the window also reads the fake store's gross for the fee key, which no give-back
 * reduces; without it the report says the figure was net only. A probe the pilot gate answers
 * first is recorded as SKIP, not as a pass.
 *
 * A localhost URL proves nothing about which store the Worker behind it reads (a local proxy to the
 * live Worker is "local" too). With --kv the run first proves it: a nonce SET at
 * watchdog:<net>:lastrun in the fake store must come back as /health's watchdog.lastRun. Without
 * that proof the exhaustion and halt sections are refused, and so is full mode on mainnet.
 *
 * Every throwaway key, and the key of every link a probe deposits to, is written to
 * <out>/keys-<stamp>.json BEFORE it is funded or posted, and <out> must be a folder git ignores
 * (checked with `git check-ignore`; the seeds hold test funds and the repository is public). Any
 * deposit that may have landed, expected or not, is reclaimed before the run ends. The sponsor's
 * balance is read before every spend and the run stops past --budget-xlm. A run that stops early
 * still writes its report.
 *
 * RUN (the runs behind the evidence, and their results, are in evidence/SOW2_READINESS_REPORT.md
 * section D3.3; evidence/SOW2_OPS_NOTE.md has the deploys they wait for):
 *   pnpm --filter @lumenia/sponsor adversarial -- --target http://127.0.0.1:8787 --network testnet --mode full --kv http://127.0.0.1:8765
 *   pnpm --filter @lumenia/sponsor adversarial -- --target https://lumenia-sponsor.avakit.workers.dev --network testnet --mode full --rate-cap 300 --account-rate-cap 15
 *   pnpm --filter @lumenia/sponsor adversarial -- --target https://lumenia-sponsor-mainnet.avakit.workers.dev --network mainnet --mode refusal-only
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Claimant,
  Contract,
  Horizon,
  Keypair,
  MuxedAccount,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { USDC_ISSUERS, defaultHorizon, defaultSorobanRpc } from "./lib/config.js";
import { ipBucket } from "./lib/rate-limit.js";

/* ------------------------- run state (read by die() and the exit handler) ------------------------- */

/** Set once <out> is checked and the target is about to be asked: from then on every exit writes the report. */
let started = false;
let reported = false;
/** Why the run stopped before its end, when it did. */
let endNote = "";

function die(message: string): never {
  if (!endNote) endNote = message;
  console.error(`adversarial-run: ${message}`);
  process.exit(1);
}

/* --------------------------------- arguments --------------------------------- */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  // A flag with its value left out must not borrow the next flag as its value: `--budget-xlm --kv
  // <url>` once read "--kv" as the budget, which parsed to NaN and turned the spend stop off.
  if (value === undefined || value.startsWith("--")) die(`--${name} needs a value`);
  return value;
}
const has = (name: string) => process.argv.includes(`--${name}`);

/** This file's folder, and the default <out> found from it rather than from the cwd: under
 *  `pnpm --filter` the cwd is apps/sponsor, so the old cwd-relative default "apps/sponsor/adversarial-out"
 *  landed in apps/sponsor/apps/sponsor/adversarial-out, a folder no ignore rule covered. */
const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_OUT = fileURLToPath(new URL("../adversarial-out/", import.meta.url));

if (has("help") || process.argv.length <= 2) {
  console.log(
    [
      "adversarial-run: probe a sponsor Worker for the refusals that make an open mainnet safe.",
      "",
      "  --target <url>              the Worker (http://127.0.0.1:8787 for wrangler dev)",
      "  --network testnet|mainnet   cross-checked against the target's /health",
      "  --mode full|refusal-only    full funds a throwaway and exhausts budgets; refusal-only never spends",
      "  --kv <url>                  a fake Upstash store the target reads (cli/fake-kv.ts): enables the",
      "                              pre-seeded counters and the halt section once the target proves it",
      "                              reads it; never the production store",
      "  --budget-xlm <n>            stop when the sponsor's XLM dropped by more than this (default 20)",
      `  --out <dir>                 reports and keys; must be a folder git ignores (default ${DEFAULT_OUT});`,
      "                              a relative path is taken from the folder the command was typed in",
      "  --source-ip <ip>            sets cf-connecting-ip (only honoured by wrangler dev)",
      "  --rate-cap <n>              the target's per-IP cap per minute (default 30)",
      "  --account-rate-cap <n>      the target's per-account cap per minute (default 5)",
      "  --skip a,b,c,d,e            sections to skip",
    ].join("\n"),
  );
  process.exit(has("help") ? 0 : 1);
}

function wholeNumber(name: string, fallback: number): number {
  const raw = arg(name);
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n <= 0) die(`--${name} must be a positive whole number`);
  return n;
}

const TARGET = (arg("target") ?? "").replace(/\/$/, "");
const NETWORK = arg("network") as "testnet" | "mainnet";
const MODE = arg("mode") as "full" | "refusal-only";
const BUDGET_XLM = Number(arg("budget-xlm") ?? "20");
const KV = arg("kv")?.replace(/\/$/, "");
/** Where the command was typed: pnpm runs a package script from the package folder and keeps the
 *  caller's folder in INIT_CWD, so a relative --out means the same thing from either place. */
const CALLER_CWD = process.env.INIT_CWD ?? process.cwd();
const OUT = resolve(CALLER_CWD, arg("out") ?? DEFAULT_OUT);
const SOURCE_IP = arg("source-ip");
const RATE_CAP = wholeNumber("rate-cap", 30);
const ACCOUNT_RATE_CAP = wholeNumber("account-rate-cap", 5);
const SECTIONS = new Set(["a", "b", "c", "d", "e"]);
const SKIP = new Set(
  (arg("skip") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

if (!TARGET || !/^https?:\/\//.test(TARGET)) die("--target must be an http(s) url");
if (NETWORK !== "testnet" && NETWORK !== "mainnet") die("--network must be testnet or mainnet");
if (MODE !== "full" && MODE !== "refusal-only") die("--mode must be full or refusal-only");
if (!Number.isFinite(BUDGET_XLM) || BUDGET_XLM <= 0) die("--budget-xlm must be a positive number of XLM");
for (const s of SKIP) if (!SECTIONS.has(s)) die(`--skip takes the sections a,b,c,d,e; got "${s}"`);
if (KV !== undefined && !/^https?:\/\//.test(KV)) die("--kv must be an http(s) url");
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(TARGET);
if (NETWORK === "mainnet" && !LOCAL && MODE === "full") {
  die("full mode is refused against a live mainnet Worker: the exhaustion section locks real recipients out until UTC midnight. Use --mode refusal-only.");
}
if (NETWORK === "mainnet" && !LOCAL && KV) die("--kv against a live mainnet Worker makes no sense: the live Worker reads its own store, never yours");
if (NETWORK === "mainnet" && MODE === "full" && !KV) {
  die("full mode on mainnet needs --kv and the target's proof that it reads it: a localhost URL can front the live Worker, whose onboarding counters and key the exhaustion section would spend");
}

const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const PASSPHRASE = NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
const HORIZON = new Horizon.Server(defaultHorizon(NETWORK));
const RPC = new rpc.Server(defaultSorobanRpc(NETWORK));
const USDC = new Asset("USDC", USDC_ISSUERS[NETWORK]);
const STROOPS = 10_000_000n;
/** A probe deposit's own validity, kept shorter than its escrow expiry plus the reclaim wait: by
 *  the time the reclaim runs, a deposit that answered 202 has either landed or can never land. */
const DEPOSIT_TIMEOUT_S = 60;
const DEPOSIT_EXPIRY_S = 150;
/** The halt verdict and /health's store readings are cached up to 5 s per isolate. */
const CACHE_MS = 5_000;
const QUIET_MS = CACHE_MS + 1_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ---------------------------------- recording ---------------------------------- */

interface Row {
  section: string;
  probe: string;
  expected: string;
  got: string;
  status: "PASS" | "FAIL" | "SKIP";
  reason?: string;
}
const rows: Row[] = [];
function record(section: string, probe: string, expected: string, got: string, ok: boolean | null, reason?: string): void {
  const status: Row["status"] = ok === null ? "SKIP" : ok ? "PASS" : "FAIL";
  rows.push({ section, probe, expected, got, status, reason });
  console.log(`  ${status === "PASS" ? "ok  " : status === "SKIP" ? "skip" : "FAIL"} [${section}] ${probe} -> ${got}${reason ? ` (${reason})` : ""}`);
}

interface Reply {
  status: number;
  text: string;
  json: Record<string, unknown> | null;
  ms: number;
}

/** When the last request to the target finished: /health is read only after QUIET_MS without one. */
let lastCallAt = 0;

async function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<Reply> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 95_000);
  try {
    const res = await fetch(`${TARGET}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(SOURCE_IP ? { "cf-connecting-ip": SOURCE_IP } : {}),
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text) as unknown;
      json = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    return { status: res.status, text, json, ms: Date.now() - t0 };
  } catch (e) {
    // No answer is an answer too (status 0): a probe that could not be asked is a FAIL row, never a
    // crash that leaves the rest of the run unasked.
    return { status: 0, text: `no answer: ${(e as Error).message}`, json: null, ms: Date.now() - t0 };
  } finally {
    clearTimeout(t);
    lastCallAt = Date.now();
  }
}

/** A refusal: 400 or 403 (never a 5xx, never a 2xx). On mainnet most 400s read "request failed". */
const refused = (r: Reply) => r.status === 400 || r.status === 403;
const says = (r: Reply, re: RegExp) => re.test(r.text);
const short = (r: Reply) => `${r.status} ${r.text.replace(/\s+/g, " ").slice(0, 110)}`;
const hashOf = (r: Reply) => (typeof r.json?.hash === "string" ? r.json.hash : null);

interface Verdict {
  refused: boolean;
  note: string;
}

/**
 * How a refusal probe reads its reply: refused by the guard it is named after (`re` is that guard's
 * own words), or, on mainnet, refused with the redacted "request failed", which is inconclusive on
 * its own and becomes proof only together with an unchanged fee budget (see refusalWindow).
 */
function refusedBy(re: RegExp, guard: string): (r: Reply) => Verdict {
  return (r) => {
    if (r.status === 0) return { refused: false, note: r.text };
    if (r.status === 429) return { refused: false, note: "the rate limiter answered, not the guard under test" };
    if (!refused(r)) return { refused: false, note: `not refused (${r.status})` };
    if (says(r, /submit failed|submit unconfirmed|send failed/)) return { refused: false, note: "it reached the network: the guard let it through" };
    if (says(r, re)) return { refused: true, note: `refused by ${guard}` };
    if (NETWORK === "mainnet" && says(r, /request failed/)) return { refused: true, note: "the reason is redacted on mainnet" };
    return { refused: false, note: `refused, but not by ${guard}` };
  };
}

/* ------------------------------------ chain ------------------------------------ */

async function balances(account: string): Promise<{ xlm: string; usdc: string } | null> {
  try {
    const acc = await HORIZON.loadAccount(account);
    const xlm = acc.balances.find((b) => b.asset_type === "native")?.balance ?? "0";
    const usdc =
      (acc.balances.find((b) => "asset_code" in b && b.asset_code === "USDC" && "asset_issuer" in b && b.asset_issuer === USDC.getIssuer()) as { balance?: string } | undefined)
        ?.balance ?? "0";
    return { xlm, usdc };
  } catch {
    return null;
  }
}

const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const u64 = (n: number) => nativeToScVal(BigInt(n), { type: "u64" });
const addr = (g: string) => Address.fromString(g).toScVal();
const linkHexOf = (kp: Keypair) => Buffer.from(kp.rawPublicKey()).toString("hex");
const expiryIn = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

/** A sender-sourced deposit invoke, built in memory with the given sequence and classic fee. */
function buildDeposit(opts: { sender: Keypair; sequence: string; fee: string; link: Keypair; amount: bigint; expiry: number; contract: string }): Transaction {
  return new TransactionBuilder(new Account(opts.sender.publicKey(), opts.sequence), { fee: opts.fee, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(opts.contract).call("deposit", addr(opts.sender.publicKey()), xdr.ScVal.scvBytes(Buffer.from(opts.link.rawPublicKey())), i128(opts.amount), u64(opts.expiry)))
    .setTimeout(DEPOSIT_TIMEOUT_S)
    .build();
}

/** reclaim(link): the contract takes the link alone and checks the recorded sender's auth (lib.rs). */
function buildReclaim(opts: { sender: Keypair; sequence: string; fee: string; linkHex: string; contract: string }): Transaction {
  return new TransactionBuilder(new Account(opts.sender.publicKey(), opts.sequence), { fee: opts.fee, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(opts.contract).call("reclaim", xdr.ScVal.scvBytes(Buffer.from(opts.linkHex, "hex"))))
    .setTimeout(300)
    .build();
}

/** Simulate and assemble a Soroban invoke the way the web does, so its fee is classic + resource. */
async function assembled(tx: Transaction): Promise<{ tx: Transaction; minResourceFee: number } | { error: string }> {
  try {
    const sim = await RPC.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) return { error: sim.error };
    return { tx: rpc.assembleTransaction(tx, sim).build(), minResourceFee: Number.parseInt(sim.minResourceFee, 10) };
  } catch (e) {
    return { error: `the local simulation did not answer: ${(e as Error).message}` };
  }
}

/**
 * Wait until the sender's sequence reaches `atLeast` (a transaction it submitted has landed), or
 * give up after about 30 s: the next transaction is built on a fresh load either way, and a load
 * that still shows the old sequence would build one the network refuses as a stale sequence.
 */
async function awaitSequence(account: string, atLeast: bigint): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      if (BigInt((await HORIZON.loadAccount(account)).sequenceNumber()) >= atLeast) return;
    } catch {
      /* Horizon blinked; ask again */
    }
    await sleep(1_500);
  }
}

/* ------------------------------------ state ------------------------------------ */

interface Health {
  network?: string;
  account?: string;
  sponsorPublicKey?: string;
  contract?: string | null;
  pilotMode?: boolean;
  signer?: { kind?: string; publicKey?: string };
  halt?: { halted?: boolean; source?: string | null; reason?: string | null };
  watchdog?: { lastRun?: string | null; lastFullRun?: string | null; ageSeconds?: number | null };
  /** The day's bids before any give-back (D3 /health serves it; an older Worker does not, so read when present). */
  fees?: { day?: string; spentXlm?: string | null; grossXlm?: string | null; maxXlm?: string; used?: number | null };
  counters?: { day?: string; escrowUsdc?: string | null; accounts?: number | null; maxDayUsdc?: string; maxDayAccounts?: number; maxDaySourceAccounts?: number };
}

let health: Health = {};
let closingHealth: Health | null = null;
let sponsorAccount = "";
let contract = "";
const keys: Record<string, { publicKey: string; secret: string; purpose: string }> = {};
let before: { xlm: string; usdc: string } | null = null;
let after: { xlm: string; usdc: string } | null = null;
let budgetStartXlm: number | null = null;
let storeProof: { ok: boolean; detail: string } | null = null;

function keysPath(): string {
  return resolve(OUT, `keys-${STAMP}.json`);
}
function saveKeys(): void {
  writeFileSync(keysPath(), `${JSON.stringify({ network: NETWORK, target: TARGET, keys }, null, 2)}\n`, { mode: 0o600 });
}

/** Refuse a key file git would track: the seeds hold test funds, and this repository is public. */
function assertGitignored(path: string): void {
  try {
    // From this file's folder, so the check consults this repository whatever folder the command
    // was typed in; a path outside it fails the check too.
    execFileSync("git", ["check-ignore", "-q", path], { cwd: SCRIPT_DIR, stdio: "ignore" });
  } catch {
    die(`refusing to write keys to ${path}: git does not ignore it (use a folder .gitignore covers, such as apps/sponsor/adversarial-out/)`);
  }
}

async function budgetGuard(where: string): Promise<void> {
  const now = await balances(sponsorAccount);
  // An unreadable balance used to let the step through, which turned the stop off exactly when it
  // could not see: a step that can spend now needs a balance to measure against.
  if (!now || budgetStartXlm === null) {
    die(`the sponsor's balance is unreadable before ${where}, so --budget-xlm cannot be enforced; nothing more is spent`);
  }
  const spent = budgetStartXlm - Number.parseFloat(now.xlm);
  if (spent > BUDGET_XLM) die(`budget exceeded before ${where}: the sponsor spent ${spent.toFixed(4)} XLM, the budget is ${BUDGET_XLM}`);
}

/** Read /health. worker.ts meters no /health request, so a 429 can only come from in front of the Worker (a Cloudflare rule): wait a minute, once. */
async function getHealth(): Promise<Health | null> {
  let r = await call("/health", { timeoutMs: 20_000 });
  if (r.status === 429) {
    console.log("  /health answered 429; waiting out its minute");
    await sleep(61_000);
    r = await call("/health", { timeoutMs: 20_000 });
  }
  return r.status === 200 && r.json ? (r.json as Health) : null;
}

/** /health after QUIET_MS without a request, so its cached reading is newer than anything we sent. */
async function freshHealth(): Promise<Health | null> {
  await sleep(Math.max(0, lastCallAt + QUIET_MS - Date.now()));
  return getHealth();
}

/* --------------------------------- the fee window --------------------------------- */

interface FeeReading {
  day: string | null;
  /** /health fees.spentXlm: NET of the bids the sponsor gave back after a validation refusal. */
  spent: bigint | null;
  raw: string | null;
  /** Every bid charged today, nothing given back; null when no source of it was readable. */
  gross: bigint | null;
  grossFrom: string | null;
}

function xlmToStroops(s: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(s.trim());
  if (!m) return null;
  return BigInt(m[1]!) * STROOPS + BigInt((m[2] ?? "").padEnd(7, "0"));
}

/** The fake store's gross for a key (cli/fake-kv.ts `/__gross`), or null when it cannot say. */
async function kvGross(key: string): Promise<bigint | null> {
  try {
    const r = await fetch(`${KV}/__gross/${encodeURIComponent(key)}`, { headers: { authorization: "Bearer local" } });
    const body = (await r.json()) as { result?: unknown };
    return typeof body.result === "string" && /^\d+$/.test(body.result) ? BigInt(body.result) : null;
  } catch {
    return null;
  }
}

/**
 * The fee budget as /health reports it, plus a GROSS figure when one can be had. The net total is
 * not enough on its own: the sponsor gives a bid back when the network refuses a signed transaction
 * while validating it, which is how a junk transaction from a key that has no account ends, so a
 * probe that got past every guard and was signed can leave spentXlm exactly where it was. The gross
 * comes from the fake store when the target proved it reads it, else from /health fees.grossXlm.
 */
async function feeReading(): Promise<FeeReading> {
  const h = await freshHealth();
  const raw = typeof h?.fees?.spentXlm === "string" ? h.fees.spentXlm : null;
  const day = h?.fees?.day ?? null;
  let gross: bigint | null = null;
  let grossFrom: string | null = null;
  if (KV && storeProof?.ok && day) {
    gross = await kvGross(`caps:${NETWORK}:fees:${day}`);
    if (gross !== null) grossFrom = "the fake store's gross";
  }
  if (gross === null && typeof h?.fees?.grossXlm === "string") {
    gross = xlmToStroops(h.fees.grossXlm);
    if (gross !== null) grossFrom = "/health fees.grossXlm";
  }
  return { day, spent: raw === null ? null : xlmToStroops(raw), raw, gross, grossFrom };
}

/** Was nothing charged against the fee budget between two readings? An unreadable total shows nothing. */
function feeUnchanged(a: FeeReading, b: FeeReading): { unchanged: boolean; detail: string; netOnly?: boolean } {
  const others = LOCAL ? "" : "; on a Worker with other traffic it can be someone else's: run it again in a quiet window";
  if (a.spent === null || b.spent === null) {
    return { unchanged: false, detail: `fees.spentXlm unreadable (${String(a.raw)} -> ${String(b.raw)}): nothing shows the probes were refused before a signature` };
  }
  if (a.day !== b.day) return { unchanged: false, detail: `the UTC day rolled over between the readings (${String(a.day)} -> ${String(b.day)}); run it again` };
  const haveGross = a.gross !== null && b.gross !== null && a.grossFrom === b.grossFrom;
  if (haveGross && b.gross! > a.gross!) {
    return { unchanged: false, detail: `${b.gross! - a.gross!} stroops charged during the probes (${a.grossFrom}): a probe got past every guard to the fee charge, the step before the signature, whatever was given back (fees.spentXlm ${a.raw} -> ${b.raw})${others}` };
  }
  if (b.spent > a.spent) {
    return { unchanged: false, detail: `fees.spentXlm ${a.raw} -> ${b.raw}: something was charged, so a probe got past every guard to the fee charge, the step before the signature${others}` };
  }
  if (b.spent < a.spent) return { unchanged: false, detail: `fees.spentXlm went down (${a.raw} -> ${b.raw}): the store was reset during the probes; run it again` };
  return haveGross
    ? { unchanged: true, detail: `fees.spentXlm ${a.raw} -> ${b.raw}; nothing charged (${a.grossFrom})` }
    : { unchanged: true, netOnly: true, detail: `fees.spentXlm ${a.raw} -> ${b.raw} (net only: a bid given back after a validation refusal would not show; a gross needs --kv, or /health fees.grossXlm)` };
}

interface RefusalProbe {
  probe: string;
  expected: string;
  send: () => Promise<Reply>;
  judge: (r: Reply) => Verdict;
}

/**
 * Send refusal probes between two fee readings and record each one: PASS only when it was refused
 * the way it should be AND nothing was charged. The sponsor charges the budget after every guard
 * and before every signature (lib/caps.ts chargeSponsorFee), so no charge is what turns a redacted
 * "request failed" into "refused before anything was signed"; with a gross figure (see
 * feeReading) that holds even for a charge the sponsor later gave back. A probe that could not be
 * built has `send` return its own status-0 reply.
 */
async function refusalWindow(section: string, probes: RefusalProbe[]): Promise<Reply[]> {
  if (probes.length === 0) return [];
  const a = await feeReading();
  const replies: Reply[] = [];
  for (const p of probes) {
    const r = await p.send();
    replies.push(r);
    console.log(`  sent [${section}] ${p.probe} -> ${short(r)}`);
  }
  const b = await feeReading();
  const fee = feeUnchanged(a, b);
  probes.forEach((p, i) => {
    const r = replies[i]!;
    const v = p.judge(r);
    const kept = fee.netOnly ? "nothing counted against the fee budget (net only: see the fee-budget row)" : "nothing charged against the fee budget";
    const reason = v.refused ? `${v.note}; ${fee.unchanged ? kept : fee.detail}` : v.note;
    record(section, p.probe, p.expected, short(r), v.refused && fee.unchanged, reason);
  });
  record(section, `the fee budget across the ${probes.length} probe(s) above`, "nothing charged: fees.spentXlm (and the gross, when readable) unchanged 6 s after the last probe", fee.detail, fee.unchanged);
  return replies;
}

/* --------------------------------- the fake store --------------------------------- */

async function kvGet(key: string): Promise<string | null> {
  const r = await fetch(`${KV}/get/${encodeURIComponent(key)}`, { headers: { authorization: "Bearer local" } });
  const body = (await r.json()) as { result?: unknown };
  return body.result == null ? null : String(body.result);
}
async function kvSet(key: string, value: string): Promise<void> {
  await fetch(`${KV}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`, { method: "POST", headers: { authorization: "Bearer local" } });
}
async function kvDel(key: string): Promise<void> {
  await fetch(`${KV}/del/${encodeURIComponent(key)}`, { method: "POST", headers: { authorization: "Bearer local" } });
}

/**
 * The fake store must be the CURRENT cli/fake-kv.ts. A process started before its last rewrite
 * keeps answering, but with no gross and the old handling of the fenced slot release, and runs
 * against such a process once produced evidence about a store the sponsor no longer talks to the
 * same way. Two increments in, one given back: only the current store answers a gross of 2.
 */
async function proveStoreCurrent(): Promise<{ ok: boolean; detail: string }> {
  const key = `adversarial:gross-probe:${STAMP}`;
  try {
    await fetch(`${KV}/pipeline`, {
      method: "POST",
      headers: { authorization: "Bearer local", "content-type": "application/json" },
      body: JSON.stringify([["INCRBY", key, "2"], ["INCRBY", key, "-1"]]),
    });
    const gross = await kvGross(key);
    await kvDel(key);
    return { ok: gross === 2n, detail: `INCRBY +2 then -1 on ${key}; /__gross answered ${gross === null ? "nothing readable" : gross.toString()}` };
  } catch (e) {
    return { ok: false, detail: `the fake store at ${KV} did not answer: ${(e as Error).message}` };
  }
}
const today = () => new Date().toISOString().slice(0, 10);

/**
 * The locality proof: SET a nonce where the watchdog writes its heartbeat, in the fake store, and
 * require the target's /health to echo it. Only a Worker that reads THIS store can, so a localhost
 * URL fronting the live Worker (and its production counters and key) fails here, before any
 * exhaustion or halt probe. The previous value is put back.
 */
async function proveStoreLocality(): Promise<{ ok: boolean; detail: string }> {
  const key = `watchdog:${NETWORK}:lastrun`;
  let saved: string | null;
  try {
    saved = await kvGet(key);
  } catch (e) {
    return { ok: false, detail: `the fake store at ${KV} did not answer: ${(e as Error).message}` };
  }
  // A canonical ISO stamp, the shape the watchdog writes, from 2001 so no reader takes it for a
  // fresh heartbeat, and random so nothing but a read of this store can produce it.
  const nonce = new Date(Date.UTC(2001, 0, 1) + Math.floor(Math.random() * 365 * 86_400_000)).toISOString();
  try {
    await kvSet(key, nonce);
    const h = await freshHealth();
    const echoed = h?.watchdog?.lastRun ?? null;
    return { ok: echoed === nonce, detail: `set ${key} = ${nonce}; /health watchdog.lastRun = ${String(echoed)}` };
  } catch (e) {
    return { ok: false, detail: `the fake store at ${KV} did not answer: ${(e as Error).message}` };
  } finally {
    try {
      if (saved === null) await kvDel(key);
      else await kvSet(key, saved);
    } catch {
      /* the store went away; nothing of ours is left in it to matter */
    }
  }
}

/* ------------------------------------ deposits ------------------------------------ */

const VALUE_ROUTES = ["/create-account", "/feebump", "/send-link", "/payout", "/sweep", "/v2-claim", "/v2-deposit", "/v2-reclaim", "/faucet", "/demo-link", "/cctp-relay"];
const GRANT_ROUTES = ["/pilot-approve", "/pilot-reject"];

/** The throwaway sender, funded in full mode. */
let sender: Keypair | null = null;

/** Every deposit a probe posts, so any that may have landed is reclaimed (sectionReclaim). */
interface Deposit {
  name: string;
  purpose: string;
  link: Keypair;
  expiry: number;
  hash: string | null;
  outcome: "not sent" | "landed" | "unconfirmed" | "refused" | "unknown";
  reclaim?: string;
}
const deposits: Deposit[] = [];

/** A fresh link for a deposit probe, written to the keys file BEFORE the deposit is posted. */
function trackDeposit(name: string, purpose: string): Deposit {
  const link = Keypair.random();
  const expiry = expiryIn(DEPOSIT_EXPIRY_S);
  keys[name] = { publicKey: link.publicKey(), secret: link.secret(), purpose: `${purpose}; link key, escrow expiry ${new Date(expiry * 1000).toISOString()}` };
  saveKeys();
  const d: Deposit = { name, purpose, link, expiry, hash: null, outcome: "not sent" };
  deposits.push(d);
  return d;
}

/** What a deposit's answer says about its money: 200 landed, 202 may still land, a refusal moved nothing. */
async function settleDeposit(d: Deposit, r: Reply, builtFrom: string): Promise<void> {
  d.hash = hashOf(r);
  if (r.status === 200 && d.hash) d.outcome = "landed";
  else if (r.status === 202) d.outcome = "unconfirmed";
  else if (refused(r) || r.status === 429 || r.status === 503) d.outcome = "refused";
  else d.outcome = "unknown";
  if ((d.outcome === "landed" || d.outcome === "unconfirmed") && sender) await awaitSequence(sender.publicKey(), BigInt(builtFrom) + 1n);
}

/* ------------------------------------ sections ------------------------------------ */

async function onboardSender(): Promise<boolean> {
  await budgetGuard("onboarding the throwaway sender");
  sender = Keypair.random();
  keys.sender = { publicKey: sender.publicKey(), secret: sender.secret(), purpose: "throwaway sender: one 0.2 USDC deposit and its reclaim" };
  saveKeys(); // BEFORE anything is funded
  console.log(`  throwaway sender ${sender.publicKey()} written to ${keysPath()} before funding`);
  const created = await call("/create-account", { body: { recipientPublicKey: sender.publicKey() } });
  if (created.status !== 200 || !created.json?.xdr) {
    record("setup", "onboard the throwaway sender", "200 sandwich", short(created), false);
    sender = null;
    return false;
  }
  const sandwich = TransactionBuilder.fromXDR(String(created.json.xdr), PASSPHRASE) as Transaction;
  sandwich.sign(sender);
  try {
    await HORIZON.submitTransaction(sandwich);
  } catch (e) {
    record("setup", "submit the onboarding sandwich", "accepted", (e as Error).message.slice(0, 120), false);
    sender = null;
    return false;
  }
  const faucet = await call("/faucet", { body: { recipientPublicKey: sender.publicKey() } });
  if (faucet.status !== 200 && faucet.status !== 202) {
    record("setup", "fund the sender from the faucet", "200", short(faucet), false);
    sender = null;
    return false;
  }
  record("setup", "onboard + fund the throwaway sender", "an account with test USDC", `${sender.publicKey().slice(0, 6)}... funded`, true);
  return true;
}

/** A probe whose transaction could not even be built locally answers with this, so it records as a FAIL. */
const unbuilt = (why: string): Reply => ({ status: 0, text: `not sent: ${why}`, json: null, ms: 0 });

async function sectionA(): Promise<void> {
  console.log("\n[a] inflated fees on the Soroban relays");
  const junk = Keypair.random();
  const probes: RefusalProbe[] = [];
  const PILOT_GATED = "the pilot gate answers first (pilotMode true): a wallet nobody approved never reaches this guard; run it against a Worker without PILOT_MODE";

  if (health.pilotMode === true) {
    // The allowlist answers before the fee cap and the simulation, so the two probes named after
    // them prove nothing here. The 403 itself is a real refusal and is recorded as what it is.
    const gated = buildDeposit({ sender: junk, sequence: "1", fee: "1000000", link: Keypair.random(), amount: 2_000_000n, expiry: expiryIn(600), contract });
    gated.sign(junk);
    probes.push({
      probe: "/v2-deposit from a wallet nobody approved (the pilot gate)",
      expected: "403 'not on the pilot allowlist'; nothing counted against the fee budget",
      send: () => call("/v2-deposit", { body: { xdr: gated.toXDR(), senderPublicKey: junk.publicKey() } }),
      judge: (r) => (r.status === 403 && says(r, /not on the pilot allowlist/) ? { refused: true, note: "refused by the pilot allowlist" } : { refused: false, note: "not the allowlist's refusal" }),
    });
    record("a", "/v2-deposit inner fee = 2 XLM cap + 1 stroop", "400 refused by the cap; nothing counted against the fee budget", "not run", null, PILOT_GATED);
    record("a", "/v2-deposit from an unfunded sender (simulation fails)", "400 refused by the simulation; nothing counted against the fee budget", "not run", null, PILOT_GATED);
  } else {
    // A1: the absolute cap, refused before any simulation, on any network, from an unfunded key.
    const capPlusOne = buildDeposit({ sender: junk, sequence: "1", fee: "20000001", link: Keypair.random(), amount: 2_000_000n, expiry: expiryIn(600), contract });
    capPlusOne.sign(junk);
    probes.push({
      probe: "/v2-deposit inner fee = 2 XLM cap + 1 stroop",
      expected: "400 refused by the cap; nothing counted against the fee budget",
      send: () => call("/v2-deposit", { body: { xdr: capPlusOne.toXDR(), senderPublicKey: junk.publicKey() } }),
      judge: refusedBy(/exceeds cap/, "the 2 XLM cap"),
    });
    // A1b: a deposit the contract would refuse (an unfunded sender has no USDC): the simulation says no.
    const unfunded = buildDeposit({ sender: junk, sequence: "1", fee: "1000000", link: Keypair.random(), amount: 2_000_000n, expiry: expiryIn(600), contract });
    unfunded.sign(junk);
    probes.push({
      probe: "/v2-deposit from an unfunded sender (simulation fails)",
      expected: "400 refused by the simulation; nothing counted against the fee budget",
      send: () => call("/v2-deposit", { body: { xdr: unfunded.toXDR(), senderPublicKey: junk.publicKey() } }),
      judge: refusedBy(/would fail/, "the simulation"),
    });
  }

  // A6: a reclaim of a drop that does not exist: the simulation refuses it (reclaims are never pilot-gated).
  const ghost = buildReclaim({ sender: junk, sequence: "1", fee: "1000000", linkHex: linkHexOf(Keypair.random()), contract });
  ghost.sign(junk);
  probes.push({
    probe: "/v2-reclaim of a drop that does not exist (simulation fails)",
    expected: "400 refused by the simulation; nothing counted against the fee budget",
    send: () => call("/v2-reclaim", { body: { xdr: ghost.toXDR(), senderPublicKey: junk.publicKey() } }),
    judge: refusedBy(/would fail/, "the simulation"),
  });

  if (MODE !== "full" || !sender || health.pilotMode === true) {
    await refusalWindow("a", probes);
    // A throwaway sender is never on the allowlist, so on a pilot Worker its deposits would meet the
    // gate's 403, not the bound under test (the rehearsal is what exercises the gate).
    const why = MODE === "full" && sender ? PILOT_GATED : "needs a funded sender: full mode only";
    record("a", "/v2-deposit fee = simulated need + headroom + 0.01 XLM", "400 refused", "not run", null, why);
    record("a", "/v2-reclaim fee = simulated need + headroom + 0.01 XLM", "400 refused", "not run", null, why);
    return;
  }

  // A2: the web assembles with a 2,000,000-stroop classic fee; the relay allows resource +
  // 2,500,000, measured against the SPONSOR's own simulation, which can differ from this script's
  // by a few stroops (the first run of this probe found 1 stroop over the local figure accepted and
  // landing). So the inflated probe sits 0.01 XLM over the local figure, and the sponsor's refusal
  // names the exact bound it applied. Its link is recorded before it is posted: if it lands, the
  // bound is broken AND the money must come back, so it is reclaimed like the real deposit.
  await budgetGuard("the inflated deposit");
  const s = sender;
  const acct = await HORIZON.loadAccount(s.publicKey());
  const overDeposit = trackDeposit("link-a-over-fee", "the inflated-fee deposit, which must be refused");
  const over = await assembled(buildDeposit({ sender: s, sequence: acct.sequenceNumber(), fee: "2600000", link: overDeposit.link, amount: 2_000_000n, expiry: overDeposit.expiry, contract }));
  if (!("error" in over)) over.tx.sign(s);
  probes.push({
    probe: `/v2-deposit fee = simulated need + headroom + 0.01 XLM${"error" in over ? "" : ` (${over.tx.fee} stroops, local minResourceFee ${over.minResourceFee})`}`,
    expected: "400 refused, naming the bound; nothing counted against the fee budget",
    send: async () => {
      if ("error" in over) return unbuilt(`local simulation failed: ${over.error.slice(0, 80)}`);
      const r = await call("/v2-deposit", { body: { xdr: over.tx.toXDR(), senderPublicKey: s.publicKey() } });
      await settleDeposit(overDeposit, r, acct.sequenceNumber());
      return r;
    },
    judge: refusedBy(/exceeds what the deposit needs/, "the simulated-need bound"),
  });
  await refusalWindow("a", probes);

  // A3: the one real deposit, at exactly the bound, built on a fresh load (the inflated one may
  // have landed and moved the sequence).
  await budgetGuard("the real deposit");
  const acct2 = await HORIZON.loadAccount(s.publicKey());
  const real = trackDeposit("link-a-real", "the one real 0.2 USDC link (reclaimed by the run)");
  const exact = await assembled(buildDeposit({ sender: s, sequence: acct2.sequenceNumber(), fee: "2500000", link: real.link, amount: 2_000_000n, expiry: real.expiry, contract }));
  if ("error" in exact) {
    real.outcome = "not sent";
    record("a", "/v2-deposit at exactly the bound (the real deposit)", "200/202 with a hash", `local simulation failed: ${exact.error.slice(0, 80)}`, false);
    return;
  }
  exact.tx.sign(s);
  const r3 = await call("/v2-deposit", { body: { xdr: exact.tx.toXDR(), senderPublicKey: s.publicKey() } });
  await settleDeposit(real, r3, acct2.sequenceNumber());
  const okDeposit = (r3.status === 200 || r3.status === 202) && real.hash !== null;
  record("a", `/v2-deposit at exactly the bound (${exact.tx.fee} stroops; the one real 0.2 USDC deposit)`, "200 confirmed or 202 accepted, with a hash", short(r3), okDeposit, real.hash ? `hash ${real.hash}` : undefined);
}

/**
 * Take back every deposit that may have landed: the real one, and any probe deposit that landed
 * when it should have been refused (it used to stay in escrow, its link key thrown away). The first
 * landed deposit also carries the inflated-fee reclaim probe.
 */
async function sectionReclaim(): Promise<void> {
  const open = deposits.filter((d) => d.outcome === "landed" || d.outcome === "unconfirmed" || d.outcome === "unknown");
  if (MODE !== "full" || !sender || open.length === 0) return;
  console.log("\n[a2] taking back every deposit that may have landed, after its link expired");
  const s = sender;
  let probed = false;
  for (const d of open) {
    const wait = d.expiry * 1000 + 10_000 - Date.now();
    if (wait > 0) {
      console.log(`  waiting ${Math.ceil(wait / 1000)} s for ${d.name} to expire`);
      await sleep(wait);
    }
    if (!probed && d.outcome === "landed") {
      probed = true;
      await budgetGuard("the inflated reclaim");
      const acct = await HORIZON.loadAccount(s.publicKey());
      const over = await assembled(buildReclaim({ sender: s, sequence: acct.sequenceNumber(), fee: "2600000", linkHex: linkHexOf(d.link), contract }));
      if (!("error" in over)) over.tx.sign(s);
      await refusalWindow("a", [
        {
          probe: `/v2-reclaim fee = simulated need + headroom + 0.01 XLM${"error" in over ? "" : ` (${over.tx.fee} stroops, local minResourceFee ${over.minResourceFee})`}`,
          expected: "400 refused, naming the bound; nothing counted against the fee budget",
          send: async () => {
            if ("error" in over) return unbuilt(`local simulation failed: ${over.error.slice(0, 80)}`);
            const r = await call("/v2-reclaim", { body: { xdr: over.tx.toXDR(), senderPublicKey: s.publicKey() } });
            if (r.status === 200 || r.status === 202) {
              d.reclaim = `taken back by the inflated probe: ${short(r)}`;
              await awaitSequence(s.publicKey(), BigInt(acct.sequenceNumber()) + 1n);
            }
            return r;
          },
          judge: refusedBy(/exceeds what the reclaim needs/, "the simulated-need bound"),
        },
      ]);
      if (d.reclaim) continue; // the inflated probe landed: the money is already back
    }
    await budgetGuard(`the reclaim of ${d.name}`);
    const acct = await HORIZON.loadAccount(s.publicKey());
    const exact = await assembled(buildReclaim({ sender: s, sequence: acct.sequenceNumber(), fee: "2500000", linkHex: linkHexOf(d.link), contract }));
    if ("error" in exact) {
      /* Only the escrow's own answer settles it. NothingHere (Error #2): no drop under the link, so a
         deposit that answered 202 or nothing, its timebound long past, never landed. AlreadyClaimed
         (#3): it landed and was already claimed or taken back (the entry stays, marked claimed).
         Anything else (an RPC outage, a drop not yet expired) proves nothing and is a FAIL row with
         the keys file left to retry by hand. */
      const nothingHere = /Error\(Contract, #2\)/.test(exact.error);
      const already = /Error\(Contract, #3\)/.test(exact.error);
      const fine = (nothingHere && d.outcome !== "landed") || already;
      d.reclaim = already
        ? "nothing left to take back: the escrow says it was already claimed or taken back"
        : nothingHere && d.outcome !== "landed"
          ? "nothing to take back: it never landed"
          : `NOT taken back (${exact.error.slice(0, 60)}); reclaim it by hand with the keys file`;
      record("a", `reclaim ${d.name} (${d.outcome})`, d.outcome === "landed" ? "200/202 with a hash" : "taken back, or nothing to take back (NothingHere)", `local simulation: ${exact.error.slice(0, 80)}`, fine, d.reclaim);
      continue;
    }
    exact.tx.sign(s);
    const r = await call("/v2-reclaim", { body: { xdr: exact.tx.toXDR(), senderPublicKey: s.publicKey() } });
    const hash = hashOf(r);
    const ok = (r.status === 200 || r.status === 202) && hash !== null;
    d.reclaim = ok ? `${r.status === 200 ? "taken back" : "taken back, unconfirmed"}: ${hash}` : `NOT taken back (${short(r)}); reclaim it by hand with the keys file`;
    const label = d.name === "link-a-real" ? `/v2-reclaim at exactly the bound (${exact.tx.fee} stroops; the money comes back)` : `/v2-reclaim of ${d.name}, which landed when it should not have (${exact.tx.fee} stroops)`;
    record("a", label, "200 confirmed or 202 accepted", short(r), ok, hash ? `hash ${hash}` : undefined);
    if (ok) await awaitSequence(s.publicKey(), BigInt(acct.sequenceNumber()) + 1n);
  }
}

/** A documentation address (RFC 5737), fresh per run so a reused fake store's counters do not carry over. */
const docIp = (prefix: "203.0.113" | "198.51.100") => `${prefix}.${1 + Math.floor(Math.random() * 254)}`;

async function sectionB(): Promise<void> {
  console.log("\n[b] budget exhaustion, contained");
  if (MODE !== "full") {
    record("b", "every exhaustion probe", "contained", "not run", null, "refusal-only mode: exhaustion is never run against a live mainnet Worker (it locks real recipients out until UTC midnight)");
    return;
  }
  if (KV && !storeProof?.ok) {
    record("b", "every exhaustion probe", "contained", "not run", null, "refused: the target did not prove it reads the fake store (setup row), so a pre-seeded counter would be ours while the calls spent its own");
    return;
  }
  const share = health.counters?.maxDaySourceAccounts ?? 0;
  const maxDay = health.counters?.maxDayAccounts ?? 0;

  if (KV) {
    // B1: the per-source share, pre-seeded to its limit for one address; a second address is served.
    const ip = SOURCE_IP ?? docIp("203.0.113");
    const other = docIp("198.51.100");
    const srcKey = `caps:${NETWORK}:accounts:${today()}:src:${ipBucket(ip)}`;
    await kvSet(srcKey, String(share));
    const fresh = () => ({ recipientPublicKey: Keypair.random().publicKey() });
    const r1 = await call("/create-account", { body: fresh(), headers: { "cf-connecting-ip": ip } });
    record("b", `/create-account from a source at its share (${share}, pre-seeded)`, "400 'paused for today'", short(r1), refused(r1) && says(r1, /paused for today/));
    const r2 = await call("/create-account", { body: fresh(), headers: { "cf-connecting-ip": other } });
    record("b", "/create-account from a second source while the first is paused", "not the 'paused' refusal (served, or a chain reason further down)", short(r2), r2.status !== 0 && !says(r2, /paused for today/), r2.status === 200 ? "served a sandwich" : "refused further down, not by the budget");
    await kvDel(srcKey);

    // B1b: the same recipient key twice costs one slot (the honest retry is free). Both calls must
    // be SERVED: two refusals also leave the counter where it was, and would prove nothing.
    const pk = Keypair.random().publicKey();
    const dayKeyName = `caps:${NETWORK}:accounts:${today()}`;
    const beforeDay = Number((await kvGet(dayKeyName)) ?? "0");
    const t1 = await call("/create-account", { body: { recipientPublicKey: pk }, headers: { "cf-connecting-ip": other } });
    const t2 = await call("/create-account", { body: { recipientPublicKey: pk }, headers: { "cf-connecting-ip": other } });
    const afterDay = Number((await kvGet(dayKeyName)) ?? "0");
    record(
      "b",
      "/create-account twice for the same recipient key",
      "both served (200), and the day counter moves by exactly 1",
      `${t1.status}, ${t2.status}; counter ${beforeDay} -> ${afterDay}`,
      // Without a served first call there is no retry to measure (a sponsor key with no account
      // on this network is refused further down): that is a skip, never a pass.
      t1.status === 200 ? t2.status === 200 && afterDay - beforeDay === 1 : null,
      t1.status === 200 ? undefined : `the first call was not served (${short(t1)}), so the retry cannot be measured on this target`,
    );

    if (sender && health.pilotMode !== true) {
      const s = sender;
      // B2: the day's escrow cap, pre-seeded to the ceiling; a valid deposit is refused with the public sentence.
      const dayUsdc = Number.parseFloat(health.counters?.maxDayUsdc ?? "0");
      const escrowKey = `caps:${NETWORK}:day:${today()}`;
      const saved = await kvGet(escrowKey);
      await kvSet(escrowKey, (BigInt(Math.round(dayUsdc)) * STROOPS).toString());
      await budgetGuard("the day-cap deposit");
      const acct = await HORIZON.loadAccount(s.publicKey());
      const capped = trackDeposit("link-b-day-cap", "a deposit past the day's escrow cap, which must be refused");
      const dep = await assembled(buildDeposit({ sender: s, sequence: acct.sequenceNumber(), fee: "2000000", link: capped.link, amount: 1_000_000n, expiry: capped.expiry, contract }));
      if ("error" in dep) {
        capped.outcome = "not sent";
        record("b", "/v2-deposit past the day's escrow cap", "400 'daily escrow cap'", `local simulation failed: ${dep.error.slice(0, 80)}`, false);
      } else {
        dep.tx.sign(s);
        const r3 = await call("/v2-deposit", { body: { xdr: dep.tx.toXDR(), senderPublicKey: s.publicKey() } });
        await settleDeposit(capped, r3, acct.sequenceNumber());
        record("b", `/v2-deposit with the day at its cap of ${dayUsdc} USDC (pre-seeded)`, "400 'daily escrow cap ... reached'", short(r3), refused(r3) && says(r3, /daily escrow cap/));
      }
      if (saved === null) await kvDel(escrowKey);
      else await kvSet(escrowKey, saved);

      // B3: a deposit that is accepted by the simulation but refused by the network (a stale
      // sequence) gives the day's budget back exactly once: the counter never goes below where it was.
      await budgetGuard("the stale-sequence deposit");
      const counterBefore = (await kvGet(escrowKey)) ?? "0";
      const staleDeposit = trackDeposit("link-b-stale-sequence", "a deposit with a sequence the network refuses");
      const acctStale = await HORIZON.loadAccount(s.publicKey());
      const stale = await assembled(buildDeposit({ sender: s, sequence: (BigInt(acctStale.sequenceNumber()) + 10n).toString(), fee: "2000000", link: staleDeposit.link, amount: 1_000_000n, expiry: staleDeposit.expiry, contract }));
      if ("error" in stale) {
        staleDeposit.outcome = "not sent";
        record("b", "a deposit the network refuses (stale sequence)", "counter unchanged", `refused by the simulation instead: ${stale.error.slice(0, 60)}`, true, "the simulation caught it first; nothing was reserved");
      } else {
        stale.tx.sign(s);
        const r4 = await call("/v2-deposit", { body: { xdr: stale.tx.toXDR(), senderPublicKey: s.publicKey() } });
        await settleDeposit(staleDeposit, r4, acctStale.sequenceNumber());
        const counterAfter = (await kvGet(escrowKey)) ?? "0";
        record("b", "a deposit accepted by the simulation and refused by the network (stale sequence)", "refused, and the day counter is back where it was (never below)", `${short(r4)}; counter ${counterBefore} -> ${counterAfter}`, refused(r4) && BigInt(counterAfter) === BigInt(counterBefore));
      }

      // B4: the sponsor fee budget, pre-seeded to its ceiling: every relay answers the public sentence.
      const feeKey = `caps:${NETWORK}:fees:${today()}`;
      const savedFee = await kvGet(feeKey);
      const maxXlm = Number.parseFloat(health.fees?.maxXlm ?? "0");
      await kvSet(feeKey, BigInt(Math.round(maxXlm * 1e7)).toString());
      await budgetGuard("the fee-budget deposit");
      const acct2 = await HORIZON.loadAccount(s.publicKey());
      const spentDeposit = trackDeposit("link-b-fee-budget", "a deposit with the fee budget spent, which must be refused");
      const dep2 = await assembled(buildDeposit({ sender: s, sequence: acct2.sequenceNumber(), fee: "2000000", link: spentDeposit.link, amount: 1_000_000n, expiry: spentDeposit.expiry, contract }));
      if ("error" in dep2) {
        spentDeposit.outcome = "not sent";
        record("b", "/v2-deposit with the fee budget spent", "400 'fee budget is spent'", `local simulation failed: ${dep2.error.slice(0, 80)}`, false);
      } else {
        dep2.tx.sign(s);
        const r5 = await call("/v2-deposit", { body: { xdr: dep2.tx.toXDR(), senderPublicKey: s.publicKey() } });
        await settleDeposit(spentDeposit, r5, acct2.sequenceNumber());
        record("b", `/v2-deposit with the day's fee budget spent (${maxXlm} XLM, pre-seeded)`, "400 'today's sponsor fee budget is spent'", short(r5), refused(r5) && says(r5, /fee budget is spent/));
      }
      const r6 = await call("/create-account", { body: { recipientPublicKey: Keypair.random().publicKey() }, headers: { "cf-connecting-ip": other } });
      record("b", "/create-account with the day's fee budget spent", "400 'today's sponsor fee budget is spent'", short(r6), refused(r6) && says(r6, /fee budget is spent/));
      if (savedFee === null) await kvDel(feeKey);
      else await kvSet(feeKey, savedFee);
    } else {
      record("b", "the day cap, the failed-deposit counter and the fee budget", "contained", "not run", null, sender ? "the pilot gate answers first (pilotMode true): the throwaway sender is not on the allowlist, so its deposits never reach these budgets" : "the throwaway sender was not funded");
    }
    return;
  }

  if (NETWORK !== "testnet") {
    record("b", "per-source exhaustion against the target's own store", "contained", "not run", null, "only ever against testnet; mainnet exhaustion needs the proven fake store");
    return;
  }
  // The live testnet Worker: the per-source share for real. Each call hands out a signed sandwich
  // that is never submitted, so nothing is locked on chain. Every served call adds one to this
  // address's share AND to the day total (caps.ts: both counters move together), and the sender's
  // own onboarding above already spent a slot from this address, as may an earlier run today: so
  // the refusal comes at or before call share+1, and the count is what the row reports.
  const limit = share > 0 ? share : 120;
  let paused = -1;
  for (let i = 1; i <= limit + 5; i++) {
    const r = await call("/create-account", { body: { recipientPublicKey: Keypair.random().publicKey() } });
    if (refused(r) && says(r, /paused for today/)) {
      paused = i;
      break;
    }
    if (r.status === 429) {
      record("b", `per-source exhaustion, call ${i}`, "not rate limited before the share", short(r), false, "the per-IP limit fired first: raise --rate-cap to the target's real cap");
      return;
    }
    if (r.status !== 200) {
      record("b", `per-source exhaustion, call ${i}`, "200 sandwich", short(r), false);
      return;
    }
  }
  record(
    "b",
    `/create-account from this address until its share of ${limit} is spent`,
    `refused with 'paused for today' at or before call ${limit + 1}`,
    paused > 0 ? `refused at call ${paused}` : `never refused in ${limit + 5} calls`,
    paused > 0 && paused <= limit + 1,
    paused > 0
      ? `the day total grows by the share (${paused - 1} served here); ${paused === 1 ? "the share was already spent today from this address" : "a second source cannot be faked from one machine"}`
      : "the share never closed",
  );
  record("b", "a second source is still served", "served", "not run", null, "cannot present a second address from one machine; proven against wrangler dev with --kv and --source-ip");
  record("b", `the day cap (${maxDay} accounts, ${health.counters?.maxDayUsdc} USDC) and the fee budget`, "contained", "not run", null, "pre-seeding needs the fake store (--kv); proven against wrangler dev");
}

/** Junk transactions for the Horizon routes: each is a shape a guard must refuse before anything is signed. */
function junkFixtures(): Array<{ route: string; name: string; body: Record<string, unknown>; re: RegExp; guard: string; pilotGated?: boolean }> {
  // A fresh recipient per /feebump fixture: five posts naming one key would meet the per-account
  // rate limit (5 a minute on mainnet) before the validator, and a 429 is not the refusal under test.
  let recipient = Keypair.random();
  const homeKp = Keypair.random();
  const mk = (source: string, ops: xdr.Operation[], fee = BASE_FEE) => {
    const b = new TransactionBuilder(new Account(source, "1"), { fee, networkPassphrase: PASSPHRASE });
    for (const op of ops) b.addOperation(op);
    return b.setTimeout(300).build();
  };
  const ANTI_DRAIN = /anti-drain rejected/;
  const balanceId = "00000000" + "ab".repeat(32);
  const fixtures: Array<{ route: string; name: string; body: Record<string, unknown>; re: RegExp; guard: string; pilotGated?: boolean }> = [];
  // 1. /feebump: a payment SOURCED BY THE SPONSOR inside the "claim" (the drain).
  const drain = mk(recipient.publicKey(), [Operation.payment({ source: sponsorAccount, destination: recipient.publicKey(), asset: Asset.native(), amount: "5" })]);
  drain.sign(recipient);
  fixtures.push({ route: "/feebump", name: "a sponsor-sourced payment inside the claim", body: { xdr: drain.toXDR(), recipientPublicKey: recipient.publicKey(), balanceId }, re: ANTI_DRAIN, guard: "the anti-drain validator" });
  // 2. /feebump: a claim of some OTHER balance id than the one named.
  recipient = Keypair.random();
  const wrongId = mk(recipient.publicKey(), [Operation.claimClaimableBalance({ balanceId: "00000000" + "cd".repeat(32) })]);
  wrongId.sign(recipient);
  fixtures.push({ route: "/feebump", name: "a claim whose balance id differs from the one named", body: { xdr: wrongId.toXDR(), recipientPublicKey: recipient.publicKey(), balanceId }, re: ANTI_DRAIN, guard: "the anti-drain validator" });
  // 3. /feebump: a muxed source address.
  recipient = Keypair.random();
  const muxed = new MuxedAccount(new Account(recipient.publicKey(), "1"), "7").accountId();
  const mux = mk(recipient.publicKey(), [Operation.claimClaimableBalance({ balanceId, source: muxed })]);
  mux.sign(recipient);
  fixtures.push({ route: "/feebump", name: "a claim op sourced by a muxed (M...) address", body: { xdr: mux.toXDR(), recipientPublicKey: recipient.publicKey(), balanceId }, re: ANTI_DRAIN, guard: "the anti-drain validator" });
  // 4. /send-link: a claimable balance with THREE claimants. The sponsor sponsors the balance's
  // reserve, which grows with every claimant, so the policy pins the count at exactly two.
  // (There is deliberately no fixture for the SENDER's own claimant predicate: the policy checks
  // that the sender is a claimant and that one claimant is unconditional, and leaves the sender's
  // predicate to the sender by design, since either claimant's claim releases the sponsored
  // reserve. A probe for it is accepted, signed and submitted, which is why it was retired.)
  const third = Keypair.random();
  const threeWay = mk(homeKp.publicKey(), [
    Operation.beginSponsoringFutureReserves({ sponsoredId: homeKp.publicKey(), source: sponsorAccount }),
    Operation.createClaimableBalance({
      asset: USDC,
      amount: "1",
      claimants: [
        new Claimant(recipient.publicKey(), Claimant.predicateUnconditional()),
        new Claimant(third.publicKey(), Claimant.predicateUnconditional()),
        new Claimant(homeKp.publicKey(), Claimant.predicateNot(Claimant.predicateBeforeRelativeTime("604800"))),
      ],
    }),
    Operation.endSponsoringFutureReserves({ source: homeKp.publicKey() }),
  ]);
  threeWay.sign(homeKp);
  fixtures.push({ route: "/send-link", name: "a send whose claimable balance has three claimants (a bigger sponsored reserve)", body: { xdr: threeWay.toXDR(), senderPublicKey: homeKp.publicKey() }, re: ANTI_DRAIN, guard: "the anti-drain send policy", pilotGated: true });
  // 4b. /send-link: no unconditional claimant at all, so the sponsored reserve could stay locked.
  const lockedForever = mk(homeKp.publicKey(), [
    Operation.beginSponsoringFutureReserves({ sponsoredId: homeKp.publicKey(), source: sponsorAccount }),
    Operation.createClaimableBalance({
      asset: USDC,
      amount: "1",
      claimants: [
        new Claimant(recipient.publicKey(), Claimant.predicateBeforeRelativeTime("60")),
        new Claimant(homeKp.publicKey(), Claimant.predicateNot(Claimant.predicateBeforeRelativeTime("604800"))),
      ],
    }),
    Operation.endSponsoringFutureReserves({ source: homeKp.publicKey() }),
  ]);
  lockedForever.sign(homeKp);
  fixtures.push({ route: "/send-link", name: "a send with no unconditional claimant (the reserve could stay locked)", body: { xdr: lockedForever.toXDR(), senderPublicKey: homeKp.publicKey() }, re: ANTI_DRAIN, guard: "the anti-drain send policy", pilotGated: true });
  // 5. /payout: a payment to a destination the policy does not allow.
  const stranger = Keypair.random();
  const payout = mk(homeKp.publicKey(), [Operation.payment({ destination: stranger.publicKey(), asset: USDC, amount: "1" })]);
  payout.sign(homeKp);
  fixtures.push({ route: "/payout", name: "a payout to a destination that is not the one named", body: { xdr: payout.toXDR(), senderPublicKey: homeKp.publicKey(), destination: Keypair.random().publicKey(), amount: "1" }, re: ANTI_DRAIN, guard: "the anti-drain payout policy" });
  // 6. /sweep: a sweep whose payment is sourced by the sponsor.
  recipient = Keypair.random();
  const sweep = mk(recipient.publicKey(), [Operation.payment({ source: sponsorAccount, destination: homeKp.publicKey(), asset: USDC, amount: "1" })]);
  sweep.sign(recipient);
  fixtures.push({ route: "/sweep", name: "a sweep whose payment the sponsor sources", body: { xdr: sweep.toXDR(), throwawayPublicKey: recipient.publicKey(), homePublicKey: homeKp.publicKey(), amount: "1" }, re: ANTI_DRAIN, guard: "the anti-drain sweep policy" });
  // 7. /feebump: an inner fee far over the sponsor's fee-bump cap. The route's own cap bounds the
  // sponsor's bid (1000 a op); this inner fee is refused one step later, by the SDK's fee-bump
  // builder ("Invalid baseFee"), because a bump must bid at least the inner rate. Either refusal is
  // before the signature.
  recipient = Keypair.random();
  const rich = mk(recipient.publicKey(), [Operation.claimClaimableBalance({ balanceId })], "5000000");
  rich.sign(recipient);
  fixtures.push({ route: "/feebump", name: "a claim whose inner fee is far over the fee-bump cap", body: { xdr: rich.toXDR(), recipientPublicKey: recipient.publicKey(), balanceId }, re: /Invalid baseFee|exceeds cap/, guard: "the fee-bump bound" });
  // 8. /feebump: not even XDR.
  fixtures.push({ route: "/feebump", name: "a body whose xdr is not XDR", body: { xdr: "AAAAnotxdr", recipientPublicKey: Keypair.random().publicKey(), balanceId }, re: /XDR/, guard: "the XDR parser" });
  return fixtures;
}

async function sectionC(): Promise<void> {
  console.log("\n[c] junk claims and junk transactions");
  /* Start in a fresh rate-limit window, so these rows are judged by the guard under test and not by
     a limiter still counting what came before: section a of this run, or another run from the same
     address. The limiter's keys are not namespaced by network, so a testnet run just before a
     mainnet one (one store, one address) fills the mainnet Worker's 30-a-minute window. */
  await freshMinute();
  const EXPECTED = "refused; nothing counted against the fee budget";
  const payout = Keypair.random().publicKey();
  const probes: RefusalProbe[] = [
    {
      probe: "/v2-claim with a 31-byte link",
      expected: EXPECTED,
      send: () => call("/v2-claim", { body: { method: "claim", linkHex: "ab".repeat(31), payout, sigHex: "cd".repeat(64) } }),
      judge: refusedBy(/32 bytes/, "the link check"),
    },
    {
      probe: "/v2-claim naming a foreign contract id",
      expected: EXPECTED,
      send: () => call("/v2-claim", { body: { method: "claim", linkHex: "ab".repeat(32), payout, sigHex: "cd".repeat(64), contract: StrKey.encodeContract(Buffer.alloc(32, 7)) } }),
      judge: refusedBy(/contract not allowed/, "the contract allowlist"),
    },
    {
      probe: "/v2-claim with a method outside the allowlist",
      expected: EXPECTED,
      send: () => call("/v2-claim", { body: { method: "withdraw", linkHex: "ab".repeat(32), payout, sigHex: "cd".repeat(64) } }),
      judge: refusedBy(/method not allowed/, "the method allowlist"),
    },
  ];
  const real = deposits.find((d) => d.name === "link-a-real" && (d.outcome === "landed" || d.outcome === "unconfirmed"));
  if (MODE === "full" && real && sender) {
    const payTo = sender.publicKey();
    probes.push({
      probe: "/v2-claim with a random 64-byte signature for a real unclaimed link",
      expected: "refused by the simulation; nothing counted against the fee budget",
      send: () => call("/v2-claim", { body: { method: "claim", linkHex: linkHexOf(real.link), payout: payTo, sigHex: Buffer.from(Keypair.random().sign(Buffer.alloc(32))).toString("hex") } }),
      judge: refusedBy(/simulation failed/, "the simulation"),
    });
  } else {
    record("c", "/v2-claim with a random signature for a real unclaimed link", "400 refused", "not run", null, "needs the real link from full mode");
  }
  for (const f of junkFixtures()) {
    if (f.pilotGated && health.pilotMode === true) {
      record("c", `${f.route}: ${f.name}`, EXPECTED, "not run", null, "the pilot gate answers first (pilotMode true): a wallet nobody approved never reaches the send policy, which test:antidrain holds offline");
      continue;
    }
    probes.push({ probe: `${f.route}: ${f.name}`, expected: EXPECTED, send: () => call(f.route, { body: f.body }), judge: refusedBy(f.re, f.guard) });
  }
  await refusalWindow("c", probes);
}

/** Sleep to just past the next minute: the store's rate-limit windows are whole epoch minutes. */
async function freshMinute(): Promise<void> {
  const wait = (Math.floor(Date.now() / 60_000) + 1) * 60_000 + 500 - Date.now();
  console.log(`  waiting ${Math.ceil(wait / 1000)} s for a fresh rate-limit window`);
  await sleep(wait);
}

async function sectionD(): Promise<void> {
  console.log("\n[d] rate limits");
  // Both limits are counted in whole-minute windows. Starting in a fresh one means the earlier
  // sections' requests are not in it and the burst cannot straddle a reset, so the 429 that comes
  // back is the limiter under test. Its words say which limiter answered, and the row checks them:
  // a per-IP 429 in the per-account row once read as a pass.
  await freshMinute();
  const payout = Keypair.random().publicKey();
  let acct429 = -1;
  let acctReply: Reply | null = null;
  for (let i = 1; i <= ACCOUNT_RATE_CAP + 2; i++) {
    const r = await call("/v2-claim", { body: { method: "claim", linkHex: "ab".repeat(31), payout, sigHex: "cd".repeat(64) }, timeoutMs: 20_000 });
    if (r.status === 429) {
      acct429 = i;
      acctReply = r;
      break;
    }
  }
  const lo = Math.max(2, ACCOUNT_RATE_CAP - 3);
  const byAccount = acctReply !== null && says(acctReply, /per-account/);
  record(
    "d",
    `${ACCOUNT_RATE_CAP + 2} junk /v2-claim posts for one payout key`,
    `the per-account limiter's 429 by post ${ACCOUNT_RATE_CAP + 1}, and not before post ${lo}`,
    acctReply ? `first 429 at post ${acct429}: ${short(acctReply)}` : `no 429 in ${ACCOUNT_RATE_CAP + 2} posts`,
    byAccount && acct429 <= ACCOUNT_RATE_CAP + 1 && acct429 >= lo,
    acctReply && !byAccount ? "a 429 from another limiter, not the per-account cap" : "the real per-account cap of this Worker (the junk is refused by the guard until the limiter answers)",
  );
  // /events/summary is metered per IP and nothing else (no account bucket), so it measures the
  // per-IP cap alone. The burst above is in this minute's window too, so the 429 arrives EARLIER
  // than the cap, never later: the check is "by the cap + 1".
  /* In parallel batches: sent one at a time over the internet, 300 requests outlast the limiter's
     one-minute window, and a burst split across two windows never reaches the cap (a live testnet
     run sent 305 and saw no 429). Served replies are counted; the cap holds if at most RATE_CAP
     were served before the first 429. */
  const total = RATE_CAP + 5;
  let served = 0;
  let ipReply: Reply | null = null;
  for (let sent = 0; sent < total && !ipReply; ) {
    const batch = Math.min(25, total - sent);
    const replies = await Promise.all(Array.from({ length: batch }, () => call("/events/summary", { timeoutMs: 20_000 })));
    sent += batch;
    for (const r of replies) {
      if (r.status === 429) ipReply ??= r;
      else if (r.status === 200) served++;
    }
  }
  const byIp = ipReply !== null && says(ipReply, /per-IP/);
  record(
    "d",
    `${total} GETs to /events/summary from one address, in batches of 25`,
    `the per-IP limiter's 429 after at most ${RATE_CAP} served`,
    ipReply ? `a 429 after ${served} served: ${short(ipReply)}` : `no 429 in ${total} requests (${served} served)`,
    byIp && served <= RATE_CAP,
    "the real per-IP cap of this Worker; the per-account burst above was in the same minute's window",
  );
}

/**
 * Ask `check` every 500 ms from `t0`, the last time exactly at `deadlineMs`, until it passes: the
 * verdict is "within the deadline" only when a check scheduled no later than the deadline passed.
 * The old loop kept asking for 6 s under a 5 s label.
 */
async function within(t0: number, deadlineMs: number, check: () => Promise<{ ok: boolean; detail: string }>): Promise<{ ok: boolean; detail: string; sentAtMs: number }> {
  let last = { ok: false, detail: "" };
  let sentAtMs = 0;
  for (let slot = 0; ; slot++) {
    const at = Math.min(slot * 500, deadlineMs);
    await sleep(Math.max(0, t0 + at - Date.now()));
    sentAtMs = Date.now() - t0;
    last = await check();
    if (last.ok || at >= deadlineMs) break;
  }
  return { ...last, sentAtMs };
}

async function sectionE(): Promise<void> {
  console.log("\n[e] the halt switch");
  if (!KV) {
    record("e", "SET sponsor:halt:<net> -> every value and grant route 503 within 5 s", "503 everywhere", "not run", null, "the live store is not ours to write; proven against wrangler dev with --kv. SPONSOR_HALT=1 + deploy is the per-Worker hard stop that needs no store.");
    return;
  }
  if (!storeProof?.ok) {
    record("e", "SET sponsor:halt:<net> -> every value and grant route 503 within 5 s", "503 everywhere", "not run", null, "refused: the target did not prove it reads the fake store (setup row)");
    return;
  }
  // The halt's own answer, not any 503 (a grant route without PILOT_APPROVE_TOKEN is 503 "not set up").
  const haltAnswer = (r: Reply) => r.status === 503 && /temporarily halted|Approvals are paused/.test(r.text);
  // All 13 routes at once, so one check is one instant rather than a walk that outlasts the cache.
  const sweep = async (): Promise<{ ok: boolean; detail: string }> => {
    const replies = await Promise.all([
      // GETs: the halt gate is method-agnostic (worker.ts), and a GET reaches no handler when the
      // Worker is not halted, so a check sent before the cached verdict turns cannot mint a demo
      // link or claim from the faucet (a POST {} to /demo-link on testnet does).
      ...VALUE_ROUTES.map(async (route) => ({ route, r: await call(route, { timeoutMs: 20_000 }) })),
      ...GRANT_ROUTES.map(async (route) => ({ route, r: await call(`${route}?pubkey=x&token=y&exp=1`, { timeoutMs: 20_000 }) })),
    ]);
    // A count first, so the row survives a report column that truncates; only the misses are named.
    const missed = replies.filter(({ r }) => !haltAnswer(r)).map(({ route, r }) => `${route}:${r.status}`);
    return {
      ok: missed.length === 0,
      detail: `${replies.length - missed.length}/${replies.length} answered the halt${missed.length ? `; not: ${missed.join(" ")}` : ""}`,
    };
  };
  for (const key of [`sponsor:halt:${NETWORK}`, "sponsor:halt"]) {
    await kvSet(key, "1");
    const t0 = Date.now();
    const halted = await within(t0, CACHE_MS, sweep);
    record("e", `SET ${key} = 1: the 11 value routes and 2 grant routes`, "all 503 within 5 s", halted.detail, halted.ok, `the check sent at ${halted.sentAtMs} ms; the verdict is cached up to 5 s per isolate`);
    // /health caches its store readings for 5 s as well: read it 6 s after the SET.
    await sleep(Math.max(0, t0 + QUIET_MS - Date.now()));
    const h = await getHealth();
    const ps = await call(`/pilot-status?pubkey=${Keypair.random().publicKey()}`);
    // /pilot-status is metered per IP on a pilot Worker. The sweeps are GETs the limiter never
    // counts, but section d's burst may have used this minute's window, so a 429 here is the
    // route's own limiter, which runs after the only place a halt answers (the halt is 503).
    record("e", `while ${key} is set: the read routes`, "/health 200 (halted:true), /pilot-status not 503", `/health ${h ? 200 : "unreadable"} halted=${String(h?.halt?.halted)} /pilot-status ${ps.status}`, h?.halt?.halted === true && ps.status !== 503 && ps.status !== 0);
    await kvDel(key);
    await kvDel(`${key}:reason`);
    const t1 = Date.now();
    const back = await within(t1, CACHE_MS, async () => {
      const r = await call("/v2-claim", { body: {}, timeoutMs: 20_000 });
      return { ok: r.status !== 0 && !haltAnswer(r), detail: short(r) };
    });
    record("e", `DEL ${key}: the value routes answer again`, "no longer the halt's 503 within 5 s", back.ok ? `recovered at ${back.sentAtMs} ms` : `still halted at ${back.sentAtMs} ms (${back.detail})`, back.ok);
  }
}

/* ------------------------------------- report ------------------------------------- */

function storeLine(): string {
  if (!KV) return "the target's own store (no --kv): nothing was pre-seeded";
  if (!storeProof) return `the fake store at ${KV}; the run stopped before the target was asked to prove it reads it`;
  return storeProof.ok
    ? `the fake store at ${KV}, proven read by the target (${storeProof.detail})`
    : `the fake store at ${KV}, NOT proven read by the target (${storeProof.detail}); the exhaustion and halt sections were refused`;
}

function markdown(): string {
  const lines: string[] = [];
  const esc = (t: string) => t.replace(/\|/g, "\\|");
  lines.push(`# Adversarial run: ${NETWORK}, ${MODE}, ${STAMP}`);
  lines.push("");
  lines.push(`Target: ${TARGET}${LOCAL ? " (a localhost URL)" : ""}`);
  lines.push(`Store: ${storeLine()}`);
  lines.push(`Sponsor account: ${sponsorAccount || "?"}; signer: ${health.signer?.kind ?? "?"}; pilotMode: ${String(health.pilotMode)}; halted before the run: ${String(health.halt?.halted)}`);
  lines.push(`Sponsor balance before: ${before ? `${before.xlm} XLM, ${before.usdc} USDC` : "unreadable"}; after: ${after ? `${after.xlm} XLM, ${after.usdc} USDC` : endNote ? "not read (the run stopped early)" : "unreadable"}`);
  if (endNote) {
    lines.push("");
    lines.push(`**The run stopped early: ${endNote}.** The rows below are the probes that ran before it stopped.`);
  }
  if (MODE === "refusal-only") {
    lines.push("");
    lines.push(
      LOCAL
        ? "Refusal-only: nothing was funded, nothing that could land was submitted, no counter was seeded. The exhaustion section is not part of refusal-only mode: against the live mainnet Worker it would lock real recipients out until UTC midnight."
        : "Refusal-only: nothing was funded, nothing that could land was submitted, no counter was seeded; the exhaustion section was not run against this live Worker because it would lock real recipients out until UTC midnight.",
    );
  }
  lines.push("");
  const sections = [...new Set(rows.map((r) => r.section))];
  for (const s of sections) {
    lines.push(`## Section ${s}`);
    lines.push("");
    lines.push("| probe | expected | got | status | reason |");
    lines.push("|---|---|---|---|---|");
    for (const r of rows.filter((x) => x.section === s)) {
      lines.push(`| ${esc(r.probe)} | ${esc(r.expected)} | ${esc(r.got)} | ${r.status} | ${esc(r.reason ?? "")} |`);
    }
    lines.push("");
  }
  const counts = { PASS: rows.filter((r) => r.status === "PASS").length, FAIL: rows.filter((r) => r.status === "FAIL").length, SKIP: rows.filter((r) => r.status === "SKIP").length };
  lines.push(`Totals: ${counts.PASS} pass, ${counts.FAIL} fail, ${counts.SKIP} skipped.`);
  lines.push("");
  if (deposits.length > 0) {
    lines.push(`Deposits the run posted (their link keys are in ${keysPath()}, written before each was posted):`);
    lines.push("");
    lines.push("| key | purpose | link (public) | outcome | hash | taken back |");
    lines.push("|---|---|---|---|---|---|");
    for (const d of deposits) {
      const back = d.reclaim ?? (d.outcome === "refused" || d.outcome === "not sent" ? "nothing to take back" : "not reached: reclaim it by hand with the keys file");
      lines.push(`| ${d.name} | ${esc(d.purpose)} | ${d.link.publicKey()} | ${d.outcome} | ${d.hash ?? ""} | ${esc(back)} |`);
    }
    lines.push("");
  }
  lines.push("The target's /health at the start:");
  lines.push("```json");
  lines.push(JSON.stringify(health, null, 2));
  lines.push("```");
  lines.push("");
  if (closingHealth) {
    lines.push("The target's /health at the end (6 s after the last request):");
    lines.push("```json");
    lines.push(JSON.stringify(closingHealth, null, 2));
    lines.push("```");
  } else {
    lines.push(`The target's /health at the end: ${endNote ? "not read (the run stopped early)" : "unreadable"}.`);
  }
  return lines.join("\n") + "\n";
}

/** Written once: at the end of a full run, or from the exit handler when the run stops early. */
function writeReport(): void {
  if (reported) return;
  reported = true;
  const base = resolve(OUT, `adversarial-${NETWORK}-${MODE}-${STAMP}`);
  const depositsOut = deposits.map((d) => ({ name: d.name, purpose: d.purpose, link: d.link.publicKey(), expiry: d.expiry, outcome: d.outcome, hash: d.hash, reclaim: d.reclaim ?? null }));
  writeFileSync(
    `${base}.json`,
    `${JSON.stringify({ network: NETWORK, mode: MODE, target: TARGET, local: LOCAL, kv: KV ?? null, storeProof, stamp: STAMP, endedEarly: endNote || null, before, after, health, closingHealth, deposits: depositsOut, rows }, null, 2)}\n`,
  );
  writeFileSync(`${base}.md`, markdown());
  const fails = rows.filter((r) => r.status === "FAIL").length;
  console.log(`report: ${base}.md (${rows.length} rows, ${fails} failing${endNote ? `; stopped early: ${endNote}` : ""})`);
}

// A run that dies (die(), an uncaught error, Ctrl-C) still leaves its report: two earlier runs left
// only their keys behind. 'exit' handlers run synchronously, which writeFileSync is.
process.on("exit", () => {
  if (!started) return;
  try {
    writeReport();
  } catch (e) {
    console.error(`adversarial-run: the report could not be written: ${(e as Error).message}`);
  }
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (!endNote) endNote = `stopped by ${sig}`;
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
}

/* --------------------------------------- main --------------------------------------- */

async function main(): Promise<void> {
  assertGitignored(keysPath());
  mkdirSync(OUT, { recursive: true });
  started = true;
  console.log(`adversarial-run: ${NETWORK} ${MODE} against ${TARGET}${KV ? ` (fake store ${KV})` : ""}; reports and keys in ${OUT}`);
  const h = await getHealth();
  if (!h) die("/health did not answer 200 with JSON");
  health = h;
  if (health.network !== NETWORK) die(`the target says it is ${health.network}, you said ${NETWORK}`);
  sponsorAccount = String(health.account ?? health.sponsorPublicKey ?? "");
  contract = String(health.contract ?? "");
  if (!StrKey.isValidEd25519PublicKey(sponsorAccount)) die("/health carries no sponsor account");
  if (!contract) die("/health carries no contract id (the D3 /health is needed; deploy the Worker first)");
  before = await balances(sponsorAccount);
  budgetStartXlm = before ? Number.parseFloat(before.xlm) : null;
  console.log(`sponsor ${sponsorAccount} balance before: ${before ? `${before.xlm} XLM, ${before.usdc} USDC` : "unreadable (a local throwaway sponsor has no account)"}`);

  const spends = MODE === "full" && !SKIP.has("a");
  if (spends && NETWORK !== "testnet") die("full mode funds a throwaway from the testnet faucet; with section a it is testnet-only (use --skip a)");
  if (spends && !before) die("full mode spends, and the sponsor's balance is unreadable: --budget-xlm could not be enforced");

  if (KV) {
    const current = await proveStoreCurrent();
    if (!current.ok) {
      die(`--kv ${KV} is not the current cli/fake-kv.ts (${current.detail}). Restart it: pnpm --filter @lumenia/sponsor fake-kv`);
    }
    console.log(`fake store is current: ${current.detail}`);
    storeProof = await proveStoreLocality();
    record("setup", "the target reads the fake store (a nonce SET at the watchdog heartbeat key comes back on /health)", "/health watchdog.lastRun echoes the nonce", storeProof.detail, storeProof.ok, storeProof.ok ? undefined : "the exhaustion and halt sections are refused");
  }
  if (NETWORK === "mainnet" && MODE === "full" && !storeProof?.ok) die("full mode on mainnet is refused: the target did not prove it reads the fake store");

  if (spends) await onboardSender();
  if (!SKIP.has("a")) await sectionA();
  if (!SKIP.has("c")) await sectionC();
  if (!SKIP.has("b")) await sectionB();
  await sectionReclaim();
  if (!SKIP.has("d")) await sectionD();
  if (!SKIP.has("e")) await sectionE();

  after = await balances(sponsorAccount);
  closingHealth = await freshHealth();
  console.log(`\nsponsor balance after: ${after ? `${after.xlm} XLM, ${after.usdc} USDC` : "unreadable"}`);
  writeReport();
  if (rows.some((r) => r.status === "FAIL")) process.exit(1);
}

main().catch((e) => {
  console.error((e as Error).stack ?? String(e));
  die(`an unexpected error: ${(e as Error).message}`);
});
