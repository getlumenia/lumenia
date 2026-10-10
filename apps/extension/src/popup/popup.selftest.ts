/**
 * Offline checks for the popup's pure parts: the sentence filter, the refusal copy, the amount and
 * link-window helpers. The refusal copy is checked mechanically against the product's word law, so a
 * later edit that slips "gasless" or a ledger term into a money screen fails here, not in review.
 *
 * Also the sentences the extension shares word for word with the other surfaces (lib/copy.ts: the
 * real-money note, the pilot's caps, the note under a typed name), the empty From field of every new
 * link, and the store listing text (store/description.txt, store/amo-listed.json) and this package's
 * README, which have to say the same.
 *
 * And the account model of the LUMENIA ACCOUNT CONTRACT v1 that the website shares: the standing
 * table and its golden rows (section 4), the standing copy (5.1), the ask-to-join results (5.2), the
 * account line (5.3), the backup conflict and restore copy (5.4, 5.5), and the disclosures (5.6),
 * each held to the contract's exact words.
 *
 *   pnpm --filter @lumenia/extension exec tsx src/popup/popup.selftest.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import {
  CAPS,
  CAPS_SENTENCE,
  CAPS_SHORT,
  DISCLOSE_EMAIL_KEPT,
  DISCLOSE_PILOT_ASK,
  DISCLOSE_PILOT_CHECK,
  EMAIL_HINT,
  NAME_NOTE,
  REAL_MONEY_WARNING,
  disclosureParts,
} from "../lib/copy";
import { MESSAGES } from "../lib/errors";
import { maskEmail as maskEmailLib, shortAddress as shortLib } from "../lib/identity";
import { CHECKING, pilotStanding, standingCopy, standingRefusal, type Standing } from "../lib/standing";
import type { ErrorCode, LinkRecord, PilotInfo } from "../lib/types";
import { EMPTY_DRAFT, draftAfterLink, draftName, openRecord, recentReady } from "./flow";
import { accountLine, askResultCopy, centsOf, dayWords, maskEmail, plainSentence, realMoneyTitle, restoredLine, shortAddress } from "./format";
import { describeProblem } from "./problems";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

// Every ErrorCode, enforced by the compiler: adding a code to lib/types.ts makes this object fail to compile.
const ALL_CODES = {
  locked: true,
  "no-account": true,
  "needs-consent": true,
  "needs-password": true,
  "needs-backup": true,
  "not-approved": true,
  "pilot-unknown": true,
  "pilot-pending": true,
  "pilot-declined": true,
  "pilot-revoked": true,
  "pilot-code-required": true,
  "email-taken": true,
  "backup-not-mine": true,
  "slots-used": true,
  "over-cap": true,
  "rate-limited": true,
  halted: true,
  "network-busy": true,
  "day-limit": true,
  offline: true,
  uncertain: true,
  "bad-amount": true,
  "bad-email": true,
  "bad-code": true,
  "no-backup": true,
  "no-password-copy": true,
  "bad-password": true,
  "weak-link-password": true,
  "unsupported-backup": true,
  "account-not-found": true,
  "not-enough-money": true,
  busy: true,
  "simulation-failed": true,
  "sponsor-refused": true,
  "not-found": true,
  "not-reclaimable": true,
  "insert-failed": true,
  "host-access": true,
  "open-send": true,
  "open-links": true,
  "weak-password": true,
  "backup-refused": true,
  "not-backed-up": true,
  internal: true,
} satisfies Record<ErrorCode, true>;
const codes = Object.keys(ALL_CODES) as ErrorCode[];

const BANNED = /\b(gasless|bank|yield|savings|deposit|interest|trustless|xdr|soroban|fee-bump|http|usdc|stellar|blockchain|on-chain)\b/i;
const ASCII = /^[\x20-\x7e]*$/;

const LISTING_WORDS_EARLY = /\b(gasless|yield|savings|interest|bank|deposit|trustless|audited)\b/i;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/* ----------------------------------- refusal copy ----------------------------------- */

