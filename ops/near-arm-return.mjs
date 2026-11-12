#!/usr/bin/env node
// Arms the Lumenia escrow's return timer for links (`arm_return`), signed by an account whose key is in the
// near-cli legacy keychain (~/.near-credentials/<network>/<signer>.json). Prints the transaction id; never a key.
//
//   node ops/near-arm-return.mjs --network mainnet --signer <account> --tgas <n> <public_key> [more keys...]
//
// From the moment this transaction is included, nobody has to act again: NEAR wakes the escrow every 200
// blocks and, at the first wake-up after the expiry, the links still open go back to their funder in one
// transfer. Anyone may arm a link; the money can only ever go to its funder. The transaction is sent and
// waited on only until INCLUDED_FINAL: one whose timer is pending does not reach FINAL until the timer ends.
// near-api-js comes from the monorepo's own install (apps/sponsor), so run `pnpm install` once first.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const network = opt("--network") ?? "testnet";
const signerId = opt("--signer");
const tgas = Number(opt("--tgas") ?? "300");
const keys = args;
const CONTRACT = { testnet: "lumenia-near.testnet", mainnet: "lumenia.near" }[network];
const RPC = { testnet: process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com", mainnet: process.env.RPC_MAINNET || "https://rpc.mainnet.fastnear.com" }[network];
const EXPLORER = { testnet: "https://testnet.nearblocks.io/txns/", mainnet: "https://nearblocks.io/txns/" }[network];
if (!CONTRACT || !signerId || !Number.isInteger(tgas) || tgas < 45 || tgas > 1000 || keys.length < 1 || keys.length > 30 || !keys.every((k) => /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(k))) {
  console.error("usage: node ops/near-arm-return.mjs --network testnet|mainnet --signer <account> --tgas <45..1000> <ed25519:public_key> [up to 30]");
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(join(root, "apps/sponsor/package.json"));
const { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas, baseEncode } = req("near-api-js");
const secret = JSON.parse(readFileSync(join(homedir(), ".near-credentials", network, `${signerId}.json`), "utf8")).private_key;
const provider = new JsonRpcProvider({ url: RPC });
const signer = KeyPairSigner.fromSecretKey(secret);
const account = new Account(signerId, provider, signer);
const tx = await account.createTransaction({
  receiverId: CONTRACT,
  actions: [actions.functionCall("arm_return", { public_keys: keys }, teraToGas(tgas), 0n)],
  publicKey: await signer.getPublicKey(),
});
const { txHash, signedTransaction } = await signer.signTransaction(tx);
const hash = baseEncode(txHash);
console.log(`armed by ${signerId}: ${keys.length} link(s), ${tgas} Tgas, tx ${hash} (${EXPLORER}${hash})`);
await provider.sendTransactionUntil(signedTransaction, "INCLUDED_FINAL");
console.log("included; from here nobody has to sign anything");
