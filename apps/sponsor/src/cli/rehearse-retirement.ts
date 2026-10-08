/**
 * rehearse-retirement: the dress rehearsal of the waitlist retirement switch (SOW 2, D3 T-D3-08),
 * on the TESTNET Worker, one phase per deploy, every step stamped and kept.
 *
 * The switch is PILOT_MODE. With it set, only hand-approved wallets may move value IN (/send-link,
 * /v2-deposit); with it unset the allowlist is gone and every wallet may, while every cap, the
 * onboarding budget, the fee budget, the rate limits and the halt switch stay exactly as they were
 * (none of them reads PILOT_MODE). This script proves each half against a deployed Worker:
 *
 *   --phase gated     the Worker runs WITH PILOT_MODE=1 (where testnet never had it). Two throwaway
 *                     wallets are made and funded with test USDC: one is never approved, the other is
 *                     the one the owner approves next. Proves /pilot-status says not approved and a real
 *                     deposit from either is refused 403 by the allowlist.
 *   --phase approved  after `pilot approve <W1>` (the command is printed): W1 reads approved and its
 *                     deposit lands; W2 is still refused.
 *   --phase open      the Worker redeployed WITHOUT PILOT_MODE: /pilot-status answers "open" for both,
 *                     both deposits land, and a deposit under the minimum is still refused by the caps.
 *   --phase halted    the Worker redeployed with SPONSOR_HALT=1: every value route and both grant routes
 *                     answer 503, the read routes still answer.
 *   --phase resumed   redeployed without SPONSOR_HALT: the value routes answer again.
 *   --phase reclaim   any time after resumed (the deposits expire two minutes after they are made):
 *                     every rehearsal deposit that may have landed is taken back to the wallet that
 *                     made it, through /v2-reclaim, so the rehearsal leaves no test USDC in the escrow.
 *                     A take-back answered 202 is retried by the next run until the escrow confirms it.
 *
 * Keys go to <out>/rehearsal-keys.json BEFORE anything is funded, and every deposit's link key is
 * added to it BEFORE the deposit is posted. The file holds seeds with test funds, so <out> must be a
 * folder git ignores (the script checks with `git check-ignore`). The default <out> is
 * apps/sponsor/adversarial-out/rehearsal, found from this file rather than from the folder pnpm runs
 * the script in. The log accumulates in <out>/rehearsal-log.json and is rewritten as
 * <out>/rehearsal-log.md after every phase, including one that stops early; that is what the ops note
 * quotes. Testnet only: it refuses a mainnet target.
 *
 * RUN (from the repo root; the deploy commands are in evidence/SOW2_OPS_NOTE.md):
 *   pnpm --filter @lumenia/sponsor rehearse -- --target https://lumenia-sponsor.avakit.workers.dev --phase gated
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, Address, Contract, Horizon, Keypair, Networks, TransactionBuilder, nativeToScVal, rpc, xdr, type Transaction } from "@stellar/stellar-sdk";
import { defaultHorizon, defaultSorobanRpc } from "../lib/config.js";

const PHASES = ["gated", "approved", "open", "halted", "resumed", "reclaim"] as const;
type Phase = (typeof PHASES)[number];
const USAGE = `usage: rehearse --target <testnet worker url> --phase ${PHASES.join("|")} [--out <dir>] [--source-ip <ip>] [--adopt]`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  // A flag with its value left out must not borrow the next flag as its value.
  if (value === undefined || value.startsWith("--")) {
    console.error(`rehearse: --${name} needs a value\n${USAGE}`);
    process.exit(1);
  }
  return value;
}

/** This file's folder, and the default <out> found from it: under `pnpm --filter` the cwd is
 *  apps/sponsor, so the old cwd-relative default landed in apps/sponsor/apps/sponsor/adversarial-out,
 *  which no ignore rule covered, with two funded seeds in it. */
const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_OUT = fileURLToPath(new URL("../../adversarial-out/rehearsal/", import.meta.url));

