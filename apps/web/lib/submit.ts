/**
 * Submit a transaction to Horizon from the browser, and when Horizon's reply is lost, ask the
 * ledger instead of waiting on the reply.
 *
 * A reply can be lost while the transaction lands. On 2026-10-09 a sponsored-onboarding sandwich
 * (testnet f6530217...ef1070) was in ledger 5100490 three seconds after it was sent; Horizon's
 * answer never reached the page, and the claim screen waited on it ("Almost there") until the
 * person gave up, with the money already safe on the ledger. So the submission races a read of the
 * transaction's own outcome (lib/horizon.ts loadSubmitOutcome, by its hash, its source and its
 * sequence number):
 *   - Horizon answers first: its answer decides, success or refusal, exactly as before;
 *   - the ledger shows the transaction succeeded first: that is the answer, whatever Horizon says
 *     later;
 *   - the submission fails WITHOUT a decided answer (offline, a reset connection, a timeout, a 5xx
 *     such as Horizon's own 504): the ledger is asked until it can say, and only a transaction the
 *     ledger shows failed, or cannot decide on in time, rethrows the original error.
 * Nothing is ever sent twice here. `deps` exists for the self-test (lib/horizon.selftest.ts).
 */
import type { Horizon, Transaction } from "@stellar/stellar-sdk";
import { loadSubmitOutcome, type SubmitOutcome } from "./horizon";
import type { NetworkConfig } from "./network";
import { signedFacts } from "./unconfirmed";

export interface SubmitDeps {
  submit: (tx: Transaction) => Promise<unknown>;
  outcome: () => Promise<SubmitOutcome>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** A transaction is in a ledger about 5 seconds after it is sent; ask first after that. */
export const FIRST_CHECK_MS = 5_000;
export const EVERY_MS = 3_000;
/** Longer than stellar-sdk's own 60-second submission timeout, so Horizon always gets its say. */
export const GIVE_UP_MS = 90_000;

/** Horizon's own HTTP answer below 500 is a decided refusal (400 tx_failed, tx_bad_seq...), never a lost reply. */
function decidedRefusal(e: unknown): boolean {
  try {
    const status = (e as { response?: { status?: unknown } } | null)?.response?.status;
    return typeof status === "number" && status >= 400 && status < 500;
  } catch {
    return false;
  }
}

export async function submitOrConfirm(
  server: Pick<Horizon.Server, "submitTransaction">,
  tx: Transaction,
  net: Pick<NetworkConfig, "horizonUrl">,
  deps: Partial<SubmitDeps> = {},
): Promise<{ hash: string; confirmedBy: "horizon" | "ledger" }> {
  const facts = signedFacts(tx);
  const hash = facts.innerHash;
  const d: SubmitDeps = {
    submit: (t) => server.submitTransaction(t),
    outcome: () =>
      loadSubmitOutcome(
        { hashes: [hash], source: facts.source, sequence: facts.sequence, maxTime: facts.maxTime },
        net,
      ),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    ...deps,
  };

  let decided = false;
  const submitted = d.submit(tx).then(
    () => ({ kind: "answered" as const }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );
  const ledger = (async (): Promise<"landed" | "failed" | "undecided"> => {
    await d.sleep(FIRST_CHECK_MS);
    const end = d.now() + GIVE_UP_MS;
    while (!decided && d.now() < end) {
      const o = await d.outcome().catch(() => "unknown" as const);
      if (o === "landed" || o === "failed") return o;
      await d.sleep(EVERY_MS);
    }
    return "undecided";
  })();

  const first = await Promise.race([submitted, ledger.then((o) => ({ kind: "ledger" as const, o }))]);
  if (first.kind === "answered") {
    decided = true;
    return { hash, confirmedBy: "horizon" };
  }
  if (first.kind === "ledger" && first.o === "landed") {
    decided = true;
    return { hash, confirmedBy: "ledger" };
  }
  if (first.kind === "error") {
    if (decidedRefusal(first.error)) {
      decided = true;
      throw first.error;
    }
    const o = await ledger;
    decided = true;
    if (o === "landed") return { hash, confirmedBy: "ledger" };
    throw first.error;
  }
  // The ledger shows it failed, or could not decide in time: Horizon's own answer decides if it
  // comes within one more interval; a reply that never comes must not hold the screen forever.
  const s = await Promise.race([submitted, d.sleep(EVERY_MS).then(() => ({ kind: "silent" as const }))]);
  decided = true;
  if (s.kind === "error") throw s.error;
  if (s.kind === "answered") return { hash, confirmedBy: "horizon" };
  throw new Error(
    first.o === "failed"
      ? `transaction ${hash} failed on the ledger`
      : `no answer from Horizon or the ledger for transaction ${hash}`,
  );
}
