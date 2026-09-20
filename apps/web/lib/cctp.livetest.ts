/**
 * CCTP inbound LIVE test, through the web app's own library (lib/cctp.ts) and a sponsor's
 * /cctp-relay route. Base Sepolia -> Stellar testnet; spends test USDC and test ETH only.
 *
 * The EVM side uses the throwaway Base Sepolia sender from the spike's gitignored state file
 * (apps/sponsor/.env.cctp-spike.json) through a local viem account, standing in for the injected
 * wallet the /add-money/base page uses; the burn call, the hook bytes and the relay polling are the
 * page's own code. The Stellar recipient is the spike's trustlined test account.
 *
 * RUN: SPONSOR_URL=https://lumenia-sponsor.avakit.workers.dev AMOUNT=1 pnpm --filter @lumenia/web test:cctp-live
 *      (SPONSOR_URL may be a local `wrangler dev` of the sponsor; default is the testnet sponsor.)
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { askRelay, burnToStellar, parseUsdc6 } from "./cctp";

const SPONSOR = process.env.SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";
const AMOUNT = process.env.AMOUNT ?? "1";
const STATE = new URL("../../sponsor/.env.cctp-spike.json", import.meta.url);

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const step = (m: string) => console.log(`[${at()}] ${m}`);

async function usdc(g: string): Promise<string> {
  const r = await fetch(`https://horizon-testnet.stellar.org/accounts/${g}`);
  const a = (await r.json()) as { balances: Array<{ asset_code?: string; asset_issuer?: string; balance: string }> };
  return a.balances.find((b) => b.asset_code === "USDC" && b.asset_issuer === "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5")?.balance ?? "0";
}

async function main() {
  const st = JSON.parse(readFileSync(STATE, "utf8")) as { privateKey: Hex; stellarRecipient: { publicKey: string } };
  const account = privateKeyToAccount(st.privateKey);
  const recipient = st.stellarRecipient.publicKey;
  const transport = http(process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org");
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport });
  step(`sender ${account.address} -> recipient ${recipient}, relay ${SPONSOR}/cctp-relay`);
  const before = await usdc(recipient);

  const burn = await burnToStellar({
    wallet,
    publicClient: publicClient as never,
    account: account.address,
    recipient,
    units: parseUsdc6(AMOUNT),
    onProgress: (s, h) => step(`${s}${h ? ` ${h}` : ""}`),
  });
  const burnedAt = Date.now();

  let mint = "";
  for (let i = 0; i < 200; i++) {
    const r = await askRelay(SPONSOR, burn);
    if (r.status === "minted") {
      mint = r.hash;
      break;
    }
    if (i % 5 === 0) step(`relay: ${r.detail}`);
    await new Promise((res) => setTimeout(res, 3000));
  }
  if (!mint) throw new Error("the relay never minted inside the wait");
  const secs = ((Date.now() - burnedAt) / 1000).toFixed(0);
  const after = await usdc(recipient);

  console.log("\nRESULT");
  console.log(`  burn (Base Sepolia)  ${burn}`);
  console.log(`  mint (Stellar)       ${mint}`);
  console.log(`  relayed by           ${SPONSOR}/cctp-relay`);
  console.log(`  burn to mint         ${secs} s`);
  console.log(`  recipient USDC       ${before} -> ${after}`);
  console.log("\nCCTP WEB LIVE TEST PASS");
}

main().catch((e) => {
  console.error(`\nCCTP WEB LIVE TEST FAIL at ${at()}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
