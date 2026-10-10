"use client";

/**
 * "Find my money with Face ID" — the whole restore, with nothing typed.
 *
 * Before this, coming back on a new phone meant an email, waiting for a 6-digit code, and a
 * password: three things to remember for a product whose entire promise is that there is nothing
 * to remember. Everything needed was already inside the passkey and simply went unread — the
 * account's own public key is the credential's user handle, and the PRF output both addresses the
 * backup and opens it (lib/wallet.tsx::findAccountWithFaceId).
 *
 * Two pieces of care in here:
 *
 * 1. The 404 copy. "No backup found" would be a lie dressed as a fact: it can equally mean the
 *    passkey was enrolled against a different host (a preview deployment), or that this device's
 *    authenticator returns a different PRF. So it says what we actually know and points at the
 *    path that does work.
 * 2. The lock step. A Face-ID restore lands at Phase 1, which means anyone holding the phone can
 *    spend — a downgrade from the Phase 2 the account had on the original device. Persisting at
 *    Phase 1 first is deliberate (a closed tab must never lose the restore), so the lock is
 *    offered immediately and skipping it is an explicit choice, not a default.
 * 3. The password it asks for. The backup Face ID opened may also hold a password copy, the one the
 *    email restore opens. The typed password is tried on it first (lib/lock.ts lockPasswordPlan):
 *    if it opens this account's backup it is the person's own existing password and is accepted
 *    even below the strength floor; if it does not, the account is locked with the new one and the
 *    person is told the email backup still opens with the old one, with the backup step right there.
 */
import { useEffect, useState } from "react";
import { ScanFace } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { isPlatformAuthenticatorAvailable } from "../../lib/passkey-prf";
import { passwordStrength } from "../../lib/password-strength";
import { shortAddress } from "../../lib/account-label";
import { boxOpensTo } from "../../lib/account-add";
import { lockPasswordPlan, OLD_BACKUP_PASSWORD_NOTE } from "../../lib/lock";
import type { PasswordCopy } from "../../lib/recovery";
import { MoneyCard } from "./MoneyCard";
import { PrimaryButton } from "./PrimaryButton";
import { RecoveryFlow } from "./RecoveryFlow";

type Step = "idle" | "finding" | "lock" | "done";

