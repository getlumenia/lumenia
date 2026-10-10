# Lumenia, SOW 2 (Instawards follow-on): the evidence package

For the Stellar Turkiye ambassador chapter lead. Status as of **2026-10-10**; the rows marked
_pending_ are filled in before the package is sent on 2026-10-16. Every link below is public:
the code and the evidence files are in this repository, every transaction opens on stellar.expert,
and every CI run opens on GitHub. Screenshots of the public pages cited here, taken on 2026-10-09 and
each checked for secrets, are in [`evidence/sow2-screenshots/`](sow2-screenshots/) with an index.

## In one paragraph

SOW 2 asked for three things. **D1**, a sender-side browser extension: built, in both stores
(Chrome Web Store public since 2026-10-06, addons.mozilla.org public since 2026-10-07), and both
stores now serve a version that makes private links: the Chrome Web Store 0.1.3 since 2026-10-10,
addons.mozilla.org 0.1.3 since 2026-10-09 and 0.1.4 since 2026-10-10. On 2026-10-09 it ran end to end in Firefox on practice money. **D2**, private links: live on getlumenia.com
since 2026-10-07 (no amount and no name in a link, the claim page reads the amount from the
ledger, a plain chat preview, a password by default for real money), with a public privacy page,
a written leak audit and a testnet commitment spike. **D3**, open-mainnet readiness: the hardened
sponsor is deployed on both networks since 2026-10-08, held by a CI step named "Hardening suite
(D3 a-k)", a scripted adversarial run against the live mainnet sponsor refused everything it
sent and spent nothing, and on 2026-10-09 the retirement of the allowlist was rehearsed on the
deployed testnet Worker, every step passing. What is not done yet: the two real-money runs (metrics 1 and 2) and the
move of the production signer to AWS KMS (metric 3, third part). All three need the founder's own
keys and accounts; the tools for each are in the repository.

## The three binary metrics

| Metric | What the SOW asks | Status | Evidence |
|---|---|---|---|
| 1 | A walletless send initiated from the published extension, claimed on mainnet, with a public transaction hash | _pending: the founder's run from an approved pilot wallet_ | Published extension: [Chrome Web Store](https://chromewebstore.google.com/detail/lumenia-send-dollars-by-l/ccdnjnckaldkmjnlpgpmdmnbajmakhmn), [addons.mozilla.org](https://addons.mozilla.org/en-US/firefox/addon/lumenia/). Practice-money proof of the same flow on testnet: [readiness report D1.3](SOW2_READINESS_REPORT.md). Demo video: below. Deposit and claim hashes: _pending_ |
| 2 | A private-by-default link whose URL and chat preview carry no amount and no sender name, claimed on mainnet | _pending: the founder's run on getlumenia.com_ | The private shape is live since 2026-10-07 and is checked every night against production ([nightly run 37774557675](https://github.com/getlumenia/lumenia/actions/runs/37774557675), step "Private link preview (D2 leak audit, live half)"). Mainnet link (key redacted), deposit and claim hashes, the WhatsApp and Telegram preview screenshots: _pending_ |
| 3 | Hardening suite green in CI, a scripted adversarial run against the live mainnet sponsor contained within the caps and written up, the production signer on KMS | Two of three parts met; KMS _pending_ | CI: [run 37813352621](https://github.com/getlumenia/lumenia/actions/runs/37813352621) and every D3 commit after it. The live mainnet run: [readiness report D3.3](SOW2_READINESS_REPORT.md), Run 4 (25 probes, 0 failures, the sponsor's balance 239.6774337 XLM before and after). KMS: the cutover tools are [`ops/kms/`](../ops/kms/); until the mainnet sponsor's `/health` says `"signer": {"kind": "kms"}` this package does not call it KMS-backed |

## Evidence by deliverable (SOW section 6.1)

| Deliverable | Evidence | Where |
|---|---|---|
| D1 | Public repository | [`apps/extension`](../apps/extension/) with its [README](../apps/extension/README.md) (what it does, every permission, what it sends and keeps, the published builds and how to rebuild them) |
| D1 | Store listing or signed package | Both public, both making private links. addons.mozilla.org served 0.1.3 from 2026-10-09 (reviewed 08:36 UTC; the signed file's sha256 `17b2da7e...7c3c` on AMO's public API) and serves 0.1.4 since 2026-10-10, 13:26 UTC (signed file `3f5c82be...a39b`), with the listing's privacy-policy field linking the privacy page. The Chrome Web Store serves 0.1.3 since 2026-10-10, 10:32 UTC (the store's "published" mail); the package it serves, downloaded that day, has sha256 `94e119a4...51bd` and matches the 0.1.3 build file for file, apart from what the store adds. The 0.1.3 packages were built 2026-10-09 and a clean-room rebuild from the sources archive is byte-identical. Version 0.1.4 (account management, built 2026-10-10) is public on addons.mozilla.org; its Chrome Web Store upload is the owner's step |
| D1 | Demo video | A 47-second silent demo of 0.1.3 on practice money: make an account, paste a link into a chat box, the recipient claims in a browser that never saw Lumenia, the sender's list shows Claimed, real money waits for a backup and an approval. Served at https://getlumenia.com/media/lumenia-extension-demo.mp4 since 2026-10-09. The right-click step is driven through the extension's own menu handler, because automation cannot open Chrome's native context menu |
| D1 | Firefox run (practice money) | 2026-10-09: the 0.1.3 Firefox package in Firefox 155 made an account, a $0.25 link in the private shape, and saw it Claimed after a claim on getlumenia.com in a separate browser; four testnet transactions and two screenshots in [readiness report D1.3](SOW2_READINESS_REPORT.md) |
| D1 | Mainnet transaction hash | _pending_ (metric 1) |
| D2 | Live private link, its claim hash, the preview proof | _pending_ (metric 2) |
| D2 | Privacy page | [getlumenia.com/privacy](https://getlumenia.com/privacy): what a link, the ledger and our sponsor can each see |
| D2 | Leak audit | [`evidence/LEAK_AUDIT.md`](LEAK_AUDIT.md): every channel a link touches, each row held by a test or a production check |
| D2 | Spike report and testnet contract id | [`evidence/ZK_SPIKE_REPORT.md`](ZK_SPIKE_REPORT.md): contract `CAGWIGEG...ILCXA` on testnet, kept live to about April 2027; a negative result stated first (below) |
| D3 | Hardening suite in public CI | The step "Hardening suite (D3 a-k)" in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) |
| D3 | Readiness report of the adversarial run against the live mainnet sponsor | [`evidence/SOW2_READINESS_REPORT.md`](SOW2_READINESS_REPORT.md), D3.3 |
| D3 | Operations note: the KMS switch, the watchdog heartbeat, the rehearsed retirement switch | [`evidence/SOW2_OPS_NOTE.md`](SOW2_OPS_NOTE.md); the rehearsal on the deployed testnet Worker (2026-10-09, every step PASS) is logged in its section 1.4; the KMS cutover log is _pending_ |

