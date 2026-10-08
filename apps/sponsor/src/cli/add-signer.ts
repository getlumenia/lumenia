/**
 * add-signer: the KMS cutover's one on-chain step (ops/RUNBOOK_SPONSOR_KEY.md section 2).
 *
 * Adds a signer (the KMS key's address, from `kms-check`) to the EXISTING sponsor account with a
 * SetOptions, so the account, its float, its sponsored reserves and the web's sponsor pin all stay
 * exactly where they are and only the KEY that signs changes. (Neither sponsor account holds a
 * trustline: XLM only, `subentry_count` 0 on Horizon on 2026-10-08.) The master key (the hot
 * SPONSOR_SECRET) keeps its weight: it is the rollback for a week; lowering it to 0 is a separate,
 * later decision (runbook section 3) that this tool deliberately does not offer.
 *
 * Two runs, and the second one submits exactly what the first one wrote:
 *   1. The dry run (the default) reads the account (one Horizon GET), builds the SetOptions with a
 *      one-hour timebound, and writes the UNSIGNED transaction, its hash, and the account's signers
 *      and thresholds BEFORE the change. It signs nothing and needs no secret: an unsigned envelope
 *      is useless to whoever reads the file, and a transaction's hash does not cover its
 *      signatures, so the hash recorded here is the hash that lands.
 *   2. `--submit --in <file> --hash <hash>` loads that file and refuses unless its transaction is
 *      still exactly the one reviewed: that hash, no signature, sourced by the record's account, ONE
 *      SetOptions that adds the record's signer at its weight with thresholds 1/1/1 and changes
 *      nothing else, inside its timebound, on an account whose sequence has not moved since. Then
 *      it signs that transaction with the master key, submits it, and writes the outcome and the
 *      signers and thresholds AFTER the change back into the same file: the cutover log.
 *
 * Real-money discipline, in code rather than in a checklist:
 *   - the file must be gitignored (the tool checks with `git check-ignore`), because a mainnet
 *     operation whose record exists only in a terminal's scrollback is how 28.5 XLM was lost once;
 *   - nothing is signed or submitted without `--submit`, and a signed envelope is never written;
 *   - mainnet needs `I_UNDERSTAND_MAINNET=1` in the shell and prints no address, only the path, the
 *     hash and counts;
 *   - the secret is read from `SPONSOR_SECRET` by `--submit` only, never printed, never written. Put
 *     it there with `read -rs SPONSOR_SECRET && export SPONSOR_SECRET` and `unset SPONSOR_SECRET`
 *     afterwards: typed on the command line it lands in the shell history and on any recorded screen.
 *
 * Paths: pnpm runs this script with apps/sponsor as its working directory, so a relative `--out` or
 * `--in` is resolved against the directory the command was typed in (INIT_CWD, which pnpm sets),
 * the way the shell reads it.
 *
 * RUN (testnet first, then mainnet), from apps/sponsor:
 *   pnpm run add-signer --network testnet --account G<existing sponsor> --signer G<kms key> \
 *     --out .cutover/testnet-setoptions.json
 *   ...read the file and record its hash, then:
 *   read -rs SPONSOR_SECRET && export SPONSOR_SECRET
 *   pnpm run add-signer --network testnet --submit --in .cutover/testnet-setoptions.json --hash <hash>
 *   unset SPONSOR_SECRET
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, BASE_FEE, Horizon, Keypair, Operation, StrKey, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { defaultHorizon, passphraseFor, type StellarNetwork } from "../lib/config.js";

/** The dry run's transaction stays valid this long: time to read the file, not time to forget it. */
export const ADD_SIGNER_TIMEOUT_SECONDS = 3600;

/** A dry run this close to its timebound is refused: a submit racing the clock gains nothing. */
const SUBMIT_MARGIN_SECONDS = 60;

/** The dry run bids the base fee; a file asking for more than this was not written by it. */
const MAX_FEE_STROOPS = 10_000n;

/** Record format 1 held a SIGNED envelope that anyone with the file could submit; --submit refuses it. */
const RECORD_FORMAT = 2;

/** apps/sponsor/, from this file's own location (src/cli/), whatever directory pnpm or a shell is in. */
const SPONSOR_DIR = fileURLToPath(new URL("../../", import.meta.url));

