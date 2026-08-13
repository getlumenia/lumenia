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
  prfToBoxId,
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
// A faster Argon for the test loop (correctness is param-independent; DEFAULT_ARGON is exercised
// once). These are the ARGON_BOUNDS minimums, not lower: since the 2026-08-08 hardening,
// below-floor params are rejected on unwrap (attacker-influenced wire input), so the selftest
// must exercise in-bounds params — the old 8/1/1 made the very first unwrap throw and the whole
// suite abort with 0 checks.
const FAST = { memMiB: 19, time: 2, parallelism: 1 };

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

  /* ---------------------------------------------------------------------------
   * [id] The PRF-derived box id — what makes "find my money with Face ID" possible.
   *
   * This id is handed to a server, so the load-bearing claim is that it leaks nothing about the
   * key that opens the box. And it is WIRE FORMAT: the frozen vector below is the thing that
   * fails loudly if anyone changes the HKDF label, the salt or the length, instead of silently
   * orphaning every stored backup and telling people "no backup found" for money that is safe.
   * ------------------------------------------------------------------------- */
  console.log("\n[id] prfToBoxId — the passkey-derived lookup id");
  {
    const prfA = new Uint8Array(32).map((_, i) => i); // 0x00…0x1f
    const prfB = new Uint8Array(32).fill(9);
    const idA = await prfToBoxId(prfA);
    const idA2 = await prfToBoxId(prfA);
    const idB = await prfToBoxId(prfB);

    ok("deterministic — the same passkey always finds the same backup", idA === idA2);
    ok("64 lowercase hex (the store's id shape)", /^[0-9a-f]{64}$/.test(idA));
    ok("a different passkey derives a different id", idA !== idB);
    ok(
      "FROZEN VECTOR — the wire format has not drifted",
      idA === "14f8b0e801e85063ca99b95806f9803f1ab1ffde4a91baf8c22616e8c6d73e44",
    );

    // Independence: the id must not be usable as the wrap key. If HKDF's info label or salt were
    // ever made to collide, this would start passing and the id would be leaking key material.
    const box = putCopy(emptyBox(), await wrapWithPrf(seed, prfA));
    const asKey = Uint8Array.from(idA.match(/../g)!.map((h) => Number.parseInt(h, 16)));
    let opened = false;
    try {
      await unwrapWithPrf(findCopy(box, "prf")!, asKey);
      opened = true;
    } catch {
      /* expected */
    }
    ok("the id is NOT the key — it cannot open the box it addresses", !opened);
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
