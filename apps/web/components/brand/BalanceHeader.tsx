/**
 * BalanceHeader — the north-star surface's headline number: the money you hold,
 * huge and tabular, with an indicative ₺ line and an HONEST custody label
 * (Phase 1 = "Not locked. Anyone with this phone can spend this"; Phase 2 =
 * "Locked with your password"). Real balance only (no-mock-data).
 */
import { AmountDisplay } from "./AmountDisplay";
import { formatTry } from "../../lib/money";

export function BalanceHeader({
  usd,
  tryValue,
  phase,
}: {
  usd: string;
  /** indicative ₺ number (already computed) */
  tryValue: number;
  phase: 1 | 2;
}) {
  return (
    <section className="flex flex-col items-center gap-1 py-6 text-center">
      <p className="text-sm text-ink-soft">Your money</p>
      <AmountDisplay value={usd} size="xl" tone="ink" countUp />
      <p className="text-sm text-ink-soft">
        ≈ {formatTry(tryValue)} <span className="opacity-70">indicative</span>
      </p>
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
