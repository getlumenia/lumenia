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
import { getHome, listAccounts, unlockPhase1, unlockPhase2, savePhase1, savePhase2, setHome, setActive, removeAccount, isPublished, type Phase, type AccountKind } from "./keystore";
import { createUserAccount } from "./new-account";
import { localSignerFromSeed, type Signer } from "./signer";
import { NeedsBackupError, NeedsPasswordError } from "./signer-error";
import { passwordStrength } from "./password-strength";
import { activeNetwork, setActiveNetwork, mainnetConfig, type NetworkId } from "./network";
import { DEFAULT_ARGON } from "./argon";
import { wrapWithPassword, unwrapWithPassword, wrapWithPrf, unwrapWithPrf, emptyBox, putCopy, findCopy, prfToBoxId, prfToAliasProof, type RecoveryBox } from "./recovery";
import { enrollPasskeyPrf, derivePasskeyPrf, assertPasskeyPrf } from "./passkey-prf";
import { fetchRecoveryBoxByPrfId } from "./recovery-api";
import { migrateLegacySentLinks } from "./sent-links";
import { toast, toastAfterReload } from "../components/brand/Toast";
import { MainnetWarningDialog, mainnetWarningSeen, markMainnetWarningSeen } from "../components/brand/MainnetWarningDialog";
import {
  arrivalDismissTarget,
  askPilotStatus,
  backupBlocksRealMoney,
  mainnetSwitchBlock,
  mainnetWarningPlan,
  type MainnetWarning,
  type PilotState,
} from "./pilot-access";
import { hasBackup } from "./recovery-api";
import { StrKey } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";

export interface WalletAccount {
  address: string;
  phase: Phase;
  /**
   * "user" = an account the person created or restored on purpose. "throwaway" = the per-link
   * account a claim produced, which /home sweeps and closes. See docs/IDENTITY_AND_ACCOUNTS.md §4.2
   * — the distinction is what stops consolidation from destroying a deliberate second account.
   */
  kind: AccountKind;
}

/**
 * This account's standing in the mainnet pilot: the sponsor's /pilot-status `state`. "open" is
 * the retirement switch (SOW 2, D3 item i): the mainnet sponsor runs without PILOT_MODE, admits
 * every wallet, and answers `pilot:false`. The reading and the switch rule live in lib/pilot-access.ts.
 */
