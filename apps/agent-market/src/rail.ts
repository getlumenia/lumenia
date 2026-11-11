// The slice of the Lumenia NEAR library (@lumenia/near, packages/near) this
// worker uses, written down as an interface. The worker is tested against a
// fake rail; the real class is wrapped by LumeniaRail below, and TypeScript
// checks the fit at compile time (a library change that breaks the worker fails
// the build, not a live job). The worker never holds a key itself: the library
// signs with the funder key it reads from FUNDER_PRIVATE_KEY or FUNDER_KEY_FILE.
import { loadConfig, Lumenia, LumeniaError, type Env, type LumeniaConfig, type LumeniaDeps, type Receipt } from "@lumenia/near";

/** Lumenia's claim route for a NEAR link (apps/web/app/c/near); the package alone builds its standalone page's `/c`. */
export const NEAR_CLAIM_PATH = "/c/near";
/** Where the links point when WEB_ORIGIN is unset: the product, not the package's local dev page. */
export const DEFAULT_WEB_ORIGIN = "https://getlumenia.com";

export interface RailPayout {
  label: string;
  amountUsdc: string;
  memo?: string;
}

export interface RailBatchInput {
  payouts: RailPayout[];
  expiresHours: number;
  /** Idempotency key for the whole batch: a second call with the same reference pays nothing and returns the first result. */
  reference: string;
}

export interface RailLinkReceipt {
  amount_usdc: string;
  memo: string;
  status: string;
  expires_at: string;
  create_tx_hash: string | null;
  explorer_url: string | null;
}

export interface RailLink {
  label: string;
  link: string;
  publicKey: string;
  receipt: RailLinkReceipt;
}

export interface RailBatchResult {
  batchId: string;
  count: number;
  totalUsdc: string;
  txHash: string | null;
  explorerUrl: string | null;
  expiresAt: string;
  payouts: RailLink[];
  /** Set when no new payment was made (idempotent replay, or a deposit confirmed after an RPC error). */
  note?: string;
}

export interface RailDrop {
  kind: string;
  label: string;
  claimedTo: string | null;
  expiresAt: string | null;
}

export interface RailStatus {
  publicKey: string;
  status: string;
  drop: RailDrop;
}

export interface RailReclaim {
  txHash: string;
  explorerUrl: string;
}

export interface RailBalances {
  funder: string;
  usdc: { balance: string; registered: boolean };
  budget: { dailyBudgetUsdc: string; spentLast24hUsdc: string; remainingUsdc: string; maxLinkUsdc: string };
}

/** A receipt row as the library stores it, reduced to what the worker needs to rebuild a deliverable. */
export interface RailReceipt {
  publicKey: string;
  createdAt: string;
  label: string | null;
  amountUsdc: string;
  memo: string;
  status: string;
  link: string | null;
  expiresAt: string;
  txHash: string | null;
  explorerUrl: string | null;
}

export interface PayoutRail {
  /** CAIP-2 style name shown in deliverables, e.g. "near:testnet". */
  readonly network: string;
  readonly contractId: string;
  readonly usdcContractId: string;
  readonly funderAccountId: string;
  readonly webOrigin: string;
  /** Fund every payout of a job in ONE transaction; the escrow keeps all or nothing. */
  createPayLinks(input: RailBatchInput): Promise<RailBatchResult>;
  linkStatus(publicKey: string): Promise<RailStatus>;
  reclaim(publicKey: string): Promise<RailReclaim>;
  balances(): Promise<RailBalances>;
  /** Receipts the library already holds for a reference: the restart safety net. */
  receiptsByReference(reference: string): RailReceipt[];
}

/** The real thing: a thin wrapper so the library's own types stay the source of truth. */
export class LumeniaRail implements PayoutRail {
  constructor(readonly lumenia: Lumenia) {}

  /** The package's own WEB_ORIGIN default is its local dev page; a worker that mints links for buyers defaults to the product. */
  static fromEnv(env: Env = process.env): LumeniaRail {
    return new LumeniaRail(openNearRail(loadConfig({ ...env, WEB_ORIGIN: env.WEB_ORIGIN?.trim() || DEFAULT_WEB_ORIGIN })));
  }

