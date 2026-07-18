<!--
Thanks for contributing to Lumenia! Please fill this out so reviews are quick.
Keep PRs focused on one change. Commit messages follow Conventional Commits.
-->

## What & why

<!-- What does this change do, and what problem does it solve? -->

Closes #

## How it was tested

<!-- Commands you ran / flows you exercised. -->

- [ ] `pnpm --filter @lumenia/sponsor exec tsc --noEmit`
- [ ] `pnpm --filter @lumenia/web exec tsc --noEmit`
- [ ] `pnpm test:antidrain` (25/25)
- [ ] `pnpm --filter @lumenia/web build`

## Checklist

- [ ] CI is green (typecheck, anti-drain, builds).
- [ ] No secrets, keys, or `.env` files committed.
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).
- [ ] User-facing copy keeps the product voice (money & people, no crypto jargon).
- [ ] Screenshot attached for any visible UI change.
- [ ] **If I touched `apps/web/app/c/` or the `lib/` modules it imports**, I ran the
      end-to-end claim regression (`pnpm --filter @lumenia/web test:e2e`) and noted the
      result below.

## Screenshots / notes

<!-- Optional. -->
