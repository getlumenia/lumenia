/**
 * ============================================================================
 *  FLEET RUN — a bounded, real-money coverage + concurrency run across the
 *  whole product surface, on testnet OR mainnet.
 * ============================================================================
 *
 *  WHAT IT IS. ~30 throwaway actors. Each MATRIX actor owns exactly ONE distinct
 *  product operation and asserts its outcome; a WAVE then fires many onboardings
 *  at once to stress the channel pool; a GUARD set proves the defenses still say
 *  no. Everything ends in one PASS/FAIL table with explorer links.
 *
 *  WHAT IT IS NOT. Not a load test of Horizon, not a launch, and not evidence of
 *  organic adoption: these are OUR OWN generated accounts. Counting them as
 *  "net-new funded recipients" would be exactly the sybil-gaming the project's
 *  north-star metric is written to exclude. They are proof that the CODE PATHS
 *  work with real dollars — nothing more, and that is worth a lot on its own.
 *
 *  MONEY MODEL (measured on mainnet 2026-08-24, not estimated):
 *    v2 Soroban deposit   0.0529 XLM   ← the only non-trivial fee
 *    v2 claim relay       0.0019 XLM
 *    classic tx           ~0.00002 XLM  (create-account, feebump, send-link, sweep)
 *    per live account     1.5 XLM       ← LOCKED sponsor reserve, not spent
 *                                         (1 account minimum + 0.5 trustline)
 *  The burn is tiny; the reserve is the real number, and it is a LOAN from the
 *  sponsor's float that `teardown` gives back. `plan` prints both in ₺.
 *
 *  TWO-STEP BY DESIGN, so no key of the owner's is ever pasted into a script and
 *  no money moves before the owner has seen the bill:
 *
 *    1. plan      — generates the actor keys, writes the state file, and prints
 *                   the exact cost, the preflight verdict, what to fund, and the
 *                   `pilot approve` commands. Reads the network; writes nothing to it.
 *    2. run       — executes the matrix, the wave and the guards. On mainnet it
 *                   refuses without --yes.
 *    3. report    — re-prints the last run's table from the state file.
 *    4. teardown  — sweeps + merges the actors back, returning reserve and USDC.
 *                   NOT run automatically: the owner chose to leave the accounts
 *                   alive, so this is a lever, not a step.
 *
 *  RUN:
 *    # rehearse on testnet first — free, same code path
 *    pnpm --filter @lumenia/sponsor fleet plan
 *    pnpm --filter @lumenia/sponsor fleet run
 *
 *    # then mainnet, with real money
 *    TREASURY_SECRET=S… pnpm --filter @lumenia/sponsor fleet plan --network mainnet
 *    # …fund the treasury, approve the wallets it names, then:
 *    TREASURY_SECRET=S… pnpm --filter @lumenia/sponsor fleet run --network mainnet --yes
 *
 *  NEEDS: internet. TREASURY_SECRET (an account the OWNER funds — the only key
 *  with real money in it; every other key here is generated and disposable).
 *  Optional: KV_REST_API_URL/TOKEN + STELLAR_NETWORK to let --approve write the
 *  pilot allowlist directly instead of printing the commands.
 *
 *  THE STATE FILE (~/.lumenia/fleet-<network>.json) HOLDS REAL SECRET KEYS. It sits
 *  OUTSIDE the repository on purpose — nothing about this run belongs in git, and a
 *  path git cannot reach beats a .gitignore rule someone has to remember. It is the
 *  only copy of those keys: if it is lost mid-run, the money behind those accounts is
 *  lost with it, which is why it is written before the first transaction and after
 *  every step.
 */
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Claimant,
  Contract,
  Horizon,
  Keypair,
  MuxedAccount,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/* ----------------------------------------------------------------------------
 * Networks. Both escrow ids are the CURRENT ones (apps/sponsor/wrangler.toml);
 * override with LUMENDROP_CONTRACT if a newer one is deployed.
 * -------------------------------------------------------------------------- */
interface Net {
  id: "testnet" | "mainnet";
  passphrase: string;
  horizon: string;
  rpc: string;
  sponsor: string;
  usdcIssuer: string;
  contract: string;
  explorer: "testnet" | "public";
  /** Pilot gate is only armed on the mainnet Worker. */
  pilot: boolean;
}

const NETS: Record<"testnet" | "mainnet", Net> = {
  testnet: {
    id: "testnet",
    passphrase: Networks.TESTNET,
    horizon: "https://horizon-testnet.stellar.org",
    rpc: "https://soroban-testnet.stellar.org",
    sponsor: "https://lumenia-sponsor.avakit.workers.dev",
    usdcIssuer: "GDO7HI2WKTMDLDG54XKAVE6BTJ5BYXE7PAYQNM5535J2SJNXR334ECYC",
    contract: "CDVZN53VEPNE4IFGOUBHOFDYF4N5XJXI5L7LWSN72HPB6ITJCHY4ST6S",
    explorer: "testnet",
    pilot: false,
  },
  mainnet: {
    id: "mainnet",
    passphrase: Networks.PUBLIC,
    horizon: "https://horizon.stellar.org",
    rpc: "https://mainnet.sorobanrpc.com",
    sponsor: "https://lumenia-sponsor-mainnet.avakit.workers.dev",
    usdcIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    contract: "CAC5JYQ2XEEVJ54EXC7KCG6MTARO5CSUQ2WNKSOM6FALCCU5UTEIWGR4",
    explorer: "public",
    pilot: true,
  },
};

/** Measured on mainnet, from this project's own canary transactions. */
const FEE_V2_DEPOSIT_XLM = 0.0529;
const FEE_V2_CLAIM_XLM = 0.0019;
const FEE_CLASSIC_XLM = 0.00002;
/** Account minimum (2 × 0.5 base reserve) + one trustline (0.5). Locked, not spent. */
const RESERVE_PER_ACCOUNT_XLM = 1.5;

const UNIT = 10_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------------------------
 * CLI
 * -------------------------------------------------------------------------- */
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const NET = NETS[(opt("network", "testnet") as "testnet" | "mainnet") ?? "testnet"];
if (!NET) throw new Error("--network must be testnet or mainnet");
const CONTRACT = process.env.LUMENDROP_CONTRACT ?? NET.contract;
const SPONSOR = (process.env.SPONSOR_URL ?? NET.sponsor).replace(/\/$/, "");
const WEB = (process.env.WEB_ORIGIN ?? "https://getlumenia.com").replace(/\/$/, "");
const USDC = new Asset("USDC", process.env.USDC_ISSUER ?? NET.usdcIssuer);
/** Per-drop amount. 0.01 is the sponsor's MIN_DROP_USDC floor — the cheapest honest test. */
const AMOUNT = opt("amount", "0.01");
/** How many concurrent onboardings the wave fires. */
const WAVE = Number.parseInt(opt("wave", "12"), 10);
/** Seconds to wait for the short-expiry drop to become reclaimable. */
const EXPIRY_WAIT = Number.parseInt(opt("expiry-wait", "100"), 10);

/**
 * Pull ONLY the shared-store credentials out of `.dev.vars`, so the owner can keep them in the
 * file wrangler already uses instead of pasting them into a command line (and into shell
 * history) every time.
 *
 * Deliberately an ALLOWLIST, not a blanket load. `.dev.vars` is a TESTNET file: it carries a
 * testnet `USDC_ISSUER`, and this script reads `USDC_ISSUER` from the environment. Loading the
 * whole file would therefore hand a `--network mainnet` run the testnet asset — every actor
 * would open a trustline to the wrong issuer and the treasury's real USDC would have nowhere
 * to land. Two keys, by name, and nothing else.
 */