if (process.argv.includes("--help")) {
  console.log(`${USAGE}\n  --out defaults to ${DEFAULT_OUT}; a relative path is taken from the folder the command was typed in, and it must be a folder git ignores`);
  process.exit(0);
}
const TARGET = (arg("target") ?? "").replace(/\/$/, "");
const PHASE = arg("phase") as Phase;
/** pnpm keeps the folder the command was typed in as INIT_CWD, so a relative --out means the same from the repo root or from apps/sponsor. */
const OUT = resolve(process.env.INIT_CWD ?? process.cwd(), arg("out") ?? DEFAULT_OUT);
const SOURCE_IP = arg("source-ip");

if (!TARGET || !PHASES.includes(PHASE)) {
  console.log(USAGE);
  process.exit(1);
}

const HORIZON = new Horizon.Server(defaultHorizon("testnet"));
const RPC = new rpc.Server(defaultSorobanRpc("testnet"));
const PASSPHRASE = Networks.TESTNET;
/** A deposit's escrow expiry: short, so the reclaim phase can take it back in the same session. */
const DEPOSIT_EXPIRY_S = 120;
/** ...and the deposit transaction's own validity, shorter still: by the time a reclaim runs, a
 *  deposit that answered 202 has either landed or can never land. */
const DEPOSIT_TIMEOUT_S = 60;

interface Step {
  at: string;
  phase: Phase;
  step: string;
  expected: string;
  got: string;
  ok: boolean;
}
interface Log {
  target: string;
  steps: Step[];
}

/** One rehearsal deposit: its link key is written here before the deposit is posted. */
interface LinkRecord {
  phase: Phase;
  wallet: "w1" | "w2";
  linkPublic: string;
  linkSecret: string;
  linkHex: string;
  contract: string;
  amountStroops: string;
  expiry: number;
  status: "posting" | "not sent" | "landed" | "unconfirmed" | "refused" | "unknown";
  hash: string | null;
  reclaim?: string;
}
interface KeyFile {
  /** The Worker these keys rehearse against: a folder holds ONE rehearsal, never a mix of targets. */
  target?: string;
  w1: string;
  w2: string;
  w1Public: string;
  w2Public: string;
  links?: LinkRecord[];
}

const keysPath = resolve(OUT, "rehearsal-keys.json");
const logPath = resolve(OUT, "rehearsal-log.json");

