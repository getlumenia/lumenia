/**
 * /faucet — test-USDC dispenser (testnet only). Owner directive + FRONTEND_PLAN §3:
 * the faucet is NOT the sponsor key — a SEPARATE distribution account, endpoint and
 * rate limit (two keys, two blast radii). The sponsor key never sources value ops;
 * the faucet only ever pays a fixed test-USDC amount to an account that ALREADY has
 * a USDC trustline (created via /create-account first — owner caveat C4 ordering).
 * A faucet drain is bounded by its own pre-minted USDC balance; it can never touch
 * the sponsor's reserve or the issuer.
 */
import {
  BASE_FEE,
  Operation,
  StrKey,
  TransactionBuilder,
  type Horizon,
} from "@stellar/stellar-sdk";
import type { SponsorConfig } from "./config.js";
import type { SponsorSigner } from "./signer.js";
import { submit } from "./stellar.js";

export interface FaucetInput {
  recipientPublicKey: string;
}

export interface FaucetResult {
  hash: string;
  ledger: number;
  amount: string;
}

/** Fixed test-USDC dispense amount. */
export const FAUCET_AMOUNT = "20";

export async function faucetHandler(
  server: Horizon.Server,
  config: SponsorConfig,
  faucet: SponsorSigner,
  input: FaucetInput,
): Promise<FaucetResult> {
  if (!StrKey.isValidEd25519PublicKey(input.recipientPublicKey)) {
    throw new Error(`invalid recipientPublicKey: ${input.recipientPublicKey}`);
  }
  // The recipient must already hold the USDC trustline (create-account runs first).
  const recipient = await server.loadAccount(input.recipientPublicKey);
  const hasTrustline = recipient.balances.some(
    (b) =>
      "asset_code" in b &&
      b.asset_code === config.usdc.getCode() &&
      "asset_issuer" in b &&
      b.asset_issuer === config.usdc.getIssuer(),
  );
  if (!hasTrustline) throw new Error("recipient has no USDC trustline (create the account first)");

  const faucetAccount = await server.loadAccount(faucet.publicKey());
  const tx = new TransactionBuilder(faucetAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.payment({ destination: input.recipientPublicKey, asset: config.usdc, amount: FAUCET_AMOUNT }),
    )
    .setTimeout(180)
    .build();
  await faucet.sign(tx);
  const { hash, ledger } = await submit(server, tx);
  return { hash, ledger, amount: FAUCET_AMOUNT };
}
