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
 * THE WARNING. Connecting an identity that already leads to a different account does not silently
 * take it over — the other person would lose their route home with no event they could have seen.
 * The server refuses and returns that account's name, and the refusal is shown as what it is:
 * *"That already opens @meric."*
 *
 * OAuth rows only appear where an app is actually registered (`/identity-providers`). An
 * unregistered provider renders as honestly unavailable rather than as a button that fails.
 */
import { useCallback, useEffect, useState } from "react";
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
import { MoneyCard } from "./MoneyCard";

const ORDER: Provider[] = ["passkey", "email", "google", "github", "x"];

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

  useEffect(() => {
    void availableProviders().then(setOffered);
  }, []);

  /**
   * Reading the list is signed by the account, so a locked account cannot show it until it is
   * unlocked. `null` means "we don't know yet", which is deliberately different from "none": an
   * empty list is a claim, and claiming somebody has no ways back in when we simply could not ask
   * would be the most alarming possible wrong answer here.
   */
  const refreshLinks = useCallback(async () => {
    if (!account) return;
    try {
      const signer = await getSigner();
      setLinked((await listLinks(signer)).map((l) => l.provider));
    } catch {
      setLinked(null);
    }
  }, [account, getSigner]);

  useEffect(() => {
    void refreshLinks();
  }, [refreshLinks]);

  /**
   * Coming back from an OAuth provider. The ticket is single-use and expires quickly, so it is
   * spent immediately on the attach — and the attach is also what surfaces a conflict, which is
   * why there is no separate "check" round trip that would consume the ticket first.
   */
  useEffect(() => {
    if (!connectedTicket || !account) return;
    let live = true;
    void (async () => {
      try {
        await attachIdentity({ kind: "ticket", ticket: connectedTicket }, account.address);
        if (!live) return;
        setNote(`${ticketProvider ? PROVIDER_LABEL[ticketProvider as Provider] ?? "That" : "That"} is connected.`);
        await refreshLinks();
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        // Spend the query param either way: a reload must not retry a ticket that is already gone.
        if (live) window.history.replaceState({}, "", "/settings");
      }
    })();
    return () => {
      live = false;
    };
  }, [connectedTicket, ticketProvider, account, refreshLinks]);

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
      await attachIdentity({ kind: "passkey", id, proof }, account.address, undefined, proof);
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
  }, [account, refreshLinks]);

  const connectEmail = useCallback(async () => {
    if (!account) return;
    setBusy("email");
    setError(null);
    setNote(null);
    try {
      await attachIdentity({ kind: "email", email, code }, account.address);
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
  }, [account, email, code, refreshLinks]);

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
        await detachMine(await getSigner(), provider);
        await refreshLinks();
      } catch (e) {
        const message = (e as Error).message;
        setError(message === "locked" ? "Unlock your money first." : message);
      } finally {
        setBusy(null);
      }
    },
    [getSigner, refreshLinks],
  );

  if (!account) return null;

  const rows = ORDER.filter((p) => p === "passkey" || p === "email" || offered.includes(p));
  const count = linked?.length ?? 0;

  return (
    <MoneyCard className="p-5">
      <div className="app-krow" style={{ borderBottom: 0, paddingTop: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="app-kicon" src="/brand-kit-assets/icon-shield.webp" alt="" />
        <div className="app-krow-body">
          <p className="app-krow-t">Ways back in</p>
          <p className="app-krow-s app-krow-s--prose">
            {linked === null
              ? "Unlock your money to see which of these are connected."
              : count === 0
                ? "Nothing connected yet. Connect one so a new phone can find this account."
                : `${count} connected. Any of them finds this account on a new phone.`}
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
                    onClick={() => void disconnect(provider)}
                    className="shrink-0 rounded-full px-3 py-1.5 text-sm text-ink-soft disabled:opacity-40"
                  >
                    {busy === provider ? "…" : "Disconnect"}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
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