export interface AccountSnapshot {
  sequence: string;
  thresholds: { low: number; med: number; high: number };
  signers: Array<{ key: string; weight: number; type: string }>;
}

export interface SetOptionsRecord {
  tool: "add-signer";
  format: number;
  builtAt: string;
  network: StellarNetwork;
  account: string;
  signer: string;
  weight: number;
  thresholds: { low: number; med: number; high: number };
  masterWeightTouched: false;
  /** The transaction's own sequence number (the account's at the dry run, plus one). */
  sequence: string;
  validUntil: string;
  hash: string;
  unsignedXdr: string;
  before: AccountSnapshot;
  outcome: "dry-run" | "submitting" | "submitted" | "failed" | "unconfirmed";
  submittedAt: string | null;
  ledger: number | null;
  /** Horizon's result codes for a refused submit; never an envelope (a signed one could be replayed). */
  error: string | null;
  after: AccountSnapshot | null;
}

/** What this tool reads from Horizon's account record; the SDK's AccountResponse satisfies it. */
export interface HorizonAccountLike {
  id: string;
  sequence: string;
  thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
  signers: ReadonlyArray<{ key: string; weight: number; type: string }>;
}

export function snapshotOf(a: HorizonAccountLike): AccountSnapshot {
  return {
    sequence: String(a.sequence),
    thresholds: { low: a.thresholds.low_threshold, med: a.thresholds.med_threshold, high: a.thresholds.high_threshold },
    signers: a.signers.map((s) => ({ key: s.key, weight: s.weight, type: s.type })),
  };
}

/**
 * Can the account's master key alone authorize a signer change? A SetOptions that touches signers
 * or thresholds needs the HIGH threshold. After the weight-0 decision the answer is no, and this
 * tool, which signs with the master key only, cannot do the rotation (runbook section 3).
 */
export function masterCanSign(account: string, snap: AccountSnapshot): boolean {
  const weight = snap.signers.find((s) => s.key === account)?.weight ?? 0;
  return weight > 0 && weight >= snap.thresholds.high;
}

/** Build the dry run: the unsigned SetOptions and its record. Pure: no network, no clock unless `now` is omitted. */
export function buildSetOptionsRecord(p: {
  network: StellarNetwork;
  account: HorizonAccountLike;
  signer: string;
  weight: number;
  now?: Date;
}): { record: SetOptionsRecord; tx: Transaction } {
  const accountId = p.account.id;
  if (!StrKey.isValidEd25519PublicKey(accountId)) throw new Error("the account must be a valid G... address");
  if (!StrKey.isValidEd25519PublicKey(p.signer)) throw new Error("the signer must be a valid G... address");
  if (accountId === p.signer) throw new Error("the signer must differ from the account (the master key is already a signer)");
  if (!Number.isInteger(p.weight) || p.weight < 1 || p.weight > 255) throw new Error("the weight must be an integer from 1 to 255");
  const now = p.now ?? new Date();
  const before = snapshotOf(p.account);
  const maxTime = Math.floor(now.getTime() / 1000) + ADD_SIGNER_TIMEOUT_SECONDS;

  /* Thresholds 1/1/1: explicit, and what the runbook states. The master key keeps its weight (it is
   * not mentioned in this op, so it is untouched); the new signer gets `weight`. Either key alone
   * then satisfies every threshold, which is exactly the cutover shape: KMS signs the traffic, the
   * hot key stays offline as the rollback until the weight-0 decision a week later. A fresh Account
   * is built from the snapshot so the caller's record of the account is never mutated. */
  const tx = new TransactionBuilder(new Account(accountId, before.sequence), {
    fee: BASE_FEE,
    networkPassphrase: passphraseFor(p.network),
  })
    .addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: p.signer, weight: p.weight },
        lowThreshold: 1,
        medThreshold: 1,
        highThreshold: 1,
      }),
    )
    .setTimebounds(0, maxTime)
    .build();

  const record: SetOptionsRecord = {
    tool: "add-signer",
    format: RECORD_FORMAT,
    builtAt: now.toISOString(),
    network: p.network,
    account: accountId,
    signer: p.signer,
    weight: p.weight,
    thresholds: { low: 1, med: 1, high: 1 },
    masterWeightTouched: false,
    sequence: tx.sequence,
    validUntil: new Date(maxTime * 1000).toISOString(),
    hash: tx.hash().toString("hex"),
    unsignedXdr: tx.toXDR(),
    before,
    outcome: "dry-run",
    submittedAt: null,
    ledger: null,
    error: null,
    after: null,
  };
  return { record, tx };
}