function loadKvCredsFromDevVars(): void {
  const path = join(import.meta.dirname, "..", ".dev.vars");
  if (!existsSync(path)) return;
  const allowed = new Set([
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
  ]);
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const [, k, v] = m;
    // An explicit environment variable always wins over the file.
    if (allowed.has(k!) && !process.env[k!]) process.env[k!] = v!.replace(/^["']|["']$/g, "");
  }
}
loadKvCredsFromDevVars();

const HZ = new Horizon.Server(NET.horizon);
const RPC = new rpc.Server(NET.rpc);
/**
 * The state file lives OUTSIDE the repository, under ~/.lumenia/. It holds the generated
 * secret keys of a live run — on mainnet, keys to real money — so the safest place for it
 * is somewhere `git add -A` can never reach, rather than somewhere a .gitignore rule has to
 * keep remembering to exclude. Nothing about this run belongs in the repo.
 */
const STATE_DIR = join(homedir(), ".lumenia");
const STATE_PATH = join(STATE_DIR, `fleet-${NET.id}.json`);

/* ----------------------------------------------------------------------------
 * The actor roster. Each MATRIX entry is one distinct product operation.
 * `funds` is the USDC the treasury must put in that actor before it can act.
 * -------------------------------------------------------------------------- */
interface ActorSpec {
  id: string;
  role: string;
  /** the one operation this actor exists to prove */
  op: string;
  /** USDC the treasury pre-funds, as a decimal string ("0" = needs none) */
  funds: string;
  /** does this actor hit a pilot-gated route (/send-link or /v2-deposit)? */
  pilotGated?: boolean;
}

function roster(): ActorSpec[] {
  const a = AMOUNT;
  const three = (Number.parseFloat(a) * 3).toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
  return [
    { id: "M01", role: "classic sender", op: "/send-link — sponsored Claimable Balance bearer link (×2: one to claim, one to sweep)", funds: (Number.parseFloat(a) * 2).toFixed(7), pilotGated: true },
    { id: "M02", role: "walletless claimer", op: "/create-account + /feebump — claims M01's link holding 0 XLM, then sends it onward", funds: "0", pilotGated: true },
    { id: "M03", role: "v2 sender", op: "/v2-deposit — USDC into the Soroban escrow behind a link key", funds: a, pilotGated: true },
    { id: "M04", role: "v2 walletless claimer", op: "/create-account + /v2-claim — late-bound payout, gasless", funds: "0" },
    { id: "M05", role: "asker", op: "request-money — receives to its ADDRESS, then collects via /feebump", funds: "0" },
    { id: "M06", role: "payer", op: "/send-link to an address — pays M05's request", funds: a, pilotGated: true },
    { id: "M07", role: "group sender", op: "create_drop — one link, 3 equal shares", funds: three, pilotGated: true },
    { id: "M08", role: "share claimer 1", op: "claim_share — first of three, then re-deposits its share", funds: "0", pilotGated: true },
    { id: "M09", role: "share claimer 2", op: "claim_share — second of three", funds: "0" },
    { id: "M10", role: "share claimer 3", op: "claim_share — third, empties the pool", funds: "0" },
    { id: "M11", role: "reclaim sender", op: "/v2-deposit with a short expiry, then /v2-reclaim — money comes back", funds: a, pilotGated: true },
    { id: "M12", role: "throwaway", op: "/sweep — claim + payment + changeTrust(0) + accountMerge into M13", funds: "0" },
    { id: "M13", role: "home account", op: "sweep destination — proves consolidation, no fragmentation", funds: "0" },
    { id: "M14", role: "cash-out sender", op: "/payout — sends USDC out to an external address", funds: a },
    { id: "M15", role: "split asker", op: "split — one request, two payers, both land on one address", funds: "0" },
    { id: "M16", role: "split payer 1", op: "/send-link to M15's address", funds: a, pilotGated: true },
    { id: "M17", role: "split payer 2", op: "/send-link to M15's address", funds: a, pilotGated: true },
  ];
}

/* ----------------------------------------------------------------------------
 * State — the only copy of the generated secrets.
 * -------------------------------------------------------------------------- */
interface StepResult {
  id: string;
  op: string;
  ok: boolean;
  detail: string;
  hashes: string[];
}
interface State {
  network: "testnet" | "mainnet";
  createdAt: string;
  amount: string;
  contract: string;
  /** actor id → secret */
  actors: Record<string, string>;
  /** wave actor secrets (onboarding stress) */
  wave: string[];
  /** link/drop secrets minted during the run, so nothing is stranded */
  links: Array<{ owner: string; secret: string; kind: string; balanceId?: string; url?: string }>;
  results: StepResult[];
  teardownDone?: boolean;
}

function loadState(): State {
  if (!existsSync(STATE_PATH)) {
    throw new Error(`no state file at ${STATE_PATH} — run \`fleet plan --network ${NET.id}\` first`);
  }
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
}
function saveState(s: State): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
}

/* ----------------------------------------------------------------------------
 * Small helpers
 * -------------------------------------------------------------------------- */
async function sponsorPost(
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const res = await fetch(`${SPONSOR}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* a non-JSON body is itself the failure detail */
  }
  return { status: res.status, body: parsed, raw };
}

async function health(): Promise<Record<string, unknown>> {
  const res = await fetch(`${SPONSOR}/health`);
  if (!res.ok) throw new Error(`sponsor /health → ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

function tx(hash: string): string {
  return `https://stellar.expert/explorer/${NET.explorer}/tx/${hash}`;
}

async function usdcOf(pub: string): Promise<string> {
  try {
    const acc = await HZ.loadAccount(pub);
    const l = acc.balances.find(
      (b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === USDC.getIssuer(),
    );
    return l ? l.balance : "0";
  } catch {
    return "0";
  }
}

/**
 * Read TREASURY_SECRET with an error a human can act on.
 *
 * The raw SDK failure for a malformed key is "invalid encoded string", which names neither
 * the variable nor what is wrong with it — and the most likely cause by far is copying a
 * placeholder like `S...` or `SBFK…` straight out of an instruction, ellipsis included. That
 * deserves to be said outright rather than diagnosed.
 */
function treasuryKeypair(): Keypair {
  const raw = (process.env.TREASURY_SECRET ?? "").trim();
  if (!raw) throw new Error("TREASURY_SECRET is not set");
  if (/[…\.]{1,3}$/.test(raw) || raw.length !== 56) {
    throw new Error(
      `TREASURY_SECRET does not look like a full secret key (got ${raw.length} characters, expected 56` +
        `${/[…\.]$/.test(raw) ? "; it ends in an ellipsis, so a placeholder was pasted instead of the key" : ""}).`,
    );
  }
  try {
    return Keypair.fromSecret(raw);
  } catch {
    throw new Error("TREASURY_SECRET is not a valid Stellar secret key (it must start with S).");
  }
}

/**
 * Read a balance that a transaction we just relayed is expected to have changed.
 *
 * A plain read straight after the relay returns can catch Horizon before it has ingested the
 * ledger, and reports 0. That is a read-after-write race, not lost money — but the mainnet run
 * printed "holds 0.0000000 USDC" under a green tick for two actors that had in fact been paid,
 * which is the kind of line that sends someone hunting for a bug that isn't there. Poll briefly
 * for a non-zero balance and report what is actually on the ledger.
 */
async function settledUsdc(pub: string, tries = 6): Promise<string> {
  let last = "0";
  for (let i = 0; i < tries; i++) {
    last = await usdcOf(pub);
    if (Number.parseFloat(last) > 0) return last;
    await sleep(2000);
  }
  return last;
}

async function hasTrustline(pub: string): Promise<boolean> {
  try {
    const acc = await HZ.loadAccount(pub);
    return acc.balances.some(
      (b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === USDC.getIssuer(),
    );
  } catch {
    return false;
  }
}

/**
 * Open the treasury's own USDC trustline, paid for by the treasury's own XLM. It is the one
 * account here the sponsor does NOT onboard — it holds the owner's real money and must be a
 * plain, self-funded account, so nothing else can open the line for it.
 */
async function openTreasuryTrustline(treasury: Keypair): Promise<string | null> {
  if (await hasTrustline(treasury.publicKey())) return null;
  const acc = await freshAccount(treasury.publicKey());
  const t = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET.passphrase })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(120)
    .build();
  t.sign(treasury);
  const res = await HZ.submitTransaction(t);
  return res.hash;
}

async function xlmOf(pub: string): Promise<string> {
  const acc = await HZ.loadAccount(pub);
  const n = acc.balances.find((b) => b.asset_type === "native");
  return n ? n.balance : "0";
}

/** Horizon is authoritative for sequence; the RPC's view lags a just-submitted tx. */
async function freshAccount(pub: string, after?: string): Promise<Account> {
  for (let i = 0; i < 30; i++) {
    const acc = await HZ.loadAccount(pub);
    if (!after || acc.sequenceNumber() !== after) return new Account(pub, acc.sequenceNumber());
    await sleep(2000);
  }
  throw new Error("sequence never advanced — the network is lagging");
}

/**
 * Sponsored onboarding: the sponsor builds begin/createAccount/changeTrust/end, the
 * recipient co-signs and submits. The recipient ends up holding 0 XLM with a USDC
 * trustline whose reserve belongs to the sponsor. This is the product's front door.
 */
async function onboard(kp: Keypair): Promise<{ hash: string; via?: string }> {
  const r = await sponsorPost("/create-account", { recipientPublicKey: kp.publicKey() });
  if (r.status !== 200 || !r.body.xdr) {
    throw new Error(`/create-account → ${r.status}: ${r.raw.slice(0, 200)}`);
  }
  const sandwich = TransactionBuilder.fromXDR(r.body.xdr as string, NET.passphrase) as Transaction;
  sandwich.sign(kp);
  const res = await HZ.submitTransaction(sandwich);
  return { hash: res.hash, via: r.body.via as string | undefined };
}

/**
 * One treasury transaction funds every actor that needs USDC. Batching is not just
 * cheaper — it removes ~10 sequential submits from the critical path, each of which
 * would be one more place a mid-run failure could strand an account.
 */
async function fundActors(
  treasury: Keypair,
  targets: Array<{ pub: string; amount: string }>,
): Promise<string> {
  const src = await freshAccount(treasury.publicKey());
  const b = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: NET.passphrase });
  for (const t of targets) {
    b.addOperation(Operation.payment({ destination: t.pub, asset: USDC, amount: t.amount }));
  }
  const t = b.setTimeout(180).build();
  t.sign(treasury);
  const res = await HZ.submitTransaction(t);
  return res.hash;
}

