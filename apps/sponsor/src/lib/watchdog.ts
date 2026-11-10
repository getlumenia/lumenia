/**
 * WATCHDOG — the tripwire that makes the incident runbook start in minutes instead of days.
 *
 * OpenZeppelin Monitor is the "proper" tool for this, but it is a separate always-on process
 * (Docker/binary) and we do not run one. The Worker is already always-on, so the watchdog runs
 * as a Cron Trigger against the same infrastructure. It checks three things and alerts on any:
 *
 *   1. **Sponsor balance floor** — the float is meant to be small and topped up on a schedule.
 *      Falling under the floor means either the top-up stopped or something is spending faster
 *      than expected.
 *   2. **Sponsor sourcing value**: the sponsor opens 0-XLM accounts, sponsors their reserves,
 *      relays escrow calls and pays fees and rent, and that short ALLOWLIST (`SPONSOR_ALLOWED_OPS`)
 *      is all it may source. A payment, a merge, a SetOptions, a funded create_account or a call
 *      into any other contract in its history is the signature of a stolen key, and it is the
 *      alert that should wake someone up.
 *   3. **Escrow governance calls** — pause/unpause/upgrade/ownership are rare and human-initiated.
 *      An unexpected one means the owner key is compromised.
 *
 * Alerts go to the console (visible in `wrangler tail`) and, when RESEND_API_KEY +
 * ALERT_NOTIFY_TO are set, by email. Without those nothing reaches a human, which from the
 * outside looks exactly like a healthy service — so "alerting is not configured" is itself an
 * alert and a field on the report (see `alertingStatus`). Cursors live in the same Upstash store
 * as the rate limiter. With no cursor (a first run, no store, or a key the store lost) the
 * forbidden-operation scan reads the account's NEWEST operations, not its oldest, and a forbidden
 * operation older than a day pages without halting; with a cursor it walks forward from it.
 *
 * Only the Worker's scheduled run changes anything: it calls `runWatchdog(config, account,
 * { autoHalt: true, heartbeat: true })`. Without those flags a run reads and reports and writes
 * nothing (no halt, no stamp, no cursor, no baseline, no cooldown, no email), so a smoke test or an
 * operator's script started from a shell that holds the production store's variables can neither
 * stop a live sponsor nor move its scan past an operation the Worker has not seen yet.
 */
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { SponsorConfig, StellarNetwork } from "./config.js";
import { kvConfigFromEnv } from "./rate-limit.js";
import { feeBudgetFromEnv, readSponsorFeeDay, stroopsToXlm } from "./caps.js";
import { CCTP_FORWARDERS } from "./cctp-relay.js";
import { haltKey, haltReasonKey, setHalt, storeHaltIsSet } from "./kill-switch.js";
import { storeFetch } from "./store-fetch.js";

/**
 * What the sponsor legitimately SOURCES. Every other operation it sources is the signature of a
 * stolen key and trips the auto-halt.
 *
 * Until 2026-11-10 this was a DENYLIST of nine operation types, and a denylist is a list of the
 * thefts somebody thought of: a sponsor-sourced `create_account` with a positive starting balance,
 * an `invoke_host_function` moving XLM or USDC through a Stellar Asset Contract, a `change_trust`
 * or a `liquidity_pool_deposit` never paged, and with the hot key signing on both Workers this scan
 * is the only theft detection there is. The allowlist is derived from the code that builds
 * sponsor-sourced operations (lib/create-account.ts, lib/soroban-relay.ts, lib/cctp-relay.ts, and
 * anti-drain.ts `SPONSOR_SOURCEABLE_OPS` for the client-built shapes) and was checked against every
 * sponsor-sourced operation Horizon lists for both accounts on 2026-11-10: mainnet GBLBAK...YZZ2
 * sourced 85 begin_sponsoring_future_reserves, 78 create_account (every one at 0 XLM) and 5
 * invoke_host_function (all `claim`/`claim_share` on the escrow); testnet GDQFGI...XDLL sourced
 * 984, 925 (every one at 0 XLM) and 19 (all `claim`, on the current and the three legacy escrows);
 * nothing else, ever. So the halt cannot fire on anything the sponsor has actually done.
 *
 *   - begin_sponsoring_future_reserves and end_sponsoring_future_reserves: the sandwich around every
 *     onboarding. The sponsor sources `begin`; `end` is recipient-sourced today and moves nothing
 *     whoever sources it, so it is allowed rather than made an outage;
 *   - create_account, ONLY with a starting balance of exactly 0: the sponsored 0-XLM account
 *     (anti-drain.ts `maxStartingBalance` defaults to "0" and nothing overrides it). Any other
 *     balance is XLM leaving the sponsor;
 *   - invoke_host_function, ONLY an InvokeContract of the escrow, a superseded escrow or the CCTP
 *     forwarder, and ONLY when no balance change names the sponsor as the payer: the relayed v2
 *     claims and the CCTP mint when no channel was free. A call into any other contract, the XLM
 *     or USDC Stellar Asset Contract above all, is value leaving the sponsor;
 *   - extend_footprint_ttl and restore_footprint: rent. The state-expiry runbook lets any funded
 *     key pay it, the sponsor hot key included, and both move nothing.
 *
 * `set_options` stays out on purpose, as before: it is how a stolen key adds a signer or drops a
 * threshold BEFORE the operation that moves value, and catching the preparation is the only chance
 * to catch it in time; the KMS cutover's and every rotation's SetOptions trip this by design
 * (ops/RUNBOOK_SPONSOR_KEY.md section 4).
 */
export const SPONSOR_ALLOWED_OPS = new Set([
  "begin_sponsoring_future_reserves",
  "end_sponsoring_future_reserves",
  "create_account",
  "invoke_host_function",
  "extend_footprint_ttl",
  "restore_footprint",
]);

/** Horizon's `function` of an invoke_host_function that calls a contract (not an upload or a create). */
const INVOKE_CONTRACT = "HostFunctionTypeHostFunctionTypeInvokeContract";

/** The contracts the sponsor may invoke: the escrow, its superseded ids (exit only) and the CCTP forwarder. */
function allowedContracts(config: SponsorConfig): Set<string> {
  return new Set([
    ...(config.lumendropContract ? [config.lumendropContract] : []),
    ...config.lumendropLegacyContracts,
    ...CCTP_FORWARDERS,
  ]);
}

/** The contract an invoke_host_function record calls (its first parameter, an Address); null when unreadable. */
function invokedContract(op: Record<string, unknown>): string | null {
  const params = op.parameters;
  if (!Array.isArray(params) || params.length === 0) return null;
  const first = params[0] as { value?: unknown } | null;
  if (typeof first?.value !== "string") return null;
  try {
    return Address.fromScVal(xdr.ScVal.fromXDR(first.value, "base64")).toString();
  } catch {
    return null;
  }
}

/**
 * Why a sponsor-sourced Horizon operation record is forbidden, as a phrase for the page, or null
 * when it is one of the allowed shapes. Strict: a shape that cannot be read (a create_account
 * without a starting balance, an invocation whose contract does not decode) is forbidden, because
 * a theft signal is never downgraded on a missing field. Exported so the offline suite can prove
 * every allowed shape quiet and every other one loud.
 */
export function forbiddenSponsorOp(op: Record<string, unknown>, config: SponsorConfig, sponsorPublicKey: string): string | null {
  const type = String(op.type ?? "");
  if (!SPONSOR_ALLOWED_OPS.has(type)) return `a ${type || "(typeless operation)"}: the sponsor never sources one`;
  if (type === "create_account") {
    const raw = typeof op.starting_balance === "string" ? op.starting_balance : "";
    const balance = Number.parseFloat(raw);
    if (!Number.isFinite(balance) || balance !== 0) {
      return `a create_account with a starting balance of ${raw || "(unreadable)"} XLM: the sponsor funds accounts with exactly 0 XLM`;
    }
    return null;
  }
  if (type === "invoke_host_function") {
    const fn = String(op.function ?? "");
    if (fn !== INVOKE_CONTRACT) {
      return `an invoke_host_function of kind ${fn || "(unreadable)"}: the sponsor only calls contracts, it never uploads or creates one`;
    }
    const contract = invokedContract(op);
    if (!contract || !allowedContracts(config).has(contract)) {
      return `an invoke_host_function on ${contract ?? "an unreadable contract"}: the sponsor only calls the escrow, a superseded escrow or the CCTP forwarder`;
    }
    const changes = Array.isArray(op.asset_balance_changes)
      ? (op.asset_balance_changes as Array<{ from?: unknown; to?: unknown; amount?: unknown; asset_code?: unknown; asset_type?: unknown }>)
      : [];
    const paid = changes.find((c) => c.from === sponsorPublicKey);
    if (paid) {
      const asset = typeof paid.asset_code === "string" ? paid.asset_code : paid.asset_type === "native" ? "XLM" : "an asset";
      return `an invoke_host_function on ${contract} that moved ${String(paid.amount ?? "?")} ${asset} out of the sponsor to ${String(paid.to ?? "?")}: the sponsor's own balance never pays a contract call`;
    }
    return null;
  }
  return null;
}

/** An owner has scheduled new bytecode: the one governance event that pages at the highest severity. */
export const UPGRADE_PROPOSED_EVENT = "upgrade_proposed";

/**
 * Escrow event names that are always worth a page: the DECODED first topics of the events the
 * OpenZeppelin modules the contract uses actually emit, read from the vendored crates
 * (stellar-access 0.7.2 `ownable`, stellar-contract-utils 0.7.2 `pausable`; a `#[contractevent]`
 * without `topics` is named after its struct in snake case), plus the three the timelock being
 * added to contracts/lumen-drop emits. Until 2026-11-10 this set named ownership_transfer_started,
 * owner_set, role_granted and role_revoked, none of which exists in those crates, so the START of an
 * ownership transfer went unpaged. OZ's `upgrade` itself emits nothing (it calls
 * `update_current_contract_wasm`), which is why an upgrade is also detected by watching the
 * deployed wasm hash, `checkWasmHash`; once the timelock lands, `upgraded` names it and the hash
 * check confirms it.
 */
const GOVERNANCE_EVENTS = new Set([
  "paused", // Paused {}
  "unpaused", // Unpaused {}
  "ownership_transfer", // OwnershipTransfer { old_owner, new_owner, live_until_ledger }: the transfer STARTED
  "ownership_transfer_completed", // OwnershipTransferCompleted { new_owner }
  "ownership_renounced", // OwnershipRenounced { old_owner }
  UPGRADE_PROPOSED_EVENT, // the timelock: new bytecode scheduled, installable after the 7-day delay
  "upgrade_cancelled", // the timelock: the pending bytecode was withdrawn
  "upgraded", // the timelock: the pending bytecode was installed
]);

