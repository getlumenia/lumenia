"use client";

/**
 * LockMoneyCard — Phase 2 "lock this money to you" (FRONTEND_PLAN §2). Client-side
 * only: unwrap the Phase-1 seed, then re-wrap it with a password-derived Argon2id
 * KEK (savePhase2). The server never sees the password or the seed. The honest
 * sentence is shown VERBATIM at password creation — softening it would be
 * overclaiming in reverse.
 *
 * Argon2id params are the provisional DEFAULT_ARGON, to be tuned from the deferred
 * on-device spike measurement.
 */
import { useState } from "react";
import { MoneyCard } from "./MoneyCard";
import { PrimaryButton } from "./PrimaryButton";
import { unlockPhase1, savePhase2 } from "../../lib/keystore";
import { DEFAULT_ARGON } from "../../lib/argon";
import { copy } from "../../lib/copy";
import { useWallet } from "../../lib/wallet";

export function LockMoneyCard() {
  const { account, refresh, setSessionSeed } = useWallet();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!account || account.phase !== 1) return null; // only offer it to unlocked (Phase 1) accounts

  async function lock() {
    if (password.length < 6) {
      setError("Choose a password of at least 6 characters.");
      return;
    }
    setBusy(true);
    setError("");
    let seed: Uint8Array | null = null;
    try {
      seed = await unlockPhase1();
      await savePhase2(account!.address, seed, password, DEFAULT_ARGON);
      // Seed the session with a COPY before the finally-wipe below zeroes ours:
      // whoever just chose a password has proven they hold it — making them retype
      // it immediately (the old behaviour) was a bug, not security.
      setSessionSeed(seed.slice());
      await refresh();
    } catch {
      setError("We couldn't lock it. Please try again.");
    } finally {
      seed?.fill(0);
      setBusy(false);
    }
  }

  return (
    <MoneyCard className="p-5">
      <p className="font-semibold text-ink">{copy.lock.title}</p>
      <p className="mt-1 text-sm text-ink-soft">{copy.lock.body}</p>
      <input
        type="password"
        inputMode="text"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Choose a password"
        className="mt-3 w-full rounded-[14px] border border-line bg-paper px-3 py-3 text-ink"
      />
      <p className="mt-2 text-xs text-ink-soft">
        If you forget this password, nobody can recover this money, Lumenia included.
      </p>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-3">
        <PrimaryButton loading={busy} loadingLabel="Locking…" onClick={lock}>
          {copy.lock.cta}
        </PrimaryButton>
      </div>
    </MoneyCard>
  );
}
