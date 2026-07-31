"use client";

/**
 * /pilot — ask to be an early mainnet pilot user.
 *
 * Honest by construction: it says out loud that this is an early preview, not reviewed by an
 * outside security firm, and capped at $1 per transfer. It also ENFORCES the safety rule the
 * pilot depends on before it will let you ask in: your money must be locked to a password
 * (Phase 2), Face ID optional — a pilot user's real money must never sit under a device key
 * anyone holding the phone could spend.
 *
 * The lock/backup step is the real RecoveryFlow (password + Face ID passkey + a portable
 * server-stored backup, all in one) — the passkey is registered right here, not on a detour.
 * A Phase-1 account sees that flow; once it becomes Phase 2 the ask-to-join form appears.
 *
 * It moves no money and keeps no server-side join: it posts the pubkey (read from the wallet,
 * never typed) + a contact email to /pilot-request, which emails the owner, who approves the
 * wallet by hand with the pilot CLI.
 */
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "../../../lib/wallet";
import { PrimaryButton } from "../../../components/brand/PrimaryButton";
import { MoneyCard } from "../../../components/brand/MoneyCard";
import { RecoveryFlow } from "../../../components/brand/RecoveryFlow";
import { mainnetConfig } from "../../../lib/network";

const SPONSOR_URL = process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";

export default function PilotPage() {
  const { status, account } = useWallet();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;
  if (!account) {
    if (typeof window !== "undefined") router.replace("/home");
    return null;
  }

  const lockedToYou = account.phase === 2;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!lockedToYou) return;
    setBusy(true);
    setError("");
    try {
      // The pilot allowlist lives on the MAINNET worker, so join requests must go there (same
      // namespace the owner approves in). Falls back to the default sponsor only if mainnet
      // isn't configured for this deployment yet.
      const target = mainnetConfig()?.sponsorUrl ?? SPONSOR_URL;
      const res = await fetch(`${target}/pilot-request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pubkey: account!.address, email }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Please try again.");
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4 py-8">
        <h1 className="text-xl font-bold text-ink">Request sent</h1>
        <p className="text-ink-soft">
          We got it. We turn the pilot on for each account by hand, and we&apos;ll email you when
          yours is ready. Thank you for helping test it.
        </p>
        <Link href="/home" className="text-sm text-money underline-offset-2 hover:underline">
          Back home
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 py-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Be an early pilot user</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Lumenia is in a pilot. If you&apos;d like to be among the first to use it with real
          money and help us make it better, ask to join here. Be honest with yourself about what
          that means: it&apos;s an early preview, not yet reviewed by an outside security firm, so
          keep amounts tiny. The pilot caps every transfer at $1.
        </p>
      </header>

      {!lockedToYou ? (
        <MoneyCard className="p-5">
          <p className="font-semibold text-ink">First, secure your account</p>
          <p className="mt-1 text-sm text-ink-soft">
            The pilot moves real money, so before you can join, lock it to a password (and Face ID,
            if your phone offers it). This same step also backs your money up, so a new phone can
            bring it back with your email and password.
          </p>
          <div className="mt-4">
            <RecoveryFlow mode="secure" />
          </div>
        </MoneyCard>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <p className="text-sm text-money">Your money is locked and backed up. One more step.</p>
          <label className="text-sm text-ink-soft">
            Your email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="mt-1 w-full rounded-[14px] border border-line bg-surface px-3 py-3 text-ink outline-none"
            />
          </label>
          <p className="text-xs text-ink-soft">
            You&apos;d join with this account:
            <br />
            <span className="break-all font-mono">{account.address}</span>
          </p>
          {error && <p className="text-sm text-danger">{error}</p>}
          <PrimaryButton loading={busy} loadingLabel="Sending…">
            Ask to join the pilot
          </PrimaryButton>
        </form>
      )}
    </div>
  );
}
