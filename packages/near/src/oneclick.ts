// Cross-chain quotes through the NEAR Intents 1Click API. Quotes are DRY and
// INFORMATIONAL: 1Click only knows mainnet assets and there is no Intents
// testnet, so the tool answers "what would 10 USDC on NEAR be worth on
// Stellar/Base right now" and never moves anything. Request shape verified
// against https://1click.chaindefuser.com/docs/v0-json (OpenAPI 0.1.10) and a
// live dry call on 2026-11-10.
import { formatUsdc } from "./amount.js";

export const ONECLICK_DEFAULT_URL = "https://1click.chaindefuser.com";

export const ONECLICK_ASSETS = {
  /** USDC on NEAR mainnet (origin; the testnet USDC of this demo has no Intents id). */
  nearUsdc: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  /** USDC on Stellar pubnet (7 decimals on the Intents side). */
  stellarUsdc: "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu",
  /** USDC on Base. */
  baseUsdc: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
} as const;

export type Destination = "stellar" | "base";

export const DESTINATION_ASSET: Record<Destination, string> = {
  stellar: ONECLICK_ASSETS.stellarUsdc,
  base: ONECLICK_ASSETS.baseUsdc,
};

/**
 * Placeholders that let a dry quote pass 1Click's validation. The NEAR refund
 * placeholder is a syntactically valid implicit account id. The Stellar
 * placeholder must be a real pubnet account with a USDC trustline that is not
 * an exchange (1Click checks both, even for dry quotes): it is a Lumenia-held
 * receipt account from the Stellar mainnet pilot (holds 0.5 USDC). The Base
 * placeholder is the example address from the 1Click docs. Pass `recipient` to quote for a
 * real wallet. Nothing is ever sent to these addresses.
 */
export const PLACEHOLDERS = {
  refundTo: "0".repeat(64),
  recipient: {
    stellar: "GDXAKZVDWTCZE5ZCESI6IH2NZ6JO5TXOVN27F6PLYVQTSSZBISUCXQ55",
    base: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D",
  } as Record<Destination, string>,
};

export const NO_TESTNET_NOTE =
  "NEAR Intents has no testnet: this is a dry, informational quote against mainnet asset ids. " +
  "Nothing was executed, no deposit address was issued, and the funder's testnet USDC cannot be bridged.";

export interface QuoteRequest {
  dry: true;
  swapType: "EXACT_INPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  deadline: string;
  referral: string;
}

export interface QuoteApiResponse {
  correlationId?: string;
  timestamp?: string;
  signature?: string;
  quoteRequest?: unknown;
  quote?: {
    amountIn?: string;
    amountInFormatted?: string;
    amountInUsd?: string;
    minAmountIn?: string;
    amountOut?: string;
    amountOutFormatted?: string;
    amountOutUsd?: string;
    minAmountOut?: string;
    timeEstimate?: number;
    withdrawFee?: string;
    refundFee?: string;
  };
}

export interface CrossChainQuote {
  destination: Destination;
  dry: true;
  amountInUsdc: string;
  amountOut: string | null;
  amountOutFormatted: string | null;
  minAmountOutFormatted: string | null;
  amountOutUsd: string | null;
  timeEstimateSeconds: number | null;
  withdrawFee: string | null;
  recipient: string;
  recipientIsPlaceholder: boolean;
  originAsset: string;
  destinationAsset: string;
  note: string;
  correlationId: string | null;
}

export class OneClickError extends Error {
  override name = "OneClickError";
}

export function buildQuoteRequest(p: {
  amountUnits: bigint;
  destination: Destination;
  now: Date;
  recipient?: string;
  refundTo?: string;
  slippageBps?: number;
  deadlineMinutes?: number;
}): QuoteRequest {
  if (p.destination !== "stellar" && p.destination !== "base") {
    throw new OneClickError(`destination must be "stellar" or "base", got "${String(p.destination)}"`);
  }
  if (p.amountUnits <= 0n) throw new OneClickError("amount must be greater than zero");
  const deadline = new Date(p.now.getTime() + (p.deadlineMinutes ?? 30) * 60_000);
  return {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: p.slippageBps ?? 100,
    originAsset: ONECLICK_ASSETS.nearUsdc,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: DESTINATION_ASSET[p.destination],
    amount: p.amountUnits.toString(),
    refundTo: p.refundTo ?? PLACEHOLDERS.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: p.recipient ?? PLACEHOLDERS.recipient[p.destination],
    recipientType: "DESTINATION_CHAIN",
    deadline: deadline.toISOString(),
    referral: "lumenia",
  };
}

export async function requestDryQuote(
  baseUrl: string,
  body: QuoteRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<QuoteApiResponse> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v0/quote`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new OneClickError(`1Click API unreachable (${(e as Error).message}); nothing was spent`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message =
      json && typeof json === "object" && typeof (json as { message?: unknown }).message === "string"
        ? (json as { message: string }).message
        : text.slice(0, 300);
    throw new OneClickError(`1Click refused the quote (HTTP ${res.status}): ${message}`);
  }
  if (!json || typeof json !== "object") throw new OneClickError("1Click returned a non-JSON body");
  return json as QuoteApiResponse;
}

export function summarizeQuote(req: QuoteRequest, destination: Destination, res: QuoteApiResponse): CrossChainQuote {
  const q = res.quote ?? {};
  return {
    destination,
    dry: true,
    amountInUsdc: formatUsdc(req.amount),
    amountOut: q.amountOut ?? null,
    amountOutFormatted: q.amountOutFormatted ?? null,
    minAmountOutFormatted: q.minAmountOut !== undefined && q.amountOutFormatted !== undefined ? scaleLike(q.minAmountOut, q.amountOut, q.amountOutFormatted) : null,
    amountOutUsd: q.amountOutUsd ?? null,
    timeEstimateSeconds: typeof q.timeEstimate === "number" ? q.timeEstimate : null,
    withdrawFee: q.withdrawFee ?? null,
    recipient: req.recipient,
    recipientIsPlaceholder: req.recipient === PLACEHOLDERS.recipient[destination],
    originAsset: req.originAsset,
    destinationAsset: req.destinationAsset,
    note: NO_TESTNET_NOTE,
    correlationId: res.correlationId ?? null,
  };
}

/** Format minAmountOut with the same decimal count 1Click used for amountOut. */
function scaleLike(minOut: string, out: string | undefined, outFormatted: string): string | null {
  if (!out) return null;
  const decimals = out.length - outFormatted.replace(".", "").replace(/^0+/, "").length;
  const d = decimals >= 0 && decimals <= 18 ? inferDecimals(out, outFormatted) : null;
  if (d === null) return null;
  const big = BigInt(minOut);
  const base = 10n ** BigInt(d);
  const whole = big / base;
  const frac = (big % base).toString().padStart(d, "0").replace(/0+$/, "");
  return frac.length ? `${whole}.${frac}` : `${whole}`;
}

function inferDecimals(out: string, outFormatted: string): number | null {
  const [w = "", f = ""] = outFormatted.split(".");
  for (let d = 0; d <= 18; d++) {
    const base = 10n ** BigInt(d);
    const big = BigInt(out);
    const whole = (big / base).toString();
    const frac = (big % base).toString().padStart(d, "0");
    if (whole === w.replace(/^0+(?=\d)/, "") && frac.replace(/0+$/, "") === f.replace(/0+$/, "")) return d;
  }
  return null;
}
