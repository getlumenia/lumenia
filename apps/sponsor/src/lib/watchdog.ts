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
 *   2. **Sponsor sourcing value** — the sponsor creates accounts and pays fees. It must NEVER
 *      source a payment or merge its account. One of those in the history is the signature of a
 *      stolen key, and it is the alert that should wake someone up.
 *   3. **Escrow governance calls** — pause/unpause/upgrade/ownership are rare and human-initiated.
 *      An unexpected one means the owner key is compromised.
 *
 * Alerts go to the console (visible in `wrangler tail`) and, when RESEND_API_KEY +
 * ALERT_NOTIFY_TO are set, by email. Cursors live in the same Upstash store as the rate limiter;
 * with no store the watchdog still performs every check, it just re-scans a fixed recent window
 * instead of resuming exactly where it left off.
 */
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { SponsorConfig } from "./config.js";
import { kvConfigFromEnv } from "./rate-limit.js";

/** Operations the sponsor must never be the source of — each is a way to move value out. */
const FORBIDDEN_SOURCE_OPS = new Set([
  "payment",
  "path_payment_strict_send",
  "path_payment_strict_receive",
  "account_merge",
  "manage_sell_offer",
  "manage_buy_offer",
]);

/**
 * Escrow event names that are always worth a page. These are the DECODED first topics, which is
 * what OpenZeppelin's Ownable/Pausable modules emit — `paused`/`unpaused` for the pause switch,
 * and the ownership-transfer events. Note that `upgrade` emits NOTHING (OZ's implementation just
 * calls `update_current_contract_wasm`), which is why an upgrade is detected by watching the
 * deployed wasm hash instead — see `checkWasmHash`.
 */
