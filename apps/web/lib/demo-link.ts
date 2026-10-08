/**
 * What the /try page's one button may make of the sponsor's /demo-link reply. Pure, so the self-test
 * (test:claimerr) drives it with no network.
 *
 * /demo-link submits a practice claimable balance (apps/sponsor/src/lib/demo-link.ts), so it has the
 * same 202 as every Horizon route: `{"error":"submit unconfirmed","hash"}`, with no link in it. The
 * button used to read any 2xx as a minted link and called `.slice` on the missing balance id, so the
 * visitor saw the browser's own TypeError ("Cannot read properties of undefined"). A reply that is
 * not a whole link is now a sentence, never a crash, and never a link with a hole in it.
 */
import { claimFragment } from "./link-fragment";

export type DemoLinkReply = { ok: true; link: string } | { ok: false; message: string };

/** What a reply must carry before it is a link anyone can claim. */
interface Minted {
  balanceId: string;
  bearerSecret: string;
  issuer: string;
  from: string;
}

function minted(body: unknown): Minted | null {
  const b = body as Partial<Record<keyof Minted, unknown>> | null;
  if (!b || typeof b !== "object") return null;
  const { balanceId, bearerSecret, issuer, from } = b;
  if (typeof balanceId !== "string" || !/^[0-9a-f]{8,}$/i.test(balanceId)) return null;
  if (typeof bearerSecret !== "string" || !/^S[A-Z2-7]{55}$/.test(bearerSecret)) return null;
  if (typeof issuer !== "string" || !/^G[A-Z2-7]{55}$/.test(issuer)) return null;
  return { balanceId, bearerSecret, issuer, from: typeof from === "string" ? from : "Lumenia" };
}

/**
 * The claim link to open, or the sentence to show. `status` and `text` are the reply as received.
 * The link is relative (`/c/<last 8>?b=..&i=..#<key>&s=<name>`): the page navigates to it in full,
 * so the key travels in the fragment. The event board (app/(site)/event) is the second caller: it
 * marks its links `seeded=1` (a public marker the claim page's beacon reads) and signs them
 * "Lumenia team", and before reading the reply here it had the same TypeError on a 202.
 */
export function readDemoLinkReply(
  status: number,
  text: string,
  opts: { seeded?: boolean; from?: string } = {},
): DemoLinkReply {
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON: judged by the status below */
  }
  const error = (body as { error?: unknown } | null)?.error;
  if (status === 202 || (typeof error === "string" && /submit unconfirmed/i.test(error))) {
    // Practice money, made by our faucet: a second tap makes a second practice link, nothing more.
    return { ok: false, message: "Your link is taking longer than usual to be ready. Please try again in a moment." };
  }
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      message: typeof error === "string" && error ? error : "This isn't available right now. Please try again in a moment.",
    };
  }
  const m = minted(body);
  if (!m) return { ok: false, message: "We couldn't make your link just now. Please try again in a moment." };
  const q = `b=${m.balanceId}&i=${m.issuer}${opts.seeded ? "&seeded=1" : ""}`;
  return {
    ok: true,
    link: `/c/${m.balanceId.slice(-8)}?${q}#${claimFragment({ key: m.bearerSecret, from: opts.from ?? m.from })}`,
  };
}
