/**
 * ============================================================================
 *  SPIKE #1b — External raw Ed25519 signer → valid Stellar signature (testnet)
 * ============================================================================
 *
 *  GOAL (Tyler + Elliot's #1 architecture risk, R3): Spike #1 signed with a
 *  local in-memory Keypair (`tx.sign`). The REAL risk is whether the sponsor
 *  key can live behind an HSM/KMS that returns a RAW 64-byte Ed25519 signature,
 *  and whether we can turn that into a valid Stellar `DecoratedSignature` the
 *  network accepts.
 *
 *  Research (June 2026): AWS KMS supports Ed25519 raw signing since 2025-11-07
 *  (ECC_NIST_EDWARDS25519 / ED25519_SHA_512 / MessageType=RAW) and returns a
 *  raw 64-byte signature. Hint = last 4 bytes of the signer's public key.
 *
 *  This spike SIMULATES the external signer with Node's `crypto` (pure Ed25519
 *  over the tx hash, exactly what KMS does) WITHOUT using stellar-sdk's signing,
 *  builds the DecoratedSignature by hand, and submits to testnet.
 *
 *  What is proven:
 *    1. A raw 64-byte Ed25519 signature produced OUTSIDE stellar-sdk is accepted
 *       by the Stellar network when wrapped as a DecoratedSignature (hint = last4(pubkey)).
 *    2. The hand-built DecoratedSignature is byte-identical to kp.signDecorated()
 *       (Ed25519 is deterministic) → the KMS path is a drop-in for tx.sign().
 *
 *  RUN:   pnpm --filter @lumenia/sponsor exec tsx src/spike1b-kms-rawsign.ts
 *  NEEDS: Node 20+, internet (Horizon testnet + friendbot). No mainnet/real money.
 * ============================================================================
 */

import crypto from "node:crypto";
import {
  Account,
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const NETWORK = Networks.TESTNET;
const server = new Horizon.Server(HORIZON_URL);

// PKCS#8 DER prefix for an Ed25519 private key (RFC 8410) — lets us load a raw
// 32-byte seed into Node crypto as an Ed25519 KeyObject.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * The "KMS" — an external signer that ONLY knows how to return a raw 64-byte
 * Ed25519 signature over a message. It deliberately does NOT use @stellar/stellar-sdk,
 * to prove the path is signer-agnostic. Swap this body for an `aws-kms.sign(...)`
 * call (ED25519_SHA_512, MessageType=RAW) and nothing else changes.
 */
function externalRawSign(seed32: Buffer, message: Buffer): Buffer {
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed32]);
  const key = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  // For Ed25519, the algorithm argument MUST be null (pure EdDSA over the message).
  return crypto.sign(null, message, key); // 64 bytes, raw — exactly KMS's output
}

async function friendbot(pub: string) {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot fail: ${res.status}`);
}

function attachExternalSignature(tx: Transaction, signerPubRaw: Buffer, rawSig: Buffer): xdr.DecoratedSignature {
  const hint = signerPubRaw.subarray(-4); // last 4 bytes of the 32-byte public key
  const decorated = new xdr.DecoratedSignature({ hint, signature: rawSig });
  tx.signatures.push(decorated);
  return decorated;
}

async function main() {
  console.log("============================================================");
  console.log(" SPIKE #1b — external raw Ed25519 → Stellar DecoratedSignature");
  console.log("============================================================");

  // The "sponsor" key. In prod the seed lives in KMS and never leaves it; here
  // we hold the seed only to feed our Node-crypto stand-in for KMS.
  const sponsor = Keypair.random();
  const seed32 = sponsor.rawSecretKey(); // 32-byte Ed25519 seed (KMS holds this)
  const pubRaw = sponsor.rawPublicKey(); // 32-byte Ed25519 public key

  console.log(`\n[1] fund signer via friendbot: ${sponsor.publicKey()}`);
  await friendbot(sponsor.publicKey());

  console.log("[2] build a real testnet tx (manageData), do NOT use tx.sign()");
  const acc = await server.loadAccount(sponsor.publicKey());
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.manageData({ name: "lumenia:spike1b", value: "kms-raw-sign" }))
    .setTimeout(180)
    .build();

  const payload = tx.hash(); // 32-byte signing payload (what KMS would sign, RAW)
  console.log(`    tx hash (signing payload): ${payload.toString("hex")}`);

  console.log("[3] sign with the EXTERNAL signer (Node crypto, pure Ed25519 — KMS stand-in)");
  const rawSig = externalRawSign(seed32, payload);
  console.log(`    raw signature: ${rawSig.length} bytes (KMS returns exactly this)`);

  console.log("[4] local correctness checks BEFORE submitting");
  // 4a. signature verifies against the public key
  const verifies = Keypair.fromPublicKey(sponsor.publicKey()).verify(payload, rawSig);
  console.log(`    ✔ signature verifies against pubkey: ${verifies}`);
  // 4b. hand-built DecoratedSignature == kp.signDecorated() (Ed25519 determinism)
  const manualHint = pubRaw.subarray(-4);
  const manualDecorated = new xdr.DecoratedSignature({ hint: manualHint, signature: rawSig });
  const sdkDecorated = sponsor.signDecorated(payload);
  const sameBytes = Buffer.compare(manualDecorated.toXDR(), sdkDecorated.toXDR()) === 0;
  console.log(`    ✔ manual DecoratedSignature === kp.signDecorated(): ${sameBytes}`);

  console.log("[5] attach the EXTERNAL signature + submit to testnet");
  attachExternalSignature(tx, pubRaw, rawSig);
  const res = await server.submitTransaction(tx);
  console.log(`    ✔ network ACCEPTED externally-signed tx → ${res.hash}`);

  const pass = verifies && sameBytes && res.successful;
  console.log("\n============================================================");
  console.log(pass ? " ✅ SPIKE #1b PASS" : " ❌ SPIKE #1b FAIL");
  console.log("============================================================");
  console.log(` • raw Ed25519 sig verifies              : ${verifies}`);
  console.log(` • hand-built == sdk DecoratedSignature  : ${sameBytes}`);
  console.log(` • network accepted external signature   : ${res.successful}`);
  console.log("\n KMS path proven: an external raw-Ed25519 signer (HSM/KMS stand-in)");
  console.log(" produces a Stellar signature the network accepts. tx.sign() → KMS is a drop-in.");
  if (!pass) process.exit(1);
}

main().catch((e) => {
  const extras = (e as { response?: { data?: { extras?: unknown } } })?.response?.data?.extras;
  console.error("\n💥 SPIKE #1b crashed:", extras ? JSON.stringify(extras, null, 2) : e);
  process.exit(1);
});
