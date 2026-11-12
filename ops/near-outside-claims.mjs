#!/usr/bin/env node
// Counts the people outside the team who claimed a Lumenia link on NEAR, from the chain alone.
//
//   node ops/near-outside-claims.mjs                      claims since the default start (below)
//   node ops/near-outside-claims.mjs --since 2026-11-12T02:00:00Z --exclude a.testnet,b.testnet
//
// The rule, stated so anyone can recount: every claim before --since was made by the team (the default is
// the moment invitations to people outside the team began). After it, a claim counts as outside unless the
// receiving account is on the team list below or in --exclude. Unique receiving accounts are reported next
// to the claim count, so one person claiming twice is visible. Read-only: two public RPC endpoints, no key,
// nothing installed (Node 22+).
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const SINCE = opt("--since") ?? "2026-11-12T02:00:00Z";
const sinceMs = Date.parse(SINCE);
if (!Number.isFinite(sinceMs)) {
  console.error(`--since must be an ISO time, got ${SINCE}`);
  process.exit(2);
}
const EXTRA = (opt("--exclude") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// Accounts the team created or controls. Claims into them never count, whenever they happen.
const TEAM = new Set([
  "lumenia-near.testnet",
  "lumenia-funder.testnet",
  "lumenia-demo.testnet",
  "lumenia-relayer.testnet",
  "lumenia.near",
  "lumenia-first.near",
  "0xmeric.near",
  "06627280e284f7785645741ffdcc83195f4e3809423e7081391515e26e202e6c",
  // Recipients of the team's own test claims on 2026-11-11 (scripts, the attack run, early takes).
  "2315f930bc757bd3b463ccef0a1b9a7fa403137705bd46ba3c7ddfec957e9cb7",
  "4b588298336513faadaf82dbed1874b50a43ad737c5e248665b84f6975f342eb",
  "880115ec6a9020bee95fbd63f907e2b4357ccec712b8a4ff1539c8942ebd93a1",
  "lumenia-eyyna.testnet",
  "lumi-ubqkrd.testnet",
  ...EXTRA,
]);
// The demo video's takes name their recipient ayse-xxxx.testnet.
const TEAM_PATTERNS = [/^ayse-[a-z0-9]{4}\.testnet$/];
const isTeam = (account) => TEAM.has(account) || TEAM_PATTERNS.some((re) => re.test(account));

const NETWORKS = [
  { name: "testnet", rpc: process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com", escrow: "lumenia-near.testnet", practice: "lumenia-relayer.testnet" },
  { name: "mainnet", rpc: process.env.NEAR_MAINNET_RPC_URL || "https://rpc.mainnet.fastnear.com", escrow: "lumenia.near", practice: null },
];
const PAGE = 100;
const MAX_PAGES = 50;

async function view(rpc, contract, method, argsObj) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "lumenia-outside-claims/1 (read-only)" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "count",
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(argsObj)).toString("base64") },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error).slice(0, 200));
  return JSON.parse(Buffer.from(json.result.result).toString("utf8"));
}

const nsToMs = (ns) => Number(BigInt(ns) / 1_000_000n);
const usd = (units) => `$${(Number(units) / 1e6).toFixed(2)}`;

let outsideTotal = 0;
const outsideAccounts = new Set();
console.log(`Claims into accounts outside the team since ${new Date(sinceMs).toISOString()} (team list: ${TEAM.size} accounts and the ayse-xxxx.testnet video takes)\n`);
for (const net of NETWORKS) {
  const rows = [];
  let teamAfter = 0;
  let scanned = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const drops = await view(net.rpc, net.escrow, "get_drops", { from_index: page * PAGE, limit: PAGE });
    scanned += drops.length;
    let olderThanSince = 0;
    for (const d of drops) {
      if (nsToMs(d.created_at_ns) < sinceMs) olderThanSince++;
      if (d.status !== "Claimed" || !d.claimed_to) continue;
      const claimedMs = nsToMs(d.status_changed_at_ns);
      if (claimedMs < sinceMs) continue;
      if (isTeam(d.claimed_to)) {
        teamAfter++;
        continue;
      }
      rows.push({ account: d.claimed_to, amount: d.amount, at: new Date(claimedMs).toISOString(), from: d.funder === net.practice ? "practice balance" : d.funder });
    }
    // Pages run newest first: once a whole page was created before --since, nothing older can have been claimed after it
    // by anyone but the team's own old links, which are still counted above when they were claimed late.
    if (drops.length < PAGE || olderThanSince === drops.length) break;
  }
  const unique = new Set(rows.map((r) => r.account));
  outsideTotal += rows.length;
  for (const a of unique) outsideAccounts.add(`${net.name}:${a}`);
  console.log(`${net.name} (${net.escrow}): ${rows.length} outside claim(s) by ${unique.size} account(s); ${teamAfter} team claim(s) in the same window; ${scanned} links scanned`);
  for (const r of rows) console.log(`  ${r.at}  ${r.account.length > 40 ? r.account.slice(0, 12) + "..." + r.account.slice(-6) : r.account}  ${usd(r.amount)}  from ${r.from}`);
  console.log("");
}
console.log(`TOTAL: ${outsideTotal} outside claim(s) by ${outsideAccounts.size} account(s).`);
