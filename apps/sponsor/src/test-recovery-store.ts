/**
 * ============================================================================
 *  TEST — recovery store namespaces (the OTP-bypass guard)
 * ============================================================================
 *
 *  "Find my money with Face ID" adds a fetch route that is NOT gated by an emailed code. That is
 *  safe only because the id it reads is 256 bits derived from a passkey, and it is stored in a
 *  DIFFERENT namespace from the email-keyed boxes.
 *
 *  The danger this file exists to catch: the server cannot tell the two ids apart. Both are 64
 *  lowercase hex and both satisfy ID_RE. If the alias route could ever read the email namespace,
 *  anyone who knows a victim's email address could compute SHA-256 of it and fetch their backup
 *  with no code at all. The first two checks below ARE that guarantee, in both directions.
 *
 *  The other half is WHO MAY WRITE. An emailed code proves control of an inbox, and the email id is
 *  SHA-256 of that address — so a code alone would let whoever reads the mail paint over somebody's
 *  only backup. Both namespaces bind a replacement to a key, and the last two sections pin that.
 *
 *  ONE EMAIL, ONE ACCOUNT (the shared account contract, sections 1 and 2). An unbound row is never
 *  taken over without an explicit, signed `replace`; a row bound to another account answers a 409
 *  that carries what it holds; the account can ask whether an email backs it up and let an email go.
 *  The last part drives all of it through the Worker's own front door (worker.fetch), on the
 *  in-memory store, with the codes read from the local log line.
 *
 *  RUN: pnpm --filter @lumenia/sponsor test:recovery-store   (no network, no keys)
 * ============================================================================
 */
import { Keypair } from "@stellar/stellar-sdk";
import {
  putBox,
  getBox,
  putAliasBox,
  getAliasBox,
  validateBox,
  BackupConflict,
  EMAIL_TAKEN_ERROR,
  OWNER_REQUIRED_ERROR,
  rowState,
  isBoundTo,
  checkMine,
  releaseBox,
  mintRecoveryTicket,
  consumeRecoveryTicket,
  RECOVERY_TICKET_TTL_SEC,
} from "./lib/recovery-store.js";
import { handleProofMessage, proofNonce } from "./lib/handles.js";
import { isPublicRefusal } from "./lib/caps.js";
import {
  idForEmail,
  codeEmailLines,
  requestOtp,
  verifyOtp,
  verifyOtpDetailed,
  OTP_BUDGET_ERROR,
  OtpCheckUnavailable,
} from "./lib/recovery-otp.js";
import worker from "./worker.js";

/* Isolation first: this file must never reach a real store or a real mailer, whatever the shell
   that runs it exports. Every store below is the in-memory fallback. */
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "RESEND_API_KEY"]) {
  delete process.env[k];
}

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✔" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  cond ? passed++ : failed++;
}
async function rejects(name: string, fn: () => Promise<unknown>, expect?: string) {
  try {
    await fn();
    ok(name, false, "did NOT reject");
  } catch (e) {
    const msg = (e as Error).message;
    ok(name, expect ? msg.toLowerCase().includes(expect.toLowerCase()) : true, msg.slice(0, 70));
  }
}

const hex = (c: string) => c.repeat(64);
const EMAIL_ID = hex("a");
const ALIAS_ID = hex("b");
const PROOF = hex("9"); // stands in for HKDF(prf, "…alias-proof-v1")
const OTHER_PROOF = hex("8");
const BOX = {
  formatVersion: 1,
  copies: [
    { kind: "prf", iv: "AAAA", ct: "BBBB", hkdfSalt: "CCCC" },
    { kind: "password", iv: "AAAA", ct: "BBBB", salt: "CCCC", argon: { memMiB: 48, time: 2, parallelism: 1 } },
  ],
};
/** A second, distinguishable box — what a re-backup writes, and what an attacker would write. */
const OTHER_BOX = {
  formatVersion: 1,
  copies: [{ kind: "prf", iv: "DDDD", ct: "EEEE", hkdfSalt: "FFFF" }],
};

const alice = Keypair.random();
const mallory = Keypair.random();

/** The account's own authorization to write box `id` — signed exactly as the client signs it. */
function ownerProof(
  kp: Keypair,
  id: string,
  ts = Math.floor(Date.now() / 1000),
  network: "testnet" | "mainnet" = "testnet",
) {
  const nonce = proofNonce();
  const message = handleProofMessage("links", id, kp.publicKey(), ts, nonce, network);
  return { pubkey: kp.publicKey(), ts, nonce, proof: kp.sign(Buffer.from(message, "utf8")).toString("base64") };
}

/** Reject, AND with text the caller may read — see the PublicRefusal section at the end. */
async function rejectsPublicly(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    ok(name, false, "did NOT reject");
  } catch (e) {
    ok(name, isPublicRefusal(e), (e as Error).message.slice(0, 60));
  }
}

