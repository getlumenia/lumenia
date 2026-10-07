/**
 * Claim-preview self-test (D2 private links): what a v2 claim page's metadata and its card image may
 * say. Offline, no keys: the ledger readers are injected, so every branch (an amount, an empty
 * escrow, an unreachable one, a slow one, a network this deployment cannot serve) is held without
 * an RPC.
 *
 *   [a] private: every link without `preview=rich` gets privateClaimMetadata() exactly, whatever its
 *       query says, and the ledger is not even asked.
 *   [b] rich: the name from the query, the amount from the LEDGER (never `a=`), "sent you money" on
 *       every answer that is not an amount, a fixed description, the card URL, noindex.
 *   [c] the OG route's decision: paint only `preview=rich` with a 64-hex `l`; everything else static.
 *   [d] the OG card's words.
 *
 * RUN: pnpm --filter @lumenia/web exec tsx lib/claim-metadata.selftest.ts
 */
import {
  LEDGER_READ_TIMEOUT_MS,
  RICH_PREVIEW_DESCRIPTION,
  ogDecision,
  richCard,
  v2ClaimMetadata,
  type LedgerDeps,
} from "./claim-metadata";
import { privateClaimMetadata } from "./link-preview";
import { testnetConfig, type NetworkConfig } from "./network";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  cond ? passed++ : failed++;
}

const HEX = "ab".repeat(32);
const NET = testnetConfig();
const MAINNET = { ...NET, id: "public", isMainnet: true } as NetworkConfig;

/** Fake readers that record what they were asked. */
function fake(over: Partial<LedgerDeps> = {}) {
  const calls: { fn: string; linkHex?: string; net?: string; param?: string | null }[] = [];
  const deps: LedgerDeps = {
    loadDrop: async (linkHex, { net }) => {
      calls.push({ fn: "loadDrop", linkHex, net: net.id });
      return { amount: "0.2000000" };
    },
    loadPool: async (linkHex, { net }) => {
      calls.push({ fn: "loadPool", linkHex, net: net.id });
      return { perShare: "5.0000000" };
    },
    resolveNetwork: (param) => {
      calls.push({ fn: "resolveNetwork", param });
      return param === "public" ? MAINNET : NET;
    },
    timeoutMs: 200,
    ...over,
  };
  return { deps, calls };
}

const text = (v: unknown): string => JSON.stringify(v);
const titleOf = (m: Awaited<ReturnType<typeof v2ClaimMetadata>>): string =>
  typeof m.title === "object" && m.title && "absolute" in m.title ? String(m.title.absolute) : String(m.title);
const imageUrl = (m: Awaited<ReturnType<typeof v2ClaimMetadata>>): string => {
  const imgs = m.openGraph?.images;
  const first = Array.isArray(imgs) ? imgs[0] : imgs;
  return typeof first === "object" && first && "url" in first ? String(first.url) : String(first);
};