/** Decode a base64 XDR topic into its native value (topics are ScVals, never plain strings). */
function decodeTopic(t: string): string {
  try {
    const v = scValToNative(xdr.ScVal.fromXDR(t, "base64"));
    return typeof v === "string" ? v : String(v);
  } catch {
    return "";
  }
}

/** A base64 ScVal decoded to its native value; `undefined` when it does not decode (a void decodes to null). */
function nativeOf(b64: string): unknown {
  try {
    return scValToNative(xdr.ScVal.fromXDR(b64, "base64"));
  } catch {
    return undefined;
  }
}

/** A decoded ScVal as a reader can use it: bytes as hex, integers as digits, addresses as strings, maps as JSON. */
function describeNative(v: unknown): string {
  if (v === undefined) return "(undecoded)";
  if (v === null) return "(void)";
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString("hex") : x));
  } catch {
    return "(undecoded)";
  }
}

function describeScVal(b64: string): string {
  return describeNative(nativeOf(b64));
}

/**
 * The timelock's `not_before` out of an upgrade_proposed event's data (a map `{not_before: u64}`,
 * ledger seconds), as digits and as a date; null when the data carries no readable one.
 */
function notBeforeOf(data: unknown): { seconds: string; iso: string } | null {
  if (!data || typeof data !== "object") return null;
  const raw = (data as { not_before?: unknown }).not_before;
  const n = typeof raw === "bigint" ? raw : typeof raw === "number" && Number.isFinite(raw) ? BigInt(Math.trunc(raw)) : null;
  if (n === null || n < 0n || n > 253_402_300_799n) return null; // past year 9999: not a timestamp
  return { seconds: n.toString(), iso: new Date(Number(n) * 1000).toISOString() };
}

export interface Alert {
  /** `critical` is a page that is mailed first with a CRITICAL subject; `page` is mailed; `info` is logged only. */
  severity: "critical" | "page" | "info";
  title: string;
  detail: string;
}

/** Whether a page can actually leave the Worker, and what is missing if it cannot. */
export interface AlertingStatus {
  configured: boolean;
  missing: string[];
}

export interface WatchdogReport {
  checked: string[];
  alerts: Alert[];
  alerting: AlertingStatus;
  /** True when this run wrote the halt key (a key-compromise tripwire fired and autoHalt was on). */
  autoHalted: boolean;
  /** The heartbeat stamp this run wrote (ISO-8601 UTC), or null when it wrote none (heartbeat off, or no store). */
  lastRun: string | null;
  /** The same stamp, also written as `watchdog:<net>:lastfull` when every check completed; else null. */
  lastFullRun: string | null;
}

/**
 * What a caller lets one run change. Both flags default to false, so the default run is
 * read-only; `worker.scheduled` passes both and is the only caller that should.
 */
export interface WatchdogOptions {
  /** Write the halt key when a key-compromise tripwire fires. */
  autoHalt?: boolean;
  /**
   * This run is the Worker's scheduled watchdog: it writes the heartbeat stamps, keeps the scan
   * cursors and the wasm baseline in the store, and emails pages under the cooldown.
   */
  heartbeat?: boolean;
  /** The run's clock, ms since the epoch (tests pin it). */
  now?: number;
  /** The pause before the read that confirms a wasm mismatch; tests shorten it. */
  confirmDelayMs?: number;
}

/**
 * The two alert titles that mean "the SPONSOR KEY, or the escrow's UPGRADE key, is in somebody
 * else's hands". They are the only two conditions the watchdog answers by halting the sponsor on
 * its own (SOW 2, D3 item f): a halt also blocks the EXIT routes (/v2-claim, /feebump, /sweep,
 * /v2-reclaim), so a float that ran low, a capacity floor, a state-expiry warning, a governance
 * event somebody may well have meant, or a check that merely failed to run must page a person and
 * never lock recipients away from money already escrowed for them. The constants are shared by
 * the check that raises the alert and the auto-halt that reads it, so the two cannot drift apart.
 */
export const TRIPWIRE_FORBIDDEN_OP = "Sponsor SOURCED a forbidden operation";
export const TRIPWIRE_WASM_CHANGED = "Escrow WASM CHANGED - the contract was upgraded";
export const AUTO_HALT_TITLE = "Sponsor AUTO-HALTED by the watchdog";

/* The pages around the two tripwires that must NOT halt. Each has its own title, so it can never be
 * mistaken for a tripwire by `isAutoHaltTripwire` and never shares a cooldown with one. */
/** The tripwire fired and the halt could not be written: the sponsor is still running. */
export const AUTO_HALT_FAILED_TITLE = "Sponsor auto-halt FAILED - halt by hand";
/** A tripwire fired on a run that was not allowed to halt (no autoHalt): reported, never written. */
export const AUTO_HALT_SKIPPED_TITLE = "Auto-halt not attempted (read-only run)";
/** A forbidden operation older than a day: history, such as a planned SetOptions, found after a lost cursor. */
export const FORBIDDEN_OP_OLD_TITLE = "Sponsor sourced a forbidden operation over a day ago";
/** The forbidden-operation scan could not reach the newest operation within one run. */
export const OPS_SCAN_BEHIND_TITLE = "Watchdog forbidden-operation scan is behind";
/** One read showed a wasm mismatch and the confirming read did not. */
export const WASM_UNCONFIRMED_TITLE = "Escrow WASM mismatch not confirmed - no auto-halt";

/** Which alerts halt on their own. Exported so the offline suite proves the scope stays this narrow. */
export function isAutoHaltTripwire(title: string): boolean {
  return title === TRIPWIRE_FORBIDDEN_OP || title === TRIPWIRE_WASM_CHANGED;
}

/**
 * Horizon page size of the forbidden-operation scan, and how many pages one run may read before
 * it says it is behind. Ten reads keep a whole worst-case run near forty subrequests, under the 50
 * a Worker on the free plan may make per invocation (developers.cloudflare.com/workers/platform/limits).
 */
export const OPS_PAGE_SIZE = 100;
export const OPS_MAX_PAGES = 10;

/** A forbidden operation older than this pages without halting (the watchdog never saw it happen). */
export const FORBIDDEN_OP_HALT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The pause between the read that finds a wasm mismatch and the read that must confirm it. */
export const WASM_CONFIRM_DELAY_MS = 2_000;

/** getEvents page size of the governance scan. */
export const EVENTS_PAGE_SIZE = 200;

/** Every check a run makes; `watchdog:<net>:lastfull` is written only when all of them completed. */
const CHECKS = ["sponsor-account", "escrow-governance", "escrow-wasm", "escrow-ttl", "fee-budget"] as const;

function networkOf(config: SponsorConfig): StellarNetwork {
  return config.networkPassphrase.includes("Public") ? "mainnet" : "testnet";
}

/** The heartbeat key: `watchdog:<network>:lastrun`, an ISO-8601 UTC stamp written at the end of every scheduled run. */
export function lastRunKey(network: StellarNetwork): string {
  return `watchdog:${network}:lastrun`;
}

/**
 * `watchdog:<network>:lastfull`: the same stamp, written only by a run in which every check
 * completed. A cron that fires while a check fails on every run (Horizon throttling the Worker, an
 * RPC that is down) keeps `lastrun` fresh and lets this one go stale, which is what the dead-man
 * workflow reads to tell "the watchdog runs" from "the watchdog sees".
 */
export function lastFullRunKey(network: StellarNetwork): string {
  return `watchdog:${network}:lastfull`;
}

/** The stamp of the last completed run, or null when there is none (or no store). */
export async function watchdogLastRun(network: StellarNetwork): Promise<string | null> {
  return kvGet(lastRunKey(network));
}

/** Both heartbeat stamps for /health, each null when absent (or no store). */
export async function watchdogStamps(network: StellarNetwork): Promise<{ lastRun: string | null; lastFullRun: string | null }> {
  const [lastRun, lastFullRun] = await Promise.all([kvGet(lastRunKey(network)), kvGet(lastFullRunKey(network))]);
  return { lastRun, lastFullRun };
}

/**
 * Seconds since a stamp, or null for no stamp / an unreadable one. NEGATIVE for a stamp from the
 * future: clamping that to 0 made a skewed clock or a stamp the watchdog never wrote read as a run
 * that had just happened. Pure, so the heartbeat workflow's rule is testable.
 */
export function watchdogAge(lastRunIso: string | null, now = Date.now()): number | null {
  if (!lastRunIso) return null;
  const t = Date.parse(lastRunIso);
  if (!Number.isFinite(t)) return null;
  return Math.round((now - t) / 1000);
}

/* ------------------------------- cursor storage ------------------------------- */

/**
 * A store read that tells ABSENT from UNREADABLE. `value: null` means the store answered and the key
 * is not there, or there is no store at all (where nothing is ever kept, so every run is a cold
 * start by design). `ok: false` means the store could not answer: a cursor read that way must not be
 * taken for a missing one, or a single store error restarts a scan from scratch and jumps over
 * everything since the cursor (the ops scan from the newest page, the governance scan from its
 * cold-start window) and then writes the jump down as the new cursor.
 */
type KvRead = { ok: true; value: string | null } | { ok: false; error: string };

