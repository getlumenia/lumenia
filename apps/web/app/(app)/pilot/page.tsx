"use client";

/**
 * /pilot — ask to be an early mainnet pilot user.
 *
 * Honest by construction: it says out loud that this is an early preview, not reviewed by an
 * outside security firm, and capped per transfer at the configured pilot cap ($5 today, via
 * `NEXT_PUBLIC_PILOT_TX_CAP_USD` — see PILOT_TX_CAP_USD below). It also ENFORCES the safety rule the
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
import { PilotStatusBadge } from "../../../components/brand/PilotStatusBadge";
import { mainnetConfig } from "../../../lib/network";
import { hasBackup } from "../../../lib/recovery-api";

const SPONSOR_URL = process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";

/**
 * The per-transfer cap this page PROMISES, which must equal MAX_DROP_USDC on the mainnet Worker.
 * It read "$1" here while the Worker enforced 5 — the page was describing a protection the user
 * did not actually have. The number lives in one named constant so the next drift is a one-line
 * fix, and `NEXT_PUBLIC_PILOT_TX_CAP_USD` lets a deploy override it without a code change.
 * Raising the Worker's cap without raising this is a promise broken, so change both together.
 */
const PILOT_TX_CAP_USD = process.env.NEXT_PUBLIC_PILOT_TX_CAP_USD ?? "5";

export default function PilotPage() {
  const { status, account } = useWallet();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"form" | "received" | "already">("form");
  const [error, setError] = useState("");

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;
  if (!account) {
    if (typeof window !== "undefined") router.replace("/home");
    return null;
  }

  /* The pilot's stated precondition is that real money never sits under a device-only key AND that
     it can be brought back. Reading `phase === 2` alone let someone who locked via /home skip the
     backup step entirely, and then told them they had one. */
  const lockedToYou = account.phase === 2 && hasBackup(account.address);

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
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; already?: boolean; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Please try again.");
      // Task 1 is idempotent: a repeat ask for the same account returns { already: true } instead of
      // a fresh submission — reassure the user rather than pretend it was newly sent.
      setView(body.already ? "already" : "received");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (view === "already") {
    return (
      <div className="flex flex-col gap-4 py-8">
        <h1 className="text-xl font-bold text-ink">You&apos;ve already asked to join</h1>
        <p className="text-ink-soft">
          We&apos;ve got your request for this account — no need to send it again. We&apos;ll email
          you the moment your spot opens.
        </p>
        <PilotStatusBadge />
        <Link href="/home" className="text-sm text-money underline-offset-2 hover:underline">
          Back home
        </Link>
      </div>
    );
  }

  if (view === "received") {
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
          keep amounts tiny. The pilot caps every transfer at ${PILOT_TX_CAP_USD}.
        </p>
        {/* Said BEFORE they opt in, not after. An earlier draft of this said conversion was "not
            possible yet", which was wrong and contradicted our own /cash-out page: the route works
            and has been walked end to end with real money. What is true is that the last leg happens
            in the user's own exchange account rather than in here, and knowing that up front is the
            difference between a workable extra step and an unpleasant surprise. */}
        <p className="mt-3 text-sm text-ink-soft">
          One thing to know up front: dollars reach you here, but the last leg into Turkish lira
          happens <strong className="text-ink">in your own exchange account, not inside Lumenia</strong>.
          The route works and we have walked it with real money.{" "}
          <Link href="/cash-out" className="text-money underline-offset-2 hover:underline">
            See the route
          </Link>{" "}
          before you join, so the extra step is something you chose rather than something you found out later.
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
