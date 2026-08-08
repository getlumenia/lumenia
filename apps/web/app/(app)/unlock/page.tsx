"use client";

/**
 * /unlock — a LOCAL decrypt gate (custody Phase 2), NOT authentication and
 * NOT a server session. It only appears when a Phase-2 (password-encrypted) blob
 * exists; Phase-1 users never see it. There is deliberately NO "forgot password?
 * contact us" link — that would be lying about what we can do (we can't: the server
 * holds only a blob it cannot open). Verifying the password decrypts the seed;
 * holding it for signing lands in Stage 5 (send).
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "../../../lib/wallet";
import { unlockPhase2 } from "../../../lib/keystore";
import { isPlatformAuthenticatorAvailable } from "../../../lib/passkey-prf";
import { PrimaryButton } from "../../../components/brand/PrimaryButton";

export default function UnlockPage() {
  const { status, account, setSessionSeed, unlockWithFaceId } = useWallet();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [faceCapable, setFaceCapable] = useState(false);
  const [faceBusy, setFaceBusy] = useState(false);
  const [showFace, setShowFace] = useState(false);

  useEffect(() => {
    void isPlatformAuthenticatorAvailable().then(setFaceCapable);
  }, []);

  if (status === "loading") {
    return <p className="py-10 text-center text-ink-soft">Loading…</p>;
  }
  // Nothing to unlock (no account, or not password-locked) → the app root.
  if (!account || account.phase !== 2) {
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
    setBusy(true);
    setError("");
    try {
      const { seed } = await unlockPhase2(password);
      setSessionSeed(seed); // hold in memory for the session (send needs to sign)
      router.replace(safeNext());
    } catch {
      setError("That password didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  /** Same destination as the password path — only the way in differs. */
  async function unlockFace() {
    setFaceBusy(true);
    setError("");
    try {
      await unlockWithFaceId();
      router.replace(safeNext());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFaceBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 py-10">
      <header className="text-center">
        <h1 className="text-xl font-bold text-ink">Unlock your money</h1>
        <p className="mt-1 text-sm text-ink-soft">Enter the password you chose on this phone.</p>
      </header>
      <input
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
