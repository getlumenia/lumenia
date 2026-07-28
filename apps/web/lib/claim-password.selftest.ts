/**
 * Claim-password self-test — the derivation a password-locked money link rests on
 * (lib/claim-password.ts). The whole feature is one claim: the link fragment alone is
 * not enough to move the money, and the right password reproduces the exact key the
 * escrow already knows. If that ever stops holding, either the lock is fake or a
 * legitimate recipient is locked out of real money — so it is tested, not assumed.
 *
 * Invariants covered:
 *   - same seed + same password → the SAME key, every time (a recipient can always claim)
 *   - a wrong password → a DIFFERENT key, and unlockLink says so locally (no escrow call)
 *   - the fragment round-trips, and a plain bearer fragment is still read as a key
 *   - a password link's fragment never contains the password
 *
 * RUN: pnpm --filter @lumenia/web test:claimpw   (offline, no keys, no network)
 */
import {
  claimPasswordProblem,
  deriveLinkKey,
  makeLinkSeed,
  parseLinkFragment,
  passwordFragment,
  unlockLink,
} from "./claim-password";
import { Buffer } from "buffer";
import { Keypair } from "@stellar/stellar-sdk";

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

const hex = (kp: Keypair) => Buffer.from(kp.rawPublicKey()).toString("hex");

async function main() {
  console.log("============================================================");
  console.log(" SELF-TEST — claim password (link key derivation)");
  console.log("============================================================\n");

  const seed = makeLinkSeed();
  // A throwaway fixture, not a credential — it guards nothing and unlocks nothing. The
  // secret scanner reads it as a high-entropy string, so the exemption is pinned to this
  // one line rather than the file, and the file stays scanned like every other.
  const password = "izmir-kahve-42"; // gitleaks:allow

  const a = await deriveLinkKey(seed, password);
  const b = await deriveLinkKey(seed, password);
  ok("same seed + same password derive the same key (the recipient can always claim)", hex(a) === hex(b));

  const wrong = await deriveLinkKey(seed, "izmir-kahve-43");
  ok("a different password derives a different key", hex(wrong) !== hex(a));

  const otherSeed = makeLinkSeed();
  const otherLink = await deriveLinkKey(otherSeed, password);
  ok("the same password on another link derives another key (links are independent)", hex(otherLink) !== hex(a));

  const unlocked = await unlockLink(seed, password, hex(a));
  ok("the right password unlocks the link", unlocked.ok && unlocked.secret === a.secret());

  const refused = await unlockLink(seed, "not-the-password", hex(a));
  ok("a wrong password is refused locally, before anything is submitted", !refused.ok);

  const frag = passwordFragment(seed);
  const parsed = parseLinkFragment(frag);
  ok(
    "the fragment round-trips to the same seed",
    parsed?.kind === "password" && Buffer.from(parsed.seed).equals(Buffer.from(seed)),
  );
  ok("the fragment never carries the password", !frag.includes(password));

  const plain = Keypair.random();
  const asKey = parseLinkFragment(plain.secret());
  ok("a plain bearer fragment is still read as a key (the default link is unchanged)",
    asKey?.kind === "key" && asKey.secret === plain.secret());

  ok("an empty fragment is rejected", parseLinkFragment("") === null);
  ok("a truncated password fragment is rejected", parseLinkFragment("p1.abc") === null);

  ok("the password floor rejects a 4-character password", claimPasswordProblem("1234") !== null);
  ok("the password floor rejects a repeated character", claimPasswordProblem("aaaaaaaa") !== null);
  ok("the password floor accepts a normal one", claimPasswordProblem("kahve-42") === null);

  console.log(`\n${failed === 0 ? "✅" : "❌"} CLAIM-PASSWORD SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

void main();
