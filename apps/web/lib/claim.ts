/**
 * Collect money waiting for the LOCAL account — the returning asker's half of
 * request money (REQUEST_MONEY.md §10 / §5.1). A paid request arrives as a
 * Claimable Balance whose unconditional claimant is this account's ADDRESS; the
 * account signs a bare claimClaimableBalance and the sponsor fee-bumps it through
 * the UNCHANGED /feebump claim policy (maxOps 1) — the same live endpoint the
 * bearer-link claim uses. Proven on testnet by Spike #6.
 *
 * Not to be confused with the claim-LINK flow (lib/sponsor.ts::runClaim), which
 * onboards a brand-new bearer account first. Here the account already exists.
 */
import { BASE_FEE, Horizon, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import type { Signer } from "./signer";
import { activeNetwork } from "./network";

export async function collectIncoming(opts: {
  sponsorUrl: string;
  signer: Signer;
  balanceId: string;
}): Promise<{ hash: string }> {
  const { horizonUrl: HORIZON_URL, passphrase: NETWORK } = activeNetwork();
  const server = new Horizon.Server(HORIZON_URL);
  const me = opts.signer.publicKey();
  const acc = await server.loadAccount(me);
  const inner = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.claimClaimableBalance({ balanceId: opts.balanceId }))
    .setTimeout(180)
    .build();
  await opts.signer.sign(inner);

  const res = await fetch(`${opts.sponsorUrl.replace(/\/$/, "")}/feebump`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ xdr: inner.toXDR(), recipientPublicKey: me, balanceId: opts.balanceId }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`/feebump → ${res.status}: ${text}`);
  return { hash: (JSON.parse(text) as { hash: string }).hash };
}
