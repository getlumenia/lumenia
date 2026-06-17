# @lumenia/web

Lumenia's web-first PWA (Next.js 16). A single codebase = a powerful web app + a mobile app installed via "Add to Home Screen".

> Skeleton EXISTS (value-first claim flow + architecture seams). For architecture and decisions,
> see the root-level [README.md](../../README.md), [stack.md](../../stack.md) and [POSITIONING.md](../../POSITIONING.md).

## What's in the skeleton
- `app/page.tsx` — landing ("Para gönder, dolar tut") · `app/manifest.ts` — PWA manifest
- `app/c/[id]/page.tsx` — **value-first claim page** (shows the money before any credential) + `ClaimButton.tsx` (deferred-credential claim action)
- `app/c/[id]/opengraph-image.tsx` — **per-claim OG card** (`next/og`, SSR) so the WhatsApp preview already says "you got money"
- `lib/signer.ts` — **Signer abstraction** (v1 local-Ed25519 / v2 passkey, same interface — Tyler #1)
- `lib/account.ts` — **address-stable** identity (signer swap, not account migration — Tyler #2)
- `lib/offramp.ts` — **exit-adapter** interface (card / CCTP), outside the trust boundary, recipient-signed (Tyler #3/#4)
- `lib/copy.ts` (tr locale), `lib/money.ts` ($/₺), `lib/claims.ts` (claim lookup stub)

Positioning rule enforced in copy: the user only ever sees **money ($/₺) and people** — never "wallet/crypto/USDC/Stellar/gas".

## Responsibilities (full scope; some stubbed)
- Claim link opening flow (browser, incl. WhatsApp webview: value-first + escape-to-browser + Argon2id)
- Passkey (WebAuthn PRF) + Argon2id recovery — key encryption/decryption is client-side
- Building the inner tx (recipient signs) → sending it to the sponsor service (`@lumenia/shared` + Spikes #1/#1c)
- Dynamic OG cards (`next/og`, per-claim-ID, SSR)
- PWA (Serwist service worker, web push)
- Request money (SEP-7) + uneven split UI — **deferred to v1.5**

## Run
```bash
pnpm install                 # installs web deps (next/react/etc.) if not yet present
pnpm --filter @lumenia/web dev
```
> Stubbed for the skeleton: the real signer, recovery, sponsor HTTP wiring, and off-ramp adapters. Icons under `/public` are placeholders.