const GOVERNANCE_EVENTS = new Set([
  "paused",
  "unpaused",
  "ownership_transfer_started",
  "ownership_transfer_completed",
  "ownership_renounced",
  "owner_set",
  "role_granted",
  "role_revoked",
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

export interface Alert {
  severity: "page" | "info";
  title: string;
  detail: string;
}

export interface WatchdogReport {
  checked: string[];
  alerts: Alert[];
}

/* ------------------------------- cursor storage ------------------------------- */

async function kvGet(key: string): Promise<string | null> {
  const kv = kvConfigFromEnv();
  if (!kv) return null;
  try {
    const res = await fetch(`${kv.url}/get/${key}`, { headers: { authorization: `Bearer ${kv.token}` } });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: unknown };
    return typeof body.result === "string" ? body.result : null;
  } catch {
    return null;
  }
}

async function kvSet(key: string, value: string): Promise<void> {
  const kv = kvConfigFromEnv();
  if (!kv) return;
  try {
    await fetch(`${kv.url}/set/${key}/${encodeURIComponent(value)}`, {
      headers: { authorization: `Bearer ${kv.token}` },
    });
  } catch {
    /* a cursor we fail to persist just means the next run re-scans — never fatal */
  }
}

/* --------------------------------- the checks --------------------------------- */

/** Minimum XLM the sponsor should be holding; below it, top-ups have stopped working. */
function balanceFloor(): number {
  const raw = process.env.SPONSOR_MIN_XLM;
  const n = raw ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 50;
}

async function checkSponsorAccount(
  config: SponsorConfig,
  sponsorPublicKey: string,
  alerts: Alert[],
): Promise<void> {
  const base = config.horizonUrl.replace(/\/$/, "");
  const acc = (await (await fetch(`${base}/accounts/${sponsorPublicKey}`)).json()) as {
    balances?: Array<{ asset_type?: string; balance?: string }>;
    status?: number;
  };
  const native = acc.balances?.find((b) => b.asset_type === "native");
  const xlm = Number.parseFloat(native?.balance ?? "0");
  if (!native) {
    alerts.push({
      severity: "page",
      title: "Sponsor account unreadable",
      detail: `Horizon returned no native balance for ${sponsorPublicKey}. The sponsor may be merged or the endpoint is down.`,
    });
    return;
  }
  const floor = balanceFloor();
  if (xlm < floor) {
    alerts.push({
      severity: "page",
      title: "Sponsor float below the floor",
      detail: `${xlm} XLM left (floor ${floor}). Top up, or find out what is spending it.`,
    });
  }

  // Walk operations forward from the last cursor and flag any value-moving op the sponsor
  // sourced. Order ascending so the cursor advances monotonically.
  const cursorKey = `watchdog:ops:${sponsorPublicKey}`;
  const cursor = await kvGet(cursorKey);
  const url =
    `${base}/accounts/${sponsorPublicKey}/operations?order=asc&limit=100` +
    (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
  const page = (await (await fetch(url)).json()) as {
    _embedded?: { records?: Array<Record<string, unknown>> };
  };
  const records = page._embedded?.records ?? [];
  let last = cursor;
  for (const op of records) {
    last = String(op.paging_token ?? last);
    const type = String(op.type ?? "");
    const source = String(op.source_account ?? "");
    if (source === sponsorPublicKey && FORBIDDEN_SOURCE_OPS.has(type)) {
      alerts.push({
        severity: "page",
        title: "Sponsor SOURCED a value-moving operation",
        detail:
          `The sponsor only creates accounts and pays fees — it must never source a ${type}. ` +
          `Transaction ${String(op.transaction_hash ?? "?")}. Treat the key as compromised: halt ` +
          `(ops/RUNBOOK_SPONSOR_KEY.md §4) and rotate.`,
      });
    }
  }
  if (last && last !== cursor) await kvSet(cursorKey, last);
}

async function checkGovernance(config: SponsorConfig, alerts: Alert[]): Promise<void> {
  if (!config.lumendropContract) return;
  const rpcUrl = config.sorobanRpcUrl;

  // Resume from the last scanned ledger; otherwise start near the current one (the RPC only
  // retains a recent window anyway, so an unbounded backfill is not possible).
  const cursorKey = `watchdog:ledger:${config.lumendropContract}`;
  const saved = await kvGet(cursorKey);
  const latestRes = (await (
    await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
    })
  ).json()) as { result?: { sequence?: number } };
  const latest = latestRes.result?.sequence;
  if (!latest) return;
  // On a cold start (no cursor) look back a bounded window — ~1h at 5s ledgers by default,
  // tunable so a first run after an incident can sweep further. With a cursor we resume from
  // it, clamped to ~24h so a long outage cannot ask the RPC for more history than it retains.
  const lookback = Number.parseInt(process.env.WATCHDOG_LOOKBACK_LEDGERS ?? "720", 10) || 720;
  const startLedger = saved
    ? Math.max(Number.parseInt(saved, 10), latest - 17_280)
    : Math.max(latest - lookback, 1);

  const eventsRes = (await (
    await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getEvents",
        params: {
          startLedger,
          filters: [{ type: "contract", contractIds: [config.lumendropContract] }],
          pagination: { limit: 200 },
        },
      }),
    })
  ).json()) as {
    result?: { events?: Array<{ topic?: string[]; ledger?: number; txHash?: string }> };
    error?: { message?: string };
  };
  // An out-of-range startLedger (the RPC only retains a rolling window) is a real condition,
  // not something to swallow: it means the watchdog has a blind spot.
  if (eventsRes.error) throw new Error(`getEvents: ${eventsRes.error.message}`);

  for (const ev of eventsRes.result?.events ?? []) {
    const names = (ev.topic ?? []).map(decodeTopic);
    const hit = names.find((n) => GOVERNANCE_EVENTS.has(n));
    if (hit) {
      alerts.push({
        severity: "page",
        title: `Escrow governance event: ${hit}`,
        detail:
          `Contract ${config.lumendropContract} emitted "${hit}" at ledger ${ev.ledger ?? "?"}` +
          (ev.txHash ? ` (tx ${ev.txHash})` : "") +
          `. If this was not you, the owner key is compromised — halt and rotate ` +
          `(ops/RUNBOOK_SPONSOR_KEY.md §4).`,
      });
    }
  }
  await kvSet(cursorKey, String(latest));
}

/**
 * An `upgrade` emits no event, so the only reliable signal is the deployed bytecode itself:
 * read the contract instance's executable wasm hash and compare it to the expected one. Any
 * difference means the running code changed — the single most serious alert in this file.
 *
 * `LUMENDROP_WASM_HASH` pins the expected hash. On the first run with no pin, the observed hash
 * is recorded and used as the baseline from then on, so the check still works unconfigured.
 */
