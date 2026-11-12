// Everything that touches the NEAR RPC lives here behind the ChainPort
// interface so the library can be tested with a fake chain. Real calls use
// near-api-js 7: provider.callFunction for views, Account.callFunctionRaw for
// transactions (waitUntil FINAL so the escrow receipts have executed when the
// call returns).
import {
  Account,
  FailoverRpcProvider,
  JsonRpcProvider,
  KeyPairSigner,
  actions,
  baseEncode,
  teraToGas,
  type KeyPairString,
  type Provider,
} from "near-api-js";
import type { LumeniaConfig } from "./config.js";

export interface TxOutcome {
  txHash: string;
  /** The function's return value as UTF-8 text (JSON for NEP-141 calls), or null. */
  returnValue: string | null;
  logs: string[];
  /** A JSON description of the failure when the transaction failed, else null. */
  failure: string | null;
}

export interface StorageBalance {
  total: string;
  available: string;
}

export interface NearBalance {
  total: bigint;
  available: bigint;
}

export interface ChainPort {
  getConfig(): Promise<unknown>;
  getStats(): Promise<unknown>;
  getDrop(publicKey: string): Promise<unknown>;
  ftBalanceOf(accountId: string): Promise<bigint>;
  storageBalanceOf(accountId: string): Promise<StorageBalance | null>;
  /** null when the account does not exist. */
  nearBalance(accountId: string): Promise<NearBalance | null>;
  ftTransferCall(p: { amountUnits: bigint; msg: string; gas?: bigint }): Promise<TxOutcome>;
  reclaim(publicKey: string): Promise<TxOutcome>;
  /**
   * Arm the escrow's return timer for links this funder made (`arm_return`). Waits only until
   * INCLUDED_FINAL: a transaction whose timer is pending does not reach FINAL until the timer ends.
   */
  armReturn(publicKeys: string[], gasTgas: number): Promise<{ txHash: string }>;
  storageDeposit(): Promise<TxOutcome>;
}

export class ChainError extends Error {
  override name = "ChainError";
  constructor(
    message: string,
    /** "no" when the failure happened before anything was broadcast. */
    readonly spent: "no" | "unknown",
  ) {
    super(message);
  }
}

export const USDC_STORAGE_DEPOSIT_YOCTO = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
export const FT_TRANSFER_CALL_GAS = teraToGas("100");
export const RECLAIM_GAS = teraToGas("100");
/** A batch of up to 30 drops needs more gas than a single drop. */
export const BATCH_TRANSFER_CALL_GAS = teraToGas("300");

export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const extra = (e as { type?: unknown }).type;
    return typeof extra === "string" && !e.message.includes(extra) ? `${e.message} (${extra})` : e.message;
  }
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function isUnknownAccount(e: unknown): boolean {
  return /does not exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(errorMessage(e));
}

export function makeProvider(urls: string[]): Provider {
  const providers = urls.map((url) => new JsonRpcProvider({ url }));
  if (providers.length === 1 && providers[0]) return providers[0];
  return new FailoverRpcProvider(providers);
}

/** Normalise a near-api-js transaction response into the few fields the library needs. */
export function parseOutcome(res: unknown): TxOutcome {
  const r = (res ?? {}) as {
    transaction?: { hash?: unknown };
    status?: unknown;
    transaction_outcome?: { outcome?: { logs?: unknown } };
    receipts_outcome?: Array<{ outcome?: { logs?: unknown } }>;
  };
  const txHash = typeof r.transaction?.hash === "string" ? r.transaction.hash : "";
  const logs: string[] = [];
  const push = (l: unknown) => {
    if (Array.isArray(l)) for (const x of l) if (typeof x === "string") logs.push(x);
  };
  push(r.transaction_outcome?.outcome?.logs);
  for (const ro of r.receipts_outcome ?? []) push(ro?.outcome?.logs);
  let failure: string | null = null;
  let returnValue: string | null = null;
  const status = r.status as { Failure?: unknown; SuccessValue?: unknown } | string | undefined;
  if (status && typeof status === "object") {
    if (status.Failure !== undefined) failure = JSON.stringify(status.Failure);
    if (typeof status.SuccessValue === "string") returnValue = Buffer.from(status.SuccessValue, "base64").toString("utf8");
  } else if (typeof status === "string" && status !== "SuccessValue") {
    failure = status;
  }
  return { txHash, returnValue, logs, failure };
}

export class NearChain implements ChainPort {
  private readonly provider: Provider;
  private signingAccount: Account | null = null;

  constructor(
    private readonly config: LumeniaConfig,
    private readonly keyResolver: () => string,
  ) {
    this.provider = makeProvider(config.rpcUrls);
  }

