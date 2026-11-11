// Signing and sending on NEAR (near-api-js). Views go through lib/near/rpc.ts, which needs no SDK;
// this module is loaded only by the screens that sign: the sender, the claim, the pay-forward.
//
// A transaction is built, signed and broadcast in three explicit steps so its hash is known, and
// can be written to storage, before the network ever sees it.

import {
  Account,
  FailoverRpcProvider,
  JsonRpcProvider,
  KeyPairSigner,
  actions,
  baseEncode,
  teraToGas,
  type KeyPairString,
  type Provider as NearProvider,
  type TxExecutionStatus,
} from "near-api-js";
import { NEAR_RPC } from "./config";
import { describeError } from "./errors";

export type Provider = NearProvider;

/** The RPC's final execution outcome, as near-api-js returns it (not re-exported by the package). */
export type RpcTransactionResponse = Awaited<ReturnType<NearProvider["sendTransaction"]>>;

/** `urls` is one RPC URL or several separated by commas; with several, each request fails over in order. */
export function makeProvider(urls: string = NEAR_RPC): Provider {
  const list = urls
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (list.length === 0) throw new Error("no RPC URL configured");
  const providers = list.map((url) => new JsonRpcProvider({ url }, { retries: 2, wait: 300, backoff: 1.6 }));
  return providers.length === 1 ? (providers[0] as JsonRpcProvider) : new FailoverRpcProvider(providers);
}

let shared: Provider | null = null;
/** One provider per page: near-api-js keeps no state in it beyond the retry policy. */
export function sharedProvider(): Provider {
  if (!shared) shared = makeProvider();
  return shared;
}

export interface FunctionCallRequest {
  provider?: Provider;
  /** the account whose key signs: the funder for ft_transfer_call and reclaim, the CONTRACT for claim */
  signerId: string;
  secretKey: KeyPairString;
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gasTgas: number;
  depositYocto: bigint;
  waitUntil?: TxExecutionStatus;
  /** called with the transaction hash after signing and before broadcast */
  onSigned?: (txHash: string) => void | Promise<void>;
}

export interface SentTransaction {
  txHash: string;
  outcome: RpcTransactionResponse;
}

const POLL_MS = 2000;
const POLL_LIMIT_MS = 90_000;

export async function sendFunctionCall(req: FunctionCallRequest): Promise<SentTransaction> {
  const provider = req.provider ?? sharedProvider();
  const signer = KeyPairSigner.fromSecretKey(req.secretKey);
  const account = new Account(req.signerId, provider, signer);
  const publicKey = await signer.getPublicKey();
  const transaction = await account.createTransaction({
    receiverId: req.receiverId,
    actions: [actions.functionCall(req.methodName, req.args, teraToGas(req.gasTgas), req.depositYocto)],
    publicKey,
  });
  const { txHash, signedTransaction } = await signer.signTransaction(transaction);
  const hash = baseEncode(txHash);
  // The hash is on record before anything is broadcast: a tab that dies mid-flight still knows.
  await req.onSigned?.(hash);
  const waitUntil = req.waitUntil ?? "EXECUTED_OPTIMISTIC";
  try {
    const outcome = await provider.sendTransactionUntil(signedTransaction, waitUntil);
    return { txHash: hash, outcome };
  } catch (e) {
    // The RPC gives up waiting after ~10 s while the transaction may still land. Ask by hash.
    const text = describeError(e);
    if (!/timeout|timed out|TimeoutError|ETIMEDOUT|504|503|fetch/i.test(text)) throw e;
    const outcome = await waitForTransaction(provider, hash, req.signerId, waitUntil);
    return { txHash: hash, outcome };
  }
}

export async function waitForTransaction(
  provider: Provider,
  txHash: string,
  signerId: string,
  waitUntil: TxExecutionStatus = "EXECUTED_OPTIMISTIC",
  limitMs = POLL_LIMIT_MS,
): Promise<RpcTransactionResponse> {
  const started = Date.now();
  let lastError: unknown = null;
  while (Date.now() - started < limitMs) {
    try {
      const r = await provider.viewTransactionStatus({ txHash, accountId: signerId, waitUntil });
      if (r.status !== "NotStarted" && r.status !== "Started") return r;
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(
    `The network has not confirmed transaction ${txHash} yet` +
      (lastError ? ` (${describeError(lastError)})` : "") +
      ". It may still land; check it on the explorer.",
  );
}