const GOLDEN_PUB = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
const SHORT = "GCFIRY...XVYOJR";
for (const net of ["testnet", "public"] as const) {
  for (const code of codes) {
    // The worker's own sentence where it is a plain one, a technical one where it is not: both must come out clean.
    for (const [message, ctx] of [
      [MESSAGES[code], {}],
      ["Something technical: HTTP 403 status {\"error\":\"x\"}", {}],
      ["", {}],
      [MESSAGES[code], { short: SHORT, used: 2, limit: 5 }],
      [MESSAGES[code], { short: SHORT, used: 5, limit: 5 }],
    ] as const) {
      const p = describeProblem(code, message, net, ctx);
      const text = `${p.title} ${p.body} ${p.label}`;
      check(`${code}/${net}: has a title, a body and one action`, p.title.length > 0 && p.body.length > 0 && p.label.length > 0);
      check(`${code}/${net}: ASCII only`, ASCII.test(text), text);
      check(`${code}/${net}: no off-limits word`, !BANNED.test(text), text.match(BANNED)?.[0]);
      check(`${code}/${net}: ends like a sentence`, /[.!?]$/.test(p.body), p.body);
    }
  }
}

const uncertain = describeProblem("uncertain", "We think it failed, try again!", "testnet");
check("uncertain is never reworded by the worker and says not to send again", /Don't send it again/.test(uncertain.body) && uncertain.action === "links");
check("not-approved offers Ask to join, here in the extension", describeProblem("not-approved", "", "public").action === "ask" && describeProblem("not-approved", "", "public").label === "Ask to join");
check("not-approved for the unaccepted note goes to Settings", describeProblem("not-approved", "Read the real-money note in Settings and accept it first.", "public").action === "settings");
check("not-enough-money on practice money offers practice dollars", describeProblem("not-enough-money", "", "testnet").action === "practice");
check("account-not-found on real money does not offer practice dollars", describeProblem("account-not-found", "", "public").action !== "practice");
const noSends = describeProblem("slots-used", "", "public", { short: SHORT, used: 5, limit: 5 });
check(
  "slots-used is the no-sends standing, naming the account, and offers Ask for more sends",
  noSends.title === "No real-money sends left." && noSends.body.startsWith(`This account (${SHORT}) has used all 5 of its real-money sends.`) && noSends.action === "ask" && noSends.label === "Ask for more sends",
  `${noSends.title} | ${noSends.body}`,
);
// E3: an account that is not open on real money yet is opened from here, never sent to the website.
const notOpen = describeProblem("account-not-found", MESSAGES["account-not-found"], "public", { short: SHORT });
check(
  "account-not-found on real money: 'Your account isn't open here yet', naming the account, with 'Open it on real money'",
  notOpen.title === "Your account isn't open here yet" && notOpen.body === `This account (${SHORT}) isn't open on real money yet.` && notOpen.action === "open-real" && notOpen.label === "Open it on real money",
  `${notOpen.body} / ${notOpen.action}`,
);
check("  ...and no text of it names getlumenia.com", !/getlumenia/i.test(`${notOpen.title} ${notOpen.body} ${notOpen.label}`) && !/getlumenia/i.test(MESSAGES["account-not-found"]));
check("the worker's own sentence for it is the plain one", MESSAGES["account-not-found"] === "This account isn't open on this network yet.");
// D3: real money waits for the backup, and three waits are three different answers.
check("needs-backup opens the backup steps", describeProblem("needs-backup", MESSAGES["needs-backup"], "public").action === "backup");
const haltedP = describeProblem("halted", MESSAGES.halted, "public");
const busyP = describeProblem("network-busy", "Something technical: HTTP 503", "public");
const dayP = describeProblem("day-limit", "Something technical: HTTP 400", "public");
check("a busy network is not told as Lumenia pausing", !/paused/i.test(`${busyP.title} ${busyP.body}`) && /network is busy/i.test(busyP.body));
check("a spent day limit says tomorrow, not 'later'", /tomorrow/.test(dayP.body) && !/later/.test(dayP.body));
check("the halt, the busy network and the day limit are three different titles", new Set([haltedP.title, busyP.title, dayP.title]).size === 3);

/* ------------------------------ the header's real-money title ------------------------------ */
const pilotAnswer = (o: Partial<PilotInfo>): PilotInfo => ({ pilot: true, approved: false, state: "none", used: 0, limit: 5, revoked: false, at: 0, ...o });
check("no answer yet: only the caps are named", realMoneyTitle(null) === "Real money: capped per link");
check("the pilot retired: open to everyone, never 'invite-only'", /open to everyone/.test(realMoneyTitle(pilotAnswer({ pilot: false, approved: true, state: "open" }))) && !/invite-only/.test(realMoneyTitle(pilotAnswer({ pilot: false, approved: true, state: "open" }))));
// "Invite-only" is said for the one standing it is true of (never asked), not for every answer that is not an approval.
check("the pilot on, never asked (state none): invite-only", /invite-only/.test(realMoneyTitle(pilotAnswer({}))));
check("the pilot on, approved: approved for real money", realMoneyTitle(pilotAnswer({ approved: true, state: "approved" })) === "You're approved for real money.");
for (const [state, o] of [
  ["waiting", { state: "pending" }],
  ["declined", { state: "rejected" }],
  ["taken off", { state: "rejected", revoked: true }],
  ["approved", { state: "approved", approved: true }],
  ["out of sends", { state: "approved", approved: true, used: 5 }],
] as const) {
  const t = realMoneyTitle(pilotAnswer(o));
  check(`the title for an account that is ${state} never says invite-only or "isn't on the list" (${t})`, !/invite-only|isn't on the list/i.test(t));
}
for (const p of [null, pilotAnswer({}), pilotAnswer({ pilot: false, approved: true }), pilotAnswer({ approved: true }), pilotAnswer({ state: "pending" }), pilotAnswer({ state: "rejected", revoked: true })]) {
  check(`the title is ASCII with no off-limits word (${realMoneyTitle(p)})`, ASCII.test(realMoneyTitle(p)) && !BANNED.test(realMoneyTitle(p)));
}

/* ------------------------- the standing table (LUMENIA ACCOUNT CONTRACT v1, 4) ------------------------- */
const goldenRows: [string, unknown, { failed?: boolean }, Standing][] = [
  ["the pilot off", { pilot: false, approved: true, state: "open" }, {}, "open"],
  ["never asked", { pilot: true, state: "none", approved: false, used: 0, limit: 5, revoked: false }, {}, "none"],
  ["waiting", { pilot: true, state: "pending", approved: false, used: 0, limit: 5, revoked: false }, {}, "pending"],
  ["approved, 2 of 5 used", { pilot: true, state: "approved", approved: true, used: 2, limit: 5, revoked: false }, {}, "approved"],
  ["approved, 5 of 5 used", { pilot: true, state: "approved", approved: true, used: 5, limit: 5, revoked: false }, {}, "no-sends"],
  ["declined", { pilot: true, state: "rejected", approved: false, used: 1, limit: 5, revoked: false }, {}, "declined"],
  ["taken off", { pilot: true, state: "rejected", approved: false, used: 1, limit: 5, revoked: true }, {}, "revoked"],
  ["approved, but not on the allowlist", { pilot: true, state: "approved", approved: false, used: 0, limit: 5 }, {}, "revoked"],
  ["the pilot on with no state", { pilot: true, approved: false }, {}, "unknown"],
  ["HTTP 503 (a failed ask)", null, { failed: true }, "unknown"],
  ["a failed ask, even with an answer in hand", { pilot: true, state: "approved", approved: true, used: 0, limit: 5 }, { failed: true }, "unknown"],
  ["pilot not a boolean", { pilot: "true", state: "approved", approved: true }, {}, "unknown"],
  ["a state nobody knows", { pilot: true, state: "frozen", approved: false }, {}, "unknown"],
  ["not an object", "approved", {}, "unknown"],
];
for (const [what, read, opts, want] of goldenRows) {
  const got = pilotStanding(read, opts);
  check(`golden row: ${what} -> ${want}`, got === want, got);
}
check("a failed ask is never 'not approved': it refuses as pilot-unknown", standingRefusal("unknown", "switch") === "pilot-unknown" && standingRefusal("unknown", "send") === "pilot-unknown");
check("the switch to real money: approved, no sends left and open let the person in", ["approved", "no-sends", "open"].every((s) => standingRefusal(s as Standing, "switch") === null));
check("a send: no sends left refuses as slots-used; approved and open go on", standingRefusal("no-sends", "send") === "slots-used" && standingRefusal("approved", "send") === null && standingRefusal("open", "send") === null);
check(
  "each other standing refuses as its own code",
  standingRefusal("none", "send") === "not-approved" &&
    standingRefusal("pending", "send") === "pilot-pending" &&
    standingRefusal("declined", "send") === "pilot-declined" &&
    standingRefusal("revoked", "send") === "pilot-revoked",
);

/* ------------------------- the standing copy (LUMENIA ACCOUNT CONTRACT v1, 5.1) ------------------------- */
const KEEPS = "Your money stays yours: you can still receive it, cash it out and take links back.";
const COPY_5_1: Record<Standing, [string, string, string | null]> = {
  none: ["Real money is invite-only for now.", `Ask to join with this account (${SHORT}).`, "Ask to join"],
  pending: ["You're on the list.", `We'll email you when this account (${SHORT}) is approved.`, "Check again"],
  approved: ["You're approved for real money.", `This account (${SHORT}) has 3 of 5 real-money sends left.`, "Switch to real money"],
  "no-sends": ["No real-money sends left.", `This account (${SHORT}) has used all 5 of its real-money sends. ${KEEPS}`, "Ask for more sends"],
  declined: ["Not approved for now.", `This account (${SHORT}) isn't approved for real money yet. If you think we got it wrong, reply to our email.`, null],
  revoked: ["Real money is off for this account.", `We took this account (${SHORT}) off real money. ${KEEPS}`, null],
  open: ["Real money is open to everyone.", "Every link is capped.", "Switch to real money"],
  unknown: ["We couldn't check real money for this account.", "Try again in a minute.", "Try again"],
};
for (const s of Object.keys(COPY_5_1) as Standing[]) {
  const c = standingCopy(s, { short: shortAddress(GOLDEN_PUB), left: 3, limit: 5 });
  const [title, line, action] = COPY_5_1[s];
  check(`5.1 ${s}: the contract's title, line and action, with short(G)`, c.title === title && c.line === line && c.action === action, `${c.title} | ${c.line} | ${c.action}`);
  check(`5.1 ${s}: ASCII, no off-limits word`, ASCII.test(`${c.title} ${c.line} ${c.action ?? ""}`) && !BANNED.test(`${c.title} ${c.line}`));
}
check("5.1 while a check runs", CHECKING === "Checking real money for this account.");
for (const s of ["pending", "declined", "revoked"] as const) {
  const c = standingCopy(s, { short: SHORT, left: 0, limit: 5 });
  const code = standingRefusal(s, "switch")!;
  const p = describeProblem(code, MESSAGES[code], "public", { short: SHORT, used: 1, limit: 5 });
  const all = `${c.title} ${c.line} ${c.action ?? ""} ${p.title} ${p.body} ${p.label} ${MESSAGES[code]}`;
  check(`${s}: never "isn't on the list", never "Ask to join"`, !/isn't on the list|Ask to join/i.test(all), all);
  check(`${s}: the refusal panel is the standing's own title and line`, p.title === c.title && p.body === c.line);
}
check("pending's panel asks again; unknown's panel tries again", describeProblem("pilot-pending", "", "public").action === "check" && describeProblem("pilot-unknown", "", "public").action === "check" && describeProblem("pilot-unknown", "", "public").label === "Try again");

/* ------------------------- the ask-to-join results (LUMENIA ACCOUNT CONTRACT v1, 5.2) ------------------------- */
const MASKED = "f***@example.com";
const askV = { short: SHORT, masked: MASKED, limit: 5, left: 0 };
const asked = (o: Partial<Parameters<typeof askResultCopy>[0]>) => askResultCopy({ state: "pending", filed: true, already: false, standing: "pending", ...o }, askV);
check("5.2 filed", same(asked({}), { title: "Request sent.", line: `We'll email ${MASKED} when this account (${SHORT}) is approved.` }));
check("5.2 already pending", same(asked({ filed: false, already: true }), { title: "You've already asked.", line: `This account (${SHORT}) is on the list. We'll email ${MASKED} when it is approved.` }));
check("  ...also when a reminder went out", asked({ filed: true, already: true }).title === "You've already asked.");
check(
  "5.2 more sends, filed",
  same(asked({ state: "approved", filed: true, already: true, standing: "no-sends" }), { title: "Asked for more sends.", line: `We'll email ${MASKED} when this account (${SHORT}) can send again.` }),
);
check(
  "5.2 more sends, already asked",
  same(asked({ state: "approved", filed: false, already: true, standing: "no-sends" }), { title: "You've already asked for more sends.", line: `We'll email ${MASKED} when this account (${SHORT}) can send again.` }),
);
check("5.2 a declined account is told it is declined, not that it is on the list", asked({ state: "rejected", filed: false, already: true, standing: "declined" }).title === "Not approved for now.");

/* ------------------------- the account line (LUMENIA ACCOUNT CONTRACT v1, 0.3, 5.3, 5.5) ------------------------- */
check("golden short: GCFIRY...XVYOJR", shortAddress(GOLDEN_PUB) === SHORT && shortLib(GOLDEN_PUB) === SHORT);
check("golden masked: f***@example.com, from the padded, mixed-case address", maskEmail("  Founder@Example.com ") === MASKED && maskEmailLib("Founder@Example.com") === MASKED);
check("masked: the part before the LAST @", maskEmail("a@b@Example.com") === "a***@example.com");
const line = (email: string | null, bound: boolean | null, needed = false) => accountLine({ pubkey: GOLDEN_PUB, email, bound }, needed);
check("5.3 backed up with an email", same(line("founder@example.com", true), { text: `${SHORT}, backed up with ${MASKED}`, action: null }));
check("  ...an older server that never said whether it is tied: still the email", line("founder@example.com", null).text === `${SHORT}, backed up with ${MASKED}`);
check("5.3 backed up, email unknown, with 'Add your backup email'", same(line(null, null), { text: `${SHORT}, backed up`, action: { kind: "add-email", label: "Add your backup email" } }));
check("5.3 not backed up yet", line(null, null, true).text === `${SHORT}, not backed up yet` && line("founder@example.com", true, true).text === `${SHORT}, not backed up yet`);
check("5.3 backup not tied, with 'Back it up again'", same(line("founder@example.com", false), { text: `${SHORT}, backup not tied to this account yet`, action: { kind: "back-up-again", label: "Back it up again" } }));
check("5.3 an added email that does not check out", MESSAGES["backup-not-mine"] === "That email doesn't back up this account." && describeProblem("backup-not-mine", "", "testnet").body === "That email doesn't back up this account.");
check("5.5 restore result", restoredLine({ pubkey: GOLDEN_PUB, email: "Founder@Example.com" }) === `This is ${SHORT}, backed up with ${MASKED}.`);
check("5.5 the hint under every backup and restore email field", EMAIL_HINT === "Type it the same way every time: first.last@gmail.com and firstlast@gmail.com are two different emails here.");

/* ----------------------------------- plain sentence filter ----------------------------------- */

check("a plain worker sentence passes", plainSentence("Too many tries in a minute. Wait a moment, then try again.") !== null);
check("a trailing (detail) is dropped", plainSentence("You've used all your real-money sends in the pilot. (pilot limit reached: 5 transactions used)") === "You've used all your real-money sends in the pilot.");
check("a status code is refused", plainSentence("Request failed with status 403.") === null);
check("a log line is refused", plainSentence("/v2-deposit -> 400: request failed") === null);
check("lowercase start is refused", plainSentence("deposit simulation failed.") === null);
check("no final stop is refused", plainSentence("Something went wrong") === null);
check("an off-limits word is refused", plainSentence("Your savings are safe and sound.") === null);
check("empty and undefined are refused", plainSentence("") === null && plainSentence(undefined) === null);
const workerMessages = codes.map((c) => [c, plainSentence(MESSAGES[c])] as const);
check("every worker message in lib/errors.ts is either a plain sentence or has our own copy", workerMessages.every(([c, s]) => s !== null || describeProblem(c, MESSAGES[c], "testnet").body.length > 0));

/* ----------------------------------- amounts and addresses ----------------------------------- */

check("centsOf reads decimals without floats", centsOf("12.5") === 1250 && centsOf("0.01") === 1 && centsOf("5") === 500 && centsOf("24.5000000") === 2450);
check("centsOf refuses non-amounts", centsOf("") === null && centsOf("abc") === null && centsOf("1.2.3") === null && centsOf(null) === null);
check("centsOf truncates past two decimals", centsOf("1.999") === 199);
check("shortAddress keeps six characters from each end", shortAddress("GCDQHIJX3ZLBCVP7OIDFQ4FJNEZFO2DX5LRHNQ7GHQ5RZXFBFVHA7XQ2") === "GCDQHI...HA7XQ2");
// In the person's own locale: "October 9" in English, "9 Ekim" in Turkish, "9. Oktober" in German.
check("dayWords names a month and a day, in either order", /^(\p{L}+\.? \d{1,2}|\d{1,2}\.? \p{L}+\.?)$/u.test(dayWords(1_760_000_000)), dayWords(1_760_000_000));

/* ----------------------------------- link windows ----------------------------------- */

const NOW = 1_760_000_000_000;
const rec = (o: Partial<LinkRecord>): LinkRecord => ({
  v: 1,
  net: "testnet",
  linkHex: "ab".repeat(32),
  sender: "G",
  amount: "5.00",
  from: "",
  locked: false,
  createdAt: NOW - 60_000,
  expiry: Math.floor((NOW + 6 * 86_400_000) / 1000),
  retrySafeAfter: NOW,
  innerHash: "cd".repeat(32),
  phase: "confirmed",
  status: "pending",
  ...o,
});
check("a link made a minute ago is offered again", recentReady([rec({})], NOW) !== null);
check("a link made 11 minutes ago is not", recentReady([rec({ createdAt: NOW - 11 * 60_000 })], NOW) === null);
check("a claimed link is not", recentReady([rec({ status: "claimed" })], NOW) === null);
check("an uncertain link is not offered as ready", recentReady([rec({ phase: "uncertain", status: undefined })], NOW) === null);
check("an empty list offers nothing", recentReady([], NOW) === null);
check("an uncertain link warns before a second send", openRecord([rec({ phase: "uncertain", status: undefined })], NOW, "testnet") !== null);
check("  ...but not before a send on the other network", openRecord([rec({ phase: "uncertain", status: undefined })], NOW, "public") === null);
check("a link still being made warns too", openRecord([rec({ phase: "submitted", status: undefined })], NOW, "testnet") !== null);
check("a settled link does not warn", openRecord([rec({})], NOW, "testnet") === null);
check("a six-hour-old uncertain link stops warning", openRecord([rec({ phase: "uncertain", status: undefined, createdAt: NOW - 7 * 3_600_000 })], NOW, "testnet") === null);

/* ------------------------- the sentences shared with the other surfaces ------------------------- */

// Written out by hand: the web's dialog and /pilot page, the pilot's mail and both store listings
// carry the same words, so a change here has to be a deliberate change everywhere.
const D1 = "Real money on Lumenia is an early pilot. It has not been reviewed by an outside security firm yet. You can lose money, so keep amounts small.";
const D2 = "$5 a link and up to $25 a day from you ($50 a day across the whole pilot)";
const D2_SHORT = "$5 a link, $25 a day";
const D3 = "Your name travels inside the link, after the #. Anyone who can read the chat can read it.";
check("the real-money note is the shared sentence, word for word", REAL_MONEY_WARNING === D1, REAL_MONEY_WARNING);
check("  ...and it says you can lose money", /You can lose money/.test(REAL_MONEY_WARNING));
check("the caps are the pilot's: $5 a link, $25 a day from one sender, $50 a day across the pilot", CAPS === D2 && CAPS_SHORT === D2_SHORT, `${CAPS} | ${CAPS_SHORT}`);
check("  ...and their sentence stands on its own, apart from the note", CAPS_SENTENCE === `Real money is capped at ${D2}.` && !CAPS_SENTENCE.includes(D1));
check("the note under a typed name is the shared sentence", NAME_NOTE === D3, NAME_NOTE);
const LISTING_WORDS = LISTING_WORDS_EARLY;
for (const [what, text] of [["note", REAL_MONEY_WARNING], ["caps", CAPS_SENTENCE], ["short caps", CAPS_SHORT], ["name note", NAME_NOTE]] as const) {
  check(`the ${what} is plain ASCII with no off-limits word`, ASCII.test(text) && !BANNED.test(text), text.match(BANNED)?.[0]);
}
/* "$50 a day" said alone is the old promise: one sender is capped at $25 a day, and $50 is the whole
   pilot's day. It may appear only as the pilot-wide figure. */
const STALE_DAY = /\$50(?:\.00)? (?:a|per) day(?! across the whole pilot)/;
check("the over-cap refusal names the pilot's caps in the shared sentence", MESSAGES["over-cap"] === CAPS_SENTENCE);
check("  ...and its panel adds what to do", describeProblem("over-cap", "", "public").body === `${CAPS_SENTENCE} Try a smaller amount.`);
for (const net of ["testnet", "public"] as const) {
  for (const code of codes) {
    const p = describeProblem(code, MESSAGES[code], net);
    check(`${code}/${net}: no "$50 a day" said as one sender's limit`, !STALE_DAY.test(`${p.title} ${p.body} ${MESSAGES[code]}`));
  }
}

/* ------------------------------ the From field of a new link ------------------------------ */

check("a new form's From field is empty (nothing fills it in)", EMPTY_DRAFT.from === null && draftName(EMPTY_DRAFT) === "");
const sentOne = draftAfterLink({ amount: "5", from: "Ayse", lock: true, password: "a long link password" });
check("once a link is made, the next one starts with an empty From, no amount and no password", draftName(sentOne) === "" && sentOne.from === null && sentOne.amount === "" && sentOne.password === "");
check("  ...and the link-password switch stays as the person left it", sentOne.lock === true && draftAfterLink({ ...EMPTY_DRAFT, lock: false }).lock === false);
check("a name the sender typed is the From field's text, as typed", draftName({ ...EMPTY_DRAFT, from: "  Ayse " }) === "  Ayse ");

/* --------------------------------- the screens' own words --------------------------------- */

// The screens are Preact components; their contract sentences are checked in the source text.
const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\s+/g, " ");
const backupSrc = src("./screens/Backup.tsx");
const restoreSrc = src("./screens/Restore.tsx");
const chooseSrc = src("./screens/Choose.tsx");
const settingsSrc = src("./screens/Settings.tsx");
const askSrc = src("./screens/Ask.tsx");
for (const sentence of [
  "This email already backs up another Lumenia account.",
  "One email backs up one account. Bring that account here, or use another email for this one.",
  "It holds an older backup that isn't tied to any account yet. Open it with its password, use another email, or replace it.",
  "Bring that account here",
  "Use another email",
  "Replace it",
  "Enter the password of the account this email backs up.",
  "Open it",
  "That password doesn't open this backup.",
  "Replacing it means that backup no longer opens with this email. Type REPLACE to confirm.",
  "Backed up. This email now opens this account ({short}).",
  "That took too long. Send a new code and try again.",
  "was never backed up. It holds only practice money, and it will be removed from this browser.",
  "Use {other} here",
  "{EMAIL_HINT}",
]) {
  check(`5.4 Backup.tsx says "${sentence}"`, backupSrc.includes(sentence));
}
check("5.5 Choose: a new account is separate from the website's", chooseSrc.includes("This makes a new account, separate from any account you have on getlumenia.com."));
check("5.5 Restore: the password step names the email it backs up", restoreSrc.includes("This is the password you chose when you backed up <strong class=\"break\">{ws.restore?.email}</strong>."));
check("5.5 Restore: the hint under the email field", restoreSrc.includes("{EMAIL_HINT}"));
check(
  "5.5 Settings: Use another account, with what stays, and the refusal",
  settingsSrc.includes("Use another account") &&
    settingsSrc.includes("This account ({short}) stays backed up with {maskEmail(email)}. Its links show again when you bring it back.") &&
    settingsSrc.includes("Back this account up first. It lives only in this browser."),
);
check("E7 Settings: Change backup email", settingsSrc.includes("Change backup email"));
check("E8 Settings: the lock sentence says whose key", settingsSrc.includes("Your key in this extension locks itself after this long without use."));
check("E3 Settings: copying an address that is not open on real money says so", settingsSrc.includes("Open it on real money first, or dollars sent here can't arrive."));
check("E1 Settings: the stale 'You're approved' line is gone, the money line says when it was checked", !settingsSrc.includes("<p class=\"fine\">You're approved for real money.</p>") && settingsSrc.includes("Checked {when(info.at)}.") && settingsSrc.includes("Check again"));
check(
  "5.2 Ask: the form's words",
  askSrc.includes("Ask to join real money") &&
    askSrc.includes("We'll use the email that backs up this account: <strong class=\"break\">{maskEmail(known)}</strong>.") &&
    askSrc.includes("Use a different email") &&
    askSrc.includes("Your email") &&
    askSrc.includes("Use the email that backs up this account ({short}).") &&
    askSrc.includes("Enter it to confirm this email is yours.") &&
    askSrc.includes("6-digit code") &&
    askSrc.includes("busyLabel=\"Asking\"") &&
    askSrc.includes("This email also asked to join for account {answer.emailAlsoFor}."),
);
// Every "Ask to join" asks here, for this extension's key: no screen sends the person to the website's /pilot page.
const popupFiles = [...readdirSync(new URL("./", import.meta.url)).map((f) => `./${f}`), ...readdirSync(new URL("./screens/", import.meta.url)).map((f) => `./screens/${f}`)].filter((f) => /\.tsx?$/.test(f) && !f.endsWith("selftest.ts"));
check(`no popup file opens the website's pilot page (${popupFiles.length} files)`, popupFiles.length > 20 && popupFiles.every((f) => !src(f).includes("URLS.pilot")), popupFiles.filter((f) => src(f).includes("URLS.pilot")).join(", "));

/* --------------------------------- the disclosures (5.6) --------------------------------- */
const D5_1 = "To check the pilot: your account's public key, to the real-money server, when you press Real money or Check again, while you use real money, and while this account's request to join is waiting.";
const D5_2 = "To ask to join real money: your account's public key, the email that backs it up, a signature from your account and, if asked, a 6-digit code, to the real-money server.";
const D5_3 = "On this device: the email each account is backed up with, so it can show it to you and use it when you ask to join.";
check("D1 is the contract's sentence", DISCLOSE_PILOT_CHECK === D5_1);
check("D2 is the contract's sentence", DISCLOSE_PILOT_ASK === D5_2);
check("D3 is the contract's sentence", DISCLOSE_EMAIL_KEPT === D5_3);
check("the consent screen shows all three, label in bold", src("./screens/Consent.tsx").includes("DISCLOSE_PILOT_CHECK") && src("./screens/Consent.tsx").includes("DISCLOSE_PILOT_ASK") && src("./screens/Consent.tsx").includes("DISCLOSE_EMAIL_KEPT") && disclosureParts(D5_1).label === "To check the pilot:" && `${disclosureParts(D5_2).label} ${disclosureParts(D5_2).rest}` === D5_2);
for (const d of [D5_1, D5_2, D5_3]) check(`"${d.slice(0, 24)}...": plain ASCII, no off-limits word`, ASCII.test(d) && !LISTING_WORDS_EARLY.test(d));

/* --------------------------------- the store listing and the README --------------------------------- */

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");
const pkg = JSON.parse(read("../../package.json")) as { version: string };
const description = read("../../store/description.txt").replace(/\n$/, "");
const listed = JSON.parse(read("../../store/amo-listed.json")) as {
  summary: Record<string, string>;
  description: Record<string, string>;
  homepage: Record<string, string>;
  version: { license: string; approval_notes: string };
};
const unlisted = JSON.parse(read("../../store/amo-metadata.json")) as { version: { approval_notes: string } };
// The README wraps its lines; a sentence is checked with every run of whitespace read as one space.
const readmeRaw = read("../../README.md");
const readme = readmeRaw.replace(/\s+/g, " ");
const listing = listed.description["en-US"] ?? "";
check("the AMO description is store/description.txt byte for byte (the Chrome listing is pasted from that file)", listing === description, `${listing.length} vs ${description.length} characters`);
check("the listing carries the real-money note word for word", description.includes(D1));
check("  ...and the caps, in a sentence of their own after it", description.includes(CAPS_SENTENCE) && description.indexOf(CAPS_SENTENCE) > description.indexOf(D1));
check("  ...and the note's old wording is gone (early preview, keep amounts tiny)", !/early preview|amounts tiny/i.test(description));
check("  ...and nowhere says $50 a day as one sender's limit", !STALE_DAY.test(description), description.match(STALE_DAY)?.[0]);
check("  ...and it says a link carries a name only when one is typed, and no amount", /no name unless you type one/i.test(description) && /carries no amount/i.test(description));
check("  ...plain ASCII, no off-limits word, and the privacy page linked", /^[\x20-\x7e\n]*$/.test(description) && !LISTING_WORDS.test(description) && description.includes("https://getlumenia.com/privacy"), description.match(LISTING_WORDS)?.[0]);
check("  ...names no site the paste was never tried on", !/WhatsApp|Telegram|Gmail/.test(description));
const notes = listed.version.approval_notes;
check("the reviewer note is the same in both AMO files, and within AMO's 3000 characters", notes === unlisted.version.approval_notes && notes.length <= 3000, `${notes.length} characters`);
check("  ...it states the caps as the sponsor enforces them (5 a link, 25 a day per sender, 50 a day in all)", /5 dollars a link/.test(notes) && /25 a day per sender/.test(notes) && /50 a day across the whole pilot/.test(notes));
check("  ...plain ASCII", /^[\x20-\x7e\n]*$/.test(notes));
check("the README names this version in its published-builds table", new RegExp(`^\\|\\s*${pkg.version.replace(/\./g, "\\.")}\\s*\\|`, "m").test(readmeRaw), pkg.version);
check("  ...and says this folder is that version", readme.includes(`This folder is version **${pkg.version}**`));
check("  ...links both store pages", readme.includes("https://chromewebstore.google.com/detail/lumenia-send-dollars-by-l/ccdnjnckaldkmjnlpgpmdmnbajmakhmn") && readme.includes("https://addons.mozilla.org/en-US/firefox/addon/lumenia/"));
check("  ...says the caps the way the screens do, and the note word for word", readme.includes(CAPS) && readme.includes(D1) && !STALE_DAY.test(readme), readme.match(STALE_DAY)?.[0]);
check("  ...names no site as a tested paste target", !/\(WhatsApp Web, Telegram Web, Gmail, any ordinary field\)/.test(readme));
// 5.6: the three disclosures, word for word, in every place the extension's data use is described.
for (const [what, text] of [
  ["store/description.txt", description],
  ["store/amo-listed.json", listing],
  ["README.md", readme],
] as const) {
  check(`${what} carries D1, D2 and D3 word for word`, text.includes(D5_1) && text.includes(D5_2) && text.includes(D5_3), [D5_1, D5_2, D5_3].filter((d) => !text.includes(d)).map((d) => d.slice(0, 30)).join(" | "));
}
check("the listing no longer says the pilot check is real money only", !description.includes("On real money only: your public key, to check whether the pilot approved it."));

console.log(fail === 0 ? `\nPASS POPUP ${pass}/${pass}` : `\nFAIL POPUP ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