async function kvRead(key: string): Promise<KvRead> {
  const kv = kvConfigFromEnv();
  if (!kv) return { ok: true, value: null };
  try {
    const res = await storeFetch(`${kv.url}/get/${key}`, { headers: { authorization: `Bearer ${kv.token}` } });
    if (!res.ok) return { ok: false, error: `the store answered ${res.status}` };
    const body = (await res.json()) as { result?: unknown; error?: string };
    if (body.error) return { ok: false, error: body.error };
    return { ok: true, value: typeof body.result === "string" ? body.result : null };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** For reads where unreadable and absent may be treated alike (a stamp, a cooldown): null for both. */
async function kvGet(key: string): Promise<string | null> {
  const read = await kvRead(key);
  return read.ok ? read.value : null;
}

/** True when the store accepted the write; false with no store or on any failure (never throws). */
async function kvSet(key: string, value: string): Promise<boolean> {
  const kv = kvConfigFromEnv();
  if (!kv) return false;
  try {
    const res = await storeFetch(`${kv.url}/set/${key}/${encodeURIComponent(value)}`, {
      headers: { authorization: `Bearer ${kv.token}` },
    });
    return res.ok;
  } catch {
    /* a cursor we fail to persist just means the next run re-scans: never fatal */
    return false;
  }
}

/**
 * A read the run needed (a scan cursor, the wasm pin) that the store could not answer. The check
 * that needed it is SKIPPED for the run, never restarted from scratch, and the scheduled run folds
 * every such skip into one `STORE_UNAVAILABLE_TITLE` line (see `runWatchdog`) instead of paging each
 * check at once: during a store outage the cooldown cannot be read or written either, so each check
 * paging on its own mailed about eight times an hour across the two Workers and spent the Resend
 * quota the theft and float pages need.
 */
export class StoreUnavailableError extends Error {}

/** The one line a scheduled run says about a store it cannot reach. */
export const STORE_UNAVAILABLE_TITLE = "Watchdog store unavailable";

/**
 * What this isolate remembers between scheduled runs when the STORE cannot: when the store was first
 * found unavailable and whether that outage was paged, and when each page was last mailed. A
 * Worker's module memory outlives a run only while its isolate stays warm, so this bounds the mail
 * an outage produces (at most one page per outage per isolate, the cooldown of every other page
 * kept) rather than recording anything; the heartbeat a store outage also stops
 * (`watchdog:<net>:lastrun`) is what reaches a person through the dead-man workflow when no isolate
 * lives long enough to count the grace. Keyed by network so one process serving both (the offline
 * suite, an operator's script) never answers one network's question with the other's memory.
 */
interface IsolateMemory {
  outage: { since: number; pagedAt: number | null } | null;
  alerted: Map<string, number>;
}
const memories = new Map<StellarNetwork, IsolateMemory>();
function memoryOf(network: StellarNetwork): IsolateMemory {
  let m = memories.get(network);
  if (!m) {
    m = { outage: null, alerted: new Map() };
    memories.set(network, m);
  }
  return m;
}

/** Test seam: forget what this process remembers between runs (the outage clock and the mailed stamps). */
export function resetWatchdogMemory(): void {
  memories.clear();
}

/** One run's settings and the decisions its checks hand to runWatchdog, which acts after the halt step. */
interface Run {
  network: StellarNetwork;
  now: number;
  /** Store writes (cursors, baseline) happen only on the Worker's scheduled run (`heartbeat`). */
  persist: boolean;
  confirmDelayMs: number;
  /** Where the forbidden-operation scan would move its cursor, and whether it raised the tripwire. */
  opsCursor?: { key: string; to: string; tripped: boolean };
  /** Set when the wasm tripwire fired: what the auto-halt page tells the operator to pin first. */
  wasmRepin?: { observed: string; source: "env" | "store"; storeKey: string };
  /**
   * Write the halt for the tripwires raised so far, NOW (runWatchdog). A check calls it the moment it
   * raises one, before its next read: a run cut off later (the Free plan gives a cron run 10 ms of
   * CPU and 50 subrequests) must not take the halt down with it.
   */
  haltNow?: () => Promise<void>;
}

/* --------------------------------- the checks --------------------------------- */

/** Minimum XLM the sponsor should be holding; below it, top-ups have stopped working. */
function balanceFloor(): number {
  const raw = process.env.SPONSOR_MIN_XLM;
  const n = raw ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 50;
}

/**
 * How many more walletless recipients the sponsor can still onboard.
 *
 * The raw balance is the wrong thing to watch. Every account the sponsor onboards adds two
 * sponsored ledger entries — the account and its USDC trustline — and each entry raises the
 * sponsor's own MINIMUM balance by the base reserve. That minimum is not spendable, so the
 * number that decides whether the next person can be onboarded is `balance - minimum`, and
 * the two diverge fast: on mainnet on 2026-08-24 the sponsor held 109 XLM against a floor of
 * 3, looking nine hundred times over — while sponsoring 186 entries, which put its minimum at
 * 94 and left capacity for ten more recipients. A floor on the raw balance would have fired
 * long AFTER onboarding had already started failing, which is the one moment it exists for.
 *
 * Reserve per recipient: THREE entries x 0.5 XLM base reserve. A sponsored 0-XLM account costs
 * its two base reserves (1 XLM) plus one for the USDC trustline, and every account the mainnet
 * sponsor has created reports `num_sponsored = 3` on Horizon. This constant said two entries (1
 * XLM) until 2026-09-06, which is why on that day the sponsor showed 33 "recipients left" against
 * a floor of 25 and stayed quiet, while the ledger said 22.
 */
const BASE_RESERVE_XLM = 0.5;
const RESERVE_PER_RECIPIENT_XLM = 3 * BASE_RESERVE_XLM;

/** Alert when fewer than this many recipients can still be onboarded. */
function capacityFloor(): number {
  const raw = process.env.SPONSOR_MIN_RECIPIENTS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 25;
}

/**
 * Alert when the escrow contract's instance or code is fewer than this many days from archival.
 *
 * Soroban state expires. When the instance or the code entry passes its `liveUntilLedgerSeq` the
 * contract is archived: the money in it is not destroyed, but every claim, reclaim and exit stops
 * working until someone pays to restore it, and nothing in the product does that on its own. The
 * deploy-time TTL was never extended on either network (found 2026-09-06: testnet had six days
 * left, mainnet about twelve weeks), so this check exists to say so with weeks of notice rather
 * than as a support ticket the morning the exits stop.
 */
function ttlFloorDays(): number {
  const raw = process.env.SPONSOR_MIN_TTL_DAYS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 21;
}

/** Ledger close time the day count assumes. Stellar targets 5s; the alert says which it used. */
const SECONDS_PER_LEDGER = 5;

/**
 * Fetch JSON from an upstream the watchdog does not control, and fail in a way a human can read.
 *
 * Every call site used to be `(await (await fetch(url)).json())`. When Horizon or the RPC answered
 * a 502 with a text body, `.json()` threw `Unexpected token 'e', "error code: 502..."` and the
 * whole check reported itself as broken. That is a page that says nothing about what went wrong,
 * for a condition that clears itself, and a monitor that cries wolf on a transient hiccup is one
 * whose next alert gets ignored.
 *
 * So: one retry with a short backoff, because these are transient by nature and this runs every
 * fifteen minutes; and on a real failure an error naming the host and the status, so the email is
 * "Horizon answered 502" rather than a parser complaint.
 */
/**
 * A source that was busy or out of reach (a throttle, a 5xx, a gateway page, no connection), as
 * opposed to an answer. A check that fails this way leaves its subject unobserved for one run, and
 * on the Worker's scheduled run it pages only once that has lasted BLIND_GRACE_MS: the public RPC
 * and Horizon both sit behind Cloudflare, Workers share their outgoing addresses, and a 15-minute
 * cron that pages on every throttled run teaches its reader to ignore pages. A considered answer (a
 * JSON-RPC error object, a 404 for the sponsor account) is not this, and still pages at once.
 */
export class SourceBusyError extends Error {}

/** How long a check may stay blind on busy sources before it pages: three missed scheduled runs. */
export const BLIND_GRACE_MS = 45 * 60_000;

/**
 * Slack on BLIND_GRACE_MS for when a cron run starts. Each run starts some seconds after its minute,
 * by a different amount every time, so without it the run 45 minutes on missed the bound whenever it
 * started less late than the first blind run had, and the page waited one more run (60 minutes). Well
 * under the 15-minute interval, so the run 30 minutes on still waits.
 */
const BLIND_START_SLACK_MS = 5 * 60_000;

/** The pause before retry `attempt` (2 or 3): 1 s then 3 s, longer when the source asks, never over 4 s. */
function retryPauseMs(attempt: number, retryAfter: string | null): number {
  const base = Number(process.env.WATCHDOG_RETRY_BASE_MS ?? "1000");
  const step = attempt <= 2 ? base : base * 3;
  const asked = retryAfter === null ? Number.NaN : Number(retryAfter) * 1000;
  return Number.isFinite(asked) && asked > step ? Math.min(asked, base * 4) : step;
}

async function fetchJson<T>(url: string): Promise<T> {
  let lastError = "";
  let retryAfter: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, retryPauseMs(attempt, retryAfter)));
    try {
      const res = await fetch(url);
      if (!res.ok) {
        lastError = `${new URL(url).host} answered ${res.status}`;
        // A 4xx other than a throttle is an answer about what was asked (a missing account), not a busy source.
        if (res.status !== 429 && res.status < 500) throw new Error(lastError);
        retryAfter = res.headers?.get?.("retry-after") ?? null;
        continue;
      }
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof Error && e.message === lastError) throw e;
      lastError = `${new URL(url).host}: ${(e as Error).message}`;
    }
  }
  throw new SourceBusyError(lastError);
}

type OpsPage = { _embedded?: { records?: Array<Record<string, unknown>> } };

