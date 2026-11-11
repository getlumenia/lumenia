// Builders for signed delegates in the tests. Keys are random and never leave memory.
import {
  KeyPair,
  KeyPairSigner,
  actions,
  base64Encode,
  buildDelegateAction,
  encodeSignedDelegate,
  teraToGas,
  type Action,
  type SignedDelegate,
} from "near-api-js";
import type { PolicyContext } from "../src/relayer/policy.js";

export const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
export const ESCROW = "lumenia-near.testnet";
export const HEIGHT = 277_000_000;
export const SENDER = "alice.testnet";
export const CTX: PolicyContext = { escrowId: ESCROW, usdcId: USDC, currentBlockHeight: HEIGHT };

export function linkKey(): string {
  return KeyPair.fromRandom("ed25519").getPublicKey().toString();
}

export function linkMsg(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ public_key: linkKey(), expires_in_s: 86_400, memo: "coffee", ...overrides });
}

export function ftTransferCall(o: {
  receiverId?: string;
  amount?: unknown;
  msg?: unknown;
  gasTgas?: number;
  deposit?: bigint;
  extra?: Record<string, unknown>;
  rawArgs?: Uint8Array;
} = {}): Action {
  const args = o.rawArgs ?? {
    receiver_id: o.receiverId ?? ESCROW,
    amount: o.amount ?? "100000",
    msg: o.msg ?? linkMsg(),
    ...(o.extra ?? {}),
  };
  return actions.functionCall("ft_transfer_call", args, teraToGas(o.gasTgas ?? 100), o.deposit ?? 1n);
}

export function reclaimCall(o: { publicKey?: unknown; gasTgas?: number; deposit?: bigint; extra?: Record<string, unknown>; method?: string } = {}): Action {
  return actions.functionCall(
    o.method ?? "reclaim",
    { public_key: o.publicKey ?? linkKey(), ...(o.extra ?? {}) },
    teraToGas(o.gasTgas ?? 100),
    o.deposit ?? 0n,
  );
}

export interface SignOpts {
  senderId?: string;
  receiverId?: string;
  actions?: Action[];
  nonce?: bigint;
  maxBlockHeight?: bigint;
  keyPair?: KeyPair;
}

export interface Signed {
  signed: SignedDelegate;
  bytes: Uint8Array;
  base64: string;
  keyPair: KeyPair;
}

/** A properly signed delegate (the signature verifies) with the given overrides. */
export async function signDelegate(o: SignOpts = {}): Promise<Signed> {
  const keyPair = o.keyPair ?? KeyPair.fromRandom("ed25519");
  const delegateAction = buildDelegateAction({
    senderId: o.senderId ?? SENDER,
    receiverId: o.receiverId ?? USDC,
    actions: o.actions ?? [ftTransferCall()],
    nonce: o.nonce ?? BigInt(HEIGHT) * 1_000_000n - 5n,
    maxBlockHeight: o.maxBlockHeight ?? BigInt(HEIGHT + 300),
    publicKey: keyPair.getPublicKey(),
  });
  const { signedDelegate } = await new KeyPairSigner(keyPair).signDelegateAction(delegateAction);
  const bytes = encodeSignedDelegate(signedDelegate);
  return { signed: signedDelegate, bytes, base64: base64Encode(bytes), keyPair };
}

/** A base64 body for the given overrides (the common case in the tests). */
export async function b64(o: SignOpts = {}): Promise<string> {
  return (await signDelegate(o)).base64;
}

export function successResponse(o: {
  hash?: string;
  successValue?: string;
  logs?: string[];
  receiptFailure?: string;
} = {}): unknown {
  const sv = o.successValue === undefined ? '"100000"' : o.successValue;
  return {
    final_execution_status: "FINAL",
    status: { SuccessValue: Buffer.from(sv).toString("base64") },
    transaction: { hash: o.hash ?? "7xdZ6gQd9XGVfqgXwW1nX4z3Jm9mUoCwZ5q5h6gZJd2a" },
    transaction_outcome: { id: "tx", outcome: { logs: [], status: { SuccessReceiptId: "r1" } } },
    receipts_outcome: [
      { id: "r1", outcome: { executor_id: SENDER, logs: [], status: { SuccessReceiptId: "r2" } } },
      {
        id: "r2",
        outcome: {
          executor_id: ESCROW,
          logs: o.logs ?? [],
          status: o.receiptFailure
            ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: o.receiptFailure } } } } }
            : { SuccessValue: "" },
        },
      },
    ],
  };
}
