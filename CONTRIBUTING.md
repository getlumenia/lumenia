# Contributing to Lumenia

Thanks for your interest. Lumenia is a **testnet pilot** — send and request money by
link, where the recipient claims it walletless, seedless, and pays no gas. This guide
gets you from a fresh clone to green checks.

> **Heads up:** the project's roadmap is grant-driven, so not every change fits the
> current scope. For anything non-trivial, please **open an issue or a discussion
> first** so we can agree on the approach before you invest time.

## Prerequisites

- **Node 20+** (CI runs Node 24)
- **pnpm 9.12** — the repo pins it via the `packageManager` field, so
  `corepack enable` will select the right version automatically
- A network connection — the spikes and e2e tests talk to the Stellar **testnet**
  (Horizon + friendbot). No real money is ever used.

## Setup

```bash
git clone https://github.com/getlumenia/lumenia.git
cd lumenia
pnpm install
```

This is a pnpm workspace with two apps and one shared package:

```
apps/web       → Next.js 16 PWA (the product surfaces + the claim page)
apps/sponsor   → the Node sponsor service (anti-drain gate, fee-bump, rate limit)
packages/shared → claim-secret + asset helpers + shared types
```

## Running the checks

The same checks CI runs, so you can reproduce a green build locally:

```bash
# typecheck both apps
pnpm --filter @lumenia/sponsor exec tsc --noEmit
pnpm --filter @lumenia/web exec tsc --noEmit

# the anti-drain validator — 25/25, no network needed
pnpm test:antidrain

# production builds
pnpm --filter @lumenia/web build
pnpm --filter @lumenia/sponsor build:vercel
```

Testnet-dependent suites (`test:integration`, the Playwright e2e, the spikes) are
**not** in CI on purpose — they need friendbot/Horizon and secrets and would be flaky.
Run them locally when your change touches those paths (see the package scripts).

## A note on the claim route

The claim page under `apps/web/app/c/` is **stability-critical** — it is the
reference flow the rest of the system is verified against. If your change touches it
(or the `lib/` modules it imports), please run the end-to-end claim regression
(`pnpm --filter @lumenia/web test:e2e`) and mention the result in your PR.

## Pull requests

- Branch off `main`; keep PRs focused on one thing.
- **Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)** —
  e.g. `feat(web): ...`, `fix(sponsor): ...`, `chore: ...`, `docs: ...`.
- Make sure **all CI checks are green** (typecheck, anti-drain, builds).
- Never commit secrets — keys, tokens, or `.env` files. `.env.example` is the only
  env file that belongs in git.
- Include a screenshot for any visible UI change.

## Language & tone

Everything in the repo is **English** — code, comments, docs, and product copy. The
product UI deliberately avoids crypto jargon (it speaks in "money" and "people"); if
you touch user-facing copy, keep that voice.

## Reporting bugs & ideas

Use the issue templates (bug report / feature request). For security issues, follow
[SECURITY.md](.github/SECURITY.md) instead of opening a public issue. For open-ended
questions, start a **Discussion**.

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) and that you'll follow our
[Code of Conduct](CODE_OF_CONDUCT.md).
