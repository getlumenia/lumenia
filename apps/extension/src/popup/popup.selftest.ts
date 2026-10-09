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
 *   pnpm --filter @lumenia/extension exec tsx src/popup/popup.selftest.ts
 */
import { readFileSync } from "node:fs";
import { CAPS, CAPS_SENTENCE, CAPS_SHORT, NAME_NOTE, REAL_MONEY_WARNING } from "../lib/copy";
import { MESSAGES } from "../lib/errors";
import type { ErrorCode, LinkRecord, PilotInfo } from "../lib/types";
import { EMPTY_DRAFT, draftAfterLink, draftName, openRecord, recentReady } from "./flow";
import { centsOf, dayWords, plainSentence, realMoneyTitle, shortAddress } from "./format";
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

/* ----------------------------------- refusal copy ----------------------------------- */

for (const net of ["testnet", "public"] as const) {
  for (const code of codes) {
    // The worker's own sentence where it is a plain one, a technical one where it is not: both must come out clean.
    for (const message of [MESSAGES[code], "Something technical: HTTP 403 status {\"error\":\"x\"}", ""]) {
      const p = describeProblem(code, message, net);
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
check("not-approved offers Ask to join", describeProblem("not-approved", "", "public").action === "join");
check("not-approved for the unaccepted note goes to Settings", describeProblem("not-approved", "Read the real-money note in Settings and accept it first.", "public").action === "settings");
check("not-enough-money on practice money offers practice dollars", describeProblem("not-enough-money", "", "testnet").action === "practice");
check("account-not-found on real money does not offer practice dollars", describeProblem("account-not-found", "", "public").action !== "practice");
check("slots-used offers to switch to practice money", describeProblem("slots-used", "", "public").action === "use-practice");
// D3: real money waits for the backup, and three waits are three different answers.
check("needs-backup opens the backup steps", describeProblem("needs-backup", MESSAGES["needs-backup"], "public").action === "backup");
const haltedP = describeProblem("halted", MESSAGES.halted, "public");
const busyP = describeProblem("network-busy", "Something technical: HTTP 503", "public");
const dayP = describeProblem("day-limit", "Something technical: HTTP 400", "public");
check("a busy network is not told as Lumenia pausing", !/paused/i.test(`${busyP.title} ${busyP.body}`) && /network is busy/i.test(busyP.body));
check("a spent day limit says tomorrow, not 'later'", /tomorrow/.test(dayP.body) && !/later/.test(dayP.body));
check("the halt, the busy network and the day limit are three different titles", new Set([haltedP.title, busyP.title, dayP.title]).size === 3);

/* ------------------------------ the header's real-money title ------------------------------ */
const pilotAnswer = (o: Partial<PilotInfo>): PilotInfo => ({ pilot: true, approved: false, state: "none", used: 0, limit: 5, at: 0, ...o });
check("no answer yet: only the caps are named", realMoneyTitle(null) === "Real money: capped per link");
check("the pilot retired: open to everyone, never 'invite-only'", /open to everyone/.test(realMoneyTitle(pilotAnswer({ pilot: false, approved: true, state: "open" }))) && !/invite-only/.test(realMoneyTitle(pilotAnswer({ pilot: false, approved: true, state: "open" }))));
check("the pilot on, not approved: invite-only", /invite-only/.test(realMoneyTitle(pilotAnswer({}))));
check("the pilot on, approved: in the pilot", /in the pilot/.test(realMoneyTitle(pilotAnswer({ approved: true, state: "approved" }))));
for (const p of [null, pilotAnswer({}), pilotAnswer({ pilot: false, approved: true }), pilotAnswer({ approved: true })]) {
  check(`the title is ASCII with no off-limits word (${realMoneyTitle(p)})`, ASCII.test(realMoneyTitle(p)) && !BANNED.test(realMoneyTitle(p)));
}

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
const LISTING_WORDS = /\b(gasless|yield|savings|interest|bank|deposit|trustless)\b/i;
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

console.log(fail === 0 ? `\nPASS POPUP ${pass}/${pass}` : `\nFAIL POPUP ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
