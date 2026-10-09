# Lumenia, SOW 2 (Instawards follow-on): the evidence package

For the Stellar Turkiye ambassador chapter lead. Status as of **2026-10-09**; the rows marked
_pending_ are filled in before the package is sent on 2026-10-16. Every link below is public:
the code and the evidence files are in this repository, every transaction opens on stellar.expert,
and every CI run opens on GitHub.

## In one paragraph

SOW 2 asked for three things. **D1**, a sender-side browser extension: built, in both stores
(Chrome Web Store public since 2026-10-06, addons.mozilla.org public since 2026-10-07), with a
version 0.1.3 built and waiting to be submitted. **D2**, private links: live on getlumenia.com
since 2026-10-07 (no amount and no name in a link, the claim page reads the amount from the
ledger, a plain chat preview, a password by default for real money), with a public privacy page,
a written leak audit and a testnet commitment spike. **D3**, open-mainnet readiness: the hardened
sponsor is deployed on both networks since 2026-10-08, held by a CI step named "Hardening suite
(D3 a-k)", and a scripted adversarial run against the live mainnet sponsor refused everything it
sent and spent nothing. What is not done yet: the two real-money runs (metrics 1 and 2) and the
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
| D1 | Store listing or signed package | Chrome Web Store and addons.mozilla.org, both public at 0.1.2; 0.1.3 packages built 2026-10-09, a clean-room rebuild from the sources archive is byte-identical; submitted to addons.mozilla.org on 2026-10-09 (in review), Chrome Web Store upload _pending_ |
| D1 | Demo video | A 47-second silent demo of 0.1.3 on practice money: make an account, paste a link into a chat box, the recipient claims in a browser that never saw Lumenia, the sender's list shows Claimed, real money waits for a backup and an approval. Served at https://getlumenia.com/media/lumenia-extension-demo.mp4 since 2026-10-09. The right-click step is driven through the extension's own menu handler, because automation cannot open Chrome's native context menu |
| D1 | Mainnet transaction hash | _pending_ (metric 1) |
| D2 | Live private link, its claim hash, the preview proof | _pending_ (metric 2) |
| D2 | Privacy page | [getlumenia.com/privacy](https://getlumenia.com/privacy): what a link, the ledger and our sponsor can each see |
| D2 | Leak audit | [`evidence/LEAK_AUDIT.md`](LEAK_AUDIT.md): every channel a link touches, each row held by a test or a production check |
| D2 | Spike report and testnet contract id | [`evidence/ZK_SPIKE_REPORT.md`](ZK_SPIKE_REPORT.md): contract `CAGWIGEG...ILCXA` on testnet, kept live to about April 2027; a negative result stated first (below) |
| D3 | Hardening suite in public CI | The step "Hardening suite (D3 a-k)" in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) |
| D3 | Readiness report of the adversarial run against the live mainnet sponsor | [`evidence/SOW2_READINESS_REPORT.md`](SOW2_READINESS_REPORT.md), D3.3 |
| D3 | Operations note: the KMS switch, the watchdog heartbeat, the rehearsed retirement switch | [`evidence/SOW2_OPS_NOTE.md`](SOW2_OPS_NOTE.md); the deployed-testnet rehearsal and the KMS cutover logs are _pending_ |

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
  refused and nothing spent; the fee-bound and budget-exhaustion probes ran against the deployed
  testnet sponsor and a local copy configured as mainnet, because on mainnet they would lock real
  recipients out until UTC midnight.
- The "26 people approved during this sprint": the store held one access request (2026-09-27,
  approved that day). The figure 26 could not be reproduced from our records.
- The extension version in the stores (0.1.2) makes links in the pre-D2 shape until 0.1.3 passes
  review; the privacy page says so.
- The mainnet daily cap was raised for the hackathon on 19 September and put back three and a
  half days late, on 24 September; nothing was spent while it stood.

## Customer Development Plan: what changed this period

**Numbers, corrected.** The pilot has moved about USD 4.4 in total (median payment USD 0.002,
largest USD 1.00), most of it in our own scripted run of 24 August. No real-money transfer has gone
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
  Firefox three), so the sender-side channel now exists; it had three Chrome users on 8 October.

**Traffic.** The latest captured report is the Vercel Web Analytics reading of 31 August; a fresh
reading is taken from the dashboard before the package is sent.

## What remains, and who does it

All five need the founder's keys, accounts or wallet. Each has a written procedure. Done on 2026-10-09: the web and both sponsor Workers run the merged release (testnet `213a2832`, mainnet `baaeaae0`), a refusal-only run against the new mainnet Worker spent nothing, and the heartbeat alert drill opened and closed issue #46.

| Step | Tool or procedure |
|---|---|
| Upload extension 0.1.3 to the Chrome Web Store (addons.mozilla.org: submitted 2026-10-09, in review); add the privacy-policy link on addons.mozilla.org | The built packages and the exact commands in [`apps/extension/README.md`](../apps/extension/README.md) |
| Metric 2: one private mainnet link from getlumenia.com/send (no name typed), previews screenshotted in WhatsApp and Telegram, claimed in a browser with no Lumenia account | [readiness report D2.5](SOW2_READINESS_REPORT.md) |
| Metric 1: one mainnet link from the store extension, claimed in a second clean browser, recorded in one take | [readiness report D1](SOW2_READINESS_REPORT.md) |
| The KMS cutover, testnet then mainnet | [`ops/kms/cloudshell-setup.sh`](../ops/kms/cloudshell-setup.sh) in AWS CloudShell, then [`ops/kms/cutover.sh`](../ops/kms/cutover.sh) |
| The retirement switch rehearsed on the deployed testnet Worker | [`ops/rehearsal/run-testnet-rehearsal.sh`](../ops/rehearsal/run-testnet-rehearsal.sh) |

The opening itself waits for one thing only, as the Customer Development Plan's section 7.4 says:
a written legal opinion. The request for it is drafted and goes to a law firm this month. Until it
is in hand, Lumenia charges no fee and mainnet stays a hand-approved pilot with caps of $5 a link,
$25 a day per sender and $50 a day in total.
