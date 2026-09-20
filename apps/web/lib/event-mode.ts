/**
 * Event mode (Stellar Pro Hackathon, Istanbul, 19-20 Sept 2026; decision register D27 item 2.2).
 *
 * `NEXT_PUBLIC_EVENT_MODE=1` at build time. It only HIDES and re-arranges: the home screen shows
 * four big money verbs (Send, Ask, Split, Cash out), a network badge sits on every app screen, and
 * the bell steps out of the way. Every route stays reachable by its URL, and nothing about how
 * money moves changes. The flag is removed after the event (HACKATHON_AFTER.md), which is a
 * redeploy, because NEXT_PUBLIC values are baked into the build.
 */
export function eventMode(): boolean {
  return process.env.NEXT_PUBLIC_EVENT_MODE === "1";
}
