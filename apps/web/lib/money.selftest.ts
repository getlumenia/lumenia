/**
 * Amount-input self-test — the filter standing between a keyboard and a payment
 * (sanitizeAmountInput in lib/money.ts).
 *
 * Why this is tested rather than assumed: every amount field used to strip with
 * `.replace(/[^0-9.]/g, "")`, which deletes a decimal comma instead of reading it. On the keyboard
 * most of this product's recipients actually own, "1,50" became "150" — the field showed a hundred
 * and fifty dollars, the button said $150.00, and the app would have sent that. On /send-out, where
 * the money leaves for an exchange, the only thing bounding the error was the balance.
 *
 * The invariant every case below is really asserting is one sentence: WHAT THE FIELD SHOWS MUST
 * PARSE TO THE NUMBER THE APP WILL SEND. A magnitude is never quietly changed; input that cannot be
 * read unambiguously is cut where the person can see the cut.
 *
 * Invariants covered:
 *   - a decimal comma is read as a decimal point, never deleted (the 100× bug)
 *   - a second separator ends the number ("1.2.3" → "1.2"), so it can never become "1.23"
 *   - the string is truncated to 2dp, never rounded up — entry cannot invent money
 *   - half-typed input survives ("1." keeps its separator) and never renders as $NaN
 *   - the output is safe to write straight back into a controlled input: re-filtering changes nothing
 *
 * RUN: pnpm --filter @lumenia/web exec tsx lib/money.selftest.ts   (offline, no keys, no network)
 */
import { formatUsd, sanitizeAmountInput } from "./money";

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✔ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

/** The filter this one replaces, kept as the thing each case is measured against. */
function oldFilter(raw: string): string {
  return raw.replace(/[^0-9.]/g, "");
}