/**
 * The classic sponsored Claimable Balance send — the exact op sequence and claimant
 * shape the sponsor's send policy pins ([begin, createCB, end]; unconditional claimant
 * + a 7-day sender reclaim). Anything else is rejected by anti-drain, by design.
 */
const RECLAIM_AFTER_SECONDS = (7 * 24 * 60 * 60).toString();

async function sendLink(
  sender: Keypair,
  claimantDestination: string,
  amount: string,
  sponsorPublicKey: string,
): Promise<{ hash: string; balanceId: string }> {
  const acc = await freshAccount(sender.publicKey());
  const claimants = [
    new Claimant(claimantDestination, Claimant.predicateUnconditional()),
    new Claimant(
      sender.publicKey(),
      Claimant.predicateNot(Claimant.predicateBeforeRelativeTime(RECLAIM_AFTER_SECONDS)),
    ),
  ];
  const inner = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET.passphrase })
    .addOperation(
      Operation.beginSponsoringFutureReserves({ sponsoredId: sender.publicKey(), source: sponsorPublicKey }),
    )
    .addOperation(
      Operation.createClaimableBalance({ asset: USDC, amount, claimants, source: sender.publicKey() }),
    )
    .addOperation(Operation.endSponsoringFutureReserves({ source: sender.publicKey() }))
    .setTimeout(180)
    .build();
  inner.sign(sender);

  const r = await sponsorPost("/send-link", { xdr: inner.toXDR(), senderPublicKey: sender.publicKey() });
  if (r.status !== 200 || !r.body.balanceId) {
    throw new Error(`/send-link → ${r.status}: ${r.raw.slice(0, 200)}`);
  }
  return { hash: r.body.hash as string, balanceId: r.body.balanceId as string };
}

/** Claim a Claimable Balance from an EXISTING account; the sponsor fee-bumps it (maxOps 1). */
async function claimCB(who: Keypair, balanceId: string): Promise<string> {
  const acc = await freshAccount(who.publicKey());
  const inner = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET.passphrase })
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .setTimeout(180)
    .build();
  inner.sign(who);
  const r = await sponsorPost("/feebump", {
    xdr: inner.toXDR(),
    recipientPublicKey: who.publicKey(),
    balanceId,
  });
  if (r.status !== 200 || !r.body.hash) throw new Error(`/feebump → ${r.status}: ${r.raw.slice(0, 200)}`);
  return r.body.hash as string;
}

/** Build + simulate + assemble a Soroban invoke, signed by `signer`, ready to relay. */
async function invoke(
  signer: Keypair,
  method: string,
  ...args: xdr.ScVal[]
): Promise<string> {
  const src = await freshAccount(signer.publicKey());
  const t = new TransactionBuilder(src, { fee: "2000000", networkPassphrase: NET.passphrase })
    .addOperation(new Contract(CONTRACT).call(method, ...args))
    .setTimeout(120)
    .build();
  const sim = await RPC.simulateTransaction(t);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method} sim: ${sim.error}`);
  const prepared = rpc.assembleTransaction(t, sim).build();
  prepared.sign(signer);
  return prepared.toXDR();
}

function stroops(amount: string): bigint {
  return BigInt(Math.round(Number.parseFloat(amount) * Number(UNIT)));
}

/** v2 deposit — sender locks USDC behind a link key; the sponsor fee-bumps (gasless). */
async function v2Deposit(
  sender: Keypair,
  link: Keypair,
  amount: string,
  expiry: bigint,
): Promise<{ hash: string; status: number }> {
  const x = await invoke(
    sender,
    "deposit",
    Address.fromString(sender.publicKey()).toScVal(),
    xdr.ScVal.scvBytes(Buffer.from(link.rawPublicKey())),
    nativeToScVal(stroops(amount), { type: "i128" }),
    nativeToScVal(expiry, { type: "u64" }),
  );
  const r = await sponsorPost("/v2-deposit", { xdr: x, senderPublicKey: sender.publicKey() });
  if (r.status !== 200 && r.status !== 202) {
    throw new Error(`/v2-deposit → ${r.status}: ${r.raw.slice(0, 200)}`);
  }
  return { hash: r.body.hash as string, status: r.status };
}

/**
 * v2 group pool — one link, `slots` equal shares.
 *
 * NOT relayed by the sponsor. `/v2-deposit` allow-lists exactly one contract method,
 * `deposit`, and answers a group drop with "only 'deposit' is relayed here, got
 * 'create_drop'" (apps/sponsor/src/lib/soroban-relay.ts). The claim and reclaim sides DO
 * allow the group methods, so a pool can be claimed and reclaimed gaslessly but cannot be
 * CREATED gaslessly — the contract feature is only half-wired to the service. Until that
 * gap closes, the pool is created by the SENDER with the treasury paying the fee through a
 * plain Stellar fee-bump, which is what a UI would have to do too.
 */
async function v2CreateDrop(
  sender: Keypair,
  treasury: Keypair,
  link: Keypair,
  amount: string,
  slots: number,
  expiry: bigint,
): Promise<string> {
  const x = await invoke(
    sender,
    "create_drop",
    Address.fromString(sender.publicKey()).toScVal(),
    xdr.ScVal.scvBytes(Buffer.from(link.rawPublicKey())),
    nativeToScVal(stroops(amount), { type: "i128" }),
    nativeToScVal(slots, { type: "u32" }),
    nativeToScVal(expiry, { type: "u64" }),
  );
  const inner = TransactionBuilder.fromXDR(x, NET.passphrase) as Transaction;
  const bump = TransactionBuilder.buildFeeBumpTransaction(treasury, "2000000", inner, NET.passphrase);
  bump.sign(treasury);
  const res = await HZ.submitTransaction(bump);
  return res.hash;
}

/**
 * Read the exact bytes the escrow will verify, sign them with the LINK key, and hand
 * the signature to the relayer. The message binds contract + network + link + payout,
 * so the relayer can pay the fee and still be unable to redirect a single stroop.
 */
async function v2Claim(
  link: Keypair,
  payoutPub: string,
  group: boolean,
): Promise<{ status: number; hash?: string; raw: string }> {
  const kind = group ? 2 : 1;
  const method = group ? "claim_share" : "claim";
  const src = await RPC.getAccount(payoutPub);
  const view = new TransactionBuilder(src, { fee: "1000000", networkPassphrase: NET.passphrase })
    .addOperation(
      new Contract(CONTRACT).call(
        "claim_message",
        nativeToScVal(kind, { type: "u32" }),
        xdr.ScVal.scvBytes(Buffer.from(link.rawPublicKey())),
        Address.fromString(payoutPub).toScVal(),
      ),
    )
    .setTimeout(60)
    .build();
  const sim = await RPC.simulateTransaction(view);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`claim_message: ${sim.error}`);
  const message = scValToNative(
    (sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval,
  ) as Uint8Array;

  const sigHex = Buffer.from(link.sign(Buffer.from(message))).toString("hex");
  const linkHex = Buffer.from(link.rawPublicKey()).toString("hex");
  const r = await sponsorPost("/v2-claim", {
    method,
    linkHex,
    payout: payoutPub,
    sigHex,
    contract: CONTRACT,
  });
  return { status: r.status, hash: r.body.hash as string | undefined, raw: r.raw };
}

/** v2 reclaim — after expiry the original sender takes the money back, gaslessly. */
async function v2Reclaim(sender: Keypair, link: Keypair): Promise<{ status: number; raw: string; hash?: string }> {
  const x = await invoke(sender, "reclaim", xdr.ScVal.scvBytes(Buffer.from(link.rawPublicKey())));
  const r = await sponsorPost("/v2-reclaim", { xdr: x, senderPublicKey: sender.publicKey() });
  return { status: r.status, raw: r.raw, hash: r.body.hash as string | undefined };
}

/**
 * Sweep — the throwaway account moves everything home and closes itself in ONE
 * sponsor-fee-bumped transaction, returning its 1.5 XLM of reserve to the sponsor.
 * With a balanceId it claims first; without, it is the plain consolidation path.
 */
async function sweep(
  throwaway: Keypair,
  homePub: string,
  amount: string,
  balanceId?: string,
): Promise<{ status: number; raw: string; hash?: string }> {
  const acc = await freshAccount(throwaway.publicKey());
  const src = throwaway.publicKey();
  const b = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET.passphrase });
  if (balanceId) b.addOperation(Operation.claimClaimableBalance({ balanceId, source: src }));
  b.addOperation(Operation.payment({ destination: homePub, asset: USDC, amount, source: src }))
    .addOperation(Operation.changeTrust({ asset: USDC, limit: "0", source: src }))
    .addOperation(Operation.accountMerge({ destination: homePub, source: src }));
  const inner = b.setTimeout(180).build();
  inner.sign(throwaway);
  const r = await sponsorPost("/sweep", {
    xdr: inner.toXDR(),
    throwawayPublicKey: src,
    homePublicKey: homePub,
    amount,
    ...(balanceId ? { balanceId } : {}),
  });
  return { status: r.status, raw: r.raw, hash: r.body.hash as string | undefined };
}

/** Payout — the user's own USDC straight out to an external address (the cash-out leg). */
async function payout(
  who: Keypair,
  destination: string,
  amount: string,
): Promise<{ status: number; raw: string; hash?: string }> {
  const acc = await freshAccount(who.publicKey());
  const inner = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET.passphrase })
    .addOperation(Operation.payment({ destination, asset: USDC, amount, source: who.publicKey() }))
    .setTimeout(180)
    .build();
  inner.sign(who);
  const r = await sponsorPost("/payout", {
    xdr: inner.toXDR(),
    senderPublicKey: who.publicKey(),
    destination,
    amount,
  });
  return { status: r.status, raw: r.raw, hash: r.body.hash as string | undefined };
}

/* ----------------------------------------------------------------------------
 * PLAN — generate keys, price the run, preflight, print what the owner must do.
 * Reads the network. Writes nothing to it.
 * -------------------------------------------------------------------------- */
async function prices(): Promise<{ xlmUsd: number; usdTry: number }> {
  let xlmUsd = 0;
  let usdTry = 0;
  try {
    const ob = (await (
      await fetch(
        `https://horizon.stellar.org/order_book?selling_asset_type=native&buying_asset_type=credit_alphanum4&buying_asset_code=USDC&buying_asset_issuer=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN&limit=1`,
      )
    ).json()) as { bids: Array<{ price: string }> };
    xlmUsd = Number.parseFloat(ob.bids[0]!.price);
  } catch {
    /* priced below as unknown rather than guessed */
  }
  try {
    const fx = (await (await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=TRY")).json()) as {
      rates: { TRY: number };
    };
    usdTry = fx.rates.TRY;
  } catch {
    /* same */
  }
  return { xlmUsd, usdTry };
}