/** A `links` proof over any name: "check:<id>" for /recovery-check, "release:<id>" for /recovery-release. */
function linksProof(kp: Keypair, name: string, ts = Math.floor(Date.now() / 1000)) {
  const nonce = proofNonce();
  const message = handleProofMessage("links", name, kp.publicKey(), ts, nonce, "testnet");
  return { pubkey: kp.publicKey(), ts, nonce, proof: kp.sign(Buffer.from(message, "utf8")).toString("base64") };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Refused with a BackupConflict of this kind, carrying exactly the stored box. */
async function conflicts(name: string, fn: () => Promise<unknown>, want: { unbound: boolean; box: unknown }) {
  try {
    await fn();
    ok(name, false, "did NOT refuse");
  } catch (e) {
    const c = e as BackupConflict;
    ok(
      name,
      e instanceof BackupConflict && c.unbound === want.unbound && same(c.box, want.box) && c.message === EMAIL_TAKEN_ERROR,
      e instanceof BackupConflict ? `unbound ${c.unbound}` : (e as Error).message.slice(0, 60),
    );
  }
}

async function main(): Promise<void> {
  console.log("============================================================");
  console.log(" TEST — recovery store namespaces");
  console.log("============================================================\n");

  /* ---- THE INVARIANT. Everything else in this file is secondary. ---- */
  await putBox(EMAIL_ID, BOX);
  ok(
    "an EMAIL-keyed box is NOT readable through the alias route (no OTP bypass)",
    (await getAliasBox(EMAIL_ID)) === null,
  );

  await putAliasBox(ALIAS_ID, BOX, PROOF);
  ok(
    "an ALIAS box is NOT readable through the email route (namespaces are separate)",
    (await getBox(ALIAS_ID)) === null,
  );

  ok("the email box round-trips in its own namespace", JSON.stringify(await getBox(EMAIL_ID)) === JSON.stringify(BOX));
  ok("the alias box round-trips in its own namespace", JSON.stringify(await getAliasBox(ALIAS_ID)) === JSON.stringify(BOX));
  ok("a missing alias id returns null, not an error", (await getAliasBox(hex("c"))) === null);

  /* ---- The alias path reuses the SAME validation, not a looser copy of it ---- */
  await rejects("alias put rejects a non-hex id", () => putAliasBox("not-a-hex-id", BOX, PROOF), "64-char hex");
  await rejects("alias put rejects a short id", () => putAliasBox("abc", BOX, PROOF), "64-char hex");
  await rejects("alias fetch rejects a non-hex id", () => getAliasBox("../../etc/passwd"), "64-char hex");
  await rejects(
    "alias put rejects a box carrying an extra field (the ciphertext-only guarantee)",
    () => putAliasBox(hex("d"), { ...BOX, seed: "oops" }, PROOF),
    "unexpected fields",
  );
  await rejects(
    "alias put rejects a copy with a plaintext-looking extra key",
    () => putAliasBox(hex("e"), { formatVersion: 1, copies: [{ kind: "prf", iv: "A", ct: "B", hkdfSalt: "C", password: "hunter2" }] }, PROOF),
    "invalid shape",
  );
  await rejects(
    "alias put rejects a weak Argon2id floor (a box that would be cheap to crack offline)",
    () => putAliasBox(hex("f"), { formatVersion: 1, copies: [{ kind: "password", iv: "A", ct: "B", salt: "C", argon: { memMiB: 1, time: 1, parallelism: 1 } }] }, PROOF),
    "invalid shape",
  );

  /* ---- ALIAS OWNERSHIP: an OTP proves control of an EMAIL, never of an alias id ---- */
  await rejects(
    "a DIFFERENT passkey cannot overwrite an existing alias box (the write-IDOR fix)",
    () => putAliasBox(ALIAS_ID, BOX, OTHER_PROOF),
    "different passkey",
  );
  ok(
    "the rejected overwrite left the original box intact",
    JSON.stringify(await getAliasBox(ALIAS_ID)) === JSON.stringify(BOX),
  );
  ok(
    "the SAME passkey may still update its own alias box (re-backup keeps working)",
    await putAliasBox(ALIAS_ID, BOX, PROOF).then(
      () => true,
      () => false,
    ),
  );
  await rejects("alias put requires a proof at all", () => putAliasBox(hex("1"), BOX, undefined), "aliasProof");
  await rejects("alias put rejects a malformed proof", () => putAliasBox(hex("2"), BOX, "nope"), "aliasProof");

  /* ---- EMAIL BOX OWNERSHIP: a code proves control of an INBOX, never of the account ---- */
  const BOUND_ID = hex("3");
  const LEGACY_ID = hex("4");

  const unsignedFirst = await putBox(LEGACY_ID, BOX).catch(() => null);
  ok("an unsigned first write is stored, unbound: a new user has no account to prove yet", unsignedFirst?.bound === false);
  // It used to stay replaceable by anyone with a code, which is how a second account backed up under
  // the same email silently painted over the first account's only copy.
  await conflicts(
    "an unbound row is NOT replaced by another unsigned write: a 409 carrying what it holds",
    () => putBox(LEGACY_ID, OTHER_BOX),
    { unbound: true, box: BOX },
  );
  await conflicts(
    "nor by an unsigned write that asks to replace it (replace needs a signature)",
    () => putBox(LEGACY_ID, OTHER_BOX, undefined, { replace: true }),
    { unbound: true, box: BOX },
  );
  ok("and the unbound row is unchanged", same(await getBox(LEGACY_ID), BOX));
  await rejects(
    "a first write whose signature does not verify is refused, not treated as unsigned",
    () => putBox(hex("5"), BOX, { ...ownerProof(alice, hex("5")), proof: ownerProof(mallory, hex("5")).proof }),
    "does not match",
  );
  ok("and nothing was stored under it", (await getBox(hex("5"))) === null);

  ok(
    "a first box may bind itself to the account that made it (bound: true)",
    (await putBox(BOUND_ID, BOX, ownerProof(alice, BOUND_ID)).catch(() => null))?.bound === true,
  );
  await rejects(
    "a verified code alone cannot then overwrite it (a stolen inbox is not the account)",
    () => putBox(BOUND_ID, OTHER_BOX),
    "signature",
  );
  await conflicts(
    "nor can another account's signature: a 409 carrying the stored box, unbound false",
    () => putBox(BOUND_ID, OTHER_BOX, ownerProof(mallory, BOUND_ID)),
    { unbound: false, box: BOX },
  );
  await conflicts(
    "and `replace` never overrides a bound row",
    () => putBox(BOUND_ID, OTHER_BOX, ownerProof(mallory, BOUND_ID), { replace: true }),
    { unbound: false, box: BOX },
  );
  await rejects(
    "nor the owner's own signature over a different box id",
    () => putBox(BOUND_ID, OTHER_BOX, ownerProof(alice, LEGACY_ID)),
    "does not match",
  );
  await rejects(
    "nor a signature old enough to have been scraped from somewhere",
    () => putBox(BOUND_ID, OTHER_BOX, ownerProof(alice, BOUND_ID, Math.floor(Date.now() / 1000) - 4000)),
    "expired",
  );
  ok("the refused overwrites left the original box intact", JSON.stringify(await getBox(BOUND_ID)) === JSON.stringify(BOX));
  ok(
    "the account itself may still re-back-up (same key: ok, bound true)",
    (await putBox(BOUND_ID, OTHER_BOX, ownerProof(alice, BOUND_ID)).catch(() => null))?.bound === true,
  );
  ok("and that write took effect", JSON.stringify(await getBox(BOUND_ID)) === JSON.stringify(OTHER_BOX));

  /* ---- An UNBOUND row: never adopted by the first proof it meets ----
     The row LEGACY_ID was written unsigned (a backup from before the binding, or from a client that
     could not sign). A signed write from another account is the forked-identity case: refused, with
     what the row holds, so the client can offer to open it or ask for another email. */
  await conflicts(
    "an unbound row + another key's signed write: BackupConflict{unbound:true}, nothing written",
    () => putBox(LEGACY_ID, OTHER_BOX, ownerProof(mallory, LEGACY_ID)),
    { unbound: true, box: BOX },
  );
  ok("getBox still answers the row's own box", same(await getBox(LEGACY_ID), BOX));
  ok("and the row is still unbound", (await rowState(LEGACY_ID)).ownerHash === undefined);
  const replaced = await putBox(LEGACY_ID, OTHER_BOX, ownerProof(mallory, LEGACY_ID), { replace: true }).catch(() => null);
  ok("the same signed write with replace:true replaces it and binds it", replaced?.bound === true && same(await getBox(LEGACY_ID), OTHER_BOX));
  ok("bound to the signer now", (await isBoundTo(LEGACY_ID, mallory.publicKey())) && !(await isBoundTo(LEGACY_ID, alice.publicKey())));
  await conflicts(
    "after which the first account is refused like any other: unbound false",
    () => putBox(LEGACY_ID, BOX, ownerProof(alice, LEGACY_ID), { replace: true }),
    { unbound: false, box: OTHER_BOX },
  );

  /* ---- RECOVERY_REQUIRE_OWNER=1: the switch for once every live client signs ---- */
  process.env.RECOVERY_REQUIRE_OWNER = "1";
  try {
    await putBox(hex("7"), BOX);
    ok("with RECOVERY_REQUIRE_OWNER=1 an unsigned first write is refused", false, "did NOT reject");
  } catch (e) {
    ok(
      "with RECOVERY_REQUIRE_OWNER=1 an unsigned first write is refused, publicly, with code owner-required",
      isPublicRefusal(e) && (e as { code?: string }).code === "owner-required" && (e as Error).message === OWNER_REQUIRED_ERROR,
      (e as Error).message.slice(0, 60),
    );
  }
  ok("and nothing was stored", (await getBox(hex("7"))) === null);
  ok("a signed first write still goes through", (await putBox(hex("7"), BOX, ownerProof(alice, hex("7"))).catch(() => null))?.bound === true);
  delete process.env.RECOVERY_REQUIRE_OWNER;

  /* ---- The proof is pinned to the chain THIS deployment answers for ----
     The web client posts every recovery call at one host whatever network the device is spending
     on, so it signs for the HOST's chain rather than the device's. Signing for the other one has to
     fail here, or that client bug would look like a refusal aimed at the user. */
  await rejects(
    "a proof signed for the other chain does not verify (network is not the caller's to choose)",
    () => putBox(hex("6"), BOX, ownerProof(alice, hex("6"), Math.floor(Date.now() / 1000), "mainnet")),
    "does not match",
  );
  ok("and nothing was stored under it", (await getBox(hex("6"))) === null);

  /* ---- Refusals a person has to be able to READ ----
     On a mainnet-configured host the Worker collapses every error that is not a PublicRefusal to
     "request failed", which is not something anybody can act on. These three are the only refusals
     this store aims at a user, so all three keep their text. */
  await rejectsPublicly("the 'needs a signature' refusal survives mainnet error-hiding", () =>
    putBox(BOUND_ID, OTHER_BOX),
  );
  await rejectsPublicly("so does the 'different account' refusal", () =>
    putBox(BOUND_ID, OTHER_BOX, ownerProof(mallory, BOUND_ID)),
  );
  await rejectsPublicly("so does the alias 'different passkey' refusal", () =>
    putAliasBox(ALIAS_ID, BOX, OTHER_PROOF),
  );

  /* ---- validateBox is genuinely SHARED, not re-implemented per namespace ---- */
  ok("validateBox accepts the good box", (() => {
    try {
      validateBox(BOX);
      return true;
    } catch {
      return false;
    }
  })());

  await registryChecks();
  await goldenVectors();
  await otpChecks();
  await routeChecks();

  console.log(`\n${failed === 0 ? "✅" : "❌"} RECOVERY STORE TESTS ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

/* ---- What the other registries may ask, and what the account may ask about itself ---- */
async function registryChecks(): Promise<void> {
  console.log("\n[registry] rowState, isBoundTo, checkMine, releaseBox");
  const MINE = hex("c");
  const UNBOUND = hex("d");
  const NONE = hex("e");
  await putBox(MINE, BOX, ownerProof(alice, MINE));
  await putBox(UNBOUND, BOX);

  const st = await rowState(MINE);
  ok("rowState names the bound row's owner hash", st.exists === true && typeof st.ownerHash === "string" && st.ownerHash.length === 64);
  ok("an unbound row exists with no owner", same(await rowState(UNBOUND), { exists: true }));
  ok("and no row is just that", same(await rowState(NONE), { exists: false }));
  ok("isBoundTo: true only for the row's own account", (await isBoundTo(MINE, alice.publicKey())) && !(await isBoundTo(MINE, mallory.publicKey())));
  ok("isBoundTo: false for an unbound row and for no row", !(await isBoundTo(UNBOUND, alice.publicKey())) && !(await isBoundTo(NONE, alice.publicKey())));

  const mine = await checkMine(MINE, linksProof(alice, `check:${MINE}`));
  ok("checkMine: the bound account hears mine:true", mine.ok === true && mine.ok && mine.mine === true);
  const other = await checkMine(MINE, linksProof(mallory, `check:${MINE}`));
  ok("another key hears mine:false (nothing about whose it is)", other.ok === true && other.mine === false);
  const unbound = await checkMine(UNBOUND, linksProof(alice, `check:${UNBOUND}`));
  ok("an unbound row answers mine:false", unbound.ok === true && unbound.mine === false);
  const none = await checkMine(NONE, linksProof(alice, `check:${NONE}`));
  ok("no row answers mine:false, the same as the others", none.ok === true && none.mine === false);
  ok("a WRITE proof (over the bare id) is not a check proof", (await checkMine(MINE, ownerProof(alice, MINE))).ok === false);
  const replay = linksProof(alice, `check:${MINE}`);
  await checkMine(MINE, replay);
  ok("a check proof works once (the replay guard)", (await checkMine(MINE, replay)).ok === false);
  ok(
    "a forged check proof is refused",
    (await checkMine(MINE, { ...linksProof(alice, `check:${MINE}`), proof: linksProof(mallory, `check:${MINE}`).proof })).ok === false,
  );

  // Release: the account lets go of its backup email, so it can back up another account.
  ok("release by another key releases nothing", same(await releaseBox(MINE, linksProof(mallory, `release:${MINE}`)), { ok: true, released: false }));
  ok("and the row is intact", same(await getBox(MINE), BOX));
  ok("an unbound row is not released", same(await releaseBox(UNBOUND, linksProof(alice, `release:${UNBOUND}`)), { ok: true, released: false }));
  ok("no row is not released", same(await releaseBox(NONE, linksProof(alice, `release:${NONE}`)), { ok: true, released: false }));
  ok("a CHECK proof is not a release proof", (await releaseBox(MINE, linksProof(alice, `check:${MINE}`))).ok === false);
  ok("the bound key releases it", same(await releaseBox(MINE, linksProof(alice, `release:${MINE}`)), { ok: true, released: true }));
  ok("the row is gone", (await getBox(MINE)) === null && same(await rowState(MINE), { exists: false }));
  ok(
    "and another account can now bind that email",
    (await putBox(MINE, OTHER_BOX, ownerProof(mallory, MINE)).catch(() => null))?.bound === true && (await isBoundTo(MINE, mallory.publicKey())),
  );

  console.log("\n[tickets] single use, ten minutes, one id");
  const t1 = await mintRecoveryTicket(UNBOUND);
  ok("a ticket is 64 lowercase hex", /^[0-9a-f]{64}$/.test(t1), t1.slice(0, 12));
  ok("it is spent once, for its own id", (await consumeRecoveryTicket(t1, UNBOUND)) === true);
  ok("and never twice", (await consumeRecoveryTicket(t1, UNBOUND)) === false);
  const t2 = await mintRecoveryTicket(UNBOUND);
  ok("it does not work for another id", (await consumeRecoveryTicket(t2, NONE)) === false);
  ok("and presenting it for another id spent it", (await consumeRecoveryTicket(t2, UNBOUND)) === false);
  const t3 = await mintRecoveryTicket(UNBOUND);
  const realNow = Date.now;
  Date.now = () => realNow() + (RECOVERY_TICKET_TTL_SEC + 1) * 1000;
  try {
    ok(`it does not work after ${RECOVERY_TICKET_TTL_SEC} s`, (await consumeRecoveryTicket(t3, UNBOUND)) === false);
  } finally {
    Date.now = realNow;
  }
  ok("a malformed ticket is refused", (await consumeRecoveryTicket("not-a-ticket", UNBOUND)) === false);

  // The production path: Upstash. SET with the id as the body and EX=600, spent by one GETDEL.
  const kvStore = new Map<string, { value: string; ex?: number }>();
  const realFetch = globalThis.fetch;
  process.env.KV_REST_API_URL = "https://kv.test";
  process.env.KV_REST_API_TOKEN = "t";
  globalThis.fetch = (async (url: string | URL, init?: { body?: string }) => {
    const u = new URL(String(url));
    const reply = (result: unknown) => ({ ok: true, status: 200, json: async () => result }) as unknown as Response;
    if (u.pathname.startsWith("/set/")) {
      const ex = u.searchParams.get("EX");
      kvStore.set(decodeURIComponent(u.pathname.slice("/set/".length)), { value: String(init?.body ?? ""), ...(ex ? { ex: Number(ex) } : {}) });
      return reply({ result: "OK" });
    }
    const cmds = JSON.parse(String(init?.body ?? "[]")) as string[][];
    return reply(
      cmds.map(([op, key]) => {
        if (op !== "GETDEL") throw new Error(`unexpected ${op}`);
        const hit = kvStore.get(key!);
        kvStore.delete(key!);
        return { result: hit?.value ?? null };
      }),
    );
  }) as typeof fetch;
  try {
    const k1 = await mintRecoveryTicket(UNBOUND);
    const row = kvStore.get(`lumenia:recovery-ticket:${k1}`);
    ok("in the store a ticket is lumenia:recovery-ticket:<ticket> = <id>, EX 600", row?.value === UNBOUND && row?.ex === RECOVERY_TICKET_TTL_SEC, JSON.stringify(row));
    ok("presented for another id it is refused, and spent", (await consumeRecoveryTicket(k1, NONE)) === false && !kvStore.has(`lumenia:recovery-ticket:${k1}`));
    const k2 = await mintRecoveryTicket(UNBOUND);
    ok("for its own id it is accepted once", (await consumeRecoveryTicket(k2, UNBOUND)) === true);
    ok("and only once", (await consumeRecoveryTicket(k2, UNBOUND)) === false);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
}

/* ---- The shared contract's golden vectors (section 1): the web and the extension pin the same ----
   Because ts is in the past, these are checked with Keypair.verify, not through the 300 s window. */
async function goldenVectors(): Promise<void> {
  console.log("\n[golden] the account contract's write, check and release proofs");
  const ONES = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
  const G = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
  const EMAIL_ID = "fb72704240c3527ba45904a8705865922f70a9c4f3c11bfa93c839f939945884";
  ok("the TEST-ONLY seed of 32 x 0x01 is the contract's account", ONES.publicKey() === G);
  ok("emailId trims and lowercases before hashing", (await idForEmail("  Founder@Example.com ")) === EMAIL_ID);
  const vectors: Array<[string, string, string, string]> = [
    [
      "write",
      EMAIL_ID,
      "lumenia-handle-links:v1:fb72704240c3527ba45904a8705865922f70a9c4f3c11bfa93c839f939945884:GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR:1760000000:0123456789abcdef:testnet",
      "h6zhlw5Gx5zDuK/kiRYEUAlrd8rRSz/V0AZhIeYBCtHwPGgVCdSoVGHmxP4DkJtFuDRfnSOSXZfymsBqkj07BA==",
    ],
    [
      "check",
      `check:${EMAIL_ID}`,
      "lumenia-handle-links:v1:check:fb72704240c3527ba45904a8705865922f70a9c4f3c11bfa93c839f939945884:GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR:1760000000:0123456789abcdef:testnet",
      "i5ORTu/1MEH2aIDhPQL8BrOWZfZk4Yiy8xMv/vkDU9WT+MC4sDrtiMBtUbu4QX2p/csnvdVoedEHYmQvvO2cDw==",
    ],
    [
      "release",
      `release:${EMAIL_ID}`,
      "lumenia-handle-links:v1:release:fb72704240c3527ba45904a8705865922f70a9c4f3c11bfa93c839f939945884:GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR:1760000000:0123456789abcdef:testnet",
      "SNdv504x5awpCGipDXOjfycaapxHt/xjxLZVukaKgwf/CORI1XwOgXItkWVKbMc0n40oXc010BYdDRZ1FK5BDQ==",
    ],
  ];
  for (const [label, name, message, sig] of vectors) {
    const built = handleProofMessage("links", name, G, 1760000000, "0123456789abcdef", "testnet");
    ok(`the ${label} message is the golden string`, built === message, built.slice(0, 48));
    ok(
      `and the golden ${label} signature verifies over it (and is what this seed signs)`,
      ONES.verify(Buffer.from(message, "utf8"), Buffer.from(sig, "base64")) &&
        ONES.sign(Buffer.from(message, "utf8")).toString("base64") === sig,
    );
  }
}

/** Run `fn` with console.log captured; the lines come back instead of being printed. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = real;
  }
}

const CODE_LINE = /\[recovery:otp\] \(local, no RESEND_API_KEY\) code for .*: (\d{6})$/;
const NOT_LOOKING = "It expires in 10 minutes. If you didn't ask for this, someone may be trying to open your Lumenia backup. It stays locked by your password.";

/* ---- The code mail, and the budgets a person is now told about ---- */
async function otpChecks(): Promise<void> {
  console.log("\n[codes] the mail's words, and an unreadable budget");
  ok("a backup code's mail says what a code nobody asked for means", codeEmailLines("recovery").expiry === NOT_LOOKING);
  ok("a real-money code's mail opens with its own line", codeEmailLines("pilot").first === "Your code to ask for real money:");

  const realFetch = globalThis.fetch;
  const sent: Array<{ subject?: string; text?: string; html?: string }> = [];
  process.env.RESEND_API_KEY = "re_test";
  globalThis.fetch = (async (url: string | URL, init?: { body?: string }) => {
    if (String(url).startsWith("https://api.resend.com/")) sent.push(JSON.parse(String(init?.body ?? "{}")));
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;
  try {
    await requestOtp("mailtext@example.test");
    await requestOtp("mailtext-pilot@example.test", "pilot");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  }
  const [backup, pilot] = sent;
  ok("the sent backup mail carries the new sentence, in the text and the HTML", !!backup?.text?.includes(NOT_LOOKING) && !!backup?.html?.includes(NOT_LOOKING), backup?.text?.slice(0, 60));
  ok("its subject is 'Your Lumenia code: NNNNNN'", /^Your Lumenia code: \d{6}$/.test(backup?.subject ?? ""), backup?.subject);
  ok(
    "the purpose 'pilot' mail keeps that subject and opens with 'Your code to ask for real money:'",
    /^Your Lumenia code: \d{6}$/.test(pilot?.subject ?? "") && !!pilot?.text?.startsWith("Your code to ask for real money: "),
    pilot?.text?.slice(0, 60),
  );
  ok("ASCII only in both mails' visible text", sent.every((m) => !/[^\x00-\x7F]/.test(`${m.subject}${m.text}`)));

  // A budget that cannot be read fails CLOSED, and says so instead of "wrong code" or "wait an hour".
  process.env.KV_REST_API_URL = "https://kv.invalid";
  process.env.KV_REST_API_TOKEN = "t";
  globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as typeof fetch;
  try {
    const id = await idForEmail("outage@example.test");
    const outage = await verifyOtpDetailed(id, "123456").then(
      (v) => `resolved ${v}`,
      (e: unknown) => (e instanceof OtpCheckUnavailable && isPublicRefusal(e) ? "unavailable" : (e as Error).message),
    );
    ok("an unreadable verify budget is 'could not check', not a spent budget", outage === "unavailable", outage);
    ok("and the boolean verifyOtp the identity routes use stays a plain false", (await verifyOtp(id, "123456")) === false);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
}

/* ============================================================================
 * THROUGH THE FRONT DOOR: worker.fetch on the in-memory store. The codes are read from the local
 * log line (RECOVERY_ALLOW_MEMORY_STORE=1, no mailer), exactly as a developer reads them.
 * ========================================================================== */
const ENV = {
  STELLAR_NETWORK: "testnet",
  SPONSOR_SECRET: Keypair.random().secret(),
  USDC_ISSUER: Keypair.random().publicKey(),
  RECOVERY_ALLOW_MEMORY_STORE: "1",
  // The route checks below make far more requests than a person would; the limits are not under test.
  RATE_CAP: "1000",
  ACCOUNT_RATE_CAP: "1000",
};

async function call(path: string, body: unknown, ip?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await worker.fetch(
    new Request(`https://sponsor.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(ip ? { "cf-connecting-ip": ip } : {}) },
      body: JSON.stringify(body),
    }),
    ENV,
  );
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text.slice(0, 120) };
  }
  return { status: res.status, json };
}

