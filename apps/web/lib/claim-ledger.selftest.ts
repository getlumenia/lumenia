/**
 * Claim-ledger self-test: the rules the v2 claim screen follows when it turns an escrow read into
 * what it shows (lib/claim-ledger.ts). A private link carries no amount, so these rules are the only
 * thing between a slow RPC and a screen that tells somebody the wrong story about their money.
 *
 *   [a] one look at a drop: an error, an empty answer, a live record, a spent record (before and
 *       after a tap)
 *   [b] which readings may replace which: a non-answer never replaces an answer, and nothing replaces
 *       a settled screen
 *   [c] the patience timer and the settled screen
 *
 * RUN: pnpm --filter @lumenia/web test:claimledger   (offline, no keys, no network)
 */
import { afterPatience, afterSettled, decideDrop, keepAnswer, withAnswer, type LedgerRead } from "./claim-ledger";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (cond) passed++;
  else failed++;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const READING: LedgerRead = { phase: "reading" };
const AMOUNT: LedgerRead = { phase: "amount", amount: "0.2000000" };
const UNREAD: LedgerRead = { phase: "unread" };
const NONE: LedgerRead = { phase: "none" };
const SPENT: LedgerRead = { phase: "spent" };
const OFF: LedgerRead = { phase: "off" };

console.log("============================================================");
console.log(" SELF-TEST - claim ledger (what the v2 claim screen may say about the amount)");
console.log("============================================================\n");

console.log("[a] one look at a one-to-one drop");
const err = decideDrop({ kind: "error" }, false);
ok("an RPC that could not be asked is 'unread', never an empty link", same(err.ledger, UNREAD) && err.settle === null && !err.answered);
const none = decideDrop({ kind: "none" }, false);
ok("every escrow answered and none holds it: 'none', and keep asking (an RPC can lag a fresh deposit)", same(none.ledger, NONE) && none.settle === null && !none.answered);
const live = decideDrop({ kind: "drop", amount: "0.2000000", claimed: false }, false);
ok("a live record shows its figure and stops the asking", same(live.ledger, AMOUNT) && live.settle === null && live.answered);
const spentFirst = decideDrop({ kind: "drop", amount: "0.2000000", claimed: true }, false);
ok("a spent record before any tap settles the screen up front, naming the escrow's figure", same(spentFirst.ledger, SPENT) && same(spentFirst.settle, { amount: "0.2000000" }) && spentFirst.answered);
const spentTapped = decideDrop({ kind: "drop", amount: "0.2000000", claimed: true }, true);
ok("...but once a tap was accepted the claim answers, and a read never swaps the screen under it", spentTapped.settle === null && same(spentTapped.ledger, AMOUNT));
const liveTapped = decideDrop({ kind: "drop", amount: "1.0000000", claimed: false }, true);
ok("a live record read after a tap still shows its figure", same(liveTapped.ledger, { phase: "amount", amount: "1.0000000" }) && liveTapped.settle === null);

console.log("\n[b] which reading may replace which");
ok("a non-answer replaces 'reading'", same(keepAnswer(READING, NONE), NONE) && same(keepAnswer(READING, UNREAD), UNREAD));
ok("a non-answer replaces another non-answer (unread -> none, none -> unread)", same(keepAnswer(UNREAD, NONE), NONE) && same(keepAnswer(NONE, UNREAD), UNREAD));
ok("a non-answer never replaces a figure", same(keepAnswer(AMOUNT, NONE), AMOUNT) && same(keepAnswer(AMOUNT, UNREAD), AMOUNT));
ok("a non-answer never replaces a settled screen", same(keepAnswer(SPENT, NONE), SPENT) && same(keepAnswer(SPENT, UNREAD), SPENT));
ok("an answer replaces a non-answer", same(withAnswer(NONE, AMOUNT), AMOUNT) && same(withAnswer(UNREAD, AMOUNT), AMOUNT) && same(withAnswer(READING, AMOUNT), AMOUNT));
ok("an answer never brings the figure back over a settled screen", same(withAnswer(SPENT, AMOUNT), SPENT));
ok("'off' (no network to ask) is not an answer either", same(keepAnswer(OFF, NONE), NONE));

console.log("\n[c] the patience timer and the settled screen");
ok("patience turns an endless 'reading' into the honest 'unread' line", same(afterPatience(READING), UNREAD));
ok("...and leaves every other state alone", [AMOUNT, UNREAD, NONE, SPENT, OFF].every((l) => same(afterPatience(l), l)));
ok("a settled claim hides the figure", same(afterSettled(), SPENT));
ok("the decisions return fresh objects (no caller can change what the next one gets)", decideDrop({ kind: "none" }, false).ledger !== decideDrop({ kind: "none" }, false).ledger);

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} CLAIM LEDGER SELF-TEST ${passed}/${passed + failed}`);
if (failed > 0) process.exit(1);
