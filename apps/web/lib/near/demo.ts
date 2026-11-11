// The deployment can carry a shared, throwaway testnet sender so a judge never needs a key.
// Both values must be present at build time; the repo never commits them.

/** Per-link cap for the shared demo sender, so its balance lasts (5.00 USDC). */
export const DEMO_MAX_LINK_UNITS = "5000000";
export const DEMO_DEFAULT_AMOUNT = "1.00";

export function demoSenderAvailable(accountId: string | undefined, secretKey: string | undefined): boolean {
  const id = (accountId ?? "").trim();
  const key = (secretKey ?? "").trim();
  return id.length >= 2 && /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,96}$/.test(key);
}

/** The amount defaults and the per-link cap for a sender: demo mode is tighter, the testnet cap stays for everyone else. */
export function linkLimits(demo: boolean, testnetMaxUnits: string): { maxUnits: string; defaultAmount: string } {
  return demo ? { maxUnits: DEMO_MAX_LINK_UNITS, defaultAmount: DEMO_DEFAULT_AMOUNT } : { maxUnits: testnetMaxUnits, defaultAmount: "1" };
}
