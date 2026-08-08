/**
 * Sharing a money link without handing the money to a third party.
 *
 * A claim link's #fragment IS the money. `https://wa.me/?text=<encoded link>` percent-encodes the
 * `#`, which stops it being a fragment at all: the bearer key travels to Meta's redirector as
 * ordinary query data, where it lands in access logs and every TLS-terminating hop on the way.
 * That is the exact leak `Referrer-Policy: no-referrer` on the claim route exists to prevent.
 *
 * The Web Share API hands the text to the operating system's share sheet instead — no network
 * request, and the user still picks WhatsApp from the same sheet. Where it is unavailable
 * (desktop browsers, mostly) we fall back to the clipboard and say so, rather than quietly
 * routing the secret through a server.
 */

export type ShareOutcome = "shared" | "copied" | "failed";

export async function shareMoneyLink(opts: { text: string; link: string }): Promise<ShareOutcome> {
  const nav = typeof navigator === "undefined" ? undefined : navigator;

  if (nav?.share) {
    try {
      await nav.share({ text: opts.text, url: opts.link });
      return "shared";
    } catch (e) {
      // The user dismissing the sheet is not a failure — don't fall through to the clipboard and
      // silently copy something they just decided not to send.
      if ((e as Error)?.name === "AbortError") return "shared";
    }
  }

  try {
    await nav?.clipboard.writeText(opts.link);
    return "copied";
  } catch {
    return "failed";
  }
}