/** The SetOptions fields this tool sets, as the SDK parses them back from XDR. */
interface ParsedSetOptions {
  type: string;
  source?: string;
  inflationDest?: string;
  clearFlags?: number;
  setFlags?: number;
  masterWeight?: number;
  lowThreshold?: number;
  medThreshold?: number;
  highThreshold?: number;
  homeDomain?: string;
  signer?: { ed25519PublicKey?: string; weight?: number };
}

/**
 * Everything --submit checks in the file before it asks for the secret. Throws the first problem
 * found; returns the record and the parsed, still UNSIGNED transaction.
 */
export function checkRecordForSubmit(
  raw: unknown,
  p: { network: StellarNetwork; hash: string; now?: Date },
): { record: SetOptionsRecord; tx: Transaction } {
  const r = raw as Partial<SetOptionsRecord> | null;
  if (!r || typeof r !== "object" || r.tool !== "add-signer" || r.format !== RECORD_FORMAT || typeof r.unsignedXdr !== "string") {
    throw new Error("the file is not a dry-run record of this version of add-signer (an older record holds a signed envelope): run the dry run again");
  }
  if (r.network !== p.network) throw new Error(`the file is for ${String(r.network)}, not ${p.network}`);
  if (r.outcome === "submitted") throw new Error("the file records a SetOptions that already landed; nothing to submit");
  const wanted = p.hash.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(wanted)) throw new Error("--hash must be the 64-hex-character hash the dry run printed");

  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(r.unsignedXdr, passphraseFor(p.network));
    if ("innerTransaction" in parsed) throw new Error("a fee-bump");
    tx = parsed as Transaction;
  } catch (e) {
    throw new Error(`the file's transaction does not parse as a ${p.network} transaction: ${(e as Error).message}`);
  }
  const actual = tx.hash().toString("hex");
  if (actual !== wanted) {
    throw new Error(`the file's transaction hashes to ${actual}, not to the --hash given: it is not the transaction that was reviewed`);
  }
  if (r.hash !== actual) throw new Error("the file's recorded hash is not its transaction's hash: the file was edited");
  if (tx.signatures.length !== 0) throw new Error("the file's transaction already carries a signature; a dry run never signs");
  if (typeof r.account !== "string" || tx.source !== r.account) throw new Error("the transaction is not sourced by the record's account");
  if (tx.sequence !== r.sequence) throw new Error("the transaction's sequence is not the record's");
  if (tx.operations.length !== 1) throw new Error(`the transaction holds ${tx.operations.length} operations, not one SetOptions`);
  const op = tx.operations[0] as unknown as ParsedSetOptions;
  // The SDK reports an unset field as undefined after an XDR round trip and as null on a freshly
  // built transaction: both mean "not set", so "set" is checked as neither.
  const isSet = (v: unknown) => v !== undefined && v !== null;
  if (op.type !== "setOptions") throw new Error(`the operation is ${op.type}, not setOptions`);
  if (isSet(op.source) && op.source !== r.account) throw new Error("the SetOptions is sourced by another account");
  if (op.signer?.ed25519PublicKey !== r.signer || op.signer?.weight !== r.weight) {
    throw new Error("the SetOptions does not add the record's signer at the record's weight");
  }
  if (op.lowThreshold !== 1 || op.medThreshold !== 1 || op.highThreshold !== 1) {
    throw new Error("the SetOptions does not set the thresholds to 1/1/1");
  }
  if (isSet(op.masterWeight) || isSet(op.inflationDest) || isSet(op.clearFlags) || isSet(op.setFlags) || isSet(op.homeDomain)) {
    throw new Error("the SetOptions changes more than the signer and the thresholds");
  }
  if (BigInt(tx.fee) > MAX_FEE_STROOPS) throw new Error(`the transaction bids ${tx.fee} stroops; the dry run bids the base fee`);
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (!maxTime) throw new Error("the transaction has no timebound; the dry run always sets one");
  const nowSec = Math.floor((p.now ?? new Date()).getTime() / 1000);
  if (maxTime - nowSec < SUBMIT_MARGIN_SECONDS) {
    throw new Error(`the dry run expired (valid until ${new Date(maxTime * 1000).toISOString()}): run it again`);
  }
  return { record: r as SetOptionsRecord, tx };
}

