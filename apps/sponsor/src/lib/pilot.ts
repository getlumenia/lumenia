/**
 * PILOT ALLOWLIST + PER-WALLET TX BUDGET.
 *
 * The user-funded mainnet pilot admits ONLY owner-approved wallets, and gives each a hard
 * budget of `PILOT_MAX_TX` (default 5) ledger-confirmed value operations. This is a SECOND,
 * independent bound next to the $1 per-drop cap (lib/caps.ts, set MAX_DROP_USDC=1 on the
 * mainnet Worker): caps bound how MUCH moves, this bounds WHO may move it and HOW OFTEN.
 *
 * Only active when PILOT_MODE=1 (set on the mainnet Worker). On testnet and in normal
 * operation it is a no-op — it can never gate the open product.
 *
 * Backed by the same Upstash store as the rate-limiter and caps. Because this guards REAL
 * money on mainnet it is FAIL-CLOSED: no KV, no admission. An allowlist you cannot read is
 * not an allowlist. Namespaced by network so a shared store can't let a testnet entry admit
 * a wallet on mainnet.
 *
 * The counter uses the same reserve-then-release pattern as caps: INCR reserves a slot on
 * check, and the caller releases (DECR) if the transaction fails — so only a LEDGER-CONFIRMED
 * value op permanently burns one of the wallet's slots.
 */
import { kvConfigFromEnv } from "./rate-limit.js";

/** True only when the mainnet Worker is running in pilot mode. */
export function pilotEnabled(): boolean {
  return process.env.PILOT_MODE === "1";
}

function maxTx(): number {
  const n = Number.parseInt(process.env.PILOT_MAX_TX ?? "5", 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function net(): string {
  return process.env.STELLAR_NETWORK ?? "testnet";
}

// approval flag + spend counter, namespaced by network.
const apprKey = (pk: string) => `pilot:${net()}:appr:${pk}`;
const txKey = (pk: string) => `pilot:${net()}:tx:${pk}`;

interface Kv {
  url: string;
  token: string;
}

/** Run one Upstash pipeline; throws on any command error (so callers fail closed). */
async function pipe(kv: Kv, commands: (string | number)[][]): Promise<unknown[]> {
  const res = await fetch(`${kv.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify(commands.map((c) => c.map(String))),
  });
  if (!res.ok) throw new Error(`pilot store returned ${res.status}`);
  const rows = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  for (const r of rows) if (r?.error) throw new Error(`pilot store error: ${r.error}`);
  return rows.map((r) => r.result);
}

export interface PilotVerdict {
  ok: boolean;
  reason?: string;
  /** Call this if the transaction FAILED, to hand the wallet's slot back. */
  release?: () => Promise<void>;
}

/**
 * Admit `pubkey` for one value op, or reject. On `ok: true` a slot is already reserved; the
 * caller MUST invoke `release()` if the transaction ends up failing. Fail-closed: any store
 * problem rejects.
 */
export async function enforcePilot(pubkey: string): Promise<PilotVerdict> {
  const kv = kvConfigFromEnv();
  if (!kv) return { ok: false, reason: "pilot allowlist unavailable (fail-closed)" };

  let approved: unknown;
  try {
    [approved] = await pipe(kv, [["GET", apprKey(pubkey)]]);
  } catch (e) {
    return { ok: false, reason: `pilot allowlist unreadable (fail-closed): ${(e as Error).message}` };
  }
  if (approved !== "1") {
    return { ok: false, reason: "this wallet is not on the pilot allowlist yet" };
  }

  // Reserve a slot atomically. INCR is the single source of truth against concurrent requests.
  let used: number;
  try {
    const [count] = await pipe(kv, [["INCR", txKey(pubkey)]]);
    used = Number(count);
  } catch (e) {
    return { ok: false, reason: `pilot counter unavailable (fail-closed): ${(e as Error).message}` };
  }

  const limit = maxTx();
  if (used > limit) {
    // Over budget: give the slot back so a rejected request doesn't permanently consume one.
    await pipe(kv, [["DECR", txKey(pubkey)]]).catch(() => {});
    return { ok: false, reason: `pilot limit reached: ${limit} transactions used` };
  }

  return {
    ok: true,
    release: async () => {
      await pipe(kv, [["DECR", txKey(pubkey)]]).catch(() => {});
    },
  };
}

/** Owner-only: add a wallet to the pilot allowlist with a fresh (zero) budget. */
export async function approvePilot(pubkey: string): Promise<void> {
  const kv = kvConfigFromEnv();
  if (!kv) throw new Error("pilot store not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
  await pipe(kv, [
    ["SET", apprKey(pubkey), "1"],
    ["SET", txKey(pubkey), "0"],
  ]);
}

/** Owner-only: remove a wallet from the pilot allowlist (its counter is left as an audit trail). */
export async function revokePilot(pubkey: string): Promise<void> {
  const kv = kvConfigFromEnv();
  if (!kv) throw new Error("pilot store not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
  await pipe(kv, [["DEL", apprKey(pubkey)]]);
}

/** Read a wallet's pilot status — for the owner CLI and audits. */
export async function pilotStatus(
  pubkey: string,
): Promise<{ approved: boolean; used: number; limit: number }> {
  const kv = kvConfigFromEnv();
  if (!kv) throw new Error("pilot store not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
  const [appr, tx] = await pipe(kv, [
    ["GET", apprKey(pubkey)],
    ["GET", txKey(pubkey)],
  ]);
  return { approved: appr === "1", used: Number(tx ?? 0), limit: maxTx() };
}
