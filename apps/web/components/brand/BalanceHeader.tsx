/**
 * BalanceHeader — the north-star surface's headline number: the money you hold,
 * huge and tabular, with an indicative ₺ line and an HONEST custody label
 * (Phase 1 = "Not locked. Anyone with this phone can spend this"; Phase 2 =
 * "Locked with your password"). Real balance only (no-mock-data).
 */
import { AmountDisplay } from "./AmountDisplay";
import { formatTry } from "../../lib/money";
import type { BalanceHeadline } from "../../lib/balance-headline";

/**
 * Three states, decided by lib/balance-headline.ts, and only one of them shows a number: the one
 * where the ledger gave it. "Reading" and "could not read" are said in words, never as $0.00, so a
 * failed Horizon read can no longer tell someone they have nothing.
 */
export function BalanceHeader({
  headline,
  rate,
  phase,
  onRetry,
}: {
  headline: BalanceHeadline;
  /** USD to TRY rate for the indicative lira line (lib/rate.ts) */
  rate: number;
  phase: 1 | 2;
  /** Runs the read again; offered with the unreadable and stale states. */
  onRetry?: () => void;
}) {
  return (
    <section className="flex flex-col items-center gap-1 py-6 text-center">
      <p className="text-sm text-ink-soft">Your money</p>
      {headline.kind === "amount" ? (
        <Amount usd={headline.usd} rate={rate} stale={headline.stale} onRetry={onRetry} />
      ) : headline.kind === "loading" ? (
        <p className="py-3 text-lg font-semibold text-ink-soft" aria-busy="true">
          Reading your balance
        </p>
      ) : (
        <div className="flex flex-col items-center gap-2 py-2">
          <p className="text-lg font-semibold text-ink">We couldn&apos;t read your balance just now</p>
          <p className="max-w-xs text-sm text-ink-soft">
            That&apos;s about the connection, not your money. Nothing about it has changed.
          </p>
          {onRetry && <RetryButton onClick={onRetry} />}
        </div>
      )}
      {phase === 1 ? (
        <p className="mt-2 rounded-full bg-secondary px-3 py-1 text-xs text-ink-soft">
          Not locked. Anyone with this phone can spend this
        </p>
      ) : (
        <p className="mt-2 rounded-full bg-money/10 px-3 py-1 text-xs text-money">
          Locked with your password
        </p>
      )}
    </section>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 items-center rounded-full border border-line px-4 text-sm font-medium text-ink"
    >
      Try again
    </button>
  );
}

/** The figure the ledger gave, with its indicative lira line. */
function Amount({
  usd,
  rate,
  stale,
  onRetry,
}: {
  usd: string;
  rate: number;
  /** A later re-read failed; this is the last figure that landed. */
  stale: boolean;
  onRetry?: () => void;
}) {
  const tryValue = Number.parseFloat(usd) * rate;
  return (
    <>
      <AmountDisplay value={usd} size="xl" tone="ink" countUp />
      <p className="text-sm text-ink-soft">
        ≈ {formatTry(tryValue)} <span className="opacity-70">indicative</span>
      </p>
      {stale && (
        <p className="mt-1 flex flex-wrap items-center justify-center gap-2 text-sm text-ink-soft">
          <span>We couldn&apos;t refresh this just now. This is the last figure we read.</span>
          {onRetry && <RetryButton onClick={onRetry} />}
        </p>
      )}
    </>
  );
}
