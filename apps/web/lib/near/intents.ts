// NEAR Intents 1Click API (https://docs.near-intents.org). A dry quote needs no API key and moves
// nothing. Intents has no testnet: on testnet this client stops at the quote and says so.

export const ONE_CLICK_BASE = "https://1click.chaindefuser.com";

export const INTENTS_ASSETS = {
  nearUsdc: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  stellarUsdc: "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu",
  baseUsdc: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
} as const;

export type Destination = "stellar" | "base";

export const DESTINATIONS: Record<Destination, { label: string; chain: string; assetId: string; placeholder: string; hint: string }> = {
  stellar: {
    label: "USDC on Stellar",
    chain: "Stellar",
    assetId: INTENTS_ASSETS.stellarUsdc,
    placeholder: "G...",
    hint: "A Stellar address starts with G and is 56 characters. It must already hold a USDC trustline.",
  },
  base: {
    label: "USDC on Base",
    chain: "Base",
    assetId: INTENTS_ASSETS.baseUsdc,
    placeholder: "0x...",
    hint: "A Base address starts with 0x followed by 40 hex characters.",
  },
};

/** Shape only: G + 55 base32 characters. The checksum is not verified here. */
export function isStellarAddress(s: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(s.trim());
}

/** Shape only: 0x + 40 hex characters. */
export function isBaseAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s.trim());
}

export function isDestinationAddress(destination: Destination, s: string): boolean {
  return destination === "stellar" ? isStellarAddress(s) : isBaseAddress(s);
}

export interface QuoteRequest {
  dry: boolean;
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
}

export function quoteDeadline(nowMs: number, minutes = 3): string {
  const d = new Date(nowMs + minutes * 60_000);
  d.setUTCMilliseconds(0);
  return d.toISOString();
}

export function buildQuoteRequest(input: {
  destination: Destination;
  amountUnits: string;
  recipient: string;
  refundTo: string;
  nowMs: number;
  dry?: boolean;
  slippageBps?: number;
}): QuoteRequest {
  return {
    dry: input.dry ?? true,
    swapType: "EXACT_INPUT",
    slippageTolerance: input.slippageBps ?? 100,
    originAsset: INTENTS_ASSETS.nearUsdc,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: DESTINATIONS[input.destination].assetId,
    amount: input.amountUnits,
    refundTo: input.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: input.recipient.trim(),
    recipientType: "DESTINATION_CHAIN",
    deadline: quoteDeadline(input.nowMs),
  };
}

export interface Quote {
  amountIn: string;
  amountInFormatted: string;
  amountOut: string;
  amountOutFormatted: string;
  minAmountOut?: string;
  amountOutUsd?: string;
  timeEstimate: number;
  depositAddress?: string;
  withdrawFee?: string;
  refundFee?: string;
}

export type QuoteResult = { ok: true; quote: Quote; raw: unknown } | { ok: false; message: string; status?: number };

export function parseQuoteResponse(status: number, body: unknown): QuoteResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (status >= 200 && status < 300 && b.quote && typeof b.quote === "object") {
    const q = b.quote as Record<string, unknown>;
    if (typeof q.amountOut === "string" && typeof q.amountOutFormatted === "string") {
      return {
        ok: true,
        quote: {
          amountIn: String(q.amountIn ?? ""),
          amountInFormatted: String(q.amountInFormatted ?? ""),
          amountOut: q.amountOut,
          amountOutFormatted: q.amountOutFormatted,
          minAmountOut: typeof q.minAmountOut === "string" ? q.minAmountOut : undefined,
          amountOutUsd: typeof q.amountOutUsd === "string" ? q.amountOutUsd : undefined,
          timeEstimate: typeof q.timeEstimate === "number" ? q.timeEstimate : Number(q.timeEstimate ?? 0),
          depositAddress: typeof q.depositAddress === "string" ? q.depositAddress : undefined,
          withdrawFee: typeof q.withdrawFee === "string" ? q.withdrawFee : undefined,
          refundFee: typeof q.refundFee === "string" ? q.refundFee : undefined,
        },
        raw: body,
      };
    }
  }
  const message =
    typeof b.message === "string"
      ? b.message
      : Array.isArray(b.message)
        ? b.message.join("; ")
        : `The quote service answered with HTTP ${status}.`;
  return { ok: false, message, status };
}

export async function requestQuote(body: QuoteRequest, fetchImpl: typeof fetch = fetch, base = ONE_CLICK_BASE): Promise<QuoteResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}/v0/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, message: `Could not reach the quote service: ${e instanceof Error ? e.message : String(e)}` };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return parseQuoteResponse(res.status, json);
}

export function describeTimeEstimate(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "a few moments";
  if (seconds < 90) return `about ${Math.round(seconds)} seconds`;
  return `about ${Math.round(seconds / 60)} minutes`;
}
