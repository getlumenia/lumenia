# Lumenia browser extension

Send dollars to anyone by link, from any page, and see whether the link was claimed. The person
you pay opens the link on getlumenia.com: no wallet, no app, no extension, and they pay no gas
(Lumenia's sponsor covers the network fee). The recipient's side does not change in any way.

This is the sender's surface only. It is a small Chrome MV3 / Firefox MV3 extension that reuses
the website's own sender code (`apps/web/lib`) instead of re-implementing anything that moves
money.

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
  recipient must also know a password you tell them some other way.
- **Pastes the link where you are**: right-click a text box (WhatsApp Web, Telegram Web, Gmail,
  any ordinary field) and choose "Paste a Lumenia link here"; once the link exists it is inserted
  into that box. It only inserts text: it never presses Send, never reads the clipboard, and sends
  nothing from the page (the one thing it looks at is the box it typed into, to tell you whether the
  link landed).
- **Shows each link's status**: Waiting, Claimed, Reclaimable (unclaimed after 7 days: you can
  take it back), Reclaimed, Closed (claimed or taken back, when we cannot tell which), Uncertain
  (sent but not confirmed yet) or Didn't go through.
- **Practice money by default** (Stellar testnet), switched in one tap with the Practice | Real
  switch that is always at the top of the popup. **Real money** (mainnet) only for accounts the
  invite-only pilot approved, capped at $5 per link and $50 per day, only with a password-locked
  account, after a one-time note that this is an early preview not yet reviewed by an outside
  security firm. The worker checks all of that again before it changes the money.
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
| The list of links you made | `storage.local` | Amount, link id, network, status, transaction hashes. Never the link's secret |
| Settings | `storage.local` | Network, auto-lock, default "from" name, consent time |

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
carries the public marker `&src=ext` in its query (never in the fragment), so a link from the
extension can be told apart; it identifies nobody.

## Permissions

| Permission | Why |
|---|---|
| `storage` | The settings, the list of your links, and the unlocked key in session memory |
| `alarms` | The auto-lock, and re-checking open links once a minute |
| `contextMenus` | "Paste a Lumenia link here" on editable fields |
| `activeTab` + `scripting` | Inserting the link into the field you picked, only after you clicked the menu item or the toolbar button |
| Host permissions (exactly the six hosts above) | Lumenia's two sponsor servers and Stellar's public Horizon and RPC endpoints; nothing else, no `<all_urls>` |

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
- The amount and the optional "from" name are in the link's query, visible to anyone who sees the
  link (and to the page you paste it into); only the secret is in the `#fragment`.
- The link is pasted into whichever box has focus, on the page and in the frame you picked, at the
  moment the link is ready; if that page has since moved to another site, nothing is pasted.
  Pasting was tested on a plain text box, a text area, a one-line field and the Lexical editor
  (the one WhatsApp Web is built on), not on WhatsApp Web, Telegram Web or Gmail themselves.
- The escrow contract can be upgraded by its owner (on real money, a 2-of-3 multisig whose three
  keys one person holds today) and has not been reviewed by an outside security firm. Its current
  code gives the owner no way to move escrowed money; an upgrade would replace that code.
- The real-money rule that the account must be password-locked is checked here, exactly as the
  website checks it; the sponsor does not check it. The pilot allowlist and the caps are enforced
  by the sponsor.
- On Firefox, host permissions can be withheld by the user; the extension asks for exactly the six
  hosts before it can do anything.
- Firefox in permanent private browsing mode ("Never remember history") refuses IndexedDB to
  extensions, so the encrypted key and the kept links cannot be stored there and the account cannot
  be connected. Ordinary windows, and private windows of a normal profile, are not affected (the
  extension does not run in private windows unless you allow it).