/** True when the check completed; false when it could not do its job (the run is then not a full run). */
async function checkSponsorAccount(
  config: SponsorConfig,
  sponsorPublicKey: string,
  alerts: Alert[],
  run: Run,
): Promise<boolean> {
  const base = config.horizonUrl.replace(/\/$/, "");
  const acc = await fetchJson<{
    balances?: Array<{ asset_type?: string; balance?: string }>;
    subentry_count?: number;
    num_sponsoring?: number;
    status?: number;
  }>(`${base}/accounts/${sponsorPublicKey}`);
  const native = acc.balances?.find((b) => b.asset_type === "native");
  const xlm = Number.parseFloat(native?.balance ?? "0");
  if (!native) {
    alerts.push({
      severity: "page",
      title: "Sponsor account unreadable",
      detail: `Horizon returned no native balance for ${sponsorPublicKey}. The sponsor may be merged or the endpoint is down.`,
    });
    return false; // the forbidden-operation scan below did not run
  }
  const floor = balanceFloor();
  if (xlm < floor) {
    alerts.push({
      severity: "page",
      title: "Sponsor float below the floor",
      detail: `${xlm} XLM left (floor ${floor}). Top up, or find out what is spending it.`,
    });
  }

  /* The check that actually protects onboarding: spendable balance, not the headline one.
   * `num_sponsoring` counts entries whose reserve THIS account pays for, plus its own
   * subentries; both raise its minimum balance and neither can be spent. */
  const sponsoring = acc.num_sponsoring ?? 0;
  const own = acc.subentry_count ?? 0;
  const minimum = (2 + sponsoring + own) * BASE_RESERVE_XLM;
  const available = xlm - minimum;
  const recipientsLeft = Math.floor(available / RESERVE_PER_RECIPIENT_XLM);
  const capFloor = capacityFloor();
  if (recipientsLeft < capFloor) {
    /* The count stays out of the title. `alertSlug` keys the email cooldown off the title, and
     * this number ticks down with every recipient onboarded — a title carrying it would mint a
     * fresh key on each run and re-email the one condition most likely to persist for hours. */
    alerts.push({
      severity: "page",
      title: "Sponsor onboarding capacity below the floor",
      detail:
        `Only ${recipientsLeft} more recipients can be onboarded (floor ${capFloor}). ${xlm} XLM held, ` +
        `but ${minimum} is locked as the minimum balance for ${sponsoring} sponsored entries — ` +
        `${available.toFixed(4)} XLM is actually spendable, at ${RESERVE_PER_RECIPIENT_XLM} XLM per ` +
        `recipient. Top up before /create-account starts failing; the raw balance will still look ` +
        `healthy when it does.`,
    });
  }

  /* The forbidden-operation scan. /accounts/<id>/operations lists every operation that TOUCHES the
   * sponsor, payments to it included, so anyone can push a forbidden operation down the list with
   * cheap incoming traffic: with a cursor the scan therefore walks FORWARD from it page after page
   * (up to OPS_MAX_PAGES a run) and says so when it is still behind. With no cursor (a first run,
   * no store, or a key the store lost) it reads the NEWEST page: walking from the account's
   * creation re-judged months of history, and with no store it re-read the same oldest page on
   * every run and never saw a new operation. The cursor is not written here: runWatchdog writes it
   * after the halt step, so a tripwire whose halt failed is found again, and retried, next run. */
  const cursorKey = `watchdog:ops:${sponsorPublicKey}`;
  const cursorRead = await kvRead(cursorKey);
  if (!cursorRead.ok) {
    // Skipped, not restarted: this run is then not a full run, and no cursor is written.
    throw new StoreUnavailableError(
      `the operations scan cursor could not be read (${cursorRead.error}), so the forbidden-operation scan was skipped ` +
        `rather than restarted from the newest page, which would jump over every operation since the cursor`,
    );
  }
  const cursor = cursorRead.value;
  /* The one-day leniency below is for a COLD start only (no cursor: a first run, no store, a key the
     store lost), where the newest page can hold a planned SetOptions from weeks ago. A forward scan
     halts on whatever it reaches, however late: an operation reached late because incoming traffic
     buried it, or because the halt write kept failing and the cursor stayed put, is exactly the
     case that must not be downgraded (a review buried one under about 97,000 cheap payments and
     it only paged). A cursor restored from an old backup therefore halts on the old operations it
     re-walks; resume after confirming them (runbook section 4). */
  const coldStart = !cursor;
  let next = cursor;
  let tripped = false;
  const inspect = (op: Record<string, unknown>): void => {
    if (String(op.source_account ?? "") !== sponsorPublicKey) return;
    // Allowlisted, not denylisted (SPONSOR_ALLOWED_OPS): anything but the known shapes is the signal.
    const why = forbiddenSponsorOp(op, config, sponsorPublicKey);
    if (why === null) return;
    const tx = String(op.transaction_hash ?? "?");
    const createdAt = typeof op.created_at === "string" ? op.created_at : "";
    const at = Date.parse(createdAt);
    /* Older than a day: an operation the watchdog never saw happen, typically a planned SetOptions
     * (the KMS cutover, a rotation) met again after the cursor was lost or restored from an old
     * backup. Halting every exit on it would be a false alarm, so it pages a person instead. An
     * operation without a readable time is treated as recent: a theft signal is never downgraded
     * on a missing field. */
    if (coldStart && Number.isFinite(at) && run.now - at > FORBIDDEN_OP_HALT_WINDOW_MS) {
      alerts.push({
        severity: "page",
        title: FORBIDDEN_OP_OLD_TITLE,
        detail:
          `The sponsor sourced ${why} at ${createdAt} (transaction ${tx}), more than a day ago, and the watchdog ` +
          `is only now reading it (a first run, or a scan cursor the store lost). Not halted. If it was not a ` +
          `planned SetOptions or other operation you made, treat the key as compromised: halt and rotate ` +
          `(ops/RUNBOOK_SPONSOR_KEY.md section 4).`,
      });
      return;
    }
    tripped = true;
    alerts.push({
      severity: "page",
      title: TRIPWIRE_FORBIDDEN_OP,
      detail:
        `The sponsor sourced ${why}. The sponsor only opens 0-XLM accounts, sponsors their reserves, relays ` +
        `escrow calls and pays fees and rent. Transaction ${tx}${createdAt ? ` at ${createdAt}` : ""}. Treat the key ` +
        `as compromised: halt (ops/RUNBOOK_SPONSOR_KEY.md section 4) and rotate.`,
    });
  };

  const opsUrl = `${base}/accounts/${sponsorPublicKey}/operations`;
  if (!cursor) {
    const page = await fetchJson<OpsPage>(`${opsUrl}?order=desc&limit=${OPS_PAGE_SIZE}`);
    const records = page._embedded?.records ?? [];
    for (const op of records) inspect(op);
    if (records[0]?.paging_token !== undefined) next = String(records[0].paging_token); // the newest
  } else {
    let pages = 0;
    let full = false;
    let reached = "";
    do {
      const from = next;
      const page = await fetchJson<OpsPage>(
        `${opsUrl}?order=asc&limit=${OPS_PAGE_SIZE}&cursor=${encodeURIComponent(from ?? "")}`,
      );
      const records = page._embedded?.records ?? [];
      for (const op of records) {
        inspect(op);
        if (op.paging_token !== undefined) next = String(op.paging_token);
        if (typeof op.created_at === "string") reached = op.created_at;
      }
      pages += 1;
      full = records.length >= OPS_PAGE_SIZE;
      if (next === from) break; // a page that does not move the cursor would be read again forever
      // A page that raised the tripwire halts the sponsor before the next page is read.
      if (tripped && full && pages < OPS_MAX_PAGES) await run.haltNow?.();
    } while (full && pages < OPS_MAX_PAGES);
    if (full) {
      const lagMs = run.now - Date.parse(reached);
      alerts.push({
        severity: "page",
        title: OPS_SCAN_BEHIND_TITLE,
        detail:
          `This run read ${pages * OPS_PAGE_SIZE} operations of ${sponsorPublicKey} (${OPS_MAX_PAGES} pages, the per-run ` +
          `bound) and more remain: it reached operations from ${reached || "an unknown time"}` +
          (Number.isFinite(lagMs) ? `, ${Math.round(lagMs / 60_000)} minutes behind the clock` : "") +
          `. Payments TO the sponsor are listed too, so a burst of incoming operations can bury a forbidden one, ` +
          `and until the scan catches up a theft would neither page nor halt. Nothing was halted for this; the next ` +
          `run continues from here. If it repeats, read ${opsUrl}?order=desc by hand or halt.`,
      });
    }
  }
  if (next && next !== cursor) run.opsCursor = { key: cursorKey, to: next, tripped };
  return true;
}

async function checkGovernance(config: SponsorConfig, alerts: Alert[], run: Run): Promise<boolean> {
  if (!config.lumendropContract) return true; // no escrow configured: nothing to watch
  const rpcUrl = config.sorobanRpcUrl;

  // Resume from the last scanned ledger; otherwise start near the current one (the RPC only
  // retains a recent window anyway, so an unbounded backfill is not possible).
  const cursorKey = `watchdog:ledger:${config.lumendropContract}`;
  const savedRead = await kvRead(cursorKey);
  if (!savedRead.ok) {
    throw new StoreUnavailableError(
      `the ledger cursor could not be read (${savedRead.error}), so the scan was skipped rather than restarted from ` +
        `the cold-start window, which would jump over every event since the cursor`,
    );
  }
  const saved = savedRead.value;
  const latest = (await rpcCall<{ sequence?: number }>(rpcUrl, "getLatestLedger")).sequence;
  // Without a latest ledger there is no window to scan: a check that could not run says so.
  if (!latest) throw new Error("getLatestLedger answered without a ledger sequence");
  // On a cold start (no cursor) look back a bounded window — ~1h at 5s ledgers by default,
  // tunable so a first run after an incident can sweep further. With a cursor we resume from
  // it, clamped to ~24h so a long outage cannot ask the RPC for more history than it retains.
  const lookback = Number.parseInt(process.env.WATCHDOG_LOOKBACK_LEDGERS ?? "720", 10) || 720;
  const startLedger = saved
    ? Math.max(Number.parseInt(saved, 10), latest - 17_280)
    : Math.max(latest - lookback, 1);

  // An out-of-range startLedger (the RPC only retains a rolling window) comes back as a
  // JSON-RPC error, and `rpcCall` throws it rather than swallowing it: it means the watchdog
  // has a blind spot, which is a real condition.
  const events = await rpcCall<{ events?: Array<{ topic?: string[]; value?: string; ledger?: number; txHash?: string }> }>(
    rpcUrl,
    "getEvents",
    {
      startLedger,
      filters: [{ type: "contract", contractIds: [config.lumendropContract] }],
      pagination: { limit: EVENTS_PAGE_SIZE },
    },
  );

  const list = events.events ?? [];
  for (const ev of list) {
    const topics = ev.topic ?? [];
    const names = topics.map(decodeTopic);
    const hit = names.find((n) => GOVERNANCE_EVENTS.has(n));
    if (hit) {
      /* The rest of the event, decoded, so the page carries what was scheduled or transferred (the
       * timelock's wasm hash and not-before, a transfer's new owner) without a second lookup. The
       * timelock's encoding (contracts/lumen-drop 0.3.0): topics ["upgrade_proposed", wasm_hash
       * (BytesN<32>)] with the data a map {not_before: u64} in ledger seconds; "upgrade_cancelled" and
       * "upgraded" carry the hash the same way and an EMPTY map as data, never void. The OZ events
       * carry their fields in the data map too. Nothing here assumes a void. */
      const rest = topics.slice(1).map(describeScVal);
      const data = typeof ev.value === "string" ? nativeOf(ev.value) : undefined;
      const payload = (rest.length > 0 ? `; topics: ${rest.join(", ")}` : "") + (ev.value !== undefined ? `; data: ${describeNative(data)}` : "");
      const where = `Contract ${config.lumendropContract} emitted "${hit}" at ledger ${ev.ledger ?? "?"}` + (ev.txHash ? ` (tx ${ev.txHash})` : "") + payload;
      if (hit === UPGRADE_PROPOSED_EVENT) {
        const hash = rest[0] ?? "(no hash topic)";
        const notBefore = notBeforeOf(data);
        alerts.push({
          severity: "critical",
          title: `Escrow governance event: ${hit}`,
          detail:
            `${where}. New bytecode ${hash} is SCHEDULED for the escrow: it can be installed from ` +
            (notBefore
              ? `${notBefore.iso} (not_before ${notBefore.seconds}, the 7-day timelock)`
              : "the end of the 7-day timelock (the event carried no readable not_before)") +
            `, and the wasm-hash check confirms the install. If this was not you, cancel it now with cancel_upgrade ` +
            `from the owner multisig and treat the owner keys as compromised (ops/RUNBOOK_SPONSOR_KEY.md section 4).`,
        });
      } else {
        alerts.push({
          severity: "page",
          title: `Escrow governance event: ${hit}`,
          detail: `${where}. If this was not you, the owner key is compromised: halt and rotate (ops/RUNBOOK_SPONSOR_KEY.md section 4).`,
        });
      }
    }
  }
  /* A full page means the window held more events than one call returns (getEvents answers in
   * ascending order). Jumping to `latest` then skipped everything after the last one returned, a
   * governance event included, so a full page moves the cursor only to the ledger of the last
   * event it returned: the next run reads on from there (re-reading that one ledger, whose repeat
   * page the cooldown absorbs). At least one ledger forward, so a single ledger holding more events
   * than a page cannot pin the scan in place forever. */
  let nextLedger = latest;
  if (list.length >= EVENTS_PAGE_SIZE) {
    const reached = list.reduce((m, ev) => (typeof ev.ledger === "number" && ev.ledger > m ? ev.ledger : m), 0);
    nextLedger = Math.max(reached, startLedger + 1);
  }
  if (run.persist) await kvSet(cursorKey, String(nextLedger));
  return true;
}