  get network(): string {
    return `near:${this.lumenia.config.network}`;
  }
  get contractId(): string {
    return this.lumenia.config.contractId;
  }
  get usdcContractId(): string {
    return this.lumenia.config.usdcContractId;
  }
  get funderAccountId(): string {
    return this.lumenia.config.funderAccountId;
  }
  get webOrigin(): string {
    return this.lumenia.config.webOrigin;
  }

  createPayLinks(input: RailBatchInput): Promise<RailBatchResult> {
    return this.lumenia.createPayLinks(input);
  }

  linkStatus(publicKey: string): Promise<RailStatus> {
    return this.lumenia.linkStatus(publicKey);
  }

  reclaim(publicKey: string): Promise<RailReclaim> {
    return this.lumenia.reclaim(publicKey);
  }

  balances(): Promise<RailBalances> {
    return this.lumenia.balances();
  }

  receiptsByReference(reference: string): RailReceipt[] {
    return this.lumenia.store
      .all()
      .filter((r) => r.reference === reference)
      .map((r) => ({
        publicKey: r.link_public_key,
        createdAt: r.created_at,
        label: r.label,
        amountUsdc: r.amount_usdc,
        memo: r.memo,
        status: r.status,
        link: r.link ?? null,
        expiresAt: r.expires_at,
        txHash: r.create_tx_hash,
        explorerUrl: r.explorer_url,
      }));
  }
}

/**
 * The library client with Lumenia's claim path on every receipt it writes. The package builds
 * `<origin>/c#<secret>` (the path of its standalone claim page); inside Lumenia the NEAR claim
 * screen is `/c/near`, so the link is re-pathed as the receipt is written, before the deposit is
 * broadcast. The receipt log on disk (which the restart safety net reads back) and the batch
 * result the deliverable renders therefore carry the link that works. `deps` replaces the chain,
 * the store and the clock in tests. The same wrapper lives in apps/web/lib/agent-mcp.ts; both go
 * away when the package grows a configurable link path. (The package does not export its
 * LinkStore, so the store to wrap comes from a first construction.)
 */
export function openNearRail(config: LumeniaConfig, deps: LumeniaDeps = {}): Lumenia {
  const probe = new Lumenia(config, deps);
  return new Lumenia(config, { ...deps, chain: probe.chain, store: nearClaimStore(probe.store, config.webOrigin) });
}

type NearStore = Lumenia["store"];

/** A receipt store that re-paths the package's `/c#` link to Lumenia's `/c/near#` as it is written. */
export function nearClaimStore(base: NearStore, webOrigin: string): NearStore {
  const origin = webOrigin.replace(/\/+$/, "");
  const packaged = `${origin}/c#`;
  const repath = (r: Receipt) => {
    if (r.link && r.link.startsWith(packaged)) r.link = `${origin}${NEAR_CLAIM_PATH}#${r.link.slice(packaged.length)}`;
  };
  return {
    path: base.path,
    load: () => base.load(),
    save: (file) => base.save(file),
    upsert: (receipt) => {
      repath(receipt);
      base.upsert(receipt);
    },
    upsertMany: (receipts) => {
      for (const r of receipts) repath(r);
      base.upsertMany(receipts);
    },
    findByBatchId: (batchId) => base.findByBatchId(batchId),
    all: () => base.all(),
    findByPublicKey: (publicKey) => base.findByPublicKey(publicKey),
    findByReference: (reference) => base.findByReference(reference),
  };
}

/**
 * True when the library refused or failed BEFORE anything moved on chain.
 * Every LumeniaError thrown by createPayLinks carries that meaning: the
 * library writes its receipts first, confirms a deposit that landed despite an
 * RPC error, and only throws when the escrow kept nothing.
 */
export function isNothingSpentError(e: unknown): boolean {
  return e instanceof LumeniaError;
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
