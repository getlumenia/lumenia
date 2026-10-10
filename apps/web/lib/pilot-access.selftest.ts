/**
 * Pilot-access self-test: the web half of the retirement switch (SOW 2, D3 item i).
 *
 * What it pins: with the mainnet sponsor's PILOT_MODE set, nothing changes (only approved wallets
 * may switch); with it unset (`pilot: false`), the web opens real money to every wallet that is
 * locked AND backed up, sends the others to do that first, and never reads `pilot: false` as "not
 * approved" (which would lock everyone out the day the switch is flipped).
 *
 * And, since the provider's own step is where both of its bugs lived, that step is driven here too
 * (askPilotStatus, with a fake fetch): a device with NO account asks without a pubkey and learns
 * the pilot is retired; a 429, a body that is not JSON, or no connection is a failed ask that keeps
 * the last answer, never "not approved". Plus the backup rule the wallet enforces where money
 * leaves (backupBlocksRealMoney), and the once-per-device real-money warning (mainnetWarningPlan),
 * including the arrival on real money that never passes through the switch.
 *
 * And the WORDS of that warning (lib/real-money.ts, decisions D1 and D2): the one sentence set,
 * verbatim and plain ASCII, the caps sentence after it, and every surface of this app that shows it
 * reading it from there rather than keeping a variant of its own. Plus the switch that retires the
 * public waitlist (`realMoneyOpen`, `waitlistCta`) and the four places that follow it.
 *
 * And the LUMENIA ACCOUNT CONTRACT v1 on the website: one standing table and one set of words for
 * every surface (contract 4 and 5.1), the ask signed by the account it is for (lib/pilot-ask.ts,
 * contract 1 and 3.2, driven against a fake sponsor), the approval link that names its account,
 * per-account approval, per-account totals, the idle lock, the Face ID password rule, the honest
 * "ways back in", and the privacy page's three disclosures (contract 5.6) word for word.
 *
 * RUN: pnpm --filter @lumenia/web test:pilotaccess   (offline, no keys, no network)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PILOT_DAY_CAP_USD,
  PILOT_SENDER_DAY_CAP_USD,
  PILOT_TX_CAP_USD,
  REAL_MONEY_WARNING,
  pilotCaps,
  pilotCapsShort,
  pilotCapsSentence,
  realMoneyOpen,
  waitlistCta,
} from "./real-money";
import { readdirSync, statSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import {
  approvalFor,
  approvalLinkPlan,
  arrivalDismissTarget,
  askPilotStatus,
  backupBlocksRealMoney,
  checkedAgo,
  mainnetSwitchBlock,
  mainnetWarningPlan,
  pilotStanding,
  readPilotStatus,
  standingAllowsRealMoney,
  standingCopy,
  type PilotRead,
  type PilotStanding,
  type PilotState,
} from "./pilot-access";
import { accountsForTotal } from "./accounts-total";
import { idleLockDue, lockPasswordPlan, OLD_BACKUP_PASSWORD_NOTE, DEFAULT_AUTO_LOCK, AUTO_LOCK_CHOICES } from "./lock";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  cond ? passed++ : failed++;
}

const SPONSOR = "https://mainnet-sponsor.invalid/";
const PUB = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/** A sponsor played by a fake fetch: `answer` decides the reply; every URL asked is recorded. */
function sponsor(answer: (url: string) => Response | "throw"): { fetchImpl: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const r = answer(url);
    if (r === "throw") throw new TypeError("Failed to fetch");
    return r;
  }) as typeof fetch;
  return { fetchImpl, asked };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Reading = Pick<PilotRead, "mainnetApproved" | "pilotState">;
const same = (a: PilotRead | null, b: Reading | null) =>
  a === b || (a !== null && b !== null && a.mainnetApproved === b.mainnetApproved && a.pilotState === b.pilotState);

/** What the provider does with an ask's result: an answer replaces, a failed ask keeps the last. */
const settle = (last: PilotRead, read: PilotRead | null): PilotRead => read ?? last;

async function asks(): Promise<void> {
  const OPEN: PilotRead = readPilotStatus({ pilot: false, approved: true, state: "open" });
  const NONE: PilotRead = readPilotStatus({ pilot: true, approved: false, state: "none" });

  console.log("\n[5] the provider's ask, WITHOUT an account (askPilotStatus)");
  {
    const s = sponsor(() => json(200, { pilot: false, approved: true, state: "open" }));
    const read = await askPilotStatus({ sponsorUrl: SPONSOR, pubkey: null, fetchImpl: s.fetchImpl });
    ok("a retired pilot is learned with no account at all: open", same(read, OPEN));
    ok("  ...asked with NO pubkey, at the sponsor's /pilot-status, no double slash", s.asked.length === 1 && s.asked[0] === "https://mainnet-sponsor.invalid/pilot-status");
  }
  {
    const s = sponsor(() => json(400, { error: "a valid pubkey is required" }));
    ok("a pilot-mode sponsor (400: pubkey required) is an answer: not open", same(await askPilotStatus({ sponsorUrl: SPONSOR, pubkey: null, fetchImpl: s.fetchImpl }), NONE));
  }
  {
    const s = sponsor(() => json(200, { pilot: true, approved: false }));
    ok("any other answer is 'none': no account is never 'approved'", same(await askPilotStatus({ sponsorUrl: SPONSOR, pubkey: null, fetchImpl: s.fetchImpl }), NONE));
  }
  {
    const s = sponsor(() => json(429, { error: "per-ip rate limit exceeded" }));
    ok("a 429 is a failed ask (null), not an answer", (await askPilotStatus({ sponsorUrl: SPONSOR, pubkey: null, fetchImpl: s.fetchImpl })) === null);
  }
  {
    const s = sponsor(() => "throw");
    ok("no connection is a failed ask (null)", (await askPilotStatus({ sponsorUrl: SPONSOR, pubkey: null, fetchImpl: s.fetchImpl })) === null);
  }

  console.log("\n[6] the provider's ask, WITH an account");
  {
    const s = sponsor(() => json(200, { pilot: false, approved: true, state: "open" }));
    const read = await askPilotStatus({ sponsorUrl: SPONSOR, pubkey: PUB, fetchImpl: s.fetchImpl });
    ok("the open answer reads as open", same(read, OPEN));
    ok("  ...asked for THIS wallet", s.asked[0] === `https://mainnet-sponsor.invalid/pilot-status?pubkey=${PUB}`);
  }
  {
    const s = sponsor(() => json(200, { pilot: true, approved: true, state: "approved", used: 1, limit: 5 }));
    ok("pilot on, approved: approved", same(await askPilotStatus({ sponsorUrl: SPONSOR, pubkey: PUB, fetchImpl: s.fetchImpl }), { mainnetApproved: true, pilotState: "approved" }));
  }
  {
    const s = sponsor(() => json(200, { pilot: true, approved: false, state: "pending" }));
    ok("pilot on, pending: not admitted", same(await askPilotStatus({ sponsorUrl: SPONSOR, pubkey: PUB, fetchImpl: s.fetchImpl }), { mainnetApproved: false, pilotState: "pending" }));
  }
  const failedAsks: [string, () => Response | "throw"][] = [
    ["a 429 body (the shared per-account bucket spent)", () => json(429, { error: "per-account rate limit exceeded" })],
    ["a body that is not JSON (a captive portal)", () => new Response("<html>Sign in to the network</html>", { status: 200 })],
    ["a 200 JSON body with no boolean pilot", () => json(200, { approved: false })],
    ["a 500", () => json(500, { error: "boom" })],
    ["a network error", () => "throw"],
  ];
  for (const [what, reply] of failedAsks) {
    const s = sponsor(reply);
    const read = await askPilotStatus({ sponsorUrl: SPONSOR, pubkey: PUB, fetchImpl: s.fetchImpl });
    ok(`${what}: a failed ask (null)`, read === null);
    ok("  ...so an open-mode user stays open, never demoted to 'invite-only'", same(settle(OPEN, read), OPEN));
  }
  {
    // The whole sequence the provider runs: open, then a rate-limited poll, then open again.
    let n = 0;
    const s = sponsor(() => (++n === 2 ? json(429, { error: "per-account rate limit exceeded" }) : json(200, { pilot: false, approved: true, state: "open" })));
    let state: PilotRead = NONE;
    for (let i = 0; i < 3; i++) state = settle(state, await askPilotStatus({ sponsorUrl: SPONSOR, pubkey: PUB, fetchImpl: s.fetchImpl }));
    ok("open, 429, open: open the whole way through", same(state, OPEN) && n === 3);
  }
}

