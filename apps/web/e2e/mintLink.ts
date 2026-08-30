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
 * Mint a fresh real testnet claim link by driving the existing `makelink` CLI
 * (apps/sponsor/src/cli/link.ts). Needs USDC_ISSUER_SECRET in the environment.
 * Returns the claim URL (with the #fragment bearer key) so a browser can claim it.
 */
export async function mintClaimLink(opts: {
  sponsor: string;
  web: string;
  amount?: string;
  from?: string;
}): Promise<MintedLink> {
  const amount = opts.amount ?? "20";
  const from = opts.from ?? "Alvin";
  if (!process.env.USDC_ISSUER_SECRET) {
    throw new Error("USDC_ISSUER_SECRET is required to mint a claim link (see HANDOFF §3)");
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
