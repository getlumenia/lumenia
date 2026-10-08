/**
 * kms-check: the first real-AWS verification of the KMS signer, run by the owner BEFORE any
 * SetOptions (ops/RUNBOOK_SPONSOR_KEY.md section 2).
 *
 * With the four variables in the shell it asks KMS for the public key, derives the G... address
 * (the one `add-signer --signer` then takes), signs ONE offline sample transaction (testnet
 * passphrase, a dummy sequence, never submitted) and verifies that signature locally with the
 * stellar-sdk. A PASS means the live KMS Ed25519 output is byte-compatible with what the network
 * verifies, which until this tool existed had only been proven against a local stand-in
 * (test-kms-signer.ts). Nothing here reaches Horizon or an RPC, and nothing prints a credential.
 *
 * RUN, with every value read into the shell rather than typed on the command line (a command line
 * lands in the shell history and on any recorded screen; the AWS pair can sign with the key):
 *   read -r KMS_KEY_ID && export KMS_KEY_ID
 *   read -rs AWS_ACCESS_KEY_ID && export AWS_ACCESS_KEY_ID
 *   read -rs AWS_SECRET_ACCESS_KEY && export AWS_SECRET_ACCESS_KEY
 *   KMS_REGION=eu-central-1 pnpm --filter @lumenia/sponsor kms-check
 *   unset KMS_KEY_ID AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
 * A KMS error prints only the HTTP status and the AWS error type; the response body (which names
 * the IAM principal) goes to stderr through the signer's own log line.
 */
import { Account, Asset, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { kmsSignerFromEnv } from "../lib/kms-signer.js";

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(
      [
        "kms-check: GetPublicKey + one offline Sign through AWS KMS, verified locally. Needs KMS_KEY_ID, KMS_REGION (or AWS_REGION), AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.",
        "Export the AWS pair with `read -rs AWS_SECRET_ACCESS_KEY && export AWS_SECRET_ACCESS_KEY` (the same for the key id), never on the command line, and unset them afterwards.",
      ].join("\n"),
    );
    return;
  }
  const missing = ["KMS_KEY_ID", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"].filter((k) => !process.env[k]);
  if (!process.env.KMS_REGION && !process.env.AWS_REGION) missing.push("KMS_REGION");
  if (missing.length > 0) {
    console.error(`kms-check: missing ${missing.join(", ")}`);
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  const signer = await kmsSignerFromEnv();
  if (!signer) {
    console.error("kms-check: KMS_KEY_ID is not set");
    process.exit(1);
  }
  const { keyId, region, publicKey } = signer.describe();
  console.log(`key     ${keyId}`);
  console.log(`region  ${region}`);
  console.log(`address ${publicKey}   <- this is the --signer for add-signer`);

  // One offline transaction: a dummy source with sequence 0, never submitted anywhere.
  const tx = new TransactionBuilder(new Account(publicKey, "0"), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: publicKey, asset: Asset.native(), amount: "1" }))
    .setTimeout(60)
    .build();
  await signer.sign(tx);
  const sig = tx.signatures[0];
  const verifier = Keypair.fromPublicKey(publicKey);
  const hintOk = !!sig && sig.hint().equals(verifier.rawPublicKey().subarray(28));
  const sigOk = !!sig && verifier.verify(tx.hash(), sig.signature());

  console.log(`hint    ${hintOk ? "ok (last 4 bytes of the raw public key)" : "WRONG"}`);
  console.log(`verify  ${sigOk ? "ok (the KMS signature verifies under the derived address)" : "FAILED"}`);
  console.log(`cloudtrail: one GetPublicKey and one Sign event for this key, since ${startedAt}`);
  if (!hintOk || !sigOk) {
    console.error("kms-check: FAIL. Do not add this key as a signer; the live KMS output does not verify.");
    process.exit(1);
  }
  console.log("kms-check: PASS");
}

main().catch((e) => {
  console.error(`kms-check: ${(e as Error).message}`);
  process.exit(1);
});