async function main() {
  console.log("============================================================");
  console.log(" SELF-TEST — amount input filter");
  console.log("============================================================\n");

  // --- the comma, which is the whole reason this exists ---------------------------------------
  console.log("[1] a decimal comma");
  ok('"1,50" reads as one-fifty', sanitizeAmountInput("1,50") === "1.50");
  ok("  …and parses to 1.5, not 150", Number.parseFloat(sanitizeAmountInput("1,50")) === 1.5);
  ok("  …where the old filter sent 150", oldFilter("1,50") === "150");
  ok('"0,05" survives as five cents', sanitizeAmountInput("0,05") === "0.05");
  ok('"250," keeps the separator being typed', sanitizeAmountInput("250,") === "250.");

  // --- the ordinary case must be untouched -----------------------------------------------------
  console.log("\n[2] a decimal point");
  ok('"12.34" passes through', sanitizeAmountInput("12.34") === "12.34");
  ok('"7" passes through', sanitizeAmountInput("7") === "7");
  ok('"0.05" passes through', sanitizeAmountInput("0.05") === "0.05");

  // --- two separators ---------------------------------------------------------------------------
  // The number ends at the second one. Splicing the halves together ("1.23") would be a silent
  // 10× on an input nobody can read for certain.
  console.log("\n[3] a second separator ends the number");
  ok('"1.2.3" → "1.2"', sanitizeAmountInput("1.2.3") === "1.2");
  ok("  …and never becomes 1.23", sanitizeAmountInput("1.2.3") !== "1.23");
  ok('"1,2,3" → "1.2"', sanitizeAmountInput("1,2,3") === "1.2");
  ok('mixed "1.2,3" → "1.2"', sanitizeAmountInput("1.2,3") === "1.2");
  ok('mixed "1,2.3" → "1.2"', sanitizeAmountInput("1,2.3") === "1.2");
  ok("the old filter accepted 1.2.3 whole", oldFilter("1.2.3") === "1.2.3");

  // A grouped paste is genuinely ambiguous — a European "1.234,56" and an American "1.234" are the
  // same characters. It is cut visibly rather than guessed at, and what shows is what would send.
  const grouped = sanitizeAmountInput("1.234,56");
  ok('grouped "1.234,56" is cut, not re-scaled', grouped === "1.23");
  ok("  …and the cut is visible in the field", grouped !== "1234.56" && grouped.length < "1.234,56".length);

  // --- everything that is not a digit ------------------------------------------------------------
  console.log("\n[4] letters and currency symbols");
  ok('"$12.34" loses the symbol', sanitizeAmountInput("$12.34") === "12.34");
  ok('"₺1,05" loses the symbol and reads the comma', sanitizeAmountInput("₺1,05") === "1.05");
  ok('"12 USD" loses the letters and the space', sanitizeAmountInput("12 USD") === "12");
  ok('"abc" is empty, not garbage', sanitizeAmountInput("abc") === "");
  ok('"-5" cannot enter a negative amount', sanitizeAmountInput("-5") === "5");
  ok("no output ever carries a non-amount character", ["$1,2 a", "₺9.999", "-.,x"].every((s) => /^[0-9]*\.?[0-9]*$/.test(sanitizeAmountInput(s))));

  // --- more than two decimals --------------------------------------------------------------------
  console.log("\n[5] two decimals, truncated");
  ok('"0.999" → "0.99" (truncated, not rounded to 1.00)', sanitizeAmountInput("0.999") === "0.99");
  ok('"1,239" → "1.23"', sanitizeAmountInput("1,239") === "1.23");
  ok("truncation never increases the amount", Number.parseFloat(sanitizeAmountInput("12.3456")) <= 12.3456);

  // --- half-typed input ----------------------------------------------------------------------------
  // These run on every keystroke, so a state the user passes THROUGH must survive the filter.
  console.log("\n[6] mid-typing");
  ok('"1." keeps its separator', sanitizeAmountInput("1.") === "1.");
  ok('"1," keeps it too', sanitizeAmountInput("1,") === "1.");
  ok('a lone "." reads as zero-point', sanitizeAmountInput(".") === "0.");
  ok('a lone "," reads as zero-point', sanitizeAmountInput(",") === "0.");
  ok("  …so the button says $0.00, not $NaN", formatUsd(sanitizeAmountInput(",")) === "$0.00");
  ok('the old filter left "." to render as $NaN', formatUsd(oldFilter(".")) === "$NaN");
  ok('"" stays ""', sanitizeAmountInput("") === "");
  ok('".5" becomes "0.5"', sanitizeAmountInput(".5") === "0.5");

  // --- what shows is what sends --------------------------------------------------------------------
  console.log("\n[7] the shown string and the parsed number agree");
  const samples = ["1,50", "1.50", "1.2.3", "$1,05", "0,999", "12", "1.", ".", "", "₺250,25", "9,99 USD"];
  let agree = true;
  let stable = true;
  for (const raw of samples) {
    const shown = sanitizeAmountInput(raw);
    // Re-filtering what is written back into the input must be a no-op, or the field fights typing.
    if (sanitizeAmountInput(shown) !== shown) stable = false;
    if (shown === "") continue;
    const parsed = Number.parseFloat(shown);
    if (!Number.isFinite(parsed)) agree = false;
    // The digits on screen, read as a number, must be the digits on screen.
    if (parsed !== Number.parseFloat(shown.endsWith(".") ? shown.slice(0, -1) : shown)) agree = false;
    if (formatUsd(shown).includes("NaN")) agree = false;
  }
  ok("every sample parses to exactly what it shows", agree);
  ok("the output is stable — filtering it again changes nothing", stable);

  const shown = sanitizeAmountInput("1,50");
  ok(`the field shows ${shown} and the app would send ${Number.parseFloat(shown).toFixed(2)}`, Number.parseFloat(shown).toFixed(2) === "1.50");

  console.log(`\n${failed === 0 ? "✅" : "❌"} MONEY SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\n💥 money self-test crashed:", e);
  process.exit(1);
});