function money(xlm: number, p: { xlmUsd: number; usdTry: number }): string {
  if (!p.xlmUsd || !p.usdTry) return `${xlm.toFixed(4)} XLM`;
  return `${xlm.toFixed(4)} XLM  ≈ $${(xlm * p.xlmUsd).toFixed(3)}  ≈ ₺${(xlm * p.xlmUsd * p.usdTry).toFixed(2)}`;
}

async function plan(): Promise<void> {
  const specs = roster();
  const p = await prices();

  console.log(`\n=== FLEET PLAN — ${NET.id.toUpperCase()} ===`);
  console.log(`  sponsor : ${SPONSOR}`);
  console.log(`  escrow  : ${CONTRACT}`);
  console.log(`  USDC    : ${USDC.getIssuer()}`);
  console.log(`  amount  : ${AMOUNT} USDC per drop`);
  if (p.xlmUsd && p.usdTry) {
    console.log(`  prices  : 1 XLM = $${p.xlmUsd.toFixed(4)} · $1 = ₺${p.usdTry.toFixed(2)}`);
  } else {
    console.log(`  prices  : UNAVAILABLE (no network to the price sources) — costs shown in XLM only`);
  }

  /* ---- the roster ---- */
  console.log(`\n--- MATRIX (${specs.length} actors, each one distinct operation) ---`);
  for (const s of specs) {
    const f = s.funds === "0" ? "" : `  [funded ${s.funds} USDC]`;
    console.log(`  ${s.id}  ${s.role.padEnd(20)} ${s.op}${f}`);
  }
  console.log(`\n--- WAVE (${WAVE} actors, fired simultaneously) ---`);
  console.log(`  W01..W${String(WAVE).padStart(2, "0")}  concurrent /create-account — asserts the channel pool`);
  console.log(`            holds: 0 tx_bad_seq, every response via:channel`);
  console.log(`\n--- GUARDS (0 accounts, 0 money — the defenses must say no) ---`);
  for (const g of GUARD_NAMES) console.log(`  ${g}`);

  /* ---- the bill ---- */
  const rounds = Number.parseInt(opt("rounds", "2"), 10);
  const v2Invokes = 5; // M03 + M07 create_drop + M11 deposit + M11 reclaim + M08 re-deposit
  const v2Claims = 5; // M04, M08/M09/M10 shares, M09 on the re-deposit
  // onboardings, sends, feebumps, sweep, payouts, treasury funding, plus the ring hops
  const classicTxs = 28 + rounds * specs.length;
  const liveAccounts = specs.length + WAVE - 1; // M12 merges itself away in the sweep
  const burn = v2Invokes * FEE_V2_DEPOSIT_XLM + v2Claims * FEE_V2_CLAIM_XLM + classicTxs * FEE_CLASSIC_XLM;
  const reserve = liveAccounts * RESERVE_PER_ACCOUNT_XLM;
  const usdcNeeded = specs.reduce((n, s) => n + Number.parseFloat(s.funds), 0);

  console.log(`\n--- THE BILL ---`);
  console.log(`  burned (fees, gone for good) : ${money(burn, p)}`);
  console.log(`  locked (sponsor reserve)     : ${money(reserve, p)}   ← ${liveAccounts} live accounts × 1.5 XLM`);
  console.log(`                                 returned by \`fleet teardown\`, not by the run`);
  const usdcTry = p.usdTry ? `  ≈ ₺${(usdcNeeded * p.usdTry).toFixed(2)}` : "";
  console.log(`  USDC moved (recoverable)     : ${usdcNeeded.toFixed(4)} USDC${usdcTry}`);

  /* ---- preflight ---- */
  console.log(`\n--- PREFLIGHT ---`);
  let blocked = false;
  const h = await health().catch((e: Error) => ({ error: e.message }) as Record<string, unknown>);
  if (h.error) {
    console.log(`  ✗ sponsor unreachable: ${h.error as string}`);
    blocked = true;
  } else {
    const netOk = (h.network as string) === NET.id;
    console.log(`  ${netOk ? "✓" : "✗"} sponsor /health → network=${h.network as string} (expected ${NET.id})`);
    if (!netOk) blocked = true;
    const sponsorPub = h.sponsorPublicKey as string;
    const float = Number.parseFloat(await xlmOf(sponsorPub).catch(() => "0"));
    const enough = float >= reserve + burn + 5;
    console.log(
      `  ${enough ? "✓" : "✗"} sponsor float ${float.toFixed(2)} XLM vs ${(reserve + burn).toFixed(2)} XLM needed (+5 buffer)`,
    );
    if (!enough) blocked = true;
    const issuerOk = (h.usdcIssuer as string) === USDC.getIssuer();
    console.log(`  ${issuerOk ? "✓" : "✗"} USDC issuer matches the sponsor's pin`);
    if (!issuerOk) blocked = true;
  }

  const treasurySecret = process.env.TREASURY_SECRET;
  let treasury: Keypair | null = null;
  let generatedTreasury: Keypair | null = null;
  let treasuryNeedsTrustline = false;
  let treasuryShort = false;
  if (treasurySecret) {
    treasury = treasuryKeypair();
    const tXlm = await xlmOf(treasury.publicKey()).catch(() => "0");
    const hasLine = await hasTrustline(treasury.publicKey());
    const tUsdc = Number.parseFloat(await usdcOf(treasury.publicKey()));
    const okU = tUsdc >= usdcNeeded;
    const okX = Number.parseFloat(tXlm) >= 1.6;
    treasuryNeedsTrustline = !hasLine;
    console.log(`  ${okX ? "✓" : "✗"} treasury XLM ${tXlm} vs ~1.6 needed (account + trustline + fees)`);
    console.log(`  ${hasLine ? "✓" : "✗"} treasury USDC trustline ${hasLine ? "open" : "MISSING — USDC sent now would bounce"}`);
    console.log(`  ${okU ? "✓" : "✗"} treasury USDC ${tUsdc} vs ${usdcNeeded.toFixed(4)} needed`);
    treasuryShort = !okU || !okX || !hasLine;
    if (treasuryShort) blocked = true;
  } else {
    /* No treasury yet: mint one and print it, the way `mainnet-demo keys` does. The owner
     * funds an address we generated rather than pasting their own funded wallet's secret
     * into a script — the treasury is the ONE key here that ever holds real money, and it
     * should be a key whose entire life is this run. */
    treasury = Keypair.random();
    generatedTreasury = treasury;
    // Still blocked: an unfunded treasury cannot run anything. Printing "preflight clean"
    // here would be the script telling the owner to go ahead into a guaranteed failure.
    blocked = true;
    console.log(`  ✗ TREASURY_SECRET not set — generated one below; fund it and re-run plan`);
  }

  /* ---- keys ----
   * `plan` is IDEMPOTENT: run twice, get the same actors. That is not a nicety, it is the
   * difference between working approvals and silently dead ones. On mainnet the owner takes
   * the addresses this prints and allow-lists them one by one; if a second `plan` — to
   * re-read the bill, to re-print the list, to check preflight after funding — minted fresh
   * keys, every one of those approvals would now point at an address the run no longer uses,
   * and the run would fail at its first pilot-gated send with nothing explaining why.
   *
   * So keys are only ever minted when there are none to reuse, or when the owner explicitly
   * asks with --force. And --force still refuses to walk over a run whose accounts hold
   * money: that file is the only copy of the keys to it.
   */
  let state: State;
  const prev: State | null = existsSync(STATE_PATH)
    ? (JSON.parse(readFileSync(STATE_PATH, "utf8")) as State)
    : null;

  if (prev && prev.results.length > 0 && !prev.teardownDone && !flag("force")) {
    console.log(`\n  ✗ ${STATE_PATH} already holds a run from ${prev.createdAt} that has NOT been`);
    console.log(`    torn down. Its accounts still hold money and this file is the only copy of`);
    console.log(`    their keys. Run \`fleet teardown\`, or pass --force to abandon them.\n`);
    process.exit(1);
  }

  const reusable =
    prev !== null &&
    prev.network === NET.id &&
    prev.results.length === 0 &&
    !flag("force") &&
    Object.keys(prev.actors).length === specs.length &&
    specs.every((s) => prev.actors[s.id]);

  if (reusable) {
    state = { ...prev, amount: AMOUNT, contract: CONTRACT };
    // The wave size is a flag, so it can legitimately change between plans; top up or trim
    // rather than reshuffling the actors the owner may already have approved.
    while (state.wave.length < WAVE) state.wave.push(Keypair.random().secret());
    state.wave = state.wave.slice(0, WAVE);
  } else {
    state = {
      network: NET.id,
      createdAt: new Date().toISOString(),
      amount: AMOUNT,
      contract: CONTRACT,
      actors: Object.fromEntries(specs.map((s) => [s.id, Keypair.random().secret()])),
      wave: Array.from({ length: WAVE }, () => Keypair.random().secret()),
      links: [],
      results: [],
    };
  }
  saveState(state);
  console.log(
    reusable
      ? `\n  actor keys REUSED from ${STATE_PATH} (minted ${state.createdAt.slice(0, 16).replace("T", " ")})`
      : `\n  actor keys MINTED and written to ${STATE_PATH} (mode 600, outside the repo)`,
  );
  if (reusable) console.log(`  same addresses as the last plan — approvals you already made still hold`);
  console.log(`  ⚠ that file is the ONLY copy of these secrets — do not delete it mid-run`);

  /* ---- what the owner must do ---- */
  const pubOf = (id: string) => Keypair.fromSecret(state.actors[id]!).publicKey();
  console.log(`\n--- WHAT YOU MUST DO BEFORE \`fleet run\` ---`);
  if (generatedTreasury) {
    console.log(`\n  1. A treasury key was generated for this run. SAVE THE SECRET NOW — it is`);
    console.log(`     shown once, and it is the only key here that will hold real money:`);
    console.log(`\n       address: ${generatedTreasury.publicKey()}`);
    console.log(`       secret : ${generatedTreasury.secret()}`);
    console.log(`\n     ORDER MATTERS — USDC cannot reach an account that has no trustline yet:`);
    console.log(`       a) send ≥ 1.6 XLM to that address`);
    console.log(`       b) TREASURY_SECRET=S… pnpm --filter @lumenia/sponsor fleet trustline --network ${NET.id}`);
    console.log(`       c) send ≥ ${usdcNeeded.toFixed(4)} USDC to the same address`);
    console.log(`       d) re-run plan with TREASURY_SECRET set`);
  } else if (treasury && treasuryShort) {
    console.log(`\n  1. Treasury ${treasury.publicKey()}`);
    console.log(`       needs ≥ ${usdcNeeded.toFixed(4)} USDC and ≥ 1.6 XLM — see the ✗ lines above`);
    if (treasuryNeedsTrustline) {
      console.log(`       it has no USDC trustline yet, so USDC sent now would BOUNCE. Open it first:`);
      console.log(`         TREASURY_SECRET=<the full S… secret> \\`);
      console.log(`           pnpm --filter @lumenia/sponsor fleet trustline --network ${NET.id}`);
    }
  } else if (treasury) {
    console.log(`\n  1. Treasury ${treasury.publicKey()} is funded and ready.`);
  }
  if (NET.pilot) {
    const gated = specs.filter((s) => s.pilotGated);
    console.log(`\n  2. Approve the ${gated.length} wallets that hit a pilot-gated route:`);
    for (const g of gated) {
      console.log(
        `       STELLAR_NETWORK=mainnet pnpm --filter @lumenia/sponsor pilot approve ${pubOf(g.id)}   # ${g.id}`,
      );
    }
    console.log(`     (each needs ≤2 of its 5-transaction budget — no need to raise PILOT_MAX_TX)`);
    console.log(`     or re-run plan with --approve and KV_REST_API_URL/TOKEN set to do it here.`);
  } else {
    console.log(`\n  2. No pilot approvals needed — the gate is only armed on the mainnet Worker.`);
  }
  console.log(`\n  3. ${NET.id === "mainnet" ? "fleet run --network mainnet --yes" : "fleet run"}`);
  console.log(
    blocked
      ? `\n  ✗ PREFLIGHT BLOCKED — fix the ✗ lines above and re-run plan.\n`
      : `\n  ✓ preflight clean.\n`,
  );

  if (flag("approve") && NET.pilot) await approveAll(state, specs);
}

