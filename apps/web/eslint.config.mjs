/**
 * ONE RULE, AND THE BUG THAT BOUGHT IT.
 *
 * /send grew two `useEffect`s that were written BELOW the screen's `if (status === "loading")`
 * early return. A cold load therefore rendered twelve hooks and then sixteen, which React answers
 * with error #310 and a white screen — on the send-money surface, in production. Typecheck cannot
 * see it (the types are perfect), the Next build did not see it (no ESLint was installed), and it
 * reached the browser. The e2e suite caught it, eleven minutes and one deploy later.
 *
 * `rules-of-hooks` catches it in about a second, which is the entire argument for this file. The
 * config stays deliberately narrow: this is not a style pass, and a linter that shouts about
 * formatting is a linter people learn to run with `--quiet`. Two rules, both about correctness.
 *
 * RUN: pnpm --filter @lumenia/web lint   (also a CI gate)
 */
import reactHooks from "eslint-plugin-react-hooks";
import next from "@next/eslint-plugin-next";

export default [
  { ignores: ["**/.next/**", "**/node_modules/**", "**/*.d.ts", "public/**"] },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: (await import("@typescript-eslint/parser")).default,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" },
    },
    plugins: { "react-hooks": reactHooks, "@next/next": next },
    rules: {
      // The one that would have caught #310 before the deploy.
      "react-hooks/rules-of-hooks": "error",
      // A warning, not an error: several effects here deliberately run once and say so inline.
      "react-hooks/exhaustive-deps": "warn",
      // Next's own checks, at warning level. They are here mostly so the `eslint-disable-next-line
      // @next/next/…` comments this codebase already carries mean something — an unregistered rule
      // makes the disable comment itself the error.
      ...next.configs.recommended.rules,
      ...next.configs["core-web-vitals"].rules,
    },
  },
];