async function main() {
  console.log("\n[a] private: the query cannot reach the card");
  const privateRef = text(privateClaimMetadata());
  for (const [label, sp] of [
    ["no query", {}],
    ["legacy ?a=999&s=Mallory", { a: "999", s: "Mallory" }],
    ["?s=Mallory&p=1 on a private link", { s: "Mallory", p: "1" }],
    ["?preview=other&a=999&s=Mallory", { preview: "other", a: "999", s: "Mallory" }],
    ["?g=3&n=public", { g: "3", n: "public" }],
    ["repeated preview (the first, not rich, wins)", { preview: ["x", "rich"], a: "999" }],
  ] as [string, Record<string, string | string[]>][]) {
    const { deps, calls } = fake();
    const m = await v2ClaimMetadata(HEX, sp, deps);
    ok(`${label}: exactly privateClaimMetadata()`, text(m) === privateRef);
    ok(`${label}: no ledger read, no network resolved`, calls.length === 0, `${calls.length} calls`);
    ok(`${label}: no "Mallory", no "999", no "$"+digit`, !/Mallory|999|\$\d/.test(text(m)));
  }
  ok("each call returns a fresh object (a caller cannot change the next card)", privateClaimMetadata() !== privateClaimMetadata());

  console.log("\n[b] rich: the ledger's amount, never the URL's");
  {
    const { deps, calls } = fake();
    const m = await v2ClaimMetadata(HEX, { a: "999", s: "Ayse", preview: "rich" }, deps);
    ok('title "Ayse sent you $0.20" (the ledger, not a=999)', titleOf(m) === "Ayse sent you $0.20", titleOf(m));
    ok("og:title and twitter:title match", m.openGraph?.title === "Ayse sent you $0.20" && m.twitter?.title === "Ayse sent you $0.20");
    ok("fixed description everywhere", m.description === RICH_PREVIEW_DESCRIPTION && m.openGraph?.description === RICH_PREVIEW_DESCRIPTION && m.twitter?.description === RICH_PREVIEW_DESCRIPTION);
    ok("summary_large_image", (m.twitter as { card?: string })?.card === "summary_large_image");
    ok("noindex, nofollow", text(m.robots) === text({ index: false, follow: false }));
    ok("og:image is the rich card URL", imageUrl(m) === `/c/x/og?preview=rich&l=${HEX}&s=Ayse`, imageUrl(m));
    ok("999 appears nowhere", !text(m).includes("999"));
    ok("one-to-one: loadDrop on testnet, never loadPool", calls.filter((c) => c.fn === "loadDrop" && c.net === "testnet" && c.linkHex === HEX).length === 1 && !calls.some((c) => c.fn === "loadPool"));
  }
  {
    const { deps, calls } = fake();
    const m = await v2ClaimMetadata(HEX, { a: "1", s: "Ayse", g: "3", preview: "rich" }, deps);
    ok("pot (g=3): loadPool, the per-share figure", titleOf(m) === "Ayse sent you $5.00" && calls.some((c) => c.fn === "loadPool") && !calls.some((c) => c.fn === "loadDrop"), titleOf(m));
    ok("pot: the card URL carries g", imageUrl(m) === `/c/x/og?preview=rich&l=${HEX}&s=Ayse&g=3`, imageUrl(m));
  }
  {
    const { deps, calls } = fake();
    const m = await v2ClaimMetadata(HEX, { a: "1", s: "Ayse", g: "99", preview: "rich" }, deps);
    ok("an out-of-bounds g is ignored: a one-to-one read, no g on the card", calls.some((c) => c.fn === "loadDrop") && !imageUrl(m).includes("g="));
  }
  {
    const { deps, calls } = fake();
    const m = await v2ClaimMetadata(HEX, { a: "1", s: "Ayse", n: "public", preview: "rich" }, deps);
    ok("n=public: the mainnet network is asked for and read", calls.some((c) => c.fn === "resolveNetwork" && c.param === "public") && calls.some((c) => c.fn === "loadDrop" && c.net === "public"));
    ok("n=public: the card URL carries it", imageUrl(m) === `/c/x/og?preview=rich&l=${HEX}&s=Ayse&n=public`, imageUrl(m));
  }
  {
    const { deps } = fake();
    const m = await v2ClaimMetadata(HEX, { a: "1", preview: "rich" }, deps);
    ok('no s: "Someone"', titleOf(m) === "Someone sent you $0.20" && imageUrl(m).includes("s=Someone"));
  }
  {
    const { deps } = fake();
    const m = await v2ClaimMetadata(HEX, { a: "1", s: "Ay&p=1 \u202Eevil", preview: "rich" }, deps);
    ok("a hostile name is sanitised and percent-encoded on the card URL", titleOf(m) === "Ay&p=1 evil sent you $0.20" && imageUrl(m).endsWith("&s=Ay%26p%3D1%20evil"), `${titleOf(m)} | ${imageUrl(m)}`);
  }

  const degraded: [string, Partial<LedgerDeps>][] = [
    ["the escrow holds nothing (null)", { loadDrop: async () => null }],
    ["the escrow could not be asked (throw)", { loadDrop: async () => { throw new Error("rpc down"); } }],
    ["the reader throws before returning a promise", { loadDrop: () => { throw new Error("sync"); } }],
    ["a mainnet link on a deployment without mainnet (resolveNetwork throws)", { resolveNetwork: () => { throw new Error("mainnet not configured"); } }],
    ["a zero amount", { loadDrop: async () => ({ amount: "0.0000000" }) }],
    ["a garbage amount", { loadDrop: async () => ({ amount: "NaN" }) }],
  ];
  for (const [label, over] of degraded) {
    const { deps } = fake(over);
    let m: Awaited<ReturnType<typeof v2ClaimMetadata>> | null = null;
    try {
      m = await v2ClaimMetadata(HEX, { a: "999", s: "Ayse", preview: "rich", n: "public" }, deps);
    } catch {
      m = null;
    }
    ok(`${label}: "Ayse sent you money", no crash, no 999`, !!m && titleOf(m) === "Ayse sent you money" && !text(m).includes("999"), m ? titleOf(m) : "threw");
  }
  {
    // Slow: the reader never answers. The page must not wait on it past the timeout.
    let settledLate = false;
    const { deps } = fake({
      timeoutMs: 80,
      loadDrop: () => new Promise((_res, rej) => setTimeout(() => { settledLate = true; rej(new Error("late")); }, 300)),
    });
    const t0 = Date.now();
    const m = await v2ClaimMetadata(HEX, { s: "Ayse", preview: "rich", a: "1" }, deps);
    const took = Date.now() - t0;
    ok('a slow ledger: "sent you money" inside the timeout', titleOf(m) === "Ayse sent you money" && took < 250, `${took} ms`);
    await new Promise((r) => setTimeout(r, 350));
    ok("  ...and its late rejection is swallowed (no unhandled rejection)", settledLate && !unhandled);
  }
  {
    const { deps, calls } = fake();
    const m = await v2ClaimMetadata("not-a-link", { s: "Ayse", preview: "rich", a: "1" }, deps);
    ok("a path that is not a 64-hex id: no read at all, \"sent you money\"", titleOf(m) === "Ayse sent you money" && !calls.some((c) => c.fn === "loadDrop" || c.fn === "loadPool"));
  }
  ok("the default timeout is ~2500 ms", LEDGER_READ_TIMEOUT_MS === 2500);

  console.log("\n[c] the OG route's decision");
  const sp = (q: string) => new URLSearchParams(q);
  ok("legacy ?a=999&s=Mallory: static", ogDecision(sp("a=999&s=Mallory")).kind === "static");
  ok("no query: static", ogDecision(sp("")).kind === "static");
  ok("preview=rich without l: static", ogDecision(sp("preview=rich&s=Mallory")).kind === "static");
  ok("preview=rich with a short l: static", ogDecision(sp(`preview=rich&l=${"ab".repeat(31)}&s=Mallory`)).kind === "static");
  ok("preview=rich with a non-hex l: static", ogDecision(sp(`preview=rich&l=${"zz".repeat(32)}&s=Mallory`)).kind === "static");
  ok("a 64-hex l without preview=rich: static", ogDecision(sp(`l=${HEX}&s=Mallory&a=999`)).kind === "static");
  const rich = ogDecision(sp(`preview=rich&l=${HEX.toUpperCase()}&s=Mallory&a=999&g=4&n=public`));
  ok(
    "preview=rich + 64-hex l: rich, the id lower-cased, the name, g and n read, a ignored",
    rich.kind === "rich" && rich.linkHex === HEX && rich.name === "Mallory" && rich.slots === 4 && rich.mainnet === true && !text(rich).includes("999"),
    text(rich),
  );
  const fromRecord = ogDecision({ preview: "rich", l: HEX });
  ok("a searchParams record works too, and no s is \"Someone\"", fromRecord.kind === "rich" && fromRecord.name === "Someone" && fromRecord.slots === null && !fromRecord.mainnet);

  console.log("\n[d] the OG card's words");
  if (rich.kind === "rich") {
    const { deps, calls } = fake();
    const card = await richCard(rich, deps);
    ok("pot on mainnet: the per-share figure from loadPool", card.usd === "$5.00" && card.group && card.name === "Mallory" && calls.some((c) => c.fn === "loadPool" && c.net === "public"), text(card));
  }
  if (fromRecord.kind === "rich") {
    const { deps } = fake();
    ok("one-to-one: the drop's figure", text(await richCard(fromRecord, deps)) === text({ name: "Someone", usd: "$0.20", group: false }));
    const { deps: down } = fake({ loadDrop: async () => { throw new Error("rpc down"); } });
    ok("unread: the name alone (usd null)", text(await richCard(fromRecord, down)) === text({ name: "Someone", usd: null, group: false }));
  }

  console.log(`\nclaim-metadata: ${passed}/${passed + failed} passed`);
  if (failed) process.exit(1);
}

let unhandled = false;
process.on("unhandledRejection", () => {
  unhandled = true;
});

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
