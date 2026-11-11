# Lumenia on NEAR: the NEAR rail, for judges and reviewers

Built at NEAR HACKATHON 2026 (window 1 to 14 November 2026; this work: 11 to 14 November). Tracks: Real-World Money, Agent Economy, Open Innovation. This document lives in Lumenia's product repository (https://github.com/getlumenia/lumenia); only the NEAR rail described here is the submission.

- Hosted demo (NEAR testnet, online through 30 November 2026): https://getlumenia.com/near (mirror for automated clients: https://lumenia-near.avakit.workers.dev)
- Demo video (60 seconds, one live take on the product screens: a link is sent, claimed into the new account ayse-bzht.testnet, paid forward through the relayer, then the public ledger): https://lumenia-near.avakit.workers.dev/demo.mp4 (16:9 copy: /demo-720p.mp4; the first take on an earlier interface is /demo-first-take.mp4)
- Escrow contract on NEAR testnet: `lumenia-near.testnet` (https://testnet.nearblocks.io/address/lumenia-near.testnet)
- One command checks everything (tests, builds, live testnet reads): `pnpm near:verify` from the repository root. See "Run it yourself".
- Hackathon tags: `pre-hackathon` (the last commit before the NEAR work) and `hackathon-submission` (the submitted state); diff https://github.com/getlumenia/lumenia/compare/pre-hackathon...hackathon-submission

## What it is, in one minute

You want to send someone ten dollars. They have no crypto wallet, no NEAR, no app. You send them a link instead. They open it in any browser, see the money, pick a name, tap once, and the money is theirs: a NEAR account with that name is created at that moment, funded with USDC, and they paid nothing for it. If they already have a NEAR account they can take the money there, and if they would rather have it on another chain they can choose that too. If nobody opens the link, the money comes back to you after it expires.

The same thing works when the sender is a program. An AI agent that owes a person money (a bounty, a survey reward, a refund) calls one tool and gets back a link and a receipt. The person on the other end never needs a wallet. Agents and people can also hire this service on NEAR Agent Market.

Lumenia exists on Stellar as a capped pilot (109 transfers moving about $4.4 in total, see "Where this comes from"). This repository is the NEAR version, written from scratch during the hackathon; only the NEAR work is submitted.

## Try it in three minutes (no wallet, no faucet click)

1. Open https://getlumenia.com/near and press "Send on NEAR". Sign in to the demo sender with the key shown on that page (a testnet account that already holds testnet USDC; the key never leaves your browser tab). Type an amount such as 1.00, choose "10 minutes (demo)" as the expiry if you want to watch a reclaim later, press Send.
2. You get a link and a QR code. Open the link in a private window or on your phone. That is the recipient.
3. Type a name, for example your first name, and press "Create <name>.testnet and claim $1.00". After a few seconds the screen says the money is in your new account, with the account name and the balance read back from the token contract.
4. Back on the sender screen, the link's state line reads "Claimed" with a small "View on explorer" link to the transaction. The "Public ledger" page lists the same link.
5. Optional: on the recipient's done screen, "Pay it forward" sends part of the money onward as a new link while the recipient holds no NEAR at all (a relayer pays the fee, and it only pays for calls to this contract).

Judges can repeat every step from the command line; see "Run it yourself".

## How NEAR is used, in plain words

- The money sits in a small contract on NEAR, an escrow. The sender moves USDC into it with one transaction; the contract remembers which link the money belongs to.
- The link holds a key. On NEAR a key can be limited to one contract, a few methods and a gas allowance. The link key can only call "claim" on the escrow, and the escrow's own balance pays the gas. That is why the recipient pays nothing and needs no NEAR.
- At claim time the contract creates the recipient's named account through NEAR's own account-creation contract (an account can exist with zero balance), registers it with the USDC token, pays that small registration deposit, transfers the USDC, and adds 0.05 NEAR so the account can make its first ordinary transactions. Four steps, one tap.
- The recipient can instead name an existing account, or ask for the money on another chain: the claim then pays a NEAR Intents deposit address and Intents delivers the dollars to the chosen chain. Intents has no testnet, so the hosted demo shows the live quote and stops there; the code path is the same on mainnet.
- A meta-transaction relayer (NEP-366) lets a freshly created account pay forward with zero NEAR. It is scoped: it relays only link creation into this escrow and the sender's reclaim, nothing else, with per-account and daily caps.
- Unclaimed money returns to the sender after the expiry the sender chose (ten minutes to seven days). The escrow owner can pause new links but can never block a claim or a reclaim, and can never move anyone's money.

## For AI agents

Lumenia's agent MCP server (apps/web/lib/agent-mcp.ts) gains the NEAR tools, backed by the `@lumenia/near` library. One call to `near_pay_link` returns a link plus a receipt (what, to whom, how much, transaction hash, status, claimed or returned). `near_pay_many` pays up to 30 people in one transaction from a list of names and amounts. The agent's key can only move its own USDC into the escrow, within a daily budget; it cannot touch claimed money or the escrow pool. `agent-market/` is the same service listed on NEAR Agent Market as "Lumenia Payout Agent", so a person or another agent can hire it from Claude Code with one sentence. The listing is live at https://market.near.ai/a/lumenia-payout (registered through the marketplace API on 2026-11-11; it appears in the Discover catalogue once the maintainer adopts it into their account; the public page and the A2A/x402 card work already). To hire it from Claude Code: `claude mcp add --transport http agent-market https://market.near.ai/mcp`, then ask Claude to hire "Lumenia Payout Agent" to pay, for example, Ayse 1 USDC and Ali 2 USDC. The worker code, the listing text and the ops files are in agent-market/.

## What was built (all inside the window)

| Part | What it is | Tests |
|---|---|---|
| contracts/lumen-drop-near/ | The escrow, in Rust (near-sdk-rs). Single and batch links, claim to a new named account, to a fresh address or to any account, sender reclaim after expiry, pause that never blocks exits, public ledger views, NEP-297 events. | 43 unit + 21 sandbox tests |
| apps/web/app/near/*, app/c/near/ | The sender and recipient screens: send one or many, claim, pay forward, take back, public ledger, CSV export an accountant can open. | 70 tests |
| apps/sponsor (/near/* routes) | The scoped NEP-366 relayer (Cloudflare Worker and a local server), live inside Lumenia's sponsor Worker at https://lumenia-sponsor.avakit.workers.dev/near/health | 60 tests |
| apps/web/lib/agent-mcp.ts (near_* tools) + packages/near | MCP server and CLI for agents: pay one, pay many, status, reclaim, balances, cross-chain quote, receipts. | 78 tests |
| apps/agent-market/ | The Agent Market worker: takes a job, creates the links in one transaction, delivers a table, a receipt and a CSV. | 69 tests |

Measured on the sandbox (whole transaction): creating one link 7.5 Tgas, a batch of 30 links 43.1 Tgas, a claim into a new named account 24.1 Tgas, a reclaim 7.4 Tgas. The pool pays about 0.057 NEAR per claim at the current testnet settings (storage, USDC registration, 0.05 NEAR starter, gas), so 10 NEAR covers about 170 claims; the contract's `get_stats` shows the live numbers.

## Run it yourself (judges, reviewers, coding agents)

Everything runs on a clean machine with Rust 1.95 (pinned by contracts/lumen-drop-near/rust-toolchain.toml), Node 24 and pnpm 9.12 (`corepack enable` or `npx -y pnpm@9.12.0`). No private key is needed for any step below.

```sh
pnpm install --frozen-lockfile
pnpm near:verify            # contract tests, the NEAR package, the web and sponsor NEAR suites, the Agent Market worker, then live read-only checks
pnpm near:verify:offline    # the same without network
pnpm near:verify:live       # only the live checks (about 2 seconds)
```

Step by step, if you prefer:

```sh
cd contracts/lumen-drop-near/contract && cargo test        # see: 43 unit tests and 21 sandbox tests, all ok
pnpm --filter @lumenia/near test                            # see: 120 tests pass
pnpm --filter @lumenia/web test:near                        # the web rail's self-tests
pnpm --filter @lumenia/web test:agentmcp                    # the agent MCP, Stellar and NEAR tools
pnpm --filter @lumenia/sponsor test:near-relay              # the relayer routes through worker.fetch
pnpm --filter @lumenia/agent-market test && pnpm --filter @lumenia/agent-market build

# Live, read-only (NEAR testnet, no key)
near contract call-function as-read-only lumenia-near.testnet get_stats json-args '{}' network-config testnet now
curl -s https://lumenia-sponsor.avakit.workers.dev/near/health
```

## Proof: live transactions on NEAR testnet (2026-11-11)

Every path below was exercised against the deployed contract `lumenia-near.testnet` with Circle's testnet USDC. Open any hash on https://testnet.nearblocks.io/txns/<hash>.

| What | Transaction | Result |
|---|---|---|
| Sender creates a 1 USDC link (contract script) | 4pV1q11f7UXLooG9cA3t1HBSFm9B4pYnUWYxr3gEgZAD | drop Open for link key ed25519:FTbxAZN3... |
| Recipient claims that link with the link key into a fresh account (contract script) | FhL77xssNU1P57uCcuC4DiDSaU17BFNUPfcceLn3dEgu | account 880115ec...93a1 created, holds 1 USDC and 0.05 NEAR; drop Claimed |
| Web script: create a 1 USDC link | 2cjvJqmgHpybmBwQNfwdginmdRZAgzUE7uvRr9FTtSYf | drop Open |
| Web script: claim it into a fresh account | BJEij829uNAZtaUAqa31Jc2yc7vq3oDjqaVizmnHckBH | account 2315f930...9cb7 holds 1 USDC; drop Claimed |
| Agent (MCP CLI) pays one person, receipt written | 2bszj9H4dfsX6igqqHzgK6sPRChUXUwVkoqEiiZfDc8K | 1 USDC link, receipt rcpt_2fd21205... |
| Agent (MCP CLI) pays three people in one transaction | EpJn7vmaAvqexTf3JDBoGsjMbYKsyHmgs2NbFvTcAJtW | 3 links (1.00, 1.50, 1.10 USDC), one receipt each |
| Pay forward through the relayer (sender signs, relayer pays the fee) | DgHQfQaxWMWzKmkwfcswBWV8NfqWyt5FvVKGAe3e3pBL | 0.10 USDC link created; relayer outcome "success" |
| The same through the relayer inside Lumenia's sponsor service (`/near/relay`, 2026-11-11 02:45 UTC) | A3jr4UJWjrNeahjYJNvX6CRbfWYw7BZTwc8Yweh2QiSm | 0.10 USDC link created; an immediate second request was refused with 429 (10-second cooldown) |
| Demo video take on the product screens: send, claim into ayse-bzht.testnet, pay forward through the sponsor relayer (2026-11-11 06:35 UTC) | AcYDkG9vYvzZLTtqTtFE3FvtFAi6hUn6NjhSNaew2ouV, 5mXtmnogZmQEP2HajYS4QWbGbg8QMUSzj9oC4pb8B3FA, 8YhoQMg6QCiTjhfrPs9b8eRGQ49XiW5CuYfvkBjMe4Ri | the named account exists and holds 1 USDC and 0.05 NEAR; the pay-forward link was created with the relayer paying the fee |
| Demo video take: send, claim into ayse-m48q.testnet, pay forward (2026-11-11 04:20 UTC) | 3Uv9rHsKn57RkMLcWLntjUh9cN86Na7WFPmXGGWm4cm6, 5MR6FCqGTGRoGugQNyNEf8W9NfUb7PPnxnHPiQn8srYZ, 2gbd1yNWTmsSSgPhHL4U4bK8tM1bPP59srRib4X6NthR | the named account exists and holds 1 USDC; the pay-forward link was created with the relayer paying the fee |

After these runs `get_stats` on the contract read 18 links created, 6 claimed, 0 returned (`pnpm near:verify:live` prints the current numbers). The unclaimed proof links return to the sender after their 24-hour or 7-day expiry.

## What is real and what is not

- Real: the contract on NEAR testnet, Circle's testnet USDC, the hosted demo, the relayer, the MCP server, the sandbox tests, the Agent Market listing.
- Testnet only: nothing here touches mainnet money. NEAR Intents has no testnet, so the cross-chain payout is shown as a live quote, not executed.
- Not done: no security audit (none is claimed). The escrow owner is a single key that can also redeploy the contract; the production design is a multisig with a time-locked upgrade, as Lumenia runs on Stellar. The relayer key is a hot key on a Worker. Named accounts are created under `.testnet` here and would be `.near` on mainnet.

## Arguing against this idea

A link is a bearer secret: whoever holds it can claim the money, so a forwarded or screenshotted link is a lost payment, and only the expiry and the sender's reclaim limit the damage. Most people who already use crypto do not need this; they have an address. NEAR has had claim links since 2020 (the linkdrop standard, later Keypom) and they did not become a consumer habit, which suggests the hard part is not the mechanic but the reason to send money this way at all. Lumenia's answer is that the recipient who has nothing is the whole point (a relative abroad, a contractor an agent must pay, a first-time user), that the escrow funds only on claim and returns on expiry instead of handing out pre-funded wallets, and that distribution, not technology, decides it. That answer is a bet, not a proof: the Stellar pilot moved about $4.4 in 109 transfers.

## Failure cases

| What happens | Outcome |
|---|---|
| Nobody opens the link | The sender takes the money back after expiry (one tap on /send, or `reclaim` from the command line). |
| The link is opened twice | The first claim marks the drop as being claimed; the second is refused by the contract. |
| The claim fails half-way (for example the chosen name is taken) | The contract reopens the drop and refunds the starter to its pool; the recipient can try again with another name. The USDC never leaves the escrow until the transfer succeeds. |
| The RPC is down | The screens say so and retry; nothing is signed or spent until the chain answers. |
| The sender loses the link | The sender's browser keeps a record of every link it made (written before the transaction is sent); the public key alone is enough to reclaim after expiry. |
| The relayer refuses or is down | The recipient still holds 0.05 NEAR and can pay their own fee from any wallet that imports the key. |
| The escrow is paused | New links are refused; claims and reclaims keep working. |

## Where this comes from

Lumenia (https://getlumenia.com) sends and requests USDC by link on Stellar, with a sponsor backend and a Soroban escrow; that is the rest of this repository. It predates the hackathon and is not part of this submission; the NEAR rail reuses its design (the link as the bearer of money, escrow with reclaim, pause that never blocks an exit, receipts) and its frontend, not its chain code. Pilot numbers, counted from the Stellar ledger: 109 transfers moving about $4.4 in total on mainnet, median payment $0.002.

## Libraries and tools

near-sdk-rs 5.x and near-contract-standards, near-sandbox and near-api (Rust) for tests, cargo-near 0.23, near-cli-rs 0.31, near-api-js 7.4, Vite 7, React 18, TypeScript 5.9, @modelcontextprotocol/server 2.4, zod, vitest, wrangler 4, qrcode-generator. The code was written with coding agents (Claude Code) directed by the founder, inside the window; nothing is reused from the Stellar codebase except ideas.

## Hackathon tags and diff

- `pre-hackathon`: the last commit of this repository before the NEAR work began (2026-11-10). Everything the diff adds was written inside the hackathon window.
- `hackathon-submission`: the state submitted to NEAR HACKATHON 2026 before 2026-11-14 23:59 UTC.
- Diff: https://github.com/getlumenia/lumenia/compare/pre-hackathon...hackathon-submission

The rest of this repository is Lumenia's Stellar product (live as a capped mainnet pilot); it predates the hackathon and is not part of the submission.

## License

MIT, see LICENSE.
