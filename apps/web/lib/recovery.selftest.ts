/**
 * Recovery crypto self-test — the funds-handling wrap/unwrap that "durable recovery" rests on
 * (RECOVERY_ARCHITECTURE §3.3/§7). Spike S1 proved this once in a scratchpad; this is the
 * COMMITTED version so it never silently regresses. Covers BOTH copies: password (Argon2id
 * floor) AND passkey-PRF (Face ID upgrade — the crypto the WebAuthn ceremony in
 * lib/passkey-prf.ts feeds, exercised here with a deterministic MOCK PRF output; real-device
 * PRF is Spike #2, owner hardware).
 *
 * The load-bearing invariant: EITHER copy re-opens the EXACT 32-byte seed → the SAME G…
 * address on any device (that IS recovery), and a wrong password / wrong PRF / tampered
 * ciphertext are ALL rejected by AES-GCM auth (never a silent wrong seed).
 *
 * RUN: pnpm --filter @lumenia/web exec tsx lib/recovery.selftest.ts   (offline, no keys)
 */
import { Keypair } from "@stellar/stellar-sdk";
import {
  wrapWithPassword,
  unwrapWithPassword,
  wrapWithPrf,
  unwrapWithPrf,
  emptyBox,
  putCopy,
  findCopy,
} from "./recovery";
import { DEFAULT_ARGON } from "./argon";

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
async function rejects(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    ok(`${label} — REJECTED`, false);
  } catch {
    ok(`${label} — REJECTED`, true);
  }
}
const addr = (seed: Uint8Array) => Keypair.fromRawEd25519Seed(Buffer.from(seed)).publicKey();
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
// A faster Argon for the test loop (correctness is param-independent; DEFAULT_ARGON is exercised once).
const FAST = { memMiB: 8, time: 1, parallelism: 1 };

async function main() {
  console.log("============================================================");
  console.log(" RECOVERY CRYPTO SELF-TEST (password + Face-ID/PRF)");
  console.log("============================================================\n");

  const seed = crypto.getRandomValues(new Uint8Array(32));
  const account = addr(seed);
  console.log(`account under test: ${account}\n`);

  console.log("[password] Argon2id floor");
  {
    const copy = await wrapWithPassword(seed, "correct horse battery", FAST);
    const back = await unwrapWithPassword(copy, "correct horse battery");
    ok("round-trip re-opens the exact seed", eq(back, seed));
    ok("recovered seed → the SAME account address", addr(back) === account);
    await rejects("wrong password", () => unwrapWithPassword(copy, "wrong password"));
    const tampered = { ...copy, ct: copy.ct.slice(0, -4) + (copy.ct.endsWith("A") ? "B" : "A") + copy.ct.slice(-3) };
    await rejects("tampered ciphertext", () => unwrapWithPassword(tampered, "correct horse battery"));
  }

  console.log("\n[prf] Face ID / passkey-PRF upgrade (mock PRF output)");
  {
    const prf = crypto.getRandomValues(new Uint8Array(32)); // stands in for the WebAuthn PRF output
    const copy = await wrapWithPrf(seed, prf);
    const back = await unwrapWithPrf(copy, prf);
    ok("round-trip re-opens the exact seed", eq(back, seed));
    ok("recovered seed → the SAME account address", addr(back) === account);
    const wrongPrf = crypto.getRandomValues(new Uint8Array(32));
    await rejects("wrong PRF output", () => unwrapWithPrf(copy, wrongPrf));
  }

  console.log("\n[box] two independent copies of one seed");
  {
    const prf = crypto.getRandomValues(new Uint8Array(32));
    let box = emptyBox();
    box = putCopy(box, await wrapWithPassword(seed, "pw", FAST));
    box = putCopy(box, await wrapWithPrf(seed, prf));
    ok("box holds both copies", box.copies.length === 2);
    ok("findCopy(password) present", !!findCopy(box, "password"));
    ok("findCopy(prf) present", !!findCopy(box, "prf"));
    const viaPw = await unwrapWithPassword(findCopy(box, "password")!, "pw");
    const viaPrf = await unwrapWithPrf(findCopy(box, "prf")!, prf);
    ok("BOTH copies re-open the SAME address (either device path works)", addr(viaPw) === account && addr(viaPrf) === account);
    // putCopy replaces same-kind (at most one per kind)
    box = putCopy(box, await wrapWithPassword(seed, "pw2", FAST));
    ok("putCopy replaces the same kind (still 2 copies)", box.copies.length === 2 && !!findCopy(box, "prf"));
  }

  console.log("\n[params] DEFAULT_ARGON exercised once (the shipped floor params)");
  {
    const copy = await wrapWithPassword(seed, "shipped params", DEFAULT_ARGON);
    ok("DEFAULT_ARGON round-trip", addr(await unwrapWithPassword(copy, "shipped params")) === account);
  }

  console.log("\n============================================================");
  console.log(failed === 0 ? ` ✅ RECOVERY SELF-TEST PASS (${passed}/${passed + failed})` : ` ❌ FAIL (${failed})`);
  console.log("============================================================");
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\n💥 recovery self-test crashed:", e);
  process.exit(1);
});
