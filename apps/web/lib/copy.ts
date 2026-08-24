/**
 * User-facing copy — English (repo language policy: everything English; a Turkish
 * locale returns as an i18n pass when the TR corridor launches).
 * Vocabulary law (FRONTEND_PLAN §8): product UI shows only money + people —
 * NEVER wallet / crypto / USDC / Stellar / blockchain / gas / on-chain. Approved:
 * money, send, receive, claim, link, held in dollars, "we cover the network cost",
 * "public record" / "publicly verifiable", reclaim / "comes back to you after 7 days".
 */
export const copy = {
  appName: "Lumenia",
  landing: {
    headline: "Send money, hold dollars.",
    sub: "Send dollars to the people you love with a link, and they receive it in one tap. No app, no setup.",
    cta: "How does it work?",
  },
  claim: {
    youReceived: (name: string) => `${name} sent you money`,
    amountNote: "It's yours to keep.",
    safetyLine: "No app, no sign-up — just tap.",
    claimCta: "Claim my money",
    claiming: "Moving your money to you…",
    slow: "Almost there — your money is safe.",
    doneLabel: "Your money",
    doneSub: "It's in your account.",
    receipt: "See the public record",
    error: (name: string) => `We couldn't finish — your money from ${name} is still safe. Try again.`,
    retry: "Try again",
    /* Failure messages that tell the truth per case. The generic `error` above stays as the
     * fallback for a cause we could not identify — "try again" is safe advice only when we
     * genuinely do not know. See lib/claim-error.ts for why this list exists. */
    errAlreadyTitle: "You already have this money",
    errAlreadyBody: "This link was claimed — it's in your account already. Nothing more to do here.",
    errBusyBody: "A lot of people are claiming right now. Wait a moment and tap again.",
    errPausedBody:
      "We've paused claiming for a short while. Your money is untouched and this link keeps working — please come back a little later.",
    errOfflineBody: "We couldn't reach Lumenia. Check your connection and tap again.",
    errLinkBody: "This link is incomplete. Open the original message and tap the link there.",
    /* Shown small under the message. It exists so that someone reporting "it didn't work" can tell
     * us WHICH failure they hit — the first two reports of this bug were unactionable because every
     * cause produced identical words. */
    errDetail: (d: string) => `Details: ${d}`,
    holdHint: "Your dollars stay right here, to spend whenever you like.",
    // post-claim next action (the north-star hand-off)
    ctaSend: "Send money to someone",
    ctaRequest: "Ask someone to pay you",
    soon: "soon",
  },
  lock: {
    title: "Lock this money to you",
    body: "Add a password so only you can spend it. You can do this anytime.",
    cta: "Lock it",
    skip: "Maybe later",
  },
  /** Request money — the ask side (REQUEST_MONEY.md §10). Approved words only. */
  request: {
    title: "Ask for money",
    sub: "Make a link that asks someone to pay you. Share it in any chat.",
    amountLabel: "How much do you need?",
    nameLabel: "Your name",
    namePlaceholder: "So they know it's you",
    cta: "Create my request link",
    // Honest notes about what happens after — different per asker (§5.1).
    noteWithAccount: "When they pay, the money lands here for you to collect.",
    noteWithoutAccount:
      "When they pay, they'll send a money link back in the same chat. Tap it and the money is yours.",
    readyTitle: "Your request is ready",
    shareCta: "Share on WhatsApp",
    recentTitle: "Your recent asks",
    waText: (name: string, amount: string, link: string) =>
      `Hi, it's ${name}. Could you send me ${amount}? You can pay it here: ${link}`,
  },
  /** The payer's side of a request — /r/[id]. */
  pay: {
    asksFor: (name: string) => `${name} is asking for`,
    // No speed claims — the flow is at least two taps (honesty law, same class
    // as "target ~30s" vs "is 30s").
    sub: "Pay it with the money you have here.",
    payCta: (name: string) => `Pay ${name}`,
    noMoneyTitle: "You don't have money here yet",
    noMoneyBody: "Money here arrives as a link. When someone sends you one, you can come back and pay this.",
    // The WhatsApp webview has its own separate storage — a payer whose money
    // lives in their real browser must not be told they have none (webview law).
    browserHint: "Received money here before? This chat window can't see it. Open this page in your usual browser.",
    copyPageLink: "Copy this page's link",
    tryDemo: "Try it out first",
    invalid: "This request link is incomplete. Ask them to send it again.",
    // Double payment is possible by design (no server state) — say so once, honestly.
    doublePayNote: (name: string) => `If someone else may have paid this already, check with ${name} first.`,
    // Self-pay: her own request opened on her own device.
    ownRequestTitle: "This is your own request",
    ownRequestBody: "Share the link with the person you're asking. When they pay, the money shows up on your home screen.",
    directNote: (name: string, tail: string) => `Goes straight to ${name}'s account (ending ${tail}).`,
    paidDirectTitle: "Paid, and on its way",
    paidDirectBody: (name: string) =>
      `${name} will find it waiting the next time they open Lumenia. If it isn't collected, it comes back to you after 7 days.`,
    sendBackTitle: (name: string) => `Now send this link back to ${name}`,
    sendBackWaText: (link: string) => `Here's the money you asked for 💸 Tap to receive it: ${link}`,
  },
  /** /home — money waiting to be collected (a paid request, or any direct transfer). */
  waiting: {
    title: "Money waiting for you",
    collect: "Add to my money",
    collecting: "Adding it…",
    row: (amount: string) => `${amount} is waiting for you`,
  },
  /**
   * Money YOU sent that came back — a link no one claimed, past the 7-day window (the
   * approved "comes back to you after 7 days"). Take it back gaslessly, no jargon.
   * ADDITIVE block (copy.ts is in the frozen claim route's import graph — existing keys
   * above never change).
   */
  recover: {
    row: (amount: string) => `${amount} you sent came back to you`,
    hint: "No one claimed it, so it's yours again.",
    take: "Take it back",
    taking: "Taking it back…",
  },
  /**
   * Delegated cash-out placeholder (Instawards SOW note): conversion to local
   * currency is handled by a licensed provider, never by Lumenia. UI placeholder
   * only. Lives on /home + /cash-out now — NOT on the claim success screen.
   */
  cashOut: {
    title: "Use your money",
    spendCard: "Spend with a card",
    toTry: "Convert to Turkish lira",
    soon: "Coming soon",
    delegatedNote: "Conversion is handled by a licensed provider, coming soon.",
    // ADDITIVE (this file is in the frozen claim route's import graph): the /home
    // info row as ONE written sentence — composing it from the labels above
    // lowercased "Turkish lira" mid-sentence.
    infoRow:
      "Spending with a card and converting to Turkish lira arrive through a licensed partner, coming soon. Until then, your dollars stay yours to send.",
    // ADDITIVE (frozen-route import graph — never edit the keys above). The card on
    // /home stopped being a placeholder once /send-out shipped: the first leg of a
    // cash-out is now a real, tappable step, so the copy says what you can do rather
    // than what is coming. The lira conversion itself is still someone else's job,
    // which is exactly what the second line keeps saying.
    liveRow:
      "You can move your dollars to a licensed exchange from here, and turn them into lira there. We never touch lira ourselves, and the guide walks the whole route.",
    sendOutCta: "Send to an exchange",
    guideCta: "Read the guide",
  },
  /**
   * ADDITIVE (frozen-route import graph). Receiving money INTO your account — /add-money.
   *
   * The whole block exists to correct one belief people arrive with: that they need a memo, tag or
   * reference, because that is what every exchange asks for. They need one to pay INTO an exchange,
   * where thousands of customers share a single account. They need nothing to be paid here, because
   * the account is theirs alone. Said as a reason, so it stays true if the product changes.
   */
  receive: {
    title: "Add money",
    lead: "Money can reach you two ways: someone sends you a link, or someone sends straight to your account.",
    ownAccount: "Your money has its own account. Nobody has to say which one is yours.",
    noMemo:
      "So if a screen asks for a memo, a tag or a reference, leave it blank. That box exists for exchanges, where everyone shares one account. You don't share yours.",
    networkTitle: "Pick the right network",
    networkBody: (network: string) =>
      `Your dollars travel on ${network}. Whoever is sending has to choose that same network. Money sent on another one never arrives, and nobody can bring it back.`,
    reciprocal:
      "One thing worth knowing before you try: an exchange that can't send on this network can't send here either. It's the same road in both directions.",
    minimum:
      "Exchanges charge a fee to send and often refuse small amounts. Check their minimum. The first time, send a couple of dollars, wait for them to land, then send the rest.",
    testTitle: "These are practice dollars",
    testBody:
      "You're on a test network, so no exchange can send real money here yet. Two things do work today: someone sends you a Lumenia link, or someone else using Lumenia sends straight to the address below.",
    testFuture:
      "When Lumenia opens to real money, this is the screen you'll use. The practice dollars don't come with you.",
    addressLabel: "Your account",
    copyCta: "Copy address",
    copied: "Copied",
    qrShow: "Show code",
    qrHide: "Hide code",
    qrSep7: "For a wallet app",
    qrPlain: "Plain address",
    qrNote: "Scanning this fills in the address and the exact dollars. Pasting is safer at an exchange.",
    waiting: "Watching for money to arrive.",
    arrived: (usd: string) => `It's here. ${usd}.`,
    checkAgain: "Check again",
    faucetCta: "Get test money",
  },
  errors: {
    notFound: "This link is invalid or has expired.",
    generic: "Something went wrong. Please try again.",
    // For failed sends/pays: technical reasons (Horizon extras, status codes) must
    // never reach a money surface (vocabulary law). Honest: a rejected inner tx
    // means nothing moved.
    moneySafe: "We couldn't finish. Your money hasn't moved. Try again.",
    // Collect: the waiting money is already GONE (collected earlier, or the sender
    // reclaimed it after 7 days). Terminal, not retryable — the list refreshes so
    // the stale item disappears. Told calmly, never as "try again forever".
    collectGone: "This money is no longer waiting. It may already be in your account, or the sender took it back.",
  },
  /**
   * Feedback — the "report a problem" channel (FeedbackDialog → sponsor /feedback,
   * isolated store, contact optional). ADDITIVE-ONLY block: this file is in the
   * frozen claim route's import graph, so existing keys above never change.
   */
  feedback: {
    linkLabel: "Report a problem",
    somethingWrong: "Something wrong? Tell us.",
    title: "Report a problem",
    sub: "Tell us what went wrong. We read every note.",
    categoryLabel: "What is it about?",
    catClaim: "Receiving money",
    catSend: "Sending money",
    catRequest: "Asking for money",
    catMoney: "My money",
    catSite: "The website",
    catOther: "Something else",
    messageLabel: "What happened?",
    messagePlaceholder: "The more detail, the faster we can help.",
    contactLabel: "How can we reach you? (optional)",
    contactPlaceholder: "Email or phone, only if you want a reply",
    submit: "Send it",
    sending: "Sending…",
    cancel: "Cancel",
    close: "Done",
    done: "Thank you, we got it.",
    doneSub: "If you left a way to reach you, we'll follow up.",
    error: "We couldn't send that. Please try again.",
  },
} as const;
