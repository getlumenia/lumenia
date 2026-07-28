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
 */
import { useEffect, useState } from "react";
import { ScanFace } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { isPlatformAuthenticatorAvailable } from "../../lib/passkey-prf";
import { passwordStrength } from "../../lib/password-strength";
import { MoneyCard } from "./MoneyCard";
import { PrimaryButton } from "./PrimaryButton";

type Step = "idle" | "finding" | "lock" | "done";

export function FindWithFaceId() {
  const { findAccountWithFaceId, lockWithPassword } = useWallet();
  const [capable, setCapable] = useState(false);
  const [step, setStep] = useState<Step>("idle");
  const [found, setFound] = useState<{ address: string; alreadyHere: boolean; hasPasswordCopy: boolean } | null>(null);
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
    try {
      const r = await findAccountWithFaceId();
      setFound(r);
      setStep("lock");
    } catch (e) {
      setError((e as Error).message);
      setStep("idle");
    }
  }

  async function lock() {
    const problem = passwordStrength(password);
    if (!problem.ok) return setError(problem.reason ?? "Pick a stronger password.");
    setBusy(true);
    setError("");
    try {
      await lockWithPassword(password);
      setPassword("");
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (step === "done") {
    return (
      <MoneyCard className="p-5">
        <p className="font-semibold text-money">Locked to you on this phone.</p>
        <p className="mt-1 text-sm text-ink-soft">
          Your money is back and only your password can spend it here.
        </p>
      </MoneyCard>
    );
  }

  if (step === "lock" && found) {
    return (
      <MoneyCard className="p-5">
        <p className="font-semibold text-ink">
          {found.alreadyHere ? "Your money was already here." : "Found it. Your money is back."}
        </p>
        <p className="mt-1 break-all font-mono text-xs text-ink-soft">{found.address}</p>
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
            onClick={() => setStep("done")}
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
