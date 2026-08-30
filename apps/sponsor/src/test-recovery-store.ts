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
 *  RUN: pnpm --filter @lumenia/sponsor test:recovery-store   (no network, no keys)
 * ============================================================================
 */
import { Keypair } from "@stellar/stellar-sdk";
import { putBox, getBox, putAliasBox, getAliasBox, validateBox } from "./lib/recovery-store.js";
import { handleProofMessage, proofNonce } from "./lib/handles.js";
import { isPublicRefusal } from "./lib/caps.js";

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

  ok(
    "a first box needs no signature — a new user has no account to prove yet",
    await putBox(LEGACY_ID, BOX).then(() => true, () => false),
  );
  ok(
    "a box written without one stays replaceable (rows that predate the binding)",
    await putBox(LEGACY_ID, OTHER_BOX).then(() => true, () => false),
  );
  await rejects(
    "a first write whose signature does not verify is refused, not treated as unsigned",
    () => putBox(hex("5"), BOX, { ...ownerProof(alice, hex("5")), proof: ownerProof(mallory, hex("5")).proof }),
    "does not match",
  );
  ok("and nothing was stored under it", (await getBox(hex("5"))) === null);

  ok(
    "a first box may bind itself to the account that made it",
    await putBox(BOUND_ID, BOX, ownerProof(alice, BOUND_ID)).then(() => true, () => false),
  );
  await rejects(
    "a verified code alone cannot then overwrite it (a stolen inbox is not the account)",
    () => putBox(BOUND_ID, OTHER_BOX),
    "signature",
  );
  await rejects(
    "nor can another account's signature",
    () => putBox(BOUND_ID, OTHER_BOX, ownerProof(mallory, BOUND_ID)),
    "different account",
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
    "the account itself may still re-back-up",
    await putBox(BOUND_ID, OTHER_BOX, ownerProof(alice, BOUND_ID)).then(() => true, () => false),
  );
  ok("and that write took effect", JSON.stringify(await getBox(BOUND_ID)) === JSON.stringify(OTHER_BOX));

  await putBox(LEGACY_ID, BOX, ownerProof(alice, LEGACY_ID));
  await rejects(
    "an unbound row adopts the first proof it is given, and is bound from then on",
    () => putBox(LEGACY_ID, OTHER_BOX, ownerProof(mallory, LEGACY_ID)),
    "different account",
  );

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

  console.log(`\n${failed === 0 ? "✅" : "❌"} RECOVERY STORE TESTS ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

void main().catch((e) => {
  console.error("\n💥 recovery store test crashed:", e);
  process.exit(1);
});
