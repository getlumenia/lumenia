# SOW 2 readiness report

Status: **2026-10-09. Complete except the rows marked _pending_, which wait on five steps that are
the owner's:**

- **extension 0.1.3 in both stores** (D1, Published builds): the build that carries the private link
  shape and the D3 client changes. Uploading it to the two stores is the owner's, and each store
  reviews it for days before it goes live.
- **the metric-1 run** (D1.5): a real-money link made from the published extension and claimed on
  mainnet. It moves real money from an approved pilot wallet.
- **the metric-2 run** (D2.5): a private-by-default link claimed on mainnet, with its chat previews.
  It moves real money from an approved pilot wallet.
- **the KMS cutover on both Workers** (D3.6, ops note section 2.4). It needs the owner's AWS account
  and the sponsor's current key. Until the mainnet Worker signs with KMS, metric 3 is not met.
- **the rehearsal of the retirement switch on the deployed testnet Worker** (D3.4, ops note section
  1.3). It redeploys that Worker four times and needs the store's credentials. Until it has run,
  this report calls the switch dry-run on a local Worker, not rehearsed.

Everything else is done: D1's published builds, checklist, tests and testnet proof; D2's code, live
since 2026-10-07, its tests and the testnet commitment spike; D3's hardening, green in CI and
deployed on both Workers on 2026-10-08, with the live adversarial runs, the first watchdog stamps
and the heartbeat's first runs.

Everything below can be checked in public. File and line references are pinned to a commit, because
later commits move lines: D1.1 cites the published extension's source at `062725f`, and D3 cites
`24d0f4e` (and `d78f4de` in its "before" column). Each transaction hash opens on stellar.expert and
each CI run on GitHub Actions. Two limits: the raw outputs of the adversarial runs stay out of the
repository (they sit next to the throwaway keys the runs made), so D3.3 transcribes them with each
answer cut short; and on mainnet a refusal's text is replaced by "request failed" and a reference
that only the Worker's own log resolves.

---

## D1. The browser extension

`apps/extension`: a Chrome MV3 / Firefox MV3 extension that makes a Lumenia payment link from the
sender's own account and shows whether it was claimed. It reuses the website's sender code
(`apps/web/lib`); the recipient side does not change. Published as version 0.1.2 on the Chrome Web
Store and on addons.mozilla.org, both built from commit `062725f`; the next build, 0.1.3, is not
built or submitted yet.

### Published builds

| Where | Version | Live since | Source | Package |
|---|---|---|---|---|
| Chrome Web Store, public: https://chromewebstore.google.com/detail/lumenia-send-dollars-by-l/ccdnjnckaldkmjnlpgpmdmnbajmakhmn | 0.1.2 | 2026-10-06 (the store's "published" email, forwarded by the owner) | [`062725f`](https://github.com/getlumenia/lumenia/tree/062725f) | the package as the store served it on 2026-10-09: sha256 `0a62ccc9736aa6b2c40b0f2895ee099c184f9f61855b364f26f099bad43e85a7` |
| addons.mozilla.org, public: https://addons.mozilla.org/en-US/firefox/addon/lumenia/ | 0.1.2 | 2026-10-07 (approved 14:10 UTC; the file was uploaded on 2026-10-04) | [`062725f`](https://github.com/getlumenia/lumenia/tree/062725f) | the AMO file, sha256 `988e3c69014d041b79288b06af5c56e24ede379a221a68d6753d7a12b15103a0` (AMO's public API gives the same hash) |
| getlumenia.com/extension/lumenia-firefox.xpi, self-hosted, AMO-signed (unlisted) | 0.1.1 | 2026-10-04 | the signed file is in the repository, `apps/web/public/extension/lumenia-firefox.xpi` (added in `cea442d`); its code is the published 0.1.2's apart from the version string | sha256 `792667fbce088a10fe5e71287f27fc305dac49684486a53eda1e081764e2039e` |
| Both stores, the next build (private link shape, the D3 client changes) | 0.1.3 | _pending: not built or submitted yet_ | _pending_ | _pending_ |

Both store packages hold the same `background.js` (sha256 `6999fb8eebd3a97302ea8eb3b63bc6a66ccb467370290c5b9e02b85bbe901024`)
and `popup.js` (sha256 `e26584432d56755dc601f5bab80d7d744dd5bbc80a93a48771747d5759661623`).
To rebuild the store version: `git checkout 062725f`, `pnpm install --frozen-lockfile`,
`pnpm --filter @lumenia/extension build`. Checked on 2026-10-09: that rebuild's `dist/chrome` and
`dist/firefox` match the two store packages file for file, apart from what each store adds (Google:
`_metadata/verified_contents.json` and an `update_url` line in `manifest.json`; Mozilla: the
`META-INF` signature folder, and its `manifest.json` has no final newline). A build of any later
commit is a different package, whatever its version line says, and so is CI's `lumenia-extension-zips`
artifact, which is built from the commit CI ran on.

### D1.1 Security checklist