export function FindWithFaceId({
  onStart,
  onFound,
  onDone,
}: {
  /**
   * Told the moment the find starts. A page that shows this card only while it has NO account must
   * keep it mounted from here on: the find adds the account before it resolves, and a page that
   * swapped to its account view at that moment unmounted the lock step it was about to offer.
   */
  onStart?: () => void;
  /** Told the moment the money is found, before the lock step is offered. */
  onFound?: () => void;
  /** Told once the money is back AND the lock step is answered (locked, or "Not now"). */
  onDone?: () => void;
} = {}) {
  const { findAccountWithFaceId, lockWithPassword } = useWallet();
  const [capable, setCapable] = useState(false);
  const [step, setStep] = useState<Step>("idle");
  /** Did they actually lock it, or skip? The done screen asserts a safety property, so it must know. */
  const [locked, setLocked] = useState(false);
  const [found, setFound] = useState<{
    address: string;
    alreadyHere: boolean;
    hasPasswordCopy: boolean;
    passwordCopy: PasswordCopy | null;
  } | null>(null);
  /** Locked with a new password while the email backup still opens with the old one. */
  const [oldBackupPassword, setOldBackupPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void isPlatformAuthenticatorAvailable().then(setCapable);
  }, []);

  if (!capable) return null; // no biometric authenticator here — the email card below is the path

  async function find() {
    setError("");
    setStep("finding");
    onStart?.();
    try {
      const r = await findAccountWithFaceId();
      setFound(r);
      setStep("lock");
      onFound?.();
    } catch (e) {
      setError((e as Error).message);
      setStep("idle");
    }
  }

  async function lock() {
    const problem = passwordStrength(password);
    setBusy(true);
    setError("");
    try {
      // Does the typed password open this account's own email backup? Then it is theirs already.
      let opens: boolean | null = null;
      if (found?.passwordCopy) {
        const opened = await boxOpensTo({ formatVersion: 1, copies: [found.passwordCopy] }, password);
        opens = opened === found.address;
      }
      const plan = lockPasswordPlan(opens, problem.ok);
      if (plan === "too-weak") {
        setError(problem.reason ?? "Pick a stronger password.");
        return;
      }
      await lockWithPassword(password, { verified: plan === "lock-verified" });
      setPassword("");
      setLocked(true);
      setOldBackupPassword(plan === "lock-new-warn");
      setStep("done");
      // With the email backup still on the old password, the backup step is offered first: the
      // screens around this one move on when onDone fires, and would take the offer with them.
      if (plan !== "lock-new-warn") onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (step === "done") {
    /* "Not now" used to land here too, so someone who explicitly DECLINED the lock was told their
       money was locked and only their password could spend it. That is the worst sentence this app
       can produce: a safety property asserted about a phone that does not have it. The two
       outcomes now read differently, and the skipped one says plainly what is still true. */
    return (
      <MoneyCard className="p-5">
        {locked ? (
          <>
            <p className="font-semibold text-money">Locked to you on this phone.</p>
            <p className="mt-1 text-sm text-ink-soft">
              Your money is back, and only your password can spend it here.
            </p>
            {oldBackupPassword && (
              <div className="mt-3 border-t border-line pt-3">
                <p className="text-sm text-ink-soft">{OLD_BACKUP_PASSWORD_NOTE}</p>
                <div className="mt-3">
                  <RecoveryFlow mode="secure" onDone={() => onDone?.()} />
                </div>
                <button
                  type="button"
                  onClick={() => onDone?.()}
                  className="mt-2 text-sm text-ink-soft underline-offset-2 hover:underline"
                >
                  Not now
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="font-semibold text-money">Your money is back on this phone.</p>
            <p className="mt-1 text-sm text-ink-soft">
              It isn&apos;t locked yet, so anyone holding this phone could spend it. You can lock it
              any time from your Account.
            </p>
          </>
        )}
      </MoneyCard>
    );
  }

  if (step === "lock" && found) {
    return (
      <MoneyCard className="p-5">
        <p className="font-semibold text-ink">
          {found.alreadyHere ? "Your money was already here." : "Found it. Your money is back."}
        </p>
        <p className="mt-1 font-mono text-xs text-ink-soft">This is {shortAddress(found.address)}.</p>
        <p className="mt-3 text-sm text-ink-soft">
          Right now anyone holding this phone could spend it. Choose a password and only you can.
          {found.hasPasswordCopy ? " Use the same one you already had." : ""}
        </p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void lock();
          }}
          autoComplete="current-password"
          placeholder="Your password"
          aria-label="Password"
          className="mt-3 w-full rounded-[14px] border border-line bg-paper px-3 py-3 text-ink"
        />
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        <div className="mt-3 flex flex-col gap-2">
          <PrimaryButton loading={busy} loadingLabel="Locking…" onClick={lock}>
            Lock it to me
          </PrimaryButton>
          <button
            onClick={() => {
              setLocked(false);
              setStep("done");
              onDone?.();
            }}
            className="text-sm text-ink-soft underline-offset-2 hover:underline"
          >
            Not now
          </button>
        </div>
      </MoneyCard>
    );
  }

  return (
    <MoneyCard className="p-5">
      <p className="flex items-center gap-2 font-semibold text-ink">
        <ScanFace className="size-5 text-money" />
        Been here before?
      </p>
      <p className="mb-3 mt-1 text-sm text-ink-soft">
        If you backed up your money with Face ID, one tap brings it back. No email, no code, nothing
        to type.
      </p>
      <PrimaryButton loading={step === "finding"} loadingLabel="Looking…" onClick={find}>
        Find my money with Face ID
      </PrimaryButton>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </MoneyCard>
  );
}
