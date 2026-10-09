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
import {
  arrivalDismissTarget,
  askPilotStatus,
  backupBlocksRealMoney,
  mainnetSwitchBlock,
  mainnetWarningPlan,
  readPilotStatus,
  type PilotRead,
  type PilotState,
} from "./pilot-access";

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
const same = (a: PilotRead | null, b: PilotRead | null) =>
  a === b || (a !== null && b !== null && a.mainnetApproved === b.mainnetApproved && a.pilotState === b.pilotState);

/** What the provider does with an ask's result: an answer replaces, a failed ask keeps the last. */
const settle = (last: PilotRead, read: PilotRead | null): PilotRead => read ?? last;

async function asks(): Promise<void> {
  const OPEN: PilotRead = { mainnetApproved: true, pilotState: "open" };
  const NONE: PilotRead = { mainnetApproved: false, pilotState: "none" };

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

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} PILOT ACCESS SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