function backupAndWarning(): void {
  console.log("\n[7] the backup rule, where money leaves (backupBlocksRealMoney)");
  const rule = (onMainnet: boolean, pilotState: PilotState, pilotKnown: boolean, backedUp: boolean) =>
    backupBlocksRealMoney({ onMainnet, pilotState, pilotKnown, backedUp });
  ok("pilot retired, on real money, no backup: blocked", rule(true, "open", true, false));
  ok("pilot retired, on real money, backed up: free", !rule(true, "open", true, true));
  ok("pilot on and approved: not re-gated (approval already required the backup)", !rule(true, "approved", true, false));
  ok("pilot on, not approved: not this rule's refusal (the sponsor's allowlist answers)", !rule(true, "none", true, false));
  ok("on real money before the sponsor has answered: blocked without a backup (fails closed)", rule(true, "none", false, false));
  ok("  ...and free with one", !rule(true, "none", false, true));
  ok("practice money is never held to it while the pilot is on", !rule(false, "none", false, false));
  ok("practice money with the pilot retired: blocked, so the checklist says 'back it up' before the switch", rule(false, "open", true, false));

  console.log("\n[8] the real-money warning, once per device (mainnetWarningPlan)");
  const arrive = mainnetWarningPlan({ trigger: "mount", network: "public", seen: false });
  ok(
    "arriving on real money unacknowledged (a mainnet claim, a device already there): shown",
    arrive.show === true && arrive.onConfirm === "mark-seen" && arrive.onDismiss === "back-to-practice",
  );
  ok("  ...'Not now' there may go back to practice money (where exactly is arrivalDismissTarget's call)", arrive.show && arrive.onDismiss === "back-to-practice");
  /* The arrival sheet must never strand someone on practice money who cannot switch back: in pilot
     mode a claim recipient not on the allowlist may hold real money (and cash it out) without
     approval, and every way back to real money answers "invite-only". */
  const pilotRecipient = mainnetSwitchBlock({ to: "public", mainnetApproved: false, pilotState: "none", account: { phase: 1 }, backedUp: false });
  ok("pilot mode, a recipient not on the allowlist: 'Not now' keeps the device on real money", arrivalDismissTarget(pilotRecipient) === "stay", String(pilotRecipient));
  const unknownYet = mainnetSwitchBlock({ to: "public", mainnetApproved: false, pilotState: "none", account: null, backedUp: false });
  ok("before /pilot-status has answered: 'Not now' keeps the device where it is (never a guess)", arrivalDismissTarget(unknownYet) === "stay");
  const openUnsecured = mainnetSwitchBlock({ to: "public", mainnetApproved: true, pilotState: "open", account: { phase: 1 }, backedUp: false });
  ok("pilot retired, an account not locked and backed up: 'Not now' keeps it on real money too", arrivalDismissTarget(openUnsecured) === "stay", String(openUnsecured));
  const free = mainnetSwitchBlock({ to: "public", mainnetApproved: true, pilotState: "open", account: { phase: 2 }, backedUp: true });
  ok("an account that may switch back any time: 'Not now' goes to practice money", arrivalDismissTarget(free) === "practice");
  ok("an approved pilot wallet too", arrivalDismissTarget(mainnetSwitchBlock({ to: "public", mainnetApproved: true, pilotState: "approved", account: { phase: 2 }, backedUp: true })) === "practice");
  ok("arriving on real money, already acknowledged: not shown", !mainnetWarningPlan({ trigger: "mount", network: "public", seen: true }).show);
  ok("arriving on practice money: not shown", !mainnetWarningPlan({ trigger: "mount", network: "testnet", seen: false }).show);
  const toReal = mainnetWarningPlan({ trigger: "switch", network: "public", seen: false });
  ok(
    "switching to real money unacknowledged: shown; 'I understand' marks it read and switches, 'Not now' stays",
    toReal.show === true && toReal.onConfirm === "mark-seen-and-switch" && toReal.onDismiss === "stay",
  );
  ok("switching to real money, acknowledged: not shown", !mainnetWarningPlan({ trigger: "switch", network: "public", seen: true }).show);
  ok("switching back to practice money: never shown", !mainnetWarningPlan({ trigger: "switch", network: "testnet", seen: false }).show);
}

/** apps/web, for the checks that read the screens themselves. */
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = (...parts: string[]): string => readFileSync(join(WEB_ROOT, ...parts), "utf8");

