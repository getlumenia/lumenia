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

/**
 * Fixed test-USDC dispense amount.
 *
 * Dropped from 20 to 0.5 on 2026-09-06, when testnet moved onto Circle's testnet USDC. This
 * project used to issue its own practice asset and could mint as much as it liked; Circle's
 * faucet gives 20 USDC per address every two hours, so the supply is now finite and shared.
 * At 0.5 a single top-up onboards forty people instead of one, which is what a room full of
 * strangers actually needs. Nobody trying the flow is counting the dollars.
 */
/* Raised to 1.0 on 2026-09-10 (owner decision): the sandbox anchor refuses any cash-out under
 * 1 USDC, so a half-dollar left a first-time practice user one faucet tap short of trying the
 * bank rail. One tap, one dollar, one cash-out. */
export const FAUCET_AMOUNT = "1";

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
