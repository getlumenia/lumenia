// NEAR views over plain JSON-RPC: no SDK, so a server component (/stats, /near) and a public page
// (/near/ledger) can read the contract without shipping near-api-js, and the same reader serves the
// browser screens. One URL or several (comma-separated) tried in order; a network failure moves to
// the next, an answer with an error is final.

import { NEAR_CONTRACT_ID, NEAR_RPC, NEAR_USDC_ID } from "./config";
import { isConfigView, isDropView, isStatsView, type ConfigView, type DropView, type StatsView } from "./drops";
import { describeError, isUnknownAccountError } from "./errors";

export class NearRpcError extends Error {
  override name = "NearRpcError";
  constructor(
    message: string,
    readonly code?: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface RpcOptions {
  /** Overrides NEAR_RPC. One URL or several, comma-separated. */
  urls?: string;
  /** "final" for a server read that may be cached; "optimistic" (default) to see a fresh write sooner. */
  finality?: "final" | "optimistic";
  /** Passed to fetch: a server component sets `{ next: { revalidate } }` here. */
  init?: RequestInit & { next?: { revalidate?: number | false } };
}

export function rpcUrls(urls: string = NEAR_RPC): string[] {
  return urls
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
}

interface RpcErrorBody {
  name?: string;
  code?: number;
  message?: string;
  data?: unknown;
  cause?: { name?: string; info?: unknown };
}

function rpcErrorMessage(err: RpcErrorBody): string {
  const parts = [err.message ?? "RPC error"];
  if (err.cause?.name) parts.push(err.cause.name);
  if (typeof err.data === "string") parts.push(err.data);
  return parts.join(": ");
}

export async function rpcCall<T>(method: string, params: Record<string, unknown>, opts: RpcOptions = {}): Promise<T> {
  const urls = rpcUrls(opts.urls);
  if (urls.length === 0) throw new NearRpcError("no RPC URL configured");
  let lastNetwork: unknown = null;
  for (const url of urls) {
    let res: Response;
    try {
      res = await fetch(url, {
        ...opts.init,
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.init?.headers ?? {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: "lumenia", method, params }),
      });
    } catch (e) {
      lastNetwork = e;
      continue;
    }
    if (!res.ok) {
      // 429 / 5xx from one node: the next one may answer.
      lastNetwork = new Error(`${url} answered HTTP ${res.status}`);
      continue;
    }
    const json = (await res.json()) as { result?: T; error?: RpcErrorBody };
    if (json.error) throw new NearRpcError(rpcErrorMessage(json.error), json.error.cause?.name ?? json.error.name, json.error.data);
    return json.result as T;
  }
  throw new NearRpcError(`The NEAR network did not answer (${describeError(lastNetwork)}). Check your connection and try again.`);
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** A view call. `null` for an empty or JSON-null result. */
export async function viewFunction<T>(contractId: string, method: string, args: Record<string, unknown> = {}, opts: RpcOptions = {}): Promise<T | null> {
  const r = await rpcCall<{ result: number[]; error?: string; logs?: string[] }>(
    "query",
    {
      request_type: "call_function",
      finality: opts.finality ?? "optimistic",
      account_id: contractId,
      method_name: method,
      args_base64: toBase64(JSON.stringify(args)),
    },
    opts,
  );
  if (r.error) throw new NearRpcError(`${contractId}.${method}: ${r.error}`);
  const text = new TextDecoder().decode(new Uint8Array(r.result ?? []));
  if (text === "" || text === "null") return null;
  return JSON.parse(text) as T;
}

export interface AccountView {
  amount: string;
  locked: string;
  code_hash: string;
  storage_usage: number;
}

export function viewAccount(accountId: string, opts: RpcOptions = {}): Promise<AccountView> {
  return rpcCall<AccountView>("query", { request_type: "view_account", finality: opts.finality ?? "final", account_id: accountId }, opts);
}

export interface AccessKeyView {
  nonce: number | string;
  permission: unknown;
}

export function viewAccessKey(accountId: string, publicKey: string, opts: RpcOptions = {}): Promise<AccessKeyView> {
  return rpcCall<AccessKeyView>(
    "query",
    { request_type: "view_access_key", finality: opts.finality ?? "final", account_id: accountId, public_key: publicKey },
    opts,
  );
}

// ---- the contract -------------------------------------------------------------------------------

export async function getDrop(publicKey: string, opts: RpcOptions = {}): Promise<DropView | null> {
  const r = await viewFunction<unknown>(NEAR_CONTRACT_ID, "get_drop", { public_key: publicKey }, opts);
  if (r === null) return null;
  if (!isDropView(r)) throw new NearRpcError(`get_drop returned an unexpected shape: ${JSON.stringify(r).slice(0, 200)}`);
  return r;
}

export async function getConfig(opts: RpcOptions = {}): Promise<ConfigView> {
  const r = await viewFunction<unknown>(NEAR_CONTRACT_ID, "get_config", {}, opts);
  if (!isConfigView(r)) throw new NearRpcError(`get_config returned an unexpected shape: ${JSON.stringify(r).slice(0, 200)}`);
  return r;
}

export async function getStats(opts: RpcOptions = {}): Promise<StatsView | null> {
  const r = await viewFunction<unknown>(NEAR_CONTRACT_ID, "get_stats", {}, opts);
  if (r === null) return null;
  if (!isStatsView(r)) throw new NearRpcError(`get_stats returned an unexpected shape: ${JSON.stringify(r).slice(0, 200)}`);
  return r;
}

/** The public ledger page, newest first (from_index 0 = newest; limit capped by the contract at 100). */
export async function getDrops(fromIndex: number, limit: number, opts: RpcOptions = {}): Promise<DropView[]> {
  const r = await viewFunction<unknown[]>(NEAR_CONTRACT_ID, "get_drops", { from_index: fromIndex, limit }, opts);
  return (r ?? []).filter(isDropView);
}

export async function getDropsByFunder(funder: string, fromIndex: number, limit: number, opts: RpcOptions = {}): Promise<DropView[]> {
  const r = await viewFunction<unknown[]>(NEAR_CONTRACT_ID, "get_drops_by_funder", { funder, from_index: fromIndex, limit }, opts);
  return (r ?? []).filter(isDropView);
}

/** USDC balance as a u128 string. A "0" is a real answer; a thrown error is not. */
export async function usdcBalance(accountId: string, opts: RpcOptions = {}): Promise<string> {
  const r = await viewFunction<string>(NEAR_USDC_ID, "ft_balance_of", { account_id: accountId }, opts);
  if (typeof r !== "string") throw new NearRpcError("ft_balance_of returned no balance");
  return r;
}

export async function usdcRegistered(accountId: string, opts: RpcOptions = {}): Promise<boolean> {
  const r = await viewFunction<unknown>(NEAR_USDC_ID, "storage_balance_of", { account_id: accountId }, opts);
  return r !== null;
}

export async function nearBalance(accountId: string, opts: RpcOptions = {}): Promise<bigint> {
  const a = await viewAccount(accountId, opts);
  return BigInt(a.amount);
}

/** true / false, or throws when the RPC could not be asked. */
export async function accountExists(accountId: string, opts: RpcOptions = {}): Promise<boolean> {
  try {
    await viewAccount(accountId, opts);
    return true;
  } catch (e) {
    if (isUnknownAccountError(e)) return false;
    throw e;
  }
}

const NO_CODE = "11111111111111111111111111111111";

export async function contractIsDeployed(opts: RpcOptions = {}): Promise<boolean> {
  const a = await viewAccount(NEAR_CONTRACT_ID, opts);
  return a.code_hash !== NO_CODE;
}

export async function keyBelongsToAccount(accountId: string, publicKey: string, opts: RpcOptions = {}): Promise<boolean> {
  try {
    await viewAccessKey(accountId, publicKey, opts);
    return true;
  } catch (e) {
    if (/does not exist|UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT/i.test(describeError(e))) return false;
    throw e;
  }
}
