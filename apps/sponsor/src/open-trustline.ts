/**
 * Open the mainnet USDC trustline on the demo sender account.
 *
 * A Stellar account cannot receive a non-native asset until it has declared a trustline for it —
 * without this, a USDC payment to the account fails with op_no_trust. Costs 0.5 XLM in reserve
 * (returned if the trustline is ever closed) plus a negligible fee.
 */
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

const HZ = new Horizon.Server("https://horizon.stellar.org");
const USDC = new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");

async function main() {
  const secret = process.env.SENDER_SECRET;
  if (!secret) throw new Error("set SENDER_SECRET");
  const kp = Keypair.fromSecret(secret);
  const acc = await HZ.loadAccount(kp.publicKey());
  if (acc.balances.some((b: any) => b.asset_code === "USDC" && b.asset_issuer === USDC.getIssuer())) {
    console.log("trustline already open");
    return;
  }
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: Networks.PUBLIC })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  const res = await HZ.submitTransaction(tx);
  console.log("trustline opened — tx", res.hash);
}

main().catch((e) => {
  console.error("💥", e?.response?.data?.extras?.result_codes ?? e?.message ?? e);
  process.exit(1);
});
