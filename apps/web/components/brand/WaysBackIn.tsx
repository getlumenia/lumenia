"use client";

/**
 * WaysBackIn — the connections that help someone FIND their account again
 * (docs/IDENTITY_AND_ACCOUNTS.md §5).
 *
 * THE COPY RULE THIS COMPONENT EXISTS TO HOLD. Nothing here is a sign-in, and nothing here is
 * described as making the money "more secure". Connecting Google or a passkey files a pointer to
 * an account under something the person controls; the money still opens with the password or the
 * passkey and nothing else. So the card counts *ways back in*, and every row says what it does:
 * it finds your account. Saying "sign in with Google" would be a straightforward lie about what
 * the server is able to do, and the architecture is built so it stays a lie.
 *
 * TWO PROOFS, ALWAYS. A connection is not something an identity can arrange by itself: proving you
 * hold an email says nothing about whose account it should point at. So every connect also carries
 * the ACCOUNT's own signature, which means a locked account cannot connect anything until it is
 * opened. That is not an error to hand back — it is an errand, and this card names it and links to
 * the one page that finishes it.
 *
 * THE WARNING. Connecting an identity that already leads to a different account does not silently
 * take it over — the other person would lose their route home with no event they could have seen.
 * The server refuses and returns that account's name, and the refusal is shown as what it is:
 * *"That already opens @meric."*
 *
 * OAuth rows only appear where an app is actually registered (`/identity-providers`). An
 * unregistered provider renders as honestly unavailable rather than as a button that fails.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import {
  attachIdentity,
  availableProviders,
  detachMine,
  listLinks,
  startConnect,
  PROVIDER_LABEL,
  OAUTH_PROVIDERS,
  type Provider,
} from "../../lib/identity";
import { assertPasskeyPrf, isPasskeyCapable } from "../../lib/passkey-prf";
import { prfToBoxId, prfToAliasProof } from "../../lib/recovery";
import { requestRecoveryOtp } from "../../lib/recovery-api";
import { isNeedsPassword } from "../../lib/signer-error";
import type { Signer } from "../../lib/signer";
import { MoneyCard } from "./MoneyCard";

const ORDER: Provider[] = ["passkey", "email", "google", "github", "x"];

/**
 * Connecting takes the ACCOUNT's own signature, not just the identity's — so an account that cannot
 * sign right now cannot connect anything, and the card has to name the errand instead of handing
 * back a refusal nobody can act on. `null` means the account can sign and nothing is in the way.
 */
type Sealed = "unlock" | "password" | null;

const SEALED_COPY: Record<NonNullable<Sealed>, string> = {
  unlock: "Unlock your money first — this takes the account's own signature.",
  password: "Set a password on this account first — this takes the account's own signature.",
};

/**
 * Which errand a signing failure names. An account with no password has nothing to unlock and
 * /unlock sends it straight back, so that case goes to /account instead; anything else is not about
 * the lock at all and is reported in its own words.
 */
function sealedBy(e: unknown, phase: 1 | 2): Sealed {
  if (isNeedsPassword(e)) return "password";
  return phase === 2 ? "unlock" : null;
}

const BLURB: Record<Provider, string> = {
  passkey: "One tap on a new phone finds this account.",
  email: "A code to your inbox finds this account.",
  google: "Finds this account with your Google account.",
  github: "Finds this account with your GitHub account.",
  x: "Finds this account with your X account.",
};

