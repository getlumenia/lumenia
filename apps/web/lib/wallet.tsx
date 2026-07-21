"use client";

/**
 * WalletProvider — the one React context the app shell hangs off (FRONTEND_PLAN §0:
 * no Zustand, one context; everything else is server/Horizon state). It exposes the
 * local account (address + custody phase) read from the keystore, and — for signing
 * (send) — an in-memory session seed set after unlock. The seed lives ONLY in memory
 * here + behind lib/signer.ts; it is never persisted in the clear and never logged.
 * v2 swaps the concrete signer without touching this shape.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { getHome, listAccounts, unlockPhase1, unlockPhase2, savePhase2, setHome, type Phase } from "./keystore";
import { localSignerFromSeed, type Signer } from "./signer";
import { DEFAULT_ARGON } from "./argon";
import { wrapWithPassword, unwrapWithPassword, emptyBox, putCopy, findCopy, type RecoveryBox } from "./recovery";

export interface WalletAccount {
  address: string;
  phase: Phase;
}

interface WalletState {
  status: "loading" | "ready";
  /** The ONE persistent home account — the address the app sends from + shows as identity. */
  account: WalletAccount | null;
  /**
   * Every stored account (home + any not-yet-swept throwaways). /home uses this to
   * consolidate incoming money into home and to sum ONE total balance. The user never
   * sees "account 1 / account 2" — this is plumbing, not UI.
   */
  accounts: WalletAccount[];
  /** true once a Phase-2 account has been unlocked this session (a signer is available). */
  unlocked: boolean;
  refresh: () => Promise<void>;
  /** hold the decrypted seed for the session (called by /unlock after a Phase-2 decrypt). */
  setSessionSeed: (seed: Uint8Array) => void;
  /**
   * A ready-to-use signer for the local account. Phase 1 unwraps the device key
   * inline; Phase 2 uses the session seed (throws if not yet unlocked — the caller
   * routes to /unlock). The seed never leaves this module.
   */
  getSigner: () => Promise<Signer>;
  /**
   * Back up the home seed into a portable, server-storable box (RECOVERY_ARCHITECTURE
   * §12): the same `password` locks the account locally (Phase 2) AND wraps the seed for
   * recovery. Returns ONLY the ciphertext box — the seed never leaves this module.
   */
  secureRecovery: (password: string) => Promise<RecoveryBox>;
  /**
   * Restore on a fresh device: open a fetched box with `password`, adopt the seed as the
   * home account (locked with that password), and unlock it for the session.
   */
  restoreRecovery: (box: RecoveryBox, password: string) => Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [accounts, setAccounts] = useState<WalletAccount[]>([]);
  const [unlocked, setUnlocked] = useState(false);
  const sessionSeed = useRef<Uint8Array | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [home, all] = await Promise.all([getHome(), listAccounts()]);
      setAccount(home ? { address: home.pubkey, phase: home.phase } : null);
      setAccounts(all.map((a) => ({ address: a.pubkey, phase: a.phase })));
    } catch {
      setAccount(null);
      setAccounts([]);
    } finally {
      setStatus("ready");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setSessionSeed = useCallback((seed: Uint8Array) => {
    sessionSeed.current = seed;
    setUnlocked(true);
  }, []);

  const getSigner = useCallback(async (): Promise<Signer> => {
    if (!account) throw new Error("no local account");
    let signer: Signer;
    if (account.phase === 1) {
      // Unlock the HOME account specifically (defaults to home, pinned for clarity).
      const seed = await unlockPhase1(account.address);
      signer = localSignerFromSeed(seed);
      seed.fill(0);
    } else {
      if (!sessionSeed.current) throw new Error("locked");
      signer = localSignerFromSeed(sessionSeed.current);
    }
    // The unlocked seed MUST derive the account we think we are signing for. If it
    // doesn't (a corrupted keystore, a swapped record), fail loud rather than sign a
    // transaction for the wrong account.
    if (signer.publicKey() !== account.address) {
      throw new Error("unlocked key does not match this account");
    }
    return signer;
  }, [account]);

  const secureRecovery = useCallback(
    async (password: string): Promise<RecoveryBox> => {
      if (!account) throw new Error("no local account");
      let seed: Uint8Array;
      if (account.phase === 1) {
        // First lock: the same password locks this account locally (Phase 2)…
        seed = await unlockPhase1(account.address);
        await savePhase2(account.address, seed, password, DEFAULT_ARGON);
      } else {
        // Already locked: verify the password by decrypting with it (throws if wrong).
        seed = (await unlockPhase2(password, account.address)).seed;
      }
      // …and wraps the seed into a portable box. Only the ciphertext leaves this module.
      const box = putCopy(emptyBox(), await wrapWithPassword(seed, password));
      setSessionSeed(seed); // keep unlocked this session (the session owns the seed)
      await refresh(); // the phase may have changed 1 → 2
      return box;
    },
    [account, refresh, setSessionSeed],
  );

  const restoreRecovery = useCallback(
    async (box: RecoveryBox, password: string): Promise<void> => {
      const copy = findCopy(box, "password");
      if (!copy) throw new Error("This backup can only be opened with Face ID.");
      const seed = await unwrapWithPassword(copy, password); // throws on a wrong password
      const pub = localSignerFromSeed(seed).publicKey();
      await savePhase2(pub, seed, password, DEFAULT_ARGON);
      await setHome(pub);
      setSessionSeed(seed);
      await refresh();
    },
    [refresh, setSessionSeed],
  );

  return (
    <WalletContext.Provider
      value={{ status, account, accounts, unlocked, refresh, setSessionSeed, getSigner, secureRecovery, restoreRecovery }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider");
  return ctx;
}
