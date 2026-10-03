# SOW 2 readiness report (DRAFT)

Status: **draft, 2026-10-03.** This file collects the evidence for the follow-on SOW deliverables
as each one lands. Today it holds D1 (the sender-side browser extension): its security checklist,
the tests behind it, the live testnet proof, and what is not verified yet. The D3 sections (the
hardening suite and the scripted adversarial run against the mainnet sponsor) are added when that
work is done.

Everything below can be checked from the public repository at the commit that adds this file:
each checklist line names the file and line that enforces it, and each transaction hash opens on
stellar.expert.

---

## D1. The browser extension

`apps/extension`: a Chrome MV3 / Firefox MV3 extension that makes a Lumenia payment link from the
sender's own account and shows whether it was claimed. It reuses the website's sender code
(`apps/web/lib`); the recipient side does not change. Version 0.1.0.

### D1.1 Security checklist

Every line is enforced by the file and line named. "Build" means the build refuses to produce a
package when the rule is broken; "Test" names the offline suite that holds it.

| # | Rule | Enforced at | Held by |
|---|---|---|---|
| 1 | No remote code. Every script is bundled; extension pages run only `'self'` scripts plus WebAssembly (`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`). | `apps/extension/manifest.chrome.json:36`, `apps/extension/manifest.firefox.json:35`, `apps/extension/build.mjs:74` | Build: `build.mjs:201` refuses any other CSP |
| 2 | Network access limited by the browser to six hosts (the two sponsor Workers, Horizon and RPC on both networks): `connect-src 'self'` plus those six; `host_permissions` exactly the same six; no `<all_urls>`. | `build.mjs:74`, `build.mjs:198`, `build.mjs:200` | Build |
| 3 | Images only from the package; no frames, no form submissions, no `<base>` (`img-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'`). | `build.mjs:74` | Build |
| 4 | Five API permissions only (storage, alarms, contextMenus, activeTab, scripting); no optional permissions, no web-accessible resources, no content scripts, no `externally_connectable`. | `build.mjs:206`, `build.mjs:208`, `build.mjs:203` | Build |
| 5 | No code built from strings: the bundles contain no `eval(`, `Function(`, string timers, `.constructor("...")`, `importScripts(`, dynamic `import(`, and no HTML assigned from a string. The one allowed occurrence is Preact's own `dangerouslySetInnerHTML` branch, which no source here uses (the build fails on that word under `src/`). | `build.mjs:113`, `build.mjs:136` | Build; counts in the shipped bundles: `eval(` 0, `Function(` 0, `import(` 0, `process.env` 0, `innerHTML` 0 in `background.js` and 3 (Preact) in `popup.js` |
| 6 | The bundles are not minified, and every URL they contain is printed at build time (the remote-code scan). | `build.mjs:180`, `build.mjs:319` | Build output |
| 7 | Only this extension's own pages may ask the worker anything: the sender must carry this extension's id AND a URL on its own extension origin (the paste function running inside a page reports the page's URL, so it is refused too). | `apps/extension/src/background/router.ts:333` | Test: `test/router.selftest.ts` [a] |
| 8 | Every request is parsed by a strict schema before anything acts on it: unknown requests, extra keys and wrong types are refused. | `router.ts:340`, `apps/extension/src/lib/messages.ts:12` | Test: `test/router.selftest.ts` [b] |
| 9 | The account key at rest is the website's own Phase-2 record (Argon2id from the password, then AES-GCM) in the extension's IndexedDB. | `apps/web/lib/keystore.ts` (reused unchanged), `apps/extension/src/background/account.ts:92` | Test: `test/restore.selftest.ts` (97 assertions, fake `/recovery-fetch`) |
| 10 | The unlocked key lives only in `storage.session` (memory, cleared when the browser closes), readable only by trusted extension contexts, never by a content script. | `account.ts:135`, `apps/extension/src/background/index.ts:52` | Test: `test/session.selftest.ts` |
| 11 | Auto-lock after 5, 15 or 60 minutes without use (default 15); the deadline is checked again at signing time, not only by the alarm; a refusal wipes the stored key. | `apps/extension/src/lib/session.ts:47`, `account.ts:202` | Test: `test/session.selftest.ts` (54) |
| 12 | Key bytes are zeroed after each use. | `account.ts:103`, `account.ts:159`, `account.ts:220`, `account.ts:246` | Code |
| 13 | Each full link (with its secret) is kept encrypted with AES-256-GCM under a key derived from the account key (HKDF-SHA-256), bound to the link's id. The key is never stored, so a locked extension cannot read a kept link back. | `apps/extension/src/lib/sealed.ts:34`, `sealed.ts:49`, `sealed.ts:94`, `account.ts:228` | Test: `test/security.selftest.ts` [a], [e] |
| 14 | The list of links in `storage.local` never holds a link's secret, and belongs to the account the extension holds: another account's record is neither listed nor written. | `apps/extension/src/lib/types.ts:28`, `apps/extension/src/background/records.ts:16`, `records.ts:47` | Test: `test/security.selftest.ts` [d] |
| 15 | The link is kept BEFORE the signed transfer is posted: if it cannot be kept, nothing is posted. | `apps/extension/src/background/send.ts:105`, `apps/web/lib/lumendrop.ts:375` | Test: `test/send.selftest.ts` [d], [h] |
| 16 | Nothing is ever sent twice automatically. An unconfirmed send is settled by reading the escrow, never by sending again; "didn't go through" needs the sponsor's own JSON refusal raised before submission, or two empty escrow reads past the send's deadline plus five minutes, and a failed link is read once more an hour later. | `apps/extension/src/lib/links.ts:17`, `links.ts:82`, `links.ts:119`, `apps/extension/src/lib/errors.ts:148` | Tests: `test/links.selftest.ts` (216), `test/send.selftest.ts` (247), `test/url.selftest.ts` (227, against the real `createV2Link`) |
| 17 | While a send is unconfirmed, a second one needs the person's explicit "Send a new one anyway". | `send.ts:68` | Test: `test/send.selftest.ts` [e] |
| 18 | The escrow records a claim and a take-back the same way, so a link whose take-back answer was lost reads "Closed", never a guess. | `links.ts:143` | Test: `test/links.selftest.ts` [c], [f] |
| 19 | Real money needs a password-locked account, the pilot's approval, a send left and the one-time note; the network switch checks the same. A cached approval stands in for a failed check for at most five minutes. | `send.ts:78`, `router.ts:185`, `apps/extension/src/background/pilot.ts:23` | Tests: `test/send.selftest.ts` [e], `test/security.selftest.ts` [c] |
| 20 | "Forget this account" waits for a running send or take-back, and refuses while links are still open (this browser holds the only list of them and the only way to take them back) unless the person chooses to forget anyway. | `router.ts:173`, `router.ts:176` | Test: `test/router.selftest.ts` [c], [d] |
| 21 | One take-back per link at a time; a take-back that failed before it was posted is "nothing moved" for certain. | `router.ts:280`, `apps/extension/src/background/reclaim.ts:57` | Tests: `test/router.selftest.ts` [d], `test/links.selftest.ts` [i] |
| 22 | The page is touched only on demand: the paste function is injected with `activeTab` + `scripting` after the person picks "Paste a Lumenia link here" (editable fields only) or presses the popup's button. It only inserts text, never presses Send, and refuses if the picked frame has moved to another site. | `apps/extension/src/background/insert.ts:31`, `apps/extension/src/background/insert.ts:117`, `apps/extension/src/content/insert.ts:13`, `apps/extension/src/content/insert.ts:16` | Test: `test/security.selftest.ts` [b]; live run below |
| 23 | The clipboard is written only on a click. | `apps/extension/src/popup/screens/Links.tsx:107`, `apps/extension/src/popup/screens/LinkReady.tsx:75` | Code |
| 24 | Nothing leaves the device before the first-run "Agree and continue", and usage counters stay off on Firefox unless the optional "technical and interaction data" permission is kept. A counter is an event name, two SHA-256 hashes cut to 8 bytes and the marker `src: "ext"`: never a URL, a link secret or an address. | `apps/extension/src/popup/screens/Consent.tsx:30`, `router.ts:57`, `router.ts:58`, `router.ts:62`, `apps/extension/manifest.firefox.json:49`, `apps/web/lib/events.ts:123` | Tests: `apps/sponsor` `test:events` (79), `apps/web` `test:extseam` (141) |
| 25 | Test-only hooks never ship: the short-expiry end-to-end build has its own entry and output folder and is never packaged. | `build.mjs:164`, `build.mjs:325` | The shipped bundles contain no `__lumeniaE2E` |
| 26 | The worker is kept alive for a long send by an extension call every 20 s, capped at three minutes. | `apps/extension/src/background/keepalive.ts:18` | Measured on Chrome 153: a bare 60 s request in the worker is cut at 30 s, and completes with the calls |

Third-party code in the shipped bundles: `@stellar/stellar-sdk` 16.3.0 (with `@stellar/js-xdr`,
`@noble/hashes`, `@noble/ed25519`, `bignumber.js`, `base32.js`, `feaxios`, `eventsource`),
`hash-wasm` 4.12.0 (Argon2id; its WebAssembly is a base64 string inside its own published
JavaScript, which is why the CSP has `'wasm-unsafe-eval'`), `zod` 3.25.76, `buffer` 6.0.3, and in
the popup `preact` 10.29.8 and `uqr` 0.1.3. `pnpm audit` lists advisories for `axios` 1.18.0 and
`smol-toml` 1.6.1 under the Stellar SDK; neither is in the bundles (the SDK's browser build uses
`feaxios` in place of `axios`, and the TOML parser is not reached).

### D1.2 Tests and builds

| What | Result |
|---|---|
| `pnpm --filter @lumenia/extension test` (offline, no keys) | 8 suites, 1,695 assertions: url 227, links 216, send 247, session 54, restore 97, security 23, router 33, popup 798 |
| `pnpm --filter @lumenia/extension typecheck` | clean (includes the reused `apps/web/lib` files) |
| `pnpm --filter @lumenia/extension build` | `dist/lumenia-chrome-0.1.0.zip`, `dist/lumenia-firefox-0.1.0.zip` |
| Rebuild from the sources archive (`pnpm --filter @lumenia/extension sources`, unpacked in an empty directory, `pnpm install --frozen-lockfile`, build) | every file of `dist/chrome` and `dist/firefox` byte-identical to the original build |
| `pnpm --filter @lumenia/extension lint:firefox` (`web-ext lint`) | 0 errors, 0 notices, 1 warning: `UNSAFE_VAR_ASSIGNMENT` (innerHTML) in `popup.js`, which is Preact's own `dangerouslySetInnerHTML` branch, never reached (rule 5) |
| CI | job `extension` in `.github/workflows/ci.yml` (frozen install, typecheck, the suites, build, `web-ext lint`, both zips uploaded as the artifact `lumenia-extension-zips`); the web step also runs `test:extseam`, `test:walletkit` and `test:agentmcp` |

### D1.3 Live proof on testnet (practice money)

Run on 2026-10-03 by `apps/extension/e2e/testnet.e2e.mjs` against the live website and the live
testnet sponsor: a throwaway account was made and backed up on getlumenia.com with a disposable
inbox, restored in the extension with the code that inbox received, and used to make two $0.10
links from the extension's background worker. The first was pasted into a chat box 5.1 s after
the send started and claimed on getlumenia.com in a browser with no extension; the second was
taken back after its expiry (this end-to-end build expires links after 180 seconds; the store
build uses seven days).

| Step | Transaction | What the explorer shows |
|---|---|---|
| Link 1 sent from the extension | [`017bef46...c1ec71`](https://stellar.expert/explorer/testnet/tx/017bef46e84e1875d5eb7ec147de0fb25b7c6f0e38aaa5067172ab8206c1ec71) | A fee-bump paid by the testnet sponsor (`GDQFGINJ...`) around the extension account's (`GBMV4QIN...`) call into the escrow contract, moving 0.10 USDC into it. The link's query ends `&src=ext`; its secret is only in the `#fragment`. |
| Link 1 claimed on getlumenia.com | [`c0669dc4...26c3fc`](https://stellar.expert/explorer/testnet/tx/c0669dc474f3897624eda460618d61ef0df71dc3bcb119620a24a001c326c3fc) | The claim, fee paid by the sponsor: the recipient paid no gas. The extension's list then read Claimed. |
| Link 2 sent | [`b9a5516f...0ade85`](https://stellar.expert/explorer/testnet/tx/b9a5516f0cd7eb1c846a47c0aee89bb28f0bb8edfa8ae4ba489a8575380ade85) | Same shape as link 1. |
| Link 2 taken back after its expiry | [`aca0330e...591567`](https://stellar.expert/explorer/testnet/tx/aca0330ec42d2a73b73c9f9315178e1bc6788848bb8fe67c5b2438f865591567) | The sender's take-back, fee paid by the sponsor; the extension's list then read Reclaimed. |

All four were read back from `horizon-testnet.stellar.org` as successful (ledgers 5,005,340 to
5,005,384). The paste also landed in a text area, a one-line field and the Lexical editor (the
editor WhatsApp Web is built on), each holding exactly one copy of the link.

The same flow through the popup's own screens (`apps/extension/e2e/ui.e2e.mjs`, the run that also
takes the store screenshots): "Before you start", restore with the mailed code, "Paste a Lumenia
link here" on a chat box, $0.10, Make the link. The box held the link 6.8 s after the click; the
link was claimed on getlumenia.com and the Links screen turned it Claimed; two more links were
taken back after their expiry with the screen's own "Take it back" button.

| Step | Transaction |
|---|---|
| Link A made in the popup and pasted (account `GBA5UTKZ...`) | [`b1138f72...b77a1e`](https://stellar.expert/explorer/testnet/tx/b1138f7224b144fc77100967678ed7747ce705ade55d23893e6346afbab77a1e) |
| Link A claimed on getlumenia.com, no extension | [`f9a30d3d...cc1ceb`](https://stellar.expert/explorer/testnet/tx/f9a30d3d33bf344e1d4ab4169ecd9d0e6cf18f94589799dea68e9d0efccc1ceb) |
| Link B made, then taken back from the Links screen | [`075cf93d...4bc81f`](https://stellar.expert/explorer/testnet/tx/075cf93ddb50234921e0c5d1253e97216a92fcc518ebad5b6c80af3e114bc81f), [`9651effc...e1f57a`](https://stellar.expert/explorer/testnet/tx/9651effc0c6a5664c3ce34268a0bb03e54347c9792cf59958993c734c4e1f57a) |
| Link C made, then taken back from the Links screen | [`a201e2c5...9c4afe`](https://stellar.expert/explorer/testnet/tx/a201e2c5f767e04f8a2845f60d87fe5020040b41a467800ce6cb55ad3d9c4afe), [`ca1fcd98...dc699b`](https://stellar.expert/explorer/testnet/tx/ca1fcd98c9b2acc7c4baa4fd28723b08e0e07413204cb6eee548380d92dc699b) |

### D1.4 Not verified yet, stated plainly

- **Firefox has not run the extension yet.** The Firefox build passes `web-ext lint`; the build
  machine has no Firefox. The first run is the owner's, on the AMO-signed package.
- **No store review has happened yet.** Neither the Chrome Web Store submission (Unlisted) nor the
  AMO unlisted signing has been made; both are the owner's.
- **No real-money send from the extension yet.** Metric 1 needs a mainnet link made from the
  published extension and claimed; that send is the owner's, from an approved pilot wallet.
- **Paste on the real chat sites is untested**: it was tested on a local page and on the public
  Lexical playground, not on WhatsApp Web, Telegram Web or Gmail themselves.
- **Only Chromium was driven**: what a browser does to `activeTab` when the page navigates was not
  tested, and the keep-alive timing is measured on Chrome 153 only.
- **The escrow contract has not been reviewed by an outside security firm**, and its owner (on
  real money, a 2-of-3 multisig whose three keys one person holds today) can upgrade it. Its
  current code gives the owner no way to move escrowed money.
- **A link left untouched for about 30 days on testnet** (longer on mainnet) is archived by the
  ledger, and neither the extension nor the website can restore it to take the money back yet;
  the list tells the sender to take a link back within three weeks of its expiry.
