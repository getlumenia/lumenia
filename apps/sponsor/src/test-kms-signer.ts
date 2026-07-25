/**
 * KMS SIGNER TESTS — KmsSponsorSigner against a LOCAL raw-Ed25519 stand-in (no network,
 * no AWS). Mirrors Spike #1b: the fake KMS signs with a stellar-sdk Keypair, so we can
 * assert BYTE-PARITY between the KMS-path DecoratedSignature and `kp.signDecorated()`
 * (Ed25519 is deterministic — identical bytes = the KMS path is a drop-in for tx.sign()).
 *
 * Also pins the exact KMS request contract (MessageType=RAW + ED25519_SHA_512 + the tx hash
 * as the message) and the fail-closed behavior. RUN: pnpm --filter @lumenia/sponsor test:kms
 */
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { KmsSponsorSigner, type KmsFetch } from "./lib/kms-signer.js";

let pass = 0,
  fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✔" : "✗"} ${n}${d ? `  (${d})` : ""}`);
  ok ? pass++ : fail++;
};

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** A fake KMS backed by a stellar Keypair; records every Sign request body it sees. */
function fakeKms(kp: Keypair, log: Array<Record<string, unknown>>): KmsFetch {
  return async (target, body) => {
    if (target === "TrentService.GetPublicKey") {
      return { PublicKey: Buffer.concat([ED25519_SPKI_PREFIX, kp.rawPublicKey()]).toString("base64") };
    }
    log.push(body);
    const msg = Buffer.from(String(body.Message), "base64");
    return { Signature: kp.sign(msg).toString("base64") };
  };
}

function sampleTx(sourcePub: string) {
  // A fully offline tx: local Account (no Horizon), one payment, testnet passphrase.
  const source = new Account(sourcePub, "0");
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.payment({
        destination: "GDASCEEDNNHMJPYPTWXG65NFDSJKSEUIWSEV7EKRIEL67F4XN3HMSSKI",
        asset: Asset.native(),
        amount: "1",
      }),
    )
    .setTimeout(60)
    .build();
}

async function main() {
  console.log("============================================================");
  console.log(" KMS SIGNER TESTS (offline; Spike #1b mechanics)");
  console.log("============================================================\n");

  const kp = Keypair.random();
  const signLog: Array<Record<string, unknown>> = [];
  const signer = await KmsSponsorSigner.create({
    keyId: "arn:aws:kms:test:000000000000:key/fake",
    region: "eu-central-1",
    accessKeyId: "x",
    secretAccessKey: "x",
    kmsFetch: fakeKms(kp, signLog),
  });

  console.log("[1] identity — GetPublicKey DER → Stellar address");
  check("publicKey() derives the G... address from the DER SPKI tail", signer.publicKey() === kp.publicKey());

  console.log("[2] signing a normal tx");
  const tx = sampleTx(kp.publicKey());
  await signer.sign(tx);
  check("exactly one signature attached", tx.signatures.length === 1);
  const sig = tx.signatures[0]!;
  check("hint = LAST 4 bytes of the raw public key", sig.hint().equals(kp.rawPublicKey().subarray(28)));
  check("the network math verifies the signature over the tx hash", kp.verify(tx.hash(), sig.signature()));
  check(
    "BYTE-PARITY with stellar-sdk signDecorated (drop-in proof)",
    sig.toXDR().equals(kp.signDecorated(tx.hash()).toXDR()),
  );
  check("envelope XDR round-trips with the KMS signature", (() => {
    const xdr64 = tx.toEnvelope().toXDR("base64");
    return TransactionBuilder.fromXDR(xdr64, Networks.TESTNET).toEnvelope().toXDR("base64") === xdr64;
  })());

  console.log("[3] the KMS request contract (what the wire must carry)");
  const req = signLog[0]!;
  check("MessageType = RAW (pure Ed25519, not the PH/prehash variant)", req.MessageType === "RAW");
  check("SigningAlgorithm = ED25519_SHA_512", req.SigningAlgorithm === "ED25519_SHA_512");
  check("Message = base64(tx hash), 32 bytes", Buffer.from(String(req.Message), "base64").equals(tx.hash()));

  console.log("[4] fee-bump signing (the sponsor's main move)");
  const inner = sampleTx(kp.publicKey());
  inner.sign(Keypair.random()); // an unrelated inner signature; the fee-bump wraps it
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(kp.publicKey(), "1000", inner, Networks.TESTNET);
  await signer.sign(feeBump);
  check(
    "fee-bump signature verifies over the OUTER hash",
    kp.verify(feeBump.hash(), feeBump.signatures[0]!.signature()),
  );

  console.log("[5] fail-closed behavior");
  const broken = await KmsSponsorSigner.create({
    keyId: "k", region: "r", accessKeyId: "x", secretAccessKey: "x",
    kmsFetch: async (target) =>
      target === "TrentService.GetPublicKey"
        ? { PublicKey: Buffer.concat([ED25519_SPKI_PREFIX, kp.rawPublicKey()]).toString("base64") }
        : Promise.reject(new Error("KMS unreachable")),
  });
  check("a KMS Sign failure THROWS (no silent fallback)", await broken.sign(sampleTx(kp.publicKey())).then(() => false, () => true));

  const badLen = await KmsSponsorSigner.create({
    keyId: "k", region: "r", accessKeyId: "x", secretAccessKey: "x",
    kmsFetch: async (target) =>
      target === "TrentService.GetPublicKey"
        ? { PublicKey: Buffer.concat([ED25519_SPKI_PREFIX, kp.rawPublicKey()]).toString("base64") }
        : { Signature: Buffer.alloc(63).toString("base64") },
  });
  check("a non-64-byte signature is rejected", await badLen.sign(sampleTx(kp.publicKey())).then(() => false, () => true));

  check("a non-Ed25519 KMS key is rejected at create()", await KmsSponsorSigner.create({
    keyId: "k", region: "r", accessKeyId: "x", secretAccessKey: "x",
    kmsFetch: async () => ({ PublicKey: Buffer.alloc(91).toString("base64") }), // RSA-sized SPKI
  }).then(() => false, () => true));

  console.log("\n============================================================");
  console.log(fail === 0 ? ` ✅ KMS SIGNER TESTS PASS (${pass}/${pass})` : ` ❌ ${fail} FAILURES (${pass} passed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("💥", e);
  process.exit(1);
});
