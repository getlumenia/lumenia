/**
 * Offline checks for the popup's pure parts: the sentence filter, the refusal copy, the amount and
 * link-window helpers. The refusal copy is checked mechanically against the product's word law, so a
 * later edit that slips "gasless" or a ledger term into a money screen fails here, not in review.
 *
 *   pnpm --filter @lumenia/extension exec tsx src/popup/popup.selftest.ts
 */
import { MESSAGES } from "../lib/errors";
import type { ErrorCode, LinkRecord } from "../lib/types";
import { openRecord, recentReady } from "./flow";
import { centsOf, dayWords, plainSentence, shortAddress } from "./format";
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
  "not-approved": true,
  "pilot-unknown": true,
  "slots-used": true,
  "over-cap": true,
  "rate-limited": true,
  halted: true,
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

console.log(fail === 0 ? `\nPASS POPUP ${pass}/${pass}` : `\nFAIL POPUP ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
