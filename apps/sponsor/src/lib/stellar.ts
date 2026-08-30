/**
 * Thin Horizon helpers shared by the sponsor endpoints and the CLI.
 */
import { Horizon, xdr } from "@stellar/stellar-sdk";
import type { SponsorConfig } from "./config";

/**
 * The Claimable Balance id created by a transaction, read from ITS OWN result XDR
 * (Horizon's hex id string). This is the unambiguous source — a "newest CB where X
 * is a claimant" Horizon query races against concurrent txs. Handles the fee-bump
 * wrapper (fee-bumped submits put the inner tx's op results one level down) and a
 * plain (unwrapped) result. Returns null on any shape surprise so the caller can
 * fall back rather than fail a tx that already succeeded.
 */
export function createdBalanceIdFromResult(resultXdr: string, opIndex: number): string | null {
  if (opIndex < 0) return null;
  try {
    const top = xdr.TransactionResult.fromXDR(resultXdr, "base64").result();
    const inner = top.switch().name.startsWith("txFeeBumpInner")
      ? top.innerResultPair().result().result()
      : top;
    const op = inner.results()[opIndex];
    if (!op) return null;
    return op.tr().createClaimableBalanceResult().balanceId().toXDR("hex");
  } catch {
    return null;
  }
}

export function horizon(config: SponsorConfig): Horizon.Server {
  return new Horizon.Server(config.horizonUrl);
}

/**
 * A submission whose OUTCOME IS UNKNOWN — which is not the same as one that failed.
 *
 * Horizon answers 504 while the transaction is still queued, and the transaction stays valid
 * until its own timebound expires, so it may be included seconds after we gave up listening.
 * A caller that collapses this into "it failed" tells the user their money never moved, and on
 * the payout leg — a payment to an exchange, with no reclaim and no link to un-send — that
 * sentence invites a SECOND irreversible payment. The hash is the only pointer that survives
 * an answer that never came; it is what an operator or a later read settles this against.
 */
export class SubmitUnconfirmedError extends Error {
  readonly submitUnconfirmed = true;
  constructor(detail: string, readonly hash?: string) {
    super(`submit unconfirmed: ${detail}`);
    this.name = "SubmitUnconfirmedError";
  }
}

/** True for a submission that was never definitively decided. Reads the brand, not the class. */
export function isSubmitUnconfirmed(e: unknown): boolean {
  return (
    e instanceof SubmitUnconfirmedError ||
    (e as { submitUnconfirmed?: boolean } | null | undefined)?.submitUnconfirmed === true
  );
}

/**
 * Did anything actually DECIDE this transaction? Only two answers are definitive: the ledger's
 * own verdict (Horizon's `extras.result_codes`), and a refusal raised here before the envelope
 * was ever posted. Everything else — a gateway timeout, a 5xx, an answer that never arrived —
 * leaves a valid transaction that may still be included.
 *
 * The bias is deliberate and one-directional: a wrong "we could not confirm" costs the user a
 * check and a wait, a wrong "nothing moved" costs them the money twice.
 */
function outcomeUnknown(e: unknown): boolean {
  // Horizon's SEP-29 guard runs client-side, BEFORE the POST — nothing was submitted.
  if ((e as Error | null | undefined)?.name === "AccountRequiresMemoError") return false;
  const res = (e as { response?: { status?: number; data?: { extras?: { result_codes?: unknown } } } })
    ?.response;
  if (res?.data?.extras?.result_codes) return false;
  const status = res?.status;
  return typeof status !== "number" || status === 408 || status >= 500;
}

/** Submit a tx, surfacing Horizon's `extras` (the useful part) on failure. */
export async function submit(
  server: Horizon.Server,
  tx: Parameters<Horizon.Server["submitTransaction"]>[0],
): Promise<{ hash: string; ledger: number; resultXdr?: string }> {
  try {
    const res = await server.submitTransaction(tx);
    // result_xdr names exactly what THIS tx did (e.g. the created CB id) — callers
    // that need an id must read it from here, not from a "newest matching entry"
    // Horizon query, which races against concurrent txs.
    return { hash: res.hash, ledger: res.ledger, resultXdr: (res as { result_xdr?: string }).result_xdr };
  } catch (e: unknown) {
    const extras = (e as { response?: { data?: { extras?: unknown } } })?.response?.data?.extras;
    const detail = extras ? JSON.stringify(extras) : (e as Error).message;
    if (outcomeUnknown(e)) {
      let hash: string | undefined;
      try {
        hash = tx.hash().toString("hex");
      } catch {
        /* an envelope we cannot hash is one we cannot name; the error still has to be raised */
      }
      throw new SubmitUnconfirmedError(detail, hash);
    }
    throw new Error(`submit failed: ${detail}`);
  }
}

export async function nativeBalance(server: Horizon.Server, pub: string): Promise<string> {
  const acc = await server.loadAccount(pub);
  return acc.balances.find((b) => b.asset_type === "native")?.balance ?? "0";
}

export async function trustlineBalance(
  server: Horizon.Server,
  pub: string,
  code: string,
  issuer: string,
): Promise<string> {
  const acc = await server.loadAccount(pub);
  const line = acc.balances.find(
    (b) => "asset_code" in b && b.asset_code === code && "asset_issuer" in b && b.asset_issuer === issuer,
  );
  return line ? line.balance : "NO_TRUSTLINE";
}

export async function friendbot(pub: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot failed for ${pub}: ${res.status}`);
}
