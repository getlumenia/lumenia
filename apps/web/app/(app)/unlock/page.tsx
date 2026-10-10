"use client";

/**
 * /unlock — a LOCAL decrypt gate (custody Phase 2), NOT authentication and
 * NOT a server session. It only appears when a Phase-2 (password-encrypted) blob
 * exists; Phase-1 users never see it. There is deliberately NO "forgot password?
 * contact us" link — that would be lying about what we can do (we can't: the server
 * holds only a blob it cannot open). Verifying the password decrypts the seed;
 * holding it for signing lands in Stage 5 (send).
 *
 * AFTER A FACE ID UNLOCK, a new password. "Forgot your password?" opens the money with Face ID, and
 * used to stop there: the forgotten password still locked this phone the next time, and still
 * sealed the email backup, so the email restore it promises would ask for a password nobody knew.
 * So the unlock is followed by an offer to set a new password (lockWithPassword, on the session key
 * Face ID just opened) and then to back up again, which re-seals the email backup under it.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "../../../lib/wallet";
import { unlockPhase2 } from "../../../lib/keystore";
import { isPlatformAuthenticatorAvailable } from "../../../lib/passkey-prf";
import { PrimaryButton } from "../../../components/brand/PrimaryButton";
import { RecoveryFlow } from "../../../components/brand/RecoveryFlow";
import { passwordStrength } from "../../../lib/password-strength";
import { backupRecord } from "../../../lib/backup-record";

export default function UnlockPage() {
  const { status, account, setSessionSeed, unlockWithFaceId, lockWithPassword } = useWallet();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [faceCapable, setFaceCapable] = useState(false);
  const [faceBusy, setFaceBusy] = useState(false);
  const [showFace, setShowFace] = useState(false);
  /** Face ID opened it: offer a new password, then a new backup, before moving on. */
  const [renew, setRenew] = useState<"offer" | "backup" | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => {
    void isPlatformAuthenticatorAvailable().then(setFaceCapable);
  }, []);

  if (status === "loading") {
    return <p className="py-10 text-center text-ink-soft">Loading…</p>;
  }
  // Nothing to unlock (no account, or not password-locked) → the app root.
  if (!account || (account.phase !== 2 && renew === null)) {
    if (typeof window !== "undefined") router.replace("/home");
    return null;
  }

  /**
   * Where to land after unlocking. `startsWith("/")` is not enough: `//evil.com` and `/\evil.com`
   * both start with a slash and both are protocol-relative URLs browsers happily leave the site
   * for. This is the worst page to get that wrong on — the user has just typed the password that
   * unlocks their money, so a redirect to a lookalike is a ready-made phishing handoff.
   */
  function safeNext(): string {
    const next = new URLSearchParams(window.location.search).get("next");
    if (!next || !/^\/[A-Za-z0-9\-._~/?#[\]@!$&'()*+,;=%]*$/.test(next)) return "/home";
    if (next.startsWith("//") || next.startsWith("/\\")) return "/home";
    return next;
  }

  async function unlock() {
    /* Read the field, not just the state. A password manager that writes the input's value
       directly — without dispatching the event React listens for — leaves `password` empty while
       the box looks full, and the console showed exactly that ("Password must be specified"). The
       user then gets told their password is wrong about a field they can see is filled. */
    const typed = password || inputRef.current?.value || "";
    if (!typed) {
      setError("Enter your password to unlock.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { seed } = await unlockPhase2(typed);
      setSessionSeed(seed); // hold in memory for the session (send needs to sign)
      seed.fill(0); // the session keeps its own copy (lib/wallet.tsx setSessionSeed)
      router.replace(safeNext());
    } catch (e) {
      /* Four very different failures used to arrive here and all four were reported as "that
       * password didn't work": no locked record on this device, a keystore read that failed, the
       * Argon2 derivation failing (it wants 48 MiB of WASM, which a memory-tight webview can
       * refuse), and the actual wrong password. Telling someone their correct password is wrong is
       * the worst of those to get wrong — they retype it, it fails again, and they conclude their
       * money is gone. Only a failed DECRYPT is evidence about the password; everything else is
       * evidence about the device. */
      console.error("[unlock]", e);
      const err = e as { name?: string; message?: string };
      if (err.message?.includes("no phase-2 key")) {
        setError("This device doesn't have a password-locked account. Bring your money back with your email or Face ID.");
      } else if (err.name === "OperationError") {
        setError("That password didn't work. Try again.");
      } else {
        setError("We couldn't check your password on this phone just now. Try again, or use Face ID if you set it up.");
      }
    } finally {
      setBusy(false);
    }
  }

  /** Same destination as the password path: only the way in differs, and a new password is offered first. */
  async function unlockFace() {
    setFaceBusy(true);
    setError("");
    try {
      await unlockWithFaceId();
      setRenew("offer");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFaceBusy(false);
    }
  }

  async function setNew() {
    const strong = passwordStrength(newPassword);
    if (!strong.ok) return setError(strong.reason ?? "Pick a stronger password.");
    if (newPassword !== confirmPassword) return setError("Those two don't match.");
    setBusy(true);
    setError("");
    try {
      await lockWithPassword(newPassword);
      setNewPassword("");
      setConfirmPassword("");
      setRenew("backup");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (renew) {
    return (
      <div className="flex flex-col gap-4 py-10">
        <header className="text-center">
          <h1 className="text-xl font-bold text-ink">{renew === "offer" ? "You're in with Face ID" : "Back it up again"}</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {renew === "offer"
              ? "Your old password still locks this phone and still opens your email backup. If you forgot it, set a new one now."
              : "Your email backup still opens with the old password. Back up again with the new one, so your email brings this money back."}
          </p>
        </header>
        {renew === "offer" ? (
          <>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Choose a new password"
              aria-label="Choose a new password"
              className="w-full rounded-[14px] border border-line bg-surface px-3 py-3 text-ink"
            />
            <input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Type it again"
              aria-label="Type the new password again"
              className="w-full rounded-[14px] border border-line bg-surface px-3 py-3 text-ink"
            />
            {error && <p className="text-sm text-danger">{error}</p>}
            <PrimaryButton loading={busy} loadingLabel="Setting it..." onClick={setNew}>
              Set a new password
            </PrimaryButton>
          </>
        ) : (
          <RecoveryFlow mode="secure" initialEmail={backupRecord(account.address)?.email ?? undefined} />
        )}
        <button onClick={() => router.replace(safeNext())} className="text-sm text-ink-soft underline-offset-2 hover:underline">
          {renew === "offer" ? "Not now" : "Continue"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-10">
      <header className="text-center">
        <h1 className="text-xl font-bold text-ink">Unlock your money</h1>
        <p className="mt-1 text-sm text-ink-soft">Enter the password you chose on this phone.</p>
      </header>
      <input
        ref={inputRef}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Your password"
        className="w-full rounded-[14px] border border-line bg-surface px-3 py-3 text-ink"
        onKeyDown={(e) => {
          if (e.key === "Enter") void unlock();
        }}
      />
      {error && <p className="text-sm text-danger">{error}</p>}
      <PrimaryButton loading={busy} loadingLabel="Unlocking…" onClick={unlock}>
        Unlock
      </PrimaryButton>

      {/* Face ID as the SECONDARY way in, never the primary button.
          It grants nothing new — whoever can pass Face ID on this phone could already clear the
          site's data and restore from the no-account screen. What it removes is a speed bump, and
          that is a real trade: better against somebody reading your password over your shoulder,
          worse against somebody who can hold the phone to your face. So it stays behind a
          deliberate tap and says what it does, rather than sitting there inviting the easy path. */}
      {faceCapable && (
        <div className="text-center">
          {showFace ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-ink-soft">
                Face ID can open it instead, using the backup you made. Your password still works,
                and it stays the way this phone locks.
              </p>
              <button
                onClick={unlockFace}
                disabled={faceBusy}
                className="mx-auto h-10 rounded-full border border-money px-5 text-sm font-medium text-money disabled:opacity-50"
              >
                {faceBusy ? "Checking…" : "Use Face ID"}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowFace(true)}
              className="text-xs text-ink-soft underline-offset-2 hover:underline"
            >
              Forgot your password?
            </button>
          )}
        </div>
      )}

      <p className="text-center text-xs text-ink-soft">
        Only this phone can unlock it. There's no password reset, and that's what keeps it yours.
      </p>
    </div>
  );
}
