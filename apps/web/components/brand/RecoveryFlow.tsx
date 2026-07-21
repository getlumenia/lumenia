"use client";

/**
 * RecoveryFlow — "Back up your money" (secure) / "Restore my money" (restore),
 * RECOVERY_ARCHITECTURE §12 step 4. Value-first + vocabulary-clean: money + people,
 * "your password", "your email" — never wallet/crypto/seed jargon. The seed never leaves
 * lib/wallet.tsx + lib/recovery.ts; this component only moves an email, a one-time code,
 * a password (never stored or sent raw), and ciphertext. Warm-paper (app) styling.
 *
 * Flow: email → 6-digit code (emailed) → password → done. On restore the fetched box is
 * cached, so a wrong password retries without a fresh code. Argon2id params are the
 * provisional DEFAULT_ARGON, tuned later from the on-device Spike #3 measurement.
 */
import { useState } from "react";
import { PrimaryButton } from "./PrimaryButton";
import { useWallet } from "../../lib/wallet";
import { requestRecoveryOtp, storeRecoveryBox, fetchRecoveryBox } from "../../lib/recovery-api";
import type { RecoveryBox } from "../../lib/recovery";

const field = "w-full rounded-[14px] border border-line bg-paper px-3 py-3 text-[16px] text-ink";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function RecoveryFlow({ mode }: { mode: "secure" | "restore" }) {
  const { secureRecovery, restoreRecovery } = useWallet();
  const secure = mode === "secure";
  const [step, setStep] = useState<"start" | "code" | "done">("start");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fetched, setFetched] = useState<RecoveryBox | null>(null);

  const emailOk = EMAIL_RE.test(email.trim());
  const codeOk = /^\d{6}$/.test(code.trim());
  const pwOk = password.length >= 6;

  async function sendCode() {
    setError("");
    setBusy(true);
    try {
      await requestRecoveryOtp(email.trim());
      setStep("code");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setError("");
    setBusy(true);
    try {
      if (secure) {
        const box = await secureRecovery(password);
        await storeRecoveryBox(email.trim(), code.trim(), box);
      } else {
        let box = fetched;
        if (!box) {
          box = await fetchRecoveryBox(email.trim(), code.trim());
          if (!box) throw new Error("No backup was found for that email.");
          setFetched(box); // cache so a wrong password retries without a fresh code
        }
        await restoreRecovery(box, password);
      }
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (step === "done") {
    return (
      <p className="text-sm font-medium text-money">
        {secure
          ? "Your money is backed up. On a new phone, your email and password bring it back."
          : "Welcome back — your money is here."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {step === "start" ? (
        <>
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            aria-label="Your email"
            placeholder="Your email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={field}
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          <PrimaryButton loading={busy} loadingLabel="Sending…" onClick={sendCode} disabled={!emailOk}>
            Send me a code
          </PrimaryButton>
        </>
      ) : (
        <>
          <p className="text-xs text-ink-soft">We sent a 6-digit code to {email.trim()}.</p>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label="6-digit code"
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className={field}
          />
          <input
            type="password"
            autoComplete={secure ? "new-password" : "current-password"}
            aria-label={secure ? "Choose a password" : "Your password"}
            placeholder={secure ? "Choose a password" : "Your password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={field}
          />
          {secure && (
            <p className="text-xs text-ink-soft">
              Remember it — it can&apos;t be reset. It is the only key to your money.
            </p>
          )}
          {error && <p className="text-sm text-danger">{error}</p>}
          <PrimaryButton loading={busy} loadingLabel="Working…" onClick={finish} disabled={!codeOk || !pwOk}>
            {secure ? "Back up my money" : "Restore my money"}
          </PrimaryButton>
          <button
            type="button"
            onClick={sendCode}
            disabled={busy}
            className="text-xs text-ink-soft underline-offset-2 hover:underline"
          >
            Resend the code
          </button>
        </>
      )}
    </div>
  );
}