/**
 * An `upgrade` emits no event, so the only reliable signal is the deployed bytecode itself:
 * read the contract instance's executable wasm hash and compare it to the expected one. Any
 * difference means the running code changed — the single most serious alert in this file.
 *
 * `LUMENDROP_WASM_HASH` pins the expected hash. On the first run with no pin, the observed hash
 * is recorded and used as the baseline from then on, so the check still works unconfigured.
 */
interface LedgerEntryRead {
  latestLedger: number;
  entries: Array<{ xdr: string; liveUntilLedgerSeq?: number }>;
}

/** The escrow contract's instance key, shared by the wasm and expiry checks. */
function instanceKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/**
 * How many times one JSON-RPC call is attempted before the check that made it gives up.
 *
 * Both public endpoints sit behind Cloudflare, and a throttled request answers with the
 * PLAIN-TEXT body `error code: 1015`, not JSON. A blind `.json()` turned that transient
 * throttle into `Unexpected token 'e', "error code: 1015" is not valid JSON`, paged the owner,
 * and named neither the status nor the cause. Two things follow: read the body as text and
 * report the status, and retry the transient failures, because a 15-minute cron that pages on
 * the first throttled request teaches its reader to ignore pages.
 */
const RPC_ATTEMPTS = 3;

/** The first bytes of a body that was not JSON, flattened, so the alert names what came back. */
function bodyExcerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "(empty body)";
  return flat.length > 120 ? `${flat.slice(0, 120)}...` : flat;
}

/**
 * A 4xx other than a throttle is the source answering about the request (a key it refuses, a wrong
 * URL, a firewall block such as Cloudflare's 403 "error code: 1020"), not a busy source: it pages at
 * once, as it does from Horizon (fetchJson), and is not retried.
 */
function refusedNotBusy(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

/**
 * One JSON-RPC call. Retries a body that is not JSON, an unreachable host and an answer with
 * neither result nor error; a JSON-RPC `error` object is a considered answer (a bad key, a
 * startLedger outside the retained window) so it throws on the spot, unretried, and so does a 4xx
 * other than 429 (refusedNotBusy).
 */
async function rpcCall<T>(url: string, method: string, params?: unknown): Promise<T> {
  let last = `${method}: the RPC was never reached`;
  let retryAfter: string | null = null;
  for (let attempt = 1; attempt <= RPC_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, retryPauseMs(attempt, retryAfter)));
    let status = 0;
    let body: string;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
      });
      status = res.status;
      retryAfter = res.headers?.get?.("retry-after") ?? null;
      body = await res.text();
    } catch (e) {
      last = `${method}: the RPC could not be reached (${(e as Error).message})`;
      continue;
    }
    let parsed: { result?: T; error?: { message?: string } };
    try {
      parsed = JSON.parse(body) as { result?: T; error?: { message?: string } };
    } catch {
      // Cloudflare's throttle and every gateway error page answer in text or HTML, not JSON.
      last = `${method}: HTTP ${status}, and the body was not JSON: ${bodyExcerpt(body)}`;
      if (refusedNotBusy(status)) throw new Error(last);
      continue;
    }
    if (parsed.error) {
      throw new Error(`${method}: ${parsed.error.message ?? `the RPC returned an error (HTTP ${status})`}`);
    }
    if (parsed.result === undefined) {
      last = `${method}: HTTP ${status}, with neither a result nor an error`;
      if (refusedNotBusy(status)) throw new Error(last);
      continue;
    }
    return parsed.result;
  }
  throw new SourceBusyError(`${last} [${RPC_ATTEMPTS} attempts]`);
}

/** `getLedgerEntries`, with the RPC's own latest ledger and each entry's expiry kept. */
async function readLedgerEntries(config: SponsorConfig, keys: xdr.LedgerKey[]): Promise<LedgerEntryRead> {
  const result = await rpcCall<{
    latestLedger?: number;
    entries?: Array<{ xdr?: string; liveUntilLedgerSeq?: number }>;
  }>(config.sorobanRpcUrl, "getLedgerEntries", { keys: keys.map((k) => k.toXDR("base64")) });
  return {
    latestLedger: result.latestLedger ?? 0,
    entries: (result.entries ?? []).flatMap((e) =>
      e.xdr ? [{ xdr: e.xdr, liveUntilLedgerSeq: e.liveUntilLedgerSeq }] : [],
    ),
  };
}

/**
 * The instance entry is read by BOTH the wasm check and the expiry check. Reading it twice a
 * run doubles this worker's share of a public RPC's rate limit for no new information, and
 * being throttled is precisely how both checks fail at once, so they share one read. A failed
 * read stays failed for the run on purpose: re-asking a throttle inside the same second is
 * what it is telling us not to do.
 */
function instanceReader(config: SponsorConfig, contractId: string): () => Promise<LedgerEntryRead> {
  let pending: Promise<LedgerEntryRead> | undefined;
  return () => {
    if (!pending) pending = readLedgerEntries(config, [instanceKey(contractId)]);
    return pending;
  };
}

/** The wasm hash an instance entry runs, or null for a built-in (SAC) executable. */
function wasmHashOf(entryXdr: string): Buffer | null {
  const data = xdr.LedgerEntryData.fromXDR(entryXdr, "base64").contractData();
  const exec = data.val().instance().executable();
  if (exec.switch().name !== "contractExecutableWasm") return null;
  return Buffer.from(exec.wasmHash());
}

/**
 * The escrow's USDC balance on the USDC Stellar Asset Contract is a ledger entry of ITS OWN, with
 * its own rent: contract data on the SAC, key `["Balance", Address(escrow)]`, persistent. It was
 * written when the first deposit reached the escrow and the SAC only bumps it when its own
 * threshold is crossed, so it can archive months before the instance and the code (found on
 * 2026-11-08: the mainnet entry, holding the escrow's 1.5 USDC, had 20.5 days left while the
 * instance and the code had four months). An archived balance entry stops every claim, reclaim
 * and exit that moves USDC out of the escrow just as surely as an archived instance does.
 *
 * `--key-xdr` of `stellar contract extend` takes this `storageKey` (the ScVal, base64), with
 * `--id` naming the SAC, not the escrow; the full ledger key is what `getLedgerEntries` reads.
 */
function usdcBalanceKey(config: SponsorConfig, contractId: string): { sac: string; storageKey: xdr.ScVal; ledgerKey: xdr.LedgerKey } {
  const sac = config.usdc.contractId(config.networkPassphrase);
  const storageKey = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), Address.fromString(contractId).toScVal()]);
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(sac).toScAddress(),
      key: storageKey,
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  return { sac, storageKey, ledgerKey };
}

/** The ledgers the runbook extends by: just under the network maximum of 3,110,400 (about 174 days at 5 s). */
const EXTEND_LEDGERS = 3_000_000;

/** The page's titles, shared with the offline suite. */
export const STATE_EXPIRY_TITLE = "Escrow contract state expiry approaching";
export const USDC_BALANCE_MISSING_TITLE = "Escrow USDC balance entry not found";

/**
 * Days until the instance, the code or the escrow's USDC balance entry archives, whichever is
 * sooner, and a page when that is inside the floor. The alert carries the exact commands, because
 * the moment it fires is not the moment to research them; any funded key may run them, no owner or
 * sponsor key is needed (the sponsor hot key may pay too: extend_footprint_ttl is on its allowlist).
 */
