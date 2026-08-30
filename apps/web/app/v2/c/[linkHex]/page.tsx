/**
 * /v2/c/[linkHex] — the v2 (Soroban LumenDrop) claim page. Value-first: the money is shown
 * before any action. The recipient claims walletless + gasless — a fresh sponsored account is
 * created for them and the drop is paid straight into it via the /v2-claim relayer (proven live).
 * The link secret rides in the #fragment (client-only); the query carries the display metadata.
 *
 * This is a NEW route (the frozen v1 /c/[id] is untouched). It reuses the brand tokens.
 */
import type { Metadata, Viewport } from "next";
import { formatUsd } from "../../../../lib/money";
import V2ClaimButton from "./V2ClaimButton";


/**
 * Without these the link arrives in WhatsApp as a bare https://getlumenia.com/v2/c/3f9a8c… with a
 * generic grey card — the visual signature of a phishing message, on the one link we are asking 20
 * people to trust. The v1 route has had this since launch; the v2 rewrite dropped it. Nothing
 * private is exposed: the amount and name are already query params, not fragment.
 *
 * Those same query params are why `robots` is declared here. This route sits at the top level, not
 * inside the (app) group whose layout carries the noindex, so nothing else says it for it — and a
 * URL naming a stranger's amount and sender has no business in an index even when the crawler can
 * only see the URL. robots.ts Disallows the path too; a Disallow alone can still leave a
 * link-discovered URL listed.
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const sp = await searchParams;
  const a = typeof sp.a === "string" ? Number.parseFloat(sp.a) : Number.NaN;
  const ok = Number.isFinite(a) && a > 0 && a <= 10_000;
  const who = (typeof sp.s === "string" ? sp.s : "").trim().slice(0, 24) || "Someone";
  const title = ok ? `${who} sent you ${formatUsd(sp.a as string)}` : `${who} sent you money`;
  const images = [`/c/x/og?${new URLSearchParams({ a: ok ? (sp.a as string) : "", s: who })}`];
  return {
    title,
    robots: { index: false, follow: false },
    openGraph: { title, images },
    twitter: { card: "summary_large_image", title, images },
  };
}

/**
 * The root layout pins maximumScale: 1, which renders as user-scalable=no — a WCAG failure. The
 * (app) and (site) groups each override it; this route is in neither, so it kept the failure on a
 * screen showing someone their money in 12px grey.
 */
export const viewport: Viewport = { maximumScale: 5, themeColor: "#F5F3EF", viewportFit: "cover" };

export default async function V2ClaimPage({
  params,
  searchParams,
}: {
  params: Promise<{ linkHex: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { linkHex } = await params;
  const sp = await searchParams;
  /* Everything below comes from the query string, which anyone can write. It is rendered at 60px
     on a page carrying our domain and a working Claim button, so it gets checked first: an
     unchecked `a` renders "$NaN" or "-$2.00", and an unchecked `s` can be 300 characters or
     reverse the line with a bidi override. */
  const rawAmount = typeof sp.a === "string" ? Number.parseFloat(sp.a) : Number.NaN;
  const amount =
    Number.isFinite(rawAmount) && rawAmount > 0 && rawAmount <= 10_000 ? sp.a as string : "";
  const sender =
    (typeof sp.s === "string" ? sp.s : "")
      .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
      .trim()
      .slice(0, 24) || "Someone";
  // `p=1` marks a password-locked link, so the page can say so up front instead of
  // letting someone tap a button that then asks for something they weren't expecting.
  const locked = sp.p === "1";
  // `n=public` means this link carries REAL money. The honesty note below was unconditional, so a
  // friend opening a real transfer was told by the app itself that the money isn't real — on the
  // one screen a non-user ever sees, about the one thing they care about.
  const real = sp.n === "public";

  return (
    /* `claim-pw` is what makes this Periwinkle. Without it the page fell through to the retired
       green :root tokens, so the live claim screen — the only screen a recipient ever sees — was a
       different product from the one they land on right after. */
    <main className="claim-pw mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-8 bg-paper px-6 py-12 text-center text-ink">
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
