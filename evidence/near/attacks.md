# NEAR rail: attacks the system refuses (live testnet)

Each row is a live attempt against the deployed testnet system on 2026-11-11 (UTC); nothing here is simulated.
Every request below reached either the deployed relayer at https://lumenia-sponsor.avakit.workers.dev/near or NEAR testnet RPC (https://test.rpc.fastnear.com), and the system's own answer is quoted verbatim (shortened).

Result: 7 of 7 attacks were REFUSED by the live system. Run 2026-11-11T22:30:15.799Z -> 2026-11-11T22:30:42.170Z.

| # | Attack | Expected | Observed answer (verbatim, short) | Verdict | Evidence |
|---|--------|----------|-----------------------------------|---------|----------|
| 1 | Drain via relayer: funder-signed USDC ft_transfer to an attacker account | 403 (only ft_transfer_call into the escrow is paid for) | HTTP 403 method: method "ft_transfer" on the USDC contract is not allowed (only ft_transfer_call) | REFUSED | HTTP 403 @ 2026-11-11T22:30:16.822Z |
| 2 | Arbitrary contract call via relayer (wrap.testnet near_deposit; escrow pause) | 403 for each (receiver is neither USDC nor the escrow; pause is not a relayed method) | (a) HTTP 403 receiver: receiver "wrap.testnet" is neither the USDC contract (3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af) nor th… | REFUSED | HTTP 403/403 @ 2026-11-11T22:30:17.738Z |
| 3 | Forged sender: delegate claims sender_id=lumenia-demo.testnet, signed with a different key | 403 bad signature; the victim's day counter does not move | HTTP 403 signature: the delegate signature does not verify against its public_key | REFUSED | HTTP 403 @ 2026-11-11T22:30:18.569Z; relayer globalToday 2 -> 2 (unchanged) |
| 4 | Oversized deposit: an otherwise-valid ft_transfer_call with 2 yoctoNEAR attached | 403 (exactly 1 yoctoNEAR is allowed) | HTTP 403 deposit: ft_transfer_call must attach exactly 1 yoctoNEAR, got 2 | REFUSED | HTTP 403 @ 2026-11-11T22:30:19.278Z |
| 5 | Claim with a stranger key: a claim tx to the escrow signed by a non-link key | chain rejects the transaction (access key does not exist) | chain rejected: Access key ed25519:ApGXAJeDPH7Fqb8piK6Zgk2z8nzKUvMF4FJCEPD37GMS does not exist on account lumenia-near.testnet | REFUSED | NEAR testnet RPC @ 2026-11-11T22:30:19.508Z |
| 6 | Double claim: claim one 0.10 USDC link twice with the same link key | first claim succeeds; second claim is rejected (link key deleted after the first) | chain rejected the second claim: Access key ed25519:G3kVK1Wu5CBXKn2DjkcH5fev3LkMEfyWQuh5ns2XaHAc does not exist on account lumenia-near.testnet | REFUSED | create https://testnet.nearblocks.io/txns/9s4tSdpXbeSa3k32AFpoZQUF6VuFUfcqDmeWrE4E4f6G ; claim#1 https://testnet.nearblocks.io/txns/2TZKmVLGK1mCVrFSfnkcx4ZL1WKqpTxhBZgY9A3zsbk6 ; claim#2 rejected (local hash wAG9RzcoSRLMhnvuct6xWTsPh9pMJtuVtoh5Gq6ztDA) |
| 7 | Rate limit: burst the same signed (policy-refused) delegate from one key | 429 per-signing-key rate limit after the per-minute allowance (15) is spent | first: HTTP 403 deposit: ft_transfer_call must attach exactly 1 yoctoNEAR, got 2 \|\| at request #16: HTTP 429 rate_limited: per-account rate limit exc… | REFUSED | HTTP 429 after 16 requests @ 2026-11-11T22:30:42.170Z |

Spend: at most 0.10 testnet USDC (attack 6 creates and claims one link). No mainnet was touched. No private keys appear in this file or in the script's output.

Re-run (Node 24, from the repo root):

```
pnpm --filter @lumenia/sponsor exec tsx ../../ops/near-attack-demo.ts   (from the repository root; uses the workspace tsx)
```