function warningWords(): void {
  console.log("\n[9] the real-money warning's words (D1) and the caps after it (D2)");
  ok(
    "the warning is D1, word for word",
    REAL_MONEY_WARNING ===
      "Real money on Lumenia is an early pilot. It has not been reviewed by an outside security firm yet. You can lose money, so keep amounts small.",
  );
  ok("  ...and carries all four things: early pilot, no outside review, you can lose money, keep amounts small", ["early pilot", "outside security firm", "You can lose money", "keep amounts small"].every((w) => REAL_MONEY_WARNING.includes(w)));
  const ascii = (t: string) => /^[\x20-\x7E]*$/.test(t);
  ok("  ...in plain ASCII (no curly quotes, no dashes), like the caps sentence", ascii(REAL_MONEY_WARNING) && ascii(pilotCapsSentence()));
  ok("the defaults are the mainnet Worker's caps today: $5 a link, $25 per sender a day, $50 a day in all", PILOT_TX_CAP_USD === "5" && PILOT_SENDER_DAY_CAP_USD === "25" && PILOT_DAY_CAP_USD === "50");
  ok("D2 long form", pilotCaps() === "$5 a link and up to $25 a day from you ($50 a day across the whole pilot)", pilotCaps());
  ok("D2 short form", pilotCapsShort() === "$5 a link, $25 a day", pilotCapsShort());
  ok("the caps sentence is its own sentence, after the warning, never folded into it", pilotCapsSentence().startsWith("The pilot caps") && !REAL_MONEY_WARNING.includes("$"));

  const surfaces: [string, string][] = [
    ["the sheet before the first switch", source("components", "brand", "MainnetWarningDialog.tsx")],
    ["/pilot", source("app", "(app)", "pilot", "page.tsx")],
    ["the ask-to-join sheet", source("components", "brand", "JoinPilotDialog.tsx")],
  ];
  for (const [name, src] of surfaces) {
    ok(`${name} shows REAL_MONEY_WARNING from lib/real-money.ts`, /import \{[^}]*\bREAL_MONEY_WARNING\b[^}]*\} from "[./]+lib\/real-money"/.test(src) && /\{REAL_MONEY_WARNING\}/.test(src));
    ok(
      `  ...and keeps no older variant of its own ("early preview", "keep amounts tiny", "afford to lose")`,
      !/early preview|keep amounts tiny|afford to lose/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")),
    );
  }
  const pilot = source("app", "(app)", "pilot", "page.tsx");
  ok("/pilot shows it in both of its states (pilot on, pilot retired), each followed by the caps", (pilot.match(/\{REAL_MONEY_WARNING\}/g) ?? []).length === 2 && (pilot.match(/\{pilotCapsSentence\(\)\}/g) ?? []).length === 2);

  console.log("\n[10] the waitlist's retirement switch (NEXT_PUBLIC_REAL_MONEY_OPEN)");
  const env = process.env as Record<string, string | undefined>;
  const before = env.NEXT_PUBLIC_REAL_MONEY_OPEN;
  try {
    delete env.NEXT_PUBLIC_REAL_MONEY_OPEN;
    ok("unset (today): real money is not open, and a waitlist call to action is the waitlist", !realMoneyOpen() && waitlistCta().href === "/waitlist" && waitlistCta().label === "Join the waitlist");
    env.NEXT_PUBLIC_REAL_MONEY_OPEN = "true";
    ok("  ...anything but the exact value 1 is still off", !realMoneyOpen());
    env.NEXT_PUBLIC_REAL_MONEY_OPEN = "1";
    ok("set to 1: open, and every waitlist call to action points at /start instead", realMoneyOpen() && waitlistCta().href === "/start" && waitlistCta().label === "Get started");
  } finally {
    if (before === undefined) delete env.NEXT_PUBLIC_REAL_MONEY_OPEN;
    else env.NEXT_PUBLIC_REAL_MONEY_OPEN = before;
  }
  const followers: [string, string][] = [
    ["the /waitlist page", source("app", "(site)", "waitlist", "page.tsx")],
    ["the landing's closing band", source("components", "site", "sections", "CloseCTA.tsx")],
    ["the footer", source("components", "site", "sections", "Footer.tsx")],
    ["/roadmap", source("app", "(site)", "roadmap", "page.tsx")],
  ];
  for (const [name, src] of followers) {
    ok(`${name} follows the switch (lib/real-money.ts) and hard-codes no waitlist link of its own`, /from "[./]+lib\/real-money"/.test(src) && /realMoneyOpen\(\)|waitlistCta\(\)/.test(src) && !/href=\{?"\/waitlist"\}?/.test(src) && !/\["Waitlist", "\/waitlist"\]/.test(src));
  }
}


/* ===========================================================================
 * LUMENIA ACCOUNT CONTRACT v1 on the website (W6 to W15).
 * ========================================================================= */