/** Optional: write the pilot allowlist directly, using the owner's own KV credentials. */
async function approveAll(state: State, specs: ActorSpec[]): Promise<void> {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.log("  --approve needs KV_REST_API_URL + KV_REST_API_TOKEN; skipped.");
    return;
  }
  const { approvePilot } = await import("./lib/pilot.js");
  process.env.STELLAR_NETWORK = NET.id;
  for (const s of specs.filter((x) => x.pilotGated)) {
    const pub = Keypair.fromSecret(state.actors[s.id]!).publicKey();
    await approvePilot(pub);
    console.log(`  approved ${s.id} ${pub}`);
  }
}

/* ----------------------------------------------------------------------------
 * RUN
 * -------------------------------------------------------------------------- */
const GUARD_NAMES = [
  "G01  anti-drain: a payment op smuggled into a claim fee-bump → rejected",
  "G02  anti-drain: a muxed (M…) operation source → rejected",
  "G03  caps: a drop above MAX_DROP_USDC → rejected",
  "G04  floor: a drop below MIN_DROP_USDC → rejected",
  "G05  pilot: an unapproved wallet deposits → 403 (mainnet only)",
  "G06  escrow: a claim signed by the WRONG key → rejected in bytecode",
  "G07  escrow: claiming the same drop twice → AlreadyClaimed",
  "G08  escrow: reclaiming before expiry → NotExpired",
  "G09  rate limit: a burst from one address → 429",
];

