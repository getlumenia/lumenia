// The daily budget is the one rule that turns "an agent with a key" into "an
// agent with an allowance": the sum of everything paid out in the trailing 24
// hours, read from the local receipt log, may not exceed DAILY_BUDGET_USDC.
// Receipts whose transaction never happened (status Failed) do not count;
// everything else does, including links that were later reclaimed, because the
// rule is about what the agent may put into escrow, not about net flow.
import { formatUsdc } from "./amount.js";

export const BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
export const NON_SPEND_STATUSES: ReadonlySet<string> = new Set(["Failed"]);

export interface BudgetReceipt {
  created_at: string;
  amount_units: string;
  status: string;
}

export interface BudgetCheck {
  ok: boolean;
  reason?: string;
  spentUnits: bigint;
  remainingUnits: bigint;
}

export function spentInWindow(receipts: readonly BudgetReceipt[], now: Date, windowMs = BUDGET_WINDOW_MS): bigint {
  const floor = now.getTime() - windowMs;
  let sum = 0n;
  for (const r of receipts) {
    if (NON_SPEND_STATUSES.has(r.status)) continue;
    const t = Date.parse(r.created_at);
    if (Number.isNaN(t) || t < floor || t > now.getTime() + 60_000) continue;
    sum += BigInt(r.amount_units);
  }
  return sum;
}

export function checkBudget(args: {
  amountUnits: bigint;
  receipts: readonly BudgetReceipt[];
  now: Date;
  dailyBudgetUnits: bigint;
  /** Per-link cap; omit for a batch total, whose rows were capped one by one. */
  maxLinkUnits?: bigint;
}): BudgetCheck {
  const spent = spentInWindow(args.receipts, args.now);
  const remaining = args.dailyBudgetUnits > spent ? args.dailyBudgetUnits - spent : 0n;
  const amount = formatUsdc(args.amountUnits);
  if (args.maxLinkUnits !== undefined && args.amountUnits > args.maxLinkUnits) {
    return {
      ok: false,
      spentUnits: spent,
      remainingUnits: remaining,
      reason:
        `Refused: ${amount} USDC is above the per-link maximum of ${formatUsdc(args.maxLinkUnits)} USDC ` +
        `(MAX_LINK_USDC). Nothing was spent.`,
    };
  }
  if (spent + args.amountUnits > args.dailyBudgetUnits) {
    return {
      ok: false,
      spentUnits: spent,
      remainingUnits: remaining,
      reason:
        `Refused: paying ${amount} USDC would exceed the daily budget of ${formatUsdc(args.dailyBudgetUnits)} USDC ` +
        `(${formatUsdc(spent)} USDC already paid in the last 24 hours, ${formatUsdc(remaining)} USDC left). ` +
        `The agent gets a budget, not the keys to everything; a human raises DAILY_BUDGET_USDC if this is intended. ` +
        `Nothing was spent.`,
    };
  }
  return { ok: true, spentUnits: spent, remainingUnits: remaining - args.amountUnits };
}