async function checkWasmHash(config: SponsorConfig, alerts: Alert[]): Promise<void> {
  if (!config.lumendropContract) return;
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(config.lumendropContract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const res = (await (
    await fetch(config.sorobanRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getLedgerEntries",
        params: { keys: [key.toXDR("base64")] },
      }),
    })
  ).json()) as { result?: { entries?: Array<{ xdr?: string }> }; error?: { message?: string } };
  if (res.error) throw new Error(`getLedgerEntries: ${res.error.message}`);

  const entryXdr = res.result?.entries?.[0]?.xdr;
  if (!entryXdr) {
    alerts.push({
      severity: "page",
      title: "Escrow contract instance not found",
      detail: `No instance entry for ${config.lumendropContract} — it may have been archived, or the id is wrong.`,
    });
    return;
  }
  const data = xdr.LedgerEntryData.fromXDR(entryXdr, "base64").contractData();
  const instance = data.val().instance();
  const exec = instance.executable();
  if (exec.switch().name !== "contractExecutableWasm") return; // a SAC, not our contract
  const observed = Buffer.from(exec.wasmHash()).toString("hex");

  const pinned = process.env.LUMENDROP_WASM_HASH ?? (await kvGet(`watchdog:wasm:${config.lumendropContract}`));
  if (!pinned) {
    await kvSet(`watchdog:wasm:${config.lumendropContract}`, observed);
    return; // first sighting becomes the baseline
  }
  if (observed !== pinned) {
    alerts.push({
      severity: "page",
      title: "Escrow WASM CHANGED — the contract was upgraded",
      detail:
        `${config.lumendropContract} now runs wasm ${observed}, expected ${pinned}. ` +
        `An upgrade emits no event, so this is the only signal. If you did not just upgrade, ` +
        `the owner key is compromised.`,
    });
  }
}

/* ---------------------------------- alerting ---------------------------------- */

async function emailAlerts(alerts: Alert[]): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_NOTIFY_TO ?? process.env.FEEDBACK_NOTIFY_TO;
  if (!key || !to || alerts.length === 0) return;
  const body = alerts.map((a) => `[${a.severity.toUpperCase()}] ${a.title}\n${a.detail}`).join("\n\n");
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: "Lumenia Watchdog <onboarding@resend.dev>",
        to: [to],
        subject: `Lumenia alert: ${alerts[0]!.title}${alerts.length > 1 ? ` (+${alerts.length - 1} more)` : ""}`,
        text: body,
      }),
    });
    if (!res.ok) console.log(`[watchdog] resend returned ${res.status}`);
  } catch (e) {
    console.log(`[watchdog] alert email failed: ${(e as Error).message}`);
  }
}

/**
 * Run every check. Never throws: a watchdog that crashes is a watchdog that stops watching, so
 * a failing check becomes its own alert.
 */
export async function runWatchdog(config: SponsorConfig, sponsorPublicKey: string): Promise<WatchdogReport> {
  const alerts: Alert[] = [];
  const checked: string[] = [];

  try {
    await checkSponsorAccount(config, sponsorPublicKey, alerts);
    checked.push("sponsor-account");
  } catch (e) {
    alerts.push({
      severity: "info",
      title: "Watchdog check failed: sponsor account",
      detail: (e as Error).message,
    });
  }

  try {
    await checkGovernance(config, alerts);
    checked.push("escrow-governance");
  } catch (e) {
    alerts.push({
      severity: "info",
      title: "Watchdog check failed: escrow governance",
      detail: (e as Error).message,
    });
  }

  try {
    await checkWasmHash(config, alerts);
    checked.push("escrow-wasm");
  } catch (e) {
    alerts.push({
      severity: "info",
      title: "Watchdog check failed: escrow wasm hash",
      detail: (e as Error).message,
    });
  }

  for (const a of alerts) {
    const line = `[watchdog:${a.severity}] ${a.title} — ${a.detail}`;
    if (a.severity === "page") console.error(line);
    else console.log(line);
  }
  await emailAlerts(alerts.filter((a) => a.severity === "page"));

  return { checked, alerts };
}