(equivalently `npx tsx ops/near-attack-demo.ts` wherever tsx is on PATH; the line above uses the workspace's pinned tsx so it needs no install.)

## Full run log

```
================================================================================
Lumenia NEAR rail: attacks the system refuses (LIVE, NEAR testnet only)
run at:   2026-11-11T22:30:15.799Z
relayer:  https://lumenia-sponsor.avakit.workers.dev/near
rpc:      https://test.rpc.fastnear.com
escrow:   lumenia-near.testnet   usdc: 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
budget:   at most 0.10 testnet USDC (attack 6). No mainnet. No secret keys printed.
================================================================================

[1] Drain via relayer: funder-signed USDC ft_transfer to an attacker account
    time:     2026-11-11T22:30:15.959Z -> 2026-11-11T22:30:16.822Z
    expected: 403 (only ft_transfer_call into the escrow is paid for)
    request:  POST /near/relay signer=lumenia-funder.testnet USDC.ft_transfer -> {receiver_id:attacker.testnet, amount:100000} 1 yocto
    answer:   HTTP 403 method: method "ft_transfer" on the USDC contract is not allowed (only ft_transfer_call)
    verdict:  REFUSED
    evidence: HTTP 403 @ 2026-11-11T22:30:16.822Z

[2] Arbitrary contract call via relayer (wrap.testnet near_deposit; escrow pause)
    time:     2026-11-11T22:30:17.299Z -> 2026-11-11T22:30:17.738Z
    expected: 403 for each (receiver is neither USDC nor the escrow; pause is not a relayed method)
    request:  POST /near/relay x2 (a) wrap.testnet.near_deposit (b) lumenia-near.testnet.pause
    answer:   (a) HTTP 403 receiver: receiver "wrap.testnet" is neither the USDC contract (3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af) nor the escrow (lumenia-near.testnet) || (b) HTTP 403 method: method "pause" on the escrow is not allowed (only recl…
    verdict:  REFUSED
    evidence: HTTP 403/403 @ 2026-11-11T22:30:17.738Z

[3] Forged sender: delegate claims sender_id=lumenia-demo.testnet, signed with a different key
    time:     2026-11-11T22:30:18.495Z -> 2026-11-11T22:30:18.569Z
    expected: 403 bad signature; the victim's day counter does not move
    request:  POST /near/relay sender_id=lumenia-demo.testnet signature from a different key than public_key
    answer:   HTTP 403 signature: the delegate signature does not verify against its public_key
    note:     refusal happens at the signature gate, before any cap or counter code runs; relayer day counter 2 -> 2
    verdict:  REFUSED
    evidence: HTTP 403 @ 2026-11-11T22:30:18.569Z; relayer globalToday 2 -> 2 (unchanged)

[4] Oversized deposit: an otherwise-valid ft_transfer_call with 2 yoctoNEAR attached
    time:     2026-11-11T22:30:18.903Z -> 2026-11-11T22:30:19.278Z
    expected: 403 (exactly 1 yoctoNEAR is allowed)
    request:  POST /near/relay USDC.ft_transfer_call -> escrow, deposit = 2 yoctoNEAR
    answer:   HTTP 403 deposit: ft_transfer_call must attach exactly 1 yoctoNEAR, got 2
    verdict:  REFUSED
    evidence: HTTP 403 @ 2026-11-11T22:30:19.278Z

[5] Claim with a stranger key: a claim tx to the escrow signed by a non-link key
    time:     2026-11-11T22:30:19.389Z -> 2026-11-11T22:30:19.508Z
    expected: chain rejects the transaction (access key does not exist)
    request:  tx -> lumenia-near.testnet.claim signed by a random ed25519 key that is not a drop key
    answer:   chain rejected: Access key ed25519:ApGXAJeDPH7Fqb8piK6Zgk2z8nzKUvMF4FJCEPD37GMS does not exist on account lumenia-near.testnet
    verdict:  REFUSED
    evidence: NEAR testnet RPC @ 2026-11-11T22:30:19.508Z

[6] Double claim: claim one 0.10 USDC link twice with the same link key
    time:     2026-11-11T22:30:26.470Z -> 2026-11-11T22:30:36.259Z
    expected: first claim succeeds; second claim is rejected (link key deleted after the first)
    request:  create (relayer) -> claim #1 -> claim #2, all with link key ed25519:G3kVK1Wu5C...
    answer:   chain rejected the second claim: Access key ed25519:G3kVK1Wu5CBXKn2DjkcH5fev3LkMEfyWQuh5ns2XaHAc does not exist on account lumenia-near.testnet
    note:     link created via relayer (ALLOWED): tx 9s4tSdpXbeSa3k32AFpoZQUF6VuFUfcqDmeWrE4E4f6G
    note:     first claim succeeded: tx 2TZKmVLGK1mCVrFSfnkcx4ZL1WKqpTxhBZgY9A3zsbk6 -> paid 4b58829833...
    note:     second claim used the already-deleted link key; local tx hash wAG9RzcoSRLMhnvuct6xWTsPh9pMJtuVtoh5Gq6ztDA
    verdict:  REFUSED
    evidence: create https://testnet.nearblocks.io/txns/9s4tSdpXbeSa3k32AFpoZQUF6VuFUfcqDmeWrE4E4f6G ; claim#1 https://testnet.nearblocks.io/txns/2TZKmVLGK1mCVrFSfnkcx4ZL1WKqpTxhBZgY9A3zsbk6 ; claim#2 rejected (local hash wAG9RzcoSRLMhnvuct6xWTsPh9pMJtuVtoh5Gq6ztDA)

[7] Rate limit: burst the same signed (policy-refused) delegate from one key
    time:     2026-11-11T22:30:36.361Z -> 2026-11-11T22:30:42.170Z
    expected: 429 per-signing-key rate limit after the per-minute allowance (15) is spent
    request:  POST /near/relay x16 (same delegate, same signing key), no USDC moved
    answer:   first: HTTP 403 deposit: ft_transfer_call must attach exactly 1 yoctoNEAR, got 2 || at request #16: HTTP 429 rate_limited: per-account rate limit exceeded
    verdict:  REFUSED
    evidence: HTTP 429 after 16 requests @ 2026-11-11T22:30:42.170Z

================================================================================
done: 7/7 attacks REFUSED by the live testnet system
run:  2026-11-11T22:30:15.799Z -> 2026-11-11T22:30:42.170Z
================================================================================
```
