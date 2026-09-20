/**
 * Event tool: mint a batch of TESTNET practice-dollar claim links from the practice faucet's own
 * key, marked `seeded=1` (team-funded, counted apart from links testers make themselves), and
 * write them with QR codes into one local HTML page the concierge shows from the laptop.
 * Testnet only; the faucet key is the testnet-only key in docs/HANDOFF.md (zero real value).
 * Output goes under docs/ (untracked, local). Bearer fragments are in the file: treat it like a
 * stack of $2 notes and delete it after the event.
 *
 * RUN (from apps/web): COUNT=50 AMOUNT=2.00 npx tsx lib/event-links.tool.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { createV2Link } from "./lumendrop";
import { localSignerFromSeed } from "./signer";
import { activeNetwork } from "./network";

const COUNT = Number(process.env.COUNT ?? "50");
const AMOUNT = process.env.AMOUNT ?? "2.00";
const SPONSOR = (process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev").replace(/\/$/, "");
const ORIGIN = process.env.LUMENIA_WEB_ORIGIN ?? "https://getlumenia.com";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

async function main() {
  if (activeNetwork().isMainnet) throw new Error("testnet only");
  const handoff = readFileSync(`${ROOT}docs/HANDOFF.md`, "utf8");
  const m = handoff.match(/^FAUCET_SECRET=(S[A-Z2-7]{55})$/m);
  if (!m) throw new Error("faucet secret not found");
  const kp = Keypair.fromSecret(m[1]!);
  if (kp.publicKey() !== "GDES54WTI6UAVS6HQGRAFQTJ3KGC6YNO7HYO7ZZEYD6ANBPKPKA67H4L") throw new Error("unexpected key");
  const signer = localSignerFromSeed(kp.rawSecretKey());
  const QRCode = require("/private/tmp/claude-501/-Users-mericcintosun-faceid-wallet/ea2a5551-e6c8-421b-8636-2080173c1d34/scratchpad/cctp/node_modules/qrcode");
  const links: { n: number; link: string; linkHex: string; hash: string }[] = [];
  const t0 = Date.now();
  for (let i = 1; i <= COUNT; i++) {
    try {
      // The public Soroban RPC throttles bursts and then misreports the sender as "Account not
      // found"; three attempts with a pause cover that without hammering it.
      let r: Awaited<ReturnType<typeof createV2Link>> | null = null;
      for (let attempt = 1; attempt <= 3 && !r; attempt++) {
        try {
          r = await createV2Link({ signer, amount: AMOUNT, from: "Lumenia team", webOrigin: ORIGIN, sponsorUrl: SPONSOR, seeded: true });
        } catch (e) {
          if (attempt === 3) throw e;
          console.log(`${i}/${COUNT} attempt ${attempt} failed (${(e as Error).message.slice(0, 60)}), retrying`);
          await new Promise((res) => setTimeout(res, 8000 * attempt));
        }
      }
      if (!r) throw new Error("no link");
      links.push({ n: i, link: r.link, linkHex: r.linkHex, hash: r.hash });
      console.log(`${i}/${COUNT} ${r.linkHex.slice(0, 8)} ${r.hash.slice(0, 8)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      // The sponsor allows 5 requests a minute per account: pace the mints so none is refused.
      await new Promise((r) => setTimeout(r, Number(process.env.PACE_MS ?? "13000")));
    } catch (e) {
      console.log(`${i}/${COUNT} FAILED: ${(e as Error).message.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  mkdirSync(`${ROOT}docs/event-links`, { recursive: true });
  writeFileSync(`${ROOT}docs/event-links/testnet-${stamp}.json`, JSON.stringify({ network: "testnet", amount: AMOUNT, from: kp.publicKey(), links }, null, 2));
  const tiles = await Promise.all(links.map(async (l) => {
    const svg = await QRCode.toString(l.link, { type: "svg", margin: 1, width: 260, errorCorrectionLevel: "M" });
    return `<section class="tile"><div class="qr">${svg}</div><div class="meta"><b>#${l.n}</b> practice $${AMOUNT} (TESTNET) <span class="id">${l.linkHex.slice(0, 8)}</span><div class="url">${l.link.replace(/#.*$/, "#...")}</div></div></section>`;
  }));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Lumenia event links (testnet)</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;margin:24px;background:#fff;color:#111}h1{font-size:20px}p{max-width:760px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px}.tile{border:1px solid #ddd;border-radius:14px;padding:14px;page-break-inside:avoid}
.qr svg{width:100%;height:auto}.meta{font-size:13px;margin-top:8px}.id{font-family:ui-monospace,monospace;color:#666}.url{font-family:ui-monospace,monospace;font-size:10px;color:#888;word-break:break-all;margin-top:4px}
@media print{.tile{border:1px solid #999}}</style></head><body>
<h1>Lumenia event links: ${links.length} x $${AMOUNT} practice dollars (TESTNET), marked seeded=1</h1>
<p>Each QR is a one-time claim link funded by the team's practice-dollar account. Show ONE tile per person; once claimed, cross it out. Practice money, test network: say so. Made ${new Date().toISOString()}.</p>
<div class="grid">${tiles.join("\n")}</div></body></html>`;
  writeFileSync(`${ROOT}docs/event-links/testnet-${stamp}.html`, html);
  console.log(`\n${links.length} links -> docs/event-links/testnet-${stamp}.html (+ .json), ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : String(e)); process.exit(1); });
