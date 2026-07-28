"use client";

/**
 * /unlock — a LOCAL decrypt gate (custody Phase 2), NOT authentication and
 * NOT a server session. It only appears when a Phase-2 (password-encrypted) blob
 * exists; Phase-1 users never see it. There is deliberately NO "forgot password?
 * contact us" link — that would be lying about what we can do (we can't: the server
 * holds only a blob it cannot open). Verifying the password decrypts the seed;
 * holding it for signing lands in Stage 5 (send).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "../../../lib/wallet";
import { unlockPhase2 } from "../../../lib/keystore";
import { PrimaryButton } from "../../../components/brand/PrimaryButton";

export default function UnlockPage() {
  const { status, account, setSessionSeed } = useWallet();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (status === "loading") {
    return <p className="py-10 text-center text-ink-soft">Loading…</p>;
  }
  // Nothing to unlock (no account, or not password-locked) → the app root.
  if (!account || account.phase !== 2) {
    if (typeof window !== "undefined") router.replace("/home");
    return null;
  }

  async function unlock() {
    setBusy(true);
    setError("");
    try {
      const { seed } = await unlockPhase2(password);
      setSessionSeed(seed); // hold in memory for the session (send needs to sign)
      const next = new URLSearchParams(window.location.search).get("next");
      router.replace(next && next.startsWith("/") ? next : "/home");
    } catch {
      setError("That password didn't work. Try again.");
    } finally {
      setBusy(false);
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
      <p className="text-center text-xs text-ink-soft">
        Only this phone can unlock it. There's no password reset, and that's what keeps it yours.
      </p>
    </div>
  );
}