const ascii = (t: string) => /^[\x20-\x7E]*$/.test(t);
/** A source file with its comments removed, for "this screen never says X" checks. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

function standingTable(): void {
  console.log("\n[11] where an account stands: the same table everywhere (contract 4)");
  const of = (body: Record<string, unknown>) => pilotStanding(readPilotStatus(body));
  const rows: [Record<string, unknown>, PilotStanding][] = [
    [{ pilot: false, approved: true, state: "open" }, "open"],
    [{ pilot: true, state: "none", approved: false, used: 0, limit: 5, revoked: false }, "none"],
    [{ pilot: true, state: "pending", approved: false, used: 0, limit: 5, revoked: false }, "pending"],
    [{ pilot: true, state: "approved", approved: true, used: 2, limit: 5, revoked: false }, "approved"],
    [{ pilot: true, state: "approved", approved: true, used: 5, limit: 5, revoked: false }, "no-sends"],
    [{ pilot: true, state: "rejected", approved: false, used: 1, limit: 5, revoked: false }, "declined"],
    [{ pilot: true, state: "rejected", approved: false, used: 1, limit: 5, revoked: true }, "revoked"],
    [{ pilot: true, state: "approved", approved: false, used: 0, limit: 5 }, "revoked"],
    [{ pilot: true, approved: false }, "unknown"],
  ];
  for (const [body, want] of rows) ok(`${JSON.stringify(body)} -> ${want}`, of(body) === want, of(body));
  ok("a failed ask is unknown, never 'not approved'", pilotStanding(null) === "unknown" && pilotStanding(readPilotStatus({ pilot: true, state: "approved", approved: true }), { failed: true }) === "unknown");
  ok("an approved account with no limit said is approved, not no-sends", of({ pilot: true, state: "approved", approved: true }) === "approved");
  ok("the standings that may use real money: approved, no-sends, open", (["approved", "no-sends", "open"] as const).every(standingAllowsRealMoney) && !(["none", "pending", "declined", "revoked", "unknown", "checking"] as const).some(standingAllowsRealMoney));
  ok("checkedAgo: the age of a stale answer", checkedAgo(0, 30_000) === "Checked just now." && checkedAgo(0, 60_000) === "Checked 1 minute ago." && checkedAgo(0, 7 * 60_000) === "Checked 7 minutes ago." && checkedAgo(null) === "");
}

async function standingAsks(): Promise<void> {
  const s = sponsor(() => json(200, { pilot: true, approved: false }));
  ok("HTTP 200 {pilot:true, approved:false} with no state, for a wallet: a failed ask -> unknown", pilotStanding(await askPilotStatus({ sponsorUrl: SPONSOR, pubkey: PUB, fetchImpl: s.fetchImpl })) === "unknown");
  const d = sponsor(() => json(503, { error: "pilot store unavailable" }));
  ok("HTTP 503 -> unknown", pilotStanding(await askPilotStatus({ sponsorUrl: SPONSOR, pubkey: PUB, fetchImpl: d.fetchImpl })) === "unknown");
  const n = sponsor(() => json(200, { pilot: true, state: "none", approved: false, used: 0, limit: 5, revoked: false }));
  const read = await askPilotStatus({ sponsorUrl: SPONSOR, pubkey: PUB, fetchImpl: n.fetchImpl });
  ok("the whole answer is kept: used, limit and revoked", read !== null && read.used === 0 && read.limit === 5 && read.revoked === false && read.state === "none");
}

const SHORT = "GCFIRY...XVYOJR";
function standingWords(): void {
  console.log("\n[12] the standing's words (contract 5.1), exactly, in ASCII");
  const want: Record<Exclude<PilotStanding, "checking">, [string, string, string | null]> = {
    none: ["Real money is invite-only for now.", `Ask to join with this account (${SHORT}).`, "Ask to join"],
    pending: ["You're on the list.", `We'll email you when this account (${SHORT}) is approved.`, "Check again"],
    approved: ["You're approved for real money.", `This account (${SHORT}) has 3 of 5 real-money sends left.`, "Switch to real money"],
    "no-sends": [
      "No real-money sends left.",
      `This account (${SHORT}) has used all 5 of its real-money sends. Your money stays yours: you can still receive it, cash it out and take links back.`,
      "Ask for more sends",
    ],
    declined: ["Not approved for now.", `This account (${SHORT}) isn't approved for real money yet. If you think we got it wrong, reply to our email.`, null],
    revoked: [
      "Real money is off for this account.",
      `We took this account (${SHORT}) off real money. Your money stays yours: you can still receive it, cash it out and take links back.`,
      null,
    ],
    open: ["Real money is open to everyone.", "Every link is capped.", "Switch to real money"],
    unknown: ["We couldn't check real money for this account.", "Try again in a minute.", "Try again"],
  };
  for (const [standing, [title, line, action]] of Object.entries(want) as [Exclude<PilotStanding, "checking">, [string, string, string | null]][]) {
    const c = standingCopy(standing, { short: SHORT, left: 3, limit: 5 });
    ok(`${standing}: "${title}"`, c.title === title && c.line === line && c.action === action, `${c.title} | ${c.line} | ${c.action}`);
    ok("  ...plain ASCII", ascii(c.title) && ascii(c.line) && (c.action === null || ascii(c.action)));
  }
  ok("checking: 'Checking real money for this account.'", standingCopy("checking", { short: SHORT }).title === "Checking real money for this account.");
  // As in the extension (lib/standing.ts): a limit the sponsor did not report is never "0 of 0".
  ok(
    "a limit not reported is not read out as a number",
    standingCopy("approved", { short: SHORT, left: 0, limit: 0 }).line === `This account (${SHORT}) is approved for real money.` &&
      standingCopy("approved", { short: SHORT, left: null, limit: null }).line === `This account (${SHORT}) is approved for real money.` &&
      standingCopy("no-sends", { short: SHORT, limit: null }).line.startsWith(`This account (${SHORT}) has used all of its real-money sends.`),
  );
  ok("no standing ever says 'still on the list'", (["none", "pending", "approved", "no-sends", "declined", "revoked", "open", "unknown", "checking"] as const).every((st) => !JSON.stringify(standingCopy(st, { short: SHORT, left: 1, limit: 5 })).includes("still on the list")));
}

const PILOT_GOLDEN = {
  pubkey: "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR",
  email: "  Founder@Example.com ",
  emailId: "fb72704240c3527ba45904a8705865922f70a9c4f3c11bfa93c839f939945884",
  message:
    "lumenia-handle-pilot:v1:fb72704240c3527ba45904a8705865922f70a9c4f3c11bfa93c839f939945884:GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR:1760000000:0123456789abcdef:mainnet",
  proof: "kZuq86B7rr9BIoSE0Mb2wqfQ2dgxLoRRVLRbT5JHnAvZuizmWtof0me3rY80wPHUfwA0XYWChj4FA8vtTEGnDg==",
};
const MAINNET_HOST = "https://lumenia-sponsor-mainnet.avakit.workers.dev";
const TESTNET_HOST = "https://lumenia-sponsor.avakit.workers.dev";

/** A sponsor that also records each request body; `answer` sees the URL and the body. */
function recorder(answer: (url: string, body: Record<string, unknown>) => Response | "throw") {
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, method: init?.method ?? "GET", body });
    const r = answer(url, body);
    if (r === "throw") throw new TypeError("Failed to fetch");
    return r;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function theAsk(): Promise<void> {
  await standingAsks();
  standingWords();

  console.log("\n[13] the ask is signed by the account it is for (lib/pilot-ask.ts, contract 1 and 3.2)");
  // A build with real money configured, so the pilot host is the mainnet Worker. Set before the
  // first import of lib/network.ts, which reads it when it loads.
  const env = process.env as Record<string, string | undefined>;
  env.NEXT_PUBLIC_SPONSOR_URL_MAINNET = MAINNET_HOST;
  env.NEXT_PUBLIC_LUMENDROP_CONTRACT_MAINNET = "CTESTMAINNETCONTRACTFORTHESELFTESTONLY";
  delete env.NEXT_PUBLIC_SPONSOR_URL;
  const ask = await import("./pilot-ask");
  const { localSignerFromSeed } = await import("./signer");
  const { emailId, signOwnerProof } = await import("./owner-proof");
  const signer = localSignerFromSeed(new Uint8Array(32).fill(1)); // TEST-ONLY
  const pk = signer.publicKey();
  const id = await emailId(PILOT_GOLDEN.email);
  const verifies = (message: string, proof: string) => Keypair.fromPublicKey(pk).verify(Buffer.from(message), Buffer.from(proof, "base64"));

  ok("the golden account and email id", pk === PILOT_GOLDEN.pubkey && id === PILOT_GOLDEN.emailId);
  ok("the golden pilot/mainnet message, byte for byte", ask.pilotProofMessage(id, pk, 1760000000, "0123456789abcdef", "mainnet") === PILOT_GOLDEN.message);
  ok("the golden pilot/mainnet signature", (await signOwnerProof(signer, "pilot", id, "mainnet", { ts: 1760000000, nonce: "0123456789abcdef" })).proof === PILOT_GOLDEN.proof);
  ok("the pilot host is the real-money Worker, and signs for mainnet", ask.pilotHost() === MAINNET_HOST && ask.pilotHostNetwork(MAINNET_HOST) === "mainnet" && ask.pilotHostNetwork(`${MAINNET_HOST}/`) === "mainnet");
  ok("  ...the practice Worker signs for testnet", ask.pilotHostNetwork(TESTNET_HOST) === "testnet");

  const CODE_FIRST = "Confirm your email with a code first.";
  {
    // The /pilot sequence: ask with no code; the server asks for one; mail it; ask again with it.
    let round = 0;
    const s = recorder((url) => {
      if (url.endsWith("/recovery-otp")) return json(200, { ok: true });
      round++;
      return round === 1 ? json(401, { error: CODE_FIRST, code: "code-required" }) : json(200, { ok: true, state: "pending", filed: true });
    });
    const first = await ask.askToJoin({ host: ask.pilotHost(), signer, email: PILOT_GOLDEN.email, src: "web", fetchImpl: s.fetchImpl });
    const b1 = s.calls[0]!.body;
    const owner = b1.owner as { pubkey: string; ts: number; nonce: string; proof: string };
    ok("the first ask goes to the pilot host's /pilot-request", s.calls[0]!.url === `${MAINNET_HOST}/pilot-request` && s.calls[0]!.method === "POST");
    ok("  ...with this account's pubkey, the trimmed email, src 'web', and NO code", b1.pubkey === pk && b1.email === "Founder@Example.com" && b1.src === "web" && !("code" in b1));
    ok("  ...and an owner proof over the mainnet pilot message that Keypair.verify accepts", owner.pubkey === pk && verifies(ask.pilotProofMessage(id, pk, owner.ts, owner.nonce, "mainnet"), owner.proof));
    ok("  ...never over the testnet one", !verifies(ask.pilotProofMessage(id, pk, owner.ts, owner.nonce, "testnet"), owner.proof));
    ok("code-required comes back typed, with the server's sentence", !first.ok && first.code === "code-required" && first.message === CODE_FIRST);
    await ask.requestPilotCode(ask.pilotHost(), PILOT_GOLDEN.email, { fetchImpl: s.fetchImpl });
    const otp = s.calls[1]!;
    ok("the code is asked for on the SAME host, with purpose 'pilot'", otp.url === `${MAINNET_HOST}/recovery-otp` && otp.body.purpose === "pilot" && otp.body.email === "Founder@Example.com");
    const second = await ask.askToJoin({ host: ask.pilotHost(), signer, email: PILOT_GOLDEN.email, code: "123456", src: "web", fetchImpl: s.fetchImpl });
    ok("the next ask carries the code", s.calls[2]!.body.code === "123456" && s.calls[2]!.url === `${MAINNET_HOST}/pilot-request`);
    ok("  ...and a fresh proof (the server refuses a message it has seen)", (s.calls[2]!.body.owner as { nonce: string }).nonce !== owner.nonce);
    ok("filed: state pending, filed true", second.ok && second.state === "pending" && second.filed && !second.already);
    if (second.ok) {
      ok("  ...shown as 'Request sent.'", ask.askView(second, false) === "filed");
      const c = ask.askResultCopy("filed", { short: SHORT, masked: "f***@example.com" });
      ok("  ...in the contract's words", c.title === "Request sent." && c.line === `We'll email f***@example.com when this account (${SHORT}) is approved.`);
    }
  }
  {
    const s = recorder((url) =>
      url.includes("/pilot-status") ? json(200, { pilot: true, state: "pending", approved: false, used: 0, limit: 5, revoked: false }) : json(200, { ok: true }),
    );
    const r = await ask.askToJoin({ host: ask.pilotHost(), signer, email: PILOT_GOLDEN.email, src: "web", fetchImpl: s.fetchImpl });
    ok("an older server's bare {ok:true}: no state, so nothing is claimed yet", r.ok && r.state === null);
    const settled = await ask.settleAsk({ host: ask.pilotHost(), pubkey: pk, result: r, fetchImpl: s.fetchImpl });
    ok("  ...the status is re-read for THIS account", s.calls.some((c) => c.url === `${MAINNET_HOST}/pilot-status?pubkey=${pk}`));
    ok("  ...and the view follows it: pending", settled.ok && settled.state === "pending");
    const none = recorder((url) => (url.includes("/pilot-status") ? json(200, { pilot: true, state: "none", approved: false, used: 0, limit: 5, revoked: false }) : json(200, { ok: true })));
    const dropped = await ask.settleAsk({ host: ask.pilotHost(), pubkey: pk, result: { ok: true, state: null, filed: false, already: false }, fetchImpl: none.fetchImpl });
    ok("an ok the status does not bear out ('none'): 'didn't go through', never 'sent'", !dropped.ok && dropped.message === ask.ASK_DID_NOT_GO_THROUGH);
    const down = recorder(() => json(503, { error: "pilot store unavailable" }));
    const unconfirmed = await ask.settleAsk({ host: ask.pilotHost(), pubkey: pk, result: { ok: true, state: null, filed: false, already: true }, fetchImpl: down.fetchImpl });
    ok("an ok the status cannot confirm: said as such", !unconfirmed.ok && unconfirmed.message === ask.ASK_UNCONFIRMED);
    const untouched = { ok: true as const, state: "pending" as const, filed: false, already: true };
    ok("a result that has its state is not re-read", (await ask.settleAsk({ host: ask.pilotHost(), pubkey: pk, result: untouched, fetchImpl: down.fetchImpl })) === untouched && down.calls.length === 1);
  }
  {
    const TAKEN = "That email backs up another Lumenia account. Ask with the email that backs up this one.";
    const refusals: [string, Response, string][] = [
      ["email-taken (409) surfaces the server sentence", json(409, { error: TAKEN, code: "email-taken" }), "email-taken"],
      ["bad-proof (401)", json(401, { error: "We couldn't confirm this account signed the request. Check your device clock and try again.", code: "bad-proof" }), "bad-proof"],
      ["bad-code (401)", json(401, { error: "That code is wrong or has expired.", code: "bad-code" }), "bad-code"],
      ["proof-required (400)", json(400, { error: "Reload the page and ask again.", code: "proof-required" }), "proof-required"],
      ["store-unavailable (503)", json(503, { error: "We couldn't record that just now. Try again in a minute.", code: "store-unavailable" }), "store-unavailable"],
      ["rate-limited (429)", json(429, { error: "per-ip rate limit exceeded" }), "rate-limited"],
    ];
    for (const [what, res, want] of refusals) {
      const body = (await res.clone().json()) as { error: string };
      const r = await ask.askToJoin({ host: ask.pilotHost(), signer, email: PILOT_GOLDEN.email, src: "web", fetchImpl: recorder(() => res).fetchImpl });
      ok(what, !r.ok && r.code === want && r.message === body.error, !r.ok ? `${r.code}: ${r.message}` : "ok");
    }
    const offline = await ask.askToJoin({ host: ask.pilotHost(), signer, email: PILOT_GOLDEN.email, src: "web", fetchImpl: recorder(() => "throw").fetchImpl });
    ok("no connection: a refusal that says so, never 'sent'", !offline.ok && offline.code === "failed");
    const noSign = { kind: "passkey-smart-account" as const, publicKey: () => pk, sign: async (t: never) => t };
    const silent = recorder(() => json(200, { ok: true, state: "pending" }));
    const r = await ask.askToJoin({ host: ask.pilotHost(), signer: noSign, email: PILOT_GOLDEN.email, src: "web", fetchImpl: silent.fetchImpl });
    ok("an account that cannot sign is refused before anything is sent", !r.ok && silent.calls.length === 0);
  }
  {
    const also = await ask.askToJoin({
      host: ask.pilotHost(),
      signer,
      email: PILOT_GOLDEN.email,
      src: "web",
      fetchImpl: recorder(() => json(200, { ok: true, state: "pending", filed: false, already: true, emailAlsoFor: "GBBD47...FLA5" })).fetchImpl,
    });
    ok("already pending: 'You've already asked.', with the other wallet this email asked for", also.ok && ask.askView(also, false) === "already" && also.emailAlsoFor === "GBBD47...FLA5");
    ok("  ...'This email also asked to join for account {other}.'", ask.alsoAskedLine("GBBD47...FLA5") === "This email also asked to join for account GBBD47...FLA5.");
    const a = ask.askResultCopy("already", { short: SHORT, masked: "f***@example.com" });
    ok("  ...in the contract's words", a.title === "You've already asked." && a.line === `This account (${SHORT}) is on the list. We'll email f***@example.com when it is approved.`);
    const more = { ok: true as const, state: "approved" as const, filed: true, already: true };
    ok("approved, all sends used, mailed now: 'Asked for more sends.'", ask.askView(more, true) === "more-filed" && ask.askResultCopy("more-filed", { short: SHORT, masked: "f***@example.com" }).title === "Asked for more sends.");
    ok("  ...not mailed now: 'You've already asked for more sends.', same line", ask.askView({ ...more, filed: false }, true) === "more-already" && ask.askResultCopy("more-already", { short: SHORT, masked: "f***@example.com" }).line === `We'll email f***@example.com when this account (${SHORT}) can send again.`);
    ok("approved with sends left, or declined: the standing says it, no result screen", ask.askView({ ...more, filed: false }, false) === "standing" && ask.askView({ ok: true, state: "rejected", filed: false, already: true }, false) === "standing");
    const words = [ask.ASK_COPY.heading, ask.ASK_COPY.emailKnown("f***@example.com"), ask.ASK_COPY.emailHint(SHORT), ask.ASK_COPY.codeStep("founder@example.com"), ask.ASK_COPY.extensionNote];
    ok("the form's words (contract 5.2)", words.join("|") === `Ask to join real money|We'll use the email that backs up this account: f***@example.com.|Use the email that backs up this account (${SHORT}).|We sent a 6-digit code to founder@example.com. Enter it to confirm this email is yours.|Asking for an account in the Lumenia extension? Open the extension and ask from Real money there.`);
    ok("  ...and its buttons", ask.ASK_COPY.ask === "Ask to join" && ask.ASK_COPY.asking === "Asking" && ask.ASK_COPY.askMore === "Ask for more sends" && ask.ASK_COPY.useDifferentEmail === "Use a different email" && ask.ASK_COPY.codeField === "6-digit code");
    ok("  ...all ASCII", [...words, ask.ASK_DID_NOT_GO_THROUGH, ask.ASK_UNCONFIRMED].every(ascii));
  }
}