async function run(): Promise<void> {
  if (NET.id === "mainnet" && !flag("yes")) {
    console.error(
      "\nThis moves REAL money on mainnet. Re-run with --yes once you have read the plan.\n",
    );
    process.exit(1);
  }
  const state = loadState();
  if (state.network !== NET.id) throw new Error(`state file is for ${state.network}, not ${NET.id}`);
  const treasury = treasuryKeypair();

  const opened = await openTreasuryTrustline(treasury);
  if (opened) console.log(`  opened the treasury's USDC trustline — ${opened}`);

  const h = await health();
  const sponsorPub = h.sponsorPublicKey as string;
  const specs = roster();
  const kp = (id: string) => Keypair.fromSecret(state.actors[id]!);
  const results: StepResult[] = [];

  const step = async (id: string, op: string, fn: () => Promise<{ detail: string; hashes?: string[] }>) => {
    process.stdout.write(`  ${id} ${op.slice(0, 58).padEnd(58)} `);
    try {
      const r = await fn();
      results.push({ id, op, ok: true, detail: r.detail, hashes: r.hashes ?? [] });
      console.log(`✓ ${r.detail}`);
    } catch (e) {
      const detail = (e as Error).message.slice(0, 160);
      results.push({ id, op, ok: false, detail, hashes: [] });
      console.log(`✗ ${detail}`);
    }
    state.results = results;
    saveState(state);
  };

  console.log(`\n=== FLEET RUN — ${NET.id.toUpperCase()} ===`);
  console.log(`  sponsor ${sponsorPub}`);
  console.log(`  escrow  ${CONTRACT}\n`);

  /* ---------- 0. onboard every actor (sponsored, 0 XLM each) ---------- */
  console.log("--- onboarding ---");
  const onboarded: string[] = [];
  for (const s of specs) {
    await step(s.id, `onboard ${s.role}`, async () => {
      const { hash, via } = await onboard(kp(s.id));
      onboarded.push(s.id);
      return { detail: `account live${via ? ` via:${via}` : ""}`, hashes: [hash] };
    });
  }

  /* ---------- 1. one transaction funds everyone who needs USDC ---------- */
  console.log("\n--- treasury funding (one batched transaction) ---");
  const targets = specs
    .filter((s) => s.funds !== "0" && onboarded.includes(s.id))
    .map((s) => ({ pub: kp(s.id).publicKey(), amount: Number.parseFloat(s.funds).toFixed(7) }));
  await step("T00", `fund ${targets.length} actors`, async () => {
    const hash = await fundActors(treasury, targets);
    return { detail: `${targets.length} actors funded in 1 tx`, hashes: [hash] };
  });

  /* ---------- 2. the matrix ---------- */
  console.log("\n--- matrix ---");
  const now = () => BigInt(Math.floor(Date.now() / 1000));

  /* M01 → M02 and M01 → M12: two classic bearer links.
   *
   * A real bearer link names a FRESH random key as its unconditional claimant, and the
   * recipient's browser then onboards exactly that key into a sponsored 0-XLM account.
   * M02 and M12 ARE those keys — already onboarded above, which is the same two steps in
   * the other order and keeps each actor's identity equal to the key that claims. Naming a
   * throwaway bearer here instead would leave the claim with no account to run from. */
  let linkForClaim = "";
  let linkForSweep = "";
  await step("M01", "classic /send-link ×2", async () => {
    const r1 = await sendLink(kp("M01"), kp("M02").publicKey(), AMOUNT, sponsorPub);
    state.links.push({ owner: "M01", secret: "→M02", kind: "classic", balanceId: r1.balanceId });
    saveState(state);
    const r2 = await sendLink(kp("M01"), kp("M12").publicKey(), AMOUNT, sponsorPub);
    state.links.push({ owner: "M01", secret: "→M12", kind: "classic", balanceId: r2.balanceId });
    saveState(state);
    linkForClaim = r1.balanceId;
    linkForSweep = r2.balanceId;
    return { detail: "2 claimable balances created", hashes: [r1.hash, r2.hash] };
  });

  await step("M02", "walletless claim of M01's link", async () => {
    if (!linkForClaim) throw new Error("M01 produced no link");
    const hash = await claimCB(kp("M02"), linkForClaim);
    const xlm = await xlmOf(kp("M02").publicKey());
    return {
      detail: `holds ${await settledUsdc(kp("M02").publicKey())} USDC and ${xlm} XLM`,
      hashes: [hash],
    };
  });

  // M03 → M04: v2 escrow, late-bound payout.
  const dropM03 = Keypair.random();
  await step("M03", "/v2-deposit into the Soroban escrow", async () => {
    state.links.push({ owner: "M03", secret: dropM03.secret(), kind: "v2" });
    saveState(state);
    const r = await v2Deposit(kp("M03"), dropM03, AMOUNT, now() + 7n * 24n * 3600n);
    return { detail: r.status === 202 ? "submitted (unconfirmed)" : "escrowed", hashes: [r.hash] };
  });

  await step("M04", "/v2-claim to a late-bound payout", async () => {
    const r = await v2Claim(dropM03, kp("M04").publicKey(), false);
    if (r.status !== 200) throw new Error(`${r.status}: ${r.raw.slice(0, 120)}`);
    const got = await settledUsdc(kp("M04").publicKey());
    const xlm = await xlmOf(kp("M04").publicKey());
    return { detail: `holds ${got} USDC and ${xlm} XLM`, hashes: [r.hash!] };
  });

  // M05 ← M06: request money — paid to the asker's ADDRESS, then collected.
  let requestBalanceId = "";
  await step("M06", "pay a request to M05's address", async () => {
    const r = await sendLink(kp("M06"), kp("M05").publicKey(), AMOUNT, sponsorPub);
    requestBalanceId = r.balanceId;
    return { detail: "paid to address", hashes: [r.hash] };
  });
  await step("M05", "collect the incoming request", async () => {
    const hash = await claimCB(kp("M05"), requestBalanceId);
    return { detail: `holds ${await settledUsdc(kp("M05").publicKey())} USDC`, hashes: [hash] };
  });

  // M07 → M08/M09/M10: group drop, three equal shares.
  const pool = Keypair.random();
  const poolTotal = (Number.parseFloat(AMOUNT) * 3).toFixed(7);
  await step("M07", "create_drop — 3 equal shares", async () => {
    state.links.push({ owner: "M07", secret: pool.secret(), kind: "v2-pool" });
    saveState(state);
    const hash = await v2CreateDrop(kp("M07"), treasury, pool, poolTotal, 3, now() + 7n * 24n * 3600n);
    return { detail: `${poolTotal} USDC in 3 slots (owner-paid fee — not relayed)`, hashes: [hash] };
  });
  /* G06 belongs HERE, not down with the other guards: it has to run while the pool still
   * has a free slot. Once M08–M10 have emptied it, a forged signature would be refused for
   * being out of shares — the right answer for the wrong reason, which proves nothing. */
  await step("G06", "a claim signed by the wrong key", async () => {
    const impostor = Keypair.random();
    const linkHex = Buffer.from(pool.rawPublicKey()).toString("hex");
    const sigHex = Buffer.from(impostor.sign(Buffer.from("not the message"))).toString("hex");
    const r = await sponsorPost("/v2-claim", {
      method: "claim_share",
      linkHex,
      payout: kp("M13").publicKey(),
      sigHex,
      contract: CONTRACT,
    });
    if (r.status === 200) throw new Error("a forged signature CLAIMED — INVARIANT BROKEN");
    return { detail: `refused (${r.status}) with the pool still claimable` };
  });

  for (const id of ["M08", "M09", "M10"]) {
    await step(id, "claim_share from the pool", async () => {
      const r = await v2Claim(pool, kp(id).publicKey(), true);
      if (r.status !== 200) throw new Error(`${r.status}: ${r.raw.slice(0, 120)}`);
      return { detail: `holds ${await settledUsdc(kp(id).publicKey())} USDC`, hashes: [r.hash!] };
    });
  }

  // M11: short expiry, so the reclaim path is testable in one sitting.
  const dropM11 = Keypair.random();
  const expiryM11 = now() + BigInt(EXPIRY_WAIT - 10);
  await step("M11", `deposit with a ${EXPIRY_WAIT - 10}s expiry`, async () => {
    state.links.push({ owner: "M11", secret: dropM11.secret(), kind: "v2-short" });
    saveState(state);
    const r = await v2Deposit(kp("M11"), dropM11, AMOUNT, expiryM11);
    return { detail: "escrowed, expires shortly", hashes: [r.hash] };
  });

  // G08 belongs here: the drop is live and not yet expired.
  await step("G08", "reclaim BEFORE expiry must fail", async () => {
    /* The refusal arrives during SIMULATION, before anything is submitted, so it surfaces as
     * a thrown HostError rather than an HTTP status. Treating a throw as a failed step would
     * mark the contract's correct answer as a red line — the invariant holding is the pass. */
    try {
      const r = await v2Reclaim(kp("M11"), dropM11);
      if (r.status === 200) throw new Error("reclaim succeeded before expiry — INVARIANT BROKEN");
      return { detail: `refused (${r.status})` };
    } catch (e) {
      const m = (e as Error).message;
      if (/INVARIANT BROKEN/.test(m)) throw e;
      return { detail: /#4/.test(m) ? "refused: NotExpired (#4)" : `refused: ${m.slice(0, 60)}` };
    }
  });

  // M12 → M13: sweep + merge, the consolidation that returns reserve.
  await step("M12", "sweep into M13 and close", async () => {
    if (!linkForSweep) throw new Error("M01 produced no second link");
    // One transaction: claim the balance, forward the USDC to M13, drop the trustline and
    // merge away — which is what returns this account's 1.5 XLM of reserve to the sponsor.
    const r = await sweep(kp("M12"), kp("M13").publicKey(), AMOUNT, linkForSweep);
    if (r.status !== 200) throw new Error(`${r.status}: ${r.raw.slice(0, 120)}`);
    return { detail: "claimed, forwarded, merged", hashes: [r.hash!] };
  });
  await step("M13", "home account holds the swept money", async () => {
    const got = await usdcOf(kp("M13").publicKey());
    if (Number.parseFloat(got) <= 0) throw new Error("nothing arrived home");
    return { detail: `${got} USDC consolidated` };
  });

  // M14: cash-out leg.
  await step("M14", "/payout to an external address", async () => {
    const dest = opt("payout-dest", treasury.publicKey());
    const r = await payout(kp("M14"), dest, AMOUNT);
    if (r.status !== 200) throw new Error(`${r.status}: ${r.raw.slice(0, 120)}`);
    return { detail: `sent out to ${dest.slice(0, 8)}…`, hashes: [r.hash!] };
  });

  // M15 ← M16 + M17: split — two payers, one asker.
  const splitIds: string[] = [];
  for (const id of ["M16", "M17"]) {
    await step(id, "pay a share of M15's split", async () => {
      const r = await sendLink(kp(id), kp("M15").publicKey(), AMOUNT, sponsorPub);
      splitIds.push(r.balanceId);
      return { detail: "share paid", hashes: [r.hash] };
    });
  }
  await step("M15", "collect both split shares", async () => {
    const hashes: string[] = [];
    for (const b of splitIds) hashes.push(await claimCB(kp("M15"), b));
    return { detail: `holds ${await usdcOf(kp("M15").publicKey())} USDC from ${splitIds.length} payers`, hashes };
  });

  /* ---------- 2b. onward activity — give every account a real history ----------
   *
   * One transaction per account is a proof; several is a history. These rounds send money
   * BETWEEN the actors that already hold some, so nothing new has to be funded and the
   * amounts just circulate. `/payout` is used for the ring because it is the one value
   * route the pilot gate does not meter — a ring of sends would burn the approved wallets'
   * five-transaction budgets on mainnet and stop the run halfway. */
  console.log("\n--- onward activity ---");

  // A claimer becomes a sender: the money M02 received goes back out as a fresh link.
  let onwardBalanceId = "";
  await step("R01", "M02 sends onward as a new link", async () => {
    const r = await sendLink(kp("M02"), kp("M13").publicKey(), AMOUNT, sponsorPub);
    onwardBalanceId = r.balanceId;
    return { detail: "claimed money re-sent", hashes: [r.hash] };
  });
  await step("R02", "M13 claims what M02 sent", async () => {
    if (!onwardBalanceId) throw new Error("R01 produced no balance");
    const hash = await claimCB(kp("M13"), onwardBalanceId);
    return { detail: `holds ${await settledUsdc(kp("M13").publicKey())} USDC`, hashes: [hash] };
  });

  // A share holder becomes an escrow sender.
  const dropR = Keypair.random();
  await step("R03", "M08 deposits its share into a new drop", async () => {
    state.links.push({ owner: "M08", secret: dropR.secret(), kind: "v2" });
    saveState(state);
    const r = await v2Deposit(kp("M08"), dropR, AMOUNT, now() + 7n * 24n * 3600n);
    return { detail: "escrowed", hashes: [r.hash] };
  });
  await step("R04", "M09 claims M08's drop", async () => {
    const r = await v2Claim(dropR, kp("M09").publicKey(), false);
    if (r.status !== 200) throw new Error(`${r.status}: ${r.raw.slice(0, 120)}`);
    return { detail: `holds ${await settledUsdc(kp("M09").publicKey())} USDC`, hashes: [r.hash!] };
  });

  /* The ring: every actor still holding USDC passes some to the next one. Repeat with
   * --rounds N to build as much history as you want; each hop is one classic transaction
   * at ~0.00002 XLM, so ten rounds still cost less than a single Soroban deposit. */
  const ROUNDS = Number.parseInt(opt("rounds", "2"), 10);
  for (let round = 1; round <= ROUNDS; round++) {
    const ring = specs.map((s) => s.id).filter((id) => id !== "M12"); // M12 merged itself away
    let hops = 0;
    const hashes: string[] = [];
    for (let i = 0; i < ring.length; i++) {
      const from = ring[i]!;
      const to = ring[(i + 1) % ring.length]!;
      const bal = Number.parseFloat(await usdcOf(kp(from).publicKey()));
      if (bal <= 0) continue;
      // Move a slice, never the whole balance, so the ring keeps circulating instead of
      // draining into one account on the first pass.
      const amt = Math.max(0.0000001, Math.floor((bal / 2) * 1e7) / 1e7).toFixed(7);
      try {
        const r = await payout(kp(from), kp(to).publicKey(), amt);
        if (r.status === 200) {
          hops++;
          if (r.hash) hashes.push(r.hash);
        }
      } catch {
        /* one refused hop must not end the round */
      }
    }
    results.push({
      id: `RING${round}`,
      op: `round ${round}: actors pay each other`,
      ok: hops > 0,
      detail: `${hops} hops settled`,
      hashes,
    });
    console.log(`  ${hops > 0 ? "✓" : "✗"} RING${round} ${hops} hops settled`);
    state.results = results;
    saveState(state);
  }

  /* ---------- 3. guards — the defenses must refuse ---------- */
  console.log("\n--- guards ---");

  await step("G01", "payment smuggled into a claim fee-bump", async () => {
    const acc = await freshAccount(kp("M13").publicKey());
    const inner = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET.passphrase })
      .addOperation(
        Operation.payment({ destination: treasury.publicKey(), asset: USDC, amount: AMOUNT }),
      )
      .setTimeout(120)
      .build();
    inner.sign(kp("M13"));
    const r = await sponsorPost("/feebump", {
      xdr: inner.toXDR(),
      recipientPublicKey: kp("M13").publicKey(),
      balanceId: "0".repeat(72),
    });
    if (r.status === 200) throw new Error("anti-drain ACCEPTED a payment — INVARIANT BROKEN");
    return { detail: `rejected (${r.status})` };
  });

  await step("G02", "muxed operation source", async () => {
    const acc = await freshAccount(kp("M13").publicKey());
    // A REAL M… address (hand-rolling one from a G… string just fails in the builder, which
    // would test our own typo rather than the sponsor's validator).
    const muxed = new MuxedAccount(new Account(kp("M13").publicKey(), "0"), "1").accountId();
    const inner = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET.passphrase })
      .addOperation(Operation.claimClaimableBalance({ balanceId: "0".repeat(72), source: muxed }))
      .setTimeout(120)
      .build();
    inner.sign(kp("M13"));
    const r = await sponsorPost("/feebump", {
      xdr: inner.toXDR(),
      recipientPublicKey: kp("M13").publicKey(),
      balanceId: "0".repeat(72),
    });
    if (r.status === 200) throw new Error("a muxed source was ACCEPTED — INVARIANT BROKEN");
    return { detail: `rejected (${r.status})` };
  });

  /* G03/G04 post an UNSIMULATED invoke on purpose.
   *
   * The obvious version — build the oversized deposit the normal way — never reaches the cap:
   * simulation fails first, because the actor does not hold 6 USDC to begin with, and the guard
   * then "passes" on an insufficient-balance error while the cap was never consulted. A right
   * answer for the wrong reason is worse than a failure, so these skip simulation and let the
   * sponsor read the amount out of the XDR, which is where the cap actually lives. The refusal
   * reason is printed verbatim rather than asserted on, so a refusal for some OTHER reason is
   * visible instead of being quietly counted as a pass. */
  const unsimulatedDeposit = async (sender: Keypair, amount: string): Promise<string> => {
    const src = await freshAccount(sender.publicKey());
    const t = new TransactionBuilder(src, { fee: "2000000", networkPassphrase: NET.passphrase })
      .addOperation(
        new Contract(CONTRACT).call(
          "deposit",
          Address.fromString(sender.publicKey()).toScVal(),
          xdr.ScVal.scvBytes(Buffer.from(Keypair.random().rawPublicKey())),
          nativeToScVal(stroops(amount), { type: "i128" }),
          nativeToScVal(now() + 3600n, { type: "u64" }),
        ),
      )
      .setTimeout(120)
      .build();
    t.sign(sender);
    return t.toXDR();
  };

  await step("G03", "a drop above the per-drop cap", async () => {
    const over = NET.id === "mainnet" ? "6" : "101";
    const r = await sponsorPost("/v2-deposit", {
      xdr: await unsimulatedDeposit(kp("M03"), over),
      senderPublicKey: kp("M03").publicKey(),
    });
    if (r.status === 200 || r.status === 202) {
      throw new Error(`a ${over} USDC drop was ACCEPTED — cap not enforced`);
    }
    return { detail: `${r.status}: ${(r.body.error as string) ?? r.raw.slice(0, 70)}` };
  });

  await step("G04", "a drop below the floor", async () => {
    const r = await sponsorPost("/v2-deposit", {
      xdr: await unsimulatedDeposit(kp("M03"), "0.001"),
      senderPublicKey: kp("M03").publicKey(),
    });
    if (r.status === 200 || r.status === 202) {
      throw new Error("a dust drop was ACCEPTED — floor not enforced");
    }
    return { detail: `${r.status}: ${(r.body.error as string) ?? r.raw.slice(0, 70)}` };
  });

  if (NET.pilot) {
    await step("G05", "an unapproved wallet deposits", async () => {
      const stranger = Keypair.random();
      const r = await sponsorPost("/v2-deposit", {
        xdr: "AAAA",
        senderPublicKey: stranger.publicKey(),
      });
      if (r.status === 200) throw new Error("an unapproved wallet was ADMITTED — INVARIANT BROKEN");
      return { detail: `refused (${r.status})` };
    });
  }

  await step("G07", "claiming M03's drop a second time", async () => {
    const r = await v2Claim(dropM03, kp("M13").publicKey(), false);
    if (r.status === 200) throw new Error("a drop was claimed TWICE — INVARIANT BROKEN");
    return { detail: `refused (${r.status})` };
  });

  await step("G09", "a burst from one address", async () => {
    const target = Keypair.random().publicKey();
    const codes = await Promise.all(
      Array.from({ length: 12 }, () =>
        sponsorPost("/create-account", { recipientPublicKey: target }).then((r) => r.status),
      ),
    );
    const limited = codes.filter((c) => c === 429).length;
    if (limited === 0) throw new Error(`no 429 in 12 requests (${codes.join(",")}) — limiter silent`);
    return { detail: `${limited}/12 rate-limited` };
  });

  /* ---------- 4. the reclaim, once the short drop has actually expired ---------- */
  console.log("\n--- waiting for the short-expiry drop ---");
  const waitUntil = Number(expiryM11) * 1000 + 15_000;
  while (Date.now() < waitUntil) {
    process.stdout.write(`\r  ${Math.ceil((waitUntil - Date.now()) / 1000)}s remaining…   `);
    await sleep(3000);
  }
  console.log("\r  expired.                    ");
  await step("M11", "/v2-reclaim after expiry", async () => {
    const r = await v2Reclaim(kp("M11"), dropM11);
    if (r.status !== 200) throw new Error(`${r.status}: ${r.raw.slice(0, 120)}`);
    return { detail: `${await settledUsdc(kp("M11").publicKey())} USDC back with the sender`, hashes: [r.hash!] };
  });

  /* ---------- 5. the concurrency wave ---------- */
  console.log(`\n--- wave: ${WAVE} simultaneous onboardings ---`);
  const waveKps = state.wave.map((s) => Keypair.fromSecret(s));
  const started = Date.now();
  /* Firing everything at once from ONE host also trips our own per-IP rate limit, so a raw
   * burst comes back part-429 — which says nothing about sequence contention, the thing this
   * wave exists to measure. A 429 is therefore retried with backoff rather than counted as a
   * failure; that the limiter fires at all is G09's job to assert, not this one's. */
  const onboardWithRetry = async (k: Keypair): Promise<{ ok: boolean; via?: string; limited: boolean; err?: string }> => {
    let limited = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { via } = await onboard(k);
        return { ok: true, via, limited };
      } catch (e) {
        const m = (e as Error).message;
        if (/429/.test(m)) {
          limited = true;
          /* The limiter is a FIXED 60s window (RATE_CAP 30 per IP), not a leaky bucket, so
           * backing off by a few seconds just re-enters the same exhausted window. The waits
           * below add up to more than 60s on purpose: the retry has to outlive the window it
           * was refused in, or the account is simply never created. */
          await sleep([8000, 20000, 35000, 50000][attempt] ?? 50000);
          continue;
        }
        return { ok: false, limited, err: m };
      }
    }
    return { ok: false, limited, err: "still rate-limited after 5 attempts" };
  };
  const outcomes = await Promise.all(waveKps.map(onboardWithRetry));
  const okCount = outcomes.filter((o) => o.ok).length;
  const viaChannel = outcomes.filter((o) => o.via === "channel").length;
  const throttled = outcomes.filter((o) => o.limited).length;
  const badSeq = outcomes.filter((o) => /tx_bad_seq|txBadSeq/i.test(o.err ?? "")).length;
  /* The property under test is the channel pool: no sequence collisions, and every account
   * that DID onboard went through a channel. Whether the limiter throttled some of them is a
   * separate, healthy fact — asserting 12/12 made a working rate limiter look like a defect. */
  const waveOk = badSeq === 0 && okCount > 0 && viaChannel === okCount;
  results.push({
    id: "WAVE",
    op: `${WAVE} concurrent /create-account`,
    ok: waveOk,
    detail: `${okCount}/${WAVE} onboarded · ${viaChannel} via:channel · ${badSeq} tx_bad_seq · ${throttled} hit the rate limit first · ${((Date.now() - started) / 1000).toFixed(1)}s`,
    hashes: [],
  });
  console.log(`  ${waveOk ? "✓" : "✗"} ${results.at(-1)!.detail}`);

  state.results = results;
  saveState(state);
  report(state);
}

