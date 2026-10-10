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
 * ONE EMAIL, ONE ACCOUNT (LUMENIA ACCOUNT CONTRACT v1). The second half drives the website's
 * recovery client (lib/recovery-client.ts) against a fake sponsor, and the pure rules around it:
 *   [w1]  every backup is signed by the account it backs up, also an account with no password on
 *         real money (which getSigner refuses), and always for the RECOVERY host's network;
 *   [w2]  a backup the email already holds for another account comes back as a conflict carrying
 *         that box (a ticket only for an unbound row), never as an overwrite; tickets, fetch,
 *         check; the conflict plan; the per-account record, the old list included;
 *   [w3]  the account's name everywhere: short address, masked email, the account line;
 *   [w5]  leaving the device is one tap only when every account here is confirmed backed up;
 *   [w14] changing the backup email releases the old one, signed, and the record follows.
 * The golden vectors are the contract's own (seed 32 x 0x01, ts 1760000000, nonce 0123456789abcdef).
 *
 * RUN: pnpm --filter @lumenia/web test:recovery   (offline, no keys, no network)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

  await accountContract();

  console.log("\n============================================================");
  console.log(failed === 0 ? ` ✅ RECOVERY SELF-TEST PASS (${passed}/${passed + failed})` : ` ❌ FAIL (${failed})`);
  console.log("============================================================");
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\n💥 recovery self-test crashed:", e);
  process.exit(1);
});

/* ===========================================================================
 * LUMENIA ACCOUNT CONTRACT v1, the website's half (W1, W2, W3, W5, W14).
 * ========================================================================= */

/** A Storage that lives in memory, so the record and the device's network switch can be driven. */
class MemoryStorage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
}

const GOLDEN = {
  pubkey: "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR",
  email: "  Founder@Example.com ",
  emailId: "fb72704240c3527ba45904a8705865922f70a9c4f3c11bfa93c839f939945884",
  ts: 1760000000,
  nonce: "0123456789abcdef",
  write: "h6zhlw5Gx5zDuK/kiRYEUAlrd8rRSz/V0AZhIeYBCtHwPGgVCdSoVGHmxP4DkJtFuDRfnSOSXZfymsBqkj07BA==",
  check: "i5ORTu/1MEH2aIDhPQL8BrOWZfZk4Yiy8xMv/vkDU9WT+MC4sDrtiMBtUbu4QX2p/csnvdVoedEHYmQvvO2cDw==",
  release: "SNdv504x5awpCGipDXOjfycaapxHt/xjxLZVukaKgwf/CORI1XwOgXItkWVKbMc0n40oXc010BYdDRZ1FK5BDQ==",
};
const RECOVERY_URL = "https://lumenia-sponsor.avakit.workers.dev";

/** A sponsor played by a fake fetch: every request is recorded, `reply` decides each answer. */
function fakeSponsor(reply: (url: string, body: Record<string, unknown>) => Response | "throw") {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, body });
    const r = reply(url, body);
    if (r === "throw") throw new TypeError("Failed to fetch");
    return r;
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const verifies = (pubkey: string, message: string, proofB64: string) =>
  Keypair.fromPublicKey(pubkey).verify(Buffer.from(message, "utf8"), Buffer.from(proofB64, "base64"));
