import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

// Playwright loads specs as CJS (web package is not "type":"module"), so use
// __dirname (import.meta is unavailable there). This file lives at
// apps/web/e2e → three levels up is the repo root.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

export interface MintedLink {
  url: string;
  amount: string;
  from: string;
  balanceId: string;
}

/**
 * Mint a fresh real testnet claim link.
 *
 * Two ways, and the default changed on 2026-09-06.
 *
 * PREFERRED: ask the sponsor's own `/demo-link` endpoint, which is what a visitor to /try gets.
 * It needs no secret at all, which is the point: this suite could never run in continuous
 * integration because it demanded an issuer key, so the only regression test on the live claim
 * path was one a person had to remember to run. It also stopped being correct when testnet moved
 * onto Circle's USDC, because the key it wanted mints an asset the app no longer accepts.
 *
 * FALLBACK: drive the `makelink` CLI, which still needs USDC_ISSUER_SECRET and only works for an
 * asset this project can issue. Kept for local runs against a self-issued asset; set
 * MINT_VIA=cli to choose it.
 *
 * Testing the path a real visitor takes is also simply a better test than testing a path only an
 * operator can take.
 */
export async function mintClaimLink(opts: {
  sponsor: string;
  web: string;
  amount?: string;
  from?: string;
}): Promise<MintedLink> {
  if (process.env.MINT_VIA === "cli") return mintViaCli(opts);
  return mintViaDemoLink(opts);
}

/** The visitor's path: the sponsor mints and hands back a claim link. No key required. */
async function mintViaDemoLink(opts: { sponsor: string; web: string }): Promise<MintedLink> {
  const res = await fetch(`${opts.sponsor.replace(/\/$/, "")}/demo-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body = (await res.json().catch(() => ({}))) as {
    balanceId?: string;
    bearerSecret?: string;
    amount?: string;
    from?: string;
    error?: string;
  };
  if (!res.ok || !body.balanceId || !body.bearerSecret) {
    throw new Error(`/demo-link did not return a claim link (HTTP ${res.status}): ${body.error ?? "no body"}`);
  }

  // Same shape the product builds: the bearer key lives in the fragment and is never sent anywhere.
  const web = opts.web.replace(/\/$/, "");
  const amount = body.amount ?? "0.5";
  const from = body.from ?? "Lumenia";
  const q = new URLSearchParams({ a: amount, s: from, b: body.balanceId });
  return {
    url: `${web}/c/${body.balanceId.slice(-8)}?${q.toString()}#${body.bearerSecret}`,
    amount,
    from,
    balanceId: body.balanceId,
  };
}

/** The operator's path: drive the makelink CLI. Needs an issuer key we control. */
async function mintViaCli(opts: {
  sponsor: string;
  web: string;
  amount?: string;
  from?: string;
}): Promise<MintedLink> {
  const amount = opts.amount ?? "20";
  const from = opts.from ?? "Alvin";
  if (!process.env.USDC_ISSUER_SECRET) {
    throw new Error("MINT_VIA=cli needs USDC_ISSUER_SECRET, and an asset this project can issue");
  }
  const { stdout } = await execFileAsync(
    "pnpm",
    [
      "--filter", "@lumenia/sponsor", "makelink", "--",
      "--sponsor", opts.sponsor,
      "--web", opts.web,
      "--amount", amount,
      "--from", from,
    ],
    { cwd: REPO_ROOT, env: process.env, timeout: 120_000, maxBuffer: 1024 * 1024 },
  );

  const url = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => /^https?:\/\/\S+#S\S+$/.test(l));
  if (!url) throw new Error(`could not parse a claim URL from makelink output:\n${stdout}`);
  // The CLI prints the id inside a parenthesised summary line, so the capture has to stop at the
  // closing paren — `\S+` swallows it and hands back an id no Horizon lookup can match.
  const balanceId = /balanceId\s+([^\s)]+)/.exec(stdout)?.[1] ?? "";
  return { url, amount, from, balanceId };
}