export function WaysBackIn({ connectedTicket, ticketProvider }: { connectedTicket?: string; ticketProvider?: string }) {
  const { account, getSigner } = useWallet();
  const [offered, setOffered] = useState<Provider[]>(["passkey", "email"]);
  const [linked, setLinked] = useState<Provider[] | null>(null);
  const [busy, setBusy] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [sealed, setSealed] = useState<Sealed>(null);
  const [ticketSpent, setTicketSpent] = useState(false);
  const spending = useRef(false);

  useEffect(() => {
    void availableProviders().then(setOffered);
  }, []);

  /**
   * Reading the list is signed by the account, so a locked account cannot show it until it is
   * unlocked. `null` means "we don't know yet", which is deliberately different from "none": an
   * empty list is a claim, and claiming somebody has no ways back in when we simply could not ask
   * would be the most alarming possible wrong answer here.
   *
   * A lock found here is recorded but NOT shown in red: arriving at a locked account is ordinary,
   * and the card says so in its own sentence. The errand only turns into an error when somebody
   * taps something it stops.
   */
  const refreshLinks = useCallback(async () => {
    if (!account) return;
    let signer: Signer;
    try {
      signer = await getSigner();
    } catch (e) {
      setSealed(sealedBy(e, account.phase));
      setLinked(null);
      return;
    }
    setSealed(null);
    try {
      setLinked((await listLinks(signer)).map((l) => l.provider));
    } catch {
      setLinked(null);
    }
  }, [account, getSigner]);

  useEffect(() => {
    void refreshLinks();
  }, [refreshLinks]);

  /**
   * The signature every connect needs, or null with the errand already on screen. Callers must
   * check the result rather than assume it: the account can lock between renders, and this is the
   * only place that knows for certain.
   */
  const accountSigner = useCallback(async (): Promise<Signer | null> => {
    if (!account) return null;
    try {
      const signer = await getSigner();
      setSealed(null);
      return signer;
    } catch (e) {
      const kind = sealedBy(e, account.phase);
      setSealed(kind);
      setError(kind ? SEALED_COPY[kind] : (e as Error).message);
      return null;
    }
  }, [account, getSigner]);

  /** The ticket the OAuth return landed with, until something spends it. */
  const liveTicket = ticketSpent ? undefined : connectedTicket;

  /**
   * Coming back from an OAuth provider. The ticket is single-use and expires quickly, so it is
   * spent immediately on the attach — and the attach is also what surfaces a conflict, which is
   * why there is no separate "check" round trip that would consume the ticket first.
   *
   * BUT the attach needs the account's own signature, and the round trip through the provider was a
   * full page load: a password-locked account has no seed in memory any more, every time. So the
   * signature is obtained FIRST, and a locked account leaves the ticket exactly where it is —
   * unspent, still in the address bar — and gets sent to /unlock with a `next` that carries it back
   * here. Spending it into a request that cannot be signed would burn the only ticket there is.
   */
  useEffect(() => {
    if (!liveTicket || !account) return;
    let live = true;
    void (async () => {
      const signer = await accountSigner();
      if (!live || !signer) return;
      // One attempt per ticket, whatever re-renders it through: a second POST would land after the
      // first consumed it and be reported back as somebody else's connection.
      if (spending.current) return;
      spending.current = true;
      try {
        await attachIdentity({ kind: "ticket", ticket: liveTicket }, account.address, signer);
        if (!live) return;
        setNote(`${ticketProvider ? PROVIDER_LABEL[ticketProvider as Provider] ?? "That" : "That"} is connected.`);
        await refreshLinks();
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        // Spend the query param either way: a reload must not retry a ticket that is already gone.
        // Not gated on `live` — the ticket is spent whether or not this card is still on screen —
        // but the URL is only rewritten while we are still on the page that carried it.
        setTicketSpent(true);
        if (window.location.pathname === "/settings") window.history.replaceState({}, "", "/settings");
      }
    })();
    return () => {
      live = false;
    };
  }, [liveTicket, ticketProvider, account, accountSigner, refreshLinks]);

  const connectPasskey = useCallback(async () => {
    if (!account) return;
    setBusy("passkey");
    setError(null);
    setNote(null);
    let prf: Uint8Array | null = null;
    try {
      // An ASSERTION, not an enrolment: this is "the Face ID you already use", which is exactly the
      // case where it may already belong to another account — and the case the warning is for.
      const assertion = await assertPasskeyPrf();
      prf = assertion.prf;
      const id = await prfToBoxId(prf);
      const proof = await prfToAliasProof(prf);
      // After the ceremony, never before it: Safari drops the user gesture across an await, and the
      // gesture is what lets the Face ID prompt open at all. The button already turns a sealed
      // account into the errand before asking for Face ID, so reaching here locked is the stale
      // case rather than the path — nobody is asked for their face and then told it was pointless.
      const signer = await accountSigner();
      if (!signer) return;
      await attachIdentity({ kind: "passkey", id, proof }, account.address, signer, undefined, proof);
      setNote("Face ID is connected.");
      await refreshLinks();
    } catch (e) {
      const message = (e as Error).message;
      setError(
        /NotAllowed|abort|not allowed/i.test(message)
          ? "No Face ID for Lumenia on this phone yet. Back your money up with Face ID first, then connect it here."
          : message,
      );
    } finally {
      prf?.fill(0);
      setBusy(null);
    }
  }, [account, accountSigner, refreshLinks]);

  const connectEmail = useCallback(async () => {
    if (!account) return;
    setBusy("email");
    setError(null);
    setNote(null);
    try {
      // Before the code is posted, not after: a code spent on a request that could not be signed is
      // a code the person has to ask for again.
      const signer = await accountSigner();
      if (!signer) return;
      await attachIdentity({ kind: "email", email, code }, account.address, signer);
      setNote("Your email is connected.");
      setEmailOpen(false);
      setCodeSent(false);
      setEmail("");
      setCode("");
      await refreshLinks();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [account, accountSigner, email, code, refreshLinks]);

  const connectOAuth = useCallback(
    async (provider: Provider) => {
      if (!account) return;
      setBusy(provider);
      setError(null);
      try {
        // Full-page navigation, not a popup: popups are unreliable in the in-app webviews a large
        // share of this product's users arrive through.
        window.location.assign(await startConnect(provider, account.address));
      } catch (e) {
        setError((e as Error).message);
        setBusy(null);
      }
    },
    [account],
  );

  const disconnect = useCallback(
    async (provider: Provider) => {
      setBusy(provider);
      setError(null);
      setNote(null);
      try {
        const signer = await accountSigner();
        if (!signer) return;
        await detachMine(signer, provider);
        await refreshLinks();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [accountSigner, refreshLinks],
  );

  if (!account) return null;

  const rows = ORDER.filter((p) => p === "passkey" || p === "email" || offered.includes(p));
  const count = linked?.length ?? 0;

  /**
   * Where the errand is done. The unlock link carries an unspent OAuth ticket back with it, so
   * coming back from Google to a locked account costs a password and nothing else — /unlock only
   * follows a `next` that is a path on this site, and this is one.
   */
  const errand: { href: string; label: string } | null =
    sealed === "password"
      ? { href: "/account", label: "Set a password" }
      : sealed === "unlock"
        ? {
            href: `/unlock?next=${encodeURIComponent(
              liveTicket
                ? `/settings?connected=${liveTicket}&provider=${ticketProvider ?? ""}`
                : "/settings",
            )}`,
            label: "Unlock",
          }
        : null;

  /** Tapping something the lock stops names the errand instead of starting a ceremony that cannot end. */
  const stoppedBySeal = (): boolean => {
    if (!sealed) return false;
    setNote(null);
    setError(SEALED_COPY[sealed]);
    return true;
  };

  return (
    <MoneyCard className="p-5">
      <div className="app-krow" style={{ borderBottom: 0, paddingTop: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="app-kicon" src="/brand-kit-assets/icon-shield.webp" alt="" />
        <div className="app-krow-body">
          <p className="app-krow-t">Ways back in</p>
          <p className="app-krow-s app-krow-s--prose">
            {sealed === "unlock"
              ? "Unlock your money to see and add ways back in."
              : sealed === "password"
                ? "Set a password on this account to see and add ways back in."
                : linked === null
                  ? "We couldn't check which of these are connected just now."
                  : count === 0
                    ? "Nothing connected yet. Connect one so a new phone can find this account."
                    : `${count} connected. Any of them finds this account on a new phone.`}{" "}
            {!error && errand && (
              <Link href={errand.href} className="underline underline-offset-2">
                {errand.label}
              </Link>
            )}
          </p>
        </div>
      </div>

      {/* The honest sentence. It is not a disclaimer tucked at the bottom — it is the definition of
          what every button below does, so it goes above them. */}
      <p className="mt-3 rounded-[12px] border border-line bg-paper px-3 py-2 text-xs text-ink-soft">
        These find your account. They never open it: that still takes your password or your Face ID,
        and we can&apos;t do it for you.
      </p>

      <div className="mt-2">
        {rows.map((provider) => {
          const isLinked = linked?.includes(provider) ?? false;
          const available = provider === "passkey" ? isPasskeyCapable() : true;
          return (
            <div key={provider} className="border-b border-line py-3 last:border-b-0">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                    {PROVIDER_LABEL[provider]}
                    {isLinked && <Check className="size-3.5 text-money" />}
                  </p>
                  <p className="text-xs text-ink-soft">{BLURB[provider]}</p>
                </div>
                {!available ? (
                  <span className="shrink-0 text-xs text-ink-soft">Not on this phone</span>
                ) : isLinked ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
                      if (stoppedBySeal()) return;
                      void disconnect(provider);
                    }}
                    className="shrink-0 rounded-full px-3 py-1.5 text-sm text-ink-soft disabled:opacity-40"
                  >
                    {busy === provider ? "…" : "Disconnect"}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
                      if (stoppedBySeal()) return;
                      if (provider === "passkey") return void connectPasskey();
                      if (provider === "email") return setEmailOpen((v) => !v);
                      void connectOAuth(provider);
                    }}
                    className="shrink-0 rounded-full border border-line px-3 py-1.5 text-sm font-medium text-ink disabled:opacity-40"
                  >
                    {busy === provider ? "Connecting…" : "Connect"}
                  </button>
                )}
              </div>

              {provider === "email" && emailOpen && !isLinked && (
                <div className="mt-3 flex flex-col gap-2">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="h-12 rounded-[14px] border border-line bg-surface px-3 text-ink outline-none"
                  />
                  {codeSent && (
                    <input
                      inputMode="numeric"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="6-digit code"
                      className="h-12 rounded-[14px] border border-line bg-surface px-3 text-ink outline-none"
                    />
                  )}
                  <button
                    type="button"
                    disabled={busy !== null || email.length < 5}
                    onClick={() => {
                      if (!codeSent) {
                        setBusy("email");
                        setError(null);
                        void requestRecoveryOtp(email)
                          .then(() => setCodeSent(true))
                          .catch((e: Error) => setError(e.message))
                          .finally(() => setBusy(null));
                        return;
                      }
                      void connectEmail();
                    }}
                    className="h-12 rounded-[14px] border border-line px-3 text-sm font-medium text-ink disabled:opacity-40"
                  >
                    {busy === "email" ? "Working…" : codeSent ? "Connect this email" : "Send me a code"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Providers with no app registered are simply absent from `offered`. Saying so beats leaving
          a person wondering why the product mentions Google nowhere. */}
      {OAUTH_PROVIDERS.some((p) => !offered.includes(p)) && (
        <p className="mt-3 text-xs text-ink-soft">
          More ways to connect are coming.
        </p>
      )}

      {note && <p className="mt-3 text-sm text-money">{note}</p>}
      {error && (
        <p className="mt-3 text-sm text-danger">
          {error}{" "}
          {errand && (
            <Link href={errand.href} className="underline underline-offset-2">
              {errand.label}
            </Link>
          )}
        </p>
      )}
    </MoneyCard>
  );
}
