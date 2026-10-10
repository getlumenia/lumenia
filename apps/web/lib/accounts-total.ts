/**
 * Which accounts a balance on screen adds up (W10, "one balance per account").
 *
 * Every money screen used to sum EVERY account on this device. That was right while the only other
 * accounts were the per-link ones a claim makes (they are swept into the active account, and until
 * then their money is the person's money in transit). It stopped being right the day a person could
 * keep two deliberate accounts: the second one's dollars were counted as spendable from the first,
 * so "You have $20 to send" could be $15 the account in use could never sign for.
 *
 * So a total is the active account plus the accounts that are NOT deliberate ("throwaway", or a
 * record from before kinds existed, which the keystore already resolves to "throwaway" unless it is
 * the active one). Another deliberate account shows its own balance where it is listed (AccountsCard).
 * Pure; loads with no window.
 */
export interface TotalAccount {
  address: string;
  kind: "user" | "throwaway";
}

export function accountsForTotal(activeAddress: string | null | undefined, accounts: readonly TotalAccount[]): string[] {
  const out: string[] = [];
  if (activeAddress) out.push(activeAddress);
  for (const a of accounts) {
    if (a.address === activeAddress || a.kind === "user") continue;
    if (!out.includes(a.address)) out.push(a.address);
  }
  return out;
}
