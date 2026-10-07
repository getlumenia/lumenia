/**
 * Where a v1 practice claim's money ends up on this device.
 *
 * A v1 link's key is ALSO the key of the account its money lands in (the claimable balance names
 * that key as its claimant), and for the /try and /event links our server made that key, and anyone
 * who saw the link holds it, a QR code on the event board included. Such an account must therefore
 * never become this device's home account, the one a person goes on to use, and possibly to use with
 * real money (the keystore is not split by network). So:
 *
 *   - the link's account is always kept as a THROWAWAY (lib/keystore.ts: a throwaway never becomes
 *     home), the kind the /home screen gathers into the home account and closes;
 *   - on a device that already has a home, that is all: /home gathers it, as it always has;
 *   - on a device with no home yet, a home is made HERE, from a key this device generates (the
 *     sponsor opens its account, as for any new account), and the money is moved into it at once,
 *     before the success screen shows, so the next screen (send, ask) already has it. This is what
 *     a v2 link does by construction: its key only ever authorises a payout into an account the
 *     device made.
 *
 * If any step after the claim fails, the money is still safe in the link's account, which the
 * device keeps as a throwaway; /home gathers it into a home on a later visit.
 */
import { Keypair } from "@stellar/stellar-sdk";
import type { AccountKind } from "./keystore";

export interface SettleDeps {
  /** This device's home account, or null when it has none yet. */
  getHome(): Promise<{ pubkey: string } | null>;
  /** Keep an account's key on this device (lib/keystore.ts savePhase1). */
  saveAccount(pubkey: string, seed: Uint8Array, kind: AccountKind): Promise<void>;
  /** Drop an account's key from this device once its account is closed. */
  removeAccount(pubkey: string): Promise<void>;
  /** Have the sponsor open the account for this key, with its USDC trustline (lib/sponsor.ts prepareAccount). */
  openAccount(seed: Uint8Array): Promise<void>;
  /** The account's USDC balance as a decimal string, or null while the ledger does not show it yet. */
  balanceOf(pubkey: string): Promise<string | null>;
  /** Move `amount` from the throwaway into home and close the throwaway (lib/sweep.ts sweepIntoHome). */
  sweep(throwawaySeed: Uint8Array, homePublicKey: string, amount: string): Promise<void>;
  /** A fresh key, made on this device. */
  newKeypair(): Keypair;
  sleep(ms: number): Promise<void>;
}

export type SettleOutcome =
  /** The device already had a home; the link's account waits as a throwaway for /home to gather. */
  | "kept-throwaway"
  /** A home was made here and the money is in it; the link's account is closed. */
  | "moved-home"
  /** A home was made here; the money is still in the link's account (the ledger lagged or the move failed). /home gathers it. */
  | "home-made-money-waiting"
  /** No home could be made now; the money is safe in the link's account, kept as a throwaway. */
  | "no-home";

/** How long the move waits for the ledger to show the claimed balance: 8 looks, 1.5 s apart. */
const BALANCE_LOOKS = 8;
const BALANCE_WAIT_MS = 1_500;

export async function settleLinkAccount(linkKey: Keypair, deps: SettleDeps): Promise<SettleOutcome> {
  const linkPub = linkKey.publicKey();
  const linkSeed = new Uint8Array(linkKey.rawSecretKey());
  try {
    await deps.saveAccount(linkPub, linkSeed, "throwaway");
    if (await deps.getHome()) return "kept-throwaway";

    const home = deps.newKeypair();
    const homeSeed = new Uint8Array(home.rawSecretKey());
    try {
      try {
        await deps.openAccount(homeSeed.slice());
      } catch {
        return "no-home";
      }
      // The first account kept on this device becomes its home (a throwaway never does).
      await deps.saveAccount(home.publicKey(), homeSeed, "user");
    } finally {
      homeSeed.fill(0);
    }

    let amount: string | null = null;
    for (let look = 0; look < BALANCE_LOOKS; look++) {
      if (look > 0) await deps.sleep(BALANCE_WAIT_MS);
      const seen = await deps.balanceOf(linkPub).catch(() => null);
      if (seen !== null && Number.parseFloat(seen) > 0) {
        amount = seen;
        break;
      }
    }
    if (amount === null) return "home-made-money-waiting";

    try {
      await deps.sweep(linkSeed.slice(), home.publicKey(), amount);
    } catch {
      return "home-made-money-waiting";
    }
    await deps.removeAccount(linkPub).catch(() => {
      /* the account is closed on the ledger; a stale record here is harmless and /home drops it */
    });
    return "moved-home";
  } finally {
    linkSeed.fill(0);
  }
}