async function checkStateExpiry(
  config: SponsorConfig,
  alerts: Alert[],
  readInstance: () => Promise<LedgerEntryRead>,
): Promise<boolean> {
  if (!config.lumendropContract) return true;
  const inst = await readInstance();
  const instance = inst.entries[0];
  // A missing instance is already a page from checkWasmHash; this check has nothing to add.
  if (!instance) return true;
  const hash = wasmHashOf(instance.xdr);
  const code = hash
    ? (await readLedgerEntries(config, [xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash }))])).entries[0]
    : undefined;
  const balanceKey = usdcBalanceKey(config, config.lumendropContract);
  const balance = (await readLedgerEntries(config, [balanceKey.ledgerKey])).entries[0];

  const latest = inst.latestLedger;
  const network = networkOf(config);
  const anyKey = "<any funded key>";
  const extendCommand = (target: string) =>
    `stellar contract extend ${target} --ledgers-to-extend ${EXTEND_LEDGERS} --durability persistent --source-account ${anyKey} --network ${network}`;
  const hex = hash ? hash.toString("hex") : "<wasm hash>";
  const balanceTarget = `--id ${balanceKey.sac} --key-xdr ${balanceKey.storageKey.toXDR("base64")}`;
  const entries = [
    { what: "instance", until: instance.liveUntilLedgerSeq, command: extendCommand(`--id ${config.lumendropContract}`) },
    { what: "code", until: code?.liveUntilLedgerSeq, command: extendCommand(`--wasm-hash ${hex}`) },
    { what: "USDC balance", until: balance?.liveUntilLedgerSeq, command: extendCommand(balanceTarget) },
  ];
  const lives = entries.filter((l): l is { what: string; until: number; command: string } => typeof l.until === "number");
  if (!latest || lives.length === 0) throw new Error("the RPC answered without ledger expiry data");

  const daysOf = (until: number) => ((until - latest) * SECONDS_PER_LEDGER) / 86_400;
  if (!balance) {
    /* The entry exists from the first deposit on, and the RPC does not return an archived one, so on
     * an escrow that has ever held USDC its absence means it archived. Never a halt: the money is
     * not lost, and a halt would also close the exits that do not touch this entry. */
    alerts.push({
      severity: "page",
      title: USDC_BALANCE_MISSING_TITLE,
      detail:
        `No live ledger entry for the escrow's USDC balance (contract data on the USDC Stellar Asset Contract ` +
        `${balanceKey.sac}, key ["Balance", ${config.lumendropContract}], persistent). Either the escrow has ` +
        `never held USDC, or the entry ARCHIVED and every claim, reclaim and exit that moves USDC out of the escrow ` +
        `fails until it is restored: stellar contract restore ${balanceTarget} --durability persistent ` +
        `--source-account ${anyKey} --network ${network} (then extend it: ${extendCommand(balanceTarget)}). ` +
        `Runbook: ops/RUNBOOK_STATE_EXPIRY.md.`,
    });
  }

  const soonest = lives.reduce((a, b) => (b.until < a.until ? b : a));
  const ledgersLeft = soonest.until - latest;
  const daysLeft = daysOf(soonest.until);
  const summary = lives.map((l) => `${l.what} until ledger ${l.until}, ${daysOf(l.until).toFixed(1)} days`).join("; ");
  const commands = lives.map((l) => `${l.what}: ${l.command}`).join(" ; ");

  if (daysLeft < ttlFloorDays()) {
    alerts.push({
      severity: "page",
      title: STATE_EXPIRY_TITLE,
      detail:
        `The ${soonest.what} entry archives in ${ledgersLeft} ledgers, about ${daysLeft.toFixed(1)} days at ` +
        `${SECONDS_PER_LEDGER}s per ledger (${summary}; latest ledger ${latest}; floor ${ttlFloorDays()} days). ` +
        `Once archived every claim and reclaim fails until the entries are restored. Extend every entry inside the ` +
        `floor now, from any funded key (ops/RUNBOOK_STATE_EXPIRY.md): ${commands}`,
    });
    return true;
  }
  alerts.push({
    severity: "info",
    title: "Escrow contract state expiry",
    detail: `${daysLeft.toFixed(0)} days of rent left (${summary}; latest ledger ${latest}).`,
  });
  return true;
}

async function checkWasmHash(
  config: SponsorConfig,
  alerts: Alert[],
  readInstance: () => Promise<LedgerEntryRead>,
  run: Run,
): Promise<boolean> {
  if (!config.lumendropContract) return true;
  const contract = config.lumendropContract;
  const entryXdr = (await readInstance()).entries[0]?.xdr;
  if (!entryXdr) {
    alerts.push({
      severity: "page",
      title: "Escrow contract instance not found",
      detail: `No instance entry for ${config.lumendropContract} — it may have been archived, or the id is wrong.`,
    });
    return true; // a finding about the escrow, reported: the check itself did its job
  }
  const running = wasmHashOf(entryXdr);
  if (!running) return true; // a SAC, not our contract
  const observed = running.toString("hex");

  const storeKey = `watchdog:wasm:${contract}`;
  const envPin = process.env.LUMENDROP_WASM_HASH;
  let pinned = envPin ?? null;
  if (!pinned) {
    const pinRead = await kvRead(storeKey);
    // Unreadable is not "no pin yet": taking it for one would re-pin to whatever runs now.
    if (!pinRead.ok) throw new StoreUnavailableError(`the pinned wasm hash could not be read (${pinRead.error})`);
    pinned = pinRead.value;
  }
  if (!pinned) {
    if (run.persist) await kvSet(storeKey, observed);
    return true; // first sighting becomes the baseline
  }
  if (observed === pinned) return true;

  /* This tripwire halts the sponsor, exits included, so one answer from one RPC node is not enough
   * to act on: right after an intended upgrade and its re-pin, a lagging node behind the public RPC
   * can still serve the old instance. Read again after a short pause and halt only when the second
   * read still disagrees with the pin; when the two reads disagree with each other, page and wait. */
  await new Promise((resolve) => setTimeout(resolve, run.confirmDelayMs));
  let confirmed: string | null = null;
  let unconfirmedBecause = "";
  try {
    const again = (await readLedgerEntries(config, [instanceKey(contract)])).entries[0]?.xdr;
    confirmed = again ? (wasmHashOf(again)?.toString("hex") ?? null) : null;
    if (!confirmed) unconfirmedBecause = "the second read returned no wasm instance";
  } catch (e) {
    unconfirmedBecause = `the second read failed (${(e as Error).message})`;
  }
  const seconds = run.confirmDelayMs / 1000;
  if (confirmed && confirmed !== pinned) {
    run.wasmRepin = { observed: confirmed, source: envPin ? "env" : "store", storeKey };
    alerts.push({
      severity: "page",
      title: TRIPWIRE_WASM_CHANGED,
      detail:
        `${contract} now runs wasm ${confirmed}, expected ${pinned}; two reads ${seconds} s apart agree` +
        (confirmed === observed ? "" : ` (the first one saw ${observed})`) +
        `. An upgrade emits no event, so this is the only signal. If you did not just upgrade, ` +
        `the owner key is compromised.`,
    });
    return true;
  }
  alerts.push({
    severity: "page",
    title: WASM_UNCONFIRMED_TITLE,
    detail:
      `One read of ${contract} returned wasm ${observed}, expected ${pinned}, but ` +
      (confirmed === pinned ? `a second read ${seconds} s later returned the pinned hash` : unconfirmedBecause) +
      `. A lagging RPC node is the likely cause, so nothing was halted; the next run reads again. If this ` +
      `repeats, read the instance by hand before trusting it.`,
  });
  return true;
}

/**
 * The day's sponsor fee budget (lib/caps.ts, SOW 2 D3 item b): a page at 80 percent, so a top-up
 * or a look at who is spending it happens before the value routes start refusing with "today's
 * sponsor fee budget is spent". The title carries no number (the cooldown keys off the title).
 */
async function checkFeeBudget(alerts: Alert[], run: Run): Promise<boolean> {
  const reading = await readSponsorFeeDay(feeBudgetFromEnv(run.network), run.now);
  if (reading.spentStroops === null) {
    alerts.push({
      severity: "info",
      title: "Sponsor fee budget unreadable",
      detail: `The fee counter for ${reading.day} could not be read; the routes bound it per isolate meanwhile.`,
    });
    return true; // informational by design: the routes bound the spend per isolate meanwhile
  }
  const spent = stroopsToXlm(reading.spentStroops);
  const max = stroopsToXlm(reading.maxStroops);
  if ((reading.used ?? 0) >= 0.8) {
    alerts.push({
      severity: "page",
      title: "Sponsor fee budget nearly spent",
      detail:
        `${spent} of ${max} XLM in fee bids used on ${reading.day} (${Math.round((reading.used ?? 0) * 100)} percent). ` +
        `Past the budget every value route refuses until UTC midnight. Raise MAX_DAY_FEE_XLM only if the spend is honest; ` +
        `otherwise find who is spending it (the rate limiter and the halt switch are the stops).`,
    });
    return true;
  }
  alerts.push({ severity: "info", title: "Sponsor fee budget", detail: `${spent} of ${max} XLM used on ${reading.day}.` });
  return true;
}

/* ---------------------------------- alerting ---------------------------------- */

/**
 * How long a given alert stays quiet after it has been emailed once.
 *
 * The watchdog runs every 15 minutes, and a condition worth paging about is usually one that
 * persists for hours: a float that needs topping up, a wasm hash that no longer matches. With
 * no memory between runs, every one of those emailed the same paragraph four times an hour
 * until someone fixed it — which does not make the problem more visible, it makes the next
 * alert easier to ignore. The condition is still logged on every run; only the email is held.
 */
function alertCooldownMs(): number {
  const raw = process.env.ALERT_COOLDOWN_MINUTES;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return (Number.isFinite(n) && n > 0 ? n : 360) * 60_000;
}

/** A stable identity for an alert: the title, which does not carry the changing numbers. */
function alertSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

/**
 * Drop alerts that were already emailed inside the cooldown, and reset the clock for any that
 * have since cleared, so a problem that comes back pages immediately instead of serving out a
 * stale silence. Fails OPEN: if the store is unreachable we send, because a missed page is
 * worse than a duplicate one.
 *
 * It does NOT start the cooldown: `markAlerted` does, once Resend has accepted the email. Stamping
 * here, before the send, let one failed send silence that page for six hours. `force` lets an alert
 * through whatever its cooldown says: the watchdog forces a halt that is NEW (the halt key was absent
 * before this run wrote it), because the email of the previous halt says nothing about this one.
 */
export async function withoutRepeats(
  alerts: Alert[],
  network: StellarNetwork,
  opts: { now?: number; force?: (a: Alert) => boolean } = {},
): Promise<Alert[]> {
  const now = opts.now ?? Date.now();
  const active = new Set(alerts.map((a) => alertSlug(a.title)));
  const memory = memoryOf(network);

  /* Namespaced by network (D3). These keys were `watchdog:alerting` and `watchdog:alerted:<slug>`
   * for both Workers, and the two very likely share one store: a testnet float alert stamped the
   * cooldown that the MAINNET float alert then read, and the mainnet email stayed unsent for six
   * hours. Each network now keeps its own clock. */
  const prefix = `watchdog:${network}`;
  const previousRead = await kvRead(`${prefix}:alerting`);
  const previous = previousRead.ok ? (previousRead.value ?? "") : "";
  /* A page that cleared resets its clock, in the store and in this isolate's memory alike: the
   * memory's stamps are listed too, because a page mailed during a store outage was never written
   * to the store's list, and once the outage is over it must be free to page again when it recurs. */
  for (const slug of new Set([...previous.split(",").filter(Boolean), ...memory.alerted.keys()])) {
    if (!active.has(slug)) {
      await kvSet(`${prefix}:alerted:${slug}`, "0");
      memory.alerted.delete(slug);
    }
  }
  await kvSet(`${prefix}:alerting`, [...active].join(","));

  const due: Alert[] = [];
  for (const a of alerts) {
    if (opts.force?.(a)) {
      due.push(a);
      continue;
    }
    const slug = alertSlug(a.title);
    /* The stamp the store keeps, or, while the store cannot be read, the one this isolate kept when
     * it mailed (markAlerted): the store's outage is exactly when a page would otherwise be mailed on
     * every run. The later of the two counts; a stamp the store has reset to 0 wins nothing. */
    const stored = Number.parseInt((await kvGet(`${prefix}:alerted:${slug}`)) ?? "0", 10);
    const remembered = memory.alerted.get(slug) ?? 0;
    const last = Math.max(Number.isFinite(stored) && stored > 0 ? stored : 0, remembered);
    if (last > 0 && now - last < alertCooldownMs()) continue;
    due.push(a);
  }
  return due;
}

