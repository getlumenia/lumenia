# Lumenia browser extension

Send dollars to anyone by link, from any page, and see whether the link was claimed. The person
you pay opens the link on getlumenia.com: no wallet, no app, no extension, and they pay no gas
(Lumenia's sponsor covers the network fee). The recipient's side does not change in any way.

This is the sender's surface only. It is a small Chrome MV3 / Firefox MV3 extension that reuses
the website's own sender code (`apps/web/lib`) instead of re-implementing anything that moves
money.

This folder is version **0.1.3**. Both stores still serve 0.1.2 until 0.1.3 has been submitted and
has passed their review; "Published builds" below says what each published version does
differently from this source.

## Install

- Chrome Web Store: https://chromewebstore.google.com/detail/lumenia-send-dollars-by-l/ccdnjnckaldkmjnlpgpmdmnbajmakhmn
- Firefox (140 or newer), addons.mozilla.org: https://addons.mozilla.org/en-US/firefox/addon/lumenia/
- From this source: see "Build, test, run" below (Load unpacked / Load Temporary Add-on).

## Published builds

| Version | Where | Public since | Built from | Package sha256 | The links it makes |
|---|---|---|---|---|---|
| 0.1.3 | Chrome Web Store and addons.mozilla.org (listed) | pending: not submitted yet | this source | recorded when it is submitted | Private: `/v2/c/<id>?[n=public&]src=ext#<key>[&s=<name>][&p=1]`. No amount anywhere in the link, and a name only when the sender types one, after the `#` |
| 0.1.2 | Chrome Web Store | 2026-10-06 | commit `062725f` | CRX as served on 2026-10-09: `0a62ccc9736aa6b2c40b0f2895ee099c184f9f61855b364f26f099bad43e85a7` | Pre-D2: `/v2/c/<id>?a=<amount>&s=<name>[&p=1][&n=public]&src=ext#<key>`, the amount and the name in the query (the name is "Someone" when none was typed) |
| 0.1.2 | addons.mozilla.org (listed) | 2026-10-07 | commit `062725f` | signed file AMO serves: `988e3c69014d041b79288b06af5c56e24ede379a221a68d6753d7a12b15103a0` | Pre-D2, as above |
| 0.1.1 | Firefox, unlisted (signed by Mozilla), self-hosted at getlumenia.com/extension/lumenia-firefox.xpi | 2026-10-04 | commit `3d80c78`, the same code as 0.1.2 apart from its version string | `792667fbce088a10fe5e71287f27fc305dac49684486a53eda1e081764e2039e` | Pre-D2, as above |

What the published 0.1.2 (and 0.1.1) does differently from this source, besides the link shape:

- The From field is filled with the name typed for the previous link, so a link carries a name
  unless the sender clears it. Here it starts empty for every link.
- A take-back the sponsor accepted but the ledger had not shown yet (a 202 answer) is listed as
  Reclaimed. Here it stays open until the ledger shows it.
- An account made in the extension and never backed up is not stopped from switching to real money
  by the extension itself (the pilot's approval is what stands in the way). Here it is.
- A busy network reads as "Sending is paused right now", the same words as the operator's pause.
  Here the pause, a busy network and a spent daily fee budget are three different messages.
- The real-money note leaves out "you can lose money", and the caps line gives the whole pilot's
  $50 day as if it were one sender's limit (one sender's is $25).

To rebuild a published version, check out the commit in the table and follow "Build, test, run";
the build reads the version from `package.json`, so the zips come out under that version's number.

## What it does

- **Starts with one question.** The first screen is the landing page's opening ("Hey, I've got a
  message for you.") and one button, Get started; after a short note on what leaves the browser
  (agreed once), it asks: do you already have a Lumenia account?
- **Makes a new account right here** ("No, I'm new here"): you pick a password (held to the
  website's own floor: at least 10 characters, not a common or patterned one), the key is made and
  locked in this browser, and practice dollars are added on the spot (the sponsor opens the account
  on the test network, no XLM needed, and its faucet pays it). Until you back it up with your email
  (one screen: email, then the mailed code), the account lives only in this browser, and the
  extension says so.
- **Or brings your existing account here** ("Yes, bring it here") from your own backup: your
  email, the one-time code we mail you, and your backup password. A passkey-only backup opens on
  getlumenia.com only; add a password there first.
- **Makes a payment link**: the amount goes into the Lumenia escrow (a Stellar smart contract)
  behind a fresh link key whose secret lives only in the link's `#fragment`. Optionally the
  recipient must also know a password you tell them some other way. The link carries no amount (the
  claim page reads it from the escrow) and no name unless you type one in From, which starts empty
  for every link; then the extension says where it goes: "Your name travels inside the link, after
  the #. Anyone who can read the chat can read it."
- **Pastes the link where you are**, from any text box on any page, in a few taps: right-click the
  box and choose "Paste a Lumenia link here" (the popup opens; where a browser does not open it from
  the menu, a badge on the toolbar button asks for a click), unlock it if it has locked itself,
  enter the amount (and on real money the link's password, which is on by default there), then Make
  the link; once the link exists it is inserted into that box. It only inserts text: it never
  presses Send, never reads the clipboard, and sends nothing from the page (the one thing it looks
  at is the box it typed into, to tell you whether the link landed). Where it was tried, and where
  not: see "Known limits".
- **Shows each link's status**: Waiting, Claimed, Reclaimable (unclaimed after 7 days: you can
  take it back), Reclaimed, Closed (claimed or taken back, when we cannot tell which), Uncertain
  (sent but not confirmed yet) or Didn't go through.
- **Practice money by default** (Stellar testnet), changed with the Practice | Real switch that is
  always at the top of the popup. **Real money** (mainnet) only for accounts the invite-only pilot
  approved, only with a password-locked account that is backed up (one made here needs its backup
  first), and only after this one-time note: "Real money on Lumenia is an early pilot. It has not
  been reviewed by an outside security firm yet. You can lose money, so keep amounts small." It is
  capped at $5 a link and up to $25 a day from you ($50 a day across the whole pilot). The worker
  checks all of that again before it changes the money, and the sponsor enforces the pilot and the
  caps.
- **Works with the website**: an account backed up here opens on getlumenia.com ("Yes, bring it
  here"), and one made on the website opens here the same way; getlumenia.com/extension is where
  the website points people to install it.

## What it never does

- It never holds your money. Your dollars are in your Stellar account and, once sent, in the
  escrow on the ledger. Lumenia's servers relay transactions and pay fees; they cannot move escrowed
  money anywhere except to the claimer or back to you.
- It never puts your money in the escrow twice on its own. A send whose outcome is unknown is
  marked Uncertain and settled by reading the escrow, never by sending again (a retry would create
  a second link). While one is unconfirmed, a new link needs your explicit "Send a new one anyway".
- It never calls a send "didn't go through" on one look: that takes two empty reads of the escrow
  past the send's deadline plus five minutes, and it looks once more an hour later in case it was
  wrong.
- It never loads remote code, never uses `eval`, never injects anything into a page you did not
  invoke it on, and declares no content scripts and no `externally_connectable`.
- It never collects browsing history or page content, and has no analytics library.

## What it stores, and where

| What | Where | Form |
|---|---|---|
| Your account key | IndexedDB `lumenia` (this extension only) | Encrypted: Argon2id from your password, then AES-256-GCM (`apps/web/lib/keystore.ts`, the website's own code) |
| A new account's backup, until you back it up | `storage.local` | The password copy of the key (Argon2id + AES-GCM, the website's own backup format), ciphertext only; removed once it is stored on Lumenia's server |
| The unlocked key, while unlocked | `storage.session` (memory only) | Removed on Lock, after 5/15/60 minutes without use (default 15), and when the browser closes |
| Each full link (with its secret) | IndexedDB `lumenia-ext-links` | AES-256-GCM under a key derived from your account key (HKDF-SHA-256) and bound to the link's id. That key is never stored: the links can be read back only while the extension is unlocked (`src/lib/sealed.ts`) |
| The list of links you made | `storage.local` | Amount, link id, network, status, transaction hashes, and the name you typed for that link, if any. Never the link's secret |
| Settings | `storage.local` | Network, auto-lock, whether the real-money note was accepted, consent time. No default "from" name: 0.1.2 and earlier kept the last one, and this version removes it when it starts |

"Forget this account" in Settings removes all of it. If the account was made here and never backed
up, it first says that forgetting it deletes the account and any money in it for good, and offers
the backup instead. If links you made here are still open (being made, waiting, reclaimable or
unconfirmed), it says how many and how much, because this browser holds the only list of them and
the only way to take them back: take them back first, or choose to forget anyway. Your money stays where it is, and your backup on getlumenia.com can
restore the account again.

## What it sends, and to whom

| When | What | To |
|---|---|---|
| Restoring your account | Your email address, then the 6-digit code | `lumenia-sponsor.avakit.workers.dev` (`/recovery-otp`, `/recovery-fetch`; returns ciphertext only) |
| Backing up an account made here | Your email address, then the 6-digit code, the backup ciphertext, and a signature from the account that binds the stored backup to it | `lumenia-sponsor.avakit.workers.dev` (`/recovery-otp`, `/recovery`) |
| Practice dollars (practice money only) | Your public key, and for a new account the signed "open the account and add the dollar line" transaction the sponsor built | `lumenia-sponsor.avakit.workers.dev` (`/create-account`, `/faucet`) |
| Sending or taking back | The signed transaction (your public key, the amount, the link id) | The network's sponsor: `lumenia-sponsor.avakit.workers.dev` (practice) or `lumenia-sponsor-mainnet.avakit.workers.dev` (real money) |
| Real money only | Your public key, to ask whether the pilot approved it (at most once a minute on its own; pressing Real money asks again, never more often than every 10 seconds) | `lumenia-sponsor-mainnet.avakit.workers.dev/pilot-status` |
| After you agree on first run (on Firefox, only while you keep its optional "technical and interaction data" permission) | Usage counters: an event name, two one-way SHA-256 hashes cut to 8 bytes (of your account and of the link: pseudonymous, not anonymous, since anyone holding the address can compute the same hash), and the marker `src: "ext"`. Never a URL, never a link secret, never an address | The network's sponsor, `/events`, which keeps counters and hashed-id sets, no event log |
| Showing balances and statuses | Public reads of your account and of the escrow | `horizon-testnet.stellar.org`, `horizon.stellar.org`, `soroban-testnet.stellar.org`, `mainnet.sorobanrpc.com` |

Our servers see the IP address of each request and use it for rate limiting. Every link made here
carries the public marker `src=ext` in its query (never in the fragment), so a link from the
extension can be told apart; it identifies nobody.

## Permissions

| Permission | Why |
|---|---|
| `storage` | The settings, the list of your links, and the unlocked key in session memory |
| `alarms` | The auto-lock, and re-checking open links once a minute |
| `contextMenus` | "Paste a Lumenia link here" on editable fields |
| `activeTab` + `scripting` | Inserting the link into the field you picked, only after you clicked the menu item or the toolbar button |
| Host permissions (exactly the six hosts below) | Lumenia's two sponsor servers and Stellar's public Horizon and RPC endpoints; nothing else, no `<all_urls>` |

`host_permissions`, the same in both manifests (`build.mjs` fails the build on any other list):

```text
https://lumenia-sponsor.avakit.workers.dev/*
https://lumenia-sponsor-mainnet.avakit.workers.dev/*
https://horizon-testnet.stellar.org/*
https://horizon.stellar.org/*
https://soroban-testnet.stellar.org/*
https://mainnet.sorobanrpc.com/*
```

The content security policy of every extension page is `script-src 'self' 'wasm-unsafe-eval';
object-src 'self'; connect-src 'self'` plus exactly the six hosts above, then `img-src 'self';
frame-src 'none'; form-action 'none'; base-uri 'none'`: a library that tried to reach any other host
would be stopped by the browser. The `wasm-unsafe-eval` is for one library: `hash-wasm` 4.12.0
(MIT), which computes Argon2id with a WebAssembly module it ships as a base64 string inside its own
JavaScript. That base64 is the library's published form, unmodified; it is used only to turn your
password into the key that encrypts your account key.

## Build, test, run

```bash
pnpm install                                   # from the repo root
pnpm --filter @lumenia/extension typecheck     # tsc, including the apps/web/lib files it reuses
pnpm --filter @lumenia/extension test          # offline self-tests (no network, no keys)
pnpm --filter @lumenia/extension build         # dist/chrome, dist/firefox, and one zip each
pnpm --filter @lumenia/extension lint:firefox  # web-ext lint on the Firefox build
pnpm --filter @lumenia/extension sources       # also the sources zip AMO asks for
pnpm --filter @lumenia/extension build-for-amo # what an AMO reviewer runs: the same build
```

Build environment: macOS or Linux (the build calls `zip` and `find`; Ubuntu 24.04 ships both).
Exact toolchain for a byte-identical rebuild (AMO compares the rebuilt Firefox files with the
uploaded ones): Node 24, pnpm 9.12.0 (`corepack enable && corepack prepare pnpm@9.12.0 --activate`),
`pnpm install --frozen-lockfile` at the repository root (the lockfile pins every package), then
`pnpm --filter @lumenia/extension build`. The unminified bundle keeps esbuild's module path comments
(`// ../../node_modules/.pnpm/...`), which match only with the same repository layout and pnpm, so
build from the sources zip as unpacked, not from a re-arranged copy.

The build is esbuild (`build.mjs`): one classic IIFE bundle per entry (a service worker may not
use dynamic `import()`), not minified, with every `process.env` value the reused library reads
defined at build time. It fails if a bundle still reads `process.env` or contains `eval(`,
`Function(`, a string passed to a timer or to `.constructor(`, `importScripts(`, `import(`, or HTML
assigned from a string (the one allowed occurrence is Preact's own `dangerouslySetInnerHTML` branch,
which no source here uses: the build also fails on that word under `src/`); if a manifest asks for
any permission beyond the five, any host beyond the six, an optional permission or a web-accessible
resource; or if the CSP differs from the one above. It prints every URL in the output.

To try it: `chrome://extensions` -> Developer mode -> Load unpacked -> `apps/extension/dist/chrome`;
in Firefox, `about:debugging` -> This Firefox -> Load Temporary Add-on -> `dist/firefox/manifest.json`.

`e2e/create.e2e.mjs` makes a NEW account in the extension on testnet (practice dollars arrive on
their own), sends $0.10 that is claimed on getlumenia.com, backs the account up with a disposable
inbox, and restores it in a fresh browser profile to the same address.

`e2e/testnet.e2e.mjs` runs the whole flow on testnet against the live website (practice money,
network-dependent, about six minutes): a practice account backed up on getlumenia.com with a
disposable inbox, restored in the extension, a $0.10 link sent and claimed in a browser with no
extension, the list showing Claimed, and a second link taken back after its expiry. It needs
`node build.mjs --e2e-ttl=180` first; that build expires links after 180 seconds and is never
packaged.

`e2e/ui.e2e.mjs` drives the same flow through the popup's own screens and takes the store
screenshots on the way. All three check that a link they made has no amount and no name in its
query (no `a`, no `s`); create and ui also check that a link made without typing a name carries
none at all, and testnet and ui that a typed name rides after the `#`. Their last recorded runs
(2026-10-03) predate the private link shape; those checks were added for 0.1.3.

## Known limits, stated plainly

- An account made in the extension exists only in this browser until it is backed up. If the
  browser profile is lost before that, the account and its money are lost with it.
- Links made here are listed here; links made on getlumenia.com are listed there. There is no
  shared list.
- The escrow marks a claim and a take-back the same way, so the list says only what it knows:
  "Reclaimed" needs this extension's own confirmed take-back; "Claimed" means the money left the
  escrow and no take-back of ours can be involved; "Closed" means one of the two happened and we
  cannot tell which (a take-back was sent and its answer was lost). Your balance shows which.
- Take an unclaimed link back within three weeks of its expiry. After that the ledger archives the
  untouched entry (about 30 days after sending on practice money, longer on real money), and this
  version cannot restore it to take the money back.
- From 0.1.3, the amount is not in the link at all: the claim page reads it from the escrow. A link
  carries a name only when you type one in From, which starts empty for every link; the claim page
  then says "Someone". A typed name rides in the `#fragment` next to the secret, which a browser
  never sends to the claim page's server, so the name stays out of its logs and out of a chat app's
  link preview. Anyone who sees the whole link (the chat service it travels through, and the page
  you paste it into) can still read it, just as they can read the secret. Links made by 0.1.2 and
  earlier, the versions in the stores until 0.1.3 is live there (see "Published builds"), carry the
  amount and the name in the query instead; getlumenia.com/privacy says the same.
- The link is pasted into whichever box has focus, on the page and in the frame you picked, at the
  moment the link is ready; if that page has since moved to another site, nothing is pasted. An
  automated browser cannot make a real right-click, so the tests call the menu item's handler
  directly. That way the paste was tested on a local test page (a plain text box, a text area, a
  one-line field) and on the Lexical playground (the editor WhatsApp Web is built on), not on
  WhatsApp Web, Telegram Web or Gmail themselves.
- The escrow contract can be upgraded by its owner (on real money, a 2-of-3 multisig whose three
  keys one person holds today) and has not been reviewed by an outside security firm. Its current
  code gives the owner no way to move escrowed money; an upgrade would replace that code.
- The real-money rules that the account must be password-locked and, when it was made here, backed
  up are checked here, exactly as the website checks them; the sponsor checks neither. The pilot
  allowlist and the caps ($5 a link and up to $25 a day from you, $50 a day across the whole pilot)
  are enforced by the sponsor.
- On Firefox, host permissions can be withheld by the user; the extension asks for exactly the six
  hosts before it can do anything.
- Firefox in permanent private browsing mode ("Never remember history") refuses IndexedDB to
  extensions, so the encrypted key and the kept links cannot be stored there and the account cannot
  be connected. Ordinary windows, and private windows of a normal profile, are not affected (the
  extension does not run in private windows unless you allow it).
