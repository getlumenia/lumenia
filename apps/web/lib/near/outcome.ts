// Reading a NEAR execution outcome: did the transaction fail, did a receipt panic, what did the
// final SuccessValue say. Pure, so the self-test can hold every shape without a network.

import type { RpcTransactionResponse } from "./chain";

type StatusLike = string | { Failure?: unknown; SuccessValue?: string; SuccessReceiptId?: string };

function failureText(f: unknown): string {
  if (typeof f === "string") return f;
  try {
    const json = JSON.stringify(f);
    // The readable part of a NEAR failure: a contract panic message or the execution error text.
    for (const re of [/"panic_msg":"((?:[^"\\]|\\.)*)"/, /"ExecutionError":"((?:[^"\\]|\\.)*)"/, /"MethodResolveError":"((?:[^"\\]|\\.)*)"/]) {
      const m = re.exec(json);
      if (m?.[1]) return m[1].replace(/\\"/g, '"').replace(/^Smart contract panicked: /, "");
    }
    const kind = /"kind":\{"([A-Za-z]+)"/.exec(json)?.[1];
    return kind ? `${kind}: ${json.slice(0, 300)}` : json.slice(0, 400);
  } catch {
    return "unknown failure";
  }
}

/** The transaction-level failure, if the chain reports one. */
export function txFailure(outcome: RpcTransactionResponse): string | null {
  const s = outcome.status as StatusLike;
  if (typeof s === "object" && s.Failure !== undefined) return failureText(s.Failure);
  return null;
}

/** The first receipt that failed, for example a panic inside ft_on_transfer that ended in a refund. */
export function receiptFailure(outcome: RpcTransactionResponse): string | null {
  for (const r of outcome.receipts_outcome ?? []) {
    const s = r.outcome.status as StatusLike;
    if (typeof s === "object" && s.Failure !== undefined) return failureText(s.Failure);
  }
  return null;
}

function base64ToText(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** The final SuccessValue decoded from base64 and parsed as JSON, or null. */
export function successValue(outcome: RpcTransactionResponse): unknown {
  const s = outcome.status as StatusLike;
  if (typeof s !== "object" || typeof s.SuccessValue !== "string") return null;
  if (s.SuccessValue === "") return null;
  const text = base64ToText(s.SuccessValue);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * ft_transfer_call resolves to the amount the receiver KEPT. "0" means the contract refused the
 * drop and the token contract refunded the sender.
 */
export function ftTransferCallUsedAmount(outcome: RpcTransactionResponse): string | null {
  const v = successValue(outcome);
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}

/**
 * A claim or reclaim chain ends in the contract's callback, which returns true when the USDC moved
 * and false when the contract rolled the drop back to Open (it then logs "drop reopened: reason").
 * null when the outcome does not carry a boolean (for example a failed transaction).
 */
export function chainResult(outcome: RpcTransactionResponse): { ok: true } | { ok: false; reason: string | null } | null {
  const v = successValue(outcome);
  if (v === true) return { ok: true };
  if (v === false) {
    const log = allLogs(outcome).find((l) => l.startsWith("drop reopened:"));
    return { ok: false, reason: log ? log.slice("drop reopened:".length).trim() : null };
  }
  return null;
}

/** The contract's own reason when it handed the tokens back ("batch refused: ..." / "drop refused: ..."). */
export function refusalReason(outcome: RpcTransactionResponse): string | null {
  const log = allLogs(outcome).find((l) => /refused:/.test(l));
  return log ? log.replace(/; tokens returned$/, "") : null;
}

export function allLogs(outcome: RpcTransactionResponse): string[] {
  const logs: string[] = [...(outcome.transaction_outcome?.outcome.logs ?? [])];
  for (const r of outcome.receipts_outcome ?? []) logs.push(...r.outcome.logs);
  return logs;
}
