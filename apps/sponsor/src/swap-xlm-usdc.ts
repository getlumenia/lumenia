/**
 * Swap XLM → USDC inside an account we hold the key for, using Stellar's built-in DEX.
 *
 * Why this exists: a wallet's own swap UI can refuse to send USDC to a brand-new address (its
 * risk scanner has no history to judge). Sending plain XLM is unaffected, so the account funds
 * itself in XLM and converts on-chain instead.
 *
 * `pathPaymentStrictSend` with a `destMin` floor: the exact XLM is spent and the transaction
 * FAILS rather than settling below the floor, so a thin order book cannot quietly eat the funds.
 *
 * RUN: SENDER_SECRET=S… pnpm --filter @lumenia/sponsor exec tsx src/swap-xlm-usdc.ts <xlm> [slippagePct]
 */
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

const HZ = new Horizon.Server("https://horizon.stellar.org");
const USDC = new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");

async function main() {
  const secret = process.env.SENDER_SECRET;
  if (!secret) throw new Error("set SENDER_SECRET");
  const kp = Keypair.fromSecret(secret);
  const sendAmount = process.argv[2];
  if (!sendAmount) throw new Error("usage: swap-xlm-usdc <xlm amount> [slippagePct]");
  const slippage = Number.parseFloat(process.argv[3] ?? "1.5");

  // Quote first, then set a floor under it. Never submit a swap without a floor.
  const paths = await HZ.strictSendPaths(Asset.native(), sendAmount, [USDC]).call();
  const best = paths.records.sort(
    (a, b) => Number.parseFloat(b.destination_amount) - Number.parseFloat(a.destination_amount),
  )[0];
  if (!best) throw new Error("no XLM→USDC path found");
  const quoted = Number.parseFloat(best.destination_amount);
  const destMin = (quoted * (1 - slippage / 100)).toFixed(7);
  console.log(`  quote: ${sendAmount} XLM → ${quoted.toFixed(7)} USDC`);
  console.log(`  floor: ${destMin} USDC (${slippage}% slippage; below this the tx fails, it does not settle)`);

  const acc = await HZ.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: Networks.PUBLIC })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount,
        destination: kp.publicKey(), // to ourselves — this is a conversion, not a transfer
        destAsset: USDC,
        destMin,
        path: best.path.map((p: any) =>
          p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code, p.asset_issuer),
        ),
      }),
    )
    .setTimeout(60)
    .build();
  tx.sign(kp);

  const res = await HZ.submitTransaction(tx);
  console.log(`  swapped — tx ${res.hash}`);

  const after = await HZ.loadAccount(kp.publicKey());
  for (const b of after.balances as any[]) {
    console.log(`  ${b.asset_code ?? "XLM"}: ${b.balance}`);
  }
}

main().catch((e) => {
  console.error("💥", e?.response?.data?.extras?.result_codes ?? e?.message ?? e);
  process.exit(1);
});
