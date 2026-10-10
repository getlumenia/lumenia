"use client";

/**
 * /pilot: ask to be an early real-money user, for THIS account.
 *
 * Honest by construction: in both of its states it shows the real-money warning verbatim (an early
 * pilot, not reviewed by an outside security firm, you can lose money, keep amounts small:
 * lib/real-money.ts, decision D1) and then the pilot's caps (per link, per sender per day, and for
 * the whole pilot per day, the mainnet Worker's own numbers). It also ENFORCES the safety rule the
 * pilot depends on before it will let you ask in: your money must be locked to a password and
 * backed up, so a pilot user's real money never sits under a device key anyone holding the phone
 * could spend.
 *
 * WHERE THIS ACCOUNT STANDS COMES FIRST (LUMENIA ACCOUNT CONTRACT v1, sections 4 and 5.1). The page
 * used to show the same ask-to-join form to everybody, so an account that was waiting, declined or
 * already approved was invited to ask again, and a person with an account here and another in the
 * extension could not tell which one any of it was about. Now the page reads the wallet's standing
 * (the same table and the same words as the extension) and names the account by its short address
 * and backup email: only "none" gets the ask, "no-sends" gets "Ask for more sends", "pending" gets
 * "Check again", and a declined or revoked account is told so plainly.
 *
 * THE ASK IS SIGNED BY THE ACCOUNT IT IS FOR (lib/pilot-ask.ts). The request used to be an unsigned
 * public key and a typed email, so anybody could file one for any key, and an email another wallet
 * had used was dropped without a word. It now carries the account's own signature, and the email is
 * proven: by the backup it already protects for this account, or by a 6-digit code the server asks
 * for when it cannot tell. The email comes from this account's backup record, read-only unless the
 * person chooses another one. Every refusal shows the server's own sentence.
 *
 * It moves no money. The owner approves each account by hand with the pilot CLI or the owner email.
 */
import { useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "../../../lib/wallet";
import { PrimaryButton } from "../../../components/brand/PrimaryButton";
import { MoneyCard } from "../../../components/brand/MoneyCard";
import { RecoveryFlow } from "../../../components/brand/RecoveryFlow";
import { PilotStatusBadge } from "../../../components/brand/PilotStatusBadge";
import { hasBackup, backupRecord } from "../../../lib/backup-record";
import { accountLine, maskEmail, shortAddress } from "../../../lib/account-label";
import { checkedAgo, standingCopy } from "../../../lib/pilot-access";
import {
  ASK_COPY,
  alsoAskedLine,
  askResultCopy,
  askToJoin,
  askView,
  pilotHost,
  requestPilotCode,
  settleAsk,
  type AskResult,
  type AskView,
} from "../../../lib/pilot-ask";
import { isNeedsPassword } from "../../../lib/signer-error";
import { REAL_MONEY_WARNING, pilotCapsSentence } from "../../../lib/real-money";

/*
 * The caps this page PROMISES must equal the mainnet Worker's. The per-transfer one read "$1" here
 * while the Worker enforced 5: the page was describing a protection the user did not actually have.
 * The numbers now live in lib/real-money.ts, one env var each, so raising a Worker cap is one change
 * there, made together with the Worker's.
 */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const quiet = "text-sm font-medium text-money underline-offset-2 hover:underline disabled:opacity-50";
const pill = "inline-flex h-10 items-center rounded-full border border-line px-4 text-sm font-medium text-ink-soft";

/** What an accepted ask showed, kept so the result screen can name the account and the email. */
interface Asked {
  view: Exclude<AskView, "standing">;
  email: string;
  also?: string;
}

/** The warning, the caps, and the one thing to know about cashing out: said BEFORE anyone asks. */
function PilotHeader() {
  return (
    <header>
      <h1 className="text-xl font-bold text-ink">Be an early pilot user</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Lumenia is in a pilot. If you&apos;d like to be among the first to use it with real money and
        help us make it better, ask to join here. Be honest with yourself about what that means:
      </p>
      <p className="mt-2 text-sm font-medium text-ink">{REAL_MONEY_WARNING}</p>
      <p className="mt-2 text-sm text-ink-soft">{pilotCapsSentence()}</p>
      {/* Said BEFORE they opt in, not after. An earlier draft of this said conversion was "not
          possible yet", which was wrong and contradicted our own /cash-out page: the route works and
          has been walked end to end with real money. What is true is that the last leg happens in
          the user's own exchange account rather than in here, and knowing that up front is the
          difference between a workable extra step and an unpleasant surprise. */}
      <p className="mt-3 text-sm text-ink-soft">
        One thing to know up front: dollars reach you here, but the last leg into Turkish lira happens{" "}
        <strong className="text-ink">in your own exchange account, not inside Lumenia</strong>. The route
        works and we have walked it with real money.{" "}
        <Link href="/cash-out" className="text-money underline-offset-2 hover:underline">
          See the route
        </Link>{" "}
        before you join, so the extra step is something you chose rather than something you found out later.
      </p>
    </header>
  );
}

export default function PilotPage() {
  const {
    status,
    account,
    network,
    pilotStanding,
    pilotUsed,
    pilotLimit,
    pilotStale,
    pilotCheckedAt,
    recheckPilot,
    switchNetwork,
  } = useWallet();
  const router = useRouter();
  const [asked, setAsked] = useState<Asked | null>(null);

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;
  if (!account) {
    if (typeof window !== "undefined") router.replace("/home");
    return null;
  }

  const short = shortAddress(account.address);
  const record = backupRecord(account.address);
  /* The pilot's stated precondition is that real money never sits under a device-only key AND that
     it can be brought back. Reading `phase === 2` alone let someone who locked via /home skip the
     backup step entirely, and then told them they had one. */
  const lockedToYou = account.phase === 2 && hasBackup(account.address);
  const left = pilotLimit !== null && pilotUsed !== null ? Math.max(0, pilotLimit - pilotUsed) : null;
  const words = standingCopy(pilotStanding, { short, left, limit: pilotLimit });
  const onMainnet = network === "public";

  /* The pilot is retired (SOW 2, D3 item i): the mainnet sponsor admits every wallet. The ask
     would go nowhere, so this screen turns into the switch, with the same honest sentences, and
     keeps the pilot's one precondition: locked with a password and backed up, first. */
  if (pilotStanding === "open") {
    return (
      <div className="flex flex-col gap-4 py-8">
        <h1 className="text-xl font-bold text-ink">Real money is open to everyone</h1>
        <p className="text-ink-soft">No invite needed any more.</p>
        <p className="text-ink-soft">{REAL_MONEY_WARNING}</p>
        <p className="text-ink-soft">{pilotCapsSentence()}</p>
        {lockedToYou ? (
          <PilotStatusBadge />
        ) : (
          <MoneyCard className="p-5">
            <p className="font-semibold text-ink">First, secure your account</p>
            <p className="mt-1 text-sm text-ink-soft">
              Real money never sits under a key that anyone holding this phone could use. Lock it
              with a password (and Face ID, if your phone offers it); the same step backs it up, so a
              new phone can bring it back with your email and password.
            </p>
            <div className="mt-4">
              <RecoveryFlow mode="secure" initialEmail={record?.email ?? undefined} />
            </div>
          </MoneyCard>
        )}
        <Link href="/home" className="text-sm text-money underline-offset-2 hover:underline">
          Back home
        </Link>
      </div>
    );
  }

  if (asked) {
    const result = askResultCopy(asked.view, { short, masked: maskEmail(asked.email) });
    return (
      <div className="flex flex-col gap-4 py-8">
        <h1 className="text-xl font-bold text-ink">{result.title}</h1>
        <p className="text-ink-soft">{result.line}</p>
        {asked.also && <p className="text-sm text-ink-soft">{alsoAskedLine(asked.also)}</p>}
        <Link href="/home" className="text-sm text-money underline-offset-2 hover:underline">
          Back home
        </Link>
      </div>
    );
  }

  /** The standing's own card: its title, its line, and the one action it may carry. */
  const standingCard = (action: ReactNode) => (
    <MoneyCard className="p-5">
      <p className="font-semibold text-ink">{words.title}</p>
      {words.line && <p className="mt-1 text-sm text-ink-soft">{words.line}</p>}
      {pilotStale && pilotCheckedAt !== null && <p className="mt-1 text-xs text-ink-soft">{checkedAgo(pilotCheckedAt)}</p>}
      {action && <div className="mt-4 flex flex-wrap gap-2">{action}</div>}
    </MoneyCard>
  );

  const onAsked = (r: Extract<AskResult, { ok: true }>, email: string, moreSends: boolean) => {
    recheckPilot();
    const view = askView(r, moreSends);
    // An answer that is a standing (approved with sends left, declined) is shown by the standing.
    if (view !== "standing") setAsked({ view, email, ...(r.emailAlsoFor ? { also: r.emailAlsoFor } : {}) });
  };

  return (
    <div className="flex flex-col gap-5 py-4">
      <PilotHeader />
      {/* WHICH account this page is about, and which email backs it up (contract 5.3). */}
      <p className="font-mono text-xs text-ink-soft">{accountLine(account.address, record).text}</p>

      {pilotStanding === "checking" && <p className="text-sm text-ink-soft">{words.title}</p>}

      {pilotStanding === "unknown" &&
        standingCard(
          <button type="button" onClick={recheckPilot} className={pill}>
            {words.action}
          </button>,
        )}

      {pilotStanding === "pending" &&
        standingCard(
          <button type="button" onClick={recheckPilot} className={pill}>
            {words.action}
          </button>,
        )}

      {pilotStanding === "approved" &&
        standingCard(
          onMainnet ? null : (
            <button
              type="button"
              onClick={() => switchNetwork("public")}
              className="h-10 rounded-full border border-money bg-money px-4 text-sm font-medium text-primary-foreground"
            >
              {words.action}
            </button>
          ),
        )}

      {(pilotStanding === "declined" || pilotStanding === "revoked") && standingCard(null)}

      {pilotStanding === "no-sends" && (
        <>
          {standingCard(null)}
          <AskForm moreSends ready onAsked={onAsked} />
        </>
      )}

      {pilotStanding === "none" && (
        <>
          {/* BOTH HALVES OF THE ASK, AT ONCE.
              These used to swap: the email field did not exist until the account was locked and
              backed up, so somebody set a password without ever seeing what it was for, and then met
              a second request they had not been told about. The security step is still required and
              still first on the page, but nothing about the ask is hidden while it is being done. */}
          {!lockedToYou && (
            <MoneyCard className="p-5">
              <p className="font-semibold text-ink">1. Secure your account</p>
              <p className="mt-1 text-sm text-ink-soft">
                The pilot moves real money, so before you can join, lock it to a password (and Face ID,
                if your phone offers it). This same step also backs your money up, so a new phone can
                bring it back with your email and password.
              </p>
              <div className="mt-4">
                <RecoveryFlow mode="secure" initialEmail={record?.email ?? undefined} />
              </div>
            </MoneyCard>
          )}
          {standingCard(null)}
          <AskForm moreSends={false} ready={lockedToYou} onAsked={onAsked} />
        </>
      )}

      <p className="text-xs text-ink-soft">{ASK_COPY.extensionNote}</p>
    </div>
  );
}

/**
 * The ask itself: the account's backup email (or one typed), a code when the server asks for one,
 * and the account's signature. `ready` is the pilot's precondition (locked and backed up); the
 * button names the outstanding step instead of being a dead control.
 */
function AskForm({
  moreSends,
  ready,
  onAsked,
}: {
  moreSends: boolean;
  ready: boolean;
  onAsked: (r: Extract<AskResult, { ok: true }>, email: string, moreSends: boolean) => void;
}) {
  const { account, getSigner } = useWallet();
  const router = useRouter();
  /** null: use the account's recorded backup email. A string: the person chose another one. */
  const [typed, setTyped] = useState<string | null>(null);
  const [code, setCode] = useState("");
  /** The server asked for a code, and one was mailed to this exact email. */
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!account) return null;

  const short = shortAddress(account.address);
  const recorded = backupRecord(account.address)?.email ?? null;
  const email = (codeFor ?? typed ?? recorded ?? "").trim();
  const fromRecord = typed === null && codeFor === null && recorded !== null;
  const emailOk = EMAIL_RE.test(email);
  const codeOk = /^\d{6}$/.test(code.trim());

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || !account) return;
    setBusy(true);
    setError("");
    try {
      let signer;
      try {
        // A signature over the ask, not a money movement.
        signer = await getSigner({ movesMoney: false });
      } catch (err) {
        if (isNeedsPassword(err)) {
          setError("Set a password on this account first.");
          return;
        }
        router.push(`/unlock?next=${encodeURIComponent("/pilot")}`);
        return;
      }
      const host = pilotHost();
      const first = await askToJoin({ host, signer, email, src: "web", ...(codeFor ? { code: code.trim() } : {}) });
      const r = await settleAsk({ host, pubkey: account.address, result: first });
      if (!r.ok) {
        if (r.code === "code-required" && !codeFor) {
          await requestPilotCode(host, email);
          setCodeFor(email);
          return;
        }
        setError(r.message);
        return;
      }
      onAsked(r, email, moreSends);
    } catch (err) {
      setError((err as Error).message || "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <p className="text-sm font-semibold text-ink">{moreSends ? ASK_COPY.askMore : ASK_COPY.heading}</p>
      {ready && !moreSends && <p className="text-sm text-money">Your money is locked and backed up. One more step.</p>}
      {codeFor ? (
        <>
          <p className="text-sm text-ink-soft">{ASK_COPY.codeStep(codeFor)}</p>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label={ASK_COPY.codeField}
            placeholder={ASK_COPY.codeField}
            value={code}
            onChange={(ev) => setCode(ev.target.value.replace(/\D/g, "").slice(0, 6))}
            className="w-full rounded-[14px] border border-line bg-surface px-3 py-3 text-ink outline-none"
          />
        </>
      ) : fromRecord ? (
        <p className="text-sm text-ink-soft">
          {ASK_COPY.emailKnown(maskEmail(recorded!))}{" "}
          <button type="button" className={quiet} onClick={() => setTyped("")}>
            {ASK_COPY.useDifferentEmail}
          </button>
        </p>
      ) : (
        <label className="text-sm text-ink-soft">
          {ASK_COPY.emailLabel}
          <input
            type="email"
            required
            value={typed ?? ""}
            onChange={(ev) => setTyped(ev.target.value)}
            placeholder="you@example.com"
            className="mt-1 w-full rounded-[14px] border border-line bg-surface px-3 py-3 text-ink outline-none"
          />
          <span className="mt-1 block text-xs">{ASK_COPY.emailHint(short)}</span>
        </label>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      {/* The security rule is enforced here rather than by hiding the form: a pilot user's real
          money must never sit under a device key anyone holding the phone could spend. */}
      <PrimaryButton
        loading={busy}
        loadingLabel={ASK_COPY.asking}
        disabled={!ready || !emailOk || (codeFor !== null && !codeOk)}
      >
        {!ready ? "Finish step 1 first" : moreSends ? ASK_COPY.askMore : ASK_COPY.ask}
      </PrimaryButton>
      {codeFor && (
        <button
          type="button"
          className="text-xs text-ink-soft underline-offset-2 hover:underline"
          disabled={busy}
          onClick={() => {
            setCodeFor(null);
            setCode("");
            setTyped("");
            setError("");
          }}
        >
          {ASK_COPY.useDifferentEmail}
        </button>
      )}
    </form>
  );
}
