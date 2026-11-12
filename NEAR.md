# Lumenia on NEAR: the NEAR rail, for judges and reviewers

- **What:** a dollar link for someone who has nothing. At the claim the escrow creates the recipient's NEAR account, funds it with USDC and pays the fee, so the recipient pays no gas; the sender can take unclaimed money back after expiry (one tap). Built at NEAR HACKATHON 2026 (the window runs from the announcement on 2026-10-19 to 2026-11-14; this work: 11 to 14 November 2026) inside [Lumenia's product repository](https://github.com/getlumenia/lumenia); only this NEAR rail is the submission.
- **Try:** https://getlumenia.com/try/send, practice money, online through 30 November 2026; links open on [/claim](https://getlumenia.com/claim), the public ledger is [/ledger](https://getlumenia.com/ledger), the per-network table [/developers](https://getlumenia.com/developers). [Demo video](https://lumenia-media.avakit.workers.dev/demo.mp4), 80 seconds: one live take on these screens, then the attack log and the mainnet proof ([16:9 copy](https://lumenia-media.avakit.workers.dev/demo-1080p.mp4)).
- **Check:** `node ops/near-verify.mjs --live-only` with nothing installed (about 5 seconds: the deployed escrows, their code hash, the hosted pages and every proof transaction), or `pnpm install --frozen-lockfile && pnpm near:verify` for everything; no key needed (see "Run it yourself").
- **Real:** the escrow [`lumenia-near.testnet`](https://testnet.nearblocks.io/address/lumenia-near.testnet), the screens, the relayer, the agent tools and one delivered Agent Market test job; hashes under "Proof".
- **Testnet:** all of that, with Circle's testnet USDC. No audit is claimed.
- **Mainnet:** the same escrow code as [`lumenia.near`](https://nearblocks.io/address/lumenia.near), proven with 3 real USDC on 2026-11-11: one link claimed into the brand-new account `lumenia-first.near`, one to an existing account; hashes under "Mainnet proof".
- **Tracks and tags:** Real-World Money, Agent Economy, Open Innovation; tags `pre-hackathon` and `hackathon-submission` ([diff](https://github.com/getlumenia/lumenia/compare/pre-hackathon...hackathon-submission)).

<details>
<summary>Try it in three minutes, click by click (no wallet, no faucet click)</summary>

1. Open https://getlumenia.com/try/send and press "Use the shared practice balance" (a testnet account that already holds test USDC; anyone may use it). Type an amount such as 1.00, choose "10 minutes (demo)" as the expiry if you want to try "Take the money back" later, and press "Create a money link".
2. You get a link and a QR code. Open the link in a private window or on your phone: that is the recipient.
3. Type a name, for example your first name, and press "Create my account and claim $1.00". After a few seconds the screen says the money is in your new account, with the account name and the balance read back from the token contract.
4. Back on the sender screen, under "Your links", the link reads "Claimed", and its Details link to the transaction and the recipient on the explorer. The "Public ledger" page lists the same link.
5. Optional: on the recipient's done screen, "Pay it forward" sends part of the money onward as a new link without spending any NEAR (a relayer pays the fee, and it only pays for calls to this contract).

Every step can be repeated from the command line; see "Run it yourself".

</details>

## Why this and not the others

Most payment links pay someone who already has a wallet. Coinbase Wallet links need the Coinbase app on both sides ([The Block](https://www.theblock.co/post/266175/coinbase-rolls-out-money-transfers-via-links-sent-on-whatsapp-tiktok-and-instagram)); Peanut (EVM, [supported chains](https://peanutprotocol.notion.site/Supported-Chains-and-Tokens-12f838117579817d926cfe352a71f5c1)) and this hackathon's invoice-link entries (Paylink, Invoice Link, Payday, Dues and others, which use NEAR Intents to let the payer choose a chain) settle to an existing address. Creating the account at the claim is NEAR-native: NEAR's own linkdrop (`create_account_and_claim`, since 2020) did it, and [Keypom](https://github.com/keypom/keypom) built a product on it until [Infinex acquired Keypom](https://infinex.xyz/news/infinex-announces-acquisition-of-keypom) in December 2024. Closest in this hackathon: [Marks](https://x.com/tryisaacnow/status/2119724177489801685) gift links (no wallet after a Google sign-in, mock USDC on testnet), [Santa](https://x.com/shipstate_xyz/status/2120058759984869487) escrowed gift links (the recipient connects a wallet), [Clausehold](https://x.com/RaphElevator/status/2120347379031257092) pays workers through a passkey on a per-job account, and [Meridian](https://x.com/meridiantown/status/2119084569102045318) turns a typed name into an account. Lumenia's take is dollars for people you cannot pay today: opening the link creates their named account with real USDC inside and every fee paid, with no wallet and no sign-in of any kind; the sender takes back what nobody claims; thirty people can be paid in one transaction, with a CSV for the accountant; and the same escrow runs on mainnet (`lumenia-first.near` was created by a real claim).

## How NEAR is used

> One product: the person sending or claiming never sees a network name in a path, a heading or a button. Lumenia picks the rail; the network shows up only in each payment's Details (with the explorer link), on receipts, and on the developer page.

- **Escrow:** one transaction moves the sender's USDC into a small contract, which records the link it belongs to and emits NEP-297 events.
- **Practice money:** the shared practice balance lives on the sponsor's relayer account, and the sponsor service creates practice links itself (`POST /near/practice-link`: 0.10 to 1.00 test USDC, a life of 10 minutes to a day, one link per 30 seconds and 10 a day per IP, 300 a day in total, fail-closed). The Worker's own scheduled run takes expired, unclaimed practice links back to the practice balance (`apps/sponsor/src/lib/near-practice-sweep.ts`; it never touches a link that is mid-claim). The browser sends only the link's public key; no key of the practice balance ever reaches a page.
- **The link is a key** that NEAR limits to one contract, two methods (`claim`, `claim_to_new_account`) and a 1 NEAR gas allowance; the escrow's own balance pays the gas, so the recipient pays no gas and needs no NEAR.
- **Account at the claim:** the contract creates the recipient's named account through NEAR's account-creation contract (an account can exist with zero balance), registers it with the USDC token and pays that deposit, transfers the USDC and, on testnet, adds a 0.05 NEAR starter. Four steps, one tap. An existing account or a fresh address works too.
- **Another chain:** the claim can pay a NEAR Intents deposit address, and Intents delivers the dollars to the chosen chain. Intents has no testnet, so the hosted demo stops at the live quote. This payout has not run on mainnet yet: NEAR Intents could not quote cross-chain pairs on 2026-11-11 and 2026-11-12.
- **Pay forward with zero NEAR:** a NEP-366 meta-transaction relayer relays only link creation into this escrow and the sender's reclaim, capped at 20 per sender a day, 500 a day in all and one per 10 seconds (`/near/health` reports them).
- **Exits:** the sender can take unclaimed money back after the expiry they chose (ten minutes to seven days). No contract method lets the owner move a drop, and pause blocks only new links; the open risk is the escrow's full-access key (see "What is real and what is not").
- **Deployed code:** testnet code hash 6xS5XbntjWeU8cpHZdc4oMKPyte4byHKKRqsGwdNiDgD (this source, with the pool-reserve guard of 2026-11-12, deploy transaction 9vosLgxfEVigByi4weGV6rA9P4iNB5mobHBYun4W8hv6); mainnet code hash GDKwUNKV1mvWVr48y77m9FEWkodcvCignc4GzJNAAcYv (the build before that guard; `ops/near-mainnet-owner.sh redeploy` brings it level, an owner step). `near:verify` reads both on chain.
- **Gas** (sandbox, whole transaction): one link 7.5 Tgas, a batch of 30 links about 43 Tgas, a claim into a new named account 24.1 Tgas, a reclaim 7.4 Tgas.

## Run it yourself

```sh
pnpm install --frozen-lockfile && pnpm near:verify
```

It runs the steps below, then the live read-only checks, which also look up every hash in this document's proof tables on chain; it prints PASS or FAIL per line and ends with `ALL GREEN`. The first run takes about 3 minutes when the Rust crates are already in `~/.cargo` (cargo compiles the test dependencies and downloads the nearcore sandbox, about 2 GB on disk in all), longer on a machine that has never built Rust; later runs take about 1 minute. With nothing installed, `node ops/near-verify.mjs --live-only` runs the live checks alone in about 5 seconds. `pnpm near:verify:offline` skips the network; `pnpm near:verify:live` runs only the live checks (a few seconds). Prerequisites: Node 22+, pnpm 9.12 (`corepack enable` or `npx -y pnpm@9.12.0`), Rust 1.95 (pinned by `contracts/lumen-drop-near/rust-toolchain.toml`), [cargo-near 0.23](https://github.com/near/cargo-near/releases), and near-cli-rs 0.31 only for the optional live `near contract` command. No private key; nothing is signed or spent.

<details>
<summary>Step by step, with what each step prints (measured 2026-11-11 UTC)</summary>

| Part | Step | Expect |
|---|---|---|
| The escrow, `contracts/lumen-drop-near/` (near-sdk-rs): single and batch links, claim to a new named account, a fresh address or any account, sender reclaim after expiry, pause that never blocks exits, public ledger views | `cd contracts/lumen-drop-near/contract && cargo test` | 46 unit and 21 sandbox tests ok |
| `@lumenia/near`, `packages/near/`: links, receipts, batch payouts, relayer policy and client, NEAR Intents quotes | `pnpm --filter @lumenia/near test` | 120 tests pass |
| The screens: `apps/web/app/(site)/try/send`, `apps/web/app/claim`, `apps/web/app/(site)/ledger`, `apps/web/components/near/` (send one or many, claim, pay forward, take back, public ledger, a CSV an accountant can open) | `pnpm --filter @lumenia/web test:near` | 298/298 |
| The agent MCP server and CLI, `apps/web/lib/agent-mcp.ts` (`near_*` tools) | `pnpm --filter @lumenia/web test:agentmcp` | 128/128, the Stellar and NEAR tools |
| The scoped NEP-366 relayer, `apps/sponsor` (`/near/*` routes): live in Lumenia's sponsor Worker, also runs as a local server | `pnpm --filter @lumenia/sponsor test:near-relay` | 252/252, the relayer, the practice-link route and the practice sweep |
| The Agent Market worker, `apps/agent-market/`: takes a job, creates the links in one transaction, delivers a table, a receipt and a CSV | `pnpm --filter @lumenia/agent-market test && pnpm --filter @lumenia/agent-market build` | 70 tests pass, then a clean build |
| Live, read-only (NEAR testnet, no key) | `near contract call-function as-read-only lumenia-near.testnet get_stats json-args '{}' network-config testnet now` and `curl -s https://lumenia-sponsor.avakit.workers.dev/near/health` | the escrow's counters (created, claimed, returned, open, pool); `"ok":true` for the relayer `lumenia-relayer.testnet` serving `lumenia-near.testnet` |

</details>

## Proof: live transactions on NEAR testnet (2026-11-11)

Every path ran against `lumenia-near.testnet` with Circle's testnet USDC; open any hash at https://testnet.nearblocks.io/txns/<hash>, or let `pnpm near:verify:live` look them all up.

| What | Transaction | Result |
|---|---|---|
| The demo video's take on the live site: a practice link made by the sponsor, claimed into the new account ayse-ge57.testnet, 0.25 USDC paid forward through the relayer (23:59 UTC) | 7EeSYWuqB8XQCsD4XpkhnRVLfLLZMHM6ccrawTKQKjf7, 6SXoxCFjfMa2V1iGd6EjSQHAsz3MD4qeKsoAdVHKThLB, rXb8FRSVzKadTsQXWmzd1D9GffXsopfGXyf6xYzSKaK | created with 1 USDC and 0.05 NEAR; after paying forward it holds 0.75 USDC and still 0.05 NEAR |
| Sender reclaim after expiry: eight links nobody claimed, each taken back by its funder in one transaction (2026-11-12, 01:30 UTC) | 3QMFMy7Wd7Zuu2uDvyLueMJFMTohMtq5X66u9nyfcrBs, 5eXme1YZR4wvJkSic16bXwpPJEGJCWk2DEj1KfNHSUw5 | two of the eight; the USDC went back to the funders, and `get_stats` counts 8 returned ($5.90) |
| Practice money comes back by itself: a 10-minute practice link nobody claimed, taken back by the sponsor Worker's scheduled sweep with no one acting (2026-11-12) | HiS6KR6R79auNRhuzZ2KVpSpqH43UJTKzmmjLX7r3oba, 8tBTMKNDyckwvisoNho9QC4tMA3Pu24iT25oVRSsezt4 | made at 01:32 UTC with a 10-minute life; reclaimed at 01:52 UTC by the cron, signed by the practice balance it went back to |
| Contract script: create a 1 USDC link, then claim it with the link key into a fresh account | 4pV1q11f7UXLooG9cA3t1HBSFm9B4pYnUWYxr3gEgZAD, FhL77xssNU1P57uCcuC4DiDSaU17BFNUPfcceLn3dEgu | drop Open for link key ed25519:FTbxAZN3..., then account 880115ec...93a1 created with 1 USDC and 0.05 NEAR; drop Claimed |
| Agent (MCP CLI) pays three people in one transaction | EpJn7vmaAvqexTf3JDBoGsjMbYKsyHmgs2NbFvTcAJtW | 3 links (1.00, 1.50, 1.10 USDC), one receipt each |
| NEAR Agent Market test job 94912e5d ("For agents") | 8NXQ2YXWNTyihMueGHvbJ6ceR1Qjft8M51Ce4u2MCaHf | two Open 0.25 USDC links, funded in one transaction |
| The relayer inside Lumenia's sponsor service, `/near/relay` (02:42 UTC) | A3jr4UJWjrNeahjYJNvX6CRbfWYw7BZTwc8Yweh2QiSm | 0.10 USDC link created; an immediate second request was refused with 429 (10-second cooldown) |

<details>
<summary>Six more rows: the web client's create and claim, an agent paying one person, the first relayed pay-forward, two earlier takes of the demo video</summary>

| What | Transaction | Result |
|---|---|---|
| Web script: create a 1 USDC link | 2cjvJqmgHpybmBwQNfwdginmdRZAgzUE7uvRr9FTtSYf | drop Open |
| Web script: claim it into a fresh account | BJEij829uNAZtaUAqa31Jc2yc7vq3oDjqaVizmnHckBH | account 2315f930...9cb7 holds 1 USDC; drop Claimed |
| Agent (MCP CLI) pays one person, receipt written | 2bszj9H4dfsX6igqqHzgK6sPRChUXUwVkoqEiiZfDc8K | 1 USDC link, receipt rcpt_2fd21205... |
| Pay forward through the relayer (sender signs, relayer pays the fee) | DgHQfQaxWMWzKmkwfcswBWV8NfqWyt5FvVKGAe3e3pBL | 0.10 USDC link created; relayer outcome "success" |
| An earlier take of the demo video, on the screens before the chain-neutral pass: send, claim into ayse-bzht.testnet, pay 0.25 USDC forward through the sponsor relayer (03:35 UTC) | AcYDkG9vYvzZLTtqTtFE3FvtFAi6hUn6NjhSNaew2ouV, 5mXtmnogZmQEP2HajYS4QWbGbg8QMUSzj9oC4pb8B3FA, 8YhoQMg6QCiTjhfrPs9b8eRGQ49XiW5CuYfvkBjMe4Ri | created with 1 USDC and 0.05 NEAR; after paying forward it holds 0.75 USDC and still 0.05 NEAR |
| An earlier take of the demo video: send, claim into ayse-m48q.testnet, pay 0.25 USDC forward (01:20 UTC) | 3Uv9rHsKn57RkMLcWLntjUh9cN86Na7WFPmXGGWm4cm6, 5MR6FCqGTGRoGugQNyNEf8W9NfUb7PPnxnHPiQn8srYZ, 2gbd1yNWTmsSSgPhHL4U4bK8tM1bPP59srRib4X6NthR | created with 1 USDC; the pay-forward link was created with the relayer paying the fee, and the account holds 0.75 USDC and 0.05 NEAR |

</details>

`get_stats` read 18 links created, 6 claimed, 0 returned by 03:46 UTC and 22 created, 8 claimed, 0 returned at 22:30 UTC (`pnpm near:verify:live` prints the current numbers). The sender can take the unclaimed proof links back after their 24-hour or 7-day expiry.

## Mainnet proof (2026-11-11, 23:08 to 23:42 UTC)

The owner ran `ops/near-mainnet-owner.sh` (an agent prepared it; the owner signed every transaction). The escrow is [`lumenia.near`](https://nearblocks.io/address/lumenia.near): the escrow code of 2026-11-11 (mainnet code hash GDKwUNKV1mvWVr48y77m9FEWkodcvCignc4GzJNAAcYv; the testnet escrow has run a newer build with a pool-reserve guard since 2026-11-12, under "Attacks the system refuses"), Circle's native USDC on NEAR (`17208628...36133a1`), the starter at 0 NEAR, 0.25 NEAR of allowance per link key, and the deployer account `06627280...e202e6c` as `owner_id`. Open any hash at https://nearblocks.io/txns/<hash>, or let `pnpm near:verify:live` look them up on mainnet.

| What | Transaction | Result |
|---|---|---|
| Create the escrow account `lumenia.near` with 4 NEAR | 83XLWxtTqdDZCQVSDSY3xop38ioeHUYeyNMPcfqh8xJv | account created |
| Deploy and initialise the escrow | 6oSU4Dcmk6jUZkBJmhR23qUiqXy13Pf6Z56VHuxzYhtR | code hash GDKwUNKV..., the configuration above |
| Register the escrow on USDC | Ds78Gdv832DULuijXQT6nVxuF7t3sbKfkw5ctjHz8LsS | registered (0.00125 NEAR) |
| Buy the USDC: 1.5 NEAR swapped on Rhea (Ref pool 5515) | BunQnSHCMbkxdzmgXb1ojgD9YpwZ7ozLHcpWu7EsvuqW | 5.329535 USDC to the deployer |
| Lock 2 USDC behind a link | G5PbQx4TCrHGLjC5EQCsVuir9owr43qYdSuBfdEfwQpU | drop Open |
| Claim it with the link key into the NEW account `lumenia-first.near` | 53idJThzBJomNkdLZqvuopMRWTaDXfzKHduD1paSTCTk | `lumenia-first.near` created holding 2 USDC and 0 NEAR; the escrow paid the gas and the USDC registration; drop Claimed |
| Lock 1 USDC behind a second link | H8t8FutLP6FLhK6pV6KvRE1YcNcpdZbWToMHGTaHmWT3 | drop Open |
| Claim it to the existing account `0xmeric.near` | 52bd4V9nUbPvXuHQkM4qceErSUd4Y3Y8Hwy9BHzSethH | 1 USDC to `0xmeric.near`; drop Claimed |

After the run `get_stats` read 2 links created, 2 claimed, 0 returned, 3 USDC in and 3 USDC out, and no function-call key was left on `lumenia.near` (each claim deletes its link key). The two claims cost the escrow pool 0.0124 NEAR in all: gas, one new account, two USDC registrations and the records' storage. The leftover 2.33 USDC and 11.44 NEAR went back to the owner (EC4WqpF4jV1mkX6NV532fNHbcRb52G8WUnQF3aM6kUGS, 7hVgYwpnmnpamrodJv1rX2Sydsypsvdcp277JLhoQoDS).

The first attempt to buy the USDC went through NEAR Intents 1Click (same chain, wNEAR to USDC, deposit transaction BsQjnKmAXe12F46proXPePfBT6aWa2QD1sU9X5TZqPQq at 23:09 UTC). It was quoted at 22 seconds and still read PROCESSING more than 30 minutes later, and the quote's own refund deadline is 2026-11-15 00:09 UTC. The script now waits for a final status and refuses a lock it cannot fund; one lock tried before that fix failed on a 0 USDC balance and cost only its fee. The USDC came from the Rhea swap instead, and the 1.5 wNEAR in the Intents swap returns to the deployer as USDC or as a refund. A claim straight into a NEAR Intents deposit address for another chain was not run on mainnet: cross-chain quotes failed for hours that day.

## Attacks the system refuses

| Attempt | What happens | Evidence |
|---|---|---|
| A relayed message that is not a Lumenia link creation or reclaim (wrong receiver or method, a 2 yoctoNEAR deposit, 150 Tgas, two actions, a payout to another account) | 403 with the reason, before anything is paid | `apps/sponsor/src/test-near-relay.ts` (252 assertions); a live 403 and 429 on the deployed Worker on 2026-11-11 (the allowed call is the `/near/relay` row under "Proof") |
| A forged sender id on a relayed message | Refused by an offline signature check, so it cannot burn the sender's daily cap | `test-near-relay.ts`, "FORGED SENDER" |
| A claim with a key that is not a link key, a second claim, a claim after expiry; a reclaim by a stranger or before expiry | The contract panics; the USDC never leaves the escrow | `tests/sandbox.rs` (21 tests); unit tests `claim_with_a_foreign_key_panics`, `double_claim_panics`, `claim_after_expiry_panics`, `reclaim_by_a_stranger_panics`, `reclaim_before_expiry_panics` |
| A batch whose amounts do not sum to the transfer, a reused key, a dust amount | The whole deposit is refunded; no record is written | `a_batch_whose_amounts_do_not_sum_to_the_transfer_is_refunded`, `a_batch_with_one_reused_key_is_refunded_entirely` (sandbox), `a_batch_with_a_reused_or_repeated_key_or_dust_is_returned_entirely` (unit) |
| The store behind the caps is down | Fails closed (503 `store_unavailable`); nothing is relayed blind | `test-near-relay.ts`, "[store down] fail closed" |
| A pool drained to its edge, so a claim's last step fails after the USDC moved and the stuck-claim reclaim pays the funder a second time (found in our own review on 2026-11-12) | Refused before it starts: new links are turned away and claims do not begin unless the pool keeps 0.05 NEAR free above storage, plus the claim's own deposits; the USDC of a refused new link goes back to its sender | unit tests `a_new_link_is_refused_when_the_pool_is_below_its_reserve`, `a_claim_is_refused_before_it_starts_when_the_pool_is_below_its_reserve`, `a_claim_refused_for_the_reserve_leaves_the_drop_open`; on testnet since 2026-11-12, not yet on mainnet (no link is open there) |
| The escrow owner tries to move a drop | No method does that; pause blocks only new links (the full-access key is under "What is real and what is not") | `pause_never_blocks_claim_or_reclaim` (unit), `pause_blocks_new_drops_but_a_pending_claim_and_a_reclaim_still_work` (sandbox) |

Live run: [evidence/near/attacks.md](evidence/near/attacks.md). Re-run it with `pnpm --filter @lumenia/sponsor exec tsx ../../ops/near-attack-demo.ts` from the repository root; no key is needed (without the funder's key file it signs attack 1 with a random key and gets attack 6's 0.10 USDC link from the public practice route), and `ATTACKS_OUT=/tmp/attacks.md` keeps your run from replacing the recorded one. A no-key re-run on 2026-11-12 at 01:40 UTC refused 7 of 7 as well (attack 6: link CQhEYEcRs9SNrVUwzeZ6owU81V4WM9mPrs8pj6YvWAH1, first claim 7xHck6wG5gFCkQrn38iB7bq2j9U4jEztobND5xNnPube, the second refused).

## For agents

The agent MCP server (`apps/web/lib/agent-mcp.ts`) has NEAR tools backed by `@lumenia/near`: pay one, pay many, status, reclaim, balances, cross-chain quote, receipts. `near_pay_link` returns a link and a receipt (what, to whom, how much, transaction hash, status, claimed or returned); `near_pay_many` pays up to 30 people in one transaction. The agent signs with its funder account's full-access key: the daily budget and per-link limits are enforced by the MCP server software, not by the key, which has no power over claimed money or the escrow pool. A function-call key scoped to the USDC contract cannot attach the 1 yoctoNEAR that `ft_transfer_call` needs, so the production design goes through the relayer or an on-chain allowance.

The same service is registered on NEAR Agent Market as "Lumenia Payout Agent", with its public page at https://market.near.ai/a/lumenia-payout (code, listing text and ops files in `apps/agent-market/`). Its one delivered job was the owner's free test run (job 94912e5d-7719-4abb-8243-1b7919d06bcf, 2026-11-11 21:14 UTC): the worker started within seconds, funded two 0.25 USDC links in one transaction (8NXQ2YXWNTyihMueGHvbJ6ceR1Qjft8M51Ce4u2MCaHf), delivered a table, a JSON receipt and receipt.csv in 12 seconds, and the delivery was accepted. Test runs do not count in the public job stats, which still read 0.

<details>
<summary>Hiring it from Claude Code, and where the listing stands</summary>

`claude mcp add --transport http agent-market https://market.near.ai/mcp`, then ask Claude to hire "Lumenia Payout Agent" to pay, for example, Ayse 1 USDC and Ali 2 USDC. The listing was registered through the marketplace API on 2026-11-11; it appears in the Discover catalogue once the maintainer adopts it into their account, and the public page and the A2A/x402 card work already.

</details>

## How this earns and what is beyond testnet

- Agent Market: a flat service fee per job (0.50 USDC today, the market median); payouts come from a treasury the agent owns.
- Product: Lumenia's model on Stellar is a flat fee per link on real money (the mainnet pilot runs with caps and no fee today); the NEAR rail inherits it.
- Cost per claim to the pool: about 0.011 NEAR without the starter (account creation 0.007 burned, USDC registration 0.00125, the record's storage, gas), about 0.06 NEAR with the 0.05 NEAR testnet starter. The mainnet escrow runs with the starter at 0, because self-claims could farm it; its two proof claims cost the pool 0.0124 NEAR together. Stellar locks 1.5 XLM per new account.
- Beyond testnet: the escrow runs on mainnet as `lumenia.near` (see "Mainnet proof"); the screens are mainnet-ready behind configuration (contract id, token id, root account); the relayer runs on testnet only and refuses mainnet in code (`apps/sponsor/src/lib/near-relay.ts`), and the mainnet starter is 0, so a mainnet recipient needs a little NEAR from elsewhere before moving the USDC on; the Stellar rail already runs a capped mainnet pilot with real people.

## What is real and what is not

- Real: every row under "Proof", the hosted demo, the relayer inside the sponsor service, the MCP server, the sandbox tests, and the Agent Market listing with its one delivered job (the owner's free test run; the public job stats still read 0).
- Testnet only: all of that, with Circle's testnet USDC; the cross-chain payout is a live NEAR Intents quote, not executed (Intents has no testnet). On mainnet only the escrow has run: two links and 3 USDC, driven from the owner's script rather than the screens (see "Mainnet proof").
- People outside the team: `node ops/near-outside-claims.mjs` recounts them from the chain alone (claims after 2026-11-12 02:00 UTC into accounts that are not the team's, listed in the script). Every claim before that was the team's own; this line is updated with the count before submission.
- Fixed: until commit 8719a83 (2026-11-11) the hosted demo's bundle carried the full-access key of `lumenia-demo.testnet`, the practice sender then. Practice links are made by the sponsor since, and that key was deleted from the account on 2026-11-12 (transaction GHETQWA2xV9YCPJPFGoZvPpAQEMRuDfSwe2XrL3Zyu6q); the account now holds one new key.
- Not done: no audit is claimed. No contract method lets the owner move a drop and pause only blocks new links, but the escrow account `lumenia-near.testnet` still holds one full-access key, which can redeploy the code (it did during development, on 2026-11-10 at 23:43 UTC), and new code could move the money; so does `lumenia.near` on mainnet. The production step is to remove that key or hand it to a multisig behind a time-locked upgrade: `ops/near-mainnet-owner.sh lock` removes it on mainnet, irreversibly, and has not been run. On Stellar, Lumenia's escrow owner is already a 2-of-3 multisig; its seven-day upgrade timelock is written (LumenDrop 0.3.0) but installed on neither network. The relayer and the agent's funder sign with hot full-access keys. Named accounts are `.testnet` on the testnet escrow; the mainnet proof created `lumenia-first.near`.

## Arguing against this idea

A link is a bearer secret: whoever holds it can claim the money, so a forwarded or screenshotted link is a lost payment, limited only by the expiry and the sender's reclaim. Most people who already use crypto have an address and do not need this. NEAR has had claim links since 2020 (the linkdrop standard, later Keypom) and they did not become a consumer habit, which suggests the hard part is the reason to send money this way, not the mechanic. Lumenia's answer: the recipient who has nothing is the whole point (a relative abroad, a contractor an agent must pay, a first-time user); the escrow pays only on claim and the sender can take back what nobody claims, instead of pre-funded wallets; and distribution, not technology, decides it. That answer is a bet, not a proof: the Stellar pilot moved about $4.4 in 109 transfers.

## Failure cases

<details>
<summary>Seven cases: an unopened link, a link opened twice, a claim that fails half-way, the RPC down, a lost link, the relayer down, a paused escrow</summary>

| What happens | Outcome |
|---|---|
| Nobody opens the link | The sender takes the money back after expiry (one tap on "Take the money back" under "Your links", or `reclaim` from the command line). It does not come back by itself. |
| The link is opened twice | The first claim marks the drop as being claimed; the second is refused by the contract. |
| The claim fails half-way (for example the chosen name is taken) | The contract reopens the drop and refunds the starter to its pool; the recipient can try again with another name. The USDC never leaves the escrow until the transfer succeeds. |
| The RPC is down | The screens say so and retry; nothing is signed or spent until the chain answers. |
| The sender loses the link | The sender's browser keeps a record of every link it made (written before the transaction is sent); the public key alone is enough to reclaim after expiry. |
| The relayer refuses or is down | On testnet the recipient still holds the 0.05 NEAR starter and can pay their own fee from any wallet that imports the key. On mainnet the starter is 0, so they first need a little NEAR from anywhere. |
| The escrow is paused | New links are refused; claims and reclaims keep working. |

</details>

## Where this comes from

Lumenia (https://getlumenia.com) sends and requests USDC by link on Stellar, with a sponsor backend and a Soroban escrow: the rest of this repository, a capped mainnet pilot (from the Stellar ledger: 109 transfers moving about $4.4 in total, median payment $0.002) that predates the hackathon and is not submitted. The NEAR rail is built on it: its design (the link as the bearer of money, escrow with reclaim, pause that never blocks an exit, receipts), its React components and mascot, the sponsor Worker and the agent MCP server, never its chain code; the new code is exactly the diff between the tags. The founder built the rail on 2026-11-11 and 2026-11-12, Istanbul time (the escrow account dates from 2026-11-10 22:39 UTC), directing coding agents (Claude Code): first as a prototype in a scratch repository, then integrated and committed here in logical commits after the test gate was green.

## Libraries and tools

near-sdk-rs 5 and near-contract-standards, near-sandbox and near-api (Rust) for tests, cargo-near 0.23, near-cli-rs 0.31, near-api-js 7.4, React 19, Next.js 16, TypeScript 6, @modelcontextprotocol/sdk 1.30, react-qr-code, zod, vitest, wrangler 4.

## Hackathon tags and diff

- `pre-hackathon`: the last commit before the NEAR work began (2026-11-10). Everything the diff adds was written inside the hackathon window.
- `hackathon-submission`: the state submitted to NEAR HACKATHON 2026 before 2026-11-14 23:59 UTC.
- Diff: https://github.com/getlumenia/lumenia/compare/pre-hackathon...hackathon-submission

## License

MIT, see [LICENSE](LICENSE).
