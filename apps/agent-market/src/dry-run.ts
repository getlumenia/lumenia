// A rail that never touches the chain: fresh keys and links are generated
// offline so `--dry-run --brief file` renders exactly the deliverable a buyer
// would get, minus transaction hashes. Nothing is escrowed, nothing is stored.
import { newLinkKey, type LinkKey } from "@lumenia/near";
import { NEAR_CLAIM_PATH, type PayoutRail, type RailBalances, type RailBatchInput, type RailBatchResult, type RailReceipt, type RailReclaim, type RailStatus } from "./rail.js";

export class DryRunRail implements PayoutRail {
  readonly network = "near:testnet";
  readonly contractId: string;
  readonly usdcContractId: string;
  readonly funderAccountId: string;
  readonly webOrigin: string;
  private readonly now: () => Date;
  private readonly keyFactory: () => LinkKey;
  readonly calls: string[] = [];

  constructor(opts: {
    contractId?: string;
    usdcContractId?: string;
    funderAccountId?: string;
    webOrigin?: string;
    now?: () => Date;
    keyFactory?: () => LinkKey;
  } = {}) {
    this.contractId = opts.contractId ?? "lumenia-near.testnet";
    this.usdcContractId = opts.usdcContractId ?? "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
    this.funderAccountId = opts.funderAccountId ?? "lumenia-funder.testnet";
    this.webOrigin = (opts.webOrigin ?? "https://getlumenia.com").replace(/\/+$/, "");
    this.now = opts.now ?? (() => new Date());
    this.keyFactory = opts.keyFactory ?? newLinkKey;
  }

  async createPayLinks(input: RailBatchInput): Promise<RailBatchResult> {
    this.calls.push(`createPayLinks ${input.reference}`);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + input.expiresHours * 3_600_000).toISOString();
    const payouts = input.payouts.map((p) => {
      const key = this.keyFactory();
      return {
        label: p.label,
        // The same shape the real rail writes: Lumenia's NEAR claim route with the secret in the fragment.
        link: `${this.webOrigin}${NEAR_CLAIM_PATH}#${key.secretKey}`,
        publicKey: key.publicKey,
        receipt: {
          amount_usdc: p.amountUsdc,
          memo: p.memo ?? "",
          status: "DryRun",
          expires_at: expiresAt,
          create_tx_hash: null,
          explorer_url: null,
        },
      };
    });
    const totalCents = input.payouts.reduce((sum, p) => sum + Math.round(Number(p.amountUsdc) * 100), 0);
    return {
      batchId: "batch_dry-run",
      count: payouts.length,
      totalUsdc: `${Math.floor(totalCents / 100)}.${String(totalCents % 100).padStart(2, "0")}`,
      txHash: null,
      explorerUrl: null,
      expiresAt,
      payouts,
      note: "dry run: nothing was escrowed",
    };
  }

  async linkStatus(publicKey: string): Promise<RailStatus> {
    this.calls.push(`linkStatus ${publicKey}`);
    return { publicKey, status: "NotFound", drop: { kind: "NotFound", label: "NotFound", claimedTo: null, expiresAt: null } };
  }

  async reclaim(publicKey: string): Promise<RailReclaim> {
    this.calls.push(`reclaim ${publicKey}`);
    throw new Error("dry run: nothing to reclaim");
  }

  async balances(): Promise<RailBalances> {
    this.calls.push("balances");
    return {
      funder: this.funderAccountId,
      usdc: { balance: "1000.00", registered: true },
      budget: { dailyBudgetUsdc: "50.00", spentLast24hUsdc: "0.00", remainingUsdc: "50.00", maxLinkUsdc: "20.00" },
    };
  }

  receiptsByReference(): RailReceipt[] {
    return [];
  }
}
