/**
 * ============================================================================
 *  SELF-TEST — name suggestions agree with the registry's rules
 * ============================================================================
 *
 *  The failure this exists to prevent is quiet and expensive: onboarding offers three tappable
 *  names, the person taps one, and the registry refuses it — at the last step of the first minute
 *  of the product. That happens the moment the generator and the registry disagree about shape,
 *  length or reserved words, and neither side would notice on its own.
 *
 *  So this pins the generator against the SAME rules apps/sponsor/src/lib/handles.ts enforces, over
 *  enough draws that a rare long pairing cannot slip through.
 *
 *  RUN: pnpm --filter @lumenia/web test:suggest   (no network)
 * ============================================================================
 */
import { suggestOne, suggestMany } from "./handle-suggest";

/** Mirrors NAME_RE in apps/sponsor/src/lib/handles.ts. */
const SHAPE = /^[a-z][a-z0-9_]{2,19}$/;

/** Mirrors RESERVED in apps/sponsor/src/lib/handles.ts. */
const RESERVED = new Set([
  "admin", "administrator", "root", "system", "official", "team", "staff", "support",
  "help", "helpdesk", "security", "abuse", "billing", "payments", "payment", "pay",
  "lumenia", "lumenio", "lumenla", "getlumenia", "stellar", "sdf", "circle", "usdc",
  "wallet", "money", "bank", "api", "www", "mail", "email", "app", "account", "accounts",
  "settings", "login", "signin", "signup", "register", "claim", "send", "request", "split",
  "contacts", "activity", "home", "start", "about", "terms", "privacy", "legal", "status",
  "null", "undefined", "anonymous", "me", "you", "everyone",
]);

/** Mirrors skeleton() — a suggestion whose SKELETON is reserved is refused just the same. */
function skeleton(name: string): string {
  return name
    .replace(/_/g, "")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/[1l]/g, "i")
    .replace(/0/g, "o")
    .replace(/2/g, "z")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/[68]/g, "b")
    .replace(/7/g, "t")
    .replace(/9/g, "g");
}

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "✔" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  cond ? passed++ : failed++;
}

const DRAWS = 4000;

console.log("============================================================");
console.log(" HANDLE SUGGESTION SELF-TEST");
console.log("============================================================\n");

const drawn: string[] = [];
for (let i = 0; i < DRAWS; i++) drawn.push(suggestOne());

const badShape = drawn.filter((n) => !SHAPE.test(n));
ok(`${DRAWS} draws all match the registry's shape`, badShape.length === 0, badShape.slice(0, 3).join(", "));

const tooLong = drawn.filter((n) => n.length > 20);
ok("none exceeds 20 characters", tooLong.length === 0, tooLong.slice(0, 3).join(", "));

const reserved = drawn.filter((n) => RESERVED.has(n) || RESERVED.has(skeleton(n)));
ok("none is a reserved word, or folds to one", reserved.length === 0, reserved.slice(0, 3).join(", "));

const shapes = new Set(drawn.map((n) => (/_/.test(n) ? "pair" : /\d/.test(n) ? "numbered" : "compound")));
ok("all three shapes actually appear", shapes.size === 3, [...shapes].join(", "));

const unique = new Set(drawn).size;
ok("draws are varied, not a handful repeated", unique > DRAWS / 4, `${unique} distinct in ${DRAWS}`);

const batch = suggestMany(3);
ok("suggestMany returns the count asked for", batch.length === 3, batch.join(", "));
ok("and never repeats within one batch", new Set(batch).size === 3);
ok("a large batch still terminates and stays distinct", new Set(suggestMany(24)).size === 24);

console.log(`\n${failed === 0 ? "✅" : "❌"} SUGGESTION SELF-TEST ${passed}/${passed + failed}`);
if (failed > 0) process.exit(1);