/** Ask /recovery-otp for a code and read it off the local log line. */
async function codeFor(email: string): Promise<string> {
  const { result, lines } = await captureLogs(() => call("/recovery-otp", { email }));
  const hit = lines.map((l) => CODE_LINE.exec(l)).find((m) => m !== null);
  if (result.status !== 200 || !hit) throw new Error(`no code for ${email}: ${result.status} ${JSON.stringify(result.json)}`);
  return hit[1]!;
}

const OLD_CLIENT_REFUSED = /already holds a backup for a different account/i; // extension 0.1.2/0.1.3, lib/backup.ts
const HEX64 = /^[0-9a-f]{64}$/;

async function routeChecks(): Promise<void> {
  const bob = Keypair.random();
  const carol = Keypair.random();

  console.log("\n[route] /recovery over an UNBOUND row: 409 with its box and a ticket");
  const uEmail = "unbound-route@example.test";
  const uId = await idForEmail(uEmail);
  const first = await call("/recovery", { id: uId, box: BOX, code: await codeFor(uEmail) });
  ok("an unsigned first write answers 200 {ok, bound:false}", first.status === 200 && same(first.json, { ok: true, bound: false }), JSON.stringify(first.json));
  const taken = await call("/recovery", { id: uId, box: OTHER_BOX, code: await codeFor(uEmail), owner: ownerProof(bob, uId) });
  ok("another account's signed write is a 409", taken.status === 409, String(taken.status));
  ok("with code email-taken and unbound true", taken.json.code === "email-taken" && taken.json.unbound === true);
  ok("its box deep-equals the stored box", same(taken.json.box, BOX), JSON.stringify(taken.json.box).slice(0, 60));
  ok("and it carries a ticket, 64 hex", typeof taken.json.ticket === "string" && HEX64.test(taken.json.ticket));
  ok("the error is the contract's sentence", taken.json.error === EMAIL_TAKEN_ERROR);
  ok("which the 0.1.2/0.1.3 extension's refusal pattern already matches", OLD_CLIENT_REFUSED.test(String(taken.json.error)));
  ok("nothing was written", same(await getBox(uId), BOX) && (await rowState(uId)).ownerHash === undefined);
  const fetched = await call("/recovery-fetch", { id: uId, code: await codeFor(uEmail) });
  ok("the 409's box is exactly what /recovery-fetch gives for the same email", fetched.status === 200 && same(fetched.json.box, taken.json.box));
  ok("/recovery-fetch of an unbound row says bound:false, with a ticket", fetched.json.bound === false && typeof fetched.json.ticket === "string" && HEX64.test(fetched.json.ticket as string));

  const ticket = String(taken.json.ticket);
  const both = await call("/recovery", { id: uId, box: OTHER_BOX, code: "123456", ticket, owner: ownerProof(bob, uId), replace: true });
  ok("a code AND a ticket is refused (exactly one of them)", both.status === 401 && both.json.error === "invalid or expired code");
  const neither = await call("/recovery", { id: uId, box: OTHER_BOX, owner: ownerProof(bob, uId), replace: true });
  ok("neither is refused too", neither.status === 401);
  const bind = await call("/recovery", { id: uId, box: OTHER_BOX, ticket, owner: ownerProof(bob, uId), replace: true });
  ok("ticket + a signed replace binds the row: 200 {ok, bound:true}", bind.status === 200 && same(bind.json, { ok: true, bound: true }), JSON.stringify(bind.json));
  ok("the row holds the new box and is bound to the signer", same(await getBox(uId), OTHER_BOX) && (await isBoundTo(uId, bob.publicKey())));
  const again = await call("/recovery", { id: uId, box: BOX, ticket, owner: ownerProof(bob, uId), replace: true });
  ok("the ticket works once: a second use is 401", again.status === 401 && again.json.error === "invalid or expired code");

  // A ticket never renews itself: a write it let in that the row refuses again (here: no `replace`)
  // is the same 409, with the box, but WITHOUT a fresh ticket. Otherwise one code would buy an endless
  // chain of tickets and keep the row open to a takeover without the inbox ever being asked again.
  const rEmail2 = "unbound-renew@example.test";
  const rId2 = await idForEmail(rEmail2);
  await call("/recovery", { id: rId2, box: BOX, code: await codeFor(rEmail2) });
  const rConflict = await call("/recovery", { id: rId2, box: OTHER_BOX, code: await codeFor(rEmail2), owner: ownerProof(carol, rId2) });
  const rTicket = String(rConflict.json.ticket ?? "");
  const renew = await call("/recovery", { id: rId2, box: OTHER_BOX, ticket: rTicket, owner: ownerProof(carol, rId2) });
  ok("a ticket-let-in write the unbound row refuses is the same 409 with its box", renew.status === 409 && renew.json.unbound === true && same(renew.json.box, BOX), JSON.stringify(renew.json).slice(0, 80));
  ok("but carries no new ticket (a ticket never renews itself)", renew.json.ticket === undefined);
  const renewAgain = await call("/recovery", { id: rId2, box: OTHER_BOX, ticket: rTicket, owner: ownerProof(carol, rId2), replace: true });
  ok("and the ticket it came with is spent (401)", renewAgain.status === 401);
  ok("the row is untouched", same(await getBox(rId2), BOX) && (await rowState(rId2)).ownerHash === undefined);

  // A ticket for one row cannot open another. A second unbound row hands out its own ticket.
  const vEmail = "unbound-other@example.test";
  const vId = await idForEmail(vEmail);
  await call("/recovery", { id: vId, box: BOX, code: await codeFor(vEmail) });
  const vFetch = await call("/recovery-fetch", { id: vId, code: await codeFor(vEmail) });
  const vTicket = String(vFetch.json.ticket ?? "");
  const wrongId = await call("/recovery", { id: uId, box: BOX, ticket: vTicket, owner: ownerProof(bob, uId) });
  ok("a ticket only works for the id it was minted for (another id: 401)", wrongId.status === 401);
  const spent = await call("/recovery", { id: vId, box: OTHER_BOX, ticket: vTicket, owner: ownerProof(carol, vId), replace: true });
  ok("and presenting it for the wrong id spent it", spent.status === 401);
  const late = await call("/recovery-fetch", { id: vId, code: await codeFor(vEmail) });
  const realNow = Date.now;
  Date.now = () => realNow() + (RECOVERY_TICKET_TTL_SEC + 1) * 1000;
  let expired: { status: number };
  try {
    // From an address of its own: the in-memory rate limiter would otherwise carry the jump forward
    // in time into every later request from the default one.
    expired = await call("/recovery", { id: vId, box: OTHER_BOX, ticket: String(late.json.ticket ?? "") }, "203.0.113.250");
  } finally {
    Date.now = realNow;
  }
  ok(`a ticket is refused after ${RECOVERY_TICKET_TTL_SEC} s (401)`, expired.status === 401, String(expired.status));
  ok("and the row it was for is untouched", same(await getBox(vId), BOX));

  console.log("\n[route] /recovery over a BOUND row");
  const bEmail = "bound-route@example.test";
  const bId = await idForEmail(bEmail);
  const bFirst = await call("/recovery", { id: bId, box: BOX, code: await codeFor(bEmail), owner: ownerProof(alice, bId) });
  ok("a signed first write answers 200 {ok, bound:true}", bFirst.status === 200 && same(bFirst.json, { ok: true, bound: true }));
  const bOther = await call("/recovery", { id: bId, box: OTHER_BOX, code: await codeFor(bEmail), owner: ownerProof(bob, bId), replace: true });
  ok("another account, even with replace:true, is a 409 with unbound false", bOther.status === 409 && bOther.json.unbound === false && bOther.json.code === "email-taken");
  ok("carrying the stored box and NO ticket", same(bOther.json.box, BOX) && !("ticket" in bOther.json));
  ok("nothing was written", same(await getBox(bId), BOX) && (await isBoundTo(bId, alice.publicKey())));
  const bUnsigned = await call("/recovery", { id: bId, box: OTHER_BOX, code: await codeFor(bEmail) });
  ok("an unsigned write to a bound row is the unchanged 400", bUnsigned.status === 400 && bUnsigned.json.error === "Replacing this backup needs a signature from the account it belongs to.");
  const bFetch = await call("/recovery-fetch", { id: bId, code: await codeFor(bEmail) });
  ok("/recovery-fetch of a bound row says bound:true and hands out no ticket", bFetch.status === 200 && bFetch.json.bound === true && !("ticket" in bFetch.json));

  console.log("\n[route] the Face ID alias is checked BEFORE the email row is touched");
  const aEmail = "alias-route@example.test";
  const aId = await idForEmail(aEmail);
  const ALIAS2 = hex("f");
  const aFirst = await call("/recovery", { id: aId, box: BOX, code: await codeFor(aEmail), owner: ownerProof(alice, aId), aliasId: ALIAS2, aliasProof: PROOF });
  ok("a backup with its Face ID copy is stored", aFirst.status === 200 && same(await getAliasBox(ALIAS2), BOX));
  const aMismatch = await call("/recovery", {
    id: aId,
    box: OTHER_BOX,
    code: await codeFor(aEmail),
    owner: ownerProof(alice, aId),
    aliasId: ALIAS2,
    aliasProof: OTHER_PROOF,
  });
  ok("a different passkey's alias is refused (400, the contract's sentence)", aMismatch.status === 400 && aMismatch.json.error === "This Face ID backup belongs to a different passkey.");
  ok("and the email row was left exactly as it was", same(await getBox(aId), BOX));
  const nEmail = "alias-new@example.test";
  const nId = await idForEmail(nEmail);
  const nMismatch = await call("/recovery", { id: nId, box: BOX, code: await codeFor(nEmail), aliasId: ALIAS2, aliasProof: OTHER_PROOF });
  ok("a NEW email with a mismatched alias leaves no email row behind", nMismatch.status === 400 && (await getBox(nId)) === null);
  const sameId = await call("/recovery", { id: nId, box: BOX, code: await codeFor(nEmail), aliasId: nId, aliasProof: PROOF });
  ok("aliasId === id is refused", sameId.status === 400 && sameId.json.error === "aliasId must differ from id");

  console.log("\n[route] /recovery-check");
  const mine = await call("/recovery-check", { id: bId, owner: linksProof(alice, `check:${bId}`) });
  ok("200 {mine:true} for the bound account", mine.status === 200 && same(mine.json, { mine: true }), JSON.stringify(mine.json));
  const notMine = await call("/recovery-check", { id: bId, owner: linksProof(bob, `check:${bId}`) });
  ok("200 {mine:false} for another account", notMine.status === 200 && same(notMine.json, { mine: false }));
  const vCheck = await call("/recovery-check", { id: vId, owner: linksProof(alice, `check:${vId}`) });
  ok("200 {mine:false} for an unbound row", vCheck.status === 200 && vCheck.json.mine === false);
  const noRow = await call("/recovery-check", { id: hex("9"), owner: linksProof(alice, `check:${hex("9")}`) });
  ok("200 {mine:false} for no row", noRow.status === 200 && noRow.json.mine === false);
  const noOwner = await call("/recovery-check", { id: bId });
  ok("400 without an owner proof", noOwner.status === 400 && noOwner.json.error === "id and owner are required");
  const badId = await call("/recovery-check", { id: "nope", owner: linksProof(alice, "check:nope") });
  ok("400 for an id that is not 64 hex", badId.status === 400);
  const forged = await call("/recovery-check", { id: bId, owner: { ...linksProof(alice, `check:${bId}`), proof: linksProof(bob, `check:${bId}`).proof } });
  ok(
    "401 with the contract's sentence for a signature that does not verify",
    forged.status === 401 && forged.json.error === "We couldn't confirm this account signed the request. Check your device clock and try again.",
  );

  console.log("\n[route] /recovery-release");
  const relOther = await call("/recovery-release", { id: bId, owner: linksProof(bob, `release:${bId}`) });
  ok(
    "409 not-yours for another account",
    relOther.status === 409 && relOther.json.code === "not-yours" && relOther.json.error === "That email doesn't back up this account.",
  );
  ok("409 not-yours for an unbound row", (await call("/recovery-release", { id: vId, owner: linksProof(alice, `release:${vId}`) })).status === 409);
  ok("409 not-yours for no row", (await call("/recovery-release", { id: hex("9"), owner: linksProof(alice, `release:${hex("9")}`) })).status === 409);
  const relForged = await call("/recovery-release", { id: bId, owner: { ...linksProof(alice, `release:${bId}`), proof: linksProof(bob, `release:${bId}`).proof } });
  ok("401 for a forged release", relForged.status === 401);
  ok("the row survived all of that", same(await getBox(bId), BOX));
  const rel = await call("/recovery-release", { id: bId, owner: linksProof(alice, `release:${bId}`) });
  ok("200 {ok:true} for the bound account", rel.status === 200 && same(rel.json, { ok: true }));
  const gone = await call("/recovery-fetch", { id: bId, code: await codeFor(bEmail) });
  ok("the email no longer opens a backup (404)", gone.status === 404);
  const rebind = await call("/recovery", { id: bId, box: OTHER_BOX, code: await codeFor(bEmail), owner: ownerProof(bob, bId) });
  ok("and a new account can bind it", rebind.status === 200 && rebind.json.bound === true);

  console.log("\n[route] the per-email budgets are SAID, not hidden");
  const capEmail = "request-cap@example.test";
  for (let i = 0; i < 10; i++) await codeFor(capEmail);
  const over = await captureLogs(() => call("/recovery-otp", { email: capEmail }));
  ok(
    "the 11th code request in the hour is a 429 otp-budget",
    over.result.status === 429 && over.result.json.code === "otp-budget" && over.result.json.error === OTP_BUDGET_ERROR,
    JSON.stringify(over.result.json),
  );
  ok("and no code was made or mailed for it", !over.lines.some((l) => CODE_LINE.test(l)));
  const vbEmail = "verify-cap@example.test";
  const vbId = await idForEmail(vbEmail);
  await call("/recovery", { id: vbId, box: BOX, code: await codeFor(vbEmail) });
  const real = await codeFor(vbEmail);
  const wrong = real === "000000" ? "111111" : "000000";
  const wrongOnce = await call("/recovery-fetch", { id: vbId, code: wrong });
  ok("a wrong code is a 401", wrongOnce.status === 401 && wrongOnce.json.error === "invalid or expired code");
  for (let i = 0; i < 11; i++) await call("/recovery-fetch", { id: vbId, code: wrong });
  const fresh = await codeFor(vbEmail);
  const budget = await call("/recovery-fetch", { id: vbId, code: fresh });
  ok(
    "past the verify budget even the RIGHT code is a 429 otp-budget, distinct from a wrong code's 401",
    budget.status === 429 && budget.json.code === "otp-budget" && budget.json.error === OTP_BUDGET_ERROR,
    JSON.stringify(budget.json),
  );
  const budgetWrite = await call("/recovery", { id: vbId, box: OTHER_BOX, code: fresh });
  ok("and /recovery answers the same 429", budgetWrite.status === 429 && budgetWrite.json.code === "otp-budget");

  console.log("\n[route] RECOVERY_REQUIRE_OWNER=1");
  process.env.RECOVERY_REQUIRE_OWNER = "1";
  try {
    const rEmail = "require-owner@example.test";
    const rId = await idForEmail(rEmail);
    const refused = await call("/recovery", { id: rId, box: BOX, code: await codeFor(rEmail) });
    ok(
      "an unsigned first write is a 400 with code owner-required",
      refused.status === 400 && refused.json.code === "owner-required" && refused.json.error === OWNER_REQUIRED_ERROR,
      JSON.stringify(refused.json),
    );
    const signed = await call("/recovery", { id: rId, box: BOX, code: await codeFor(rEmail), owner: ownerProof(carol, rId) });
    ok("a signed one is stored and bound", signed.status === 200 && signed.json.bound === true);
  } finally {
    delete process.env.RECOVERY_REQUIRE_OWNER;
  }
}

void main().catch((e) => {
  console.error("\n💥 recovery store test crashed:", e);
  process.exit(1);
});