export type { PilotState } from "./pilot-access";

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
   *
   * By default the signer is for MOVING MONEY, and on real money with the pilot retired it is
   * refused with NeedsBackupError until the account is backed up (lib/pilot-access.ts
   * backupBlocksRealMoney); every money screen routes that to /pilot's secure step. A caller that
   * signs nothing that moves money (a proof for the backup store, a name, a way back in, opening the
   * account's own dollar line) says so with `{ movesMoney: false }` and is not held to it: the backup
   * step itself signs one of those, and must work for an account that has no backup yet.
   */
  getSigner: (opts?: { movesMoney?: boolean }) => Promise<Signer>;
  /**
   * Back up the home seed into a portable, server-storable box (RECOVERY_ARCHITECTURE
   * §12): the same `password` locks the account locally (Phase 2) AND wraps the seed for
   * recovery. Only ciphertext leaves this module — `commit` is handed the box and must put it
   * somewhere durable; the local Phase-2 lock is written only after it resolves.
   *
   * `newPassword` REPLACES an existing one, which is the only way past a password too weak to be
   * the offline-crack floor for the box.
   */
  secureRecovery: (
    password: string,
    commit: (box: RecoveryBox) => Promise<void>,
    newPassword?: string,
  ) => Promise<void>;
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
  /**
   * true when THIS account may switch to mainnet: on the pilot allowlist, or the pilot is retired
   * and real money is open to everyone (pilotState "open").
   */
  mainnetApproved: boolean;
  /**
   * This account's standing in the mainnet pilot, straight from the sponsor's /pilot-status `state`:
   * 'none' (never asked), 'pending' (asked, waiting), 'approved' (may switch up), 'rejected' (not
   * this round — the UI never says so in those words). Fail-soft 'none' when mainnet isn't configured
   * or the status call fails, so the UI degrades to "practice money" cleanly.
   */
  pilotState: PilotState;
  /**
   * true once the sponsor has answered for the current account (or this build has no mainnet). Until
   * then `pilotState` is the "none" default, not an answer, and the backup rule fails closed on real
   * money (lib/pilot-access.ts backupBlocksRealMoney).
   */
  pilotKnown: boolean;
  /** Switch this device's active network (mainnet only sticks if approved + configured); reloads. */
  switchNetwork: (id: NetworkId) => void;
  /**
   * Make another account on this device the active one — the account the app IS: shown, sent from,
   * and where incoming links consolidate. Reloads, for the same reason switchNetwork does: an
   * unlocked seed belongs to the account it was unlocked for, and every money module reads the
   * active account at call time.
   */
  switchAccount: (address: string) => Promise<void>;
  /**
   * Open a brand-new account (sponsored, 0 XLM, USDC trustline) and switch to it. Lands at Phase 1,
   * so the caller should offer the password step straight away — real money cannot be sent from an
   * unlocked-by-default account.
   */
  createAccount: () => Promise<{ address: string }>;
  /**
   * Remove one non-active account from this device. Irreversible without a backup, which is why the
   * UI that calls this asks in those words. Refuses the active account outright.
   */
  forgetAccount: (address: string) => Promise<void>;
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
  const [pilotKnown, setPilotKnown] = useState(false);
  /* Read by getSigner through a ref, so the signer's identity does not change when an answer
     arrives: screens key effects on getSigner, and a new identity would re-run their signed reads. */
  const pilotRef = useRef<{ state: PilotState; known: boolean }>({ state: "none", known: false });
  useEffect(() => {
    pilotRef.current = { state: pilotState, known: pilotKnown };
  }, [pilotState, pilotKnown]);
  /**
   * The real-money warning sheet, and what its two buttons do (lib/pilot-access.ts
   * mainnetWarningPlan): before a switch, or on arriving on real money unacknowledged.
   */
  const [warning, setWarning] = useState<Extract<MainnetWarning, { show: true }> | null>(null);
  const sessionSeed = useRef<Uint8Array | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [home, all] = await Promise.all([getHome(), listAccounts()]);
      setAccount(home ? { address: home.pubkey, phase: home.phase, kind: home.kind } : null);
      setAccounts(all.map((a) => ({ address: a.pubkey, phase: a.phase, kind: a.kind })));
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
    const id = activeNetwork().id;
    setNetworkState(id);
    /* ARRIVING on real money unacknowledged gets the warning too. The switch below was the only
       place it showed, and two ways onto real money never pass through it: a mainnet claim (the
       claim page lives outside this provider and sets the network itself) and a device that was
       already on real money. "Not now" there means practice money only when the way back is open
       to this account (mainnetWarningPlan "mount", arrivalDismissTarget). */
    const plan = mainnetWarningPlan({ trigger: "mount", network: id, seen: mainnetWarningSeen() });
    if (plan.show) setWarning(plan);
  }, []);

  /* Ask the mainnet sponsor where real money stands for this device (lib/pilot-access.ts
     askPilotStatus): with an account, whether THIS wallet may; without one, only whether the pilot
     is retired, which a device with no account used never to learn, so after the switch was flipped
     it went on saying "invite-only". The sponsor enforces it regardless; this gates the UI and, with
     the pilot retired, the backup rule in getSigner. */
  const address = account?.address ?? null;
  const askedFor = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // Not before the keystore has been read: the first answer would be for "no account" and be
    // thrown away a moment later.
    if (status === "loading") return;
    const mainnet = mainnetConfig();
    if (!mainnet) {
      setMainnetApproved(false);
      setPilotState("none");
      setPilotKnown(true); // no real money in this build: there is nothing left to learn
      return;
    }
    /* A different account is a different question: its answer must not inherit the previous one's,
       and until it arrives nothing is known (getSigner fails closed on real money meanwhile). */
    if (askedFor.current !== address) {
      askedFor.current = address;
      setMainnetApproved(false);
      setPilotState("none");
      setPilotKnown(false);
    }
    let alive = true;
    const ask = () =>
      askPilotStatus({ sponsorUrl: mainnet.sponsorUrl, pubkey: address }).then((read) => {
        /* null is a FAILED ask (a 429, an error page, no connection), and a failed ask is not a
           rejection. It used to be read as one twice over: a thrown fetch demoted an approved pilot
           user to "none", and later any JSON error body did, so a rate-limited open-mode user was
           told "invite-only". Keep the last known answer and try again on the next tick. */
        if (!alive || read === null) return;
        /* `pilot:false` is the sponsor saying the allowlist is retired: it admits every wallet,
           never "not approved" (lib/pilot-access.ts readPilotStatus, test:pilotaccess). */
        setMainnetApproved(read.mainnetApproved);
        setPilotState(read.pilotState);
        setPilotKnown(true);
      });

    void ask();

    /* Approval happens on the OWNER's phone, minutes or hours later, and nothing pushes that back
       here. The status was read exactly once per hard page load, and `account` does not change in
       normal use — so on an installed PWA an approved user could sit on "You're on the list,
       nothing to do right now" for days, with no button anywhere to check. Poll while the answer is
       still pending, only when the tab is visible, and stop as soon as it lands. (Without an
       account there is no approval to wait for: the answer is re-read when the tab comes back.) */
    const poll = window.setInterval(() => {
      if (address && document.visibilityState === "visible") void ask();
    }, 60_000);
    const onShow = () => {
      if (document.visibilityState === "visible") void ask();
    };
    document.addEventListener("visibilitychange", onShow);

    return () => {
      alive = false;
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [address, status]);

  // A network switch changes which chain every value call builds for. Reload so every module
  // re-reads it cleanly and a stale unlocked session never carries across networks.
  const performSwitch = useCallback((id: NetworkId) => {
    // AFTER the reload, not now: the switch throws this page away, so a toast lit here would be
    // destroyed by the very event it announces (components/brand/Toast.tsx).
    toastAfterReload(id === "public" ? "You're on real money now." : "You're on practice money now.");
    setActiveNetwork(id);
    window.location.reload();
  }, []);

  const switchNetwork = useCallback(
    (id: NetworkId) => {
      const block = mainnetSwitchBlock({
        to: id === "public" ? "public" : "testnet",
        mainnetApproved,
        pilotState,
        account: account ? { phase: account.phase } : null,
        backedUp: account ? hasBackup(account.address) : false,
      });
      if (block === "invite-only") {
        // The sponsor is the real gate, so refusing here is only a UI courtesy — but refusing
        // SILENTLY was its own small bug: the button did nothing and said nothing, which reads as
        // a broken app rather than as an answer.
        toast("Real money is invite-only for now — you're still on practice money.");
        return;
      }
      if (block === "secure-first") {
        /* The pilot retired, its precondition did not: real money only for an account that is
           locked with a password and backed up. /pilot is where that one step lives. */
        toastAfterReload("Lock your money with a password and back it up first: real money needs both.");
        window.location.assign("/pilot");
        return;
      }
      /* Everyone reads the real-money warning once per device before the first switch, whichever
         screen asked and whether the pilot is on or retired (SOW 2, D3 item i): an early pilot,
         not reviewed by an outside security firm, keep amounts small. The sheet below finishes
         the switch on "I understand". */
      const plan = mainnetWarningPlan({ trigger: "switch", network: id === "public" ? "public" : "testnet", seen: mainnetWarningSeen() });
      if (plan.show) {
        setWarning(plan);
        return;
      }
      performSwitch(id);
    },
    [mainnetApproved, pilotState, account, performSwitch],
  );

  const setSessionSeed = useCallback((seed: Uint8Array) => {
    sessionSeed.current = seed;
    setUnlocked(true);
  }, []);

  const getSigner = useCallback(async (opts?: { movesMoney?: boolean }): Promise<Signer> => {
    if (!account) throw new Error("no local account");
    const onMainnet = activeNetwork().id === "public";
    /* THE PILOT'S PRECONDITION, WHERE MONEY LEAVES. With the pilot retired the sponsor admits every
       wallet, and the lock-AND-backup rule used to run only inside switchNetwork(): a mainnet claim,
       a new account made on real money, or "Use this" on another account put a never-backed-up
       account on real money with no check at all, and nothing before a send asked. So the rule sits
       here, where every money movement gets its key (lib/pilot-access.ts backupBlocksRealMoney).
       First, before the password check below, because /pilot's one secure step sets the password
       AND writes the backup, which "set a password" alone would not. */
    if (
      opts?.movesMoney !== false &&
      onMainnet &&
      backupBlocksRealMoney({
        onMainnet,
        pilotState: pilotRef.current.state,
        pilotKnown: pilotRef.current.known,
        backedUp: hasBackup(account.address),
      })
    ) {
      throw new NeedsBackupError();
    }
    // Real money must never sit under a Phase-1 account — a device key with no password, which
    // anyone holding the unlocked phone can spend.
    //
    // This used to key off NEXT_PUBLIC_REQUIRE_PHASE2 alone, which was the wrong axis: one build
    // serves BOTH networks (the choice is a runtime device flag), so the env var could only be all
    // or nothing. Off meant real mainnet money was spendable from an unlocked phone; on meant the
    // testnet demo — the thing we hand strangers to try — grew a password wall. So the rule follows
    // the NETWORK instead: mainnet always requires the password, testnet never does. The env var
    // survives as an override for forcing Phase 2 on a testnet build too.
    if (account.phase === 1 && (onMainnet || process.env.NEXT_PUBLIC_REQUIRE_PHASE2 === "1")) {
      // Typed, not generic: every money screen sends a signer failure to /unlock, and /unlock sends
      // an account without a password back to /home. Undistinguished, this branch is that loop.
      throw new NeedsPasswordError();
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
    async (
      password: string,
      commit: (box: RecoveryBox) => Promise<void>,
      newPassword?: string,
    ): Promise<void> => {
      if (!account) throw new Error("no local account");
      // Whatever wraps the box is what somebody holding the fetched ciphertext gets to guess
      // OFFLINE, bounded only by Argon2id. So the floor is enforced at the wrap, not merely in the
      // form above it: a screen that locks first and backs up second could otherwise carry a
      // 6-character device password straight into the server copy.
      const key = newPassword ?? password;
      const strong = passwordStrength(key);
      if (!strong.ok) throw new Error(strong.reason ?? "Pick a stronger password.");
      const wasPhase1 = account.phase === 1;
      const seed = wasPhase1
        ? await unlockPhase1(account.address)
        : // Already locked: verify the password by decrypting with it (throws if wrong).
          (await unlockPhase2(password, account.address)).seed;
      const box = putCopy(emptyBox(), await wrapWithPassword(seed, key));
      setSessionSeed(seed); // keep unlocked this session (the session owns the seed)
      // The backup has to LAND before this device is locked to the password behind it. Locking
      // first left anyone whose emailed code was wrong or expired holding a Phase-2 account whose
      // password had been typed exactly once and whose seed existed nowhere else.
      await commit(box);
      if (wasPhase1 || newPassword) {
        await savePhase2(account.address, seed, key, DEFAULT_ARGON);
      }
      await refresh(); // the phase may have changed 1 → 2
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
      await savePhase2(pub, seed, password, DEFAULT_ARGON, "user"); // restored on purpose → never swept
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
      await savePhase1(pub, seed, "user"); // restored on purpose → never swept
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
    await savePhase1(pub, seed, "user"); // found on purpose → never swept
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
      // The same floor as the wrap: this password becomes the account's password, and a later
      // backup hands it verbatim to secureRecovery as the key to server-stored ciphertext.
      const strong = passwordStrength(password);
      if (!strong.ok) throw new Error(strong.reason ?? "Pick a stronger password.");
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

  /**
   * Switching is a hard reload on purpose. `activeNetwork()`-style call-time reads exist all over
   * the money modules, and the session seed in this provider belongs to whichever account unlocked
   * it — a soft route change would leave one screen signing for an account another screen is no
   * longer showing. Reloading throws all of that away, which is the only cheap way to be sure.
   */
  const switchAccount = useCallback(async (address: string): Promise<void> => {
    const known = await listAccounts();
    if (!known.some((a) => a.pubkey === address)) throw new Error("that account is not on this phone");
    sessionSeed.current?.fill(0);
    sessionSeed.current = null;
    await setActive(address);
    window.location.assign("/home");
  }, []);

  const createAccount = useCallback(async (): Promise<{ address: string }> => {
    const { address } = await createUserAccount({ sponsorUrl: activeNetwork().sponsorUrl, makeActive: true });
    sessionSeed.current?.fill(0);
    sessionSeed.current = null;
    await refresh();
    return { address };
  }, [refresh]);

  const forgetAccount = useCallback(
    async (address: string): Promise<void> => {
      if (account?.address === address) throw new Error("that is the account you are using");
      await removeAccount(address, true); // deliberate: the UI has already confirmed it
      await refresh();
    },
    [account, refresh],
  );

  // Where "Not now" on the arrival sheet may leave this device: back to practice money only when the
  // switch back to real money is open to this account right now (lib/pilot-access.ts).
  const arrivalTarget = arrivalDismissTarget(
    mainnetSwitchBlock({
      to: "public",
      mainnetApproved,
      pilotState,
      account: account ? { phase: account.phase } : null,
      backedUp: account ? hasBackup(account.address) : false,
    }),
  );

  return (
    <WalletContext.Provider
      value={{ status, account, accounts, unlocked, network, mainnetApproved, pilotState, pilotKnown, switchNetwork, switchAccount, createAccount, forgetAccount, refresh, setSessionSeed, getSigner, secureRecovery, restoreRecovery, addFaceIdBackup, restoreWithFaceId, findAccountWithFaceId, lockWithPassword, unlockWithFaceId }}
    >
      {children}
      {/* What each button does was decided by mainnetWarningPlan when the sheet was opened; where
          "Not now" on the arrival sheet leaves the device is decided now (arrivalDismissTarget). */}
      <MainnetWarningDialog
        open={warning !== null}
        arrived={warning?.onDismiss === "back-to-practice"}
        backToPractice={warning?.onDismiss === "back-to-practice" && arrivalTarget === "practice"}
        onClose={() => {
          const plan = warning;
          setWarning(null);
          if (plan?.onDismiss === "back-to-practice" && arrivalTarget === "practice") performSwitch("testnet");
        }}
        onConfirm={() => {
          const plan = warning;
          markMainnetWarningSeen();
          setWarning(null);
          if (plan?.onConfirm === "mark-seen-and-switch") performSwitch("public");
        }}
      />
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider");
  return ctx;
}
