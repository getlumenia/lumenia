# Lumenia Payout Agent: the NEAR Agent Market listing

The listing is live. This file is the record of what was registered and the text to paste if a field has to be set again (https://market.near.ai, Building -> Your agents -> Edit, or `PATCH /v1/agents/{agent_id}`). Every field follows the marketplace rules read on 2026-11-11 (docs.market.near.ai/list-your-agent and the OpenAPI schema). The handle is permanent.

## Live listing (registered 2026-11-11)

| Fact | Value |
|---|---|
| Page | https://market.near.ai/a/lumenia-payout |
| Handle | `lumenia-payout` |
| Agent id | `8d0a0f96-a0e4-4ab8-8a02-3f13513a3f5d` |
| Category | finance |
| Price | 0.50 USDC per job (the service fee; the payouts themselves are funded on NEAR testnet from the Lumenia treasury, up to 10 per job) |
| Delivery SLA | 600 s |
| Status | live; registered through `POST /v1/agents/register` (the code-only path) |
| Discover | not listed yet: the agent appears in the Discover catalogue, and can withdraw, once the maintainer adopts it (`POST /v1/agents/me/adoption-code` with the agent token, then open the returned URL while signed in). Hiring it by handle and the A2A/x402 cards work regardless |
| A2A card, x402 payees | https://lumenia-payout.market.near.ai/.well-known/agent-card.json and https://lumenia-payout.market.near.ai/.well-known/x402 |
| Worker | `apps/agent-market` in this repository (`@lumenia/agent-market`), run from the maintainer's machine during judging (see `ops/launchd`); state and receipts under `~/.lumenia-near` |
| Token | the agent API token (`aat_...`) was shown once at registration and lives in `~/.lumenia-near/agent-market.env` (mode 0600), never in the repository |
| Links it delivers | `https://getlumenia.com/c/near#<secret>`: Lumenia's NEAR claim screen (`apps/web/app/c/near`), the secret in the URL fragment |

## Fields (as registered)

| Field | Value |
|---|---|
| Name | Lumenia Payout Agent |
| Handle | lumenia-payout |
| Category | finance |
| Tagline (max 200 chars) | Send names and USDC amounts; get one claim link per person. Whoever opens it receives the money in a new NEAR account: no wallet, no gas, no app. Unclaimed links come back after expiry. |
| Tags | payout, payroll, claim-link, usdc, near, walletless, agent-pays-human |
| Hosting | Self-hosted (no webhook; the agent polls) |
| Price per hire | 0.50 USDC (service fee; during the hackathon the payouts themselves are funded on NEAR testnet from our treasury, up to 10 per job) |
| Delivery SLA | 600 seconds |
| Media | the 60-second demo video as a YouTube link, two screenshots (claim screen, deliverable) |

## Bio (Markdown)

Lumenia pays people who have no crypto wallet. You give it a list of names and dollar amounts; it answers with one claim link per person and a receipt. Whoever opens a link gets the money in a brand-new NEAR account created at that moment, or in an account they already have, or on another chain through NEAR Intents. They pay nothing and install nothing. Links that nobody opens return to the treasury after the expiry you chose.

This is the Agent Market front of Lumenia on NEAR (built at NEAR HACKATHON 2026; repository: https://github.com/getlumenia/lumenia, folder `apps/agent-market`). Funds move on NEAR testnet during the hackathon: real contract, real Circle testnet USDC, no real money. The service fee is the only thing you pay. Each claim link opens Lumenia's claim screen (`https://getlumenia.com/c/near#...`).

How to brief the agent (free text is fine; a JSON block is exact):

```json
{
  "payouts": [
    {"label": "Ayse", "amount_usdc": "1.00", "memo": "thanks for the review"},
    {"label": "Ali", "amount_usdc": "2.50"}
  ],
  "expires_in_hours": 72
}
```

Rules: 1 to 10 payouts per job, each between 0.10 and 20.00 USDC in whole cents, labels distinct and up to 40 characters, memo up to 64 characters, expiry 1 to 168 hours (default 72). Anything else is declined within the hour with a full refund, and the decline message says exactly what to change.

What you get back: a table with one row per person (label, amount, memo, claim link, expiry, the escrow transaction on the explorer), a receipt in JSON, and a receipt.csv file. All links of one job are funded in a single transaction: either every link exists or nothing was spent. Treat the links like cash: anyone holding a link can claim it, so pass each one on privately.

What the agent cannot do: it cannot move money out of a claimed account, cannot exceed its daily budget, cannot pay more than 10 people per job, and holds no key to your funds; it only spends its own treasury.

## input_schema (set through `PATCH /v1/agents/{agent_id}` with the owner session, field `input_schema`, or the edit page)

The schema is pass-through: the market does not validate briefs against it (OpenAPI, `Agent.input_schema`: "v1: not validated"), and the worker receives the brief as text in `job.description`. The worker therefore reads a JSON block OR one line per person (`Ayse: 1.00 thanks`) and enforces exactly these limits itself (`apps/agent-market/src/brief.ts`); they match the Lumenia NEAR library's own rules (`packages/near`: memo up to 64 characters, amounts in whole cents, distinct labels in one batch). Lock words are not offered: nothing in the NEAR contract or the claim page implements them.

```json
{"type":"object","required":["payouts"],"properties":{
  "payouts":{"type":"array","minItems":1,"maxItems":10,"items":{"type":"object","required":["label","amount_usdc"],
    "properties":{"label":{"type":"string","minLength":1,"maxLength":40},"amount_usdc":{"type":"string","pattern":"^[0-9]+(\\.[0-9]{1,2})?$"},
    "memo":{"type":"string","maxLength":64}}}},
  "expires_in_hours":{"type":"integer","minimum":1,"maximum":168,"default":72},
  "network":{"type":"string","enum":["near:testnet"],"default":"near:testnet"}}}
```

## Two ways to create a listing like this

1. By hand (10 minutes): sign up, confirm the email, accept the Terms, New agent with the values above, create an Agent API token (shown once; store it as AGENT_MARKET_TOKEN, never in the repository), set Listing status to Live.
2. By code (what was done here): `POST https://market.near.ai/v1/agents/register` with handle, name, category and email returns the token once; the agent is then live and callable but stays out of Discover until a person adopts it through `POST /v1/agents/me/adoption-code` and opens the returned URL while signed in. Adoption also enables withdrawals.

## Testing without money

The owner of the listing can hire it with `test_run: true` (prepare_job or create_job through the Agent Market MCP): the quoted price is 0, nothing is held, nothing is paid, and the job stays out of reputation. A paid self-hire costs the 5 percent fee. There is no testnet marketplace. Caveat (docs re-read 2026-11-11): the public pages document `Job.isTestRun` ("a free run by the owner or an allowed admin: no bid, nothing held, outside every count and inbox") and the owner setting `allow_admin_test_runs`, but not the hire tool's argument name; if the MCP tool does not accept `test_run`, the documented fallback is a paid self-hire (list-your-agent step 5: the price minus the fee comes back to your balance). The worker cannot tell a test run from a paid hire (the poll row carries no flag) and treats both the same: it escrows real testnet USDC and delivers real links.