## Suggested reading of the SOW checklist (section 6.2)

Our own reading, so the chapter lead can disagree with it line by line.

| Deliverable | Present / Partial / Missing | Why |
|---|---|---|
| D1 | Partial until the metric-1 run | The extension, both public listings, the repository and the demo exist; the mainnet send from the published extension does not yet |
| D2 | Partial until the metric-2 run | The privacy package is live and tested, the spike is on testnet; the mainnet claim of a private link does not exist yet |
| D3 | Partial until the KMS cutover | The hardening is deployed and green in CI, the live mainnet run is written up; the production signer is still an environment key |

## Where the work differs from the SOW as written

Stated in full, each with its reason, in [`EVIDENCE.md`](../EVIDENCE.md) under "SOW 2: deviations
from the SOW as written". In short:

- The spike stores a commitment **next to** the amount, not instead of it, and does not hide the
  amount: on Stellar today the token transfer publishes it, and the record must keep it so a
  dishonest reveal cannot take other people's money. Groth16 on BLS12-381 was measured on testnet
  with the upstream example circuit only. This is a negative result, and the report says so first.
- The adversarial run against the live mainnet sponsor was refusal-only: it showed junk claims
  refused, the classic fee-bump route refusing an inflated fee, and nothing spent. The other
  inflated-fee probes and the budget-exhaustion probes ran against the deployed testnet sponsor and a
  local copy on the testnet ledger; a local copy configured as mainnet ran only the onboarding-share
  probes. On mainnet the pilot gate answers first for a wallet nobody approved, the fee probes need a
  funded sender, and budget exhaustion would lock real recipients out until UTC midnight.
- The "26 people approved during this sprint": the store held one access request (2026-09-27,
  approved that day). The figure 26 could not be reproduced from our records.
- Both stores first published 0.1.2, which makes links in the pre-D2 shape. Both now serve a version
  that makes private links (the Chrome Web Store 0.1.3 since 2026-10-10; addons.mozilla.org 0.1.3 since
  2026-10-09 and 0.1.4 since 2026-10-10); an install of 0.1.2
  that has not updated yet, and the self-hosted Firefox file (0.1.1), still make the old shape. The
  privacy page says which versions make which shape.
- The mainnet daily cap was raised for the hackathon on 19 September and put back three and a
  half days late, on 24 September; nothing was spent while it stood.

## Customer Development Plan: what changed this period