function smallRules(): void {
  console.log("\n[14] the approval link names its account (W8)");
  const A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const B = PUB;
  const C = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
  ok("for the account in use: switch, as before", approvalLinkPlan(A, A, [A, B]) === "switch");
  ok("for another account on this device: offer to use it, never switch silently", approvalLinkPlan(B, A, [A, B]) === "offer-use");
  ok("for an account not on this device: offer to bring it here", approvalLinkPlan(C, A, [A, B]) === "offer-bring");
  ok("an old link with no for=: switch, as before", approvalLinkPlan(null, A, [A]) === "switch");
  ok("for= is read from the fragment, and only a well-formed address", approvalFor(`#for=${C}`) === C && approvalFor(`#x=1&for=${B}`) === B && approvalFor("#for=GNOTANADDRESS") === null && approvalFor("") === null);
  const accountPage = source("app", "(app)", "account", "page.tsx");
  ok(
    "/account decides nothing before the fragment is read (the switch runs in the same commit as the read)",
    /useState<string \| null \| undefined>\(undefined\)/.test(accountPage) && /forPubkey === undefined\s*\?\s*null/.test(accountPage) && /if \(plan !== "switch"\) return;/.test(accountPage),
  );
  ok("  ...and 'Use {forShort}' comes back to the same approval link after the switch", /switchAccount\(forPubkey, `\/account\?switch=mainnet#for=\$\{forPubkey\}`\)/.test(accountPage));

  console.log("\n[15] one balance per account (W10, lib/accounts-total.ts)");
  const accounts = [
    { address: "GHOME", kind: "user" as const },
    { address: "GSECOND", kind: "user" as const },
    { address: "GCLAIM1", kind: "throwaway" as const },
    { address: "GCLAIM2", kind: "throwaway" as const },
  ];
  const total = accountsForTotal("GHOME", accounts);
  ok("the account in use and the claim accounts are added up", total.includes("GHOME") && total.includes("GCLAIM1") && total.includes("GCLAIM2"));
  ok("  ...another deliberate account is NOT", !total.includes("GSECOND"));
  ok("  ...switching makes the other one the total, never both", JSON.stringify(accountsForTotal("GSECOND", accounts)) === JSON.stringify(["GSECOND", "GCLAIM1", "GCLAIM2"]));
  ok("  ...the active account counts even before the keystore lists it", JSON.stringify(accountsForTotal("GNEW", [])) === JSON.stringify(["GNEW"]));

  console.log("\n[16] the website locks itself (W11, lib/lock.ts idleLockDue)");
  const MIN = 60_000;
  ok("the default is 15 minutes, and the choices are 5, 15, 60", DEFAULT_AUTO_LOCK === 15 && AUTO_LOCK_CHOICES.join(",") === "5,15,60");
  ok("in use: not due", !idleLockDue(0, null, 15, 14 * MIN));
  ok("15 minutes with no input: due", idleLockDue(0, null, 15, 15 * MIN));
  ok("hidden for the whole time, with input just before: due when it comes back", idleLockDue(10 * MIN, 10 * MIN, 5, 15 * MIN));
  ok("hidden for less than the limit, input just before: not due", !idleLockDue(12 * MIN, 12 * MIN, 5, 15 * MIN));
  ok("a 60-minute choice is honored", !idleLockDue(0, null, 60, 59 * MIN) && idleLockDue(0, null, 60, 60 * MIN));
  const wallet = source("lib", "wallet.tsx");
  ok("the wallet wipes the session key when it is due, and a new account starts locked", /idleLockDue\(/.test(wallet) && /const lockNow = useCallback\(\(\) => \{\s*sessionSeed\.current\?\.fill\(0\);/.test(wallet) && /createUserAccount\([\s\S]{0,400}setUnlocked\(false\)/.test(wallet));
  const menu = source("components", "brand", "AccountMenu.tsx");
  ok("the account menu offers 'Lock now' and the 5/15/60 choice", menu.includes("Lock now") && /AUTO_LOCK_CHOICES\.map/.test(menu));

  console.log("\n[17] Face ID and the backup password (W12, lib/lock.ts lockPasswordPlan)");
  ok("the typed password opens this account's own backup: lock with it, even if short", lockPasswordPlan(true, false) === "lock-verified" && lockPasswordPlan(true, true) === "lock-verified");
  ok("it does not open the backup and is strong: lock, and say the backup still opens with the old one", lockPasswordPlan(false, true) === "lock-new-warn");
  ok("no password copy to compare with, strong: lock", lockPasswordPlan(null, true) === "lock-new");
  ok("a new password below the floor: refused, as before", lockPasswordPlan(false, false) === "too-weak" && lockPasswordPlan(null, false) === "too-weak");
  ok("the warning's words", OLD_BACKUP_PASSWORD_NOTE === "Your email backup still opens with your old password. Use that one, or choose a new one and back up again.");
}

/** Every .ts/.tsx under apps/web, outside node_modules and .next. */
function webFiles(dir = WEB_ROOT, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "test-results" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) webFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function pagesAndWords(): void {
  console.log("\n[18] every standing surface reads the standing, and none says 'still on the list' (W6)");
  const surfaces: [string, string][] = [
    ["NetworkSwitcher", source("components", "brand", "NetworkSwitcher.tsx")],
    ["PilotStatusBadge", source("components", "brand", "PilotStatusBadge.tsx")],
    ["PilotStatusChip", source("components", "brand", "PilotStatusChip.tsx")],
    ["/activate", source("app", "(app)", "activate", "page.tsx")],
    ["/send", source("app", "(app)", "send", "page.tsx")],
    ["/pilot", source("app", "(app)", "pilot", "page.tsx")],
  ];
  for (const [name, src] of surfaces) {
    ok(`${name} reads pilotStanding and the standing's words`, /\bpilotStanding\b/.test(src) && /\bstandingCopy\(|standingAllowsRealMoney\(/.test(src));
    ok(`  ...and never says 'still on the list'`, !/still on the list/i.test(code(src)));
  }
  const send = code(source("app", "(app)", "send", "page.tsx"));
  ok("/send: 'pilot limit reached' becomes the no-sends words, with 'Ask for more sends'", /pilot limit reached/.test(send) && /standingCopy\("no-sends"/.test(send) && /refusedByPilot === "no-sends"/.test(send) && send.includes("Ask for more sends"));
  ok("/send: 'Ask to join' only for a never-asked account", /pilotStanding === "none" \? \(\s*<Link href="\/pilot"[^>]*>\s*Ask to join\s*<\/Link>/.test(send) && !send.includes("Ask to join the pilot"));
  const activate = code(source("app", "(app)", "activate", "page.tsx"));
  ok("/activate: the pilot step is done for approved, no-sends and open", /const isApproved = standingAllowsRealMoney\(pilotStanding\)/.test(activate));
  ok("/activate: 'Bring my money back' goes to /start?step=restore", /href="\/start\?step=restore"[\s\S]{0,200}Bring my money back/.test(activate));

  console.log("\n[19] /pilot: the standing first, then a signed ask (W7)");
  const pilot = source("app", "(app)", "pilot", "page.tsx");
  const pilotCode = code(pilot);
  ok("/pilot asks through lib/pilot-ask.ts, never posting /pilot-request itself", /from "[./]+lib\/pilot-ask"/.test(pilot) && !/fetch\(/.test(pilotCode) && !pilotCode.includes("/pilot-request"));
  ok("  ...and the form renders only under a standing that asks: none, or no-sends", (pilotCode.match(/<AskForm\b/g) ?? []).length === 2 && /pilotStanding === "no-sends" && \(\s*<>[\s\S]{0,120}<AskForm moreSends\b/.test(pilotCode) && /pilotStanding === "none" && \(\s*<>[\s\S]*?<AskForm moreSends=\{false\}/.test(pilotCode));
  ok("  ...code-required asks for a pilot code, then asks with it", /r\.code === "code-required"[\s\S]{0,120}requestPilotCode\(host, email\)/.test(pilotCode));
  ok("  ...a locked account goes to /unlock?next=/pilot", pilotCode.includes('`/unlock?next=${encodeURIComponent("/pilot")}`'));
  ok("  ...and the extension line is on the page", pilotCode.includes("ASK_COPY.extensionNote"));
  const dialog = code(source("components", "brand", "JoinPilotDialog.tsx"));
  ok("JoinPilotDialog no longer posts to /pilot-request", !dialog.includes("/pilot-request"));
  ok("  ...and sends a person with no account to make one first", dialog.includes("Real money is approved one account at a time. Make your account first, then ask from it.") && dialog.includes("Make my account first") && dialog.includes("We&apos;ll email you when real money opens to everyone."));

  console.log("\n[20] approval is per account (W9)");
  const card = source("components", "brand", "AccountsCard.tsx");
  ok("AccountsCard: only an approved account opens another on real money, and the new one asks on its own", card.includes("On real money, only an approved account can open another one, and the new one asks to join real money on its own."));
  ok("  ...says so above the button when it may", card.includes("The new account asks to join real money on its own."));
  ok("  ...and no longer says new accounts open once you are on the list", !card.includes("On real money, new accounts open once you are on the pilot list."));

  console.log("\n[21] ways back in say what they do (W13)");
  const ways = source("components", "brand", "WaysBackIn.tsx");
  const callers = webFiles().filter(
    (f) => !f.endsWith(join("lib", "identity.ts")) && !f.endsWith(".selftest.ts") && /\bfetchByIdentity\b/.test(code(readFileSync(f, "utf8"))),
  );
  ok("fetchByIdentity still has no caller on the website", callers.length === 0, callers.join(", "));
  ok("  ...so WaysBackIn promises no restore: no 'finds this account'", !/finds this account/i.test(ways));
  ok("  ...and says how an account does come back", ways.includes("To bring an account back on a new phone, use its backup email and password, or Face ID."));

  console.log("\n[22] the privacy page says what the code does (W15, contract 5.6)");
  const privacy = source("app", "(site)", "privacy", "page.tsx");
  const D1 = "To check the pilot: your account's public key, to the real-money server, when you press Real money or Check again, while you use real money, and while this account's request to join is waiting.";
  const D2 = "To ask to join real money: your account's public key, the email that backs it up, a signature from your account and, if asked, a 6-digit code, to the real-money server.";
  const D3 = "On this device: the email each account is backed up with, so it can show it to you and use it when you ask to join.";
  ok("D1 word for word", privacy.includes(`"${D1}"`));
  ok("D2 word for word", privacy.includes(`"${D2}"`));
  ok("D3 word for word", privacy.includes(`"${D3}"`));
  ok("  ...each one rendered", /<Disclosure text=\{DISCLOSE_PILOT_CHECK\} \/>/.test(privacy) && /<Disclosure text=\{DISCLOSE_PILOT_ASK\} \/>/.test(privacy) && /<Disclosure text=\{DISCLOSE_BACKUP_EMAIL\} \/>/.test(privacy));
  ok("the backup paragraph no longer hedges with 'normally', and names the older backups", !/normally\s+carries/.test(privacy) && privacy.includes("Backups made before 30 August 2026,") && privacy.includes("and some made since by an older version of this site"));
  ok("the pilot paragraph: signed, email proven, 90 days, nothing dropped silently", ["signed by your account", "6-digit code", "for 90 days", "No application is dropped silently"].every((w) => privacy.includes(w)));
  ok("the website section: the email each account was backed up with", privacy.includes("This browser keeps, for each account on it, the email it was backed up with."));
}

async function main(): Promise<void> {
  console.log("============================================================");
  console.log(" SELF-TEST: who may switch to real money (pilot on, pilot retired)");
  console.log("============================================================\n");

  console.log("[1] reading /pilot-status");
  const retired = readPilotStatus({ pilot: false, approved: true, state: "open" });
  ok("pilot:false (the switch flipped) reads as open and admitted", retired.pilotState === "open" && retired.mainnetApproved);
  const retiredOld = readPilotStatus({ pilot: false, approved: false });
  ok("pilot:false from a Worker before this change (approved:false) still reads as open, never as 'not approved'", retiredOld.pilotState === "open" && retiredOld.mainnetApproved);
  const approved = readPilotStatus({ pilot: true, approved: true, state: "approved" });
  ok("pilot:true + approved reads as approved", approved.pilotState === "approved" && approved.mainnetApproved);
  const pending = readPilotStatus({ pilot: true, approved: false, state: "pending" });
  ok("pilot:true + pending is not admitted", pending.pilotState === "pending" && !pending.mainnetApproved);
  const rejected = readPilotStatus({ pilot: true, approved: false, state: "rejected" });
  ok("pilot:true + rejected is not admitted", rejected.pilotState === "rejected" && !rejected.mainnetApproved);
  const junk = readPilotStatus({ pilot: true, approved: "yes", state: "superuser" });
  ok("an unknown state fails soft to 'none', and a non-boolean approved is not approval", junk.pilotState === "none" && !junk.mainnetApproved);
  const spoofed = readPilotStatus({ pilot: true, approved: false, state: "open" });
  ok("'open' is only ever derived from pilot:false, never taken from the state field", spoofed.pilotState === "none" && !spoofed.mainnetApproved);
  ok("an empty answer is 'none', not admitted", readPilotStatus({}).pilotState === "none" && !readPilotStatus({}).mainnetApproved);

  console.log("[2] who may switch, with the pilot ON (PILOT_MODE=1): nothing changes");
  const on = (state: PilotState, admitted: boolean, phase: number | null, backedUp: boolean) =>
    mainnetSwitchBlock({ to: "public", mainnetApproved: admitted, pilotState: state, account: phase === null ? null : { phase }, backedUp });
  ok("an approved, locked, backed-up wallet may switch", on("approved", true, 2, true) === null);
  ok("an approved wallet is not re-gated by this module (its approval already required the lock and the backup)", on("approved", true, 1, false) === null);
  ok("a pending wallet is invite-only", on("pending", false, 2, true) === "invite-only");
  ok("a wallet that never asked is invite-only", on("none", false, 2, true) === "invite-only");
  ok("no account and no approval is invite-only", on("none", false, null, false) === "invite-only");

  console.log("[3] who may switch, with the pilot RETIRED (PILOT_MODE unset)");
  ok("a locked and backed-up wallet may switch, with no approval of its own", on("open", true, 2, true) === null);
  ok("a locked wallet without a backup is sent to back up first", on("open", true, 2, false) === "secure-first");
  ok("an unlocked wallet is sent to lock and back up first", on("open", true, 1, true) === "secure-first");
  ok("an unlocked wallet with no backup likewise", on("open", true, 1, false) === "secure-first");
  ok("a device with no account yet may switch (the account it makes there moves nothing until it is locked and backed up)", on("open", true, null, false) === null);
  ok(
    "  ...and that holds: such an account is blocked from moving money until it is backed up",
    backupBlocksRealMoney({ onMainnet: true, pilotState: "open", pilotKnown: true, backedUp: false }),
  );

  console.log("[4] switching back to practice money is never blocked");
  ok("pilot on, not approved", mainnetSwitchBlock({ to: "testnet", mainnetApproved: false, pilotState: "none", account: { phase: 1 }, backedUp: false }) === null);
  ok("pilot retired, not locked", mainnetSwitchBlock({ to: "testnet", mainnetApproved: true, pilotState: "open", account: { phase: 1 }, backedUp: false }) === null);

  await asks();
  backupAndWarning();
  warningWords();
  standingTable();
  await theAsk();
  smallRules();
  pagesAndWords();

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} PILOT ACCESS SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
