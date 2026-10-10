"use client";

/**
 * DisconnectButton — remove this device's keys, so someone can hand the phone on, use a different
 * account, or stop practising and start fresh.
 *
 * The reason this is not a plain "sign out": everywhere else that phrase is reversible, because
 * the account lives on a server and a password brings it back. Here the keys ARE the account. With a
 * backup the server confirmed is tied to the account, the promise holds: email and password, or
 * Face ID, restore it. Without one this device may hold the only copy, and pressing this ends access
 * to that money permanently. Same button, two completely different consequences, so it types
 * differently: one confirmation when every account here is confirmed backed up, a typed word
 * otherwise.
 *
 * IT REMOVES EVERY ACCOUNT. clearKeystore wipes the whole keystore, and the confirmation used to look
 * at the active account alone: a second account that was never backed up, or money from a claimed
 * link still on its way into the active account, went with it after one tap. The rule is now one
 * pure function over all of them (lib/leave-device.ts disconnectTier), and the active account's
 * backup is re-checked against the server when it can sign without asking (a "not mine" answer
 * forces the typed tier).
 *
 * A BACKUP IS NOT THE WHOLE STORY. It brings the account back, not the list of money links sent from
 * this browser: that list lives only here (localStorage `lumenia.sent`, per network), and it is the
 * only way the website finds a link to take back. Removing the account leaves the list where it is,
 * so the way back to an unclaimed link is this account, on this browser. When there are links, the
 * sheet says so before anything is removed.
 */
import { useState } from "react";
import { clearKeystore } from "../../lib/keystore";
import { useWallet } from "../../lib/wallet";
import { backupRecords, forgetAllBackupRecords, markBackedUp } from "../../lib/backup-record";
import { checkMine } from "../../lib/recovery-client";
import { disconnectTier, unconfirmedAccounts, type DisconnectTier } from "../../lib/leave-device";
import { shortAddress } from "../../lib/account-label";
import { loadTotalUsd } from "../../lib/horizon";

const CONFIRM_WORD = "REMOVE";

/** Does this browser hold any money links sent from it (either network)? Blocked storage reads as no. */
function sentLinksHere(): boolean {
  for (const net of ["testnet", "public"]) {
    try {
      const all = JSON.parse(localStorage.getItem(`lumenia.sent.${net}`) ?? "{}") as Record<string, { balanceId?: unknown }>;
      if (Object.values(all).some((r) => typeof r?.balanceId === "string" && /^[0-9a-f]{64}$/i.test(r.balanceId))) return true;
    } catch {
      /* unreadable: nothing to warn about from here */
    }
  }
  return false;
}

export function DisconnectButton() {
  const { account, accounts, getSigner } = useWallet();
  const [arming, setArming] = useState(false);
  const [checking, setChecking] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasLinks, setHasLinks] = useState(false);
  const [tier, setTier] = useState<DisconnectTier>("typed");
  const [unconfirmed, setUnconfirmed] = useState<string[]>([]);
  const [claimMoney, setClaimMoney] = useState(false);

  const userAccounts = accounts.filter((a) => a.kind === "user").map((a) => a.address);
  if (account && !userAccounts.includes(account.address)) userAccounts.unshift(account.address);
  const many = userAccounts.length > 1;
  const canGo = tier === "one-tap" || typed.trim().toUpperCase() === CONFIRM_WORD;

  /** Decide the tier from what is known now, then re-check the active account's backup. */
  async function arm(): Promise<void> {
    setHasLinks(sentLinksHere());
    setArming(true);
    setChecking(true);
    try {
      const throwaways = accounts.filter((a) => a.kind !== "user").map((a) => a.address);
      let withMoney = false;
      if (throwaways.length > 0) {
        // Unknown counts as money: a failed read must never earn the one-tap tier.
        withMoney = await loadTotalUsd(throwaways)
          .then((t) => t.perAccount.some((p) => Number.parseFloat(p.usd) > 0))
          .catch(() => true);
      }
      const notMine: string[] = [];
      const record = account ? backupRecords()[account.address] : undefined;
      if (account && record?.email) {
        // Only when it can sign without asking: a locked account keeps what is recorded.
        const signer = await getSigner({ movesMoney: false }).catch(() => null);
        if (signer) {
          const answer = await checkMine(record.email, signer);
          if (answer === "not-mine") {
            notMine.push(account.address);
            markBackedUp(account.address, record.email, false);
          } else if (answer === "mine") {
            markBackedUp(account.address, record.email, true);
          }
        }
      }
      const records = backupRecords();
      setClaimMoney(withMoney);
      setTier(disconnectTier({ userAccounts, records, throwawayWithMoney: withMoney, notMine }));
      setUnconfirmed(unconfirmedAccounts({ userAccounts, records, notMine }));
    } finally {
      setChecking(false);
    }
  }

  async function run(): Promise<void> {
    setBusy(true);
    try {
      await clearKeystore();
      // The email each account was backed up with goes with the accounts (see /privacy).
      forgetAllBackupRecords();
    } finally {
      // Full reload rather than a client navigation: every module holding an unlocked seed or a
      // cached account in memory has to be torn down, and a soft route change would leave them.
      window.location.href = "/";
    }
  }

  const label = many ? "Remove every account from this browser" : "Remove this account from this browser";

  if (!arming) {
    return (
      <button
        type="button"
        onClick={() => void arm()}
        className="mt-3 rounded-[14px] border border-line px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-muted"
      >
        {label}
      </button>
    );
  }

  if (checking) {
    return <p className="mt-3 text-sm text-ink-soft">Checking your backups...</p>;
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      {hasLinks && (
        <p className="text-sm text-ink-soft">
          Links you sent from this browser can only be taken back from this browser. If any are still
          unclaimed, bring this account back here, not on another phone, to take them back.
        </p>
      )}
      {tier === "one-tap" ? (
        <p className="text-sm text-ink-soft">
          {many
            ? "Every account here is backed up, so each comes back with its own email and password. Remove them all from this browser?"
            : "You have a backup, so your account comes back with your email and password. Remove it here?"}
        </p>
      ) : (
        <>
          <p className="text-sm text-danger">
            {many
              ? "This removes every account on this browser. Any without a confirmed backup is gone for good, and nobody, including us, can undo it."
              : "This account has no confirmed backup. Removing it here ends your access to its money for good, and nobody, including us, can undo it."}
          </p>
          {unconfirmed.length > 0 && (
            <ul className="text-sm text-ink-soft">
              {unconfirmed.map((a) => (
                <li key={a} className="font-mono text-xs">
                  {shortAddress(a)}: no confirmed backup
                </li>
              ))}
            </ul>
          )}
          {claimMoney && (
            <p className="text-sm text-ink-soft">Money from a link you claimed is still on its way into your account here.</p>
          )}
          <label className="text-sm text-ink-soft">
            Type {CONFIRM_WORD} to confirm
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className="mt-1 w-full rounded-[14px] border border-line bg-surface px-3 py-3 text-ink outline-none"
            />
          </label>
        </>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!canGo || busy}
          onClick={run}
          className="rounded-[14px] border border-danger px-3 py-2 text-sm font-medium text-danger transition-opacity disabled:opacity-40"
        >
          {busy ? "Removing..." : many ? "Remove them all" : "Remove it"}
        </button>
        <button
          type="button"
          onClick={() => {
            setArming(false);
            setTyped("");
          }}
          className="rounded-[14px] px-3 py-2 text-sm text-ink-soft"
        >
          Keep it
        </button>
      </div>
    </div>
  );
}