async function throwsWith(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = (...parts: string[]): string => readFileSync(join(WEB_ROOT, ...parts), "utf8");

async function accountContract(): Promise<void> {
  /* The device is on REAL money for [w1]: a mainnet-configured build, switched to public. Set before
     the first import of lib/network.ts, which reads both when it loads. */
  const env = process.env as Record<string, string | undefined>;
  delete env.NEXT_PUBLIC_SPONSOR_URL;
  env.NEXT_PUBLIC_SPONSOR_URL_MAINNET = "https://lumenia-sponsor-mainnet.avakit.workers.dev";
  env.NEXT_PUBLIC_LUMENDROP_CONTRACT_MAINNET = "CTESTMAINNETCONTRACTFORTHESELFTESTONLY";
  const storage = new MemoryStorage();
  const g = globalThis as unknown as { localStorage?: Storage; window?: unknown };
  g.localStorage = storage as unknown as Storage;
  g.window = { localStorage: storage };
  storage.setItem("lumenia.network", "public");

  const { activeNetwork } = await import("./network");
  const { handleProofMessage } = await import("./handles");
  const { localSignerFromSeed } = await import("./signer");
  const { emailId, signOwnerProof } = await import("./owner-proof");
  const rc = await import("./recovery-client");
  const rec = await import("./backup-record");
  const label = await import("./account-label");
  const { disconnectTier, unconfirmedAccounts } = await import("./leave-device");

  const seed = new Uint8Array(32).fill(1); // TEST-ONLY
  const signer = localSignerFromSeed(seed);
  const pk = signer.publicKey();
  const at = { ts: GOLDEN.ts, nonce: GOLDEN.nonce };
  const box = putCopy(emptyBox(), await wrapWithPassword(seed, "correct horse battery", FAST));

  console.log("\n[w1] the golden vectors (contract 1)");
  ok("seed 32 x 0x01 is the golden account", pk === GOLDEN.pubkey);
  const id = await emailId(GOLDEN.email);
  ok("emailId trims and lowercases, then hashes", id === GOLDEN.emailId);
  ok(
    "the write/testnet message, byte for byte",
    handleProofMessage("links", id, pk, GOLDEN.ts, GOLDEN.nonce, "testnet") ===
      `lumenia-handle-links:v1:${GOLDEN.emailId}:${GOLDEN.pubkey}:1760000000:0123456789abcdef:testnet`,
  );
  ok("the write/testnet signature", (await signOwnerProof(signer, "links", id, "testnet", at)).proof === GOLDEN.write);
  ok("the check/testnet signature", (await signOwnerProof(signer, "links", `check:${id}`, "testnet", at)).proof === GOLDEN.check);
  ok("the release/testnet signature", (await signOwnerProof(signer, "links", `release:${id}`, "testnet", at)).proof === GOLDEN.release);

  console.log("\n[w1] a backup is always signed by the account it backs up");
  ok("the device is on real money for this check", activeNetwork().id === "public");
  ok("  ...and the recovery host still answers for practice money", rc.recoveryHostNetwork() === "testnet");
  {
    /* An account with no password on real money: getSigner refuses it (NeedsPasswordError,
       lib/wallet.tsx), which is why the backup step used to post unsigned. secureRecovery now hands
       commit the signer of the seed it holds; this is that signer. */
    const s1 = fakeSponsor(() => json(200, { ok: true, bound: true }));
    const r = await rc.storeBox({ email: GOLDEN.email, box, code: "123456", signer: localSignerFromSeed(seed), fetchImpl: s1.fetchImpl });
    const call = s1.calls[0]!;
    const owner = call.body.owner as { pubkey: string; ts: number; nonce: string; proof: string };
    ok("posted once, to the recovery host's /recovery", s1.calls.length === 1 && call.url === `${RECOVERY_URL}/recovery`);
    ok("owner.pubkey is the account being backed up", owner?.pubkey === pk);
    ok(
      "Keypair.verify accepts the proof over the TESTNET links message for this email",
      verifies(pk, handleProofMessage("links", id, pk, owner.ts, owner.nonce, "testnet"), owner.proof),
    );
    ok("  ...and not over the mainnet one (the device's switch never leaks into it)", !verifies(pk, handleProofMessage("links", id, pk, owner.ts, owner.nonce, "mainnet"), owner.proof));
    ok("a fresh nonce of 16 lowercase hex and a current time", /^[0-9a-f]{16}$/.test(owner.nonce) && Math.abs(owner.ts - Date.now() / 1000) < 60);
    ok("the code goes, no ticket, no replace", call.body.code === "123456" && !("ticket" in call.body) && !("replace" in call.body));
    ok("the box goes as given, under the email's id", call.body.id === id && JSON.stringify(call.body.box) === JSON.stringify(box));
    ok("the server's bound answer comes back", r.bound === true);
  }
  {
    const s2 = fakeSponsor(() => json(200, { ok: true }));
    const e = await throwsWith(() => rc.storeBox({ email: GOLDEN.email, box, code: "123456", signer: undefined, fetchImpl: s2.fetchImpl }));
    ok("no signer: refused before anything is posted", e instanceof Error && e.message === rc.CANNOT_SIGN_BACKUP && s2.calls.length === 0);
    const noRaw = { kind: "passkey-smart-account" as const, publicKey: () => pk, sign: async (t: never) => t };
    const e2 = await throwsWith(() => rc.storeBox({ email: GOLDEN.email, box, code: "123456", signer: noRaw, fetchImpl: s2.fetchImpl }));
    ok("a signer that cannot sign a message: the same refusal, nothing posted", e2 instanceof Error && e2.message === rc.CANNOT_SIGN_BACKUP && s2.calls.length === 0);
    ok("  ...in the contract's words", rc.CANNOT_SIGN_BACKUP === "We couldn't sign this backup. Unlock and try again.");
    const old = await rc.storeBox({ email: GOLDEN.email, box, code: "123456", signer, fetchImpl: s2.fetchImpl });
    ok("an older server that does not say bound: null, never a guess", old.bound === null);
  }
  {
    const wallet = source("lib", "wallet.tsx");
    const flow = source("components", "brand", "RecoveryFlow.tsx");
    ok("wallet.tsx secureRecovery builds the signer from the seed it holds and hands it to commit", /const signer = localSignerFromSeed\(seed\);[\s\S]{0,600}await commit\(box, signer\)/.test(wallet));
    ok("RecoveryFlow no longer asks getSigner for the backup's signature", !/getSigner\(\{ movesMoney: false \}\)\.catch\(\(\) => undefined\)/.test(flow) && !/\bgetSigner\b/.test(flow));
    ok("RecoveryFlow stores through lib/recovery-client.ts, not the extension's storeRecoveryBox", /storeBox\(/.test(flow) && !/storeRecoveryBox/.test(flow));
  }

  console.log("\n[w2] a conflict, never an overwrite (contract 2.2)");
  const stored = putCopy(emptyBox(), await wrapWithPassword(crypto.getRandomValues(new Uint8Array(32)), "another one entirely", FAST));
  const TICKET = "ab".repeat(32);
  const TAKEN = "That email already holds a backup for a different account. Use another email address for this one.";
  {
    const s = fakeSponsor(() => json(409, { error: TAKEN, code: "email-taken", unbound: false, box: stored, ticket: TICKET }));
    const e = await throwsWith(() => rc.storeBox({ email: GOLDEN.email, box, code: "123456", signer, fetchImpl: s.fetchImpl }));
    ok("409 bound: a BackupConflict", e instanceof rc.BackupConflict);
    const c = e as InstanceType<typeof rc.BackupConflict>;
    ok("  ...carrying the stored box exactly", JSON.stringify(c.box) === JSON.stringify(stored));
    ok("  ...unbound false, and no ticket even if one were sent", c.unbound === false && c.ticket === undefined);
    ok("  ...with the server's sentence (what the extension's old regex matches)", /already holds a backup for a different account/.test(c.message));
  }
  {
    const s = fakeSponsor(() => json(409, { error: TAKEN, code: "email-taken", unbound: true, box: stored, ticket: TICKET }));
    const c = (await throwsWith(() => rc.storeBox({ email: GOLDEN.email, box, code: "123456", signer, fetchImpl: s.fetchImpl }))) as InstanceType<typeof rc.BackupConflict>;
    ok("409 unbound: unbound true, with its ticket", c instanceof rc.BackupConflict && c.unbound === true && c.ticket === TICKET);
    const bad = fakeSponsor(() => json(409, { error: TAKEN, code: "email-taken", unbound: true, box: stored, ticket: "not-hex" }));
    const c2 = (await throwsWith(() => rc.storeBox({ email: GOLDEN.email, box, code: "123456", signer, fetchImpl: bad.fetchImpl }))) as InstanceType<typeof rc.BackupConflict>;
    ok("  ...and a malformed ticket is dropped, not passed on", c2 instanceof rc.BackupConflict && c2.ticket === undefined);
  }
  {
    const s = fakeSponsor(() => json(200, { ok: true, bound: true }));
    const r = await rc.storeBox({ email: GOLDEN.email, box, ticket: TICKET, replace: true, signer, fetchImpl: s.fetchImpl });
    const b = s.calls[0]!.body;
    ok("a ticket request carries the ticket, NO code field, and replace:true", b.ticket === TICKET && !("code" in b) && b.replace === true && r.bound === true);
    const both = await throwsWith(() => rc.storeBox({ email: GOLDEN.email, box, code: "123456", ticket: TICKET, signer, fetchImpl: s.fetchImpl }));
    const neither = await throwsWith(() => rc.storeBox({ email: GOLDEN.email, box, signer, fetchImpl: s.fetchImpl }));
    ok("exactly one of code and ticket, refused before posting", both instanceof Error && neither instanceof Error && s.calls.length === 1);
  }
  {
    const s = fakeSponsor(() => json(401, { error: "invalid or expired code" }));
    const t = await throwsWith(() => rc.storeBox({ email: GOLDEN.email, box, ticket: TICKET, replace: true, signer, fetchImpl: s.fetchImpl }));
    ok("a ticket that comes back 401 says the contract's expiry line", t instanceof rc.RecoveryRefusal && t.message === "That took too long. Send a new code and try again." && t.status === 401);
    const c = await throwsWith(() => rc.storeBox({ email: GOLDEN.email, box, code: "000000", signer, fetchImpl: s.fetchImpl }));
    ok("a wrong code is a wrong code", c instanceof rc.RecoveryRefusal && c.message === "That code is wrong or has expired.");
    const BUDGET = "Too many tries for this email in the last hour. Wait, then ask for a new code.";
    const b = fakeSponsor(() => json(429, { error: BUDGET, code: "otp-budget" }));
    const r = await throwsWith(() => rc.storeBox({ email: GOLDEN.email, box, code: "123456", signer, fetchImpl: b.fetchImpl }));
    ok("429 otp-budget surfaces the server's sentence and code", r instanceof rc.RecoveryRefusal && r.message === BUDGET && r.code === "otp-budget");
    const f = await throwsWith(() => rc.fetchBox(GOLDEN.email, "123456", { fetchImpl: b.fetchImpl }));
    ok("  ...on a fetch too", f instanceof rc.RecoveryRefusal && f.message === BUDGET);
  }

  console.log("\n[w2] fetch and check (contract 2.3, 2.4)");
  {
    const unbound = await rc.fetchBox(GOLDEN.email, "123456", { fetchImpl: fakeSponsor(() => json(200, { box: stored, bound: false, ticket: TICKET })).fetchImpl });
    ok("an unbound row: bound false, with the ticket to tie it", unbound?.bound === false && unbound.ticket === TICKET);
    const bound = await rc.fetchBox(GOLDEN.email, "123456", { fetchImpl: fakeSponsor(() => json(200, { box: stored, bound: true, ticket: TICKET })).fetchImpl });
    ok("a bound row: bound true, and no ticket", bound?.bound === true && bound.ticket === undefined);
    const s = fakeSponsor(() => json(200, { box: stored }));
    const old = await rc.fetchBox(GOLDEN.email, "123456", { fetchImpl: s.fetchImpl });
    ok("an older server: bound null (unknown), never false", old !== null && old.bound === null && old.ticket === undefined);
    ok("  ...asked with the email's id and the code, at /recovery-fetch", s.calls[0]!.url === `${RECOVERY_URL}/recovery-fetch` && s.calls[0]!.body.id === id && s.calls[0]!.body.code === "123456");
    ok("404: no backup (null)", (await rc.fetchBox(GOLDEN.email, "123456", { fetchImpl: fakeSponsor(() => json(404, { error: "not found" })).fetchImpl })) === null);
  }
  {
    const s = fakeSponsor(() => json(200, { mine: true }));
    ok("check: mine", (await rc.checkMine(GOLDEN.email, signer, { fetchImpl: s.fetchImpl })) === "mine");
    const owner = s.calls[0]!.body.owner as { pubkey: string; ts: number; nonce: string; proof: string };
    ok(
      "  ...posted to /recovery-check with no code, signed over check:<id> for testnet",
      s.calls[0]!.url === `${RECOVERY_URL}/recovery-check` && !("code" in s.calls[0]!.body) && s.calls[0]!.body.id === id &&
        verifies(pk, handleProofMessage("links", `check:${id}`, pk, owner.ts, owner.nonce, "testnet"), owner.proof),
    );
    ok("check: not mine", (await rc.checkMine(GOLDEN.email, signer, { fetchImpl: fakeSponsor(() => json(200, { mine: false })).fetchImpl })) === "not-mine");
    ok("check 404 (an older server): unknown, never not-mine", (await rc.checkMine(GOLDEN.email, signer, { fetchImpl: fakeSponsor(() => json(404, { error: "not found" })).fetchImpl })) === "unknown");
    ok("check with no connection: unknown", (await rc.checkMine(GOLDEN.email, signer, { fetchImpl: fakeSponsor(() => "throw").fetchImpl })) === "unknown");
    ok("check 401 or a body with no answer: unknown", (await rc.checkMine(GOLDEN.email, signer, { fetchImpl: fakeSponsor(() => json(401, { error: "x" })).fetchImpl })) === "unknown" && (await rc.checkMine(GOLDEN.email, signer, { fetchImpl: fakeSponsor(() => json(200, {})).fetchImpl })) === "unknown");
  }

  console.log("\n[w2] after a restore: tie an untied row, or ask (lib/recovery-client.ts tieRestored)");
  {
    const s = fakeSponsor(() => json(200, { ok: true, bound: true }));
    const tied = await rc.tieRestored(GOLDEN.email, { box: stored, bound: false, ticket: TICKET }, signer, { fetchImpl: s.fetchImpl });
    ok(
      "an untied row with its ticket: one signed /recovery with the ticket and replace, no code, the same box: true",
      tied === true && s.calls.length === 1 && s.calls[0]!.url === `${RECOVERY_URL}/recovery` && s.calls[0]!.body.ticket === TICKET &&
        s.calls[0]!.body.replace === true && !("code" in s.calls[0]!.body) && JSON.stringify(s.calls[0]!.body.box) === JSON.stringify(stored),
    );
    const expired = await rc.tieRestored(GOLDEN.email, { box: stored, bound: false, ticket: TICKET }, signer, {
      fetchImpl: fakeSponsor(() => json(401, { error: "invalid or expired code" })).fetchImpl,
    });
    ok("the server said untied and the bind did not go through (ticket ran out): false, never unknown", expired === false);
    const offline = await rc.tieRestored(GOLDEN.email, { box: stored, bound: false, ticket: TICKET }, signer, { fetchImpl: fakeSponsor(() => "throw").fetchImpl });
    ok("  ...nor with no connection: false", offline === false);
    const noTicket = fakeSponsor(() => json(200, { ok: true, bound: true }));
    ok("untied with no ticket: false, and nothing is posted", (await rc.tieRestored(GOLDEN.email, { box: stored, bound: false }, signer, { fetchImpl: noTicket.fetchImpl })) === false && noTicket.calls.length === 0);
    const mine = fakeSponsor(() => json(200, { mine: true }));
    ok(
      "a tied row: asked with /recovery-check, mine is true",
      (await rc.tieRestored(GOLDEN.email, { box: stored, bound: true }, signer, { fetchImpl: mine.fetchImpl })) === true && mine.calls[0]!.url === `${RECOVERY_URL}/recovery-check`,
    );
    ok("a tied row that is not this account's: false", (await rc.tieRestored(GOLDEN.email, { box: stored, bound: true }, signer, { fetchImpl: fakeSponsor(() => json(200, { mine: false })).fetchImpl })) === false);
    ok("an older server (no bound, a 404 check): null, never false", (await rc.tieRestored(GOLDEN.email, { box: stored, bound: null }, signer, { fetchImpl: fakeSponsor(() => json(404, { error: "not found" })).fetchImpl })) === null);
    ok("RecoveryFlow ties a restore through it", source("components", "brand", "RecoveryFlow.tsx").includes("tieRestored(typedEmail, f, signer)"));
  }

  console.log("\n[w2] the conflict plan (contract 5.4)");
  {
    const A = GOLDEN.pubkey;
    const B = Keypair.random().publicKey();
    ok("it opens to THIS account: bind-own", rc.conflictPlan(A, A, true).kind === "bind-own" && rc.conflictPlan(A, A, false).kind === "bind-own");
    ok("it opens to another account: offer-bring, never a replace", rc.conflictPlan(B, A, true).kind === "offer-bring" && rc.conflictPlan(B, A, false).kind === "offer-bring");
    const u = rc.conflictPlan(null, A, true);
    const b = rc.conflictPlan(null, A, false);
    ok("it does not open, unbound row: ask for its password, Replace offered", u.kind === "ask-password" && u.offerReplace === true);
    ok("it does not open, bound row: ask for its password, Replace NEVER offered", b.kind === "ask-password" && b.offerReplace === false);
    ok("the hint under every email field (contract 5.5)", rc.EMAIL_HINT === "Type it the same way every time: first.last@gmail.com and firstlast@gmail.com are two different emails here.");
  }

  console.log("\n[w2] the per-account record (localStorage lumenia.backups, contract 6)");
  {
    storage.removeItem("lumenia.backups");
    storage.setItem("lumenia.backedup", JSON.stringify(["GLEGACYACCOUNT"]));
    ok("nothing recorded: no backup, not confirmed", !rec.hasBackup(pk) && !rec.isConfirmedBackup(pk) && rec.backupRecord(pk) === null);
    const legacy = rec.backupRecord("GLEGACYACCOUNT");
    ok("the old list still reads, as email null and bound null", legacy !== null && legacy.email === null && legacy.bound === null && rec.hasBackup("GLEGACYACCOUNT"));
    ok("  ...which is backed up but NOT confirmed", !rec.isConfirmedBackup("GLEGACYACCOUNT"));
    rec.markBackedUp(pk, GOLDEN.email, true, 1000);
    const r1 = rec.backupRecord(pk);
    ok("a signed write that came back bound: the email, normalized, and bound true", r1?.email === "founder@example.com" && r1.bound === true && r1.at === 1000);
    const raw = JSON.parse(storage.getItem("lumenia.backups") ?? "{}") as Record<string, unknown>;
    ok("  ...stored in the contract's shape, the legacy entry folded in", JSON.stringify(raw[pk]) === JSON.stringify({ email: "founder@example.com", at: 1000, bound: true }) && "GLEGACYACCOUNT" in raw);
    rec.markBackedUp(pk, "FOUNDER@example.com", null, 2000);
    ok("an older server's 'cannot say' for the SAME email keeps the earlier answer", rec.backupRecord(pk)?.bound === true);
    rec.markBackedUp(pk, "other@example.com", null, 3000);
    ok("a different email starts from unknown", rec.backupRecord(pk)?.bound === null && rec.backupRecord(pk)?.email === "other@example.com");
    rec.markBackedUp(pk, null, false, 4000);
    ok("bound false with no email keeps the email it had", rec.backupRecord(pk)?.email === "other@example.com" && rec.backupRecord(pk)?.bound === false);
    rec.forgetBackupRecord("GLEGACYACCOUNT");
    ok("forgetting an account drops it from both lists", rec.backupRecord("GLEGACYACCOUNT") === null && !(JSON.parse(storage.getItem("lumenia.backedup") ?? "[]") as string[]).includes("GLEGACYACCOUNT"));
    storage.setItem("lumenia.backups", "{not json");
    ok("an unreadable record reads as none, never throws", rec.backupRecord(pk) === null && Object.keys(rec.backupRecords()).length === 0);
    rec.forgetAllBackupRecords();
    ok("leaving the browser forgets every record", storage.getItem("lumenia.backups") === null && storage.getItem("lumenia.backedup") === null);
  }

  console.log("\n[w3] naming the account (contract 0.3, 5.3)");
  {
    ok("short(G) golden: GCFIRY...XVYOJR", label.shortAddress(GOLDEN.pubkey) === "GCFIRY...XVYOJR");
    ok("masked(email) golden: f***@example.com", label.maskEmail(GOLDEN.email) === "f***@example.com");
    ok("masked takes the LAST @", label.maskEmail("A@b@Host.example") === "a***@host.example");
    const line = (r: Parameters<typeof label.accountLine>[1]) => label.accountLine(GOLDEN.pubkey, r);
    ok("no record: not backed up yet, no action", line(null).text === "GCFIRY...XVYOJR, not backed up yet" && line(null).action === null);
    ok("an email known: backed up with the masked email", line({ email: "founder@example.com", at: 1, bound: true }).text === "GCFIRY...XVYOJR, backed up with f***@example.com");
    ok("  ...also while the binding is unknown", line({ email: "founder@example.com", at: 1, bound: null }).text === "GCFIRY...XVYOJR, backed up with f***@example.com");
    const legacyLine = line({ email: null, at: 0, bound: null });
    ok("backed up, email unknown: 'backed up' + Add your backup email", legacyLine.text === "GCFIRY...XVYOJR, backed up" && legacyLine.action === "add-email" && label.ACCOUNT_LINE_ACTION["add-email"] === "Add your backup email");
    const untied = line({ email: "founder@example.com", at: 1, bound: false });
    ok("the server said not tied: 'backup not tied to this account yet' + Back it up again", untied.text === "GCFIRY...XVYOJR, backup not tied to this account yet" && untied.action === "back-up-again" && label.ACCOUNT_LINE_ACTION["back-up-again"] === "Back it up again");
    ok("an added email that does not check out", label.NOT_THIS_ACCOUNTS_EMAIL === "That email doesn't back up this account.");
    const ascii = (t: string) => /^[\x20-\x7E]*$/.test(t);
    ok("every line is plain ASCII", [line(null).text, legacyLine.text, untied.text, line({ email: "x@y.z", at: 1, bound: true }).text].every(ascii));
    for (const [name, src] of [
      ["AccountMenu.tsx", source("components", "brand", "AccountMenu.tsx")],
      ["app/(app)/account/page.tsx", source("app", "(app)", "account", "page.tsx")],
      ["AccountsCard.tsx", source("components", "brand", "AccountsCard.tsx")],
    ] as const) {
      ok(`${name} imports shortAddress from lib/account-label.ts`, /import \{[^}]*\bshortAddress\b[^}]*\} from "[./]+lib\/account-label"/.test(src));
      ok(`  ...and puts no U+2026 next to an address`, !/slice\(\s*0\s*,\s*\d+\s*\)\}?\u2026|\u2026\$?\{?[^}\n]{0,40}slice\(\s*-\d+\s*\)/.test(src));
    }
  }

  console.log("\n[w5] leaving the device (lib/leave-device.ts disconnectTier)");
  {
    const A = "GACTIVE";
    const B = "GOTHER";
    const bound = { email: "a@x.io", at: 1, bound: true };
    const all = { [A]: bound, [B]: bound };
    ok("every account here confirmed backed up, no claim money: one tap", disconnectTier({ userAccounts: [A, B], records: all, throwawayWithMoney: false }) === "one-tap");
    ok("one unconfirmed account that is NOT the active one: typed", disconnectTier({ userAccounts: [A, B], records: { [A]: bound }, throwawayWithMoney: false }) === "typed");
    ok("a legacy record (bound unknown): typed", disconnectTier({ userAccounts: [A], records: { [A]: { email: null, at: 0, bound: null } }, throwawayWithMoney: false }) === "typed");
    ok("a server answer of not tied (bound false): typed", disconnectTier({ userAccounts: [A], records: { [A]: { ...bound, bound: false } }, throwawayWithMoney: false }) === "typed");
    ok("a claim account still holding money: typed", disconnectTier({ userAccounts: [A, B], records: all, throwawayWithMoney: true }) === "typed");
    ok("a fresh check answering not-mine: typed, whatever the record says", disconnectTier({ userAccounts: [A, B], records: all, throwawayWithMoney: false, notMine: [A] }) === "typed");
    ok("the typed tier names each account without a confirmed backup", JSON.stringify(unconfirmedAccounts({ userAccounts: [A, B], records: { [A]: bound }, notMine: [] })) === JSON.stringify([B]));
    const btn = source("components", "brand", "DisconnectButton.tsx");
    ok("the button names what it removes: one account, or every account", btn.includes("Remove this account from this browser") && btn.includes("Remove every account from this browser") && btn.includes(": no confirmed backup"));
    for (const caller of [source("app", "(app)", "account", "page.tsx"), source("app", "(app)", "settings", "page.tsx"), source("components", "brand", "AccountMenu.tsx")]) {
      ok("  ...and its callers pass no backedUp of their own", /<DisconnectButton \/>/.test(caller) && !/backedUp=\{/.test(caller));
    }
  }

  console.log("\n[w14] change backup email: the old one is released, signed (contract 2.5)");
  {
    const s = fakeSponsor(() => json(200, { ok: true }));
    ok("released", (await rc.releaseEmail(GOLDEN.email, signer, { fetchImpl: s.fetchImpl, at })) === "released");
    const b = s.calls[0]!.body;
    const owner = b.owner as { pubkey: string; ts: number; nonce: string; proof: string };
    ok("posted to /recovery-release with the old email's id", s.calls[0]!.url === `${RECOVERY_URL}/recovery-release` && b.id === GOLDEN.emailId);
    ok("the proof is the golden release/testnet signature", owner.pubkey === GOLDEN.pubkey && owner.ts === GOLDEN.ts && owner.nonce === GOLDEN.nonce && owner.proof === GOLDEN.release);
    ok(
      "  ...over the golden release message",
      verifies(pk, `lumenia-handle-links:v1:release:${GOLDEN.emailId}:${GOLDEN.pubkey}:1760000000:0123456789abcdef:testnet`, owner.proof),
    );
    ok("409 not-yours", (await rc.releaseEmail(GOLDEN.email, signer, { fetchImpl: fakeSponsor(() => json(409, { error: "That email doesn't back up this account.", code: "not-yours" })).fetchImpl })) === "not-yours");
    ok("404 (an older server): unknown", (await rc.releaseEmail(GOLDEN.email, signer, { fetchImpl: fakeSponsor(() => json(404, { error: "not found" })).fetchImpl })) === "unknown");

    storage.clear();
    rec.recordEmailChange(pk, { oldEmail: "old@example.com", newEmail: "New@Example.com", bound: true, release: "released" }, 5000);
    ok("released: the record holds the new email, bound as the server said", rec.backupRecord(pk)?.email === "new@example.com" && rec.backupRecord(pk)?.bound === true);
    ok("  ...and the old email is not listed", rec.alsoOpens(pk).length === 0);
    rec.recordEmailChange(pk, { oldEmail: "new@example.com", newEmail: "third@example.com", bound: null, release: "not-yours" }, 6000);
    ok("not-yours: the old email stays listed as one that may also open this account", JSON.stringify(rec.alsoOpens(pk)) === JSON.stringify(["new@example.com"]));
    ok("  ...and the new email's binding never inherits the old one's", rec.backupRecord(pk)?.bound === null && rec.backupRecord(pk)?.email === "third@example.com");
  }
}