/** The live account must still be the one the dry run read: same sequence, signer not yet added. */
export function checkLiveAccount(record: SetOptionsRecord, tx: Transaction, live: AccountSnapshot): void {
  const needed = (BigInt(tx.sequence) - 1n).toString();
  if (live.sequence !== needed) {
    throw new Error(
      `the account's sequence moved since the dry run (it is ${live.sequence}, the transaction needs ${needed}): another transaction from the account landed, so this one would fail. Run the dry run again`,
    );
  }
  if (live.signers.some((s) => s.key === record.signer && s.weight === record.weight)) {
    throw new Error("the signer is already on the account at that weight; nothing to submit");
  }
  if (!masterCanSign(record.account, live)) {
    throw new Error("the account's master key can no longer authorize a signer change (weight 0, or below the high threshold); see the runbook, section 3");
  }
}

/** A relative --out/--in means what it means in the shell the command was typed in (INIT_CWD under pnpm). */
export function resolveCliPath(path: string, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  return isAbsolute(path) ? path : resolve(env.INIT_CWD || cwd, path);
}

/** True when git would ignore `absPath` (asked from inside the repo, whatever the caller's directory). */
export function isGitignored(absPath: string): boolean {
  try {
    execFileSync("git", ["-C", SPONSOR_DIR, "check-ignore", "-q", absPath], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A record path that .gitignore covers: apps/sponsor/.cutover/<network>-setoptions.json. */
export function suggestedRecordPath(network: StellarNetwork): string {
  return resolve(SPONSOR_DIR, ".cutover", `${network}-setoptions.json`);
}

/** How to write `absPath` from the directory the command was typed in. */
export function shownPath(absPath: string, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  return relative(env.INIT_CWD || cwd, absPath) || ".";
}

/* ---------------------------------------------------------------------------------------------- */

function usage(code: number): never {
  console.log(
    [
      "add-signer: add a signer (weight 1) to the existing sponsor account with a SetOptions.",
      "",
      "Dry run (default; reads the account, signs nothing, needs no secret):",
      "  --network testnet|mainnet   which network (mainnet also needs I_UNDERSTAND_MAINNET=1)",
      "  --account G...              the EXISTING sponsor account (the address /health shows)",
      "  --signer G...               the KMS key's address (from `kms-check`)",
      "  --out <path>                where the UNSIGNED transaction, its hash and the account's signers",
      "                              and thresholds are written; must be gitignored",
      "  --weight <n>                signer weight, default 1",
      "",
      "Submit (signs exactly the transaction in the file with the master key, then submits it):",
      "  --network testnet|mainnet   the same network",
      "  --submit --in <path>        the dry run's file (the outcome is written back into it)",
      "  --hash <hex>                the hash you recorded from the dry run",
      "",
      "  --horizon <url>             override the Horizon url (both modes)",
      "",
      "Relative paths are read from the directory the command is typed in (pnpm's INIT_CWD).",
      "Env (submit only): SPONSOR_SECRET = the account's master key. Never printed, never written.",
      "  Set it with `read -rs SPONSOR_SECRET && export SPONSOR_SECRET`, never on the command line,",
      "  and `unset SPONSOR_SECRET` afterwards.",
    ].join("\n"),
  );
  process.exit(code);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function fail(message: string): never {
  console.error(`add-signer: ${message}`);
  process.exit(1);
}

/** Refuse any record path git would track: the record of a key change must never reach a commit. */
function requireGitignored(absPath: string, network: StellarNetwork): void {
  if (isGitignored(absPath)) return;
  fail(
    `refusing to use ${shownPath(absPath)}: it is not gitignored. A path that is, from this directory: ${shownPath(suggestedRecordPath(network))}`,
  );
}

function writeRecord(absPath: string, record: SetOptionsRecord): void {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function summary(s: AccountSnapshot): string {
  return `${s.signers.length} signer(s), thresholds ${s.thresholds.low}/${s.thresholds.med}/${s.thresholds.high}`;
}

async function dryRun(network: StellarNetwork, horizon: Horizon.Server, quiet: boolean): Promise<void> {
  const account = arg("account") ?? "";
  const signer = arg("signer") ?? "";
  if (!StrKey.isValidEd25519PublicKey(account)) fail("--account must be a valid G... address");
  if (!StrKey.isValidEd25519PublicKey(signer)) fail("--signer must be a valid G... address");
  if (account === signer) fail("--signer must differ from --account (the master key is already a signer)");
  const weight = Number.parseInt(arg("weight") ?? "1", 10);
  if (!Number.isInteger(weight) || weight < 1 || weight > 255) fail("--weight must be an integer from 1 to 255");

  const out = arg("out");
  if (!out) fail("--out is required: the unsigned transaction and its hash are written there before anything else");
  const outPath = resolveCliPath(out);
  requireGitignored(outPath, network);
  if (existsSync(outPath)) {
    let previous: { outcome?: string; submitted?: boolean } = {};
    try {
      previous = JSON.parse(readFileSync(outPath, "utf8")) as typeof previous;
    } catch {
      /* unreadable: overwrite it like any other stale dry run */
    }
    if (previous.outcome === "submitted" || previous.outcome === "unconfirmed" || previous.outcome === "submitting" || previous.submitted === true) {
      fail(`${shownPath(outPath)} records a submitted SetOptions (the cutover log); keep it and choose another --out`);
    }
  }

  const loaded = await horizon.loadAccount(account);
  const already = loaded.signers.find((s) => s.key === signer);
  if (already && already.weight === weight) {
    console.log(`${quiet ? "the signer" : signer} is already a signer of ${quiet ? "the account" : account} with weight ${weight}; nothing to do.`);
    return;
  }

  const { record } = buildSetOptionsRecord({ network, account: loaded, signer, weight });
  writeRecord(outPath, record);
  console.log(`wrote ${shownPath(outPath)} (unsigned; nothing submitted)`);
  console.log(`hash  ${record.hash}`);
  console.log(`valid until ${record.validUntil}`);
  console.log(`before: ${summary(record.before)}`);
  if (!quiet) console.log(`SetOptions on ${account}: add signer ${signer} weight ${weight}, thresholds 1/1/1, master weight untouched`);
  if (!masterCanSign(account, record.before)) {
    console.log("note: the master key cannot authorize this any more, so --submit will refuse it (runbook section 3)");
  }
  // --filter runs from anywhere in the repo, and the path is relative to where this was typed.
  console.log("Read the file and record the hash. Then, from this same directory, with SPONSOR_SECRET exported from `read -rs`:");
  console.log(`  pnpm --filter @lumenia/sponsor add-signer --network ${network} --submit --in ${shownPath(outPath)} --hash ${record.hash}`);
}

async function submitRun(network: StellarNetwork, horizon: Horizon.Server, quiet: boolean): Promise<void> {
  const inArg = arg("in");
  const hashArg = arg("hash");
  if (!inArg || !hashArg) {
    fail("--submit needs --in <the dry run's file> and --hash <the hash recorded from it>; it signs and submits exactly the transaction in that file");
  }
  const inPath = resolveCliPath(inArg);
  requireGitignored(inPath, network);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(inPath, "utf8"));
  } catch (e) {
    fail(`cannot read ${shownPath(inPath)}: ${(e as Error).message}`);
  }
  const { record, tx } = checkRecordForSubmit(raw, { network, hash: hashArg });
  for (const k of ["account", "signer"] as const) {
    const given = arg(k);
    if (given && given !== record[k]) fail(`--${k} differs from the file's ${k}`);
  }

  const secret = process.env.SPONSOR_SECRET;
  if (!secret) fail("SPONSOR_SECRET is not set (read -rs SPONSOR_SECRET && export SPONSOR_SECRET)");
  let master: Keypair;
  try {
    master = Keypair.fromSecret(secret);
  } catch {
    fail("SPONSOR_SECRET is not a valid secret key");
  }
  if (master.publicKey() !== record.account) fail("SPONSOR_SECRET is not the key of the record's account (it must be the account's master key)");

  const live = snapshotOf(await horizon.loadAccount(record.account));
  /* A submit answered "unconfirmed" (a 504, no response) may have landed after all. Then the account
     shows the record's signer at its weight and has used exactly THIS transaction's sequence, and
     checkLiveAccount would refuse it as "another transaction moved the sequence". Confirm the landing
     by the hash, which only this transaction has, and record it, so the cutover log gets its ledger
     and its after-state instead of a misattributed refusal. */
  if (live.sequence === tx.sequence && live.signers.some((s) => s.key === record.signer && s.weight === record.weight)) {
    // With Horizon's `_links` the SDK moves the ledger number to `ledger_attr` (`ledger` becomes a
    // link to follow); without them it stays `ledger`. Either way it is the number that is kept.
    let onLedger: { ledger_attr?: unknown; ledger?: unknown; successful?: boolean } | null = null;
    try {
      onLedger = (await horizon.transactions().transaction(record.hash).call()) as unknown as {
        ledger_attr?: unknown;
        ledger?: unknown;
        successful?: boolean;
      };
    } catch {
      onLedger = null;
    }
    if (onLedger && onLedger.successful !== false) {
      record.outcome = "submitted";
      record.ledger =
        typeof onLedger.ledger_attr === "number" ? onLedger.ledger_attr : typeof onLedger.ledger === "number" ? onLedger.ledger : null;
      record.after = live;
      record.error = null;
      writeRecord(inPath, record);
      console.log(`already landed: ${record.hash} is on the ledger${record.ledger ? ` (ledger ${record.ledger})` : ""}; the record now says so`);
      console.log(`after: ${summary(live)}`);
      return;
    }
  }
  checkLiveAccount(record, tx, live);

  tx.sign(master);
  // Written BEFORE the submit: a run that dies mid-request still leaves "look this hash up".
  record.outcome = "submitting";
  record.submittedAt = new Date().toISOString();
  record.error = null;
  writeRecord(inPath, record);
  console.log(`submitting ${record.hash}`);
  try {
    const res = await horizon.submitTransaction(tx);
    record.outcome = "submitted";
    record.ledger = res.ledger;
    try {
      record.after = snapshotOf(await horizon.loadAccount(record.account));
    } catch {
      record.after = null; // the SetOptions landed; the after-read is a convenience, not the proof
    }
    writeRecord(inPath, record);
    console.log(`submitted: ledger ${res.ledger}, hash ${res.hash}`);
    if (record.after) console.log(`after: ${summary(record.after)}`);
    console.log(`explorer: https://stellar.expert/explorer/${network === "mainnet" ? "public" : "testnet"}/tx/${res.hash}`);
    if (!quiet) console.log(`recorded in ${shownPath(inPath)}`);
  } catch (e) {
    const response = (e as { response?: { status?: number; data?: { extras?: { result_codes?: unknown } } } }).response;
    // Horizon's result codes only: the extras also carry the SIGNED envelope, which must not be kept.
    const codes = response?.data?.extras?.result_codes;
    const status = response?.status;
    const undecided = status === undefined || status >= 500;
    record.outcome = undecided ? "unconfirmed" : "failed";
    record.error = codes ? JSON.stringify(codes) : `${status ?? "no response"}: ${String((e as Error).message).slice(0, 200)}`;
    writeRecord(inPath, record);
    if (undecided) {
      fail(
        `submit unconfirmed (${record.error}): the transaction may still land until ${record.validUntil}. Look the hash up before anything else; re-submitting this same file is safe, it can land only once`,
      );
    }
    fail(`submit failed: ${record.error}`);
  }
}

async function main(): Promise<void> {
  if (flag("help") || process.argv.length <= 2) usage(flag("help") ? 0 : 1);

  const network = arg("network") as StellarNetwork | undefined;
  if (network !== "testnet" && network !== "mainnet") fail("--network must be testnet or mainnet");
  if (network === "mainnet" && process.env.I_UNDERSTAND_MAINNET !== "1") {
    fail("mainnet needs I_UNDERSTAND_MAINNET=1 in the shell (real money; read the runbook's real-money rules first)");
  }
  const quiet = network === "mainnet";
  const url = arg("horizon") ?? defaultHorizon(network);
  // Plain http only for a Horizon on this machine (the offline end-to-end test in test-kms-signer.ts).
  const horizon = new Horizon.Server(url, { allowHttp: isLoopback(url) });
  if (flag("submit")) await submitRun(network, horizon, quiet);
  else await dryRun(network, horizon, quiet);
}

function isLoopback(url: string): boolean {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Run only as a script, so test-kms-signer.ts can import the checks above without a CLI firing. */
function isEntryPoint(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((e) => {
    console.error(`add-signer: ${(e as Error).message}`);
    process.exit(1);
  });
}