/* ----------------------------------------------------------------------------
 * REPORT
 * -------------------------------------------------------------------------- */
function report(state: State): void {
  const pass = state.results.filter((r) => r.ok).length;
  const total = state.results.length;
  console.log(`\n${"=".repeat(72)}`);
  console.log(` FLEET RESULT — ${state.network.toUpperCase()}  ${pass}/${total} PASS`);
  console.log(`${"=".repeat(72)}\n`);
  for (const r of state.results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.id.padEnd(5)} ${r.op.slice(0, 46).padEnd(46)} ${r.detail}`);
  }
  const hashes = state.results.flatMap((r) => r.hashes);
  if (hashes.length) {
    console.log(`\n--- ON-CHAIN EVIDENCE (${hashes.length} transactions) ---`);
    for (const h of hashes) console.log(`  ${tx(h)}`);
  }
  console.log(
    `\n  escrow: https://stellar.expert/explorer/${NET.explorer}/contract/${state.contract}`,
  );
  console.log(`  state : ${STATE_PATH}`);
  if (!state.teardownDone) {
    console.log(
      `\n  ${(Object.keys(state.actors).length + state.wave.length - 1) * RESERVE_PER_ACCOUNT_XLM} XLM of sponsor reserve is still locked by these accounts.`,
    );
    console.log(`  \`fleet teardown --network ${state.network}\` returns it whenever you want.\n`);
  }
}