Every line names the file and line that enforces it in the published build, at commit
[`062725f`](https://github.com/getlumenia/lumenia/tree/062725f); later commits (D2, D3) moved some of
these lines. "Build" means the build refuses to produce a package when the rule is broken; "Test"
names the offline suite that holds it.

| # | Rule | Enforced at | Held by |
|---|---|---|---|
| 1 | No remote code. Every script is bundled; extension pages run only `'self'` scripts plus WebAssembly (`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`). | `apps/extension/manifest.chrome.json:36`, `apps/extension/manifest.firefox.json:35`, `apps/extension/build.mjs:74` | Build: `build.mjs:201` refuses any other CSP |
| 2 | Network access limited by the browser to six hosts (the two sponsor Workers, Horizon and RPC on both networks): `connect-src 'self'` plus those six; `host_permissions` exactly the same six; no `<all_urls>`. | `build.mjs:74`, `build.mjs:198`, `build.mjs:200` | Build |
| 3 | Images only from the package; no frames, no form submissions, no `<base>` (`img-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'`). | `build.mjs:74` | Build |
| 4 | Five API permissions only (storage, alarms, contextMenus, activeTab, scripting); no optional permissions, no web-accessible resources, no content scripts, no `externally_connectable`. | `build.mjs:206`, `build.mjs:208`, `build.mjs:203` | Build |
| 5 | No code built from strings: the bundles contain no `eval(`, `Function(`, string timers, `.constructor("...")`, `importScripts(`, dynamic `import(`, and no HTML assigned from a string. The one allowed occurrence is Preact's own `dangerouslySetInnerHTML` branch, which no source here uses (the build fails on that word under `src/`). | `build.mjs:113`, `build.mjs:136` | Build; counts in the shipped bundles: `eval(` 0, `Function(` 0, `import(` 0, `process.env` 0, `innerHTML` 0 in `background.js` and 3 (Preact) in `popup.js` |
| 6 | The bundles are not minified, and every URL they contain is printed at build time (the remote-code scan). | `build.mjs:180`, `build.mjs:319` | Build output |
| 7 | Only this extension's own pages may ask the worker anything: the sender must carry this extension's id AND a URL on its own extension origin (the paste function running inside a page reports the page's URL, so it is refused too). | `apps/extension/src/background/router.ts:363` | Test: `test/router.selftest.ts` [a] |
| 8 | Every request is parsed by a strict schema before anything acts on it: unknown requests, extra keys and wrong types are refused. | `router.ts:370`, `apps/extension/src/lib/messages.ts:12` | Test: `test/router.selftest.ts` [b] |
| 9 | The account key at rest is the website's own Phase-2 record (Argon2id from the password, then AES-GCM) in the extension's IndexedDB, whether the account was restored or made here. | `apps/web/lib/keystore.ts` (reused unchanged), `apps/extension/src/background/account.ts:155` | Tests: `test/restore.selftest.ts` (97), `test/account.selftest.ts` [a] |
| 10 | The unlocked key lives only in `storage.session` (memory, cleared when the browser closes), readable only by trusted extension contexts, never by a content script. | `account.ts:240`, `apps/extension/src/background/index.ts:52` | Test: `test/session.selftest.ts` |
| 11 | Auto-lock after 5, 15 or 60 minutes without use (default 15); the deadline is checked again at signing time, not only by the alarm; a refusal wipes the stored key. | `apps/extension/src/lib/session.ts:47`, `account.ts:307` | Test: `test/session.selftest.ts` (54) |
| 12 | Key bytes are zeroed after each use. | `account.ts:123`, `account.ts:160`, `account.ts:264`, `account.ts:325`, `account.ts:351` | Code |
| 13 | Each full link (with its secret) is kept encrypted with AES-256-GCM under a key derived from the account key (HKDF-SHA-256), bound to the link's id. The key is never stored, so a locked extension cannot read a kept link back. | `apps/extension/src/lib/sealed.ts:34`, `sealed.ts:49`, `sealed.ts:94`, `account.ts:333` | Test: `test/security.selftest.ts` [a], [e] |
| 14 | The list of links in `storage.local` never holds a link's secret, and belongs to the account the extension holds: another account's record is neither listed nor written; the mirror that scopes it is repaired from the keystore. | `apps/extension/src/lib/types.ts:28`, `apps/extension/src/background/records.ts:16`, `records.ts:47`, `account.ts:76` | Tests: `test/security.selftest.ts` [d], `test/account.selftest.ts` [d] |
| 15 | The link is kept BEFORE the signed transfer is posted: if it cannot be kept, nothing is posted. | `apps/extension/src/background/send.ts:105`, `apps/web/lib/lumendrop.ts:375` | Test: `test/send.selftest.ts` [d], [h] |
| 16 | Nothing is ever sent twice automatically. An unconfirmed send is settled by reading the escrow, never by sending again; "didn't go through" needs the sponsor's own JSON refusal raised before submission, or two empty escrow reads past the send's deadline plus five minutes, and a failed link is read once more an hour later. | `apps/extension/src/lib/links.ts:17`, `links.ts:82`, `links.ts:119`, `apps/extension/src/lib/errors.ts:152` | Tests: `test/links.selftest.ts` (216), `test/send.selftest.ts` (247), `test/url.selftest.ts` (227, against the real `createV2Link`) |
| 17 | While a send is unconfirmed, a second one needs the person's explicit "Send a new one anyway". | `send.ts:68` | Test: `test/send.selftest.ts` [e] |
| 18 | The escrow records a claim and a take-back the same way, so a link whose take-back answer was lost reads "Closed", never a guess. | `links.ts:143` | Test: `test/links.selftest.ts` [c], [f] |
| 19 | Real money needs a password-locked account, the pilot's approval, a send left and the one-time note; the network switch checks the same. A cached approval stands in for a failed check for at most five minutes. | `send.ts:78`, `router.ts:207`, `apps/extension/src/background/pilot.ts:23` | Tests: `test/send.selftest.ts` [e], `test/security.selftest.ts` [c] |
| 20 | "Forget this account" waits for a running send or take-back, refuses while links are still open (this browser holds the only list of them and the only way to take them back), and refuses to delete an account made here that was never backed up (its only copy), each unless the person chooses to forget anyway. | `router.ts:192`, `router.ts:195`, `router.ts:198` | Tests: `test/router.selftest.ts` [c], [d], `test/account.selftest.ts` [d] |
| 21 | One take-back per link at a time; a take-back that failed before it was posted is "nothing moved" for certain. | `router.ts:310`, `apps/extension/src/background/reclaim.ts:57` | Tests: `test/router.selftest.ts` [d], `test/links.selftest.ts` [i] |
| 22 | The page is touched only on demand: the paste function is injected with `activeTab` + `scripting` after the person picks "Paste a Lumenia link here" (editable fields only) or presses the popup's button. It only inserts text, never presses Send, and refuses if the picked frame has moved to another site. | `apps/extension/src/background/insert.ts:31`, `apps/extension/src/background/insert.ts:117`, `apps/extension/src/content/insert.ts:13`, `apps/extension/src/content/insert.ts:16` | Test: `test/security.selftest.ts` [b]; live runs below |
| 23 | The clipboard is written only on a click. | `apps/extension/src/popup/screens/Links.tsx:108`, `apps/extension/src/popup/screens/LinkReady.tsx:76` | Code |
| 24 | Nothing leaves the device before the first-run "Agree and continue" (the hello screen before it sends nothing), and usage counters stay off on Firefox unless the optional "technical and interaction data" permission is kept. A counter is an event name, two SHA-256 hashes cut to 8 bytes and the marker `src: "ext"`: never a URL, a link secret or an address. | `apps/extension/src/popup/screens/Consent.tsx:33`, `account.ts:84`, `router.ts:63`, `router.ts:64`, `router.ts:68`, `apps/extension/manifest.firefox.json:49`, `apps/web/lib/events.ts:117` | Tests: `apps/sponsor` `test:events`, `apps/web` `test:extseam` (141) |
| 25 | Test-only hooks never ship: the short-expiry end-to-end build has its own entry and output folder and is never packaged. | `build.mjs:164`, `build.mjs:325` | The shipped bundles contain no `__lumeniaE2E` |
| 26 | The worker is kept alive for a long send by an extension call every 20 s, capped at three minutes. | `apps/extension/src/background/keepalive.ts:18` | Measured on Chrome 153: a bare 60 s request in the worker is cut at 30 s, and completes with the calls |
| 27 | An account made in the extension needs a password that passes the website's own floor (at least 10 characters, not common, not patterned); its key record is written first, and its backup copy is wrapped with the same password and kept here as ciphertext only. | `account.ts:145`, `account.ts:148`, `account.ts:155`, `account.ts:156` | Test: `test/account.selftest.ts` [a] |
| 28 | A backup is stored only with the mailed code AND a signature from the unlocked account, which binds the stored row so a later write from someone who can only read the mailbox is refused; a locked extension cannot back up. | `account.ts:199`, `account.ts:206`, `apps/extension/src/lib/backup.ts:38` | Test: `test/account.selftest.ts` [b] |
| 29 | Practice dollars only: a new account is opened by the sponsor (no XLM needed) with a transaction the extension checks with the website's own guard before signing (a sponsored create plus a trustline sourced by the account, nothing else), then the faucet pays; real money is refused. | `apps/extension/src/background/practice.ts:28`, `practice.ts:29`, `apps/web/lib/sponsor.ts:165` | Test: `test/account.selftest.ts` [c]; live run below |

Two rules were added to the source after `062725f`, so no store build has them until 0.1.3: real
money also needs an account that is backed up, and both the network switch and the send refuse one
that is not (`apps/extension/src/background/router.ts:214` and `send.ts:83` at `24d0f4e`; Tests:
`test/router.selftest.ts`, `test/send.selftest.ts`); and a 202 answer to a take-back stays open
instead of reading as landed (D3.8).

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
| `pnpm --filter @lumenia/extension test` (offline, no keys) | at `062725f`, the published build: 9 suites, 1,808 assertions: url 227, links 216, send 247, session 54, restore 97, security 23, router 33, account 41, popup 870 (re-run on 2026-10-09). At `24d0f4e`, with the D2 and D3 changes: 1,927: url 235, links 225, send 260, session 54, restore 97, security 23, router 38, account 41, popup 954 |
| `pnpm --filter @lumenia/extension typecheck` | clean (includes the reused `apps/web/lib` files) |
| `pnpm --filter @lumenia/extension build` | `dist/lumenia-chrome-<version>.zip` and `dist/lumenia-firefox-<version>.zip`, the version read from `apps/extension/package.json` (0.1.2 at `062725f`) |
| Rebuild from the sources archive (`pnpm --filter @lumenia/extension sources`, unpacked in an empty directory, `pnpm install --frozen-lockfile`, build) | every file of `dist/chrome` and `dist/firefox` byte-identical to the original build |
| `pnpm --filter @lumenia/extension lint:firefox` (`web-ext lint`) | 0 errors, 0 notices, 1 warning: `UNSAFE_VAR_ASSIGNMENT` (innerHTML) in `popup.js`, which is Preact's own `dangerouslySetInnerHTML` branch, never reached (rule 5) |
| CI | job `extension` in `.github/workflows/ci.yml` (frozen install, typecheck, the suites, build, `web-ext lint`, both zips uploaded as the artifact `lumenia-extension-zips`); the web step also runs `test:extseam` (141 at `062725f`, 162 at `24d0f4e`), `test:walletkit` and `test:agentmcp` |

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

The same flow through the popup's own screens, on the redesigned first run with the Practice | Real
switch in the header (`apps/extension/e2e/ui.e2e.mjs`, 2026-10-03 20:56Z, the run that takes store
screenshots 1, 2 and 5): Hello ("Hey, I've got a message for you.") -> Get started -> "One thing
first" -> Agree -> "Yes, bring it here", restore with the mailed code, "Paste a Lumenia link here" on
a chat box, $0.10, Make the link. The box held the link 8.3 s after the click; the link was claimed
on getlumenia.com and the Links screen turned it Claimed; the other two links were taken back after
their expiry, each with the Links screen's own "Take it back" button and its confirmation.

| Step | Transaction |
|---|---|
| Link A made in the popup and pasted (account `GBV72WN3...`) | [`98885802...cf92ac`](https://stellar.expert/explorer/testnet/tx/988858024a337c8897d7e3481a5747b0e819881de4e8556250022def17cf92ac) |
| Link A claimed on getlumenia.com, no extension | [`08822388...29c7d8`](https://stellar.expert/explorer/testnet/tx/088223881bc46b1ce93a7d418509ed9bb2d7c8bcee9fd367c1a014b2ea29c7d8) |
| Link B made, then taken back from the Links screen | [`bdd27263...693ed5`](https://stellar.expert/explorer/testnet/tx/bdd272630290105a77c493f382133a9d0379a34a6799c5f23ce826f960693ed5), [`202aa005...fa9cf9`](https://stellar.expert/explorer/testnet/tx/202aa005a009e03beaf01a2feda87a6ce62bfda30d43e6d12afba5373afa9cf9) |
| Link C made, then taken back from the Links screen | [`7565df34...9f2541`](https://stellar.expert/explorer/testnet/tx/7565df348294560044a16e3308121a0b75bc48cd5a220947a04101eb159f2541), [`ce774164...38196c`](https://stellar.expert/explorer/testnet/tx/ce7741645427c48b5a7f744f7b46fe1d5080b62034d3df9ded08717cf038196c) |

Store screenshots 3 and 4 come from a second run of the same file built with the store's own seven
days (`node build.mjs --e2e-ttl=604800 && node e2e/ui.e2e.mjs --paste-shots`, 21:01Z), so the
take-back date they show is the real one. Both links shown in them were claimed straight after
(deposits [`e72ab1a9...5a6f76`](https://stellar.expert/explorer/testnet/tx/e72ab1a9d360f3ae72e8a00d84e95e20921ab91c6cb8ad9481b0cf66cd5a6f76)
and [`e5166a8c...12523f`](https://stellar.expert/explorer/testnet/tx/e5166a8ced3239db2ae45004e274274b09eafe74634c55a76dc654722b12523f),
claims [`cd64a655...4b8286`](https://stellar.expert/explorer/testnet/tx/cd64a655f16edd6ae95225d7b9c5a953487e0265291de5214bc6e5d6534b8286)
and [`c64c7384...46b996`](https://stellar.expert/explorer/testnet/tx/c64c73849fbad2e8bdc204797dd6fbeb1441ee42717cfde2050b2af66c46b996)),
so no link in any image can still be claimed. All ten transactions were read back from
`horizon-testnet.stellar.org` as successful (ledgers 5,007,494 to 5,007,553).

An account MADE in the extension, end to end (`apps/extension/e2e/create.e2e.mjs`, 19:34Z): the
popup's first run ("Hey, I've got a message for you." -> Get started -> agree -> "No, I'm new here"
-> a password), practice dollars added on their own, a $0.10 link claimed on getlumenia.com in a
browser with no extension, the extension reading it as Claimed, a backup with a disposable inbox,
and a fresh browser profile restoring the account to the same address (balance 0.90).

| Step | Transaction | What the explorer shows |
|---|---|---|
| The account opened by the sponsor | [`915f06c3...a257ff`](https://stellar.expert/explorer/testnet/tx/915f06c3d7a7c346801dd0f1d264efff5e7ba33f0f53a1cf81efd4593aa257ff) | One transaction: the sponsor begins sponsoring, creates `GB5Y754L...` with 0 XLM, the new account adds its USDC line (signed in the extension), and the sponsoring ends. The account holds 0 XLM. |
| Practice dollars from the faucet | [`804c0972...15a8c8`](https://stellar.expert/explorer/testnet/tx/804c09724eb8157916378b10de1b7835618629a87e286bb0eddd43b95f15a8c8) | 1.00 USDC from the faucet account, a separate key from the sponsor's. |
| The first link | [`802cb10d...3bc2f1`](https://stellar.expert/explorer/testnet/tx/802cb10d2f31955267c7dfd21426b5c5f5b06e45cbc75acdc16a2029f13bc2f1) | The new account's call into the escrow, fee paid by the sponsor. |
| Claimed on getlumenia.com | [`f9d3b9f0...42860c`](https://stellar.expert/explorer/testnet/tx/f9d3b9f0cf2791c53e242d8fa9f591df18ae15369e88a05e33374e167642860c) | The claim, fee paid by the sponsor. |

### D1.4 Not verified yet, stated plainly

- **No one has run the extension in Firefox yet.** The Firefox build passes `web-ext lint`, AMO
  signed the unlisted 0.1.0 and 0.1.1 on 2026-10-04, and AMO's review approved the listed 0.1.2,
  public since 2026-10-07 (see Published builds). That first run in Firefox is the owner's.
- **The AMO listing does not link the privacy policy yet** (AMO's public API answered
  `has_privacy_policy: false` on 2026-10-09); the Chrome Web Store listing links
  getlumenia.com/privacy. Linking https://getlumenia.com/privacy#extension from the AMO listing is the
  owner's step.
- **Brave** installs the extension from the Chrome Web Store with its standard notice that Brave does
  not review extensions; that notice is Brave's for every extension outside its own vetted list.
- **The published 0.1.2 makes links in the pre-D2 shape** (amount and name in the query), and it has
  neither of the two rules added after it (see D1.1). Both reach the stores with 0.1.3; see the D2
  section and D3.8.
- **No real-money send from the extension yet, so no recording of one.** Metric 1 (D1.5) needs a
  mainnet link made from the published extension and claimed; that send and its recording are the
  owner's, from an approved pilot wallet.
- **Paste on the real chat sites is untested**: it was tested on a local page and on the public
  Lexical playground, not on WhatsApp Web, Telegram Web or Gmail themselves.
- **Only Chromium was driven**: what a browser does to `activeTab` when the page navigates was not
  tested, and the keep-alive timing is measured on Chrome 153 only.
- **The escrow contract has not been reviewed by an outside security firm**, and its owner (on
  real money, a 2-of-3 multisig whose three keys one person holds today) can upgrade it. Its
  current code gives the owner no way to move escrowed money.
- **An untouched link's escrow record is archived after about 7 days on testnet.** Measured: a new
  record lives for the network's minimum, 120,960 ledgers on testnet (about 7 days at 5 seconds a
  ledger), because the contract's own bump at deposit does not extend a record that fresh. So an
  untouched practice link is archived at about the moment its take-back opens. Archival neither
  loses the money nor blocks the take-back: since protocol 23 a transaction that uses an archived
  record restores it automatically and pays for the restore inside its own fee. A testnet take-back
  144,171 ledgers (about 8 days) after its deposit succeeded that way
  ([`489c391f...a9b7ee`](https://stellar.expert/explorer/testnet/tx/489c391fb199d3f00f89e62ad31782925845f136c401cf30ce09074eeea9b7ee),
  2026-09-27), built the way the extension and the website build theirs (`reclaimV2` in
  `apps/web/lib/lumendrop.ts`, which assembles the transaction from its simulation). No archived
  take-back has gone through the D3 sponsor yet. On mainnet the network's minimum is 2,073,600
  ledgers, about 120 days. The published extension's list tells the sender to take a link back within
  three weeks of its expiry because "after that, this extension can't do it for you"; for the reason
  above, that warning does not hold.

### D1.5 Metric 1: a real-money link from the published extension, claimed on mainnet

_Pending: the owner's run_, from an approved pilot wallet, inside the pilot's limits ($5 a link, $25 a
day). Until every row is filled, metric 1 is not met.

| | |
|---|---|
| The extension build used (store and version) | _pending_ |
| Deposit (mainnet), made from the extension | _pending_ |
| Claim (mainnet), in a browser with no extension and no wallet | _pending_ |
| Recipient account (created by the claim) | _pending_ |
| Recording of the run, ending on the extension's Links screen reading Claimed | _pending_ |

---

## D2. Private links and the commitment spike

Status: **code done and tested 2026-10-06, live since 2026-10-07.** The web deploys of `1bc2049` and
`d78f4de` (Vercel, 2026-10-07 18:12 and 18:18 UTC) carry it. D2's one sponsor change, which shortens
the sender's address in a relay refusal's log line, went live with both Workers' D3 deploys on
2026-10-08 (D3.9). CI
was green on `1bc2049` ([run 37664877374](https://github.com/getlumenia/lumenia/actions/runs/37664877374)),
and the nightly run against production on 2026-10-08
([run 37774557675](https://github.com/getlumenia/lumenia/actions/runs/37774557675)) passed its step
"Private link preview (D2 leak audit, live half)". Still the owner's: the mainnet run (D2.5).

### D2.1 What a link carries now

| | Before D2 | Now (default) |
|---|---|---|
| A one-to-one link | `/v2/c/<id>?a=5.00&s=Ayse[&p=1][&n=public]#<key>` | `/v2/c/<id>[?n=public]#<key>[&s=Ayse][&p=1]` |
| A group link | `...?a=<share>&s=Ayse&g=6...#<key>&g=6` | `/v2/c/<id>?g=6[&n=public]#<key>[&s=Ayse]&g=6` |
| The sender's name | in the query | none unless the sender types one: the "Sent as" field on /send and /group (and the extension's From field, from 0.1.3) starts empty, a typed name goes after the `#`, and a link without one shows "Someone" |
| The chat preview | "Ayse sent you $5.00", a card painted from the query | "Lumenia" and "Someone sent you dollars by link. Open it to see the amount. No app, no sign-up, and the recipient pays no gas.", a static brand image |
| The amount on the claim page | read from `?a=` (an edited `?a=999` showed $999.00) | read from the escrow, with "Verified on the ledger" |
| A password for real money | off by default | on by default on mainnet, with one line on why; the extension already did this |

The amount appears nowhere in the link. A typed name and the lock marker sit after the `#`, which no
browser or preview bot sends to a server; anyone who can read the chat can still read them, and the
name field says so when a name is typed. Showing the amount and the name in the preview is an
explicit choice on /send and /group ("Show the amount and my name in chat previews", off by default);
even then the card's amount is read from the ledger. Links made before D2 keep claiming.

### D2.2 Tests

Counts as run on 2026-10-09 at `24d0f4e`; where D3 added cases later, the D2 figure is given too.

| Suite | What it holds | Count |
|---|---|---|
| `apps/web` `test:linkprivacy` (CI) | every link shape, round-tripped; the beacon body; the claim-route headers | 51/51 |
| `apps/web` `test:claimmeta` (CI) | private metadata for every link; rich metadata and the OG card read the ledger, never `a=` | 55/55 |
| `apps/web` `test:group` (CI) | the group-link parser, incl. the name and lock marker in the fragment | 84/84 (45 before D2, 57 with D2) |
| `apps/web` `test:horizon` (CI) | the v1 page's claimable-balance read, three-valued and pinned to USDC | 62/62 (17 before D2, 45 with D2) |
| `apps/web` `test:claimledger` (CI) | what the v2 claim screen may say about the amount: errors, empty reads, spent records, late reads after a tap | 17/17 |
| `apps/web` `test:claimhome` (CI) | a practice link's account is kept as a throwaway, never adopted as the device's home account (leak audit row 20) | 22/22 |
| `apps/sponsor` `test:events` (CI) | [17] an unknown field such as `amount` is dropped from the log and the counters | 80/80 (78 before D2) |
| `apps/extension` `test:url` (CI) | the extension's links, private by default | 235/235 (227 before D2, 233 with D2) |
| `apps/web/e2e/preview.spec.ts` (nightly, e2e.yml) | four bot user agents, an edited `?a=999`, the ledger amount on the page, clean beacons, a real claim, the claimed link reopened | passed 2026-10-06 against a local production build on testnet; since 2026-10-08 it runs nightly against production, and [run 37774557675](https://github.com/getlumenia/lumenia/actions/runs/37774557675) (2026-10-08) passed its step "Private link preview (D2 leak audit, live half)" |
| `apps/web/e2e/private-variants.spec.ts` (on demand) | a password-locked link and a group link made on /send and /group, opened on a fresh device, read from the ledger, claimed | passed 2026-10-06, same setup |

The CI suites above ran green on `1bc2049`
([run 37664877374](https://github.com/getlumenia/lumenia/actions/runs/37664877374), 2026-10-07) and on
`24d0f4e` ([run 37821341438](https://github.com/getlumenia/lumenia/actions/runs/37821341438), 2026-10-08).

### D2.3 The leak audit and the privacy page

- [`LEAK_AUDIT.md`](LEAK_AUDIT.md): one row per channel (URL, fragment, page body, spoofed amount,
  metadata, OG image, referrer, host logs, web analytics, beacons, sponsor logs, pilot status,
  recovery, third parties, service worker, the sender's device, share text, request links, the store
  packages, a practice link's key, the sponsor and the amount), each with a file and line or
  production output.
- The privacy page: https://getlumenia.com/privacy, in seven sections (what a link carries; what the
  ledger shows, forever; what our sponsor sees; fresh accounts; what we never store; the browser
  extension; our website), linked from the site footer, /how-it-works, /terms and /extension. It
  carries its own "Last updated" date (7 October 2026 at `24d0f4e`).

### D2.4 The commitment spike (testnet)

[`ZK_SPIKE_REPORT.md`](ZK_SPIKE_REPORT.md). The escrow variant `contracts/lumen-drop-commit` stores a
sha256 commitment next to the escrowed amount and checks the reveal at claim; 21 tests including the
wrong-reveal cases and the solvency property. Testnet contract
[`CAGWIGEGGTPZK7SPERJRW3EYSEHGSZKQEKEH6SU4ECU6EI7BKTAILCXA`](https://stellar.expert/explorer/testnet/contract/CAGWIGEGGTPZK7SPERJRW3EYSEHGSZKQEKEH6SU4ECU6EI7BKTAILCXA),
one deposit [`78183bfa...2ec2b`](https://stellar.expert/explorer/testnet/tx/78183bfa875d264f42bdda6e92b1809bc79651cc0ef0898ca3b900cb9952ec2b)
and its claim [`f478345c...139a3`](https://stellar.expert/explorer/testnet/tx/f478345c357c103e44f3e6c9e700e2dc6597bd402eccc475b71a0f9acac139a3).
It does not hide the amount: the deposit moves it through a public SAC transfer, and the report lists
every place it stays public.

### D2.5 Metric 2: a private link claimed on mainnet

_Pending: the owner's run_, from an approved pilot wallet, with no name typed and no rich preview
chosen (the defaults). Until every row is filled, metric 2 is not met.

| | |
|---|---|
| The link, key redacted | _pending_ |
| Deposit (mainnet) | _pending_ |
| Claim (mainnet) | _pending_ |
| Recipient account (created by the claim) | _pending_ |
| WhatsApp and Telegram preview cards | _pending: two screenshots_ |
| What a preview bot got (`curl -A`) | _pending: pasted output_ |
| Mainnet beacon routing seen on the mainnet Worker | _pending: the claim's counters arriving at `lumenia-sponsor-mainnet` and none at the testnet Worker (`wrangler tail` on both), the mainnet half the leak audit's row 10 leaves to this run_ |

### D2.6 Not verified yet, stated plainly

- The mainnet run above is not done yet; until it is, metric 2 is not met.
- The extension's published packages (Chrome Web Store 0.1.2 and AMO 0.1.2, both built from
  `062725f`, and the self-hosted 0.1.1) were built before D2 and make links in the old shape until
  0.1.3.
- Previews were checked with the chat apps' user agents, not inside every chat app; the cards on a
  real phone are the owner's screenshots.
- A v1 practice link's key (from /try or /event) is also the key of the account it opens. Until
  2026-10-07 that account became the device's home account on a first claim; since then the link's
  account is only ever a throwaway and the money moves into a home made on the device (leak audit row
  20). A device that adopted a link's account as home before the fix keeps it; /privacy says so.
- For a link made before D2 (or edited by hand), Next.js copies the request's own query into the
  page's script data. Nothing new is revealed (a bot already sent those bytes), but those bytes are
  in the HTML.

---

## D3. Open-mainnet readiness: the hardened sponsor, the KMS signer, the retirement switch

Status: **code done, tested and deployed, 2026-10-08.** Every item below is held by an offline
suite that runs in CI under the step "Hardening suite (D3 a-k)" (green, D3.2). Both Workers run this
code since 2026-10-08 (the mainnet one with `PILOT_MODE=1` kept), and the live adversarial runs,
the watchdog stamps and the heartbeat workflow's first runs are below. Still pending, the owner's
steps: the KMS cutover (without it, metric 3 is not met) and the rehearsal on the deployed testnet
Worker; [`SOW2_OPS_NOTE.md`](SOW2_OPS_NOTE.md) holds their exact commands and logs.

What D3 does not do: open mainnet. The mainnet Worker keeps `PILOT_MODE=1` (hand-approved wallets
only; $5 a link and up to $25 a day from one sender, $50 a day across the whole pilot; fail-closed)
until the written legal opinion the Customer Development Plan names (section 7.4). D3 makes that
opening a configuration change, so far dry-run on a local Worker against the live testnet ledger;
its rehearsal on the deployed testnet Worker is still to run (D3.4). The opening also ends the
hand-approval, which is the only stand-in for KYC and AML today; D3.8 lists that and the other
limits that remain after D3.

"Before" refers to the code at `d78f4de` (the parent of this work), and the file and line references
in that column are at that commit; "after" refers to `227db3f`, and every other file and line cited
in this section holds at `24d0f4e` as well.

### D3.1 Item by item

| Item | Before | After | Where | Held by |
|---|---|---|---|---|
| a. Simulation and tight fee bounds on the Soroban relays | `/v2-deposit` never simulated and fee-bumped any client-declared fee up to a flat 2 XLM (`soroban-relay.ts:85`, `:331`); `/v2-reclaim` already simulated; nothing offline reached the reclaim relay | `/v2-deposit` simulates before the caps, the fee budget and the signature; refuses `inner.fee > minResourceFee + 2,500,000`, any simulation error, and a simulation that names no numeric resource fee (the bound would otherwise fail open on `NaN`), with nothing spent; 2 XLM stays the outer cap. A deposit must move the sender's own USDC (`from` is the sender). The fee-bump bids the smallest valid base, the inner's own inclusion fee: `2 x inclusion + resource fee`, where the relays used to bid `2 x (inclusion + resource) + resource`. A deposit or take-back whose sender-signed inner DECLARES a resource fee its own fee cannot cover (less than 100 stroops left for inclusion) is refused before anything is reserved: core refuses such an inner anyway, but the fee-bump around it used to bid `200 + R` with R the client's number (a review declared 14 XLM inside a 0.2 XLM fee and the sponsor signed a 14 XLM bid); a NEGATIVE declared fee is refused too (the field is a signed int64), and the built fee-bump may bid at most twice the inner's fee. The classic routes that fee-bump a client's transaction (`/feebump`, `/payout`, `/sweep`) refuse any bid other than their own nominal one, because the SDK adds a resource fee declared on a classic inner to the bid and nothing read that field (the review had a claim declare 14 XLM and the sponsor bid 140,002,000 stroops). All three relays (and the CCTP relay) take an injectable RPC client | `apps/sponsor/src/lib/soroban-relay.ts:659`, `apps/sponsor/src/lib/soroban-relay.ts:667`, `apps/sponsor/src/lib/soroban-relay.ts:102`, `apps/sponsor/src/lib/soroban-relay.ts:109`, reclaim `apps/sponsor/src/lib/soroban-relay.ts:795`, `apps/sponsor/src/lib/soroban-relay.ts:614`, `apps/sponsor/src/lib/soroban-relay.ts:160`, `apps/sponsor/src/lib/soroban-relay.ts:190`, `apps/sponsor/src/lib/soroban-relay.ts:205`, `apps/sponsor/src/lib/feebump.ts:79` | `test:soroban-relay` [7], [10], [11], [12], [13]; `test:caps` [16]; `test:cctp` |
| b. A per-day sponsor fee budget | none; `/health` showed six fields | every route the sponsor signs adds the fee it BIDS to `caps:<net>:fees:<day>` before the sponsor's signature, and past `MAX_DAY_FEE_XLM` (mainnet 15, testnet 2000) refuses with "today's sponsor fee budget is spent; try again tomorrow". The network's answer then settles the charge: a transaction that provably never reached a ledger (the signer threw, core refused it while validating, the RPC declined to queue it or refused the request, or Horizon does not know its hash when asked twice, one ledger apart) gives its bid back; an included one, SUCCESS or FAILED, counts the fee its result reports; an undecided one keeps the whole bid. So the count is at or above the real spend at every moment (this amends the brief's "never given back"; D3.7 says why). `/health` shows the day's spend; the watchdog pages at 80 percent | `apps/sponsor/src/lib/caps.ts:1022`, `apps/sponsor/src/lib/caps.ts:902`, `apps/sponsor/src/lib/caps.ts:982`, `apps/sponsor/src/lib/stellar.ts:143`, `apps/sponsor/src/lib/stellar.ts:109`, `apps/sponsor/src/lib/soroban-relay.ts:260`; charged in `apps/sponsor/src/lib/feebump.ts:85`, `apps/sponsor/src/lib/send.ts:99`, `apps/sponsor/src/lib/payout.ts:90`, `apps/sponsor/src/lib/sweep.ts:97`, `apps/sponsor/src/lib/create-account.ts:215`, `apps/sponsor/src/lib/soroban-relay.ts:268`; `apps/sponsor/wrangler.toml:164`; `apps/sponsor/src/lib/watchdog.ts:864` | `test:caps` [12], [15], [16]; `test:soroban-relay` [8], [9], [10], [11]; `test:cctp` [submit]; `test:antidrain`; `test:watchdog-offline` [11] |
| c. Single-shot cap accounting | the deposit already released at most once (`releaseOnce`, `soroban-relay.ts:384`), but nothing locked it; `withPilotSlot` gave the pilot slot back on any throw (`worker.ts:172`); the approve link re-ran `approvePilot`, which resets a wallet's spent slots (`worker.ts:506`); an RPC that died mid-poll after the send was accepted, or a send call that threw, surfaced as a plain 400 that released everything | release counted per branch by tests (send ERROR 1, send refused outright 1, TRY_AGAIN_LATER 1, on-ledger FAILED 1, NOT_FOUND 0, RPC death mid-poll 0, a send that threw unanswered 0, DUPLICATE 0); the pilot slot is kept for an unconfirmed submit; the approve link decides from the allowlist flag itself, read with a call that throws (a revoked wallet's link re-admits it; a failed read answers 503 and approves nothing); no approval path refills spent slots (the counter is written with `SET ... NX`); a revoke sets the status with the flag | `apps/sponsor/src/lib/soroban-relay.ts:684`, `apps/sponsor/src/worker.ts:187`, `apps/sponsor/src/worker.ts:670`, `apps/sponsor/src/lib/pilot.ts:251`, `apps/sponsor/src/lib/pilot.ts:279`, `apps/sponsor/src/lib/soroban-relay.ts:311`, `apps/sponsor/src/lib/soroban-relay.ts:223` | `test:soroban-relay` [8]; `test:pilot` [6], [12], [13] |
| d. A per-share floor on group drops | already done before D3 (`soroban-relay.ts:368`) | unchanged: `create_drop(amount, slots)` is refused when `amount / slots` is under `MIN_DROP_USDC`, so a cent cannot buy thirty sponsored accounts | `apps/sponsor/src/lib/soroban-relay.ts:639` | `test:soroban-relay` [4] |
| e. A per-source onboarding budget two addresses cannot exhaust | mainnet 40 a day with a derived per-source share floored at 20 (`caps.ts:284`, `wrangler.toml:158-159`), so two IPv4 addresses could refuse every recipient until UTC midnight; the test asserted that ratio (`test-caps.ts:340`); a retry for the same recipient cost a second slot | mainnet 60 a day and 8 per source; the derived share is `ceil(day/8)` with no floor on mainnet; one marker per recipient key and day makes an honest retry free. The marker is read with the increments and written (`SET NX`) only once both limits have passed, so a request the limits refuse leaves nothing a concurrent request for the same key could be served on (it used to be written first, and a review had a refused request's marker serve a second request as a repeat with no limit checked). The slot is fenced: the marker holds the admitting request's token, a repeat re-stamps it, and a release gives the slot back only while the token is still its own, so a first attempt that fails after its retry was served cannot make the day read low. A repeat re-stamps the marker before it hands its increments back, so a marker that vanished in between leaves the request counted and admitted afresh, and a lost answer to the marker's write is released through the fence. A repeat is served on the sponsor path, without a channel lease (leased repeats let one address empty the pool, a review measured), at most ten times per key and source a day (each is a signed sandwich the fee budget counts; per source, so nobody who knows an address can spend its owner's retries) | `apps/sponsor/src/lib/caps.ts:453`, `apps/sponsor/src/lib/caps.ts:206`, `apps/sponsor/src/lib/caps.ts:609`, `apps/sponsor/src/lib/caps.ts:802`, `apps/sponsor/src/lib/caps.ts:576`, `apps/sponsor/src/worker.ts:396`, `apps/sponsor/src/worker.ts:407`, `apps/sponsor/src/lib/caps.ts:223`, `apps/sponsor/wrangler.toml:181`, `apps/sponsor/wrangler.toml:185` | `test:caps` [11], [11b], [11c] |
| f. Watchdog heartbeat and automatic halt on its own tripwires | no record of the watchdog having run; nothing halted on its own; the halt key and the alert cooldown keys were shared by both Workers' store, so a testnet halt or alert reached mainnet | every run ends by writing `watchdog:<net>:lastrun`; `/health` reports it with the alerting state, the halt state, the signer and the day's counters; a GitHub workflow is scheduled to read both `/health` pages every 30 minutes (GitHub starts it late: D3.5 has the runs so far) and opens one issue when a stamp is older than 45 minutes; the sponsor halts itself through `sponsor:halt:<net>` on exactly two findings ("Sponsor SOURCED a forbidden operation", "Escrow WASM CHANGED"), never on the float, capacity, state expiry, a governance event or a failed check; the halt key and the cooldowns are per network; the store read still fails open (section D3.8). A second stamp, `watchdog:<net>:lastfull`, is written only when every check completed, and the workflow also fails when it is older than 3 hours, when a stamp is from the future, when `/health` is not JSON, and when the mainnet Worker reports alerting not configured (a revoked key or an unverified sender still reads as configured). Only the Worker's scheduled run may halt or write (`runWatchdog` is read-only without both flags, so a local smoke test cannot halt a Worker); a halt cleared without removing its cause comes back on the next run and is emailed at once; a wasm mismatch halts only when a second read 2 seconds later repeats it; on a cold start (no scan cursor: a first run, or a cursor the store lost) a forbidden operation older than 24 hours pages without halting, while a scan that walks forward from its cursor halts on one of any age; the operation scan reads up to 10 pages a run and pages when it is behind; its cursor moves only once the halt has landed; a scan cursor or wasm pin the store cannot read (an error, not an absent key) skips that check with a page instead of restarting the scan from scratch, which would jump over everything since the cursor and write the jump down; the alert cooldown is stamped only after the mail was accepted; the halt read the routes share is one store read per isolate and network while it is in flight, a verdict written meanwhile outranks its answer, and a read that does not answer in 2 seconds fails open | `apps/sponsor/src/lib/watchdog.ts:1208`, `apps/sponsor/src/lib/watchdog.ts:135`, `apps/sponsor/src/lib/watchdog.ts:1130`, `apps/sponsor/src/lib/kill-switch.ts:69`, `apps/sponsor/src/lib/kill-switch.ts:116`, `apps/sponsor/src/lib/kill-switch.ts:58`, `apps/sponsor/src/lib/watchdog.ts:231`, `apps/sponsor/src/lib/watchdog.ts:936`, `apps/sponsor/src/worker.ts:341`, `apps/sponsor/src/worker.ts:1090`, `apps/sponsor/src/lib/watchdog.ts:202`, `.github/workflows/watchdog-heartbeat.yml` | `test:watchdog-offline` (193 checks, every tripwire with `fetch` stubbed, and the Worker's own scheduled run with account != signer) |
| g. Unconfirmed submissions on every value route | `/v2-claim`, `/v2-reclaim` and `/cctp-relay` threw on NOT_FOUND; the Worker answered 400, which mainnet redacts to "request failed", so the claim screen offered a retry that minted another sponsored account for a claim that then landed | the three answer 202 `{hash, confirmed:false}` like `/v2-deposit`; TRY_AGAIN_LATER answers 503 "the network is busy; try again shortly" with the budget given back; DUPLICATE counts as on the network. A send call that throws without a definitive refusal is an unconfirmed submit too, on all four Soroban relays, and `/cctp-relay` has one 202 body for a submitted mint. The web settles a claim's 202 from the claim transaction itself (SUCCESS is claimed; FAILED, or NOT_FOUND past its 60-second time bound plus a margin, is not landed and may be retried) and the payout's balance, never from the escrow's `claimed` flag, which a take-back sets too; a 202 from a Horizon route (`/feebump`, `/send-link`, `/sweep`, `/demo-link`) is one typed unconfirmed error everywhere (a direct payment re-checks the ledger and offers no second payment; a sweep keeps its key until Horizon shows the merge); the take-back, CCTP and agent tools and the extension no longer call an unconfirmed outcome done; the busy answer, the fee budget's refusal and the operator halt are three different sentences on the claim screens and in the extension | `apps/sponsor/src/worker.ts:518`, `apps/sponsor/src/worker.ts:498`, `apps/sponsor/src/worker.ts:1067`, `apps/sponsor/src/lib/soroban-relay.ts:132`, `apps/sponsor/src/lib/soroban-relay.ts:223`, `apps/web/lib/lumendrop.ts:749`, `apps/web/lib/claim-error.ts:162`, `apps/web/lib/unconfirmed.ts:49`, `apps/web/lib/horizon.ts:359`, `apps/web/lib/sweep.ts:113` | `test:soroban-relay` [8], [10], [11]; `test:cctp` [submit]; `test:claimerr`; `test:group` [7], [8]; `test:horizon`; `test:cctp-web`; `test:agentmcp`; extension `test:links`, `test:send` |
| h. The production signer leaves the environment variable (KMS) | the code used the signer's own address as the sponsor account at 22 call sites in 9 files, so moving the key into KMS would have made the Worker act as a new, unfunded account | `SPONSOR_ACCOUNT_ID` names the existing account and every operation source, fee-bump source and sponsored reserve reads it; the signer only signs; `/health` reports `signer.kind` (`env` or `kms`) and the account; the KMS key is added to the existing account as a weight-1 signer with one SetOptions (tools `kms-check` and `add-signer`); runbook rewritten. KMS mode refuses to start without `SPONSOR_ACCOUNT_ID`; `/health` names where the account came from (`accountSource`); the signing key's own address is refused as a recipient, sender, throwaway, home or operation source, because the KMS signature is also that address's master signature; each KMS call has one retry and a 5-second deadline, and AWS error bodies stay in the log; `add-signer` writes an unsigned dry run with the signers before the change and submits exactly that transaction; the watchdog runs with no KMS call | `apps/sponsor/src/lib/config.ts:155`, `apps/sponsor/src/lib/config.ts:192`, `apps/sponsor/src/lib/service.ts:47`, `apps/sponsor/src/lib/kms-signer.ts:216`, `apps/sponsor/src/lib/service.ts:63`, `apps/sponsor/src/lib/anti-drain.ts:69`, `apps/sponsor/src/cli/add-signer.ts`, `apps/sponsor/src/cli/kms-check.ts`, `ops/RUNBOOK_SPONSOR_KEY.md` section 2 | `test:kms` [6] to [12] ([8] runs every value handler and `/health` with the account and the signer two addresses, and five reverts to the signer's address each fail it; [9] KMS mode without `SPONSOR_ACCOUNT_ID`; [10] the KMS transport; [11], [12] `add-signer` end to end); `test:cctp` [submit] (the CCTP relay with the account and the signer two addresses); `test:caps` [17]; `test:antidrain` SIG-1 to SIG-9 |
| i. The waitlist retirement behind one switch | unsetting `PILOT_MODE` made the sponsor answer `{pilot:false, approved:false}`, which the web read as "not approved" (`wallet.tsx:194`), so the flip would have locked every user out of real money | `PILOT_MODE` unset: `/pilot-status` answers `{pilot:false, approved:true, state:"open"}`, the allowlist is a no-op, and the web opens real money to every wallet that is locked and backed up (others are sent to do that first, and the wallet refuses to sign a money movement for them on real money); a device with no account learns it from `/pilot-status` asked without a key, answered before the rate limiter; set: the sponsor behaves as before (the web adds two checks of its own on real money: the lock-and-backup card on /home, and no money movement before `/pilot-status` has answered once). Everyone sees the real-money warning once per device, on the first switch or on arriving on real money; on arrival, "Not now" returns to practice money only when the account may switch back, so a recipient the pilot has not approved is never stranded. Every cap survives the flip (only `pilot.ts` and `worker.ts` read the variable) | `apps/sponsor/src/worker.ts:630`, `apps/web/lib/pilot-access.ts:73`, `apps/web/lib/pilot-access.ts:118`, `apps/web/lib/pilot-access.ts:150`, `apps/web/lib/pilot-access.ts:185`, `apps/web/lib/wallet.tsx:354`, `apps/sponsor/wrangler.toml:193` | `test:pilot` [12], [13]; `test:pilotaccess` (the rules as pure functions; their use in `wallet.tsx` is not under test); extension `test:router` [f], `test:send`; the local dry run (D3.4; the rehearsal on the deployed Worker is still to run) |
| j. A scripted adversarial run | none | `apps/sponsor/src/adversarial-run.ts`: inflated fees, budget exhaustion, junk claims and transactions, rate limits, the halt switch; full mode (testnet, or a local Worker with a stand-in store) and refusal-only mode (the live mainnet Worker: nothing funded, nothing that can land submitted, no counter seeded, full mode refused) | `apps/sponsor/src/adversarial-run.ts`, `apps/sponsor/src/cli/fake-kv.ts` | the runs in D3.3; `test:antidrain`; `fake-kv --selftest` |
| k. A per-sender day cap | the $50 day was global: one wallet could spend all of it | `MAX_DAY_USDC_PER_SENDER` (mainnet 25), reserved and released together with the day counter on `/send-link` and `/v2-deposit` | `apps/sponsor/src/lib/caps.ts:310`, `apps/sponsor/src/lib/caps.ts:170`, `apps/sponsor/src/lib/soroban-relay.ts:672`, `apps/sponsor/wrangler.toml:155` | `test:caps` [13] |

### D3.2 The tests

| Suite (offline, no keys) | Items | Before D3 | After D3 |
|---|---|---|---|
| `apps/sponsor` `test:soroban-relay` | a, b, c, d, g | 42 | 141 |
| `apps/sponsor` `test:caps` | a, b, e, h, k | 82 | 274 |
| `apps/sponsor` `test:watchdog-offline` (new) | f, b | none | 193 |
| `apps/sponsor` `test:kms` | h | 13 | 142 |
| `apps/sponsor` `test:pilot` | c, i | 46 | 80 |
| `apps/sponsor` `test:cctp` | a, b, g, h | 37 | 55 |
| `apps/sponsor` `test:antidrain` | b, h, j (what the junk probes replay) | 60 | 71 |
| `apps/sponsor` `fake-kv --selftest` (new) | j (the stand-in store the adversarial run needs) | none | 33 |
| `apps/web` `test:claimerr` | g | 44 | 75 |
| `apps/web` `test:group` | g | 57 | 84 |
| `apps/web` `test:horizon` | g | 45 | 62 |
| `apps/web` `test:cctp-web` | g | 18 | 24 |
| `apps/web` `test:agentmcp` | g | 26 | 30 |
| `apps/web` `test:pilotaccess` (new) | i | none | 62 |
| `apps/extension` `test` (all nine suites) | g, i | 1,814 | 1,927 |

The CI step `Hardening suite (D3 a-k)` (`.github/workflows/ci.yml:119`) runs `test:soroban-relay`,
`test:cctp`, `test:caps`, `test:watchdog-offline`, `test:kms`, `test:pilot`, `test:antidrain`,
`fake-kv --selftest`, `test:claimerr`, `test:group`, `test:horizon`, `test:cctp-web`, `test:agentmcp`
and `test:pilotaccess` under the name the SOW uses; all but the store self-test also run in the
general steps above it, and the extension's suite runs in its own job. The whole offline gate on `227db3f`, run locally on 2026-10-08: sponsor 12
suites / 1,200 assertions, web 19 / 869, extension 9 / 1,927, the escrow contract's `cargo test` 29/29,
three typechecks clean, web lint clean at `--max-warnings 0`, the web production build 70/70 pages.
CI runs: [37813352621](https://github.com/getlumenia/lumenia/actions/runs/37813352621), green on commit `227db3f` (2026-10-08), the step "Hardening suite (D3 a-k)" included, and [37821341438](https://github.com/getlumenia/lumenia/actions/runs/37821341438), green on `24d0f4e` (2026-10-08) with the same steps.

Browser runs with the D3 web code (a local production build, 2026-10-08): the live claim
regression `e2e/claim.spec.ts` passed against the D3 sponsor (a local `wrangler dev` of the D3
code, after the third review round; testnet tx [`4f76dd36...74a5ed`](https://stellar.expert/explorer/testnet/tx/4f76dd36fd502fba82ea3b2d6f47b58981fe317ff0966782a8996f049f74a5ed)) and against the deployed,
pre-D3 testnet sponsor (tx [`930437d4...d9beec`](https://stellar.expert/explorer/testnet/tx/930437d46135133f6a2637b212a9662be507769381a3aaf2e969658ee3d9beec)), so the web can ship before the Worker; `e2e/preview.spec.ts`, which makes and claims a private link
(`/v2-deposit` + `/v2-claim`), passed against the D3 sponsor after the third round as well.

### D3.3 The scripted adversarial run

`pnpm --filter @lumenia/sponsor adversarial -- --target <url> --network <net> --mode full|refusal-only`.
Every probe is a row with what was expected and what came back; the script writes throwaway keys to
disk before funding them, reads the sponsor's balance before every spend, stops past `--budget-xlm`,
and refuses full mode against a non-local mainnet target, because the exhaustion section would lock
real recipients out until UTC midnight. The halt and pre-seeded-counter probes need `--kv`: a local
stand-in for the store (`pnpm --filter @lumenia/sponsor fake-kv`), never the production store.

A refusal counts only when nothing was charged: every refusal probe runs inside a fee window
(`/health` `fees.spentXlm` read before the probes and 6 s after the last one, plus `fees.grossXlm`,
every bid the budget accepted that day, which a give-back never lowers; with `--kv`, the stand-in store's own gross of the fee key), so mainnet's redacted
"request failed" is not taken as proof on its own; probes the pilot allowlist answers first are
SKIP, not PASS; and with `--kv` the target must first echo a nonce set at `watchdog:<net>:lastrun`
in the stand-in store, or the exhaustion and halt sections are refused, and so is full mode on
mainnet.

**Run 1: full mode, the D3 code on the testnet ledger.** A local `wrangler dev` of the D3 code with
the testnet sponsor key, the live testnet ledger and RPC, and the local stand-in store, which the
Worker first proved it reads (the setup row). One real 0.2 USDC deposit and its take-back landed,
the onboarding rows were served where the budgets allow it, every other probe was refused, and the
fee windows show nothing charged by any refused probe.

| # | Section | Probe | Expected | Got | Result |
|---|---|---|---|---|---|
| 1 | setup | the target reads the fake store (a nonce SET at the watchdog heartbeat key comes back on /health) | /health watchdog.lastRun echoes the nonce | set watchdog:testnet:lastrun = 2001-02-16T13:17:13.380Z; /health watchdog.lastRun = 2001-02-16T13:17:13.380Z | PASS |
| 2 | setup | onboard + fund the throwaway sender | an account with test USDC | GCLFCH... funded | PASS |
| 3 | a. fees | /v2-deposit inner fee = 2 XLM cap + 1 stroop | 400 refused by the cap; nothing counted against the fee budget | 400 {"error":"inner fee 20000001 exceeds cap 20000000"} | PASS |
| 4 | a. fees | /v2-deposit from an unfunded sender (simulation fails) | 400 refused by the simulation; nothing counted against the fee budget | 400 {"error":"v2-deposit would fail: HostError: Error(Contract, #13)  ... | PASS |
| 5 | a. fees | /v2-reclaim of a drop that does not exist (simulation fails) | 400 refused by the simulation; nothing counted against the fee budget | 400 {"error":"v2-reclaim would fail: HostError: Error(Contract, #2)  ... | PASS |
| 6 | a. fees | /v2-deposit fee = simulated need + headroom + 0.01 XLM (2829317 stroops, local minResourceFee 229317) | 400 refused, naming the bound; nothing counted against the fee budget | 400 {"error":"inner fee 2829317 exceeds what the deposit needs (2729320)"} | PASS |
| 7 | a. fees | the fee budget across the 4 probe(s) above | nothing charged: fees.spentXlm (and the gross, when readable) unchanged 6 s after the last probe | fees.spentXlm 0.00004 -> 0.00004; nothing charged (the fake store's gross) | PASS |
| 8 | a. fees | /v2-deposit at exactly the bound (2729317 stroops; the one real 0.2 USDC deposit) | 200 confirmed or 202 accepted, with a hash | 200 {"hash":"87f1a1f2...9c54b414","confirmed":true} | PASS |
| 9 | c. junk | /v2-claim with a 31-byte link | refused; nothing counted against the fee budget | 400 {"error":"link must be 32 bytes (hex)"} | PASS |
| 10 | c. junk | /v2-claim naming a foreign contract id | refused; nothing counted against the fee budget | 400 {"error":"contract not allowed: CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR"} | PASS |
| 11 | c. junk | /v2-claim with a method outside the allowlist | refused; nothing counted against the fee budget | 400 {"error":"method not allowed: withdraw"} | PASS |
| 12 | c. junk | /v2-claim with a random 64-byte signature for a real unclaimed link | refused by the simulation; nothing counted against the fee budget | 400 {"error":"v2-claim simulation failed: HostError: Error(Crypto, InvalidInput)  ... | PASS |
| 13 | c. junk | /feebump: a sponsor-sourced payment inside the claim | refused; nothing counted against the fee budget | 400 {"error":"anti-drain rejected the inner tx: op sequence [payment] != expected [claimClaimableBalance]"} | PASS |
| 14 | c. junk | /feebump: a claim whose balance id differs from the one named | refused; nothing counted against the fee budget | 400 {"error":"anti-drain rejected the inner tx: claim balanceId 00000000cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdc... | PASS |
| 15 | c. junk | /feebump: a claim op sourced by a muxed (M...) address | refused; nothing counted against the fee budget | 400 {"error":"anti-drain rejected the inner tx: op 'claimClaimableBalance' source must be a plain G... acco... | PASS |
| 16 | c. junk | /send-link: a send whose claimable balance has three claimants (a bigger sponsored reserve) | refused; nothing counted against the fee budget | 400 {"error":"anti-drain rejected the send tx: createClaimableBalance has 3 claimants, expected 2"} | PASS |
| 17 | c. junk | /send-link: a send with no unconditional claimant (the reserve could stay locked) | refused; nothing counted against the fee budget | 400 {"error":"anti-drain rejected the send tx: createClaimableBalance has no unconditional claimant (reserv... | PASS |
| 18 | c. junk | /payout: a payout to a destination that is not the one named | refused; nothing counted against the fee budget | 400 {"error":"anti-drain rejected the payout tx: payout destination GBWAXOXXPKAAR3PWROEJIZB5WEGOI2PIOBHOEOJ... | PASS |
| 19 | c. junk | /sweep: a sweep whose payment the sponsor sources | refused; nothing counted against the fee budget | 400 {"error":"anti-drain rejected the sweep tx: sweep must be [payment,changeTrust,accountMerge] (optionall... | PASS |
| 20 | c. junk | /feebump: a claim whose inner fee is far over the fee-bump cap | refused; nothing counted against the fee budget | 400 {"error":"Invalid baseFee, it should be at least 5000000 stroops."} | PASS |
| 21 | c. junk | /feebump: a body whose xdr is not XDR | refused; nothing counted against the fee budget | 400 {"error":"XDR Read Error: unknown EnvelopeType member for value 158"} | PASS |
| 22 | c. junk | the fee budget across the 13 probe(s) above | nothing charged: fees.spentXlm (and the gross, when readable) unchanged 6 s after the last probe | fees.spentXlm 0.0193821 -> 0.0193821; nothing charged (the fake store's gross) | PASS |
| 23 | b. budgets | /create-account from a source at its share (120, pre-seeded) | 400 'paused for today' | 400 {"error":"new accounts from this connection are paused for today - its limit of 120 is reached; try aga... | PASS |
| 24 | b. budgets | /create-account from a second source while the first is paused | not the 'paused' refusal (served, or a chain reason further down) | 200 {"xdr":"<a sponsor-signed sandwich>" | PASS |
| 25 | b. budgets | /create-account twice for the same recipient key | both served (200), and the day counter moves by exactly 1 | 200, 200; counter 2 -> 3 | PASS |
| 26 | b. budgets | /v2-deposit with the day at its cap of 1000 USDC (pre-seeded) | 400 'daily escrow cap ... reached' | 400 {"error":"canary cap: daily escrow cap of 1000 USDC reached; try again tomorrow"} | PASS |
| 27 | b. budgets | a deposit accepted by the simulation and refused by the network (stale sequence) | refused, and the day counter is back where it was (never below) | 400 {"error":"v2-deposit send failed: {\"_maxDepth\":200,\"_attributes\":{\"feeCharged\":{\"_value\":\"2295... | PASS |
| 28 | b. budgets | /v2-deposit with the day's fee budget spent (2000 XLM, pre-seeded) | 400 'today's sponsor fee budget is spent' | 400 {"error":"today's sponsor fee budget is spent; try again tomorrow"} | PASS |
| 29 | b. budgets | /create-account with the day's fee budget spent | 400 'today's sponsor fee budget is spent' | 400 {"error":"today's sponsor fee budget is spent; try again tomorrow"} | PASS |
| 30 | a. fees | /v2-reclaim fee = simulated need + headroom + 0.01 XLM (2627478 stroops, local minResourceFee 27478) | 400 refused, naming the bound; nothing counted against the fee budget | 400 {"error":"inner fee 2627478 exceeds what the reclaim needs (2527481)"} | PASS |
| 31 | a. fees | the fee budget across the 1 probe(s) above | nothing charged: fees.spentXlm (and the gross, when readable) unchanged 6 s after the last probe | fees.spentXlm 0.0195021 -> 0.0195021; nothing charged (the fake store's gross) | PASS |
| 32 | a. fees | /v2-reclaim at exactly the bound (2527478 stroops; the money comes back) | 200 confirmed or 202 accepted | 200 {"hash":"90f2674e...a1be76f4","confirmed":true} | PASS |
| 33 | d. rate limits | 17 junk /v2-claim posts for one payout key | the per-account limiter's 429 by post 16, and not before post 12 | first 429 at post 16: 429 {"error":"per-account rate limit exceeded"} | PASS |
| 34 | d. rate limits | 305 GETs to /events/summary from one address | the per-IP limiter's 429 by request 301 | first 429 at request 285: 429 {"error":"per-IP rate limit exceeded"} | PASS |
| 35 | e. halt | SET sponsor:halt:testnet = 1: the 11 value routes and 2 grant routes | all 503 within 5 s | 13/13 answered the halt | PASS |
| 36 | e. halt | while sponsor:halt:testnet is set: the read routes | /health 200 (halted:true), /pilot-status not 503 | /health 200 halted=true /pilot-status 200 | PASS |
| 37 | e. halt | DEL sponsor:halt:testnet: the value routes answer again | no longer the halt's 503 within 5 s | recovered at 4000 ms | PASS |
| 38 | e. halt | SET sponsor:halt = 1: the 11 value routes and 2 grant routes | all 503 within 5 s | 13/13 answered the halt | PASS |
| 39 | e. halt | while sponsor:halt is set: the read routes | /health 200 (halted:true), /pilot-status not 503 | /health 200 halted=true /pilot-status 200 | PASS |
| 40 | e. halt | DEL sponsor:halt: the value routes answer again | no longer the halt's 503 within 5 s | recovered at 4001 ms | PASS |

Totals: 40 probes, 40 pass, 0 fail, 0 skipped.
Sponsor balance: before 19994.1249669 XLM / 0 USDC, after 19994.1038119 XLM / 0 USDC; spent 0.0211550 XLM.
Run: 2026-10-08T14-39-29-842Z UTC, target http://127.0.0.1:8790, network testnet, mode full.
Its two real transactions, read back from horizon-testnet as successful: the deposit (row 8)
[`87f1a1f2...54b414`](https://stellar.expert/explorer/testnet/tx/87f1a1f2a7c0238dd171ba4a665c604a2c58b4cb6f538cf1b1efcd7e9c54b414)
at ledger 5,089,364 and the take-back (row 32)
[`90f2674e...a1be76f4`](https://stellar.expert/explorer/testnet/tx/90f2674eed143524373cff30ea8e84cc9d71d7977c3cd155d1aeb6c3a1be76f4)
at ledger 5,089,397.

**Run 2: full mode without section a, the mainnet configuration.** A local
`wrangler dev --env mainnet` of the D3 code with a throwaway sponsor key (no account on mainnet, so
nothing it signed could ever land), the live mainnet RPC for reads only, and the local stand-in
store, never the production one. Section a needs a funded mainnet sender, so it is skipped, and so
are the rows that need one; it shows the mainnet Worker's own answers: the redaction ("request
failed" with a reference, proven harmless by the fee window), the real 30-a-minute and 5-a-minute
limits, the onboarding share of 8, and the halt on both keys. Its junk `/v2-claim` rows cannot fail
in this setup: the throwaway sponsor has no mainnet account, so nothing it signed could land
whatever the guard did; they show the answer, and the fee window shows nothing was charged. A first
attempt, started the moment Run 1 ended, had ten junk rows answered 429 by the rate limiter (the
runner marks such rows FAIL, never PASS): the limiter's windows are shared by the two networks (D3.8),
and Run 1's last minute had filled the mainnet Worker's 30. The runner now starts its junk section in
a fresh minute, and the run below is the repeat. Its two "read routes" rows show `/pilot-status`
429: that is the route's own limiter (section d's burst, in the same minute, had used the address's 30), which runs
after the only place a halt answers 503 (`apps/sponsor/src/worker.ts:318`, value and grant routes only), so the
route was reached, not halted; `/health` read `halted: true` at the same moment.

| # | Section | Probe | Expected | Got | Result |
|---|---|---|---|---|---|
| 1 | setup | the target reads the fake store (a nonce SET at the watchdog heartbeat key comes back on /health) | /health watchdog.lastRun echoes the nonce | set watchdog:mainnet:lastrun = 2001-09-29T17:28:08.307Z; /health watchdog.lastRun = 2001-09-29T17:28:08.307Z | PASS |
| 2 | c. junk | /v2-claim with a random signature for a real unclaimed link | 400 refused | not run (needs the real link from full mode) | SKIP |
| 3 | c. junk | /send-link: a send whose claimable balance has three claimants (a bigger sponsored reserve) | refused; nothing counted against the fee budget | not run (the pilot gate answers first (pilotMode true): a wallet nobody approved never reaches the send policy, whic...) | SKIP |
| 4 | c. junk | /send-link: a send with no unconditional claimant (the reserve could stay locked) | refused; nothing counted against the fee budget | not run (the pilot gate answers first (pilotMode true): a wallet nobody approved never reaches the send policy, whic...) | SKIP |
| 5 | c. junk | /v2-claim with a 31-byte link | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"7fc818ee"} | PASS |
| 6 | c. junk | /v2-claim naming a foreign contract id | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"6a132247"} | PASS |
| 7 | c. junk | /v2-claim with a method outside the allowlist | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"03c795b8"} | PASS |
| 8 | c. junk | /feebump: a sponsor-sourced payment inside the claim | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"c5728128"} | PASS |
| 9 | c. junk | /feebump: a claim whose balance id differs from the one named | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"5d9f9d2c"} | PASS |
| 10 | c. junk | /feebump: a claim op sourced by a muxed (M...) address | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"5e4e445a"} | PASS |
| 11 | c. junk | /payout: a payout to a destination that is not the one named | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"717d2ef3"} | PASS |
| 12 | c. junk | /sweep: a sweep whose payment the sponsor sources | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"b20ff44c"} | PASS |
| 13 | c. junk | /feebump: a claim whose inner fee is far over the fee-bump cap | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"3071c68d"} | PASS |
| 14 | c. junk | /feebump: a body whose xdr is not XDR | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"57c1f679"} | PASS |
| 15 | c. junk | the fee budget across the 10 probe(s) above | nothing charged: fees.spentXlm (and the gross, when readable) unchanged 6 s after the last probe | fees.spentXlm 0 -> 0; nothing charged (the fake store's gross) | PASS |
| 16 | b. budgets | /create-account from a source at its share (8, pre-seeded) | 400 'paused for today' | 400 {"error":"new accounts from this connection are paused for today - its limit of 8 is reached; try again... | PASS |
| 17 | b. budgets | /create-account from a second source while the first is paused | not the 'paused' refusal (served, or a chain reason further down) | 400 {"error":"request failed","ref":"357a8af6"} | PASS |
| 18 | b. budgets | /create-account twice for the same recipient key | both served (200), and the day counter moves by exactly 1 | 400, 400; counter 0 -> 0 (the first call was not served (400 {"error":"request failed","ref":"b662d02b"}), so the retry cannot be mea...) | SKIP |
| 19 | b. budgets | the day cap, the failed-deposit counter and the fee budget | contained | not run (the throwaway sender was not funded) | SKIP |
| 20 | d. rate limits | 7 junk /v2-claim posts for one payout key | the per-account limiter's 429 by post 6, and not before post 2 | first 429 at post 6: 429 {"error":"per-account rate limit exceeded"} | PASS |
| 21 | d. rate limits | 35 GETs to /events/summary from one address | the per-IP limiter's 429 by request 31 | first 429 at request 25: 429 {"error":"per-IP rate limit exceeded"} | PASS |
| 22 | e. halt | SET sponsor:halt:mainnet = 1: the 11 value routes and 2 grant routes | all 503 within 5 s | 13/13 answered the halt | PASS |
| 23 | e. halt | while sponsor:halt:mainnet is set: the read routes | /health 200 (halted:true), /pilot-status not 503 | /health 200 halted=true /pilot-status 429 | PASS |
| 24 | e. halt | DEL sponsor:halt:mainnet: the value routes answer again | no longer the halt's 503 within 5 s | recovered at 4002 ms | PASS |
| 25 | e. halt | SET sponsor:halt = 1: the 11 value routes and 2 grant routes | all 503 within 5 s | 13/13 answered the halt | PASS |
| 26 | e. halt | while sponsor:halt is set: the read routes | /health 200 (halted:true), /pilot-status not 503 | /health 200 halted=true /pilot-status 429 | PASS |
| 27 | e. halt | DEL sponsor:halt: the value routes answer again | no longer the halt's 503 within 5 s | recovered at 4001 ms | PASS |

Totals: 27 probes, 22 pass, 0 fail, 5 skipped.
Sponsor balance: not readable (a local throwaway sponsor key that has no account on this network).
Run: 2026-10-08T14-46-05-554Z UTC, target http://127.0.0.1:8788, network mainnet, mode full.

**Run 3: full mode against the deployed testnet Worker.**
`pnpm --filter @lumenia/sponsor adversarial -- --target https://lumenia-sponsor.avakit.workers.dev --network testnet --mode full --rate-cap 300 --account-rate-cap 15`.
Its first attempt, at 17:30 UTC on the first testnet deploy, had 28 rows and 2 failing, and both
were real findings: `/create-account` answered "Too many subrequests by single Worker invocation" at
the 40th call of the per-source exhaustion probe, because a full 40-channel pool cost one store round
trip per channel per pass and a Worker invocation may make only so many; and the runner's per-IP
burst, sent one request at a time over the internet, outlasted the limiter's one-minute window. The
lease now takes the first free channel of a pass in one round trip (commit `6b6b98c`, `test:channels`
[7] and [8]), and the burst goes out in parallel batches. The repeat, on that fix, at 17:48 UTC: the
exhaustion probe was served 75 times past the full pool and refused only by the address's share;
the store-dependent rows are SKIP by design (the live store is not ours to seed or halt).

| # | Section | Probe | Expected | Got | Result |
|---|---|---|---|---|---|
| 1 | setup | onboard + fund the throwaway sender | an account with test USDC | GBW7UH... funded | PASS |
| 2 | a. fees | /v2-deposit inner fee = 2 XLM cap + 1 stroop | 400 refused by the cap; nothing counted against the fee budget | 400 {"error":"inner fee 20000001 exceeds cap 20000000"} | PASS |
| 3 | a. fees | /v2-deposit from an unfunded sender (simulation fails) | 400 refused by the simulation; nothing counted against the fee budget | 400 {"error":"v2-deposit would fail: HostError: Error(Contract, #13)  ... | PASS |
| 4 | a. fees | /v2-reclaim of a drop that does not exist (simulation fails) | 400 refused by the simulation; nothing counted against the fee budget | 400 {"error":"v2-reclaim would fail: HostError: Error(Contract, #2)  ... | PASS |
| 5 | a. fees | /v2-deposit fee = simulated need + headroom + 0.01 XLM (2849324 stroops, local minResourceFee 249324) | 400 refused, naming the bound; nothing counted against the fee budget | 400 {"error":"inner fee 2849324 exceeds what the deposit needs (2749328)"} | PASS |
| 6 | a. fees | the fee budget across the 4 probe(s) above | nothing charged: fees.spentXlm (and the gross, when readable) unchanged 6 s after the last probe | fees.spentXlm 0.0226778 -> 0.0226778; nothing charged (/health fees.grossXlm) | PASS |
| 7 | a. fees | /v2-deposit at exactly the bound (2749328 stroops; the one real 0.2 USDC deposit) | 200 confirmed or 202 accepted, with a hash | 200 {"hash":"9afcdd14...a9b8f270","confirmed":true} | PASS |
| 8 | c. junk | /v2-claim with a 31-byte link | refused; nothing counted against the fee budget | 400 {"error":"link must be 32 bytes (hex)"} | PASS |
| 9 | c. junk | /v2-claim naming a foreign contract id | refused; nothing counted against the fee budget | 400 {"error":"contract not allowed: CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR"} | PASS |
| 10 | c. junk | /v2-claim with a method outside the allowlist | refused; nothing counted against the fee budget | 400 {"error":"method not allowed: withdraw"} | PASS |
| 11 | c. junk | /v2-claim with a random 64-byte signature for a real unclaimed link | refused by the simulation; nothing counted against the fee budget | 400 {"error":"v2-claim simulation failed: HostError: Error(Crypto, InvalidInput)  ... | PASS |
| 12 | c. junk | /feebump: a sponsor-sourced payment inside the claim | refused; nothing counted against the fee budget | 400 {"error":"anti-drain rejected the inner tx: op sequence [payment] != expected [claimClaimableBalance]"} | PASS |
| 13 | c. junk | /feebump: a claim whose balance id differs from the one named | refused; nothing counted against the fee budget | 400 {"error":"anti-drain rejected the inner tx: claim balanceId 00000000cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdc... | PASS |
| 14 | c. junk | /feebump: a claim op sourced by a muxed (M...) address | refused; nothing counted against the fee budget | 400 {"error":"anti-drain rejected the inner tx: op 'claimClaimableBalance' source must be a plain G... acco... | PASS |
| 15 | c. junk | /send-link: a send whose claimable balance has three claimants (a bigger sponsored reserve) | refused; nothing counted against the fee budget | 400 {"error":"anti-drain rejected the send tx: createClaimableBalance has 3 claimants, expected 2"} | PASS |
| 16 | c. junk | /send-link: a send with no unconditional claimant (the reserve could stay locked) | refused; nothing counted against the fee budget | 400 {"error":"anti-drain rejected the send tx: createClaimableBalance has no unconditional claimant (reserv... | PASS |
| 17 | c. junk | /payout: a payout to a destination that is not the one named | refused; nothing counted against the fee budget | 400 {"error":"anti-drain rejected the payout tx: payout destination GDABMZJFJ2JHNKZT7UV52GFKB7EJ7URIOUTOE6S... | PASS |
| 18 | c. junk | /sweep: a sweep whose payment the sponsor sources | refused; nothing counted against the fee budget | 400 {"error":"anti-drain rejected the sweep tx: sweep must be [payment,changeTrust,accountMerge] (optionall... | PASS |
| 19 | c. junk | /feebump: a claim whose inner fee is far over the fee-bump cap | refused; nothing counted against the fee budget | 400 {"error":"Invalid baseFee, it should be at least 5000000 stroops."} | PASS |
| 20 | c. junk | /feebump: a body whose xdr is not XDR | refused; nothing counted against the fee budget | 400 {"error":"XDR Read Error: unknown EnvelopeType member for value 158"} | PASS |
| 21 | c. junk | the fee budget across the 13 probe(s) above | nothing charged: fees.spentXlm (and the gross, when readable) unchanged 6 s after the last probe | fees.spentXlm 0.0437601 -> 0.0437601; nothing charged (/health fees.grossXlm) | PASS |
| 22 | b. budgets | /create-account from this address until its share of 120 is spent | refused with 'paused for today' at or before call 121 | refused at call 76 | PASS |
| 23 | b. budgets | a second source is still served | served | not run (cannot present a second address from one machine; proven against wrangler dev with --kv and --source-ip) | SKIP |
| 24 | b. budgets | the day cap (600 accounts, 1000 USDC) and the fee budget | contained | not run (pre-seeding needs the fake store (--kv); proven against wrangler dev) | SKIP |
| 25 | a. fees | /v2-reclaim fee = simulated need + headroom + 0.01 XLM (2627478 stroops, local minResourceFee 27478) | 400 refused, naming the bound; nothing counted against the fee budget | 400 {"error":"inner fee 2627478 exceeds what the reclaim needs (2527481)"} | PASS |
| 26 | a. fees | the fee budget across the 1 probe(s) above | nothing charged: fees.spentXlm (and the gross, when readable) unchanged 6 s after the last probe | fees.spentXlm 0.0467601 -> 0.0467601; nothing charged (/health fees.grossXlm) | PASS |
| 27 | a. fees | /v2-reclaim at exactly the bound (2527478 stroops; the money comes back) | 200 confirmed or 202 accepted | 200 {"hash":"fffedf3a...991c57af","confirmed":true} | PASS |
| 28 | d. rate limits | 17 junk /v2-claim posts for one payout key | the per-account limiter's 429 by post 16, and not before post 12 | first 429 at post 16: 429 {"error":"per-account rate limit exceeded"} | PASS |
| 29 | d. rate limits | 305 GETs to /events/summary from one address, in batches of 25 | the per-IP limiter's 429 after at most 300 served | a 429 after 284 served: 429 {"error":"per-IP rate limit exceeded"} | PASS |
| 30 | e. halt | SET sponsor:halt:<net> -> every value and grant route 503 within 5 s | 503 everywhere | not run (the live store is not ours to write; proven against wrangler dev with --kv. SPONSOR_HALT=1 + deploy is the ...) | SKIP |

Totals: 30 probes, 27 pass, 0 fail, 3 skipped.
Sponsor balance: before 19993.9925092 XLM / 0 USDC, after 19993.9696540 XLM / 0 USDC; spent 0.0228552 XLM.
Run: 2026-10-08T17-48-59-637Z UTC, target https://lumenia-sponsor.avakit.workers.dev, network testnet, mode full.
Its two real transactions, read back from horizon-testnet as successful: the deposit (row 7)
[`9afcdd14...a9b8f270`](https://stellar.expert/explorer/testnet/tx/9afcdd14000a9104892d728fa0b80f33e04823cad19c36ce606a4c45a9b8f270)
at ledger 5,091,637 and the take-back (row 27)
[`fffedf3a...991c57af`](https://stellar.expert/explorer/testnet/tx/fffedf3a2127c2d76fded2a755f350433ae4ca2f83c82ab22d757416991c57af)
at ledger 5,091,674.

**Run 4: refusal-only against the live mainnet Worker, 2026-10-08 17:54 UTC, right after its
deploy.** `pnpm --filter @lumenia/sponsor adversarial -- --target https://lumenia-sponsor-mainnet.avakit.workers.dev --network mainnet --mode refusal-only`.
Refusal-only on purpose: the exhaustion section is never run against the live mainnet Worker,
because its day budgets (new accounts, escrow dollars, the fee budget) are shared by every real
recipient, and exhausting one locks real people out until UTC midnight. Nothing was funded and
nothing that could land was submitted. The containment artifact: the mainnet sponsor's balance was
239.6774337 XLM and 0 USDC before the run and the same after it, and `/health` `fees.grossXlm`
stayed 0.

What this run shows of the three classes SOW 2 names, and where the rest is shown. SOW 2 asks for
all three against the live mainnet sponsor; two of them are shown there only in part, for the
reasons in the table, and that is a deviation from its wording.

| SOW class | On the live mainnet Worker (this run) | Shown instead, and where |
|---|---|---|
| Junk claims rejected | Yes: rows 11 to 20, ten junk claims and transactions refused inside a fee window that stayed at 0 (row 21) | The same probes with readable answers: Runs 1 and 3 |
| Inflated-fee relays refused | In part: row 19, the classic `/feebump` refusing a claim whose inner fee is far over its bound. The Soroban relays' fee bounds did not run here: rows 1 and 2 meet the pilot gate first (a wallet nobody approved), and rows 6 and 7 need a funded sender. Row 4 shows the take-back relay's own simulation refusing on mainnet, which comes before its fee bound | The deployed testnet Worker (Run 3 rows 2 to 5 and 25) and a local Worker on the testnet ledger (Run 1 rows 3 to 6 and 30), the same code with the testnet configuration. No run has sent them under the mainnet configuration (Run 2 skipped them too) |
| Budget exhaustion contained | No: row 22, by design (above) | The per-source onboarding share on the deployed testnet Worker (Run 3 row 22) and in the mainnet configuration on a local Worker (Run 2 rows 16 and 17: the share of 8, and a second address not paused); the day cap, the failed-deposit counter and the fee budget on a local Worker with the testnet configuration (Run 1 rows 26 to 29). The mainnet per-sender cap ($25) is held by `test:caps` [13] only (D3.9) |
| All within the caps | Yes: the balance before and after, and every fee window | Every run's fee windows |

Of the nine SKIP rows, four meet the pilot gate (rows 1, 2, 9 and 10: it guards only `/v2-deposit`
and `/send-link`, where money enters escrow), two need a funded sender (6, 7), one needs a real
unclaimed link (8), one is the exhaustion section (22), and one is the store halt (25), which needs
the store and is shown by Runs 1 and 2.

| # | Section | Probe | Expected | Got | Result |
|---|---|---|---|---|---|
| 1 | a. fees | /v2-deposit inner fee = 2 XLM cap + 1 stroop | 400 refused by the cap; nothing counted against the fee budget | not run (the pilot gate answers first (pilotMode true): a wallet nobody approved never reaches this guard; run it ag...) | SKIP |
| 2 | a. fees | /v2-deposit from an unfunded sender (simulation fails) | 400 refused by the simulation; nothing counted against the fee budget | not run (the pilot gate answers first (pilotMode true): a wallet nobody approved never reaches this guard; run it ag...) | SKIP |
| 3 | a. fees | /v2-deposit from a wallet nobody approved (the pilot gate) | 403 'not on the pilot allowlist'; nothing counted against the fee budget | 403 {"error":"this wallet is not on the pilot allowlist yet"} | PASS |
| 4 | a. fees | /v2-reclaim of a drop that does not exist (simulation fails) | 400 refused by the simulation; nothing counted against the fee budget | 400 {"error":"request failed","ref":"4a7aab6d"} | PASS |
| 5 | a. fees | the fee budget across the 2 probe(s) above | nothing charged: fees.spentXlm (and the gross, when readable) unchanged 6 s after the last probe | fees.spentXlm 0 -> 0; nothing charged (/health fees.grossXlm) | PASS |
| 6 | a. fees | /v2-deposit fee = simulated need + headroom + 0.01 XLM | 400 refused | not run (needs a funded sender: full mode only) | SKIP |
| 7 | a. fees | /v2-reclaim fee = simulated need + headroom + 0.01 XLM | 400 refused | not run (needs a funded sender: full mode only) | SKIP |
| 8 | c. junk | /v2-claim with a random signature for a real unclaimed link | 400 refused | not run (needs the real link from full mode) | SKIP |
| 9 | c. junk | /send-link: a send whose claimable balance has three claimants (a bigger sponsored reserve) | refused; nothing counted against the fee budget | not run (the pilot gate answers first (pilotMode true): a wallet nobody approved never reaches the send policy, whic...) | SKIP |
| 10 | c. junk | /send-link: a send with no unconditional claimant (the reserve could stay locked) | refused; nothing counted against the fee budget | not run (the pilot gate answers first (pilotMode true): a wallet nobody approved never reaches the send policy, whic...) | SKIP |
| 11 | c. junk | /v2-claim with a 31-byte link | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"01d6d684"} | PASS |
| 12 | c. junk | /v2-claim naming a foreign contract id | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"7b6f94ad"} | PASS |
| 13 | c. junk | /v2-claim with a method outside the allowlist | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"22d48e01"} | PASS |
| 14 | c. junk | /feebump: a sponsor-sourced payment inside the claim | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"3af55a15"} | PASS |
| 15 | c. junk | /feebump: a claim whose balance id differs from the one named | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"b4aede33"} | PASS |
| 16 | c. junk | /feebump: a claim op sourced by a muxed (M...) address | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"a5202224"} | PASS |
| 17 | c. junk | /payout: a payout to a destination that is not the one named | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"ca3b625a"} | PASS |
| 18 | c. junk | /sweep: a sweep whose payment the sponsor sources | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"959479a9"} | PASS |
| 19 | c. junk | /feebump: a claim whose inner fee is far over the fee-bump cap | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"fe82a6c3"} | PASS |
| 20 | c. junk | /feebump: a body whose xdr is not XDR | refused; nothing counted against the fee budget | 400 {"error":"request failed","ref":"ac16a2fb"} | PASS |
| 21 | c. junk | the fee budget across the 10 probe(s) above | nothing charged: fees.spentXlm (and the gross, when readable) unchanged 6 s after the last probe | fees.spentXlm 0 -> 0; nothing charged (/health fees.grossXlm) | PASS |
| 22 | b. budgets | every exhaustion probe | contained | not run (refusal-only mode: exhaustion is never run against a live mainnet Worker (it locks real recipients out unti...) | SKIP |
| 23 | d. rate limits | 7 junk /v2-claim posts for one payout key | the per-account limiter's 429 by post 6, and not before post 2 | first 429 at post 6: 429 {"error":"per-account rate limit exceeded"} | PASS |
| 24 | d. rate limits | 35 GETs to /events/summary from one address, in batches of 25 | the per-IP limiter's 429 after at most 30 served | a 429 after 24 served: 429 {"error":"per-IP rate limit exceeded"} | PASS |
| 25 | e. halt | SET sponsor:halt:<net> -> every value and grant route 503 within 5 s | 503 everywhere | not run (the live store is not ours to write; proven against wrangler dev with --kv. SPONSOR_HALT=1 + deploy is the ...) | SKIP |

Totals: 25 probes, 16 pass, 0 fail, 9 skipped.
Sponsor balance: before 239.6774337 XLM / 0 USDC, after 239.6774337 XLM / 0 USDC; spent 0.0000000 XLM.
Run: 2026-10-08T17-54-26-957Z UTC, target https://lumenia-sponsor-mainnet.avakit.workers.dev, network mainnet, mode refusal-only.

**A third run against the deployed testnet Worker, 2026-10-08 18:13 UTC**, after Run 4 and from the
same connection as Run 3, in full mode: 27 rows, 20 pass, 1 fail, 6 skipped, and the testnet
sponsor's balance the same before and after (19993.9696540 XLM). The one FAIL is its setup row:
onboarding the throwaway sender was refused with "new accounts from this connection are paused for
today - its limit of 120 is reached", because Run 3 and its first attempt had spent this
connection's testnet share for the day. That is the onboarding budget working, not a product
failure: the per-source row (section b) was refused at its first call for the same reason, the rows
that need a funded sender were skipped, and every other refusal probe passed again inside fee
windows that did not move. Its rows repeat Run 3's and are not transcribed here.

### D3.4 The retirement switch: dry runs done, the deployed rehearsal still to run

The rehearsal turns the allowlist on, refuses a wallet that was never approved, approves one wallet,
turns the allowlist off, proves both wallets send and the caps still refuse, halts and resumes by
environment, and finally takes every deposit it made back. A dry run of the D3 code (one local
Worker restart per phase, the live testnet ledger, a freshly started stand-in store, an empty log
folder) passed all six phases at 14:48-14:52 UTC on 2026-10-08: three real deposits landed and all
three were taken back after their two-minute expiry, and the three deposits the first dry run had
left in the testnet escrow were taken back as well; the log, with the hashes, is in the ops note
section 1.4.

The run on the deployed testnet Worker is the owner's (ops note section 1.3) and had not run when
this was written (2026-10-09, 00:20 UTC). Until it has, this report says the switch was dry-run on a
local Worker against the live testnet ledger, not rehearsed. It needs a connection whose testnet
onboarding share is unused that day; the ops note says when to run it.

Either way the rehearsal covers the server half of the switch only. The web and the extension ask
only the mainnet sponsor for `/pilot-status` (`apps/web/lib/wallet.tsx:253` and
`apps/extension/src/background/pilot.ts:39` at `24d0f4e`), so flipping the testnet Worker never
reaches their code. Their half is held by `test:pilotaccess` (the rules as pure functions) and the
extension's `test:router` and `test:send`, and has not been driven in a browser against an open
sponsor.

### D3.5 What `/health` says now

Read from the LIVE mainnet Worker at 18:02 UTC on 2026-10-08, after its deploy and its first
watchdog run (18:00:36 UTC, a full run, nothing halted). The signer is still the environment key
(`"kind": "env"`): the KMS cutover is pending (D3.6). Nothing in it is a secret: no token, no key id,
only public addresses and counters.

```json
{
  "ok": true,
  "service": "lumenia-sponsor",
  "network": "mainnet",
  "sponsorPublicKey": "GBLBAKFVTS2GSEOUK3AKOZAO3I6T34YHNJPG4DMF5JODVWJDJIPDYZZ2",
  "account": "GBLBAKFVTS2GSEOUK3AKOZAO3I6T34YHNJPG4DMF5JODVWJDJIPDYZZ2",
  "accountSource": "signer",
  "signer": {
    "kind": "env",
    "publicKey": "GBLBAKFVTS2GSEOUK3AKOZAO3I6T34YHNJPG4DMF5JODVWJDJIPDYZZ2",
    "available": true
  },
  "pilotMode": true,
  "usdcCode": "USDC",
  "usdcIssuer": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  "contract": "CAC5JYQ2XEEVJ54EXC7KCG6MTARO5CSUQ2WNKSOM6FALCCU5UTEIWGR4",
  "halt": {
    "halted": false,
    "source": null,
    "reason": null
  },
  "watchdog": {
    "lastRun": "2026-10-08T18:00:36.837Z",
    "ageSeconds": 87,
    "lastFullRun": "2026-10-08T18:00:36.837Z",
    "fullAgeSeconds": 87
  },
  "alerting": {
    "configured": true,
    "missing": []
  },
  "fees": {
    "day": "2026-10-08",
    "spentXlm": "0",
    "grossXlm": "0",
    "maxXlm": "15",
    "used": 0
  },
  "counters": {
    "day": "2026-10-08",
    "maxDayUsdc": "50",
    "maxDayAccounts": 60,
    "escrowUsdc": "0",
    "accounts": 0,
    "maxDaySourceAccounts": 8
  }
}
```

The live pages: `https://lumenia-sponsor.avakit.workers.dev/health` and
`https://lumenia-sponsor-mainnet.avakit.workers.dev/health`. The mainnet watchdog stamped its first
full run at 18:00:36 UTC (its `/health` read `null` at 17:54, right after the deploy). The testnet
one, on the D3 code since about 17:03 UTC, stamped the same run time; its earlier full runs on the
D3 code, read during Run 3 and its first attempt, were at 17:15:34, 17:30:38 and 17:45:31 UTC. Read
again at 00:16 UTC on 2026-10-09: both had stamped a full run minutes before (testnet 00:16:05,
mainnet 00:16:10), neither was halted, and both signers were still `env`. This page is read again
after the KMS cutover (D3.6).

The heartbeat workflow (`.github/workflows/watchdog-heartbeat.yml`) is scheduled every 30 minutes,
at minutes 7 and 37, but GitHub has started this repository's schedules hours late. Its first run,
started by hand at 18:01 UTC right after both deploys, was green
([run 37821047843](https://github.com/getlumenia/lumenia/actions/runs/37821047843)), and no
`watchdog-heartbeat` issue was opened. Its first 12 scheduled slots (17:07 to 22:37 UTC) produced one
scheduled run, [run 37850573340](https://github.com/getlumenia/lumenia/actions/runs/37850573340),
created at 21:59:43 UTC and green; read at 00:18 UTC on 2026-10-09, it was still the only one in 15
slots. Its alert path (opening or updating an issue) has not run yet: every run so far was green.

### D3.6 The KMS trace

_Pending: the owner's cutover, testnet first, then mainnet_ (ops note section 2.4). Read at 00:16 UTC
on 2026-10-09, both Workers' `/health` still say `"signer": {"kind": "env"}`, so the third part of
metric 3 (the production signer running on KMS) is not met yet.

What the trace will hold: the KMS key's address from `kms-check` (its PASS line and the G address
only; the key's ARN names the AWS account and stays out of anything published, CloudTrail
screenshots included), the SetOptions transaction hash, the sponsor account's signer list after it,
`/health` showing `"signer": {"kind": "kms"}`, the first KMS-signed transaction, the CloudTrail
`Sign` entry matched to it, and `wrangler secret list` without `SPONSOR_SECRET`.

Anyone can check which key signed a transaction from its envelope: each signature carries a hint,
the last 4 bytes of the signer's public key, and verifies over the transaction hash only under that
key. So the first KMS-signed fee-bump is public proof on its own: its signature verifies under the
KMS key's address and not under the account's old key (the shape `test:kms` [7] asserts). Until
`/health` on the mainnet Worker says `kms`, this report does not call the sponsor KMS-backed.

### D3.7 Measured: what the fee budget counts, and why a charge now comes back

A fee-bump BIDS `base x (inner operations + 1) + resource fee` (the SDK's
`buildFeeBumpTransaction`), and the ledger charges the inclusion part at the network's going rate,
not in full. The first cut of item b counted the bid and never gave anything back. Measured on
testnet with that first cut, earlier on 2026-10-08:

| | Counted (bids, never given back) | Charged by the ledger |
|---|---|---|
| One real deposit relayed at the bound (testnet tx [`dc640c57...ea8f54`](https://stellar.expert/explorer/testnet/tx/dc640c57f069051c60373f7a2b654a75a4df7a569b2436d66d88084588ea8f54), read back from Horizon) | 5,672,960 stroops (0.567 XLM) | 189,076 stroops (0.019 XLM) |
| A whole full run (onboarding, a deposit, a take-back, every refusal) | 1.543 XLM | 0.0207 XLM |

At that ratio the mainnet budget of 15 XLM admitted about 26 relayed deposits a day. Worse, a
review found it was a free target: a well-formed transaction the network refuses before inclusion
costs its sender nothing, yet its bid stayed counted, so about 30,000 junk `/sweep` posts from
addresses that do not exist, or 20 to 30 stale-sequence deposits, spent the day, after which every
exit refused until UTC midnight; a KMS outage did the same with retries that were never signed.

So the charge now moves on the network's answer (D3.1 b): a transaction that never reached a ledger
gives its bid back, an included one counts what its result reports, and only an undecided one keeps
the whole bid. The bid itself is smaller too: the relays bid the smallest valid base, so an honest
testnet deposit bids 4,224,320 stroops where it bid 4,672,960. Measured with the D3 code:

| | Bid while in flight | Counted once decided | Charged by the ledger |
|---|---|---|---|
| One real deposit relayed at the bound (Run 1, testnet tx [`87f1a1f2...54b414`](https://stellar.expert/explorer/testnet/tx/87f1a1f2a7c0238dd171ba4a665c604a2c58b4cb6f538cf1b1efcd7e9c54b414)) | 5,229,317 stroops (0.523 XLM) | 193,421 stroops, the fee its result reports | 193,421 stroops (Horizon `fee_charged`) |
| The whole of Run 1 | 1.449 XLM accepted (`fees.grossXlm`) | 0.021275 XLM | 0.021155 XLM (the sponsor's balance) |
| 25 junk `/sweep` posts from a never-funded address (`test:caps` [16]) | 100,000 stroops | 0 | 0 |

The whole run's count sits 1,200 stroops above what it cost: three `/create-account` sandwiches
the run asked for and never submitted (section b), each counted at its 400-stroop bid because the
sponsor never sees a client's submission. The deposit's bid is the new, smaller one (`2 x 2,500,000
+ 229,317`); the old base would have bid 5,687,951. Before this change the same kind of run counted
1.543 XLM for 0.0207 XLM of real spend. The bid is still what the budget holds while a transaction
is in flight, so a day of 15 XLM still holds roughly 28 relayed deposits at once; it no longer
means 28 a day.

### D3.8 Known limits after D3

**a. What the opening waits on.** Only the written legal opinion: the Customer Development Plan's line
(section 7.4), which SOW 2 keeps as the one item between Lumenia and open mainnet. Nothing opens
before it. Part of what that opinion answers is whether an open, free, capped pilot needs KYC and AML
controls (the first limit in c); if it says yes, the opening waits for that work as well. D3's own
remaining steps (the KMS cutover and the deployed rehearsal, in this report's status line) are part
of being ready, not gates after it. The day the opinion arrives, the flip follows the checklist in
the ops note, section 1.2.

**b. What raising the caps materially, and renouncing the escrow's upgrade key, wait on.** SOW 2 makes
the professional review the gate for these two steps, not for the opening:

- **A professional security review.** None has been done; the contract has had a self-assessment
  with free tools only.
- **A timelock on the escrow's upgrade.** The escrow's owner is a 2-of-3 multisig since 2026-09-18,
  with no timelock.

**c. The limits that remain, stated plainly.**

- **Opening ends the only KYC and AML stand-in.** The Customer Development Plan (section 7.4) names
  the hand-approval of every wallet as what stands in for KYC and AML today. With `PILOT_MODE` unset
  every wallet is admitted: no identity check is left on the sponsor (the web's backup rule runs in
  the browser only), and no destination is screened. What remains is the caps on money entering
  escrow, the onboarding, rate and fee budgets, and the kill switch.
- **Opening needs a named support owner.** The plan's section 7.5: one person answers everything
  today, the cost per ticket is not measured, and that capacity paces how fast the pilot can open.
  Users reach support through "Report a problem" (the site footer, /account, /home and
  /notifications); the claim pages and the extension popup have no such entry yet.
- **With the pilot off, two wallets can close the day for everyone.** The escrow day cap is one
  counter for all senders ($50 on mainnet) with a per-sender share ($25, item k). Only deposits move
  it (`checkCaps` runs on `/send-link` and `/v2-deposit` only) and a claim never gives it back, so two
  wallets making five $5 links each fill the $50, and every other sender is refused until UTC
  midnight. They pay no fee (the sponsor pays it), can open their accounts through sponsored
  onboarding, and get their money back within minutes by claiming their own links, every day. Item k
  stopped one wallet doing this, not two. While `PILOT_MODE=1` only hand-approved wallets deposit.
  Not built: a per-source share of the day cap, or a share kept for first-time senders; the opening
  numbers are the owner's (ops note section 1.2).
- **`/send-link` has no bound on sponsored reserves once the pilot is off.** A send to a known
  address is a claimable balance with two claimants, whose reserve (1 XLM) the sponsor pays until it
  is claimed or taken back. The dollar caps bound money, not the number of balances, and the send's
  fee is too small for the fee budget to bind it. With the pilot on, only hand-approved wallets send,
  five transactions each (`PILOT_MAX_TX`); with the pilot off nothing bounds it: about 133 sends of
  0.01 USDC ($1.33 of the sender's own money, which they can take back; about half an hour for one
  key at 5 a minute) would lock the whole spendable float, 133 XLM on 2026-10-09. After that no new
  account could be opened, and every claim into a fresh account would fail until a top-up.
  `/send-link` cannot simply be closed: it is the live path for a payment to a known address.
- **The onboarding day cap is close to the whole float, and `/create-account` is open today.** Opening
  an account is not pilot-gated (a recipient is not a pilot wallet), on mainnet too. Mainnet allows 60
  a day at about 1.5 XLM of reserve each: about 90 XLM, about 68 percent of the 133 XLM spendable on
  2026-10-09 (88 onboardings). The per-source share (8 a day) is keyed by address, an IPv4 address as
  it is and an IPv6 address by its /64, so eight addresses, or eight /64s from one small IPv6
  allocation, can take the whole day; two such days empty the spendable float. The watchdog pages
  below 25 onboardings left; it does not halt. The share is a fairness bound between callers, not a
  sybil bound.
- **`/payout` relays a user's own USDC to any address, with no pilot gate and no amount cap.**
  Deliberate: the pilot gate and the dollar caps cover money entering escrow or a claimable balance;
  the exit routes (claim, take-back, payout, sweep) stay open so that a recipient is never stranded.
  A mainnet account opened through `/create-account` can receive USDC from anywhere, and `/payout`
  then pays the fee to send it on to any address with any memo, bounded only by the rate limits, its
  fee bound and the fee budget.
- **After the KMS cutover the Worker still holds secrets.** The cutover takes the sponsor's signing
  key out of the Worker, not every secret: the Worker keeps the AWS access key pair it calls KMS with
  (whoever holds that pair can have KMS sign for the sponsor until the pair is deactivated) and the
  channel accounts' keys (`CHANNEL_SECRETS`). The trust boundary after the cutover is the Worker's
  secret store plus the AWS IAM policy, not KMS alone.
- **A KMS-signed fee-bump is publicly attributable.** Its signature's hint names the KMS key (D3.6),
  so anyone can see which key signed each sponsor transaction: the KMS key, or the old key while it is
  still a signer. That is the public proof of the cutover, and it would also show any use of the old
  key.
- **After the KMS cutover the old key is held offline only.** It stays a weight-1 signer of the
  sponsor account for one week as the rollback; from the cutover on it is held offline only, and the
  week's end date goes into the ops note's cutover log when the cutover runs. Lowering it to weight 0
  is a separate decision.
- **The fee budget refuses exits too.** Decided this way (D3.1 b): when the day's budget is spent,
  claims and take-backs wait until UTC midnight like everything else. It now counts what the ledger
  charged once a transaction is decided, but the whole bid while one is in flight or undecided, and
  the bids are large next to the charges (the web declares a 2,000,000-stroop inclusion fee on a
  deposit, the claim relay 1,000,000): a flood of concurrent requests can hold the day's budget in
  flight for the seconds each takes to be refused, and refuse honest traffic meanwhile. An
  UNDECIDED relay (a 202) keeps its whole bid until UTC midnight: nothing reconciles it later, even
  after its time bound has passed (about 0.52 XLM for a deposit at the bound). A transaction that is
  included and fails spends the budget at its real fee, which no give-back can change; such junk is
  bounded only by the rate limits (5 a minute per account, 30 per address). Not built: a per-source
  share of the fee budget (the onboarding budget has one), a sequence check before the charge (the
  give-back makes junk refused before a ledger cost nothing; it does not stop it being sent), and a
  share kept for the exit routes. The owner kept 15 XLM a day for the pilot on 2026-10-08; the
  number for the opening is the owner's (ops note section 1.2). This holds today, not only after the
  opening: the exit routes are open to every wallet, so junk that is included and fails, sent from
  many accounts, can spend the budget; at about 200 stroops for an included failed claim and 5 a
  minute per account, 15 XLM takes on the order of 100 accounts sending all day.
- **A same-ledger race can undercount one bid.** A transaction refused with a validation code is
  given its bid back; in a rare race (another transaction of the same sender moving the sequence
  first, in the same ledger) an included transaction can carry such a code and its fee was charged.
  Each case costs the sender a transaction of their own and undercounts one bid.
- **`/health` reads the store, cached.** It stays unmetered: its store readings are cached per
  isolate for 5 seconds and a refresh in flight is shared, so a request loop costs at most five
  readings plus one halt read per isolate per 5 seconds; a rate limiter would itself write to the
  store on every request.
- **The rate limiter is shared by the two networks.** Its windows (`rl:ip:<address>:<minute>`,
  `rl:acct:<key>:<minute>`) carry no network, so if the two Workers share one store (likely; D3.9)
  an address's requests to the testnet Worker count against its 30-a-minute window on the mainnet
  Worker, as Run 2's first attempt showed. It throttles only that address. Namespacing it would also
  double what one address may ask of the routes that send email (`/recovery-otp`, the pilot
  request) across the two Workers, so it is left as it is and stated here.
- **Repeats stay on the sponsor path.** A repeat (a key that already holds today's slot) is served
  without a channel lease, so repeats cannot empty the pool. Two in flight share the sponsor's next
  sequence, and one a client submits (it fails on an existing account, but it is included) moves
  that sequence under the other sponsor-path handouts in flight, which then fail with a bad sequence
  and are retried. Bounded by ten repeats per key and source a day, on keys that each cost a slot.
- **A refused transaction's ledger lookup.** After a refusal whose code an included transaction can
  also carry, a hash Horizon does not know is asked again about 5 seconds later before its bid comes
  back; a Horizon lag longer than that still gives back one bid that was paid, and anyone can make
  their own request wait those 5 seconds.
- **The channel key signs before the charge on the channel paths.** `/v2-claim` and `/cctp-relay`
  on a channel sign the inner transaction with the channel's key before the fee budget is charged,
  because the fee-bump copies the inner envelope as it is built; nothing leaves the process unless
  the sponsor's own signature follows, and that comes after the charge.
- **Automatic halt on two findings only.** A stolen sponsor key and a changed escrow are answered by
  an automatic halt; a low float, a capacity floor, a state-expiry warning, a governance event or a
  failed check page a person instead, because a halt also blocks the exit routes and must not
  strand recipients over something that is not a theft.
- **The kill switch fails open on a store error.** If the store cannot be read, the sponsor runs as
  if not halted, so that a store outage never strands recipients. The stop that needs no store is
  `SPONSOR_HALT=1`; the dry run exercised it as a local Worker restart (D3.4), and its deploy form
  (`npx wrangler deploy --var SPONSOR_HALT:1`) has not been run on a deployed Worker yet.
- **The other store-dependent bounds, and which way each fails.** The rate limiter falls back to
  per-isolate memory; the onboarding and fee budgets degrade to per-isolate counters (a soft bound
  across isolates) rather than refuse; the escrow day cap fails CLOSED on mainnet
  (`CAPS_FAIL_CLOSED=1`); the pilot allowlist fails CLOSED.
- **The escrow contract does not enforce the caps itself.** The $5 / $25 / $50 limits and the
  allowlist bind the sponsor's deposit relays (`/send-link`, `/v2-deposit`), not its exit routes
  (`/payout` above); a sender who pays their own fee can call `deposit` directly. The contract keeps
  every exit callable either way.
- **The heartbeat workflow depends on GitHub's scheduler**, which can delay or drop runs (one
  scheduled run in its first 12 slots, D3.5) and disables a public repository's scheduled workflows
  after 60 days without activity. Its alert path (opening an issue) has not run yet.
- **The published extension packages** (Chrome Web Store 0.1.2, AMO 0.1.2, the self-hosted 0.1.1) read
  a 202 answer to a take-back from the D3 sponsor as landed, and have no backup rule for real money
  (D1.1). The source keeps a 202 open and has the rule; both reach the stores with 0.1.3, and the
  flip waits for it (ops note section 1.2).
- **A direct payment's "do not pay again" lives in the page.** After a 202 on a payment to a known
  address the page says not to pay again and offers no button, and re-checks the ledger; a reload,
  or reopening the request link, loses that state and offers Pay again.
- **The web's wallet provider is not under test.** The pilot-access rules (the backup gate where
  money leaves, the arrival warning, the no-account ask) and the claim settle are tested as pure
  functions; their wiring inside `apps/web/lib/wallet.tsx` and the claim flow is not, because no
  component test exists.
- **The watchdog's worst case and the free plan.** A run that pages through a backlog, halts and
  retries its reads can need more than the 50 subrequests the Workers free plan allows per
  invocation. The live testnet run hit the per-invocation subrequest limit on `/create-account` at
  about that count (fixed for the channel lease, Run 3), which suggests the free plan; the plan
  itself is not recorded here (D3.9). A relay that polls a slow transaction for its whole window
  (40 polls) comes close to the same limit; a poll that fails on it reads as undecided (202). During a rotation, the
  page for the second SetOptions may be held by the alert cooldown (the runbook says how to confirm
  the scan instead).
- **The local node server** (`apps/sponsor/src/index.ts`) now answers 202 and 503 like the Worker,
  but still lacks the pilot gate, the grant-route halt and `/cctp-relay`; it is a development
  convenience, and nothing in this report was measured against it.

### D3.9 Not verified yet, stated plainly

- Deployed 2026-10-08: the testnet Worker about 17:03 UTC, again with the lease fix at about 17:48 UTC
  (version `7bfebe3e`); the mainnet Worker at 17:54 UTC (version `73136ad0`) with `PILOT_MODE=1`
  kept, after checking that the mainnet sponsor sourced no operation the watchdog halts on (its newest
  200 operations, 2026-08-24 to 10-03) and that the escrow's running wasm matches the pin. The live
  claim regression passed through the deployed web and the testnet Worker (tx
  [`6151c3d7...b1d75c`](https://stellar.expert/explorer/testnet/tx/6151c3d7ad2393c6ff9c30c4be41c5d4f2ecce2536f50891ba8be370eeb1d75c)).
- The KMS path has never signed with a live AWS key; `kms-check` is the first live proof, and the
  AWS documentation does not state the Ed25519 signature's encoding (the code expects the raw 64
  bytes).
- Whether the two Workers share one store cannot be read from the repository (the store's address is
  a secret); the halt and cooldown keys were made per network on the assumption that they do.
- Which Cloudflare plan the Workers run on (the subrequest budget above), and the heartbeat
  workflow's alert path: no run has opened or updated an issue yet (every run so far was green; the
  scheduled run at 21:59 UTC ran its close job, with nothing to close).
- Runs 1 and 2 used a local Worker and a local stand-in for the store: they prove the code and its
  answers, not the deployed configuration. Runs 3 and 4 are the deployed proof, without the
  store-dependent rows (seeded budgets, the store halt), which only Runs 1 and 2 show.
- No run in any configuration exercises the per-sender day cap (item k); only `test:caps` [13] holds
  it. Under the mainnet configuration, no run exercised the $50 day cap, the failed-deposit counter
  or the 15 XLM fee budget (Run 2 rows 18 and 19 are SKIP). `/health` reads back the $50 day and the
  15 XLM budget; the $25 and $5 limits are configuration only (`apps/sponsor/wrangler.toml:155` and
  `:149`).
- The adversarial runner's own refusals (full mode against a live mainnet Worker, `--kv` with a live
  mainnet target, full mode on a local mainnet Worker without `--kv`, a store that is not the current
  stand-in) stop it before any probe or spend, but no test in the repository holds them and their
  output is not recorded here yet.
- Runs 1 and 2, the rehearsal's dry run and the browser runs were made before the last review's
  fixes (the negative and classic-route resource fees, the onboarding repeat path, the halt read's
  write guard and timeout); those are held by the offline suites, not yet by a run.