/** Refuse a key file git would track: the seeds hold test funds, and this repository is public. */
try {
  execFileSync("git", ["check-ignore", "-q", keysPath], { cwd: SCRIPT_DIR, stdio: "ignore" });
} catch {
  console.error(`rehearse: refusing to write keys to ${keysPath}: git does not ignore it (use a folder .gitignore covers, such as apps/sponsor/adversarial-out/)`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
/* One folder, one rehearsal, checked before the log is even read: a folder left by a run against
   ANOTHER Worker (a local dry run, say) would reuse its wallets, approval and deposits, and a refused
   run would append its FAIL row to that rehearsal's log. A keys file from an older version of this
   tool records no target; `--adopt` continues it against this --target. */
const ADOPT = process.argv.includes("--adopt");
for (const [path, what] of [[keysPath, "keys file"], [logPath, "log"]] as const) {
  if (!existsSync(path)) continue;
  const recorded = (JSON.parse(readFileSync(path, "utf8")) as { target?: string }).target;
  if (recorded === TARGET || (recorded === undefined && ADOPT)) continue;
  console.error(
    `rehearse: the ${what} in ${OUT} belongs to a rehearsal against ${recorded ?? "an unrecorded target (pass --adopt to continue it here)"}, ` +
      `not ${TARGET}: start this one in an empty folder (--out <new folder git ignores>) or move that folder away first`,
  );
  process.exit(1);
}
const log: Log = existsSync(logPath) ? (JSON.parse(readFileSync(logPath, "utf8")) as Log) : { target: TARGET, steps: [] };
log.target = TARGET;

function record(step: string, expected: string, got: string, ok: boolean): void {
  const s: Step = { at: new Date().toISOString(), phase: PHASE, step, expected, got, ok };
  log.steps.push(s);
  console.log(`${s.at}  ${ok ? "ok  " : "FAIL"}  [${PHASE}] ${step} -> ${got}`);
}

interface Reply {
  status: number;
  text: string;
  json: Record<string, unknown> | null;
}

async function call(path: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${TARGET}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(SOURCE_IP ? { "cf-connecting-ip": SOURCE_IP } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}
const short = (r: { status: number; text: string }) => `${r.status} ${r.text.replace(/\s+/g, " ").slice(0, 120)}`;
const hashOf = (r: Reply) => (typeof r.json?.hash === "string" ? r.json.hash : null);

/** The two throwaway wallets, created once and reused by every phase, and every deposit's link. */
let keyFile: KeyFile | null = null;
function loadKeys(): { w1: Keypair; w2: Keypair } | null {
  if (!existsSync(keysPath)) return null;
  keyFile = JSON.parse(readFileSync(keysPath, "utf8")) as KeyFile;
  if (keyFile.target === undefined && ADOPT) {
    keyFile.target = TARGET;
    saveKeys();
  }
  /* One folder, one rehearsal. A folder left by an earlier run against ANOTHER Worker (a local dry
     run, say) would have this run reuse its wallets, its approval and its deposit records, and the
     log would mix two rehearsals under one heading. */
  if (keyFile.target !== TARGET) {
    throw new Error(
      `${keysPath} belongs to a rehearsal against ${keyFile.target ?? "an unrecorded target"}, not ${TARGET}: ` +
        `start this one in an empty folder (--out <new folder git ignores>) or move that folder away first`,
    );
  }
  keyFile.links ??= [];
  return { w1: Keypair.fromSecret(keyFile.w1), w2: Keypair.fromSecret(keyFile.w2) };
}
function saveKeys(): void {
  writeFileSync(keysPath, `${JSON.stringify(keyFile, null, 2)}\n`, { mode: 0o600 });
}

async function onboard(kp: Keypair): Promise<boolean> {
  const created = await call("/create-account", { recipientPublicKey: kp.publicKey() });
  if (created.status !== 200 || !created.json?.xdr) return false;
  const sandwich = TransactionBuilder.fromXDR(String(created.json.xdr), PASSPHRASE) as Transaction;
  sandwich.sign(kp);
  try {
    await HORIZON.submitTransaction(sandwich);
  } catch {
    return false;
  }
  const faucet = await call("/faucet", { recipientPublicKey: kp.publicKey() });
  return faucet.status === 200 || faucet.status === 202;
}

/**
 * Wait until a wallet's sequence reaches `atLeast` (the transaction it just sent has landed), or give
 * up after about 30 s: the next transaction from it is built on a fresh load, and a load that still
 * shows the old sequence would build one the network refuses.
 */
async function awaitSequence(account: string, atLeast: bigint): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      if (BigInt((await HORIZON.loadAccount(account)).sequenceNumber()) >= atLeast) return;
    } catch {
      /* Horizon blinked; ask again */
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
}

type Outcome = { reply: Reply; link: LinkRecord } | { local: string; link: LinkRecord };

/**
 * A real deposit of `amount` stroops of test USDC from a wallet, simulated and assembled like the web
 * does. Its link is recorded in the key file BEFORE it is posted, and its outcome after, so a deposit
 * that lands can always be taken back (the reclaim phase) and one that answered 202 is not forgotten.
 */
async function deposit(wallet: "w1" | "w2", kp: Keypair, contract: string, amount: bigint): Promise<Outcome> {
  const acct = await HORIZON.loadAccount(kp.publicKey());
  const link = Keypair.random();
  const expiry = Math.floor(Date.now() / 1000) + DEPOSIT_EXPIRY_S;
  const rec: LinkRecord = {
    phase: PHASE,
    wallet,
    linkPublic: link.publicKey(),
    linkSecret: link.secret(),
    linkHex: Buffer.from(link.rawPublicKey()).toString("hex"),
    contract,
    amountStroops: amount.toString(),
    expiry,
    status: "posting",
    hash: null,
  };
  keyFile!.links!.push(rec);
  saveKeys(); // BEFORE the deposit is posted
  const tx = new TransactionBuilder(new Account(kp.publicKey(), acct.sequenceNumber()), { fee: "2000000", networkPassphrase: PASSPHRASE })
    .addOperation(
      new Contract(contract).call(
        "deposit",
        Address.fromString(kp.publicKey()).toScVal(),
        xdr.ScVal.scvBytes(Buffer.from(link.rawPublicKey())),
        nativeToScVal(amount, { type: "i128" }),
        nativeToScVal(BigInt(expiry), { type: "u64" }),
      ),
    )
    .setTimeout(DEPOSIT_TIMEOUT_S)
    .build();
  const sim = await RPC.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    rec.status = "not sent";
    saveKeys();
    return { local: `local simulation failed: ${sim.error.slice(0, 100)}`, link: rec };
  }
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  let reply: Reply;
  try {
    reply = await call("/v2-deposit", { xdr: prepared.toXDR(), senderPublicKey: kp.publicKey() });
  } catch (e) {
    rec.status = "unknown";
    saveKeys();
    return { local: `no answer: ${(e as Error).message}`, link: rec };
  }
  rec.hash = hashOf(reply);
  rec.status = reply.status === 200 && rec.hash ? "landed" : reply.status === 202 ? "unconfirmed" : [400, 403, 429, 503].includes(reply.status) ? "refused" : "unknown";
  saveKeys();
  if (rec.status === "landed" || rec.status === "unconfirmed") await awaitSequence(kp.publicKey(), BigInt(acct.sequenceNumber()) + 1n);
  return { reply, link: rec };
}
const landed = (d: Outcome) => "reply" in d && (d.reply.status === 200 || d.reply.status === 202) && hashOf(d.reply) !== null;
const refusedWith = (d: Outcome, status: number) => "reply" in d && d.reply.status === status;
const shown = (d: Outcome) => `${"local" in d ? d.local : short(d.reply)} (link ${d.link.linkPublic})`;

/** The escrow's NothingHere (contracts/lumen-drop, `Error::NothingHere = 2`): no drop under the link. */
const NOTHING_HERE = /Error\(Contract, #2\)/;
/** The escrow's AlreadyClaimed (`Error::AlreadyClaimed = 3`): the drop landed and is claimed or taken back. */
const ALREADY_CLAIMED = /Error\(Contract, #3\)/;

/** Take one recorded deposit back to its wallet: reclaim(link), simulated, assembled, relayed. */
async function reclaim(kp: Keypair, l: LinkRecord): Promise<{ reply: Reply } | { local: string }> {
  const acct = await HORIZON.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(new Account(kp.publicKey(), acct.sequenceNumber()), { fee: "2000000", networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(l.contract).call("reclaim", xdr.ScVal.scvBytes(Buffer.from(l.linkHex, "hex"))))
    .setTimeout(300)
    .build();
  const sim = await RPC.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return { local: sim.error.slice(0, 120) };
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  const reply = await call("/v2-reclaim", { xdr: prepared.toXDR(), senderPublicKey: kp.publicKey() });
  if ((reply.status === 200 || reply.status === 202) && hashOf(reply)) await awaitSequence(kp.publicKey(), BigInt(acct.sequenceNumber()) + 1n);
  return { reply };
}

function writeLog(): void {
  writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
  const cell = (t: string) => t.replace(/\|/g, "\\|");
  const links = keyFile?.links ?? [];
  const md = [
    `# Retirement switch rehearsal: ${log.target}`,
    "",
    "| time (UTC) | phase | step | expected | got | result |",
    "|---|---|---|---|---|---|",
    ...log.steps.map((s) => `| ${s.at} | ${s.phase} | ${cell(s.step)} | ${cell(s.expected)} | ${cell(s.got).slice(0, 160)} | ${s.ok ? "PASS" : "FAIL"} |`),
    "",
    ...(links.length > 0
      ? [
          "Every deposit the rehearsal posted (public parts only; the link keys are in rehearsal-keys.json):",
          "",
          "| phase | wallet | link (public) | amount (stroops) | expiry (UTC) | outcome | deposit tx | taken back |",
          "|---|---|---|---|---|---|---|---|",
          ...links.map((l) => `| ${l.phase} | ${l.wallet.toUpperCase()} | ${l.linkPublic} | ${l.amountStroops} | ${new Date(l.expiry * 1000).toISOString()} | ${l.status} | ${l.hash ?? ""} | ${cell(l.reclaim ?? (l.status === "refused" || l.status === "not sent" ? "nothing to take back" : "not yet: run --phase reclaim"))} |`),
          "",
        ]
      : []),
  ].join("\n");
  writeFileSync(resolve(OUT, "rehearsal-log.md"), md);
}

async function main(): Promise<void> {
  const h = await call("/health");
  const health = (h.json ?? {}) as { network?: string; pilotMode?: boolean; contract?: string; halt?: { halted?: boolean; source?: string | null } };
  if (health.network !== "testnet") throw new Error(`the target says it is ${String(health.network)}; this rehearsal is testnet-only`);
  if (!health.contract) throw new Error("/health carries no contract id: deploy the D3 Worker first");
  const contract = health.contract;

  let keys = loadKeys();
  if (!keys) {
    if (PHASE !== "gated") throw new Error(`no ${keysPath}: run --phase gated first`);
    keys = { w1: Keypair.random(), w2: Keypair.random() };
    keyFile = { target: TARGET, w1: keys.w1.secret(), w2: keys.w2.secret(), w1Public: keys.w1.publicKey(), w2Public: keys.w2.publicKey(), links: [] };
    saveKeys();
    console.log(`keys written to ${keysPath} before funding: W1 ${keys.w1.publicKey()} (to approve), W2 ${keys.w2.publicKey()} (never approved)`);
  }
  const { w1, w2 } = keys;
  const status = async (kp: Keypair) => (await call(`/pilot-status?pubkey=${kp.publicKey()}`)).json ?? {};

  if (PHASE === "gated") {
    record("/health shows the switch ON", "pilotMode: true", `pilotMode: ${String(health.pilotMode)}`, health.pilotMode === true);
    // Onboarding is open by design (a recipient is never a pilot user), so both wallets get accounts.
    const funded1 = await onboard(w1);
    const funded2 = await onboard(w2);
    record("two throwaway wallets onboarded and given test USDC (onboarding is never gated)", "both funded", `W1 ${funded1}, W2 ${funded2}`, funded1 && funded2);
    const s2 = await status(w2);
    record("/pilot-status for the never-approved wallet W2", "pilot:true, approved:false", JSON.stringify(s2), s2.pilot === true && s2.approved !== true);
    const d2 = await deposit("w2", w2, contract, 500_000n);
    record("a real 0.05 USDC deposit from W2", "403, not on the allowlist", shown(d2), refusedWith(d2, 403));
    const d1 = await deposit("w1", w1, contract, 500_000n);
    record("a real 0.05 USDC deposit from W1 before its approval", "403, not on the allowlist", shown(d1), refusedWith(d1, 403));
    console.log(`\nNEXT (owner): approve W1 in the TESTNET namespace, then run --phase approved:\n  STELLAR_NETWORK=testnet KV_REST_API_URL=... KV_REST_API_TOKEN=... pnpm --filter @lumenia/sponsor pilot approve ${w1.publicKey()}`);
  }

  if (PHASE === "approved") {
    record("/health still shows the switch ON", "pilotMode: true", `pilotMode: ${String(health.pilotMode)}`, health.pilotMode === true);
    const s1 = await status(w1);
    record("/pilot-status for W1 after `pilot approve`", "pilot:true, approved:true", JSON.stringify(s1), s1.pilot === true && s1.approved === true);
    const d1 = await deposit("w1", w1, contract, 500_000n);
    record("a real 0.05 USDC deposit from the approved W1", "200 (or 202) with a hash", shown(d1), landed(d1));
    const d2 = await deposit("w2", w2, contract, 500_000n);
    record("the same from the never-approved W2", "still 403", shown(d2), refusedWith(d2, 403));
  }

  if (PHASE === "open") {
    record("/health shows the switch OFF", "pilotMode: false", `pilotMode: ${String(health.pilotMode)}`, health.pilotMode === false);
    const s2 = await status(w2);
    record("/pilot-status for the never-approved W2", "pilot:false, approved:true, state:open", JSON.stringify(s2), s2.pilot === false && s2.approved === true && s2.state === "open");
    const d1 = await deposit("w1", w1, contract, 500_000n);
    record("a real 0.05 USDC deposit from W1", "200 (or 202)", shown(d1), landed(d1));
    const d2 = await deposit("w2", w2, contract, 500_000n);
    record("a real 0.05 USDC deposit from W2, never approved", "200 (or 202): the allowlist is gone", shown(d2), landed(d2));
    const dust = await deposit("w2", w2, contract, 50_000n);
    record("a 0.005 USDC deposit from W2 (under MIN_DROP_USDC)", "400, the caps still refuse it", shown(dust), "reply" in dust && dust.reply.status === 400 && /below the minimum/.test(dust.reply.text));
  }

  if (PHASE === "halted" || PHASE === "resumed") {
    const value = ["/create-account", "/feebump", "/send-link", "/payout", "/sweep", "/v2-claim", "/v2-deposit", "/v2-reclaim", "/faucet", "/demo-link", "/cctp-relay"];
    const grant = ["/pilot-approve?pubkey=x&token=y&exp=1", "/pilot-reject?pubkey=x&token=y&exp=1"];
    const answers: string[] = [];
    let all503 = true;
    let none503 = true;
    /* The HALT's own answer, not any 503: a grant route on a Worker without PILOT_APPROVE_TOKEN
       answers 503 "not set up", which says nothing about the halt. */
    const isHaltAnswer = (r: { status: number; text: string }) => r.status === 503 && /temporarily halted|Approvals are paused/.test(r.text);
    // GETs: the halt gate is method-agnostic (worker.ts), and a GET reaches no handler when the
    // Worker is not halted, so the resumed check cannot mint a demo link (a POST {} to /demo-link did).
    let answered = 0;
    for (const p of value) {
      const r = await call(p);
      answers.push(`${p}:${r.status}`);
      if (isHaltAnswer(r)) {
        none503 = false;
        answered++;
      } else all503 = false;
    }
    for (const p of grant) {
      const r = await call(p);
      answers.push(`${p.split("?")[0]}:${r.status}`);
      if (isHaltAnswer(r)) {
        none503 = false;
        answered++;
      } else all503 = false;
    }
    // A count first, so the row survives the log's column limit; the per-route answers follow.
    const total = value.length + grant.length;
    const summary = `${answered}/${total} answered the halt (${answers.join(" ")})`;
    const read = await call(`/pilot-status?pubkey=${w2.publicKey()}`);
    if (PHASE === "halted") {
      // The environment switch, not a store key someone left set: this phase rehearses SPONSOR_HALT=1.
      record("/health shows the halt", "halt.halted: true, source env", JSON.stringify(health.halt), health.halt?.halted === true && health.halt?.source === "env");
      record("the 11 value routes and the 2 grant routes, with SPONSOR_HALT=1", "all 503 with the halt's answer", summary, all503);
      record("a read route during the halt", "/pilot-status 200", short(read), read.status === 200);
    } else {
      record("/health shows no halt", "halt.halted: false", JSON.stringify(health.halt), health.halt?.halted === false);
      record("the same 13 routes after SPONSOR_HALT is removed", "none answers the halt", summary, none503);
    }
  }

  if (PHASE === "reclaim") {
    if (health.halt?.halted === true) throw new Error("the Worker is halted, and a halt refuses /v2-reclaim too: run --phase reclaim after --phase resumed");
    const wallets = { w1, w2 };
    // A deposit that may have landed and is not back yet, including one an earlier run could NOT take back.
    const open = (keyFile!.links ?? []).filter(
      (l) =>
        (l.status === "landed" || l.status === "unconfirmed" || l.status === "unknown" || l.status === "posting") &&
        (!l.reclaim || l.reclaim.startsWith("NOT taken back") || l.reclaim.startsWith("taken back, unconfirmed")),
    );
    if (open.length === 0) record("every rehearsal deposit is back or never landed", "nothing left to take back", `${keyFile!.links!.length} deposit(s) recorded`, true);
    for (const l of open) {
      const wait = l.expiry * 1000 + 10_000 - Date.now();
      if (wait > 0) {
        console.log(`waiting ${Math.ceil(wait / 1000)} s for the ${l.phase} deposit from ${l.wallet.toUpperCase()} to expire`);
        await new Promise((r) => setTimeout(r, wait));
      }
      const label = `take back the ${l.phase} deposit from ${l.wallet.toUpperCase()} (link ${l.linkPublic})`;
      const r = await reclaim(wallets[l.wallet], l);
      if ("local" in r) {
        /* Only the escrow's own answer settles it. NothingHere (Error #2): no drop was ever stored
           under this link, so a deposit that answered 202 or nothing, its timebound long past, never
           landed. AlreadyClaimed (#3): the drop landed and was claimed or taken back already (the
           escrow keeps the entry, marked claimed), which confirms an earlier take-back that answered
           202. Anything else (an RPC hiccup, a drop not yet expired) proves nothing: the deposit
           stays in the retry set for the next --phase reclaim. */
        const gone = NOTHING_HERE.test(r.local);
        const already = ALREADY_CLAIMED.test(r.local);
        const earlier = l.reclaim?.startsWith("taken back, unconfirmed") ? l.reclaim.replace("taken back, unconfirmed", "taken back") : null;
        const fine = already || (gone && l.status !== "landed");
        l.reclaim = already
          ? (earlier ?? "nothing left to take back: the escrow says it was already claimed or taken back")
          : gone && l.status !== "landed"
            ? "nothing to take back: it never landed"
            : gone
              ? `no drop under the link although it landed: check ${l.hash ?? "its hash"} by hand`
              : `NOT taken back (${r.local.slice(0, 60)})`;
        record(label, l.status === "landed" ? "200 (or 202) with a hash, or AlreadyClaimed" : "taken back, or nothing to take back (NothingHere)", `local simulation: ${r.local}`, fine);
      } else {
        const hash = hashOf(r.reply);
        const ok = (r.reply.status === 200 || r.reply.status === 202) && hash !== null;
        if (ok) l.reclaim = `${r.reply.status === 200 ? "taken back" : "taken back, unconfirmed"}: ${hash}`;
        record(label, "200 (or 202) with a hash", short(r.reply), ok);
      }
      saveKeys();
    }
  }
}

main()
  .catch((e) => {
    record("the phase ran to its end", "no error", (e as Error).message, false);
  })
  .finally(() => {
    // Written even when the phase stopped early, so a partial phase's steps are not lost.
    writeLog();
    const fails = log.steps.filter((s) => s.phase === PHASE && !s.ok).length;
    console.log(`\nlog: ${resolve(OUT, "rehearsal-log.md")} (${fails} failing in this phase)`);
    process.exit(fails > 0 ? 1 : 0);
  });
