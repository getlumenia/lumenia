# Leak audit: what a Lumenia link reveals, and to whom (SOW 2, D2)

Status: **written 2026-10-06 for the commit that adds it (`1bc2049`), updated 2026-10-09 for the
release after `24d0f4e` (merged that day; its commit and its deploys are the owner's).** Written for
SOW 2 deliverable D2 (d): "a written, tested leak audit - referrer policy, no secrets or amounts in
server logs or analytics, and a fix for mainnet beacons currently routed to the testnet worker".

One row per channel that a link, its amount or its sender's name can travel through: what the channel
carried before D2, what it carries now, and the proof (a file and line, a test that runs in CI, or
output pasted from production). "Now" means the code at the latest commit that changes this file.

D2 went live in production on 2026-10-07, with the `1bc2049` deploy (about 18:12 UTC). The nightly live
run [37774557675](https://github.com/getlumenia/lumenia/actions/runs/37774557675) (2026-10-08, against
https://getlumenia.com) passed its step "Private link preview (D2 leak audit, live half)": four
chat-preview bot user agents, an edited `?a=`, the amount read from the ledger, clean beacons and a
real claim. Rows 1, 2, 5, 6, 10 and 11 also name changes made in the release after `24d0f4e`,
merged on 2026-10-09 and held by the offline suites on the merged tree: no sender name in a new link
unless one is typed, `seeded=1` only on team-funded group links, a rich card only for a live drop or
pool, v1 practice beacons to the testnet Worker, and the sponsor's log redaction. The web half is
live since the deploy of `00aa0a5` on 2026-10-09 (the live claim, private-preview and send checks passed against
getlumenia.com that morning); row 11 holds on both Workers since their deploys of 2026-10-09 (testnet version `213a2832`, mainnet `baaeaae0`, both
tagged `215cfb2`); before that, a refused relay simulation, payout or sweep on mainnet could log a full address or an amount.

What this audit does not claim: the public ledger is public. Every deposit shows the sender's account,
the amount and the time; every claim shows the account that received it. D2 changes what the link, the
chat preview, the logs and the counters give away, not what the ledger records. The link's id is
public on the ledger next to the amount and the sender's account, and if that account holds an @name,
anyone with the id can find the name too, whether or not the link carries one (row 22). The part after
`#` keeps a name out of previews and logs, not out of reach. The public privacy page
(https://getlumenia.com/privacy) says so in plain language, and [ZK_SPIKE_REPORT.md](ZK_SPIKE_REPORT.md)
lists every place the amount stays public on chain.

## The link shapes

| Shape | Made by | URL |
|---|---|---|
| Private (the default) | /send, /group, the agent MCP, the mainnet demo script, the browser extension from 0.1.3; `&s=<name>` only when the sender types a name | `/v2/c/<linkHex>[?g=N][&n=public][&seeded=1][&src=ext]#<key>[&s=<name>][&g=N][&p=1]` |
| Rich (the sender's explicit choice) | /send and /group with "Show the amount and my name in chat previews" switched on; from the release after `24d0f4e`, `&s=` only when a name was typed | `/v2/c/<linkHex>?a=<amount>[&s=<name>][&g=N][&p=1][&n=public][&seeded=1]&preview=rich[&src=ext]#<key>[&g=N]` |
| Legacy (made before D2, still claimable) | links already sent; the extension 0.1.2, which the Chrome Web Store still serves until 0.1.3 replaces it there (addons.mozilla.org serves 0.1.3 since 2026-10-09) | `/v2/c/<linkHex>?a=<amount>&s=<name>[...]#<key>` |
| v1 practice link (testnet only) | /try, /event, the nightly regression | `/c/<id>?b=<balanceId>[&i=<issuer>]#<secret>&s=<name>` |

The builder is one function, `v2LinkUrl` (`apps/web/lib/lumendrop.ts:291`), over the pure fragment
helpers in `apps/web/lib/link-fragment.ts`; `apps/web/lib/link-privacy.selftest.ts` [a] holds every
shape (single, group, password, mainnet, seeded, ext, rich, hostile names) and runs in CI
(`.github/workflows/ci.yml`, "Web self-tests").

## Channels

| # | Channel | Before D2 | Now | Proof |
|---|---|---|---|---|
| 1 | **URL path and query** (seen by every server and bot that fetches the link, and logged by the host) | `a=` amount, `s=` sender name, `p=1`, `g=`, `n=public`, `seeded=1`, `src=` | Private links: only `g`, `n`, `seeded`, `src`, none personal; from the release after `24d0f4e`, /group writes `seeded=1` only on a link the team funded, never for an ordinary sender. The amount is nowhere in the link; a typed name and the lock marker are after `#`. Rich links: amount, and the name if one was typed, by the sender's choice. | `apps/web/lib/lumendrop.ts:291-314` (`v2LinkUrl`); `link-privacy.selftest.ts` [a], 51/51 in CI at `24d0f4e`, 74/74 on the merged tree (2026-10-09); the third builder `apps/sponsor/src/mainnet-demo.ts:165` moved to the private shape |
| 2 | **URL fragment** (`#...`) | the key | the key, then the name (`&s=`) only when the sender typed one, the share count, the lock marker. From the release after `24d0f4e` a new link carries no name unless one is typed: the "Sent as" field on /send and /group (and the extension's From field, from 0.1.3) starts empty, and an empty name writes no `s=`; before it, /send and /group filled in the sender's @name | Browsers and preview bots never send a fragment in a request (RFC 3986 section 3.5). The claim pages remove it from the address bar on load (`apps/web/app/v2/c/[linkHex]/V2ClaimButton.tsx:287`, `apps/web/app/c/[id]/ClaimButton.tsx:109`). The fragment IS in the chat message itself: whoever can read the chat can read the key and the name. That is stated on /privacy. The empty default is held by `test:linkprivacy` (the link shapes and a source check on the send screens, 74/74 on the merged tree) and, for the extension, by `test:url` |
| 3 | **Claim page body** (the HTML a bot downloads) | v2: amount at 60px and "<name> sent you money", from the query; v1: the same plus an indicative lira line | No amount and no name in the server HTML of a private link, the RSC payload included. For a legacy or edited link, Next.js copies the request's own query into its router data (`"c"`, `"q"`, the `__PAGE__?{...}` key), so those query values appear inside a script, never on screen or in a preview tag: the bytes the bot itself sent, nothing more; only a redirect could remove them, and it would break legacy names, so it was not done. The client reads the name from the fragment and the amount from the ledger: v2 from the escrow's `get_drop` / `get_pool` (`loadDrop`, `apps/web/lib/lumendrop.ts:1288`), v1 from the claimable balance on Horizon. "Reading the amount from the ledger", then "Verified on the ledger". | `apps/web/app/v2/c/[linkHex]/page.tsx:81` (the server hands the client only the link id, the share-count hint and the network; the ledger read is `V2ClaimButton.tsx:356`, "Verified on the ledger" at `:603`; the screen rules are `apps/web/lib/claim-ledger.ts`, `test:claimledger` 17/17 in CI); `apps/web/app/c/[id]/page.tsx:69` and `apps/web/app/c/[id]/ClaimView.tsx:88-99` (Horizon read, asked again for about 30 s pinned to the claimable USDC, `apps/web/lib/horizon.ts:308`; `test:horizon` 45/45 in CI with D2, 62/62 since D3, 71/71 on the merged tree); `apps/web/e2e/preview.spec.ts` (four bot user agents, no `$` followed by a digit, no sender name) |
| 4 | **Spoofed amount** (a forwarded link edited to `?a=999`) | rendered as $999.00 next to a working Claim button on our domain | `a` is never read for display, title, preview or button; the page shows the escrowed amount | `apps/web/lib/link-fragment.ts:170` `readClaimQuery` (reads `a` for presence only); `apps/web/e2e/preview.spec.ts` step 4 |
| 5 | **Metadata and preview card** (title, description, og:*, twitter:*) | "<name> sent you $X", og:image `/c/x/og?a=..&s=..` | One fixed set for every link that is not explicitly rich: title "Lumenia", the description "Someone sent you dollars by link. Open it to see the amount. No app, no sign-up, and the recipient pays no gas.", og:image `/og.png` (a static brand image); `robots: noindex`. Rich links: name from the query, amount read from the ledger on the server, never from `a=`; from the release after `24d0f4e`, only when the ledger answers with a live drop or pool for the id, so a made-up, spent or unreadable id gets the fixed set and no name is drawn. | `apps/web/lib/link-preview.ts` (`privateClaimMetadata`); `apps/web/app/v2/c/[linkHex]/page.tsx:37-46` -> `apps/web/lib/claim-metadata.ts:138` (`v2ClaimMetadata`, over `readLiveAmount` at `:77`); `apps/web/app/c/[id]/page.tsx:40-41`; `apps/web/lib/claim-metadata.selftest.ts` (`test:claimmeta`) 55/55 in CI at `24d0f4e`, 65/65 on the merged tree; `link-privacy.selftest.ts`; `preview.spec.ts` |
| 6 | **OG image route** `/c/[id]/og` | painted `a` and `s` from its own query for anyone | Paints only with `preview=rich`, a 64-hex link id and, from the release after `24d0f4e`, a live drop or pool behind that id on the ledger, which also gives the amount; anything else, a made-up id included, is a 307 to `/og.png`, kept at the edge for a minute | `apps/web/app/c/[id]/og/route.tsx:40-53` with `ogCard` (`apps/web/lib/claim-metadata.ts:214`), which joins `ogDecision` (`:176`) and `richCard` (`:196`); `test:claimmeta` 65/65 on the merged tree |
| 7 | **Referrer** (what a claim page tells the next site) | no-referrer on the claim routes | unchanged: `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex, nofollow` on `/c/:id`, `/c/:id/:path*`, `/v2/c/:linkHex`; `strict-origin-when-cross-origin` elsewhere | `apps/web/next.config.ts:116,128-148`; `link-privacy.selftest.ts` [c]; production headers below |
| 8 | **Vercel request logs** (the host records each request's path and query) | every v2 render and every preview fetch was logged with the amount and the name, e.g. `/v2/c/<id>?a=5&s=<name>` and `/c/x/og?a=5&s=<name>`, until this deploy | private links log `/v2/c/<id>` plus non-personal markers; their preview image is a static file served without a function call. Runtime-log retention depends on the Vercel plan (Hobby 1 hour, Pro 1 day, per vercel.com/docs/logs/runtime). | items 1, 5 and 6; nothing can unlog what was logged before the deploy, which is why it is stated here |
| 9 | **Vercel Web Analytics** | mounted only on the public site | unchanged: mounted only in the `(site)` layout, so the claim routes and the money screens send nothing to it | `apps/web/app/(site)/layout.tsx:39,89`; held by link-privacy: a source check that no other layout mounts the analytics (`test:linkprivacy`, added in the release after `24d0f4e`, 74/74 on the merged tree) |
| 10 | **Beacons** (our own counters, `/events`) | event name, hashed ids; mainnet claims were counted on the testnet Worker until 494739b / f7bf14d; v1 practice claims (always testnet money) went to the network the DEVICE was set to, so a device switched to Real money counted a practice claim on the mainnet Worker, until the release after `24d0f4e` | event name, `cid` and `aid` (SHA-256 cut to 8 bytes), `seeded`, a duration bucket, `src`: never a URL, a fragment, a name or an amount; each goes to the Worker of the LINK's network, v1 practice links included (always testnet). The Worker drops any field it does not name. | `apps/web/lib/events.ts:136-166`; `test:extseam` [f], "to the sponsor of the network named" (`apps/web/lib/ext-seam.selftest.ts:1154`, a mainnet-shaped network, 162/162 at `24d0f4e`, in CI; 175/175 on the merged tree); the v1 route's check, a practice claim on a device set to Real money counted on the testnet Worker (also `test:extseam`, added in the release after `24d0f4e`, within the 175/175); `link-privacy.selftest.ts` [b] (the body); `apps/sponsor/src/test-events.ts` [17] "handleEvent drops an unknown field such as amount" (80/80 in CI); `preview.spec.ts` step 5; the production tail below |
| 11 | **Sponsor logs** (Cloudflare Workers) | event lines: hashed ids only. On mainnet an error line carries the path and the refusal reason, and up to `24d0f4e` that reason could hold a full address and an amount: a refused relay simulation logged the RPC's diagnostic text (the sender's full address, the link id and the amount), a refused `/payout` or `/sweep` logged its anti-drain reason word for word (full addresses and amounts), and the other anti-drain reasons named the full account or destination of the refused transaction | event lines carry hashed ids only (`apps/sponsor/src/lib/events.ts:211`). On testnet a refusal's reason is returned to the caller and not logged. On mainnet the caller gets "request failed" and a reference, and the error log keeps one line with the path, the reference and the reason. From the release after `24d0f4e` that line is redacted: every full G, C or M address in it is cut to its first four characters, and nothing after its first line is kept (`oneLogLine` in `apps/sponsor/src/lib/soroban-relay.ts`, which the mainnet error handler in `apps/sponsor/src/worker.ts` runs on every reason); a refused Soroban simulation on `/v2-deposit`, `/v2-claim`, `/v2-reclaim` and `/cctp-relay` carries only the HostError's first line, at most 200 characters, so the event log that replayed the sender's address, the link id and the amount is gone (`simErrorHead`, same file); a refused `/payout` or `/sweep` names the rule that tripped and never the amount, its addresses cut to four characters (the payout and sweep reasons in `apps/sponsor/src/lib/anti-drain.ts`); a Horizon refusal keeps its result codes and drops `envelope_xdr` and `result_xdr` (`extrasDetail` in `apps/sponsor/src/lib/stellar.ts`). The other anti-drain reasons still say which rule a refused transaction broke, as the audit trail of an attempted drain, but on mainnet no full address reaches the log line. **Live on both Workers since their deploys of 2026-10-09** (testnet, mainnet version `baaeaae0`, both tagged `215cfb2`); a refusal-only run against the new mainnet Worker answered every refusal `request failed` with a reference (readiness report D3.3, Run 5). Stated, not changed: the pilot application logs the wallet, and the applicant's contact when no mailer is configured or the mail is refused (`notifyPilotRequest` in `apps/sponsor/src/lib/pilot-request.ts`), and the real-money interest note logs the contact the same way (`notifyPilotInterest`), by design, stated on /privacy; an approval or rejection mail that cannot be sent now logs the wallet only (`notifyPilotApproved`, `notifyPilotRejected`); the waitlist and feedback fall back to the log when the store is unreachable (`waitlist.ts:39,47`, `feedback.ts:154,162`). | the functions named; the redaction is held by `test:soroban-relay` and `test:antidrain` (163/163 and 82/82 on the merged tree, run locally; both suites run in CI) |
| 12 | **Pilot status** | not covered before | the web app asks the real-money Worker `GET /pilot-status?pubkey=<account>` when a page loads and about once a minute while the tab is visible, for any account, on practice money too: the full public key is in the request URL (seen in the tail below). Stated on /privacy, not changed. | `apps/web/lib/wallet.tsx:253` (the ask) and `:274` (the minute poll), the URL built in `apps/web/lib/pilot-access.ts:84` (`askPilotStatus`) |
| 13 | **Recovery calls** | | by design every backup and restore call goes to the practice-money Worker on both networks, so one backup serves both: a ciphertext box keyed by a SHA-256 of the email; the email itself is used once to send a code | `apps/web/lib/recovery-api.ts:16,96-104` |
| 14 | **Third parties on the claim routes** | none | none: CSP `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'` (no remote script origin; `unsafe-inline` is Next's inline hydration payload), `connect-src` limited to our two Workers and the public Stellar servers (Horizon and Soroban RPC on both networks), `img-src 'self' data: blob:`, no webfont host, no analytics | `apps/web/next.config.ts:97-101`; held by link-privacy: checks on the CSP that `next.config.ts` serves (`script-src`, `connect-src`, `img-src`; `test:linkprivacy`, added in the release after `24d0f4e`, 74/74 on the merged tree); production header below. The Stellar servers see the IP and the link or account being read, as any server does |
| 15 | **Service worker** | none | none registered | `git grep -n serviceWorker -- apps/web` returns nothing, and `apps/web/public` holds no service-worker script (checked 2026-10-06) |
| 16 | **Sender's device** | | the full link with its key, encrypted in IndexedDB `lumenia-links` (`apps/web/lib/sent-links.ts`); `lumenia.sent` in localStorage holds amount, name and link id per network, no key (`sent-links.ts:120`); the claim latch holds the payout account per link id (`apps/web/lib/lumendrop.ts:984`). **Stated exception:** `/try` keeps the whole practice link, key included, in `sessionStorage` for that tab so a reload can offer it again (`apps/web/app/(site)/try/MintButton.tsx:70`); testnet practice money, tab-scoped. | the files named |
| 17 | **Share text** | "<name> sent you money ... Tap to receive it:" above the link | "I sent you money ... Tap to receive it:", no name and no amount, for every link | `apps/web/components/brand/LinkReadyCard.tsx` |
| 18 | **Request links** (asking someone to pay you) | the asked amount and the asker's name in `/r/<id>?a=..&n=..`, a preview titled "<name> is asking for $X", and share texts that name both | **unchanged, outside D2:** a request holds no money and the payer's screen needs the amount and the name; stated on /privacy. Same fix available later (fragment + fixed preview). | `apps/web/lib/request.ts:70-74`; `apps/web/app/(app)/r/[id]/page.tsx:22-25`; `apps/web/app/(app)/split/page.tsx:154` |
| 19 | **The extension packages already in the stores** | | 0.1.2, still served by the Chrome Web Store (and by addons.mozilla.org from 2026-10-07 until 0.1.3 replaced it there on 2026-10-09), bundles the pre-D2 builder, so its links keep the legacy shape until 0.1.3 replaces it in the Chrome Web Store too; the claim page treats those as legacy (fixed preview, ledger amount, the name from `?s=` for display). 0.1.3 was built on 2026-10-09 (the readiness report's Published builds has its hashes): `/v2/c/<id>?[n=public&]src=ext#<key>[&s=<typed name>][&p=1]`, no amount anywhere, no name unless one is typed, and the name 0.1.2 saved is deleted at startup. addons.mozilla.org approved it on 2026-10-09 (public since 08:36 UTC); the Chrome Web Store upload is the owner's, and that store reviews it before it goes live | `apps/extension` builds from `apps/web/lib`; the new shape is pinned by `apps/extension/test/url.selftest.ts` (`test:url`, 235/235 at `24d0f4e`, 359/359 on the merged tree; in CI) |
| 20 | **A practice link's key** (v1, testnet, /try and /event) | the server makes the key in a practice link (`apps/sponsor/src/lib/demo-link.ts:34`) and the v1 claim kept that same key as the device's account, which became the home account on a first claim, so anyone who saw the link (a QR code on the event board included) held the home account's key; the keystore is not split by network | **fixed 2026-10-07 for every new claim:** the link's account is always kept as a throwaway, and the keystore never adopts a throwaway as home (`apps/web/lib/keystore.ts` `adoptsHome`); on a device with no home, a home is made from a key generated on the device and the money is moved into it before the next buttons show (`apps/web/lib/claim-home.ts`, wired in `apps/web/app/c/[id]/ClaimButton.tsx`). A device that adopted a link's account as home before the fix keeps it; /privacy says not to receive real money into it. | `test:claimhome` 22/22 (CI); `apps/web/e2e/claim.spec.ts` step 5 asserts the home account after a claim is not the link's key (nightly) |
| 21 | **The sponsor and the amount** | reads it | still reads it, on purpose: the caps ($5 a link, $25 a day per sender, $50 a day across the whole pilot) need the amount from the transaction it fee-bumps (SOW 2 out-of-scope list: amounts are not hidden from our own sponsor) | `apps/sponsor/src/lib/soroban-relay.ts` (canary cap on the deposit) |
| 22 | **Lookups by link id** (anyone holding the part before `#`: the host's logs, every preview bot, the chat server) | not covered before | stated, not changed (hiding amounts on chain is out of SOW 2's scope on mainnet): the escrow's `get_drop(link)` is a free read-only call any RPC answers, and returns the sender's account, the amount, the expiry and whether it was claimed; the escrow's deposit event keeps the link id next to the sender and the amount for good; `GET /handle-of?pubkey=<account>` on either Worker returns that account's @name, with no sign-in. So the link id leads to the amount and the sender's account, and to the sender's @name when the account holds one, whether or not the link carries a name | `contracts/lumen-drop/src/lib.rs:291` (`get_drop`) and `:118`, `:236` (`DepositEvent`); `apps/sponsor/src/worker.ts:871` (`/handle-of`); `apps/sponsor/src/lib/handles.ts:327` (`handleOf`) |

## Production evidence

Headers, `curl -sS -D -`, 2026-10-04 20:41:35 GMT (the claim-route headers predate D2 and are unchanged
by it):

```
https://getlumenia.com/v2/c/0000000000000000000000000000000000000000000000000000000000000000
HTTP/2 200
content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self' https://lumenia-sponsor.avakit.workers.dev https://lumenia-sponsor-mainnet.avakit.workers.dev https://horizon-testnet.stellar.org https://horizon.stellar.org https://soroban-testnet.stellar.org https://mainnet.sorobanrpc.com; worker-src 'self' blob:; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; upgrade-insecure-requests
referrer-policy: no-referrer
strict-transport-security: max-age=63072000; includeSubDomains; preload
x-content-type-options: nosniff
x-frame-options: DENY
x-robots-tag: noindex, nofollow

https://getlumenia.com/c/x
HTTP/2 404
referrer-policy: no-referrer
x-robots-tag: noindex, nofollow
```

The beacon routing fix, on production: both Workers tailed (`npx wrangler tail <worker> --format json`)
during one run of `apps/web/e2e/send.spec.ts` against getlumenia.com, 2026-10-04 20:42:37Z to
20:43:23Z (a practice link claimed, $0.20 sent on as a v2 link, that link claimed). Every counter went
to the testnet Worker, none to the mainnet one, and each line is an event name and hashed ids:

```
lumenia-sponsor (testnet), /events:
2026-10-04T20:42:48.753Z POST /events 200 | [event] {"event":"claim_opened","cid":"c2e2dd2d59fa2c9d","aid":null}
2026-10-04T20:43:02.622Z POST /events 200 | [event] {"event":"claim_succeeded","cid":"c2e2dd2d59fa2c9d","aid":"7a26a04eab89a795"}
2026-10-04T20:43:04.694Z POST /events 200 | [event] {"event":"send_started","cid":"7a26a04eab89a795","aid":"7a26a04eab89a795"}
2026-10-04T20:43:13.160Z POST /events 200 | [event] {"event":"send_link_created","cid":"7a26a04eab89a795","aid":"7a26a04eab89a795"}
2026-10-04T20:43:13.984Z POST /events 200 | [event] {"event":"claim_opened","cid":"6652eb3acaee6acd","aid":null}
2026-10-04T20:43:22.999Z POST /events 200 | [event] {"event":"claim_succeeded","cid":"6652eb3acaee6acd","aid":"a9b1ebd17a39c8a9"}

lumenia-sponsor-mainnet, same window: no /events; one request
2026-10-04T20:43:03.801Z GET /pilot-status?pubkey=GAPNRJHI635F3M6WAEUOSGIGKBBIDT4V6FDRK6KCETI3NNSIQHNZ6RU6 200   (row 12)
```

The mainnet direction (a real-money claim counted on the mainnet Worker) has not been shown on
production yet. The mainnet Worker's `/events/summary` holds one `claim_opened` (2026-09-19) and no
`claim_succeeded` (read 2026-10-09). That one count cannot be attributed to a mainnet link: before the
row 10 fix, a device switched to Real money that opened a v1 practice link made the same count. The
first attributable proof is the metric 2 claim: `sh ops/events-snapshot.sh` before and after it, where
the mainnet `claim_opened` and `claim_succeeded` must each move by one. That reading goes into the
readiness report's D2.5 with the run.

## How to re-run

```bash
pnpm --filter @lumenia/web test:linkprivacy     # URL shapes, beacon body, claim-route headers, analytics scope, the CSP (CI)
pnpm --filter @lumenia/web test:extseam         # incl. [f] a beacon goes to the sponsor of the network named (CI)
pnpm --filter @lumenia/sponsor test:events      # incl. [17] unknown fields such as amount are dropped (CI)
pnpm --filter @lumenia/sponsor test:soroban-relay   # incl. the mainnet log redaction of row 11 (CI)
pnpm --filter @lumenia/extension test:url       # the extension's links, private by default (CI)
pnpm --filter @lumenia/web test:claimmeta       # metadata + OG decisions, the rich amount from the ledger (CI)
pnpm --filter @lumenia/web test:claimledger     # what the claim screen may say about the amount (CI)
pnpm --filter @lumenia/web exec playwright test e2e/preview.spec.ts   # live, testnet (nightly in e2e.yml)
pnpm --filter @lumenia/web exec playwright test e2e/private-variants.spec.ts   # a locked and a group link (on demand)
```
