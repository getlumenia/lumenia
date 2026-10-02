/**
 * Event tool, the other half of event-links.tool.ts: take back the TESTNET practice-dollar links
 * that nobody claimed. A v2 drop never returns on its own: after its expiry the money sits in the
 * escrow until the funding key calls `reclaim(link)`, and `claim` has no expiry check, so a late
 * claim still works until we do. This walks every export under docs/event-links, asks the escrow
 * which drops are still open, and reclaims each one through the testnet sponsor's /v2-reclaim
 * (the faucet key signs as the recorded sender, the sponsor fee-bumps, the practice dollars land
 * back on the faucet account).
 *
 * Testnet only: the faucet key is the testnet-only key in docs/HANDOFF.md (zero real value) and
 * the tool refuses to run against mainnet. Prints link ids, never fragments.
 *
 * RUN (from apps/web): npx tsx lib/reclaim-seeded.tool.ts            reclaim everything open
 *                      DRY=1 npx tsx lib/reclaim-seeded.tool.ts      only report what is open
 * Writes docs/event-links/reclaim-<stamp>.json with one row per link.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { loadV2DropStatus, reclaimV2 } from "./lumendrop";
import { localSignerFromSeed } from "./signer";
import { activeNetwork } from "./network";

const SPONSOR = (process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev").replace(/\/$/, "");
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIR = `${ROOT}docs/event-links`;
const FAUCET_PUB = "GDES54WTI6UAVS6HQGRAFQTJ3KGC6YNO7HYO7ZZEYD6ANBPKPKA67H4L";
// The testnet sponsor allows 15 requests a minute per account; a reclaim is one request plus reads.
const PACE_MS = Number(process.env.PACE_MS ?? "5000");
const DRY = process.env.DRY === "1";

interface ExportedLink {
  n: number;
  link: string;
  linkHex: string;
  hash: string;
}
interface Row {
  file: string;
  n: number;
  linkHex: string;
  before: "pending" | "settled" | "unknown";
  action: "reclaimed" | "skipped" | "failed" | "dry-run";
  hash?: string;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (activeNetwork().isMainnet) throw new Error("testnet only");
  const handoff = readFileSync(`${ROOT}docs/HANDOFF.md`, "utf8");
  const m = handoff.match(/^FAUCET_SECRET=(S[A-Z2-7]{55})$/m);
  if (!m) throw new Error("faucet secret not found");
  const kp = Keypair.fromSecret(m[1]!);
  if (kp.publicKey() !== FAUCET_PUB) throw new Error("unexpected key");
  const signer = localSignerFromSeed(kp.rawSecretKey());

  const files = readdirSync(DIR)
    .filter((f) => /^testnet-.*\.json$/.test(f))
    .sort();
  const rows: Row[] = [];
  let open = 0;
  for (const file of files) {
    const doc = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")) as { network: string; links: ExportedLink[] };
    if (doc.network !== "testnet") throw new Error(`${file} is not a testnet export`);
    for (const l of doc.links) {
      const before = await loadV2DropStatus(l.linkHex, FAUCET_PUB);
      const row: Row = { file, n: l.n, linkHex: l.linkHex, before, action: "skipped" };
      if (before === "pending") open++;
      if (before !== "pending") {
        console.log(`${file} #${l.n} ${l.linkHex.slice(0, 8)} ${before} -> skip`);
      } else if (DRY) {
        row.action = "dry-run";
        console.log(`${file} #${l.n} ${l.linkHex.slice(0, 8)} pending -> would reclaim`);
      } else {
        try {
          const { hash } = await reclaimV2({ signer, linkHex: l.linkHex, sponsorUrl: SPONSOR, group: false });
          row.action = "reclaimed";
          row.hash = hash;
          console.log(`${file} #${l.n} ${l.linkHex.slice(0, 8)} pending -> reclaimed ${hash.slice(0, 8)}`);
        } catch (e) {
          row.action = "failed";
          row.error = (e as Error).message.slice(0, 160);
          console.log(`${file} #${l.n} ${l.linkHex.slice(0, 8)} pending -> FAILED ${row.error}`);
        }
        await sleep(PACE_MS);
      }
      rows.push(row);
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const out = `${DIR}/reclaim-${stamp}.json`;
  writeFileSync(out, JSON.stringify({ network: "testnet", sponsor: SPONSOR, dry: DRY, at: new Date().toISOString(), rows }, null, 2));
  const count = (a: Row["action"]) => rows.filter((r) => r.action === a).length;
  console.log(
    `\n${rows.length} links read, ${open} were open: reclaimed ${count("reclaimed")}, failed ${count("failed")}, ` +
      `dry-run ${count("dry-run")}, skipped ${count("skipped")} (already claimed or reclaimed)`,
  );
  console.log(`report: ${out}`);
  if (count("failed") > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`reclaim tool error: ${(e as Error).message}`);
  process.exit(1);
});
