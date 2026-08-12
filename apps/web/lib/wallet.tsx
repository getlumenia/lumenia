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
import { getHome, listAccounts, unlockPhase1, unlockPhase2, savePhase1, savePhase2, setHome, isPublished, type Phase } from "./keystore";
import { localSignerFromSeed, type Signer } from "./signer";
import { activeNetwork, setActiveNetwork, mainnetConfig, type NetworkId } from "./network";
import { DEFAULT_ARGON } from "./argon";
import { wrapWithPassword, unwrapWithPassword, wrapWithPrf, unwrapWithPrf, emptyBox, putCopy, findCopy, prfToBoxId, prfToAliasProof, type RecoveryBox } from "./recovery";
import { enrollPasskeyPrf, derivePasskeyPrf, assertPasskeyPrf } from "./passkey-prf";
import { fetchRecoveryBoxByPrfId } from "./recovery-api";
import { migrateLegacySentLinks } from "./sent-links";
import { StrKey } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";

export interface WalletAccount {
  address: string;
  phase: Phase;
}

/** This account's standing in the mainnet pilot — the sponsor's /pilot-status `state`. */
export type PilotState = "none" | "pending" | "approved" | "rejected";

/** Narrow an untrusted /pilot-status `state` to a known value; anything else fails soft to 'none'. */
function isPilotState(s: unknown): s is PilotState {
  return s === "none" || s === "pending" || s === "approved" || s === "rejected";
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
  /**
   * Face ID UPGRADE (real browser only; RECOVERY_ARCHITECTURE §12 step 5): enroll a passkey
   * and wrap the seed with its PRF output, adding a second (PRF) copy to `box`. Returns the
   * updated box to re-store. Requires the account to be unlocked (session seed present).
   * Degrades gracefully where passkeys/PRF are unavailable; NEVER a claim-path dependency.
   */
  addFaceIdBackup: (box: RecoveryBox) => Promise<{ box: RecoveryBox; aliasId: string; aliasProof: string }>;
  /**
   * Find and restore this user's account from a passkey alone — no email, no code, no password.
   * One discoverable assertion yields both the PRF (which addresses and opens the backup) and the
   * account's public key. Throws with a plain-language reason when there is no backup for this
   * passkey, which is NOT the same as "you have no backup".
   */
  findAccountWithFaceId: () => Promise<{ address: string; alreadyHere: boolean; hasPasswordCopy: boolean }>;
  /** Lock a Phase-1 account with a password (used right after a Face-ID restore). */
  lockWithPassword: (password: string) => Promise<void>;
  /**
   * Unlock THIS SESSION with Face ID instead of the password, for an account that is already on
   * this device and already password-locked. Deliberately NOT findAccountWithFaceId: it writes
   * nothing, so the account stays Phase 2 and the password still governs the next session.
   */
  unlockWithFaceId: () => Promise<void>;
  /** Restore on a fresh device via Face ID: unwrap the box's PRF copy with the passkey. */
  restoreWithFaceId: (box: RecoveryBox) => Promise<void>;
  /** The network the classic value path uses right now on this device (testnet unless switched). */
  network: NetworkId;
  /** true when THIS account is on the mainnet pilot allowlist — the only case mainnet may be picked. */
  mainnetApproved: boolean;
  /**
   * This account's standing in the mainnet pilot, straight from the sponsor's /pilot-status `state`:
   * 'none' (never asked), 'pending' (asked, waiting), 'approved' (may switch up), 'rejected' (not
   * this round — the UI never says so in those words). Fail-soft 'none' when mainnet isn't configured
   * or the status call fails, so the UI degrades to "practice money" cleanly.
   */
  pilotState: PilotState;
  /** Switch this device's active network (mainnet only sticks if approved + configured); reloads. */
  switchNetwork: (id: NetworkId) => void;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [accounts, setAccounts] = useState<WalletAccount[]>([]);
  const [unlocked, setUnlocked] = useState(false);
  const [network, setNetworkState] = useState<NetworkId>("testnet");
  const [mainnetApproved, setMainnetApproved] = useState(false);
  const [pilotState, setPilotState] = useState<PilotState>("none");
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
    // One-shot cleanup for devices that already hold plaintext claim links (see sent-links.ts).
    void migrateLegacySentLinks();
  }, [refresh]);

  // Reflect the device's chosen network once mounted (localStorage is client-only, not at SSR).
  useEffect(() => {
    setNetworkState(activeNetwork().id);
  }, []);

  // Ask the mainnet sponsor whether THIS account is on the pilot allowlist. Only an approved
  // account may switch to mainnet; the sponsor enforces it regardless — this just gates the UI.
  useEffect(() => {
    const mainnet = mainnetConfig();
    if (!account || !mainnet) {
      setMainnetApproved(false);
      setPilotState("none");
      return;
    }
    let alive = true;
    fetch(`${mainnet.sponsorUrl.replace(/\/$/, "")}/pilot-status?pubkey=${account.address}`)
      .then((r) => r.json() as Promise<{ approved?: boolean; state?: string }>)
      .then((d) => {
        if (!alive) return;
        setMainnetApproved(Boolean(d.approved));
        setPilotState(isPilotState(d.state) ? d.state : "none");
      })
      .catch(() => {
        if (!alive) return;
        setMainnetApproved(false);
        setPilotState("none");
      });
    return () => {
      alive = false;
    };
  }, [account]);

  // A network switch changes which chain every value call builds for. Reload so every module
  // re-reads it cleanly and a stale unlocked session never carries across networks.
  const switchNetwork = useCallback(
    (id: NetworkId) => {
      if (id === "public" && !mainnetApproved) return; // UI guard; the sponsor is the real gate
      setActiveNetwork(id);
      window.location.reload();
    },
    [mainnetApproved],
  );

  const setSessionSeed = useCallback((seed: Uint8Array) => {
    sessionSeed.current = seed;
    setUnlocked(true);
  }, []);

  const getSigner = useCallback(async (): Promise<Signer> => {
    if (!account) throw new Error("no local account");
    // Real money must never sit under a Phase-1 account — a device key with no password, which
    // anyone holding the unlocked phone can spend.
    //
    // This used to key off NEXT_PUBLIC_REQUIRE_PHASE2 alone, which was the wrong axis: one build
    // serves BOTH networks (the choice is a runtime device flag), so the env var could only be all
    // or nothing. Off meant real mainnet money was spendable from an unlocked phone; on meant the
    // testnet demo — the thing we hand strangers to try — grew a password wall. So the rule follows
    // the NETWORK instead: mainnet always requires the password, testnet never does. The env var
    // survives as an override for forcing Phase 2 on a testnet build too.
    const onMainnet = activeNetwork().id === "public";
    if (account.phase === 1 && (onMainnet || process.env.NEXT_PUBLIC_REQUIRE_PHASE2 === "1")) {
      throw new Error("Lock your money with a password first, then try again.");
    }
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

  /**
   * Adopt a restored account WITHOUT stealing the home pointer from a PUBLISHED one.
   *
   * A restore used to call setHome() unconditionally. That is fine until an address has been
   * handed to somebody: /home sweeps every non-home account, and the sweep ends in accountMerge,
   * which closes the account on-chain. So restoring a backup could silently demote the very
   * address a user gave to an exchange, and then destroy it — the withdrawal would bounce.
   *
   * Rule: take home when there is no home, when it is already this account, or when the current
   * home was never published. A published home keeps the pointer; the restored account is still
   * fully stored, still counted in the balance, and can be made home deliberately later.
   */
  const adoptRestored = useCallback(async (pub: string): Promise<void> => {
    const home = await getHome();
    if (!home || home.pubkey === pub) {
      await setHome(pub);
      return;
    }
    if (!(await isPublished(home.pubkey))) await setHome(pub);
  }, []);

  const restoreRecovery = useCallback(
    async (box: RecoveryBox, password: string): Promise<void> => {
      const copy = findCopy(box, "password");
      if (!copy) throw new Error("This backup can only be opened with Face ID.");
      const seed = await unwrapWithPassword(copy, password); // throws on a wrong password
      const pub = localSignerFromSeed(seed).publicKey();
      await savePhase2(pub, seed, password, DEFAULT_ARGON);
      await adoptRestored(pub);
      setSessionSeed(seed);
      await refresh();
    },
    [adoptRestored, refresh, setSessionSeed],
  );

  const addFaceIdBackup = useCallback(
    async (box: RecoveryBox): Promise<{ box: RecoveryBox; aliasId: string; aliasProof: string }> => {
      if (!account) throw new Error("no local account");
      if (!sessionSeed.current) throw new Error("locked"); // Face ID is an upgrade over the unlocked seed
      // A stable per-account passkey user id = the account's raw 32-byte public key. The
      // authenticator hands this back on every later assertion, which is what lets a fresh device
      // learn WHICH account it just unlocked without the user typing anything.
      const userId = StrKey.decodeEd25519PublicKey(account.address);
      const { prf } = await enrollPasskeyPrf({ userId, userName: `Lumenia ${account.address.slice(0, 6)}` });
      const updated = putCopy(box, await wrapWithPrf(sessionSeed.current, prf));
      // The second, independent value from the same PRF: where this box will be findable later
      // with no email and no code. Derived here so the raw PRF never leaves this module.
      const aliasId = await prfToBoxId(prf);
      // A third value from the same PRF, independent of the id: it proves to the server that this
      // passkey owns that alias row, so nobody else's verified code can overwrite it.
      const aliasProof = await prfToAliasProof(prf);
      prf.fill(0);
      return { box: updated, aliasId, aliasProof };
    },
    [account],
  );

  const restoreWithFaceId = useCallback(
    async (box: RecoveryBox): Promise<void> => {
      const copy = findCopy(box, "prf");
      if (!copy) throw new Error("This backup has no Face ID key. Use your password.");
      const prf = await derivePasskeyPrf();
      const seed = await unwrapWithPrf(copy, prf); // throws on a wrong passkey / tampered copy
      prf.fill(0);
      const pub = localSignerFromSeed(seed).publicKey();
      // Adopt device-locally with the device key (Phase 1) — they authenticated biometrically,
      // so no separate password; the "Back up your money" card can add one later.
      await savePhase1(pub, seed);
      await adoptRestored(pub);
      setSessionSeed(seed);
      await refresh();
    },
    [adoptRestored, refresh, setSessionSeed],
  );

  /**
   * ZERO-TYPING restore: one Face ID tap on a phone that has never seen this account.
   *
   * Everything needed is already inside the passkey and, until now, went unread. A single
   * discoverable assertion returns the PRF output AND the `userHandle` set at enrolment — the
   * account's own raw public key. The PRF derives where the backup is stored, fetches the
   * ciphertext with no email and no code, and opens it. The userHandle is then a free
   * cross-check that the seed we just decrypted really is the account the passkey names.
   *
   * `alreadyHere` distinguishes "we brought your money back" from "you already had it here",
   * so a second tap reads as reassurance rather than as an error.
   */
  const findAccountWithFaceId = useCallback(async (): Promise<{
    address: string;
    alreadyHere: boolean;
    hasPasswordCopy: boolean;
  }> => {
    const { prf, userHandle } = await assertPasskeyPrf();
    let seed: Uint8Array;
    let box: RecoveryBox | null;
    try {
      box = await fetchRecoveryBoxByPrfId(await prfToBoxId(prf));
      if (!box) {
        throw new Error(
          "We couldn't find a backup for this Face ID. If you set one up with your email, use that below.",
        );
      }
      const copy = findCopy(box, "prf");
      if (!copy) throw new Error("This backup has no Face ID key. Use your password.");
      seed = await unwrapWithPrf(copy, prf);
    } finally {
      prf.fill(0);
    }
    const pub = localSignerFromSeed(seed).publicKey();
    if (userHandle && userHandle.length === 32) {
      // Belt-and-braces: AES-GCM already authenticated the ciphertext, but if these ever
      // disagree the passkey and the box belong to different accounts and adopting would be
      // worse than failing.
      const named = StrKey.encodeEd25519PublicKey(Buffer.from(userHandle));
      if (named !== pub) throw new Error("This passkey doesn't match the backup it opened.");
    }
    const before = await getHome();
    await savePhase1(pub, seed);
    await adoptRestored(pub);
    setSessionSeed(seed);
    await refresh();
    return {
      address: pub,
      alreadyHere: before?.pubkey === pub,
      hasPasswordCopy: Boolean(findCopy(box, "password")),
    };
  }, [adoptRestored, refresh, setSessionSeed]);

  /**
   * Lock a Phase-1 account with a password (Phase 2). A Face-ID restore lands at Phase 1 so a
   * closed tab can never lose the restore, but Phase 1 means anyone holding the phone can spend —
   * a silent downgrade from the Phase 2 it had on the original device. This is the step that
   * undoes that, offered immediately rather than left to a card the user may never open.
   */
  const lockWithPassword = useCallback(
    async (password: string): Promise<void> => {
      if (!account) throw new Error("no local account");
      const seed = sessionSeed.current ?? (await unlockPhase1(account.address));
      await savePhase2(account.address, seed, password, DEFAULT_ARGON);
      setSessionSeed(seed);
      await refresh();
    },
    [account, refresh, setSessionSeed],
  );

  /**
   * Unlock this session with Face ID when the password is the thing that's been forgotten.
   *
   * Writes NOTHING. findAccountWithFaceId adopts an account onto a device and lands it at Phase 1;
   * running that here would quietly demote an already-locked account to "anyone holding this phone
   * can spend it", which is the opposite of what somebody unlocking wants. This only puts the seed
   * in memory for the session, so the password still governs the next one.
   *
   * On capability: this grants nothing new. Whoever can pass Face ID on this phone could already
   * clear the site's data and restore from scratch on the no-account screen. What it removes is a
   * speed bump, which is worth being explicit about in the UI rather than quiet about — it trades
   * shoulder-surfing resistance for coercion resistance, and that is the user's trade to know.
   */
  const unlockWithFaceId = useCallback(async (): Promise<void> => {
    if (!account) throw new Error("no local account");
    const { prf } = await assertPasskeyPrf();
    let seed: Uint8Array;
    try {
      const box = await fetchRecoveryBoxByPrfId(await prfToBoxId(prf));
      if (!box) {
        throw new Error("We couldn't find a Face ID backup for this money. Your password still works.");
      }
      const copy = findCopy(box, "prf");
      if (!copy) throw new Error("This backup has no Face ID key. Use your password.");
      seed = await unwrapWithPrf(copy, prf);
    } finally {
      prf.fill(0);
    }
    // The passkey may legitimately open a DIFFERENT account's backup (a second Lumenia passkey on
    // the same phone). Unlocking this one with that seed would sign for the wrong account, so it
    // fails loudly instead.
    if (localSignerFromSeed(seed).publicKey() !== account.address) {
      throw new Error("That Face ID belongs to different money on this phone.");
    }
    setSessionSeed(seed);
  }, [account, setSessionSeed]);

  return (
    <WalletContext.Provider
      value={{ status, account, accounts, unlocked, network, mainnetApproved, pilotState, switchNetwork, refresh, setSessionSeed, getSigner, secureRecovery, restoreRecovery, addFaceIdBackup, restoreWithFaceId, findAccountWithFaceId, lockWithPassword, unlockWithFaceId }}
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