**Numbers, corrected.** The pilot has moved about USD 4.4 in total (recounted from Horizon on
6 September). USD 2.76 of it was 69 person-to-person payments (median USD 0.002, largest USD 1.00);
65 of those 69 came from our own scripted run of 24 August, though together they add up to only
USD 0.26 (Horizon, counted again on 9 October). No real-money transfer has gone
through the service between 31 August and 9 October. The plan's "26 pilot access requests, 36
feedback submissions" could not be reproduced: on 27 September the store held one access request,
one feedback entry and six waitlist sign-ups. The plan counted five recorded sessions; two were
recorded (30.08 mainnet user test, 31.08 demo and interview), and five external touchpoints in all.

**Scope.** SOW 2 (dated 04.09.2026) moves the guides, the sender interviews and the H3 funnel
reading to SOW 3; it keeps the extension and the approvals in this period. The plan's 7.3 targets
for the period (ten sender conversations, twenty pilot wallets we did not recruit, a first
claim-to-second-action reading) stand at zero, at most one, and none. H3 (does a sender adopt)
still rests on one interview.

**Learnings.**

- Learning 8, the hackathon (Rise In x Stellar Pro, Scale Track, 19-20 September): not a finalist.
  The judges asked why a link rather than a wallet, and our live numbers were small. A three-minute
  surface has to show the recipient's moment, not the architecture.
- Learning 9, data hygiene: two figures in a submitted plan could not be reproduced from our own
  store. Every number we report now carries its source and the date it was read.
- Learning 10, distribution: a browser extension cleared both stores in three days (Chrome two,
  Firefox three), so the sender-side channel now exists; it had three Chrome users on 8 October,
  and the Chrome Web Store listing still showed three on 10 October.

**Traffic.** The latest captured report is the Vercel Web Analytics reading of 31 August; a fresh
reading is taken from the dashboard before the package is sent.

## What remains, and who does it

All three need the founder's keys, accounts or wallet. Each has a written procedure. Done on 2026-10-09: the web and both sponsor Workers took the merged release (testnet `213a2832`, then `32067caf` after the rehearsal's last deploy; mainnet `baaeaae0`; all tagged `215cfb2`), a refusal-only run against the new mainnet Worker spent nothing, the heartbeat alert drill opened and closed issue #46, extension 0.1.3 went public on addons.mozilla.org, ran end to end in Firefox on practice money and was submitted to the Chrome Web Store (which published it the next day), and the retirement switch was rehearsed on the deployed testnet Worker from 08:57 to 09:03 UTC: six phases, 22 logged steps, all PASS, every deposit that landed taken back ([ops note section 1.4](SOW2_OPS_NOTE.md)). Done on 2026-10-10: the Chrome Web Store published 0.1.3, so both stores serve it. Two fixes went live (the web at `c961c69`, the testnet Worker as `b7876a09`, the mainnet Worker as `dd9408b4` with `PILOT_MODE=1` kept and the caps unchanged; [readiness report D3.9](SOW2_READINESS_REPORT.md)): on both Workers, the watchdog now pages on a throttled or unreachable source only after 45 minutes (that day it had paged five times on a throttled public RPC alone); on the web and both Workers, the account problems the founder reported on 9 and 10 October are fixed (one email backs up one account, every surface names the account in use and its backup email, a request to join real money is signed by that account). The full offline gate is green on that tree, and the live claim, private-preview and send checks passed against production after the web deploy. Extension 0.1.4, which carries the same account model, went public on addons.mozilla.org at 13:26 UTC.

| Step | Tool or procedure |
|---|---|
| Metric 2: one private mainnet link from getlumenia.com/send (no name typed), previews screenshotted in WhatsApp and Telegram, claimed in a browser with no Lumenia account | [readiness report D2.5](SOW2_READINESS_REPORT.md) |
| Metric 1: one mainnet link from the store extension, claimed in a second clean browser, recorded in one take | [readiness report D1](SOW2_READINESS_REPORT.md) |
| The KMS cutover, testnet then mainnet | [`ops/kms/cloudshell-setup.sh`](../ops/kms/cloudshell-setup.sh) in AWS CloudShell, then [`ops/kms/cutover.sh`](../ops/kms/cutover.sh) |

Also the founder's, and not part of any metric: uploading extension 0.1.4 to the Chrome Web Store,
and, once the new website and 0.1.4 are live, setting the two new server switches
(`PILOT_REQUIRE_PROOF=1` on the mainnet Worker, `RECOVERY_REQUIRE_OWNER=1` on the testnet Worker),
which refuse an unsigned request to join real money and an unsigned first backup.

The opening itself waits for one thing only, as the Customer Development Plan's section 7.4 says:
a written legal opinion. The request for it is drafted and goes to a law firm this month. Until it
is in hand, Lumenia charges no fee and mainnet stays a hand-approved pilot with caps of $5 a link,
$25 a day per sender and $50 a day in total.