  private async view<T>(contractId: string, method: string, args: Record<string, unknown>): Promise<T> {
    try {
      return (await this.provider.callFunction({ contractId, method, args })) as T;
    } catch (e) {
      throw new ChainError(`view ${contractId}.${method} failed: ${errorMessage(e)}. Nothing was spent.`, "no");
    }
  }

  getConfig(): Promise<unknown> {
    return this.view(this.config.contractId, "get_config", {});
  }

  getStats(): Promise<unknown> {
    return this.view(this.config.contractId, "get_stats", {});
  }

  getDrop(publicKey: string): Promise<unknown> {
    return this.view(this.config.contractId, "get_drop", { public_key: publicKey });
  }

  async ftBalanceOf(accountId: string): Promise<bigint> {
    const s = await this.view<string | null>(this.config.usdcContractId, "ft_balance_of", { account_id: accountId });
    return BigInt(s ?? "0");
  }

  storageBalanceOf(accountId: string): Promise<StorageBalance | null> {
    return this.view<StorageBalance | null>(this.config.usdcContractId, "storage_balance_of", { account_id: accountId });
  }

  async nearBalance(accountId: string): Promise<NearBalance | null> {
    try {
      const state = await new Account(accountId, this.provider).getState();
      return { total: state.balance.total, available: state.balance.available };
    } catch (e) {
      if (isUnknownAccount(e)) return null;
      throw new ChainError(`view account ${accountId} failed: ${errorMessage(e)}. Nothing was spent.`, "no");
    }
  }

  private signer(): Account {
    if (!this.signingAccount) {
      const secret = this.keyResolver();
      this.signingAccount = new Account(
        this.config.funderAccountId,
        this.provider,
        KeyPairSigner.fromSecretKey(secret as KeyPairString),
      );
    }
    return this.signingAccount;
  }

  private async send(what: string, fn: () => Promise<unknown>): Promise<TxOutcome> {
    let res: unknown;
    try {
      res = await fn();
    } catch (e) {
      throw new ChainError(`${what} failed: ${errorMessage(e)}`, "unknown");
    }
    return parseOutcome(res);
  }

  ftTransferCall(p: { amountUnits: bigint; msg: string; gas?: bigint }): Promise<TxOutcome> {
    const account = this.signer();
    return this.send("ft_transfer_call", () =>
      account.callFunctionRaw({
        contractId: this.config.usdcContractId,
        methodName: "ft_transfer_call",
        args: { receiver_id: this.config.contractId, amount: p.amountUnits.toString(), msg: p.msg },
        gas: p.gas ?? FT_TRANSFER_CALL_GAS,
        deposit: 1n,
        waitUntil: "FINAL",
      }),
    );
  }

  reclaim(publicKey: string): Promise<TxOutcome> {
    const account = this.signer();
    return this.send("reclaim", () =>
      account.callFunctionRaw({
        contractId: this.config.contractId,
        methodName: "reclaim",
        args: { public_key: publicKey },
        gas: RECLAIM_GAS,
        deposit: 0n,
        waitUntil: "FINAL",
      }),
    );
  }

  async armReturn(publicKeys: string[], gasTgas: number): Promise<{ txHash: string }> {
    // Built, signed and sent in three steps so the hash is known: the RPC answers INCLUDED_FINAL with no outcome.
    const signer = KeyPairSigner.fromSecretKey(this.keyResolver() as KeyPairString);
    const account = new Account(this.config.funderAccountId, this.provider, signer);
    let hash = "";
    try {
      const tx = await account.createTransaction({
        receiverId: this.config.contractId,
        actions: [actions.functionCall("arm_return", { public_keys: publicKeys }, teraToGas(gasTgas), 0n)],
        publicKey: await signer.getPublicKey(),
      });
      const { txHash, signedTransaction } = await signer.signTransaction(tx);
      hash = baseEncode(txHash);
      await this.provider.sendTransactionUntil(signedTransaction, "INCLUDED_FINAL");
      return { txHash: hash };
    } catch (e) {
      throw new ChainError(`arm_return failed${hash ? ` (tx ${hash})` : ""}: ${errorMessage(e)}`, "unknown");
    }
  }

  storageDeposit(): Promise<TxOutcome> {
    const account = this.signer();
    return this.send("storage_deposit", () =>
      account.callFunctionRaw({
        contractId: this.config.usdcContractId,
        methodName: "storage_deposit",
        args: { account_id: this.config.funderAccountId, registration_only: true },
        gas: teraToGas("30"),
        deposit: USDC_STORAGE_DEPOSIT_YOCTO,
        waitUntil: "FINAL",
      }),
    );
  }
}
