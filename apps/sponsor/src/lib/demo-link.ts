/**
 * /demo-link — mints a REAL testnet claim link on demand so any visitor (or an SCF
 * reviewer) experiences the hero moment alone in ~30 seconds (FRONTEND_PLAN §1b).
 * The faucet account (which holds XLM + test-USDC) creates a small dual-predicate
 * Claimable Balance and returns the bearer secret so the client can build the /c/…
 * link. SEPARATE from the sponsor key + the user faucet path; aggressively
 * rate-limited by the caller. Testnet only.
 */
import { BASE_FEE, Claimant, Keypair, Operation, TransactionBuilder, type Horizon } from "@stellar/stellar-sdk";
import type { SponsorConfig } from "./config.js";
import type { SponsorSigner } from "./signer.js";
import { submit, createdBalanceIdFromResult } from "./stellar.js";

export interface DemoLinkResult {
  balanceId: string;
  bearerSecret: string;
  amount: string;
  issuer: string;
  from: string;
}

const DEMO_AMOUNT = "5";
const DEMO_FROM = "Lumenia";
const DEMO_RECLAIM_SECONDS = "3600"; // the faucet can reclaim an unclaimed demo link after 1 hour

export async function demoLinkHandler(
  server: Horizon.Server,
  config: SponsorConfig,
  faucet: SponsorSigner,
): Promise<DemoLinkResult> {
  const bearer = Keypair.random();
  const acc = await server.loadAccount(faucet.publicKey());
  const claimants = [
    new Claimant(bearer.publicKey(), Claimant.predicateUnconditional()),
    new Claimant(faucet.publicKey(), Claimant.predicateNot(Claimant.predicateBeforeRelativeTime(DEMO_RECLAIM_SECONDS))),
  ];
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: config.networkPassphrase })
    .addOperation(Operation.createClaimableBalance({ asset: config.usdc, amount: DEMO_AMOUNT, claimants }))
    .setTimeout(180)
    .build();
  await faucet.sign(tx);
  const { resultXdr } = await submit(server, tx);

  // Read the created CB id from THIS tx's result (the createClaimableBalance is op 0),
  // not a "newest CB where the bearer is a claimant" query. The bearer is a fresh
  // unique key here so the query wouldn't actually collide, but the result-XDR path
  // is the unambiguous one the send flow uses — no reason to keep the racy pattern.
  let balanceId = resultXdr ? createdBalanceIdFromResult(resultXdr, 0) : null;
  if (!balanceId) {
    const cb = await server.claimableBalances().claimant(bearer.publicKey()).order("desc").limit(1).call();
    balanceId = cb.records[0]?.id ?? null;
  }
  if (!balanceId) throw new Error("demo link submitted but the Claimable Balance id was not found");

  return {
    balanceId,
    bearerSecret: bearer.secret(),
    amount: DEMO_AMOUNT,
    issuer: config.usdc.getIssuer()!,
    from: DEMO_FROM,
  };
}