/* ----------------------------------------------------------------------------
 * TEARDOWN — give the reserve and the USDC back. Not part of `run`.
 * -------------------------------------------------------------------------- */
async function teardown(): Promise<void> {
  if (NET.id === "mainnet" && !flag("yes")) {
    console.error("\nThis closes real mainnet accounts. Re-run with --yes.\n");
    process.exit(1);
  }
  const state = loadState();
  // TREASURY_SECRET is required even when --home points elsewhere: emptying an account needs
  // a funded source for the dust below, and the treasury is the one account that has USDC.
  if (!process.env.TREASURY_SECRET) throw new Error("set TREASURY_SECRET (teardown funds dust from it)");
  const home = opt("home", treasuryKeypair().publicKey());

  console.log(`\n=== FLEET TEARDOWN — ${NET.id.toUpperCase()} → ${home} ===\n`);
  const all = [
    ...Object.entries(state.actors).map(([id, s]) => ({ id, kp: Keypair.fromSecret(s) })),
    ...state.wave.map((s, i) => ({ id: `W${String(i + 1).padStart(2, "0")}`, kp: Keypair.fromSecret(s) })),
  ];
  /* The sweep policy pins [payment, changeTrust, accountMerge] — and `payment` cannot carry
   * a zero amount. So an account holding NO USDC (every wave actor, and any claimer that
   * already forwarded its money) has no sponsor-supported way to close, and its 1.5 XLM of
   * reserve would stay locked forever. One stroop of USDC each fixes it: the sweep then has
   * something to move, and the dust comes straight back home in the same transaction.
   * 0.0000001 USDC × ~30 accounts is three millionths of a dollar. */
  const treasury = treasuryKeypair();
  const live: typeof all = [];
  const dust: Array<{ pub: string; amount: string }> = [];
  for (const a of all) {
    if (a.kp.publicKey() === home) continue;
    try {
      await HZ.loadAccount(a.kp.publicKey());
    } catch {
      console.log(`  · ${a.id} already gone`);
      continue;
    }
    live.push(a);
    if (Number.parseFloat(await usdcOf(a.kp.publicKey())) === 0) {
      dust.push({ pub: a.kp.publicKey(), amount: "0.0000001" });
    }
  }
  if (dust.length) {
    // 100 ops per transaction is the protocol limit; chunk so a large fleet still works.
    for (let i = 0; i < dust.length; i += 90) {
      await fundActors(treasury, dust.slice(i, i + 90));
    }
    console.log(`  · dusted ${dust.length} empty accounts so they can be swept\n`);
  }

  let closed = 0;
  for (const a of live) {
    try {
      const bal = await usdcOf(a.kp.publicKey());
      if (Number.parseFloat(bal) === 0) throw new Error("still holds no USDC — cannot sweep");
      const r = await sweep(a.kp, home, bal);
      if (r.status !== 200) throw new Error(`${r.status}: ${r.raw.slice(0, 100)}`);
      closed++;
      console.log(`  ✓ ${a.id} closed, ${bal} USDC home`);
    } catch (e) {
      console.log(`  ✗ ${a.id} ${(e as Error).message.slice(0, 100)}`);
    }
  }
  state.teardownDone = true;
  saveState(state);
  console.log(
    `\n  ${closed}/${all.length} accounts closed — about ${(closed * RESERVE_PER_ACCOUNT_XLM).toFixed(1)} XLM of reserve back with the sponsor.\n`,
  );
}

/* -------------------------------------------------------------------------- */
async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "plan") return plan();
  if (cmd === "trustline") {
    const t = treasuryKeypair();
    const hash = await openTreasuryTrustline(t);
    console.log(
      hash
        ? `\n  ✓ USDC trustline opened for ${t.publicKey()}\n    ${tx(hash)}\n    You can send it USDC now.\n`
        : `\n  ✓ ${t.publicKey()} already has its USDC trustline — send it USDC.\n`,
    );
    return;
  }
  if (cmd === "run") return run();
  if (cmd === "report") return report(loadState());
  if (cmd === "teardown") return teardown();
  console.log(`
usage: fleet <plan|trustline|run|report|teardown> [options]

  --network testnet|mainnet   which network (default testnet)
  --amount 0.01               USDC per drop (0.01 is the sponsor's floor)
  --wave 12                   how many simultaneous onboardings
  --expiry-wait 100           seconds before the short-expiry reclaim
  --rounds 2                  extra payment rounds around the actor ring
  --force                     plan: replace a state file that was never torn down

  trustline opens the treasury's own USDC trustline (needs TREASURY_SECRET + a little
  XLM in it). USDC cannot be sent to an account before this exists.
  --payout-dest G…            where the cash-out leg sends (default: treasury)
  --home G…                   teardown destination (default: treasury)
  --approve                   plan: write the pilot allowlist via KV directly
  --yes                       required for any mainnet write
`);
  process.exit(1);
}

main().catch((e) => {
  console.error("\n💥", (e as Error)?.message ?? e);
  process.exit(1);
});
