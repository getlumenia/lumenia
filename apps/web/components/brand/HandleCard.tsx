"use client";

/**
 * HandleCard — the `@name` an account can be paid at (docs/IDENTITY_AND_ACCOUNTS.md §3).
 *
 * Three states, one card: you have no name (pick one), you have one (show it, and how to use it
 * outside Lumenia), or you are giving it up.
 *
 * TWO THINGS THIS SCREEN MUST SAY OUT LOUD, because both are irreversible in their own way:
 *   1. A name is PUBLIC. It ties this account's whole history on the public record to a word, for
 *      anyone, forever. That is a real trade and it is stated before the button, not after.
 *   2. Giving a name up does NOT free it. Nobody can register it for 30 days, including you —
 *      a name people have paid to must not become a stranger's the moment you move on.
 *
 * Claiming is a signature from the account, so a locked account has to be unlocked first; the card
 * says so and points at /unlock rather than failing with a technical message.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, Copy } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { checkHandle, claimHandle, handleOf, releaseHandle, federationAddress } from "../../lib/handles";
import { MoneyCard } from "./MoneyCard";
import { PrimaryButton } from "./PrimaryButton";

type Availability = { state: "idle" | "checking" | "free" | "taken" | "invalid"; reason?: string };

export function HandleCard() {
  const { account, getSigner } = useWallet();
  const [name, setName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [availability, setAvailability] = useState<Availability>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const checkSeq = useRef(0);

  useEffect(() => {
    if (!account) return;
    let live = true;
    setLoading(true);
    handleOf(account.address)
      .then((n) => live && setName(n))
      .catch(() => live && setName(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [account]);

  /**
   * Availability while typing, debounced. Each run carries a sequence number so a slow answer for
   * an earlier draft can never overwrite the answer for what is on screen now — the classic
   * race that makes a name look free after you have already typed past it.
   */
  useEffect(() => {
    const candidate = draft.trim().toLowerCase().replace(/^@+/, "");
    if (candidate.length < 3) {
      setAvailability({ state: "idle" });
      return;
    }
    const seq = ++checkSeq.current;
    setAvailability({ state: "checking" });
    const t = setTimeout(() => {
      void checkHandle(candidate)
        .then((r) => {
          if (seq !== checkSeq.current) return;
          if (r.taken) return setAvailability({ state: "taken" });
          setAvailability(r.available ? { state: "free" } : { state: "invalid", reason: r.reason });
        })
        .catch(() => {
          if (seq === checkSeq.current) setAvailability({ state: "idle" });
        });
    }, 350);
    return () => clearTimeout(t);
  }, [draft]);

  const claim = useCallback(async () => {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      const signer = await getSigner();
      const claimed = await claimHandle(signer, draft);
      setName(claimed.name);
      setDraft("");
      setAvailability({ state: "idle" });
    } catch (e) {
      const message = (e as Error).message;
      setError(message === "locked" ? "Unlock your money first, then pick your name." : message);
    } finally {
      setBusy(false);
    }
  }, [account, draft, getSigner]);

  const release = useCallback(async () => {
    if (!account || !name) return;
    setBusy(true);
    setError(null);
    try {
      const signer = await getSigner();
      await releaseHandle(signer, name);
      setName(null);
      setConfirmRelease(false);
    } catch (e) {
      const message = (e as Error).message;
      setError(message === "locked" ? "Unlock your money first." : message);
    } finally {
      setBusy(false);
    }
  }, [account, name, getSigner]);

  if (!account) return null;

  return (
    <MoneyCard className="p-5">
      <div className="app-krow" style={{ borderBottom: 0, paddingTop: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="app-kicon" src="/brand-kit-assets/icon-key.webp" alt="" />
        <div className="app-krow-body">
          <p className="app-krow-t">Your name</p>
          <p className="app-krow-s app-krow-s--prose">
            {name ? "People can pay you at this instead of a long address." : "Pick a short name people can pay you at."}
          </p>
        </div>
      </div>

      {loading ? (
        <p className="mt-4 text-sm text-ink-soft">Checking…</p>
      ) : name ? (
        <div className="mt-4">
          <p className="text-2xl font-bold text-ink">@{name}</p>

          {/* The part that works OUTSIDE Lumenia: any wallet that speaks federation can send here
              by typing this, which is what makes a name worth having rather than a nickname. */}
          <div className="mt-3 flex items-center justify-between gap-2 rounded-[12px] border border-line bg-paper px-3 py-2">
            <span className="break-all font-mono text-xs text-ink-soft">{federationAddress(name)}</span>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(federationAddress(name));
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  /* clipboard blocked */
                }
              }}
              className="shrink-0 text-ink-soft"
              aria-label="Copy"
            >
              {copied ? <Check className="size-4 text-money" /> : <Copy className="size-4" />}
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-soft">
            Works in other Stellar wallets too — they can type that instead of your address.
          </p>

          {confirmRelease ? (
            <div className="mt-4 border-t border-line pt-4">
              <p className="text-sm text-danger">
                Giving up @{name} does not free it. Nobody can take it for 30 days — including you —
                so anyone who saved it can&apos;t be paid to a stranger by mistake.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={release}
                  className="rounded-[14px] border border-danger px-3 py-2 text-sm font-medium text-danger disabled:opacity-40"
                >
                  {busy ? "Giving it up…" : "Give it up"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRelease(false)}
                  className="rounded-[14px] px-3 py-2 text-sm text-ink-soft"
                >
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRelease(true)}
              className="mt-4 text-sm text-ink-soft underline-offset-2 hover:underline"
            >
              Give up this name
            </button>
          )}
        </div>
      ) : (
        <div className="mt-4">
          <label className="text-sm text-ink-soft" htmlFor="handle-input">
            Choose a name
          </label>
          <div className="mt-1 flex items-center gap-2 rounded-[14px] border border-line bg-surface px-3">
            <span className="text-ink-soft">@</span>
            <input
              id="handle-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="yourname"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="h-12 flex-1 bg-transparent text-ink outline-none"
            />
          </div>

          <p className="mt-2 min-h-5 text-sm">
            {availability.state === "checking" && <span className="text-ink-soft">Checking…</span>}
            {availability.state === "free" && <span className="text-money">That one is free.</span>}
            {availability.state === "taken" && <span className="text-ink-soft">Someone already has that.</span>}
            {availability.state === "invalid" && <span className="text-ink-soft">{availability.reason}</span>}
          </p>

          {/* Stated BEFORE the button. A name is a public, permanent link between a word and every
              transaction this account has ever made. */}
          <p className="mt-1 text-xs text-ink-soft">
            A name is public. It links this account&apos;s record to that word for anyone who looks, so
            pick one you are happy to be known by. You can give it up later.
          </p>

          <PrimaryButton
            className="mt-3 w-full"
            disabled={busy || availability.state !== "free"}
            onClick={claim}
          >
            {busy ? "Taking it…" : "Take this name"}
          </PrimaryButton>
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm text-danger">
          {error}{" "}
          {error.toLowerCase().includes("unlock") && (
            <Link href="/unlock" className="underline underline-offset-2">
              Unlock
            </Link>
          )}
        </p>
      )}
    </MoneyCard>
  );
}