/**
 * Start the cooldown of alerts that were DELIVERED: only after Resend answered 2xx, so a failed send
 * is retried next run. Kept in the store and in this isolate's memory, so a store that cannot be
 * written does not re-mail the same page on every run while it lasts.
 */
export async function markAlerted(alerts: Alert[], network: StellarNetwork, now = Date.now()): Promise<void> {
  const memory = memoryOf(network);
  for (const slug of new Set(alerts.map((a) => alertSlug(a.title)))) {
    memory.alerted.set(slug, now);
    await kvSet(`watchdog:${network}:alerted:${slug}`, String(now));
  }
}

/**
 * Whether the email path is wired at all. Exported so an operator can read it from /health
 * instead of inferring it from an inbox that has been quiet for a month: a watchdog with no
 * delivery keys is silent for exactly the same reason a healthy one is, and the two have to be
 * told apart from the outside.
 */
export function alertingStatus(): AlertingStatus {
  const missing: string[] = [];
  if (!process.env.RESEND_API_KEY) missing.push("RESEND_API_KEY");
  if (!(process.env.ALERT_NOTIFY_TO ?? process.env.FEEDBACK_NOTIFY_TO)) {
    missing.push("ALERT_NOTIFY_TO (or FEEDBACK_NOTIFY_TO)");
  }
  return { configured: missing.length === 0, missing };
}

/** True only when Resend accepted the email (2xx); the caller starts the cooldown on nothing less. */
async function emailAlerts(alerts: Alert[], network: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_NOTIFY_TO ?? process.env.FEEDBACK_NOTIFY_TO;
  if (!key || !to || alerts.length === 0) return false;
  // Critical first: the subject names the first alert, and a scheduled upgrade must not sit behind a float line.
  const rank = (a: Alert) => (a.severity === "critical" ? 0 : a.severity === "page" ? 1 : 2);
  const ordered = [...alerts].sort((a, b) => rank(a) - rank(b));
  const first = ordered[0]!;
  const body = ordered.map((a) => `[${a.severity.toUpperCase()}] ${a.title}\n${a.detail}`).join("\n\n");
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: process.env.RESEND_FROM ?? "Lumenia Watchdog <onboarding@resend.dev>",
        to: [to],
        subject:
          `${first.severity === "critical" ? "CRITICAL: " : ""}Lumenia ${network} alert: ${first.title}` +
          (ordered.length > 1 ? ` (+${ordered.length - 1} more)` : ""),
        text: body,
      }),
    });
    if (!res.ok) console.log(`[watchdog] resend returned ${res.status}`);
    return res.ok;
  } catch (e) {
    console.log(`[watchdog] alert email failed: ${(e as Error).message}`);
    return false;
  }
}

/** The auto-halt page when the halt landed: how to resume, and for a wasm change what to pin FIRST. */
function haltedDetail(network: StellarNetwork, why: string, run: Run, forbiddenOp: boolean, scanMoved: boolean): string {
  const del = (key: string) => `curl -H "authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/${key}"`;
  const parts = [`Every value route on ${network} answers 503 from now (key ${haltKey(network)}). Tripwire: ${why}.`];
  if (run.wasmRepin) {
    /* The env pin wins over everything (checkWasmHash), so deleting the halt key while it still
     * names the old hash buys fifteen minutes: the next run compares again and halts again. */
    const r = run.wasmRepin;
    parts.push(
      r.source === "env"
        ? `If the upgrade was yours: FIRST set LUMENDROP_WASM_HASH = "${r.observed}" in the ` +
            `${network === "mainnet" ? "[env.mainnet.vars]" : "[vars]"} block of apps/sponsor/wrangler.toml and deploy ` +
            `this Worker, THEN resume. Resuming first only lasts until the next run, which sees the old pin and halts again.`
        : `If the upgrade was yours: FIRST record the new baseline ` +
            `(curl -H "authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/set/${r.storeKey}/${r.observed}", ` +
            `or pin LUMENDROP_WASM_HASH and deploy), THEN resume. Resuming first only lasts until the next run.`,
    );
  }
  if (forbiddenOp) {
    parts.push(
      `For the sponsor-sourced operation: confirm it was not you (the KMS cutover's and every rotation's SetOptions ` +
        `trip this by design).` +
        (scanMoved
          ? ` This run has already moved its scan past that operation, so resuming does not trip on it again; the next SetOptions will.`
          : ` The scan cursor did not move past that operation, so the next run finds it again and re-halts.`),
    );
  }
  parts.push(`To resume: ${del(haltKey(network))} and ${del(haltReasonKey(network))}. Runbook: ops/RUNBOOK_SPONSOR_KEY.md section 4.`);
  return parts.join(" ");
}

/**
 * Run every check. Never throws: a watchdog that crashes is a watchdog that stops watching, so
 * a failing check becomes its own PAGE. A check that cannot run leaves the thing it watches
 * unobserved, and an unobserved contract reads exactly like a quiet one — only `page` is
 * emailed, so anything less would leave the blind spot in a log nobody reads.
 */
