/**
 * /v2/c/[linkHex] — the v2 (Soroban LumenDrop) claim page. Value-first: the money is shown
 * before any action. The recipient claims walletless + gasless — a fresh sponsored account is
 * created for them and the drop is paid straight into it via the /v2-claim relayer (proven live).
 * The link secret rides in the #fragment (client-only); the query carries the display metadata.
 *
 * This is a NEW route (the frozen v1 /c/[id] is untouched). It reuses the brand tokens.
 */
import { formatUsd } from "../../../../lib/money";
import V2ClaimButton from "./V2ClaimButton";

export default async function V2ClaimPage({
  params,
  searchParams,
}: {
  params: Promise<{ linkHex: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { linkHex } = await params;
  const sp = await searchParams;
  const amount = typeof sp.a === "string" ? sp.a : "";
  const sender = (typeof sp.s === "string" ? sp.s : "").trim() || "Someone";
  // `p=1` marks a password-locked link, so the page can say so up front instead of
  // letting someone tap a button that then asks for something they weren't expecting.
  const locked = sp.p === "1";
  // `n=public` means this link carries REAL money. The honesty note below was unconditional, so a
  // friend opening a real transfer was told by the app itself that the money isn't real — on the
  // one screen a non-user ever sees, about the one thing they care about.
  const real = sp.n === "public";

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-8 px-6 py-12 text-center">
      <div className="flex flex-col items-center gap-2">
        <p className="text-ink-soft">{sender} sent you money</p>
        {amount ? (
          <p className="text-6xl font-bold tabular-nums text-money">{formatUsd(amount)}</p>
        ) : (
          <p className="text-2xl font-semibold text-ink">You have money to claim</p>
        )}
        {locked && (
          <p className="mt-2 text-sm text-ink-soft">
            This one is locked. You&apos;ll need the password {sender} gave you.
          </p>
        )}
      </div>
      <V2ClaimButton linkHex={linkHex} amount={amount} sender={sender} />
      {real ? (
        <p className="text-xs text-ink-soft">Real money, on the public Stellar record.</p>
      ) : (
        <p className="text-xs text-ink-soft">Test network. This money isn&apos;t real.</p>
      )}
    </main>
  );
}