export async function runWatchdog(
  config: SponsorConfig,
  sponsorPublicKey: string,
  opts: WatchdogOptions = {},
): Promise<WatchdogReport> {
  const alerts: Alert[] = [];
  const checked: string[] = [];
  /* Every key this run writes, the halt included, follows the CONFIG it was handed, never the
   * process environment: the page names the key the run wrote, whatever shell started it. */
  const network = networkOf(config);
  const now = opts.now ?? Date.now();
  const run: Run = {
    network,
    now,
    persist: opts.heartbeat === true,
    confirmDelayMs: opts.confirmDelayMs ?? WASM_CONFIRM_DELAY_MS,
  };
  const readInstance = instanceReader(config, config.lumendropContract ?? "");

  /* AUTO-HALT, on the two key-compromise tripwires and nothing else (see the constants), and only
   * when the caller allows it (`autoHalt`, which only the Worker's scheduled run passes). The halt
   * goes through the same store key the kill switch reads, namespaced to the network of the CONFIG,
   * so a testnet watchdog can never stop the mainnet sponsor. A store without a key, or a store that
   * refuses the write, leaves the page as the only answer, and the page says so.
   *
   * It is WRITTEN the moment a tripwire is raised, before any remaining read: right after the page
   * of operations that raised it (checkSponsorAccount), and right after the check that raised it.
   * On the Workers Free plan a cron run gets 10 ms of CPU and 50 subrequests, and the run that
   * finds a theft is the long one (a backlog of pages, the wasm confirm read, the emails); written
   * at the end, the halt died with any run cut off before it. The PAGE is still built at the end,
   * from everything the run found. One write per distinct tripwire list: a second tripwire later in
   * the run rewrites the halt so its reason names both, and a store that refuses is not asked again
   * on every page (the next run retries, as before). */
  let autoHalted = false;
  let attemptedWhy = "";
  let haltFailure = "";
  /** The halt key before this run's first write (undefined: not read yet). A halt is NEW when it was absent. */
  let before: boolean | null | undefined;
  const tripwireWhy = (): string =>
    [...new Set(alerts.filter((a) => isAutoHaltTripwire(a.title)).map((a) => a.title))].join("; ");
  const haltNow = async (): Promise<void> => {
    if (!opts.autoHalt) return;
    const why = tripwireWhy();
    if (!why || why === attemptedWhy) return;
    attemptedWhy = why;
    if (before === undefined) before = await storeHaltIsSet(network); // asked before the write
    try {
      if (await setHalt(network, `watchdog auto-halt: ${why}`, now)) {
        autoHalted = true;
        haltFailure = "";
      }
    } catch (e) {
      haltFailure = (e as Error).message;
    }
  };
  run.haltNow = haltNow;

  /* BLIND CHECKS (see SourceBusyError). When each check began failing on busy sources, in ONE store
   * key, so a run costs one read and, only when something changed, one write. A store that cannot be
   * read, or no store at all, leaves no memory of earlier runs, and then a failed check pages at once,
   * as before: the grace never outlives the record it depends on (and a store that refuses the write
   * pages the failures that waited on it, below). Only the Worker's scheduled run (persist) uses it;
   * an operator's run reports every failure as a page. */
  const blindKey = `watchdog:${network}:blind`;
  let blindKnown = false;
  let blindBefore: Record<string, number> = {};
  /** The store could not answer the blind ledger: evidence of a store outage even if no check needed a cursor. */
  let blindUnreadable = false;
  if (run.persist && kvConfigFromEnv()) {
    const read = await kvRead(blindKey);
    if (read.ok) {
      blindKnown = true;
      try {
        const parsed = JSON.parse(read.value ?? "{}") as unknown;
        if (parsed && typeof parsed === "object") blindBefore = parsed as Record<string, number>;
      } catch {
        blindBefore = {};
      }
    } else {
      blindUnreadable = true;
    }
  }
  const blindNow: Record<string, number> = {};
  /** The failures this run let wait as info lines, each resting on its start time in the ledger. */
  const waiting: Array<{ alert: Alert; slug: string; since: number; lead: string; why: string }> = [];
  /** The checks this scheduled run skipped because the STORE could not answer (StoreUnavailableError), folded into one line below. */
  const storeSkipped: Array<{ check: string; why: string }> = [];
  const checkFailed = (title: string, lead: string, e: unknown): void => {
    const why = (e as Error).message;
    if (e instanceof StoreUnavailableError && run.persist) {
      storeSkipped.push({ check: title.replace(/^Watchdog check failed: /, ""), why });
      return;
    }
    if (!(e instanceof SourceBusyError) || !run.persist || !blindKnown) {
      alerts.push({ severity: "page", title, detail: `${lead}: ${why}` });
      return;
    }
    const slug = alertSlug(title);
    const seen = Number(blindBefore[slug]);
    const since = Number.isFinite(seen) && seen > 0 && seen <= now ? seen : now;
    blindNow[slug] = since;
    const minutes = Math.round((now - since) / 60_000);
    if (now - since >= BLIND_GRACE_MS - BLIND_START_SLACK_MS) {
      alerts.push({
        severity: "page",
        title,
        detail:
          `${lead}: ${why}. Every run for ${minutes} minutes (since ${new Date(since).toISOString()}) found the ` +
          `source busy or out of reach.`,
      });
      return;
    }
    const alert: Alert = {
      severity: "info",
      title,
      detail:
        `${lead}: ${why}. A busy or unreachable source ${minutes > 0 ? `for ${minutes} minutes so far` : "on this run"}; ` +
        `it pages if this lasts ${BLIND_GRACE_MS / 60_000} minutes, and the heartbeat opens an issue after 3 hours ` +
        `without a full run.`,
    };
    waiting.push({ alert, slug, since, lead, why });
    alerts.push(alert);
  };

  try {
    if (await checkSponsorAccount(config, sponsorPublicKey, alerts, run)) checked.push("sponsor-account");
  } catch (e) {
    checkFailed("Watchdog check failed: sponsor account", "The sponsor float check or forbidden-op scan did not complete", e);
  }
  await haltNow(); // a forbidden operation halts before the next check reads anything

  try {
    if (await checkGovernance(config, alerts, run)) checked.push("escrow-governance");
  } catch (e) {
    checkFailed("Watchdog check failed: escrow governance", "Governance events are unobserved until this clears", e);
  }

  try {
    if (await checkWasmHash(config, alerts, readInstance, run)) checked.push("escrow-wasm");
  } catch (e) {
    checkFailed("Watchdog check failed: escrow wasm hash", "An upgrade would go unnoticed until this clears", e);
  }
  await haltNow(); // a confirmed wasm change halts before the expiry and fee reads

  try {
    if (await checkStateExpiry(config, alerts, readInstance)) checked.push("escrow-ttl");
  } catch (e) {
    checkFailed("Watchdog check failed: escrow state expiry", "Archival would arrive unannounced until this clears", e);
  }

  try {
    if (await checkFeeBudget(alerts, run)) checked.push("fee-budget");
  } catch (e) {
    checkFailed("Watchdog check failed: fee budget", "The day's fee spend is unobserved until this clears", e);
  }

  /* THE STORE OUTAGE, as one line. A store that cannot be read is the blind source every check
   * rests on at once: the scans above were skipped (never restarted), the cooldown and the heartbeat
   * below cannot be written. Paging each skipped check at once, with no cooldown to hold it, mailed
   * on every run of both Workers (about eight mails an hour) until the Resend quota was spent, and
   * the theft and float pages the outage might mask were then refused. So the outage gets the grace
   * every other blind source gets, counted in this isolate's memory because the store cannot keep
   * it, and ONE page per outage once it has lasted BLIND_GRACE_MS; before that, and after, an info
   * line. A cold isolate on every run counts no grace and pages nothing: the heartbeat it cannot
   * write is then the alarm, through the dead-man workflow. An operator's run (no heartbeat) still
   * pages every failure at once, as before. */
  const memory = memoryOf(network);
  if (run.persist) {
    if (storeSkipped.length > 0 || blindUnreadable) {
      if (!memory.outage || memory.outage.since > now) memory.outage = { since: now, pagedAt: null };
      const since = memory.outage.since;
      const minutes = Math.round((now - since) / 60_000);
      const skipped = storeSkipped.length > 0 ? storeSkipped.map((s) => `${s.check} (${s.why})`).join("; ") : "no scan needed it on this run";
      const lead =
        `The store could not be read, so the scans that rest on it were SKIPPED, never restarted: ${skipped}. Every ` +
        `cursor stays where it was and the next readable run continues from it. The alert cooldown and the heartbeat ` +
        `cannot be written while this lasts, and the dead-man workflow opens an issue when the heartbeat goes stale`;
      if (memory.outage.pagedAt === null && now - since >= BLIND_GRACE_MS - BLIND_START_SLACK_MS) {
        memory.outage.pagedAt = now;
        alerts.push({
          severity: "page",
          title: STORE_UNAVAILABLE_TITLE,
          detail: `${lead}. Every run for ${minutes} minutes (since ${new Date(since).toISOString()}) found the store unavailable. Paged once per outage.`,
        });
      } else {
        alerts.push({
          severity: "info",
          title: STORE_UNAVAILABLE_TITLE,
          detail:
            `${lead}. ${minutes > 0 ? `For ${minutes} minutes so far` : "On this run"}; ` +
            (memory.outage.pagedAt === null ? `it pages once if this lasts ${BLIND_GRACE_MS / 60_000} minutes.` : `already paged at ${new Date(memory.outage.pagedAt).toISOString()}.`),
        });
      }
    } else {
      memory.outage = null; // the store answered: a later outage is a new one
    }
  }

  /* The halt step's REPORT. Every write already happened as its tripwire was raised (`haltNow`);
   * this call only covers a tripwire some later check might one day raise, and writes nothing new. */
  await haltNow();
  // A halt is NEW when its key was absent before this run wrote it (unknown counts as absent).
  const freshHalt = autoHalted && before !== true;
  /* The forbidden-operation cursor moves only once the halt step is decided. Past a tripwire it
   * moves only after the halt has landed (or when this run was never going to halt), so a halt
   * write that failed is retried by the next run instead of being scanned past for good. */
  let cursorDone = false;
  const moveOpsCursor = async (): Promise<boolean> => {
    if (cursorDone) return false;
    cursorDone = true;
    const ops = run.opsCursor;
    if (!run.persist || !ops || (ops.tripped && opts.autoHalt && !autoHalted)) return false;
    return kvSet(ops.key, ops.to);
  };
  const tripped = alerts.filter((a) => isAutoHaltTripwire(a.title));
  if (tripped.length > 0 && opts.autoHalt) {
    const why = tripwireWhy();
    const scanMoved = autoHalted ? await moveOpsCursor() : false;
    alerts.push(
      autoHalted
        ? {
            severity: "page",
            title: AUTO_HALT_TITLE,
            detail: haltedDetail(network, why, run, tripped.some((a) => a.title === TRIPWIRE_FORBIDDEN_OP), scanMoved),
          }
        : {
            severity: "page",
            title: AUTO_HALT_FAILED_TITLE,
            detail:
              `The tripwire fired (${why}) but the halt could NOT be written (${haltFailure || "no store configured"}), so the ` +
              `sponsor is still running. Halt by hand NOW: SPONSOR_HALT=1 and deploy, or SET ${haltKey(network)} to 1 in ` +
              `the store. Every run until a halt lands finds the tripwire again and retries the write (the scan does not ` +
              `move past the operation before then). Runbook: ops/RUNBOOK_SPONSOR_KEY.md section 4.`,
          },
    );
  } else if (tripped.length > 0) {
    alerts.push({
      severity: "info",
      title: AUTO_HALT_SKIPPED_TITLE,
      detail:
        `${tripped.map((a) => a.title).join("; ")}: this run was started without autoHalt, so it wrote no halt ` +
        `(${haltKey(network)}). Only the Worker's scheduled run halts on its own.`,
    });
  }

  await moveOpsCursor(); // no-op when the halt branch above already moved it

  /* The blind ledger, written BEFORE anything is logged or mailed: a failure this run let wait rests
   * on the start time this write keeps. When the store refuses it, the next run would find no start
   * and wait again, and again on every run after that, so each failure whose start was not already
   * in the store pages now instead. */
  if (run.persist && blindKnown) {
    const norm = (m: Record<string, number>) => JSON.stringify(Object.keys(m).sort().map((k) => [k, Number(m[k])]));
    if (norm(blindNow) !== norm(blindBefore) && !(await kvSet(blindKey, JSON.stringify(blindNow)))) {
      for (const w of waiting) {
        if (Number(blindBefore[w.slug]) === w.since) continue; // its start is already kept from an earlier run
        w.alert.severity = "page";
        w.alert.detail = `${w.lead}: ${w.why}. The store could not save when this began, so the grace cannot be counted and it pages now.`;
      }
    }
  }

  const alerting = alertingStatus();
  if (!alerting.configured) {
    alerts.push({
      severity: "page",
      title: "Watchdog cannot deliver alerts",
      detail:
        `${alerting.missing.join(" and ")} unset, so every alert on this run — including any above ` +
        `— exists only in \`wrangler tail\`. Set them (wrangler secret put) or the sponsor is ` +
        `running unmonitored.`,
    });
  }

  for (const a of alerts) {
    const line = `[watchdog:${a.severity}] ${a.title} - ${a.detail}`;
    if (a.severity === "info") console.log(line);
    else console.error(line);
  }
  /* With no delivery there is nothing to de-duplicate, and running the cooldown anyway would
   * stamp every live condition as "already sent" (buying hours of silence on the first run
   * after someone finally sets the keys). A read-only run (no heartbeat) sends nothing either: its
   * email would read exactly like the Worker's, and its cooldown stamps would silence the Worker's. */
  if (run.persist && alerting.configured) {
    const force = freshHalt ? (a: Alert) => a.title === AUTO_HALT_TITLE || isAutoHaltTripwire(a.title) : undefined;
    const due = await withoutRepeats(alerts.filter((a) => a.severity !== "info"), network, { now, force });
    if (due.length > 0 && (await emailAlerts(due, network))) await markAlerted(due, network, now);
  }

  /* The heartbeat, written LAST and on every scheduled run: a run that got this far completed,
   * whatever it found. The dead-man workflow (.github/workflows/watchdog-heartbeat.yml) reads it
   * through /health and raises an issue when it is older than 45 minutes, which is the one failure
   * this file cannot report about itself: not running at all. The full-run stamp goes stale while
   * any check keeps failing, which is the other one: running, but blind. */
  let lastRun: string | null = null;
  let lastFullRun: string | null = null;
  if (opts.heartbeat) {
    const stamp = new Date(now).toISOString();
    if (await kvSet(lastRunKey(network), stamp)) lastRun = stamp;
    if (CHECKS.every((c) => checked.includes(c)) && (await kvSet(lastFullRunKey(network), stamp))) lastFullRun = stamp;
  }

  return { checked, alerts, alerting, autoHalted, lastRun, lastFullRun };
}
